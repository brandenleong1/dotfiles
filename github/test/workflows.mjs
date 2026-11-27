// The workflows' security properties, read from the files (README.md, "Security model"), so a change that breaks one
// fails here before anyone has to spot it in review:
//   - every workflow declares its permissions, and the ones that run a PR's code (pull_request) never get write ones;
//   - event text reaches scripts only through `env:`: no `${{ }}` inside any `run:`;
//   - the privileged ones (pull_request_target, workflow_run) check out only the default branch, never a PR's head;
//   - checkouts keep no credentials, except the one job that pushes (the submodule bump), and it runs no PR code;
//   - every setup-node uses the same Node version;
//   - a workflow_dispatch input is checked before it's used, and only through `env:`.
// Standalone suite: precommit runs it (tools/run-tests.mjs).
//
//   node test/workflows.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows');
const NODE = '22';
const PUSHES = new Set(['update-submodules.yml']);   // the one workflow whose checkout keeps its token, to push

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
	if (ok) passed++;
	else { failed++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

/** The lines of the block that starts at line `i`: that line and every following one indented deeper than it. */
function blockAt(lines, i) {
	const indent = lines[i].search(/\S/);
	const out = [lines[i]];
	for (let j = i + 1; j < lines.length; j++) {
		if (lines[j].trim() && lines[j].search(/\S/) <= indent) break;
		out.push(lines[j]);
	}
	return out;
}

/** The steps that use an action (`uses: owner/name@...`): each step's lines. */
function stepsUsing(lines, action) {
	return lines.flatMap((line, i) => {
		if (!new RegExp(`^\\s*(- )?uses: ${action.replace('/', '\\/')}@`).test(line)) return [];
		// the step starts at its `- ` line: this one, or the nearest one above at the step's indent
		let start = i;
		while (start > 0 && !/^\s*- /.test(lines[start])) start--;
		return [blockAt(lines, start)];
	});
}

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
check('there are workflows to check', files.length >= 10, String(files.length));
for (const file of files) {
	const text = fs.readFileSync(path.join(DIR, file), 'utf8');
	const lines = text.split('\n');
	const on = blockAt(lines, lines.findIndex((l) => /^on:/.test(l))).join('\n');
	const privileged = /^\s+(pull_request_target|workflow_run):/m.test(on);
	const runsPrCode = /^\s+pull_request:/m.test(on);

	check(`${file}: declares its permissions`, /^permissions:/m.test(text));
	if (runsPrCode) check(`${file}: runs a PR's code, so no write permissions`, !/:\s*write\b/.test(text), (text.match(/^.*:\s*write\b.*$/gm) || []).join(' | '));

	const runs = lines.flatMap((line, i) => (/^\s*(- )?run: /.test(line) ? [blockAt(lines, i).join('\n')] : []));
	const interpolated = runs.filter((r) => r.includes('${{'));
	check(`${file}: no \${{ }} inside a run: (event text goes through env:)`, interpolated.length === 0, interpolated.join('\n---\n'));

	const checkouts = stepsUsing(lines, 'actions/checkout').map((s) => s.join('\n'));
	if (privileged) {
		const notDefault = checkouts.filter((c) => !/^\s+ref: \$\{\{ github\.event\.repository\.default_branch \}\}$/m.test(c));
		check(`${file}: privileged, so it checks out the default branch only`, checkouts.length > 0 && notDefault.length === 0, notDefault.join('\n---\n'));
	}
	check(`${file}: no checkout of a PR's head ref or SHA in a privileged workflow`, !privileged || !/ref: .*(pull_request\.head|workflow_run\.head)/.test(text));
	const keeps = checkouts.filter((c) => !/persist-credentials: false/.test(c));
	if (PUSHES.has(file)) check(`${file}: pushes, and runs no PR code`, !runsPrCode && !privileged && keeps.length === 1);
	else check(`${file}: its checkouts keep no credentials`, keeps.length === 0, keeps.join('\n---\n'));

	const nodes = stepsUsing(lines, 'actions/setup-node').map((s) => /node-version: (\S+)/.exec(s.join('\n'))?.[1]);
	check(`${file}: Node ${NODE} everywhere`, nodes.every((v) => v === NODE), JSON.stringify(nodes));

	for (const [, input] of text.matchAll(/inputs\.([a-z_]+)/g)) {
		const viaEnv = new RegExp(`^\\s+[A-Z_]+: \\$\\{\\{ [^}]*inputs\\.${input}[^}]*\\}\\}$`, 'm').test(text);
		check(`${file}: input "${input}" reaches its script only through env:`, viaEnv);
	}
}

// the ones the bot dispatches take what it sends, and check it
{
	const policy = fs.readFileSync(path.join(DIR, 'pr-policy.yml'), 'utf8');
	check('pr-policy.yml: its `pr` input must be a number', /\[\[ "\$PR_NUMBER" =~ \^\[0-9\]\+\$ \]\]/.test(policy));
	check('pr-policy.yml: dispatched, it checks the PR is open, here, with this branch at this commit', /\.state == "open" and \.head\.repo\.full_name == \$repo and \.head\.ref == \$ref and \.head\.sha == \$sha/.test(policy));
	const bot = fs.readFileSync(path.join(DIR, 'pr-bot.yml'), 'utf8');
	check('pr-bot.yml: its `delay` input must be a small number', /\[\[ "\$DELAY" =~ \^\[0-9\]\{1,2\}\$ \]\]/.test(bot));
	check('pr-bot.yml: one review at a time, never cancelled half way', /group: pr-bot-review\n\s+cancel-in-progress: false/.test(bot));
	check('precommit.yml: the job is named precommit (a required check)', /^ {2}precommit:$/m.test(fs.readFileSync(path.join(DIR, 'precommit.yml'), 'utf8')));
	check('pr-policy.yml: the job is named pr-policy (a required check)', /^ {2}pr-policy:$/m.test(policy));
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
