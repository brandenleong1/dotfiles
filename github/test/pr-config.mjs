// The config loader (tools/pr-config.mjs): defaults, a file merged over them (objects key by key, lists replaced),
// errors for unknown keys, wrong types and unsafe values, the cross-field rules, what the config derives (rulesets,
// labels, kept and exempt branches), and the command line the workflows and the setup script use. Also that the
// repository's own .github/pr-automation.json is valid, and that the schema documents every setting.
// Standalone suite: precommit runs it (tools/run-tests.mjs).
//
//   node test/pr-config.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, ROOT, loadConfig, resolveConfig, renderRuleset, labelsOf, keptBranches, exemptBranches } from '../tools/pr-config.mjs';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
	if (ok) passed++;
	else { failed++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}
function refuses(name, raw, re) {
	try {
		resolveConfig(raw, 'test');
		check(name, false, 'accepted');
	} catch (e) {
		check(name, re.test(e.message), e.message);
	}
}
const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-config-test-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

// ---- defaults and merging --------------------------------------------------------------------------------------------

{
	const none = loadConfig(path.join(scratch, 'missing.json'));
	check('no file: every default', JSON.stringify(none) === JSON.stringify(DEFAULTS));
	const c = resolveConfig({ title: { areas: ['App'] }, merge: { approvals: 2 }, $comment: 'notes are fine' });
	check('a file sets what it names, objects merged key by key', c.title.areas.length === 1 && c.title.maxLength === DEFAULTS.title.maxLength && c.merge.approvals === 2 && c.merge.method === 'squash');
	check('…and lists replaced, not appended', JSON.stringify(c.title.areas) === '["App"]');
	check('…and the result is frozen', Object.isFrozen(c.merge) && Object.isFrozen(c.title.areas));
	check("the repository's own .github/pr-automation.json is valid", (() => { try { return !!loadConfig(path.join(ROOT, '.github', 'pr-automation.json')); } catch (e) { console.log(e.message); return false; } })());
	check('the test config is valid', !!loadConfig(path.join(here, 'fixtures', 'pr-automation.test.json')));
}

// ---- refusals ------------------------------------------------------------------------------------------------------------

refuses('an unknown key', { merge: { methd: 'squash' } }, /merge\.methd: unknown setting/);
refuses('an unknown section', { modules: {} }, /modules: unknown setting/);
refuses('a wrong type', { merge: { approvals: '2' } }, /merge\.approvals: expected a number/);
refuses('a list where an object goes', { title: [] }, /title: expected an object/);
refuses('an object where a list goes', { title: { areas: 'Core' } }, /title\.areas: expected a list/);
refuses('a merge method GitHub has not', { merge: { method: 'octopus' } }, /merge\.method: expected one of squash, merge, rebase/);
refuses('a bad regular expression', { forbidden: { paths: ['(unclosed'] } }, /forbidden\.paths\[0\]: not a regular expression/);
refuses('an npm script name that could be an option or a command', { precommit: { scripts: ['test; rm -rf /'] } }, /precommit\.scripts\[0\]: expected an npm script name/);
refuses('…or start with a dash', { screenshots: { script: '--silent' } }, /screenshots\.script: expected an npm script name/);
refuses('a branch name git would refuse', { screenshots: { branch: 'bot/../main' } }, /screenshots\.branch: expected a branch name/);
refuses('…or one ending in .lock', { branches: { keep: ['release.lock'] } }, /branches\.keep\[0\]: expected a branch name/);
refuses('a workflow file outside .github/workflows', { rebuild: { checkWorkflows: [{ file: '../evil.yml' }] } }, /rebuild\.checkWorkflows\[0\]: file: expected a workflow file name/);
refuses('a local check with an unknown field', { testing: { localChecks: [{ name: 'x', match: 'x', when: 'always' }] } }, /unknown field "when"/);
refuses('…or without its pattern', { testing: { localChecks: [{ name: 'x' }] } }, /missing "match"/);
refuses('a path that climbs out of the repository', { pages: { include: ['../secrets/'] } }, /pages\.include\[0\]: expected a path/);
refuses('a submodule URL that isn\'t https', { pages: { submodules: { 'lib/x': 'git@github.com:o/x.git' } } }, /lib\/x: expected an https:\/\/ URL/);
refuses('a bump title that could reach a shell', { submodules: { bumps: [{ path: 'lib/x', branch: 'bot/bump-x', title: 'Bump $(whoami)' }] } }, /title: expected one line without double quotes, \$ or \\/);
refuses('a label with a comma (actions/stale splits on them)', { labels: { hold: 'on, hold' } }, /labels\.hold: expected a label/);
refuses('a stale age of nothing', { stale: { days: 0 } }, /stale\.days: expected a whole number from 1/);
refuses('an author_association that doesn\'t exist', { merge: { approverAssociations: ['ADMIN'] } }, /expected an author_association/);
refuses('fewer approvals for CI than for the rest', { merge: { approvals: 2, ciApprovals: 1 } }, /merge\.ciApprovals: must be at least merge\.approvals/);
refuses('pattern "prefix" without prefixes', { branch: { pattern: 'prefix' } }, /branch\.prefixes: list at least one prefix/);
refuses('pattern "regex" without one', { branch: { pattern: 'regex' } }, /branch\.regex: set it/);
refuses('areas with tags off', { title: { maxTags: 0 } }, /title\.areas: tags are off/);
refuses('the bot waiting for its own status', { merge: { requiredChecks: ['precommit', 'pr-bot'] } }, /not the bot's own status/);
refuses('"Tested at" without the Testing section', { description: { requiredSections: ['Context'] } }, /include "Testing"/);
refuses('a file that isn\'t an object', [], /the file: expected an object/);
refuses('a preview remote that could be an option', { localPreviews: { remote: '--upload-pack=x' } }, /localPreviews\.remote: expected a remote's name/);
refuses('a preview marker that isn\'t a plain name', { localPreviews: { marker: 'x"><script>' } }, /localPreviews\.marker: expected a meta tag name/);
refuses('a preview submodule with a trailing slash, or climbing out', { localPreviews: { submodules: ['lib/theme/', '../x'] } }, /localPreviews\.submodules\[0\][\s\S]*localPreviews\.submodules\[1\]/);
refuses('a content type with a line break', { localPreviews: { types: { '.glb': 'model/gltf-binary\nx: y' } } }, /\.glb: expected a content type/);
refuses('a port past 65535', { localPreviews: { port: 70000 } }, /localPreviews\.port: expected a whole number from 0 to 65535/);
check('a preview content type and marker that are fine', resolveConfig({ localPreviews: { types: { '.glb': 'model/gltf-binary' }, marker: 'branch-preview', submodules: ['lib/theme'] } }).localPreviews.types['.glb'] === 'model/gltf-binary');
{
	let message = '';
	try { resolveConfig({ merge: { method: 'x', approvals: 0 }, nope: 1 }, 'f.json'); } catch (e) { message = e.message; }
	check('every problem is reported at once, naming the file', /^f\.json: /.test(message) && /nope/.test(message) && /merge\.method/.test(message) && /merge\.approvals/.test(message), message);
}

// ---- what the config derives --------------------------------------------------------------------------------------------

{
	const template = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'rulesets', 'main.json'), 'utf8'));
	const rule = (ruleset, type) => ruleset.rules.find((r) => r.type === type);
	const squash = renderRuleset('main', resolveConfig({}), template);
	check('ruleset main: squash only, one approval, the bot\'s status required from GitHub Actions',
		JSON.stringify(rule(squash, 'pull_request').parameters.allowed_merge_methods) === '["squash"]' && rule(squash, 'pull_request').parameters.required_approving_review_count === 1
		&& JSON.stringify(rule(squash, 'required_status_checks').parameters.required_status_checks) === '[{"context":"pr-bot","integration_id":15368}]' && !!rule(squash, 'required_linear_history'));
	const merge = renderRuleset('main', resolveConfig({ merge: { method: 'merge', approvals: 2, ciApprovals: 2 }, ruleset: { requiredChecks: ['pr-bot', 'precommit'] } }), template);
	check('…merge commits: no linear history, the approvals and checks configured', !rule(merge, 'required_linear_history') && JSON.stringify(rule(merge, 'pull_request').parameters.allowed_merge_methods) === '["merge"]'
		&& rule(merge, 'pull_request').parameters.required_approving_review_count === 2 && rule(merge, 'required_status_checks').parameters.required_status_checks.length === 2);
	check('…no required checks: no such rule', !rule(renderRuleset('main', resolveConfig({ ruleset: { requiredChecks: [] } }), template), 'required_status_checks'));
	check('…and the template is left as it was', JSON.stringify(template) === JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'rulesets', 'main.json'), 'utf8'))));
	const names = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'rulesets', 'branch-names.json'), 'utf8'));
	const excluded = (c) => renderRuleset('branch-names', resolveConfig(c), names)?.conditions.ref_name.exclude;
	check('ruleset branch-names: <name>/<thing> for pattern "user", and the screenshot branch', JSON.stringify(excluded({})) === '["~DEFAULT_BRANCH","refs/heads/*/*","refs/heads/bot/screenshots"]', JSON.stringify(excluded({})));
	check('…<prefix>/<thing> for pattern "prefix", and exempt branches', JSON.stringify(excluded({ branch: { pattern: 'prefix', prefixes: ['feature', 'fix'], exempt: ['release'] } })) === '["~DEFAULT_BRANCH","refs/heads/feature/*","refs/heads/fix/*","refs/heads/release","refs/heads/bot/screenshots"]', JSON.stringify(excluded({ branch: { pattern: 'prefix', prefixes: ['feature', 'fix'], exempt: ['release'] } })));
	check('…and none for "regex" or "any"', renderRuleset('branch-names', resolveConfig({ branch: { pattern: 'any' } }), names) === null);
	const labels = (c) => labelsOf(resolveConfig(c)).map((l) => l.name);
	check('labels: hold, the stale ones with that module on, and the extra ones', JSON.stringify(labels({})) === '["hold"]' && JSON.stringify(labels({ stale: { enabled: true }, labels: { hold: 'wait', extra: [{ name: 'bug', color: 'd73a4a' }] } })) === '["wait","stale","keep-open","bug"]');
	const bumps = resolveConfig({ submodules: { enabled: true, bumps: [{ path: 'lib/x', branch: 'bot/bump-x', title: '[Deps] Fix: Bump X to `{sha}`' }] }, branch: { exempt: ['release'] } });
	check('exempt branches: the configured ones and the bump branches', JSON.stringify([...exemptBranches(bumps)]) === '["release","bot/bump-x"]');
	check('kept branches: the configured ones and the screenshot branch', JSON.stringify([...keptBranches(resolveConfig({ branches: { keep: ['release'] } }))]) === '["release","bot/screenshots"]');
}

// ---- the schema documents every setting -------------------------------------------------------------------------------

{
	const schema = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'pr-automation.schema.json'), 'utf8'));
	const missing = [];
	const walk = (defaults, node, at) => {
		for (const [key, value] of Object.entries(defaults)) {
			const prop = node?.properties?.[key];
			if (!prop) { missing.push(`${at}${key}`); continue; }
			if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length && prop.properties) walk(value, prop, `${at}${key}.`);
		}
		for (const key of Object.keys(node?.properties || {})) if (key !== '$schema' && !(key in defaults)) missing.push(`${at}${key} (not a setting)`);
	};
	walk(DEFAULTS, schema, '');
	check('the schema has every setting, and no others', missing.length === 0, missing.join(', '));
}

// ---- the command line ---------------------------------------------------------------------------------------------------

{
	const file = path.join(scratch, 'config.json');
	fs.writeFileSync(file, JSON.stringify({ precommit: { scripts: ['lint', 'test'] }, stale: { enabled: true }, submodules: { enabled: true, bumps: [{ path: 'lib/x', branch: 'bot/bump-x', title: '[Deps] Fix: Bump X to `{sha}`' }] } }));
	const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'pr-config.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, PR_AUTOMATION_CONFIG: file, ...env } });
	check('get: a list, one item per line', cli(['get', 'precommit.scripts']).stdout === 'lint\ntest\n');
	check('get: a value', cli(['get', 'merge.method']).stdout === 'squash\n');
	check('get: no such setting fails', cli(['get', 'merge.nope']).status === 1);
	const outputs = path.join(scratch, 'outputs');
	fs.writeFileSync(outputs, '');
	cli(['outputs', 'stale'], { GITHUB_OUTPUT: outputs });
	check('outputs: a section\'s values, appended to $GITHUB_OUTPUT', fs.readFileSync(outputs, 'utf8') === 'enabled=true\nclosePrs=true\ndays=30\nlabel=stale\nexemptLabel=keep-open\npruneBranches=true\n', fs.readFileSync(outputs, 'utf8'));
	check('outputs: lists comma-separated, objects left out', /^scripts=lint,test$/m.test(cli(['outputs', 'precommit']).stdout) && !/limits/.test(cli(['outputs', 'screenshots']).stdout));
	check('ruleset: rendered from the template', JSON.parse(cli(['ruleset', 'main']).stdout).name === 'default-branch' && cli(['ruleset', '../x']).status === 1);
	check('labels: name, color and description, tab-separated', cli(['labels']).stdout.split('\n')[1] === 'stale\tcfd3d7\tNo activity for 30 days');
	check('bumps: path, branch and title, tab-separated', cli(['bumps']).stdout === 'lib/x\tbot/bump-x\t[Deps] Fix: Bump X to `{sha}`\n');
	check('check: ok, and what is on', /^ok: /.test(cli(['check']).stdout) && /modules on: stale, submodules/.test(cli(['check']).stdout));
	fs.writeFileSync(file, '{ "merge": { "method": "octopus" } ');
	check('a broken file: every command fails, saying why', cli(['check']).status === 1 && /not valid JSON/.test(cli(['get', 'merge.method']).stderr));
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
