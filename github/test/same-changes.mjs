// pr-policy's "Tested at" comparison end to end: tools/same-changes.mjs against local repositories behind a fake GitHub
// (test/fixtures/pr-bot-github.mjs over test/fixtures/git-repos.mjs), then tools/check-pr.mjs with its verdict, as the
// workflow runs them. A clean rebase, a merge of the base ("Update branch") and a stack rebuilt by hand keep the
// author's results; other changes, a commit GitHub doesn't have, or a SHA that's no commit don't; and when the
// comparison itself fails, pr-policy fails closed. tools/restack.mjs's own tests (test/restack.mjs) cover the
// comparison's cases in more detail.
// Standalone suite: precommit runs it (tools/run-tests.mjs).
//
//   node test/same-changes.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git, makeRepos, commitFiles, lines } from './fixtures/git-repos.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(here, 'fixtures', 'pr-automation.test.json');
process.env.PR_AUTOMATION_CONFIG = CONFIG_FILE;
const { testedChanges } = await import('../tools/same-changes.mjs');
const fake = pathToFileURL(path.join(here, 'fixtures', 'pr-bot-github.mjs')).href;
const tool = (name) => path.join(here, '..', 'tools', name);
const short = (sha) => sha.slice(0, 7);

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
	if (ok) passed++;
	else { failed++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

const body = (testing) => `## Context\n\nWhy.\n\n## Changes\n\n- Changed a thing.\n\n## Testing\n\n${testing}\n`;
/** A description that passes for `sha`: the author's local results for that commit. */
const bodyFor = (sha) => body(`- Tested at ${short(sha)}.\n- Ran \`npm test\`: 30 of 30 suites passed.\n- Ran \`npm run test:e2e\`: 45 passed, 0 failed.`);

/** pr-policy's check of a description for `head` (based on `base`, of PR `pr` among `prs`), as the workflow runs it. */
function policyRun(r, { body: description, head, base = 'main', pr = null, prs = [] }) {
	const pull = { PR_TITLE: '[Core] Fix: Change a Line', PR_AUTHOR: 'alice', PR_BRANCH: 'alice/change', PR_FILES: 'a.txt' };
	const env = { PATH: process.env.PATH, PR_AUTOMATION_CONFIG: CONFIG_FILE, ...pull, GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: 'o/r', GITHUB_SERVER_URL: `file://${r.root}`, PR_BODY: description, PR_HEAD_SHA: head, PR_BASE_REF: base, ...(pr ? { PR_NUMBER: String(pr) } : {}) };
	const scene = { git: r.server, state: path.join(r.root, 'policy-github.json'), prs };
	const same = spawnSync(process.execPath, ['--import', fake, tool('same-changes.mjs')], { env: { ...env, PR_BOT_SCENE: JSON.stringify(scene) }, encoding: 'utf8' });
	const verdict = same.stdout.trim();
	const checked = spawnSync(process.execPath, [tool('check-pr.mjs')], { env: { ...env, PR_TESTED_CHANGES: verdict }, encoding: 'utf8' });
	return { verdict, status: checked.status, out: checked.stdout + same.stderr + checked.stderr };
}

/** The fake GitHub reads the repository once, as GitHub sees every push: a force-push after this is in the PRs' timelines. */
function githubSees(r, prs) {
	const scene = { git: r.server, state: path.join(r.root, 'policy-github.json'), prs };
	const run = spawnSync(process.execPath, ['--import', fake, '--input-type=module', '-e', "await fetch('https://api.github.com/repos/o/r/pulls')"], {
		env: { PATH: process.env.PATH, GITHUB_SERVER_URL: `file://${r.root}`, PR_BOT_SCENE: JSON.stringify(scene) }, encoding: 'utf8',
	});
	if (run.status !== 0) throw new Error(`the fake GitHub exited ${run.status}: ${run.stderr}`);
}

/** main, and branches off it changing a.txt: alice/b line 8, alice/c line 6, alice/d line 1. */
function plainRepos() {
	const r = makeRepos();
	const w = r.work;
	const branch = (name, line) => {
		git(w, ['switch', '--quiet', '-c', name, 'main']);
		return commitFiles(w, name, { 'a.txt': lines(1, 10, { [line]: name.slice(-1) }) });
	};
	const heads = { b: branch('alice/b', 8), c: branch('alice/c', 6), d: branch('alice/d', 1) };
	git(w, ['push', '--quiet', 'origin', 'alice/b', 'alice/c', 'alice/d']);
	return { ...r, ...heads };
}

// the verdicts that need no git
{
	const head = 'abcdef1234567890abcdef1234567890abcdef12';
	check('no "Tested at": none', await testedChanges({ repo: 'o/r', body: body('- Ran it.'), head, baseRef: 'main' }) === 'none');
	check('"Tested at" the head: head', await testedChanges({ repo: 'o/r', body: bodyFor(head), head, baseRef: 'main' }) === 'abcdef1 head');
}

{
	const r = plainRepos();
	const w = r.work;
	git(w, ['switch', '--quiet', 'main']);
	const main = commitFiles(w, 'Main: line 6', { 'a.txt': lines(1, 10, { 6: 'm' }) });
	git(w, ['push', '--quiet', 'origin', 'main']);
	// alice/b rebased cleanly, and alice/d updated with a merge of main ("Update branch")
	git(w, ['switch', '--quiet', '-c', 'rebased', main]);
	const rebased = commitFiles(w, 'B', { 'a.txt': lines(1, 10, { 6: 'm', 8: 'b' }) });
	git(w, ['switch', '--quiet', 'alice/d']);
	git(w, ['merge', '--quiet', '--no-edit', 'main']);
	const updated = git(w, ['rev-parse', 'HEAD']);
	// alice/c rebuilt on main by hand, its line 6 resolved with main's: not the changes it was tested with
	git(w, ['switch', '--quiet', '-c', 'resolved', main]);
	const resolved = commitFiles(w, 'C, resolved', { 'a.txt': lines(1, 10, { 6: 'c and m' }) });
	// a commit only on the author's machine
	const local = commitFiles(w, 'Never pushed', { 'b.txt': 'b\n' });
	git(w, ['push', '--quiet', '--force', 'origin', `${rebased}:refs/heads/alice/b`, `${updated}:refs/heads/alice/d`, `${resolved}:refs/heads/alice/c`]);

	const clean = policyRun(r, { body: bodyFor(r.b), head: rebased });
	check('pr-policy: a clean rebase keeps "Tested at"', clean.verdict === `${short(r.b)} same` && clean.status === 0 && /makes the same changes as this head/.test(clean.out), JSON.stringify(clean));
	check('…and the tested commit, no longer on any branch after the force-push, is still fetched by its SHA', !git(r.server, ['branch', '--contains', r.b]));
	const merged = policyRun(r, { body: bodyFor(r.d), head: updated });
	check('…and so does a merge of the base into the branch', merged.verdict === `${short(r.d)} same` && merged.status === 0, JSON.stringify(merged));
	const different = policyRun(r, { body: bodyFor(r.c), head: resolved });
	check('…a conflict resolved by hand, with other changes, fails it', different.verdict === `${short(r.c)} different` && different.status === 1 && /"Tested at [0-9a-f]{7}" isn't this PR's head \([0-9a-f]{7}\), and it makes different changes/.test(different.out), JSON.stringify(different));
	const unpushed = policyRun(r, { body: bodyFor(local), head: resolved });
	check('…a tested commit that was never pushed fails it, saying to push it or re-test', unpushed.verdict === `${short(local)} unfetchable` && unpushed.status === 1 && /push the tested commit, or re-test this head/.test(unpushed.out), JSON.stringify(unpushed));
	const head = policyRun(r, { body: bodyFor(resolved), head: resolved });
	check('…"Tested at" the head itself needs no comparing', head.verdict === `${short(resolved)} head` && head.status === 0, JSON.stringify(head));
	const notCommit = policyRun(r, { body: bodyFor('deadbeefdeadbeef'), head: resolved });
	check('…nor does a SHA that\'s no commit pass', notCommit.verdict === 'deadbee unfetchable' && notCommit.status === 1, JSON.stringify(notCommit));
	const broken = policyRun(r, { body: bodyFor(r.b), head: rebased, base: 'no-such-branch' });
	check('…and when the comparison itself fails, it fails closed', broken.verdict === `${short(r.b)} error` && broken.status === 1 && /couldn't compare their changes/.test(broken.out), JSON.stringify(broken));
	r.close();
}

// a stack rebuilt by hand, the lower PR's conflict with main resolved, so its changes differ: the PR stacked on it keeps
// its "Tested at" (its own commit replays onto the lower PR's new head as it was), as pr-policy reads in its timeline
// that its base was force-pushed from the commit it was tested on; and fails when its own change differs
{
	const r = makeRepos({ 'a.txt': lines(1, 10), 'rows.txt': 'one\n' });
	const w = r.work;
	git(w, ['switch', '--quiet', '-c', 'alice/p']);
	commitFiles(w, 'P', { 'rows.txt': 'one\np\n' });
	git(w, ['switch', '--quiet', '-c', 'alice/q']);
	const q = commitFiles(w, 'Q', { 'a.txt': lines(1, 10, { 5: 'q' }) });
	git(w, ['push', '--quiet', 'origin', 'alice/p', 'alice/q']);
	const prs = [{ number: 1, base: 'main', ref: 'alice/p' }, { number: 2, base: 'alice/p', ref: 'alice/q' }];
	githubSees(r, prs);
	git(w, ['switch', '--quiet', 'main']);
	commitFiles(w, 'Main: a row', { 'rows.txt': 'one\nm\n' });
	git(w, ['switch', '--quiet', '-c', 'p2']);
	const p2 = commitFiles(w, 'P', { 'rows.txt': 'one\nm\np\n' });
	git(w, ['switch', '--quiet', '-c', 'q2']);
	const q2 = commitFiles(w, 'Q', { 'a.txt': lines(1, 10, { 5: 'q' }) });
	git(w, ['switch', '--quiet', '-c', 'q3', p2]);
	const q3 = commitFiles(w, 'Q', { 'a.txt': lines(1, 10, { 5: 'Q' }) });
	git(w, ['push', '--quiet', '--force', 'origin', 'main', `${p2}:refs/heads/alice/p`, `${q2}:refs/heads/alice/q`, `${q3}:refs/heads/alice/q3`]);
	const same = policyRun(r, { body: bodyFor(q), head: q2, base: 'alice/p', pr: 2, prs });
	check('pr-policy: a PR on one rebuilt by hand with other changes keeps "Tested at"', same.verdict === `${short(q)} same` && same.status === 0, JSON.stringify(same));
	const differs = policyRun(r, { body: bodyFor(q), head: q3, base: 'alice/p', pr: 2, prs });
	check('…not when its own change differs', differs.verdict === `${short(q)} different` && differs.status === 1, JSON.stringify(differs));
	const unknown = policyRun(r, { body: bodyFor(q), head: q2, base: 'alice/p' });
	check('…nor without the PR, whose timeline says what its base was', unknown.verdict === `${short(q)} different`, JSON.stringify(unknown));
	r.close();
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
