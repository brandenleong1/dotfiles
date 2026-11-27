// tools/restack.mjs against tiny local repositories: a stacked PR's own commits replayed onto a new base, with the
// same authors, messages and changes; a conflict, a changed diff, a branch not built on its base, and a push over
// someone else's push are refused; whether a tested commit makes the same changes as a head (sameChanges); and
// nothing a PR branch carries (or the machine's git config) runs while it works.
// Standalone suite: `npm test` and CI run it (tools/run-tests.mjs).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openRepo } from '../tools/restack.mjs';
import { git, makeRepos, commitFiles, lines, changes } from './fixtures/git-repos.mjs';

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
	if (ok) passed++;
	else { failed++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

/** main, a lower PR (p: line 3) and a PR stacked on it (q: lines 4 and 9, in two commits); then p squash-merged. */
function stackedRepos() {
	const repos = makeRepos();
	const { work } = repos;
	const base = git(work, ['rev-parse', 'HEAD']);
	git(work, ['switch', '--quiet', '-c', 'p']);
	const p = commitFiles(work, 'P: line 3', { 'a.txt': lines(1, 10, { 3: 'p' }) });
	git(work, ['switch', '--quiet', '-c', 'q']);
	commitFiles(work, 'Q: line 4\n\nWith a body.', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'q' }) }, { author: 'Bob <bob@example.com>' });
	const q = commitFiles(work, 'Q: line 9', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'q', 9: 'q' }), 'b.txt': 'new\n' });
	git(work, ['switch', '--quiet', 'main']);
	const squash = git(work, ['commit-tree', `${p}^{tree}`, '-p', base, '-m', 'Squash of P']);
	git(work, ['push', '--quiet', 'origin', `${squash}:refs/heads/main`, 'p', 'q']);
	return { ...repos, base, p, q, squash };
}

function open(repos) {
	return openRepo({ url: `file://${repos.server}` });
}

// a two-commit PR replays onto the squashed lower PR: same trees, authors, messages and changes; the bot commits it
{
	const r = stackedRepos();
	const repo = open(r);
	repo.fetch([r.squash, r.p, r.q]);
	const result = repo.rebuild({ oldBase: r.p, oldHead: r.q, newBase: r.squash });
	check('a stacked PR is rebuilt', result.status === 'rebuilt' && result.commits === 2, JSON.stringify(result));
	const pushed = repo.push({ branch: 'q', head: result.head, lease: r.q });
	check('…and pushed with a lease on its old head', pushed.status === 'pushed' && git(r.server, ['rev-parse', 'q']) === result.head, JSON.stringify(pushed));
	const log = git(r.server, ['log', '--format=%an <%ae>|%cn|%B%x00', `${r.squash}..q`]).split('\0').map((s) => s.trim()).filter(Boolean);
	check('…keeping each commit\'s author and message', log.length === 2 && log[1] === 'Bob <bob@example.com>|github-actions[bot]|Q: line 4\n\nWith a body.' && log[0].startsWith('Alice <alice@example.com>|github-actions[bot]|Q: line 9'), JSON.stringify(log));
	check('…on top of main', git(r.server, ['rev-parse', 'q~2']) === r.squash);
	check('…making the same changes', changes(r.server, r.squash, 'q') === changes(r.server, r.p, r.q));
	check('…with the same tree', git(r.server, ['rev-parse', 'q^{tree}']) === git(r.server, ['rev-parse', `${r.q}^{tree}`]));
	repo.close();
	r.close();
}

// someone pushed to the branch since: the lease fails and their push stays
{
	const r = stackedRepos();
	git(r.work, ['switch', '--quiet', 'q']);
	const theirs = commitFiles(r.work, 'Q: more', { 'c.txt': 'more\n' });
	git(r.work, ['push', '--quiet', 'origin', 'q']);
	const repo = open(r);
	repo.fetch([r.squash, r.p, r.q]);
	const result = repo.rebuild({ oldBase: r.p, oldHead: r.q, newBase: r.squash });
	const pushed = repo.push({ branch: 'q', head: result.head, lease: r.q });
	check('a push over someone else\'s push is refused', pushed.status === 'moved', JSON.stringify(pushed));
	check('…and their commit stays', git(r.server, ['rev-parse', 'q']) === theirs);
	repo.close();
	r.close();
}

// main changed the PR's lines: the replay conflicts, and says where
{
	const r = stackedRepos();
	git(r.work, ['switch', '--quiet', 'main']);
	git(r.work, ['reset', '--quiet', '--hard', r.squash]);
	const moved = commitFiles(r.work, 'Main: line 4', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'main' }) });
	git(r.work, ['push', '--quiet', 'origin', 'main']);
	const repo = open(r);
	repo.fetch([moved, r.p, r.q]);
	const result = repo.rebuild({ oldBase: r.p, oldHead: r.q, newBase: moved });
	check('a replay that conflicts is refused', result.status === 'conflict' && JSON.stringify(result.files) === '["a.txt"]', JSON.stringify(result));
	check('…naming the PR\'s commit that conflicts', result.commit === git(r.work, ['rev-parse', `${r.q}~1`]));
	repo.close();
	r.close();
}

// main already has one of the PR's lines: the replay is clean but would change less, so it's refused
{
	const r = stackedRepos();
	git(r.work, ['switch', '--quiet', 'main']);
	git(r.work, ['reset', '--quiet', '--hard', r.squash]);
	const moved = commitFiles(r.work, 'Main: line 9 too', { 'a.txt': lines(1, 10, { 3: 'p', 9: 'q' }) });
	git(r.work, ['push', '--quiet', 'origin', 'main']);
	const repo = open(r);
	repo.fetch([moved, r.p, r.q]);
	const result = repo.rebuild({ oldBase: r.p, oldHead: r.q, newBase: moved });
	check('a replay that changes the diff is refused', result.status === 'different', JSON.stringify(result));
	repo.close();
	r.close();
}

// the lines around the PR's moved (main added lines above them): still the same changes
{
	const r = stackedRepos();
	git(r.work, ['switch', '--quiet', 'main']);
	git(r.work, ['reset', '--quiet', '--hard', r.squash]);
	const moved = commitFiles(r.work, 'Main: a header', { 'a.txt': `h1\nh2\n${lines(1, 10, { 3: 'p' })}`, 'z.txt': 'z\n' });
	git(r.work, ['push', '--quiet', 'origin', 'main']);
	const repo = open(r);
	repo.fetch([moved, r.p, r.q]);
	const result = repo.rebuild({ oldBase: r.p, oldHead: r.q, newBase: moved });
	check('changes that only moved down the file are the same changes', result.status === 'rebuilt', JSON.stringify(result));
	repo.close();
	r.close();
}

// main changed the lines right around the PR's (not the PR's own): the PR's changes are the same
{
	const r = stackedRepos();
	git(r.work, ['switch', '--quiet', 'main']);
	git(r.work, ['reset', '--quiet', '--hard', r.squash]);
	const moved = commitFiles(r.work, 'Main: lines 6 and 7', { 'a.txt': lines(1, 10, { 3: 'p', 6: 'm', 7: 'm' }) });
	git(r.work, ['push', '--quiet', 'origin', 'main']);
	const repo = open(r);
	repo.fetch([moved, r.p, r.q]);
	const result = repo.rebuild({ oldBase: r.p, oldHead: r.q, newBase: moved });
	check('a base with new lines next to the PR\'s: the same changes', result.status === 'rebuilt', JSON.stringify(result));
	repo.close();
	r.close();
}

// sameChanges: whether a tested commit makes the same changes as a head, for a PR on a base
{
	const r = stackedRepos();
	const w = r.work;
	git(w, ['switch', '--quiet', 'main']);
	git(w, ['reset', '--quiet', '--hard', r.squash]);
	const later = commitFiles(w, 'Main: line 7', { 'a.txt': lines(1, 10, { 3: 'p', 7: 'm' }) });
	git(w, ['push', '--quiet', 'origin', 'main']);
	const repo = open(r);
	repo.fetch([later, r.squash, r.p, r.q]);
	// q, rebuilt on the squash of p (as the PR bot does), then rebased again onto a later main
	const onSquash = repo.rebuild({ oldBase: r.p, oldHead: r.q, newBase: r.squash }).head;
	const onLater = repo.rebuild({ oldBase: r.p, oldHead: r.q, newBase: later }).head;
	check('sameChanges: a stacked PR rebuilt on the squash of the one below', repo.sameChanges({ base: r.squash, tested: r.q, head: onSquash }));
	check('…and rebuilt again on a later main', repo.sameChanges({ base: later, tested: r.q, head: onLater }) && repo.sameChanges({ base: later, tested: onSquash, head: onLater }));
	check('…and still when main moved on after the rebuild', repo.sameChanges({ base: later, tested: r.q, head: onSquash }));
	// a PR that dropped one of its commits, or changed its line, isn't the same
	git(w, ['switch', '--quiet', '-c', 'dropped', r.squash]);
	const dropped = commitFiles(w, 'Q: line 9 only', { 'a.txt': lines(1, 10, { 3: 'p', 9: 'q' }), 'b.txt': 'new\n' });
	const changed = commitFiles(w, 'Q: line 4 again', { 'a.txt': lines(1, 10, { 3: 'p', 4: 'Q', 9: 'q' }) });
	git(w, ['push', '--quiet', 'origin', 'dropped']);
	repo.fetch([dropped, changed]);
	check('…not a head that dropped one of the tested commits', !repo.sameChanges({ base: r.squash, tested: r.q, head: dropped }));
	check('…nor one that changes a line differently', !repo.sameChanges({ base: r.squash, tested: r.q, head: changed }));
	repo.close();
	r.close();
}

// sameChanges on a plain PR: a change moved elsewhere, or a first commit dropped in a rebase, isn't the same
{
	const r = makeRepos({ 'a.txt': lines(1, 20) });
	const w = r.work;
	const base = git(w, ['rev-parse', 'HEAD']);
	git(w, ['switch', '--quiet', '-c', 'tested']);
	commitFiles(w, 'A', { 'b.txt': 'a\n' });
	const tested = commitFiles(w, 'B: x after line 2', { 'a.txt': lines(1, 20, { 2: '2\nx' }) });
	git(w, ['switch', '--quiet', 'main']);
	const main = commitFiles(w, 'Main: line 15', { 'a.txt': lines(1, 20, { 15: 'm' }) });
	git(w, ['switch', '--quiet', '-c', 'rebased']);
	commitFiles(w, 'A', { 'b.txt': 'a\n' });
	const rebased = commitFiles(w, 'B: x after line 2', { 'a.txt': lines(1, 20, { 2: '2\nx', 15: 'm' }) });
	git(w, ['switch', '--quiet', '-c', 'moved', main]);
	commitFiles(w, 'A', { 'b.txt': 'a\n' });
	const moved = commitFiles(w, 'B: x after line 8', { 'a.txt': lines(1, 20, { 8: '8\nx', 15: 'm' }) });
	git(w, ['switch', '--quiet', '-c', 'dropped', main]);
	const dropped = commitFiles(w, 'B: x after line 2', { 'a.txt': lines(1, 20, { 2: '2\nx', 15: 'm' }) });
	git(w, ['push', '--quiet', 'origin', 'main', 'tested', 'rebased', 'moved', 'dropped']);
	const repo = open(r);
	repo.fetch([main, tested, rebased, moved, dropped]);
	check('sameChanges: a clean rebase of a plain PR', repo.sameChanges({ base: main, tested, head: rebased }) && base !== main);
	check('…not the same line added elsewhere in the file', !repo.sameChanges({ base: main, tested, head: moved }));
	check('…nor a rebase that dropped the first commit', !repo.sameChanges({ base: main, tested, head: dropped }));
	repo.close();
	r.close();
}

// sameChanges on a stacked PR whose lower PR had a fixup (two commits on one line), squashed into one on main
{
	const r = makeRepos();
	const w = r.work;
	git(w, ['switch', '--quiet', '-c', 'lower']);
	commitFiles(w, 'L1', { 'a.txt': lines(1, 10, { 3: 'p' }) });
	const lower = commitFiles(w, 'L2: fixup', { 'a.txt': lines(1, 10, { 3: 'P' }) });
	git(w, ['switch', '--quiet', '-c', 'upper']);
	const upper = commitFiles(w, 'U', { 'a.txt': lines(1, 10, { 3: 'P', 4: 'u' }) });
	git(w, ['switch', '--quiet', 'main']);
	const squash = git(w, ['commit-tree', `${lower}^{tree}`, '-p', 'main', '-m', 'Squash of L']);
	git(w, ['push', '--quiet', 'origin', `${squash}:refs/heads/main`, 'lower', 'upper']);
	const repo = open(r);
	repo.fetch([squash, lower, upper]);
	const rebuilt = repo.rebuild({ oldBase: lower, oldHead: upper, newBase: squash });
	check('sameChanges: a stacked PR rebuilt after a lower PR with a fixup merged', rebuilt.status === 'rebuilt' && repo.sameChanges({ base: squash, tested: upper, head: rebuilt.head }), JSON.stringify(rebuilt));
	repo.close();
	r.close();
}

// sameChanges on a stack rebuilt by hand after main changed a line next to the lowest PR's: that PR's conflict is
// resolved, so its changes differ, and the middle PR's own commits are replayed onto it as they were (a cherry-pick).
// They're the same changes once it's known that the middle PR's base branch was at the lowest PR's old head (from the
// force-push in its timeline: `formerBases`), and so are the top PR's; not without that, nor for a middle PR whose
// own change differs, or that dropped one of its commits
{
	const r = makeRepos({ 'a.txt': lines(1, 10), 'rows.txt': 'one\n' });
	const w = r.work;
	git(w, ['switch', '--quiet', '-c', 'p']);
	const p = commitFiles(w, 'P', { 'rows.txt': 'one\np\n', 'a.txt': lines(1, 10, { 3: 'p' }) });
	git(w, ['switch', '--quiet', '-c', 'q']);
	commitFiles(w, 'Q: b.txt', { 'b.txt': 'q\n' });
	const q = commitFiles(w, 'Q: line 5', { 'a.txt': lines(1, 10, { 3: 'p', 5: 'q' }) });
	git(w, ['switch', '--quiet', '-c', 'r']);
	const top = commitFiles(w, 'R', { 'r.txt': 'r\n' });
	git(w, ['switch', '--quiet', 'main']);
	commitFiles(w, 'Main: a row', { 'rows.txt': 'one\nm\n' });
	// P rebuilt on main by hand, with its row after main's; Q's and R's own commits replayed onto it
	git(w, ['switch', '--quiet', '-c', 'p2']);
	const p2 = commitFiles(w, 'P', { 'rows.txt': 'one\nm\np\n', 'a.txt': lines(1, 10, { 3: 'p' }) });
	git(w, ['switch', '--quiet', '-c', 'q2']);
	commitFiles(w, 'Q: b.txt', { 'b.txt': 'q\n' });
	const q2 = commitFiles(w, 'Q: line 5', { 'a.txt': lines(1, 10, { 3: 'p', 5: 'q' }) });
	git(w, ['switch', '--quiet', '-c', 'r2']);
	const top2 = commitFiles(w, 'R', { 'r.txt': 'r\n' });
	// Q with its line 5 changed otherwise, and Q without its first commit
	git(w, ['switch', '--quiet', '-c', 'q-changed', p2]);
	commitFiles(w, 'Q: b.txt', { 'b.txt': 'q\n' });
	const changed = commitFiles(w, 'Q: line 5', { 'a.txt': lines(1, 10, { 3: 'p', 5: 'Q' }) });
	git(w, ['switch', '--quiet', '-c', 'q-dropped', p2]);
	const dropped = commitFiles(w, 'Q: line 5', { 'a.txt': lines(1, 10, { 3: 'p', 5: 'q' }) });
	git(w, ['push', '--quiet', 'origin', 'main', 'p', 'q', 'r', 'p2', 'q2', 'r2', 'q-changed', 'q-dropped']);
	const repo = open(r);
	repo.fetch([p, q, top, p2, q2, top2, changed, dropped]);
	check('sameChanges: a PR stacked on one rebuilt by hand with other changes, given the base it was tested on', repo.sameChanges({ base: p2, tested: q, head: q2, formerBases: [p, p2] }));
	check('…and the PR on top of it', repo.sameChanges({ base: q2, tested: top, head: top2, formerBases: [q, q2] }));
	check('…not without knowing that base', !repo.sameChanges({ base: p2, tested: q, head: q2 }) && !repo.sameChanges({ base: q2, tested: top, head: top2 }));
	check('…nor when its own change differs', !repo.sameChanges({ base: p2, tested: q, head: changed, formerBases: [p, p2] }));
	check('…nor when it dropped one of its commits', !repo.sameChanges({ base: p2, tested: q, head: dropped, formerBases: [p, p2] }));
	repo.close();
	r.close();
}

// in GitHub Actions the token's mask goes to stderr: a tool's stdout can be its answer (tools/same-changes.mjs)
{
	const run = spawnSync(process.execPath, ['--input-type=module', '-e',
		`import { openRepo } from ${JSON.stringify(new URL('../tools/restack.mjs', import.meta.url).href)}; openRepo({ url: 'https://github.com/o/r.git', token: 't0ken' }).close();`],
	{ env: { ...process.env, GITHUB_ACTIONS: 'true' }, encoding: 'utf8' });
	check('the token is masked on stderr, nothing on stdout', run.status === 0 && run.stdout === '' && /^::add-mask::\S+$/m.test(run.stderr), JSON.stringify(run));
}

// the branch below changed after this one was made: the PR isn't on its old base
{
	const r = stackedRepos();
	const repo = open(r);
	repo.fetch([r.squash, r.p, r.q]);
	check('a PR not built on its old base is refused', repo.rebuild({ oldBase: r.squash, oldHead: r.q, newBase: r.squash }).status === 'not-on-base');
	check('a PR with no commits of its own is refused', repo.rebuild({ oldBase: r.p, oldHead: r.p, newBase: r.squash }).status === 'empty');
	check('the paths a range changes', JSON.stringify(repo.changedFiles(r.p, r.q)) === '["a.txt","b.txt"]', JSON.stringify(repo.changedFiles(r.p, r.q)));
	repo.close();
	r.close();
}

// a merge commit in the PR (it merged its base in): its changes to the PR's branch replay too
{
	const r = stackedRepos();
	git(r.work, ['switch', '--quiet', 'p']);
	const p2 = commitFiles(r.work, 'P: line 1', { 'a.txt': lines(1, 10, { 1: 'p', 3: 'p' }) });
	git(r.work, ['switch', '--quiet', 'q']);
	git(r.work, ['merge', '--quiet', '--no-edit', 'p']);
	const q = git(r.work, ['rev-parse', 'HEAD']);
	const squash = git(r.work, ['commit-tree', `${p2}^{tree}`, '-p', r.base, '-m', 'Squash of P']);
	git(r.work, ['push', '--quiet', '--force', 'origin', `${squash}:refs/heads/main`, 'p', 'q']);
	const repo = open(r);
	repo.fetch([squash, p2, q]);
	const result = repo.rebuild({ oldBase: p2, oldHead: q, newBase: squash });
	check('a PR with a merge commit is rebuilt', result.status === 'rebuilt' && result.commits === 3, JSON.stringify(result));
	repo.close();
	r.close();
}

// Nothing runs: not the PR branch's .gitattributes, .gitmodules or hooks, and not the machine's git config either
// (filters, drivers, hooks), which the bot's runner could have. Each would leave a file behind if it ran.
{
	const r = stackedRepos();
	const marks = path.join(r.root, 'marks');
	fs.mkdirSync(marks);
	const touch = (name) => `sh -c 'touch ${marks}/${name}; cat'`;
	const hooks = path.join(r.root, 'hooks');
	fs.mkdirSync(hooks);
	for (const hook of ['pre-push', 'reference-transaction', 'post-checkout', 'post-rewrite', 'pre-commit', 'post-commit']) {
		fs.writeFileSync(path.join(hooks, hook), `#!/bin/sh\ntouch ${marks}/hook-${hook}\n`, { mode: 0o755 });
	}
	const home = path.join(r.root, 'home');
	fs.mkdirSync(home);
	const config = [
		'[core]', `\thooksPath = ${hooks}`, `\tfsmonitor = ${touch('fsmonitor')}`, `\tattributesFile = ${path.join(home, 'attributes')}`,
		'[filter "evil"]', `\tclean = ${touch('clean')}`, `\tsmudge = ${touch('smudge')}`, `\tprocess = ${touch('process')}`,
		'[merge "evil"]', `\tdriver = ${touch('merge')}`,
		'[diff "evil"]', `\ttextconv = ${touch('textconv')}`, `\tcommand = ${touch('diff')}`,
		'[diff]', `\texternal = ${touch('external')}`,
		'',
	].join('\n');
	fs.writeFileSync(path.join(home, '.gitconfig'), config);
	fs.writeFileSync(path.join(home, 'attributes'), '* filter=evil merge=evil diff=evil\n');
	git(r.work, ['switch', '--quiet', 'q']);
	commitFiles(r.work, 'Q: attributes', {
		'.gitattributes': '* filter=evil merge=evil diff=evil\n',
		'.gitmodules': `[submodule "lib"]\n\tpath = lib\n\turl = ${r.server}\n`,
		'a.txt': lines(1, 10, { 3: 'p', 4: 'q', 9: 'q', 10: 'q' }),
	});
	git(r.work, ['update-index', '--add', '--cacheinfo', `160000,${r.base},lib`]);
	git(r.work, ['commit', '--quiet', '-m', 'Q: a submodule']);
	const head = git(r.work, ['rev-parse', 'HEAD']);
	git(r.work, ['push', '--quiet', 'origin', 'q']);
	// the machine's config, as far as the process environment can point git at it
	const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS };
	Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_PARAMETERS: `'core.hooksPath'='${hooks}'` });
	let result, pushed;
	try {
		const repo = open(r);
		repo.fetch([r.squash, r.p, head]);
		result = repo.rebuild({ oldBase: r.p, oldHead: head, newBase: r.squash });
		pushed = result.head && repo.push({ branch: 'q', head: result.head, lease: head });
		repo.close();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
	check('a PR with attributes and a submodule is rebuilt as data', result.status === 'rebuilt' && pushed?.status === 'pushed', JSON.stringify({ result, pushed }));
	check('…running no hook, filter, driver or fsmonitor', fs.readdirSync(marks).length === 0, fs.readdirSync(marks).join(', '));
	check('…and keeping the submodule as a plain commit id', git(r.server, ['ls-tree', 'q', 'lib']).startsWith(`160000 commit ${r.base}`), git(r.server, ['ls-tree', 'q', 'lib']));
	check('…with the same tree as before', git(r.server, ['rev-parse', 'q^{tree}']) === git(r.server, ['rev-parse', `${head}^{tree}`]));
	r.close();
}

// only https:// and file:// remotes
{
	let threw = false;
	try { openRepo({ url: 'ext::sh -c touch% /tmp/x' }); } catch { threw = true; }
	check('other remotes are refused', threw);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
