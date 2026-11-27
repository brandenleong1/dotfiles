// The PR bot (tools/pr-bot.mjs) against a fake GitHub (test/fixtures/pr-bot-github.mjs): which PR it merges, and what
// it tells the ones it holds. Here: a stacked PR (based on another PR's branch) waits, however ready it looks; merged
// PRs close the issues they fix; the asynchronous merge; approvals carried over a rebuilt PR; pruning branches by hand;
// and, against a real (local) repository, keeping the open PRs up to date after a merge (the bot's or one by hand):
// the PRs on the merged PR's branch moved to main by deleting it (GitHub won't change the base of a PR in a stack), and
// put back when GitHub doesn't move them; plain PRs and stacks rebuilt on main, bottom up, with pr-policy passing on
// their old "Tested at" (tools/same-changes.mjs); and the PRs it leaves saying why once.
// And the settings in .github/pr-automation.json that change what it does (test/fixtures/pr-automation.test.json, and
// variations of it): the merge method, the checks it waits for, approvals, carried approvals, a custom status and hold
// label, rebuilding off, and the postcommit and Pages modules it starts.
// Standalone suite: precommit runs it (tools/run-tests.mjs).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git, makeRepos, commitFiles, lines, changes } from './fixtures/git-repos.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bot = path.join(here, '..', 'tools', 'pr-bot.mjs');
const fake = pathToFileURL(path.join(here, 'fixtures', 'pr-bot-github.mjs')).href;
const CONFIG_FILE = path.join(here, 'fixtures', 'pr-automation.test.json');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-bot-test-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
let passed = 0, failed = 0;

function check(name, ok, detail = '') {
	if (ok) passed++;
	else { failed++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

/**
 * Run `pr-bot.mjs review` (or `args`) on a scene (a list of PRs, or a whole scene); the writes it made, parsed. Its
 * git remote is `serverUrl`: nowhere, unless the scene has a repository.
 */
function review(prs, { args = ['review'], serverUrl = 'file:///nonexistent', config = null } = {}) {
	const run = runBot(Array.isArray(prs) ? { prs } : prs, args, serverUrl, config);
	if (run.status !== 0) throw new Error(`pr-bot exited ${run.status}: ${run.stderr || run.stdout}`);
	return run.writes;
}

/** `config`: settings merged over the test config, for this run only. */
function runBot(scene, args, serverUrl = 'file:///nonexistent', config = null) {
	const run = spawnSync(process.execPath, ['--import', fake, bot, ...args], {
		env: { ...process.env, PR_AUTOMATION_CONFIG: configFile(config), GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: 'o/r', GITHUB_SERVER_URL: serverUrl, PR_BOT_SCENE: JSON.stringify(scene) },
		encoding: 'utf8',
	});
	const lines = run.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
	// the fake's own notes (e.g. what pr-policy said) ride along as `writes.fake`
	const writes = Object.assign(lines.filter((l) => l.method), { fake: lines.filter((l) => l.fake) });
	return { status: run.status, stdout: run.stdout, stderr: run.stderr, writes };
}
const merges = (writes) => writes.filter((w) => /\/merge$/.test(w.path)).map((w) => +w.path.match(/pulls\/(\d+)/)[1]);
const statusOf = (writes, sha) => writes.filter((w) => w.path.endsWith(`/statuses/${sha}`)).map((w) => w.body).pop();

// pruning, by hand: branches with no open PR and no commit for 30+ days go, bot/screenshots stays, nothing else happens
{
	const branches = ['alice/old', 'bob/old', 'bot/screenshots'].map((name, i) => ({ name, commit: { sha: `stale-${i}` } }));
	const writes = review({ prs: [], branches }, { args: ['prune-branches'] });
	const deleted = writes.filter((w) => w.method === 'DELETE').map((w) => w.path.replace(/^.*\/heads\//, ''));
	check('pruning deletes stale branches', JSON.stringify(deleted) === '["alice/old","bob/old"]', JSON.stringify(deleted));
	check('…keeps bot/screenshots, and dispatches nothing', !deleted.includes('bot/screenshots') && !writes.some((w) => /\/dispatches$/.test(w.path)), JSON.stringify(writes.map((w) => w.path)));
	check('a dry run deletes nothing', review({ prs: [], branches }, { args: ['prune-branches', '--dry-run'] }).length === 0);
	check('the commands that went are gone', runBot({ prs: [] }, ['follow-up', '1:' + 'a'.repeat(40)]).status === 2 && runBot({ prs: [] }, ['after-merge', 'x']).status === 2);
}

// #2 is stacked on #1 (based on #1's branch) and approved; #1 isn't approved yet
{
	const writes = review([
		{ number: 1, base: 'main', ref: 'alice/lower', approved: false },
		{ number: 2, base: 'alice/lower', ref: 'alice/upper', approved: true },
	]);
	check('a stacked PR is not merged, even approved and green', !merges(writes).includes(2), JSON.stringify(merges(writes)));
	const s = statusOf(writes, 'h2');
	check('a stacked PR says what it waits for', s && s.state === 'pending' && /^Stacked on #1/.test(s.description), JSON.stringify(s));
	check('the PR below it still waits for its review', !merges(writes).includes(1) && /review/i.test(statusOf(writes, 'h1')?.description || ''), JSON.stringify(statusOf(writes, 'h1')));
}

// a PR based on a branch that no open PR has
{
	const writes = review([{ number: 3, base: 'some-branch', ref: 'alice/x', approved: true }]);
	const s = statusOf(writes, 'h3');
	check('a PR based on another branch is not merged', merges(writes).length === 0, JSON.stringify(merges(writes)));
	check('it says to change its base to main', s && s.state === 'pending' && /not main/.test(s.description), JSON.stringify(s));
}

// pruning a branch that isn't a merged PR's head, with an open PR based on it: GitHub would close that PR, so it moves
// to main first
{
	const branches = [{ name: 'alice/old', commit: { sha: 'stale-0' } }];
	const writes = review({ prs: [{ number: 9, base: 'alice/old', ref: 'alice/top' }], branches }, { args: ['prune-branches'] });
	const retarget = writes.findIndex((w) => w.method === 'PATCH' && w.path.endsWith('/pulls/9') && w.body?.base === 'main');
	const remove = writes.findIndex((w) => w.method === 'DELETE' && w.path.endsWith('/heads/alice/old'));
	check('pruning a branch a PR is based on moves the PR to main first', retarget >= 0 && remove > retarget, JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
}

// a merged PR closes the open issues it fixes, in this repo only, with a comment naming it
{
	const writes = review([{ number: 5, base: 'main', ref: 'alice/z', approved: true, fixes: [{ number: 12 }, { number: 13, state: 'CLOSED' }, { number: 14, repo: 'other/repo' }] }]);
	const closed = writes.filter((w) => w.method === 'PATCH' && /\/issues\/\d+$/.test(w.path) && w.body?.state === 'closed').map((w) => +w.path.split('/').pop());
	const comment = writes.find((w) => w.method === 'POST' && w.path.endsWith('/issues/12/comments'));
	check('a merged PR closes the issue it fixes', JSON.stringify(merges(writes)) === '[5]' && JSON.stringify(closed) === '[12]', `merged ${JSON.stringify(merges(writes))}, closed ${JSON.stringify(closed)}`);
	check('…with a comment naming the PR', comment && /#5/.test(comment.body.body), JSON.stringify(comment));
	check('…and leaves closed issues and other repos alone', !closed.includes(13) && !closed.includes(14), JSON.stringify(closed));
}

// the normal case still merges: based on main, approved, green
{
	const writes = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true }]);
	check('a ready PR based on main is merged', JSON.stringify(merges(writes)) === '[4]', JSON.stringify(merges(writes)));
	check('…and nothing is dispatched after it (no postcommit, Pages, or follow-up runs)', !writes.some((w) => /\/dispatches$/.test(w.path)), JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
}

// a PR with others stacked on it: the plain merge is refused, so the bot asks the asynchronous endpoint and polls it,
// reading the uuid and the merge commit from the answer's `details`, as GitHub documents them
{
	const writes = review([{ number: 6, base: 'main', ref: 'alice/z', approved: true, hasStack: true }]);
	const asyncMerges = writes.filter((w) => /\/pulls\/6\/merge-async$/.test(w.path));
	check('a PR with a stack on it is merged asynchronously', asyncMerges.length === 1 && asyncMerges[0].body.merge_method === 'squash' && asyncMerges[0].body.sha === 'h6' && asyncMerges[0].body.bypass_rules === false, JSON.stringify(asyncMerges));
	const deleted = writes.some((w) => w.method === 'DELETE' && /alice\/z$/.test(w.path));
	check('…and its branch is cleaned up after the merge, as for any merged PR', deleted, JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
}
// the asynchronous merge's result can't be read back, but the PR did merge: still a merge
{
	const writes = review([{ number: 7, base: 'main', ref: 'alice/y', approved: true, hasStack: true, asyncLost: true }]);
	const deleted = writes.some((w) => w.method === 'DELETE' && /alice\/y$/.test(w.path));
	check('a merge whose asynchronous result is lost is still followed up', deleted, JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
	check('…and not reported as refused', !/refused/.test(JSON.stringify(writes.filter((w) => /statuses/.test(w.path)))), JSON.stringify(writes.filter((w) => /statuses/.test(w.path))));
}

// an approval that a push dismissed carries over when the new head makes the same changes (only its parent differs):
// by default (merge.carryApprovals "count") the bot counts it, says so once, and merges
{
	const writes = review([{ number: 8, base: 'main', ref: 'alice/w', approved: false, carry: 'same' }]);
	const said = writes.filter((w) => w.method === 'POST' && /\/issues\/8\/comments$/.test(w.path)).map((w) => w.body.body);
	check('a carried approval is counted, and the PR says whose', said.length === 1 && /counts @bob's approval of old8 for this head/.test(said[0]) && /<!-- pr-bot: carried h8 7 -->$/.test(said[0]) && !writes.some((w) => /\/pulls\/8\/reviews$/.test(w.path)), JSON.stringify(said));
	check('…and the PR merges', JSON.stringify(merges(writes)) === '[8]', JSON.stringify(merges(writes)));
}
// with "review", the bot posts an approval of the head, saying whose it carries, and merges
{
	const writes = review([{ number: 8, base: 'main', ref: 'alice/w', approved: false, carry: 'same' }], { config: { merge: { carryApprovals: 'review' } } });
	const posted = writes.filter((w) => w.method === 'POST' && /\/pulls\/8\/reviews$/.test(w.path));
	check('"review": a carried approval is posted on the head', posted.length === 1 && posted[0].body.event === 'APPROVE' && posted[0].body.commit_id === 'h8' && /@bob.*old8/.test(posted[0].body.body), JSON.stringify(posted));
	check('…and the PR merges', JSON.stringify(merges(writes)) === '[8]', JSON.stringify(merges(writes)));
}
// with "off", it waits for a new review
{
	const writes = review([{ number: 8, base: 'main', ref: 'alice/w', approved: false, carry: 'same' }], { config: { merge: { carryApprovals: 'off' } } });
	check('"off": nothing is carried', merges(writes).length === 0 && /Needs a review/.test(statusOf(writes, 'h8')?.description || ''), JSON.stringify(statusOf(writes, 'h8')));
}
// not when the changes differ: it waits for a new review like any other PR
{
	const writes = review([{ number: 9, base: 'main', ref: 'alice/v', approved: false, carry: 'different' }]);
	check('an approval of different changes is not carried', !writes.some((w) => /\/pulls\/9\/reviews$/.test(w.path)) && !merges(writes).includes(9), JSON.stringify(writes.map((w) => w.path)));
	check('…and the PR asks for a review', /review/i.test(statusOf(writes, 'h9')?.description || ''), JSON.stringify(statusOf(writes, 'h9')));
}

// ---- keeping PRs up to date, against a local repository -------------------------------------------------------------

/** Run a pass of the bot (`review`, or `args`) on a repository scene; its writes. */
function reviewRepo(r, prs, extra = {}, args = ['review']) {
	const scene = { git: r.server, state: path.join(r.root, 'fake-github.json'), prs, ...extra };
	return review(scene, { args, serverUrl: `file://${r.root}` });
}
/** Calls straight to the fake GitHub on a repository scene, with no bot: each call's answer, { status, message }. */
function callFake(r, prs, calls) {
	const scene = { git: r.server, state: path.join(r.root, 'fake-github.json'), prs };
	const script = `for (const [method, path, body] of ${JSON.stringify(calls)}) {
		const res = await fetch('https://api.github.com' + path, { method, body: body ? JSON.stringify(body) : undefined });
		console.log(JSON.stringify({ answer: res.status, message: JSON.parse(await res.text()).message || null }));
	}`;
	const run = spawnSync(process.execPath, ['--import', fake, '--input-type=module', '-e', script], {
		env: { ...process.env, GITHUB_SERVER_URL: `file://${r.root}`, PR_BOT_SCENE: JSON.stringify(scene) },
		encoding: 'utf8',
	});
	if (run.status !== 0) throw new Error(`the fake exited ${run.status}: ${run.stderr}`);
	return run.stdout.split('\n').filter((l) => l.startsWith('{"answer"')).map((l) => JSON.parse(l)).map(({ answer, message }) => ({ status: answer, message }));
}
/** The fake's state after the passes so far: { prs: { [n]: { body, ... } }, updated: [main SHAs], ... } */
const fakeState = (r) => JSON.parse(fs.readFileSync(path.join(r.root, 'fake-github.json'), 'utf8'));
/** A description that passes pr-policy for `sha`: the author's local results for that head. */
const bodyFor = (sha) => `## Context\n\nWhy.\n\n## Changes\n\n- Changed a thing.\n\n## Testing\n\n- Tested at ${sha.slice(0, 7)}.\n- Ran \`npm test\`: 30 of 30 suites passed.\n- Ran \`npm run test:e2e\`: 59 passed, 0 failed.\n`;
/** The fake's pr-policy verdicts: [{ pr, head, tested, errors, notes }] */
const policies = (r, writes) => writes.fake.filter((w) => w.fake === 'pr-policy');
const mergedPrs = (writes) => [...new Set(writes.filter((w) => /\/merge(-async)?$/.test(w.path)).map((w) => +w.path.match(/pulls\/(\d+)/)[1]))];
const commentsOn = (writes, n) => writes.filter((w) => w.method === 'POST' && w.path.endsWith(`/issues/${n}/comments`)).map((w) => w.body.body);
const dispatches = (writes) => writes.filter((w) => /\/dispatches$/.test(w.path)).map((w) => `${w.path.match(/workflows\/([^/]+)/)[1]} ${w.body.ref}${w.body.inputs?.pr ? ` #${w.body.inputs.pr}` : ''}${w.body.inputs?.delay ? ` in ${w.body.inputs.delay} min` : ''}`);
const bodyEdits = (writes) => writes.filter((w) => w.method === 'PATCH' && w.body?.body != null);
const at = (r, ref) => git(r.server, ['rev-parse', '--verify', '--quiet', ref], { ok: [0, 1] });
const short = (sha) => sha.slice(0, 7);

/**
 * A merge made by hand, between the bot's passes: GitHub squashes PR `n` onto main and, as this repository is set
 * up, deletes its branch and moves the PRs based on it to main (unless `keepBranch`). Returns the new main.
 */
function humanMerge(r, n, { keepBranch = false } = {}) {
	const file = path.join(r.root, 'fake-github.json');
	const s = JSON.parse(fs.readFileSync(file, 'utf8'));
	const pr = s.prs[n], head = at(r, pr.ref), main = at(r, 'main');
	const tree = git(r.server, ['merge-tree', '--write-tree', main, head]);
	const commit = git(r.server, ['commit-tree', tree, '-p', main, '-m', `[Docs] Fix: Thing ${n}`]);
	git(r.server, ['update-ref', 'refs/heads/main', commit, main]);
	Object.assign(pr, { open: false, merged: true, mergeCommit: commit, mergedHead: head });
	if (!keepBranch) {
		git(r.server, ['update-ref', '-d', `refs/heads/${pr.ref}`]);
		for (const other of Object.values(s.prs)) if (other.open && other.base === pr.ref) other.base = 'main';
	}
	fs.writeFileSync(file, JSON.stringify(s));
	return commit;
}

/**
 * main, and three PRs off it changing a.txt: alice/a line 6, alice/b line 8 (next to it, but not touching: once
 * alice/a merges the lines around alice/b's change are new, but it's the same change), alice/c line 6 too (a conflict).
 */
function plainRepos() {
	const r = makeRepos();
	const w = r.work;
	const branch = (name, line) => {
		git(w, ['switch', '--quiet', '-c', name, 'main']);
		return commitFiles(w, name, { 'a.txt': lines(1, 10, { [line]: name.slice(-1) }) });
	};
	const heads = { a: branch('alice/a', 6), b: branch('alice/b', 8), c: branch('alice/c', 6), d: branch('alice/d', 1) };
	git(w, ['push', '--quiet', 'origin', 'alice/a', 'alice/b', 'alice/c', 'alice/d']);
	return { ...r, ...heads };
}

// a plain PR that falls behind main when another one merges: the bot rebuilds it on main, leaves its description as it
// was, and pr-policy passes on the new head with its old "Tested at", since it makes the same changes; then it merges
{
	const r = plainRepos();
	const prs = [
		{ number: 1, base: 'main', ref: 'alice/a', approved: true, body: bodyFor(r.a) },
		{ number: 2, base: 'main', ref: 'alice/b', approved: true, body: bodyFor(r.b) },
	];
	const first = reviewRepo(r, prs);
	const b = at(r, 'alice/b'), main = at(r, 'main');
	check('a plain PR: the ready one merges', JSON.stringify(mergedPrs(first)) === '[1]', JSON.stringify(mergedPrs(first)));
	check('…and the other, behind main now, is rebuilt on it, with the same change', b !== r.b && at(r, 'alice/b~1') === main && git(r.server, ['show', `${b}:a.txt`]) === lines(1, 10, { 6: 'a', 8: 'b' }).trim(), `${b} on ${at(r, 'alice/b~1')}, main ${main}`);
	check('…its description is left as it was', fakeState(r).prs[2].body === bodyFor(r.b) && bodyEdits(first).length === 0, JSON.stringify(bodyEdits(first)));
	check('…its checks are started, then a review in a few minutes', JSON.stringify(dispatches(first)) === JSON.stringify(['precommit.yml alice/b', 'pr-policy.yml alice/b #2', 'pr-bot.yml main in 5 min']), JSON.stringify(dispatches(first)));
	const policy = policies(r, first);
	check('…and pr-policy passes on the new head with its old "Tested at"', policy.length === 1 && policy[0].head === b && policy[0].tested === `${short(r.b)} same` && policy[0].errors.length === 0
		&& policy[0].notes.some((n) => n === `Tested at ${short(r.b)}, which makes the same changes as this head (${short(b)}).`), JSON.stringify(policy));
	check('…its comment says it was rebuilt after #1 merged, and that its results hold', /^The PR bot rebuilt this PR on `main` after #1 merged, to keep it up to date: it replayed the PR's commit onto/.test(commentsOn(first, 2)[0] || '') && /so do the results in its Testing section/.test(commentsOn(first, 2)[0] || ''), JSON.stringify(commentsOn(first, 2)));
	check('…its approval holds over the bot\'s push, and it\'s ready', statusOf(first, b)?.description === 'Ready: the bot merges it on its next pass' && !first.some((w) => /dismissals$/.test(w.path)), JSON.stringify(statusOf(first, b)));
	check('…and main is marked as up to date', fakeState(r).updated.includes(main), JSON.stringify(fakeState(r).updated));
	check("…and the merged PR's branch is deleted", !at(r, 'alice/a') && first.some((w) => w.method === 'DELETE' && /alice\/a$/.test(w.path)));
	const second = reviewRepo(r, prs);
	check('then the delayed review merges it, and main has both changes', JSON.stringify(mergedPrs(second)) === '[2]' && git(r.server, ['show', 'main:a.txt']) === lines(1, 10, { 6: 'a', 8: 'b' }).trim(), JSON.stringify(mergedPrs(second)));
	r.close();
}

/**
 * main; alice/p (line 3), stacked on it alice/q (line 4, then a new file), and on that alice/r (line 5). Each PR's
 * change sits next to the one below it, so once alice/p is squash-merged alice/q conflicts with main, as on GitHub.
 */
function stackRepos() {
	const r = makeRepos();
	const w = r.work;
	git(w, ['switch', '--quiet', '-c', 'alice/p']);
	commitFiles(w, 'P', { 'a.txt': lines(1, 10, { 3: 'p' }) });
	git(w, ['switch', '--quiet', '-c', 'alice/q']);
	commitFiles(w, 'Q: line 4', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'q' }) }, { author: 'Bob <bob@example.com>' });
	commitFiles(w, 'Q: a new file', { 'q.txt': 'q\n' });
	git(w, ['switch', '--quiet', '-c', 'alice/r']);
	commitFiles(w, 'R', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'q', 5: 'r' }) });
	git(w, ['push', '--quiet', 'origin', 'alice/p', 'alice/q', 'alice/r']);
	return { ...r, p: at(r, 'alice/p'), q: at(r, 'alice/q'), r: at(r, 'alice/r') };
}
/** The scene for a stack's PRs, each with a description tested at its first head. */
const stackOf = (r) => [
	{ number: 1, base: 'main', ref: 'alice/p', approved: true, hasStack: true, body: bodyFor(at(r, 'alice/p') || r.p) },
	{ number: 2, base: 'alice/p', ref: 'alice/q', approved: true, body: bodyFor(r.q) },
	{ number: 3, base: 'alice/q', ref: 'alice/r', approved: true, body: bodyFor(r.r) },
];

// the fake GitHub, as GitHub is now: it won't change the base of a PR that another is based on ("part of a stack"), and deleting a
// merged PR's branch moves the PRs on it to that PR's base, while deleting a branch no merged PR had closes them
{
	const r = stackRepos();
	const [patchQ, patchR] = callFake(r, stackOf(r), [['PATCH', '/repos/o/r/pulls/2', { base: 'main' }], ['PATCH', '/repos/o/r/pulls/3', { base: 'alice/q' }]]);
	check('the fake: changing the base of a PR with another on it is refused', patchQ.status === 422 && patchQ.message === 'Cannot change the base branch because the pull request is part of a stack.' && fakeState(r).prs[2].base === 'alice/p', JSON.stringify(patchQ));
	check("…and the top PR's isn't", patchR.status === 200, JSON.stringify(patchR));
	callFake(r, stackOf(r), [['PUT', '/repos/o/r/pulls/1/merge-async', { sha: r.p }], ['GET', '/repos/o/r/pulls/1/merge-async/u1'], ['DELETE', '/repos/o/r/git/refs/heads/alice/p']]);
	const s = fakeState(r);
	check("…deleting a merged PR's branch moves the PR on it to that PR's base", s.prs[1].merged && !at(r, 'alice/p') && s.prs[2].open && s.prs[2].base === 'main', JSON.stringify(s.prs[2]));
	callFake(r, stackOf(r), [['DELETE', '/repos/o/r/git/refs/heads/alice/q']]);
	check('…deleting a branch no merged PR had closes the PR on it', !fakeState(r).prs[3].open && fakeState(r).prs[3].base === 'alice/q', JSON.stringify(fakeState(r).prs[3]));
	const [restore, reopen] = callFake(r, stackOf(r), [['POST', '/repos/o/r/git/refs', { ref: 'refs/heads/alice/q', sha: r.q }], ['PATCH', '/repos/o/r/pulls/3', { state: 'open' }]]);
	check('…and once the branch is back, the PR can be reopened', restore.status === 200 && reopen.status === 200 && at(r, 'alice/q') === r.q && fakeState(r).prs[3].open, JSON.stringify([restore, reopen]));
	r.close();
}

// a three-PR stack: P merges, and Q and R are rebuilt, bottom up (Q on main, R on Q). Their descriptions are left as
// they were, their checks are dispatched (pr-policy passing on their old "Tested at": the tested commits still carry
// P's unsquashed commit, which main has a copy of), the bot asks itself for a review in a few minutes, and that
// review merges Q: the approval of Q's old head holds over the bot's push. Then R the same way.
{
	const r = stackRepos();
	const STACK = stackOf(r);
	const first = reviewRepo(r, STACK);
	check('the bottom of the stack merges', JSON.stringify(mergedPrs(first)) === '[1]', JSON.stringify(mergedPrs(first)));
	const q = at(r, 'alice/q'), rr = at(r, 'alice/r'), main = at(r, 'main');
	check('Q is rebuilt on main', q !== r.q && at(r, 'alice/q~2') === main, `${q} on ${at(r, 'alice/q~2')}, main ${main}`);
	check('…making exactly its old changes', changes(r.server, main, q) === changes(r.server, r.p, r.q));
	check('R is rebuilt on Q', rr !== r.r && at(r, 'alice/r~1') === q && changes(r.server, q, rr) === changes(r.server, r.q, r.r));
	const moves = (writes) => writes.fake.filter((f) => f.fake === 'base-deleted');
	check("the bot doesn't change Q's base, which GitHub refuses with R on it", !first.some((w) => w.method === 'PATCH' && w.body?.base), JSON.stringify(first.filter((w) => w.method === 'PATCH')));
	check("…it deletes P's branch, and GitHub moves Q to main", first.some((w) => w.method === 'DELETE' && /alice\/p$/.test(w.path)) && !at(r, 'alice/p')
		&& JSON.stringify(moves(first)) === JSON.stringify([{ fake: 'base-deleted', ref: 'alice/p', how: 'retarget', prs: [2] }]) && fakeState(r).prs[2].base === 'main', JSON.stringify(moves(first)));
	check('their descriptions are left as they were', fakeState(r).prs[2].body === bodyFor(r.q) && fakeState(r).prs[3].body === bodyFor(r.r) && bodyEdits(first).length === 0, JSON.stringify(bodyEdits(first)));
	check('their checks are started on the new heads, then a review in a few minutes', JSON.stringify(dispatches(first)) === JSON.stringify(['precommit.yml alice/q', 'pr-policy.yml alice/q #2', 'precommit.yml alice/r', 'pr-policy.yml alice/r #3', 'pr-bot.yml main in 5 min']), JSON.stringify(dispatches(first)));
	check("pr-policy passes on Q's and R's new heads, with their old \"Tested at\"", JSON.stringify(policies(r, first).map((p) => [p.pr, p.head, p.tested, p.errors.length])) === JSON.stringify([[2, q, `${short(r.q)} same`, 0], [3, rr, `${short(r.r)} same`, 0]]), JSON.stringify(policies(r, first)));
	check('each says it was rebuilt, and that its results hold', /^The PR bot rebuilt this PR on `main` after #1 merged/.test(commentsOn(first, 2)[0] || '') && /so do the results in its Testing section/.test(commentsOn(first, 2)[0] || '') && /^The PR bot rebuilt this PR on #2 \(which it rebuilt too\) after #1 merged/.test(commentsOn(first, 3)[0] || ''), JSON.stringify([commentsOn(first, 2), commentsOn(first, 3)]));
	check("Q's approval of its old head holds, and it's ready", statusOf(first, q)?.description === 'Ready: the bot merges it on its next pass' && !first.some((w) => /dismissals$/.test(w.path)), JSON.stringify(statusOf(first, q)));
	check('R waits for Q', /^Stacked on #2/.test(statusOf(first, rr)?.description || ''), JSON.stringify(statusOf(first, rr)));

	const second = reviewRepo(r, STACK);   // the review the bot asked for
	const r2 = at(r, 'alice/r'), main2 = at(r, 'main');
	check('then the delayed review merges Q', JSON.stringify(mergedPrs(second)) === '[2]', JSON.stringify(mergedPrs(second)));
	check("…deletes Q's branch, and GitHub moves R to main", JSON.stringify(moves(second).map((f) => [f.ref, f.how, f.prs])) === JSON.stringify([['alice/q', 'retarget', [3]]]) && fakeState(r).prs[3].base === 'main' && !second.some((w) => w.method === 'PATCH' && w.body?.base), JSON.stringify(moves(second)));
	check('…and R is rebuilt on main', at(r, 'alice/r~1') === main2 && changes(r.server, main2, r2) === changes(r.server, r.q, r.r));
	check("…pr-policy passes again with R's first \"Tested at\"", JSON.stringify(policies(r, second).map((p) => [p.pr, p.head, p.tested, p.errors.length])) === JSON.stringify([[3, r2, `${short(r.r)} same`, 0]]), JSON.stringify(policies(r, second)));
	check('…its approval holds over both of the bot\'s pushes, and it\'s ready', statusOf(second, r2)?.description === 'Ready: the bot merges it on its next pass', JSON.stringify(statusOf(second, r2)));
	const third = reviewRepo(r, STACK);
	check('then R merges, and main has all three', JSON.stringify(mergedPrs(third)) === '[3]' && at(r, 'main^{tree}') === at(r, `${r.r}^{tree}`), JSON.stringify(mergedPrs(third)));
	r.close();
}

// a description tested at a commit with other changes (here, the PR below's head): pr-policy fails on the rebuilt head
{
	const r = stackRepos();
	const prs = stackOf(r).slice(0, 2).map((p) => (p.number === 2 ? { ...p, body: bodyFor(r.p) } : p));
	const writes = reviewRepo(r, prs);
	const q = at(r, 'alice/q');
	check('a description tested at other changes: Q is still rebuilt', q !== r.q && bodyEdits(writes).length === 0);
	check('…and pr-policy fails on its new head', policies(r, writes).some((p) => p.pr === 2 && p.head === q && p.tested === `${short(r.p)} different` && p.errors.some((e) => /makes different changes/.test(e))) && statusOf(writes, q)?.description === 'Waiting for pr-policy', JSON.stringify([policies(r, writes), statusOf(writes, q)]));
	r.close();
}

// a merge made by hand: the push to main runs the bot (a review), which first brings the open PRs up to date with the
// new main, bottom up through the stack that was on the merged PR: GitHub moved Q to main when it deleted P's branch,
// and Q's own commits start at P's head. Once per merge: the next pass leaves them.
{
	const r = stackRepos();
	git(r.work, ['switch', '--quiet', '-c', 'alice/x', 'main']);
	const x = commitFiles(r.work, 'X', { 'a.txt': lines(1, 10, { 9: 'x' }) });
	git(r.work, ['push', '--quiet', 'origin', 'alice/x']);
	const prs = [...stackOf(r).map((p) => ({ ...p, approved: false })), { number: 4, base: 'main', ref: 'alice/x', body: bodyFor(x) }];
	const before = reviewRepo(r, prs);
	check('a merge by hand: before it, nothing is rebuilt', dispatches(before).length === 0 && at(r, 'alice/q') === r.q, JSON.stringify(dispatches(before)));
	const merged = humanMerge(r, 1);
	const writes = reviewRepo(r, prs);
	const q = at(r, 'alice/q'), rr = at(r, 'alice/r'), x2 = at(r, 'alice/x');
	check('…after it, the PR that was stacked on it is rebuilt on main, from its own commits', at(r, 'alice/q~2') === merged && changes(r.server, merged, q) === changes(r.server, r.p, r.q), `${q} on ${at(r, 'alice/q~2')}`);
	check('…the one above that on it', at(r, 'alice/r~1') === q && changes(r.server, q, rr) === changes(r.server, r.q, r.r));
	check('…and the plain PR on main', at(r, 'alice/x~1') === merged && x2 !== x);
	check('…bottom up, each with its checks, then one review later', JSON.stringify(dispatches(writes)) === JSON.stringify(['precommit.yml alice/q', 'pr-policy.yml alice/q #2', 'precommit.yml alice/r', 'pr-policy.yml alice/r #3', 'precommit.yml alice/x', 'pr-policy.yml alice/x #4', 'pr-bot.yml main in 5 min']), JSON.stringify(dispatches(writes)));
	check('…pr-policy passing on each with its old "Tested at"', policies(r, writes).length === 3 && policies(r, writes).every((p) => p.errors.length === 0 && / same$/.test(p.tested)), JSON.stringify(policies(r, writes)));
	check('…each comment names the merge', [2, 3, 4].every((n) => /after #1 merged/.test(commentsOn(writes, n)[0] || '')), JSON.stringify([2, 3, 4].map((n) => commentsOn(writes, n))));
	check('…and main is marked as up to date', fakeState(r).updated.includes(merged));
	const again = reviewRepo(r, prs);
	check('…so the next pass rebuilds nothing again', dispatches(again).length === 0 && at(r, 'alice/q') === q && at(r, 'alice/x') === x2, JSON.stringify(dispatches(again)));
	r.close();
}

// a merge by hand after which the PR stacked on the merged one merged main in ("Update branch", with another PR's
// change): when main moves again, its own commits start where it merged main, not at the merged PR's head
{
	const r = stackRepos();
	const w = r.work;
	git(w, ['switch', '--quiet', '-c', 'alice/s', 'main']);
	const s = commitFiles(w, 'S', { 's.txt': 's\n' });
	git(w, ['switch', '--quiet', '-c', 'alice/x', 'main']);
	const x = commitFiles(w, 'X', { 'a.txt': lines(1, 10, { 9: 'x' }) });
	git(w, ['push', '--quiet', 'origin', 'alice/s', 'alice/x']);
	const prs = [...stackOf(r).slice(0, 2).map((p) => ({ ...p, approved: false })), { number: 4, base: 'main', ref: 'alice/s', body: bodyFor(s) }, { number: 5, base: 'main', ref: 'alice/x', body: bodyFor(x) }];
	reviewRepo(r, prs);
	humanMerge(r, 1);
	humanMerge(r, 4);
	git(w, ['fetch', '--quiet', 'origin']);
	git(w, ['switch', '--quiet', 'alice/q']);
	git(w, ['merge', '--quiet', '--no-edit', 'origin/main'], { ok: [1] });   // P's line, squashed, next to Q's
	const updated = commitFiles(w, 'Merge main', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'q' }) });
	git(w, ['push', '--quiet', 'origin', 'alice/q']);
	const file = path.join(r.root, 'fake-github.json');
	const state = JSON.parse(fs.readFileSync(file, 'utf8'));
	state.prs[2].body = bodyFor(updated);   // tested again after the update
	fs.writeFileSync(file, JSON.stringify(state));
	const merged = humanMerge(r, 5);
	const writes = reviewRepo(r, prs);
	const q = at(r, 'alice/q');
	check('a PR that merged main after the PR below merged is rebuilt from where it merged main', q !== updated && at(r, `${q}^{tree}`) === git(r.server, ['merge-tree', '--write-tree', merged, updated]) && commentsOn(writes, 2).every((c) => /^The PR bot rebuilt/.test(c)), JSON.stringify(commentsOn(writes, 2)));
	check('…and pr-policy passes on its new head', policies(r, writes).some((p) => p.pr === 2 && p.head === q && p.errors.length === 0), JSON.stringify(policies(r, writes)));
	r.close();
}

// a merge by hand that kept the branch, which then got a new commit: the PR on it isn't moved to main, which would take
// that commit into it unreviewed
{
	const r = stackRepos();
	const prs = stackOf(r).slice(0, 2).map((p) => ({ ...p, approved: false }));
	reviewRepo(r, prs);
	humanMerge(r, 1, { keepBranch: true });
	git(r.work, ['switch', '--quiet', 'alice/p']);
	commitFiles(r.work, 'P: after the merge', { 'p.txt': 'p\n' });
	git(r.work, ['push', '--quiet', 'origin', 'alice/p']);
	const writes = reviewRepo(r, prs);
	check('a kept branch with new commits: the PR on it stays on it', fakeState(r).prs[2].base === 'alice/p' && at(r, 'alice/q') === r.q && !writes.some((w) => w.method === 'PATCH'), JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
	check('…and the branch is kept', at(r, 'alice/p') && !writes.some((w) => w.method === 'DELETE'), JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
	check('…and says why', /its base, `alice\/p`, has new commits since #1 merged it/.test(commentsOn(writes, 2)[0] || ''), JSON.stringify(commentsOn(writes, 2)));
	r.close();
}

// …and when the merged PR's branch is kept, the PRs stacked on it are still on it: the bot deletes the branch, which
// is still at the merged PR's head, and GitHub moves them to main
{
	const r = stackRepos();
	const prs = stackOf(r).map((p) => ({ ...p, approved: false }));
	reviewRepo(r, prs);
	const merged = humanMerge(r, 1, { keepBranch: true });
	const writes = reviewRepo(r, prs);
	const q = at(r, 'alice/q');
	const moved = writes.fake.filter((f) => f.fake === 'base-deleted');
	check('a merge by hand that kept the branch: the bot deletes it, and GitHub moves the PR on it to main', !at(r, 'alice/p') && fakeState(r).prs[2].base === 'main'
		&& JSON.stringify(moved.map((f) => [f.ref, f.how, f.prs])) === JSON.stringify([['alice/p', 'retarget', [2]]]) && !writes.some((w) => w.method === 'PATCH' && w.body?.base), JSON.stringify(writes.map((w) => `${w.method} ${w.path}`)));
	check('…and it is rebuilt on main from its own commits, the one above it on it', at(r, 'alice/q~2') === merged && changes(r.server, merged, q) === changes(r.server, r.p, r.q)
		&& at(r, 'alice/r~1') === q && policies(r, writes).length === 2 && policies(r, writes).every((p) => p.errors.length === 0), JSON.stringify(policies(r, writes)));
	r.close();
}

/** The stack, with alice/q having merged alice/p back in after p changed the line q changes: replaying q conflicts. */
function conflictRepos() {
	const r = makeRepos();
	const w = r.work;
	git(w, ['switch', '--quiet', '-c', 'alice/p']);
	commitFiles(w, 'P', { 'a.txt': lines(1, 10, { 3: 'p' }) });
	git(w, ['switch', '--quiet', '-c', 'alice/q']);
	commitFiles(w, 'Q', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'q' }) });
	git(w, ['switch', '--quiet', 'alice/p']);
	commitFiles(w, 'P again', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'p' }) });
	git(w, ['switch', '--quiet', 'alice/q']);
	git(w, ['merge', '--quiet', 'alice/p'], { ok: [1] });
	commitFiles(w, 'Merge alice/p', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'q and p' }) });
	git(w, ['switch', '--quiet', '-c', 'alice/r']);
	commitFiles(w, 'R', { 'r.txt': 'r\n' });
	git(w, ['push', '--quiet', 'origin', 'alice/p', 'alice/q', 'alice/r']);
	return { ...r, q: at(r, 'alice/q'), r: at(r, 'alice/r') };
}

// a replay that conflicts: Q is left as it was, with a comment saying why, and so is R above it
{
	const r = conflictRepos();
	const writes = reviewRepo(r, stackOf(r));
	check('a stack whose replay conflicts: the bottom still merges', JSON.stringify(mergedPrs(writes)) === '[1]', JSON.stringify(mergedPrs(writes)));
	check('…nothing is pushed', at(r, 'alice/q') === r.q && at(r, 'alice/r') === r.r);
	const said = commentsOn(writes, 2);
	check('…Q says the replay conflicts, and how to rebuild it by hand', said.length === 1 && /conflicts in `a\.txt`/.test(said[0]) && /needs rebuilding by hand/.test(said[0]) && /git rebase --onto origin\/main [0-9a-f]{40} alice\/q/.test(said[0]), JSON.stringify(said));
	check('…and that R was left too', /#3/.test(said[0] || '') && commentsOn(writes, 3).length === 0, JSON.stringify(commentsOn(writes, 3)));
	check('…no checks are started for them', !dispatches(writes).some((d) => /alice\/[qr]/.test(d)), JSON.stringify(dispatches(writes)));
	r.close();
}

// a plain PR that conflicts with main after a merge: one comment per main it can't be rebuilt on, not one per pass
{
	const r = plainRepos();
	const prs = [
		{ number: 1, base: 'main', ref: 'alice/a', approved: true, body: bodyFor(r.a) },
		{ number: 2, base: 'main', ref: 'alice/c', approved: true, body: bodyFor(r.c) },
		{ number: 3, base: 'main', ref: 'alice/d', body: bodyFor(r.d) },
	];
	const first = reviewRepo(r, prs);
	check('a conflict with main: the PR is left as it was', JSON.stringify(mergedPrs(first)) === '[1]' && at(r, 'alice/c') === r.c && at(r, 'alice/d') !== r.d);
	check('…with a comment saying where', commentsOn(first, 2).length === 1 && /conflicts in `a\.txt`/.test(commentsOn(first, 2)[0]) && /<!-- pr-bot: left [0-9a-f]{40} conflict on [0-9a-f]{40} -->$/.test(commentsOn(first, 2)[0]), JSON.stringify(commentsOn(first, 2)));
	const again = reviewRepo(r, prs, {}, ['update']);
	check('…asked again on the same main (Run workflow → update), it doesn\'t say it again', commentsOn(again, 2).length === 0 && at(r, 'alice/c') === r.c, JSON.stringify(commentsOn(again, 2)));
	humanMerge(r, 3);
	const third = reviewRepo(r, prs);
	check('…but once more on a new main', commentsOn(third, 2).length === 1 && fakeState(r).comments[2].length === 2, JSON.stringify(commentsOn(third, 2)));
	r.close();
}

// main moved under the merge (someone merged a PR with Q's second change a moment before): the replay is clean, but Q
// would change less than it did, so it's left as it was
{
	const r = stackRepos();
	git(r.work, ['switch', '--quiet', 'main']);
	const race = commitFiles(r.work, 'Someone else', { 'q.txt': 'q\n' });
	git(r.work, ['push', '--quiet', 'origin', 'main:refs/tags/race']);
	const writes = reviewRepo(r, stackOf(r), { race });
	check('a replay that changes the diff: nothing is pushed', JSON.stringify(mergedPrs(writes)) === '[1]' && at(r, 'alice/q') === r.q && at(r, 'alice/r') === r.r);
	check('…and Q says its changes would differ', /no longer make exactly the same changes/.test(commentsOn(writes, 2)[0] || ''), JSON.stringify(commentsOn(writes, 2)));
	r.close();
}

// someone pushed to Q after the bot read it (or GitHub showed an old head): the lease fails, their push stays, and R
// isn't touched. No comment, since it may be GitHub's lag; main isn't marked, so the next review looks again.
{
	const r = stackRepos();
	git(r.work, ['switch', '--quiet', 'alice/q']);
	const theirs = commitFiles(r.work, 'Q: one more', { 'q2.txt': 'q\n' });
	git(r.work, ['push', '--quiet', 'origin', 'alice/q']);
	const prs = stackOf(r).map((p) => (p.number === 2 ? { ...p, apiHead: r.q } : p));
	const writes = reviewRepo(r, prs);
	check('a push meanwhile: the lease keeps it', JSON.stringify(mergedPrs(writes)) === '[1]' && at(r, 'alice/q') === theirs && at(r, 'alice/r') === r.r);
	check('…without a comment, and main isn\'t marked up to date, for the next review to try again', commentsOn(writes, 2).length === 0 && !fakeState(r).updated.includes(at(r, 'main')), JSON.stringify([commentsOn(writes, 2), fakeState(r).updated]));
	r.close();
}

// PRs the bot mustn't rebuild, each stacked on P: one from a fork, one changing CI, one on hold, and one whose branch
// is another PR's head too. Each is left as it was with a comment saying why; an ordinary one is rebuilt.
{
	const r = makeRepos();
	const w = r.work;
	git(w, ['switch', '--quiet', '-c', 'alice/p']);
	const p = commitFiles(w, 'P', { 'a.txt': lines(1, 10, { 3: 'p' }) });
	const branch = (name, files) => {
		git(w, ['switch', '--quiet', '-c', name, p]);
		return commitFiles(w, name, { 'a.txt': lines(1, 10, { 3: 'p', 4: name }), ...files });
	};
	const fork = branch('mallory/q', {});
	const optionLike = branch('mallory/x', {});   // a fork's branch named like a git option
	const ci = branch('alice/ci', { '.github/workflows/x.yml': 'on: push\n' });
	const held = branch('alice/held;echo', {});
	branch('alice/plain', {});
	const shared = branch('alice/shared', {});
	git(w, ['push', '--quiet', 'origin', 'alice/p', 'alice/ci', 'alice/held;echo', 'alice/plain', 'alice/shared', `${fork}:refs/pull/2/head`, `${optionLike}:refs/pull/8/head`]);
	const prs = [
		{ number: 1, base: 'main', ref: 'alice/p', approved: true },
		{ number: 2, base: 'alice/p', ref: 'mallory/q', approved: true, fork: true },
		{ number: 3, base: 'alice/p', ref: 'alice/ci', approved: true },
		{ number: 4, base: 'alice/p', ref: 'alice/held;echo', approved: true, labels: ['hold'] },
		{ number: 5, base: 'alice/p', ref: 'alice/plain', approved: true },
		{ number: 6, base: 'alice/p', ref: 'alice/shared', approved: true },
		{ number: 7, base: 'main', ref: 'alice/shared' },
		{ number: 8, base: 'alice/p', ref: '--exec=touch$IFS/tmp/x', approved: true, fork: true },
	];
	const writes = reviewRepo(r, prs);
	check('fork, CI and held PRs aren\'t pushed', at(r, 'alice/ci') === ci && at(r, 'alice/held;echo') === held && at(r, 'refs/pull/2/head') === fork && !at(r, 'mallory/q'));
	check('…the fork PR says why', /comes from a fork/.test(commentsOn(writes, 2)[0] || ''), JSON.stringify(commentsOn(writes, 2)));
	check('…the CI PR says why', /changes CI or the PR tools \(`\.github\/workflows\/x\.yml`\)/.test(commentsOn(writes, 3)[0] || ''), JSON.stringify(commentsOn(writes, 3)));
	check('…the held PR says why', /labelled `hold`/.test(commentsOn(writes, 4)[0] || ''), JSON.stringify(commentsOn(writes, 4)));
	check('…with its branch quoted in the command to paste, from P\'s head', commentsOn(writes, 4)[0]?.includes(`git rebase --onto origin/main ${p} 'alice/held;echo'\n`), JSON.stringify(commentsOn(writes, 4)));
	check('…and so does the one sharing its branch', at(r, 'alice/shared') === shared && /also the head of #7/.test(commentsOn(writes, 6)[0] || ''), JSON.stringify(commentsOn(writes, 6)));
	check('…and a branch named like an option is left out of the command', commentsOn(writes, 8)[0]?.includes(`git rebase --onto origin/main ${p}\n`) && !/--exec/.test(commentsOn(writes, 8)[0]), JSON.stringify(commentsOn(writes, 8)));
	check('…and the ordinary one is rebuilt', at(r, 'alice/plain~1') === at(r, 'main') && /^The PR bot rebuilt this PR/.test(commentsOn(writes, 5)[0] || ''), JSON.stringify(commentsOn(writes, 5)));
	check('…with checks started for it alone, and one review later', JSON.stringify(dispatches(writes)) === JSON.stringify(['precommit.yml alice/plain', 'pr-policy.yml alice/plain #5', 'pr-bot.yml main in 5 min']), JSON.stringify(dispatches(writes)));
	const again = reviewRepo(r, prs, {}, ['update']);
	check('…and asked again, they don\'t say it again', [2, 3, 4, 6, 7, 8].every((n) => commentsOn(again, n).length === 0), JSON.stringify([2, 3, 4, 6, 7, 8].map((n) => commentsOn(again, n))));
	r.close();
}

// a plain PR on hold that falls behind main: left as it was, said once (per head)
{
	const r = plainRepos();
	const prs = [
		{ number: 1, base: 'main', ref: 'alice/a', approved: true, body: bodyFor(r.a) },
		{ number: 2, base: 'main', ref: 'alice/b', approved: true, labels: ['hold'], body: bodyFor(r.b) },
	];
	const first = reviewRepo(r, prs);
	check('a held PR behind main isn\'t rebuilt', JSON.stringify(mergedPrs(first)) === '[1]' && at(r, 'alice/b') === r.b && !dispatches(first).some((d) => /alice\/b/.test(d)), JSON.stringify(dispatches(first)));
	check('…and says why once', commentsOn(first, 2).length === 1 && /labelled `hold`/.test(commentsOn(first, 2)[0]), JSON.stringify(commentsOn(first, 2)));
	const again = reviewRepo(r, prs, {}, ['update']);
	check('…not again on the next update', commentsOn(again, 2).length === 0 && at(r, 'alice/b') === r.b, JSON.stringify(commentsOn(again, 2)));
	r.close();
}

// GitHub closes the PR stacked on the merged one when the bot deletes that branch (as it can, right after a merge), and that PR has
// another on it, so its base can't be changed either: the branch is put back where it was, the PR reopened, and it's
// left as it was, with the one above it, saying so once. main is done with: the next review doesn't try again.
{
	const r = stackRepos();
	const STACK = stackOf(r);
	const writes = reviewRepo(r, STACK, { onDelete: 'close' });
	const s = fakeState(r), main = at(r, 'main');
	check('GitHub closes the stacked PR: the bottom still merges, and the bot deletes its branch', JSON.stringify(mergedPrs(writes)) === '[1]'
		&& JSON.stringify(writes.fake.filter((f) => f.fake === 'base-deleted').map((f) => [f.ref, f.how, f.prs])) === JSON.stringify([['alice/p', 'close', [2]]]));
	check('…then puts the branch back at the merged head, and reopens the PR', at(r, 'alice/p') === r.p && s.prs[2].open && s.prs[2].base === 'alice/p'
		&& writes.some((w) => w.method === 'POST' && w.path.endsWith('/git/refs') && w.body.ref === 'refs/heads/alice/p' && w.body.sha === r.p), JSON.stringify(s.prs[2]));
	check('…tries changing its base, which GitHub refuses with #3 on it, and rebuilds nothing', writes.some((w) => w.method === 'PATCH' && w.path.endsWith('/pulls/2') && w.body?.base === 'main')
		&& at(r, 'alice/q') === r.q && at(r, 'alice/r') === r.r && !dispatches(writes).some((d) => /alice\/[qr]/.test(d)), JSON.stringify(dispatches(writes)));
	const said = commentsOn(writes, 2);
	check('…and says so on it, once, with the PR above it', said.length === 1 && /GitHub closed this PR; the bot put the branch back at `[0-9a-f]{7}` and reopened this PR, but GitHub wouldn't let it change the base/.test(said[0])
		&& /#3/.test(said[0]) && commentsOn(writes, 3).length === 0 && s.updated.includes(main), JSON.stringify(said));
	const again = reviewRepo(r, STACK);
	check('…and the next review leaves it', !again.some((w) => w.method === 'DELETE' || w.method === 'PATCH') && commentsOn(again, 2).length === 0 && at(r, 'alice/p') === r.p, JSON.stringify(again.map((w) => `${w.method} ${w.path}`)));
	r.close();
}

// GitHub closes the stacked PR, which has none on it: the bot puts the branch back, reopens the PR, moves it to main
// itself (allowed for a PR with none on it), deletes the branch again, and rebuilds the PR
{
	const r = stackRepos();
	const writes = reviewRepo(r, stackOf(r).slice(0, 2), { onDelete: 'close' });
	const q = at(r, 'alice/q'), main = at(r, 'main');
	check('GitHub closes a stacked PR with none on it: the bot reopens it and moves it to main itself', fakeState(r).prs[2].open && fakeState(r).prs[2].base === 'main' && !at(r, 'alice/p'), JSON.stringify(fakeState(r).prs[2]));
	check('…and rebuilds it on main, with its checks', at(r, 'alice/q~2') === main && changes(r.server, main, q) === changes(r.server, r.p, r.q)
		&& JSON.stringify(dispatches(writes)) === JSON.stringify(['precommit.yml alice/q', 'pr-policy.yml alice/q #2', 'pr-bot.yml main in 5 min']) && /^The PR bot rebuilt this PR on `main`/.test(commentsOn(writes, 2)[0] || ''), JSON.stringify(dispatches(writes)));
	r.close();
}

// GitHub leaves the stacked PR on the deleted branch, and won't change its base: the branch is put back, and the PR is
// left as it was, saying so
{
	const r = stackRepos();
	const writes = reviewRepo(r, stackOf(r).slice(0, 2), { onDelete: 'leave', fail: ['retarget'] });
	check('GitHub leaves the stacked PR on the deleted branch: the bot puts the branch back, and rebuilds nothing', at(r, 'alice/p') === r.p && fakeState(r).prs[2].open && fakeState(r).prs[2].base === 'alice/p' && at(r, 'alice/q') === r.q, JSON.stringify(fakeState(r).prs[2]));
	check('…and says so, once', commentsOn(writes, 2).length === 1 && /GitHub didn't move it to `main`; the bot put the branch back at/.test(commentsOn(writes, 2)[0]), JSON.stringify(commentsOn(writes, 2)));
	r.close();
}

// GitHub closes the stacked PR, and won't let the bot put the branch back: the PR says how to do it by hand, and main
// isn't marked as done, for the next review to look again
{
	const r = stackRepos();
	const writes = reviewRepo(r, stackOf(r).slice(0, 2), { onDelete: 'close', fail: ['restore'] });
	const said = commentsOn(writes, 2);
	check("a branch the bot couldn't put back: the closed PR says how to", !at(r, 'alice/p') && !fakeState(r).prs[2].open && said.length === 1
		&& said[0].includes(`GitHub closed this PR, and the bot couldn't put the branch back: push \`${r.p}\` back to it, reopen this PR, then change its base to \`main\``), JSON.stringify(said));
	check('…and main is left for the next review', !fakeState(r).updated.includes(at(r, 'main')), JSON.stringify(fakeState(r).updated));
	r.close();
}

// GitHub refuses the dispatches: the PR is still rebuilt, and its comment says its checks need starting
{
	const r = stackRepos();
	const writes = reviewRepo(r, stackOf(r).slice(0, 2), { fail: ['dispatch'] });
	check('a rebuilt PR whose checks couldn\'t start says so', at(r, 'alice/q') !== r.q && /couldn't start `precommit\.yml` and `pr-policy\.yml`/.test(commentsOn(writes, 2)[0] || ''), JSON.stringify(commentsOn(writes, 2)));
	r.close();
}

// ---- settings (.github/pr-automation.json) ---------------------------------------------------------------------------

// the merge method: a merge commit keeps the guideline message; a rebase has none to give
{
	const merged = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true }], { config: { merge: { method: 'merge' } } });
	const body = merged.find((w) => /\/pulls\/4\/merge$/.test(w.path))?.body;
	check('merge.method "merge": a merge commit with the title and the PR URL', body?.merge_method === 'merge' && body.commit_title === '[Docs] Fix: Thing 4' && body.commit_message === 'https://github.com/o/r/pull/4', JSON.stringify(body));
	const rebased = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true }], { config: { merge: { method: 'rebase' } } });
	const rebase = rebased.find((w) => /\/pulls\/4\/merge$/.test(w.path))?.body;
	check('merge.method "rebase": no commit message', rebase?.merge_method === 'rebase' && !('commit_title' in rebase) && !('commit_message' in rebase), JSON.stringify(rebase));
	const squash = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true }]).find((w) => /\/pulls\/4\/merge$/.test(w.path))?.body;
	check('…and squash by default, pinned to the reviewed head', squash?.merge_method === 'squash' && squash.sha === 'h4' && squash.commit_title === '[Docs] Fix: Thing 4', JSON.stringify(squash));
}

// the checks it waits for
{
	const config = { merge: { requiredChecks: ['precommit', 'pr-policy', 'lint'] } };
	const waiting = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true }], { config });
	check('merge.requiredChecks: it waits for every one', merges(waiting).length === 0 && statusOf(waiting, 'h4')?.description === 'Waiting for lint', JSON.stringify(statusOf(waiting, 'h4')));
	const green = review({ prs: [{ number: 4, base: 'main', ref: 'alice/y', approved: true }], checks: ['precommit', 'pr-policy', 'lint'] }, { config });
	check('…and merges once they pass', JSON.stringify(merges(green)) === '[4]', JSON.stringify(merges(green)));
}

// approvals: more than one, and more for CI changes
{
	const two = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true }], { config: { merge: { approvals: 2, ciApprovals: 3 } } });
	check('merge.approvals 2: one approval waits', merges(two).length === 0 && statusOf(two, 'h4')?.description === 'Needs 2 reviews of the latest commit (has 1)', JSON.stringify(statusOf(two, 'h4')));
	const ci = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true, files: ['src/a.js', '.github/workflows/precommit.yml'] }]);
	check('a PR that changes CI needs merge.ciApprovals', merges(ci).length === 0 && statusOf(ci, 'h4')?.description === 'Changes CI or the PR tools: needs 2 reviews of the latest commit (has 1)', JSON.stringify(statusOf(ci, 'h4')));
	const tools = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true, files: ['tools/pr-config.mjs'] }]);
	check('…the PR tools count as CI', merges(tools).length === 0, JSON.stringify(statusOf(tools, 'h4')));
	const carriedCi = review([{ number: 8, base: 'main', ref: 'alice/w', approved: false, carry: 'same', files: ['.github/pr-automation.json'] }]);
	check('…and never carry an approval over', merges(carriedCi).length === 0 && !carriedCi.some((w) => /\/issues\/8\/comments$/.test(w.path)), JSON.stringify(carriedCi.map((w) => w.path)));
}

// its own status's name, and the hold label's
{
	const writes = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true }, { number: 5, base: 'main', ref: 'alice/z', approved: true, labels: ['do-not-merge'] }], { config: { merge: { status: 'merge-bot' }, labels: { hold: 'do-not-merge' } } });
	const contexts = [...new Set(writes.filter((w) => /\/statuses\//.test(w.path)).map((w) => w.body.context))];
	check('merge.status names the status (and its -update mark)', JSON.stringify(contexts.sort()) === JSON.stringify(['merge-bot', 'merge-bot-update']), JSON.stringify(contexts));
	const held = review([{ number: 5, base: 'main', ref: 'alice/z', approved: true, labels: ['do-not-merge'] }], { config: { labels: { hold: 'do-not-merge' } } });
	check('labels.hold names the hold label', merges(held).length === 0 && /remove the `do-not-merge` label/.test(statusOf(held, 'h5')?.description || ''), JSON.stringify(statusOf(held, 'h5')));
}

// the modules it starts after its own merge, whose push starts no workflows: postcommit, and Pages once
{
	const config = { postcommit: { enabled: true }, pages: { enabled: true } };
	const writes = review([{ number: 4, base: 'main', ref: 'alice/y', approved: true }], { config });
	check('postcommit and Pages on: each is started once after the merge', JSON.stringify(merges(writes)) === '[4]' && JSON.stringify(dispatches(writes)) === JSON.stringify(['postcommit.yml main', 'pages.yml main']), JSON.stringify(dispatches(writes)));
	const branches = ['alice/old'].map((name, i) => ({ name, commit: { sha: `stale-${i}` } }));
	const pruned = review({ prs: [], branches }, { args: ['prune-branches'], config });
	check('…and Pages after pruning deleted a branch', JSON.stringify(dispatches(pruned)) === JSON.stringify(['pages.yml main']), JSON.stringify(dispatches(pruned)));
	check('…not after a pass that changed nothing', dispatches(review([{ number: 4, base: 'main', ref: 'alice/y', approved: false }], { config })).length === 0);
	check('…nor in a dry run', review({ prs: [], branches }, { args: ['prune-branches', '--dry-run'], config }).length === 0);
}

// branches.keep and the screenshot branch are never pruned
{
	const branches = ['alice/old', 'release/1.x', 'bot/screenshots'].map((name, i) => ({ name, commit: { sha: `stale-${i}` } }));
	const deleted = (config) => review({ prs: [], branches }, { args: ['prune-branches'], config }).filter((w) => w.method === 'DELETE').map((w) => w.path.replace(/^.*\/heads\//, ''));
	check('branches.keep is kept, and so is the screenshot branch', JSON.stringify(deleted({ branches: { keep: ['release/1.x'] } })) === '["alice/old"]', JSON.stringify(deleted({ branches: { keep: ['release/1.x'] } })));
	check('…wherever screenshots.branch puts it', JSON.stringify(deleted({ screenshots: { branch: 'release/1.x' } })) === '["alice/old","bot/screenshots"]', JSON.stringify(deleted({ screenshots: { branch: 'release/1.x' } })));
}

// rebuild.enabled off: nothing is rebuilt, but the merged branch still goes, so GitHub moves the PR stacked on it
{
	const r = stackRepos();
	const writes = review({ git: r.server, state: path.join(r.root, 'fake-github.json'), prs: stackOf(r) }, { serverUrl: `file://${r.root}`, config: { rebuild: { enabled: false } } });
	check('rebuild off: the bottom merges, and its branch is deleted', JSON.stringify(mergedPrs(writes)) === '[1]' && !at(r, 'alice/p') && fakeState(r).prs[2].base === 'main', JSON.stringify(fakeState(r).prs[2]));
	check('…but nothing is rebuilt or started', at(r, 'alice/q') === r.q && at(r, 'alice/r') === r.r && dispatches(writes).length === 0, JSON.stringify(dispatches(writes)));
	check('…and the PR left behind says to update its branch', /behind main: update the branch/.test(statusOf(writes, r.q)?.description || '') || /Merge conflict/.test(statusOf(writes, r.q)?.description || ''), JSON.stringify(statusOf(writes, r.q)));
	const update = runBot({ git: r.server, state: path.join(r.root, 'fake-github.json'), prs: stackOf(r) }, ['update'], `file://${r.root}`, { rebuild: { enabled: false } });
	check('…and `update` refuses', update.status === 2 && /rebuild\.enabled is off/.test(update.stderr), update.stderr);
	r.close();
}

// a bad config stops the bot before it does anything
{
	const run = runBot({ prs: [{ number: 4, base: 'main', ref: 'alice/y', approved: true }] }, ['review'], 'file:///nonexistent', { merge: { method: 'octopus' } });
	check('a bad config: the bot stops, changing nothing', run.status !== 0 && run.writes.length === 0 && /merge\.method: expected one of squash, merge, rebase/.test(run.stderr), run.stderr);
}

/** The test config with `config` merged over it, as a file for one run (the test config itself when there's none). */
function configFile(config) {
	if (!config) return CONFIG_FILE;
	const merged = mergeInto(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')), config);
	const file = path.join(scratch, `config-${Math.random().toString(36).slice(2)}.json`);
	fs.writeFileSync(file, JSON.stringify(merged));
	return file;
}

function mergeInto(target, changes) {
	for (const [key, value] of Object.entries(changes)) {
		if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object') mergeInto(target[key], value);
		else target[key] = value;
	}
	return target;
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
