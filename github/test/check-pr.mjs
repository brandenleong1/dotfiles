// The PR check (tools/check-pr.mjs), with the test config (test/fixtures/pr-automation.test.json) and variations of it.
// Titles: the configured tags and qualifiers, and book-title case (articles, conjunctions, and prepositions lower case
// unless first or last; phrasal-verb particles either way). Branches: each pattern. Descriptions: the sections, the
// Testing section's local results for the PR's head ("Tested at <sha>" and each configured check, some only for the
// paths they name), screenshots for the paths that need them, and no sensitive text. Files: none the config forbids.
// "Tested at" another commit passes on pr-policy's word that it makes the same changes, and only warns when checked by
// hand (test/same-changes.mjs runs that comparison end to end). And the command line, as pr-policy runs it.
// Standalone suite: precommit runs it (tools/run-tests.mjs).
//
//   node test/check-pr.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPr, checkCommit, testedSha } from '../tools/check-pr.mjs';
import { loadConfig, resolveConfig } from '../tools/pr-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(here, 'fixtures', 'pr-automation.test.json');
const CONFIG = loadConfig(CONFIG_FILE);
/** The test config with `changes` merged over it (as a repository's file would set them). */
const configWith = (changes) => resolveConfig(merge(JSON.parse(JSON.stringify(CONFIG)), changes), 'test');

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
	if (ok) passed++;
	else { failed++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}
const errorsOf = (title, config = CONFIG) => checkPr({ title }, config).errors;
const ok = (title, config) => check(`accepts "${title}"`, errorsOf(title, config).length === 0, JSON.stringify(errorsOf(title, config)));
const bad = (title, re, config) => check(`rejects "${title}"`, errorsOf(title, config).some((e) => re.test(e)), JSON.stringify(errorsOf(title, config)));

// ---- titles ------------------------------------------------------------------------------------------------------------

ok("[CI] Fix: Make the PR Bot Wait for a Stacked PR's Base to Merge");
ok('[UI] Feature: Show One Panel at a Time on Phones and Tablets');
ok('[Core] Fix: Retry a Request Instead of Failing at Once');
ok('[API] Feature: Page through Results with Two or More Filters');
ok('[UI] Fix: Set Up the Panel');                        // a particle may be capitalised
ok('[UI] Fix: Set up the Panel');                        // ...or not
ok('[Docs] Fix: Say What It Waits For');                 // a small word last is capitalised
ok('[Deps] Fix: Bump the Parser to `0b1f1a9`');          // code counts as a capitalised word
ok('[UI] Feature: Add Mark-All-Done Buttons and Tidy the Settings Panel');
ok('[Core][Cache] Performance: Drop Entries When They Expire');   // a sub-area

bad("[CI] Fix: Make The PR Bot Wait For A Stacked PR's Base To Merge", /"The", "For", "A".*lower case/);
bad('[Core] Performance: Cache Results Per Request', /"Per".*lower case/);
bad('[UI] Fix: show the menu', /capitalise "show", "menu"/);
bad('[UI] Fix: Draw Borders Like the theme', /capitalise "theme"/);
bad('[Docs] Fix: Say What It Waits for', /capitalise "for"/);   // the last word, even a small one
bad('[Server] Fix: Retry a Request', /unknown area "\[Server\]"; use one of \[Core\] \[API\]/);
bad('[UI] Fixed: The Menu', /unknown qualifier "Fixed:"/);
bad('[UI] Fix: Added the Menu', /imperative \("Add", not "Added"\)/);
bad('UI Fix: The Menu', /use "\[Area\]\[Sub-area\] Qualifier: Title Case Summary", e\.g\. "\[UI\] Fix: Keep the Menu Open after a Click"/);
bad('[UI][Menu][Item] Fix: Keep It Open', /use "\[Area\]\[Sub-area\]/);
bad('[UI][menu] Fix: Keep It Open', /sub-area "\[menu\]" should be one capitalised word/);
bad(`[UI] Fix: ${'Word '.repeat(20)}End`, /characters; keep it to 80/);
bad('[UI] Fix: Keep the Menu Open.', /no full stop/);

// other title rules: no tags or qualifier, any area, no title case
{
	const plain = configWith({ title: { maxTags: 0, areas: [], qualifiers: [], example: 'Keep the Menu Open' } });
	ok('Keep the Menu Open after a Click', plain);
	bad('keep the menu open', /capitalise "keep", "menu", "open"/, plain);
	const anyArea = configWith({ title: { areas: [], maxTags: 1 } });
	ok('[Parser] Fix: Read Empty Files', anyArea);
	bad('[parser] Fix: Read Empty Files', /area "\[parser\]" should be one capitalised word/, anyArea);
	bad('[Parser][Lexer] Fix: Read Empty Files', /use "\[Area\] Qualifier/, anyArea);
	ok('[Core] Fix: keep the menu open', configWith({ title: { titleCase: false } }));
	ok('[Core] Fix: Added the Menu', configWith({ title: { imperative: false } }));
}

// ---- branches --------------------------------------------------------------------------------------------------------

{
	const branch = (name, author, config = CONFIG) => checkPr({ branch: name, author }, config).errors;
	check('a branch named <author>/<short-name> passes', branch('alice/docs', 'alice').length === 0 && branch('Alice/docs', 'alice').length === 0);
	check("…someone else's name doesn't", /should start with your username: alice\/<short-name>/.test(branch('bob/docs', 'alice')[0] || ''), JSON.stringify(branch('bob/docs', 'alice')));
	check('…nor a name without one, or in capitals', branch('docs', 'alice').length === 1 && branch('alice/Docs', 'alice').length === 1);
	const prefixed = configWith({ branch: { pattern: 'prefix', prefixes: ['feature', 'fix'] } });
	check('pattern "prefix": <prefix>/<short-name>', branch('feature/menu', 'alice', prefixed).length === 0 && /should be <feature\|fix>\/<short-name>/.test(branch('alice/menu', 'alice', prefixed)[0] || ''));
	const regex = configWith({ branch: { pattern: 'regex', regex: '^[A-Z]+-\\d+-[a-z-]+$' } });
	check('pattern "regex"', branch('ABC-12-menu', 'alice', regex).length === 0 && branch('alice/menu', 'alice', regex).length === 1);
	check('pattern "any"', branch('Whatever Goes', 'alice', configWith({ branch: { pattern: 'any' } })).length === 0);
	const exempt = configWith({ branch: { exempt: ['release/next'] }, submodules: { enabled: true, bumps: [{ path: 'lib/parser', branch: 'bot/bump-parser', title: '[Deps] Fix: Bump the Parser to {sha}' }] } });
	check('exempt branches and the submodule bump branches pass', branch('release/next', 'alice', exempt).length === 0 && branch('bot/bump-parser', 'alice', exempt).length === 0 && branch('bot/bump-parser', 'alice').length === 1);
}

// ---- commits ---------------------------------------------------------------------------------------------------------

{
	const commit = (message, repo = 'o/r') => checkCommit(message, CONFIG, { serverUrl: 'https://github.com', repo }).errors;
	check('a merged commit: title, blank line, the PR URL', commit('[Docs] Fix: Say It\n\nhttps://github.com/o/r/pull/1').length === 0);
	check("…not another repository's PR", /body must be only the PR's URL \(https:\/\/github\.com\/o\/r\/pull\/<n>\)/.test(commit('[Docs] Fix: Say It\n\nhttps://github.com/x/y/pull/1')[0] || ''));
	check('…without knowing the repository, any one on the server', commit('[Docs] Fix: Say It\n\nhttps://github.com/x/y/pull/1', '').length === 0);
	check('…not the " (#N)" GitHub appends', commit('[Docs] Fix: Say It (#1)\n\nhttps://github.com/o/r/pull/1').some((e) => /drop the " \(#N\)"/.test(e)));
	check('…a blank line after the title, and only the URL', commit('[Docs] Fix: Say It\nhttps://github.com/o/r/pull/1').some((e) => /blank line/.test(e)) && commit('[Docs] Fix: Say It\n\nMore.\nhttps://github.com/o/r/pull/1').length === 1);
}

// ---- the Testing section: the author's local run, for this head ----------------------------------------------------

const HEAD = '3f9c2e1d7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d';
const body = (testing, extra = '') => `## Context\n\nWhy.\n\n## Changes\n\n- Changed a thing.\n\n## Testing\n\n${testing}\n${extra}`;
const TESTED = '- Tested at 3f9c2e1.\n- Ran `npm test`: 30 of 30 suites passed.\n- Ran `npm run test:e2e`: 45 passed, 0 failed.';
const bodyErrors = (b, extra = {}, config = CONFIG) => checkPr({ body: b, headSha: HEAD, ...extra }, config).errors;
const accepts = (name, b, extra, config) => check(`accepts ${name}`, bodyErrors(b, extra, config).length === 0, JSON.stringify(bodyErrors(b, extra, config)));
const rejects = (name, b, re, extra, config) => check(`rejects ${name}`, bodyErrors(b, extra, config).some((e) => re.test(e)), JSON.stringify(bodyErrors(b, extra, config)));

accepts('a Testing section with the head and both results', body(TESTED));
accepts('the full SHA, and a skipped check with its reason', body('- Tested at `3f9c2e1d7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d`.\n- Ran `node tools/run-tests.mjs`: 30 of 30 suites pass.\n- `npm run test:e2e`: skipped: no browser on this machine.'));
accepts('results on a wrapped bullet line', body('- Tested at 3f9c2e1.\n- Ran `npm test` after rebasing:\n  30 of 30 suites passed.\n- Ran `npm run test:e2e`: 45 passed, 0 failed.'));
rejects('a Testing section without "Tested at"', body('- Ran `npm test`: 30 of 30 suites passed.\n- Ran `npm run test:e2e`: 45 passed, 0 failed.'), /needs a "Tested at 3f9c2e1" line/);
rejects('"Tested at" an older head with other changes (after a push)', body(TESTED.replace('3f9c2e1', 'a1b2c3d')), /"Tested at a1b2c3d" isn't this PR's head \(3f9c2e1\), and it makes different changes/, { testedChanges: 'a1b2c3d different' });
rejects('a SHA shorter than 7 characters', body(TESTED.replace('3f9c2e1', '3f9c2e')), /needs a "Tested at/);
rejects('`npm test` without its result', body('- Tested at 3f9c2e1.\n- Ran `npm test`.\n- Ran `npm run test:e2e`: 45 passed, 0 failed.'), /`npm test` with its result/);
rejects('a check that is missing', body('- Tested at 3f9c2e1.\n- Ran `npm test`: 30 of 30 suites passed.'), /`npm run test:e2e` with its result/);
rejects('"skipped" with no reason', body('- Tested at 3f9c2e1.\n- Ran `npm test`: 30 of 30 suites passed.\n- `npm run test:e2e`: skipped.'), /`npm run test:e2e` with its result/);
rejects('a Tested-at line hidden in a comment', body('<!-- Tested at 3f9c2e1 -->\n- Ran `npm test`: 30 of 30 suites passed.\n- Ran `npm run test:e2e`: 45 passed, 0 failed.'), /needs a "Tested at/);
// a check with paths: only for PRs that change them
const BENCH = '\n- Ran `npm run bench`: 12 of 12 cases passed (0 slower).';
rejects('a PR that changes src/engine/ with no bench result', body(TESTED), /`npm run bench` with its result \(it changes `src\/engine\/`\)/, { files: ['src/engine/loop.js', 'README.md'] });
accepts('a PR that changes src/engine/ with its bench result', body(TESTED + BENCH), { files: ['src/engine/loop.js'] });
accepts('no bench line where the PR changes nothing it names', body(TESTED), { files: ['tools/bench.mjs', 'docs/testing.md'] });
check('without a head SHA (the PR bot, a merged commit) the results aren\'t asked for', checkPr({ body: body('- Ran the tests.') }, CONFIG).errors.length === 0);
{
	const defaults = resolveConfig({}, 'defaults');
	accepts('the default check takes common test commands', body('- Tested at 3f9c2e1.\n- Ran `ctest`: 120 of 120 tests passed.'), {}, defaults);
	rejects('…and still wants one', body('- Tested at 3f9c2e1.'), /needs the test suite with its result/, {}, defaults);
	accepts('no "Tested at" when it is off', body('- Ran `npm test`: 3 passed.\n- Ran `npm run test:e2e`: 1 passed.'), {}, configWith({ testing: { requireTestedAt: false } }));
	accepts('another section name', '## Context\n\nWhy.\n\n## Changes\n\n- Changed it.\n\n## Verification\n\n' + TESTED, {}, configWith({ testing: { section: 'Verification' }, description: { requiredSections: ['Context', 'Changes', 'Verification'], pastTenseSections: ['Changes'] } }));
}

// ---- sections and sensitive text -------------------------------------------------------------------------------------

rejects('an empty Context', body(TESTED).replace('Why.', ''), /fill in the "## Context" section/);
rejects('a personal path', body(TESTED, '\nSee /home/alice/project/x.\n'), /a personal path/);
rejects('a GitHub token', body(TESTED, `\nghp_${'a'.repeat(36)}\n`), /a GitHub token/);
accepts('a placeholder path', body(TESTED, '\nSee /home/<you>/project.\n'));
rejects('a configured sensitive pattern', body(TESTED, '\nTicket INT-4411.\n'), /contains an internal ticket number/, {}, configWith({ description: { sensitivePatterns: [{ pattern: '\\bINT-\\d+\\b', what: 'an internal ticket number' }] } }));
check('a Changes bullet without a past-tense verb is a warning', checkPr({ body: body(TESTED).replace('- Changed a thing.', '- The thing.'), headSha: HEAD }, CONFIG).warnings.length === 1);

// ---- "Tested at" another commit: its results hold if it makes the same changes as the head ------------------------

const AT_OLD = body(TESTED.replace('3f9c2e1', 'aa11bb2'));
const AT_OLD_FULL = body(TESTED.replace('3f9c2e1', 'AA11BB22CC33DD44EE55FF6677889900AABBCCDD'));
const notes = (b, testedChanges) => checkPr({ body: b, headSha: HEAD, testedChanges }, CONFIG).notes;
accepts('"Tested at" a commit that makes the same changes (pr-policy\'s word)', AT_OLD, { testedChanges: 'aa11bb2 same' });
check('…and says so in a note', JSON.stringify(notes(AT_OLD, 'aa11bb2 same')) === JSON.stringify(['Tested at aa11bb2, which makes the same changes as this head (3f9c2e1).']), JSON.stringify(notes(AT_OLD, 'aa11bb2 same')));
accepts('a full SHA in capitals, compared as it is in lower case', AT_OLD_FULL, { testedChanges: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd same' });
rejects('a commit GitHub doesn\'t have', AT_OLD, /isn't this PR's head \(3f9c2e1\), and GitHub has no commit aa11bb2 to compare it with: push the tested commit, or re-test this head/, { testedChanges: 'aa11bb2 unfetchable' });
rejects('an abbreviated SHA that is more than one commit\'s', AT_OLD, /"Tested at aa11bb2" matches more than one commit/, { testedChanges: 'aa11bb2 ambiguous' });
rejects('a comparison that failed (CI fails closed)', AT_OLD, /pr-policy couldn't compare their changes/, { testedChanges: 'error' });
rejects('…or that came back empty', AT_OLD, /pr-policy couldn't compare their changes/, { testedChanges: '' });
rejects('a verdict on another commit than the line names', AT_OLD, /pr-policy couldn't compare their changes/, { testedChanges: 'cc33dd4 same' });
accepts('a verdict after other output (its last line counts)', AT_OLD, { testedChanges: '::add-mask::eC1hY2Nlc3M=\naa11bb2 same\n' });
rejects('…and only its last line', AT_OLD, /pr-policy couldn't compare their changes/, { testedChanges: 'aa11bb2 same\naa11bb2 error' });
const local = checkPr({ body: AT_OLD, headSha: HEAD }, CONFIG);
check('by hand (no verdict) "Tested at" another commit is taken at its word, with a warning', local.errors.length === 0 && local.warnings.some((w) => /"Tested at aa11bb2" isn't this PR's head \(3f9c2e1\)\. pr-policy passes it only if aa11bb2 makes the same changes/.test(w)), JSON.stringify(local));
check('the commit the Testing section names, for pr-policy to compare', testedSha(AT_OLD_FULL, CONFIG) === 'aa11bb22cc33dd44ee55ff6677889900aabbccdd' && testedSha(body('- Ran the tests.'), CONFIG) === null && testedSha(`<!-- Tested at aa11bb2 -->\n${body('- Ran it.')}`, CONFIG) === null && testedSha('## Context\n\nTested at aa11bb2.', CONFIG) === null);

// ---- screenshots: a PR that changes how it looks shows it --------------------------------------------------------------

const shots = (images) => `\n## Screenshots\n\n${images}\n`;
rejects('a UI change without a Screenshots section', body(TESTED), /changes how it looks \(`src\/ui\/panel\.js`\).*"## Screenshots"/, { files: ['docs/a.md', 'src/ui/panel.js'] });
rejects('a style change whose Screenshots section has no image', body(TESTED, shots('See the menu.')), /changes how it looks \(`theme\.css`\)/, { files: ['theme.css'] });
rejects('an image only inside a comment', body(TESTED, shots('<!-- ![menu](https://example.com/a.png) -->')), /changes how it looks/, { files: ['index.html'] });
accepts('a UI change with a Markdown image', body(TESTED, shots('![The menu](https://github.com/o/r/blob/bot/screenshots/pr-9/menu.png?raw=true)')), { files: ['src/ui/menu.js'] });
accepts('a UI change with an <img> tag', body(TESTED, shots('<img width="400" alt="menu" src="https://github.com/user-attachments/assets/1">')), { files: ['src/ui/menu.js'] });
accepts('a change elsewhere without screenshots', body(TESTED), { files: ['src/api/routes.js', 'docs/a.md'] });
rejects('"See the Screenshots comment" with the screenshot bot off', body(TESTED, shots('See the Screenshots comment.')), /with at least one image: drag/, { files: ['src/ui/menu.js'] });
accepts('…and with it on', body(TESTED, shots('See the Screenshots comment.')), { files: ['src/ui/menu.js'] }, configWith({ screenshots: { enabled: true } }));

// ---- files no PR may add ---------------------------------------------------------------------------------------------

for (const file of ['.env', 'deploy/.env', 'certs/server.pem', 'keys/signing.KEY', 'home/id_rsa', 'app/release.keystore']) {
	rejects(`a PR adding ${file}`, body(TESTED), /look like credentials or private keys/, { files: ['docs/a.md', file] });
}
accepts('files that only look a bit like them', body(TESTED), { files: ['src/env.js', 'docs/keys.md', 'src/.envrc.example.md', 'id_rsa.md'] });
{
	const vendored = configWith({ forbidden: { paths: ['(^|/)vendor/', '\\.(exe|dll)$'], message: 'are vendored or built files: add them through the package manager.' } });
	check('a configured forbidden list replaces the default', checkPr({ files: ['vendor/lib/a.c', 'out/app.EXE'] }, vendored).errors[0]?.includes('`vendor/lib/a.c`, `out/app.EXE` are vendored or built files') && checkPr({ files: ['.env'] }, vendored).errors.length === 0, JSON.stringify(checkPr({ files: ['vendor/lib/a.c', 'out/app.EXE'] }, vendored)));
}

// ---- the command line, as pr-policy runs it ---------------------------------------------------------------------------
// Run as a script, its top level runs main() before the rest of the module: nothing main() reaches may be a `const` or
// `let` declared below that call (it would throw "Cannot access … before initialization" only when run as a command).
// test/module-order.mjs checks that for every module; these run the command as pr-policy does.

const tool = (name) => path.join(here, '..', 'tools', name);
const cli = (env, args = []) => spawnSync(process.execPath, [tool('check-pr.mjs'), ...args], {
	encoding: 'utf8', env: { PATH: process.env.PATH, PR_AUTOMATION_CONFIG: CONFIG_FILE, PR_TITLE: '[CI] Fix: Make the PR Bot Wait for Its Checks', PR_AUTHOR: 'alice',
		PR_BRANCH: 'alice/bot-waits', PR_FILES: 'tools/pr-bot.mjs', ...env },
});
const crashed = (run) => /Error\b.*\n\s+at /.test(run.stderr);
const sameCli = cli({ PR_BODY: AT_OLD, PR_HEAD_SHA: HEAD, PR_TESTED_CHANGES: 'aa11bb2 same' });
check('the command line passes "Tested at" a commit with the same changes, with a note', sameCli.status === 0 && /^notice: Tested at aa11bb2, which makes the same changes as this head \(3f9c2e1\)\.$/m.test(sameCli.stdout) && /^ok\b/m.test(sameCli.stdout), `${sameCli.status} ${sameCli.stdout}${sameCli.stderr}`);
const masked = cli({ PR_BODY: AT_OLD, PR_HEAD_SHA: HEAD, PR_TESTED_CHANGES: '::add-mask::eC1h\naa11bb2 same' });
check('…also after other output', masked.status === 0, `${masked.status} ${masked.stdout}${masked.stderr}`);
for (const verdict of ['aa11bb2 different', 'aa11bb2 unfetchable', 'error', '']) {
	const run = cli({ PR_BODY: AT_OLD, PR_HEAD_SHA: HEAD, PR_TESTED_CHANGES: verdict });
	check(`…and fails it on "${verdict}", without crashing`, run.status === 1 && !crashed(run) && /^error: Description: "Tested at aa11bb2" isn't this PR's head/m.test(run.stdout), `${run.status} ${run.stdout}${run.stderr}`);
}
const byHand = cli({ PR_BODY: AT_OLD, PR_HEAD_SHA: HEAD });
check('…takes it at its word by hand (no verdict), with a warning', byHand.status === 0 && /^warning: .*pr-policy passes it only if aa11bb2 makes the same changes/m.test(byHand.stdout), `${byHand.status} ${byHand.stdout}${byHand.stderr}`);
const plain = cli({ PR_BODY: body(TESTED), PR_HEAD_SHA: HEAD, PR_TESTED_CHANGES: '3f9c2e1 head' });
check('…and passes a PR tested at its head', plain.status === 0 && !crashed(plain), `${plain.status} ${plain.stdout}${plain.stderr}`);
const annotated = cli({ GITHUB_ACTIONS: 'true', PR_TITLE: 'bad title\n::error::injected', PR_BODY: body(TESTED), PR_HEAD_SHA: HEAD });
check('in Actions, annotations are one line each: PR text can\'t start a workflow command', annotated.status === 1 && annotated.stdout.split('\n').filter((l) => l.startsWith('::')).every((l) => /^::(error|warning|notice)::/.test(l)) && !/^::error::injected/m.test(annotated.stdout), annotated.stdout);
const titleOnly = cli({}, ['--title', '[Docs] Feature: Add a Style Guide']);
const commitCli = spawnSync(process.execPath, [tool('check-pr.mjs'), '--commit'], { input: '[Docs] Fix: Say It\n\nhttps://github.com/o/r/pull/3\n', encoding: 'utf8', env: { PATH: process.env.PATH, PR_AUTOMATION_CONFIG: CONFIG_FILE, GITHUB_REPOSITORY: 'o/r' } });
check('--title and --commit', titleOnly.status === 0 && commitCli.status === 0, `${titleOnly.stdout}${titleOnly.stderr}${commitCli.stdout}${commitCli.stderr}`);
const badConfig = cli({ PR_AUTOMATION_CONFIG: path.join(here, 'fixtures', 'missing-dir', 'nothing.json') }, ['--title', '[Docs] Feature: Add a Style Guide']);
check('no config file at all: the defaults', badConfig.status === 0, `${badConfig.stdout}${badConfig.stderr}`);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/** `changes` merged into `target`, objects key by key. */
function merge(target, changes) {
	for (const [key, value] of Object.entries(changes)) {
		if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) merge(target[key], value);
		else target[key] = value;
	}
	return target;
}
