// Rebuilds a pull request's branch on a new base, for the PR bot (tools/pr-bot.mjs): the PR's own commits are replayed
// one by one, and the result must make exactly the changes the PR made before. And compares what two commits change,
// for pr-policy (tools/same-changes.mjs).
//
// The bot holds a write token, and PR branches are untrusted, so git only ever treats them as data. Everything happens
// in a new, empty bare repository: the commits are fetched as objects, replayed with `git merge-tree` and recorded with
// `git commit-tree`, and nothing is ever checked out. So nothing from a PR branch can run:
//   - hooks: a new repository has none (no template is copied), core.hooksPath points nowhere, and pushes skip them;
//   - filters, textconv and merge or diff drivers: git takes those from its config, never from a repository's files,
//     and this ignores the system and global config; attributes (.gitattributes) are read from an empty tree, so a PR
//     can't even pick a built-in driver;
//   - submodules: never fetched, updated or pushed;
//   - and the objects are checked as they're fetched (transfer.fsckObjects).
//
//   const repo = openRepo({ url, token });   // url: https://github.com/<owner>/<repo>.git (file:// in tests)
//   repo.fetch([sha, ...]);
//   repo.changedFiles(base, head);            // paths a range touches
//   repo.sameTree(a, b, '.github');           // whether two commits have the same directory (or both have none)
//   repo.rebuild({ oldBase, oldHead, newBase });   // { status: 'rebuilt', head, commits } or why not (below)
//   repo.sameChanges({ base, tested, head, formerBases });  // whether two commits make the same changes to a PR's base
//   repo.has(sha); repo.isAncestor(a, b);
//   repo.push({ branch, head, lease });       // { status: 'pushed' | 'moved' | 'refused', message }
//   repo.close();
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };
const MIN_GIT = [2, 40];   // merge-tree --merge-base
const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_COMMITS = 250;   // more than any real PR: a person should look at a branch like that
// Set on every command. Most of these are already git's defaults; they're here so that no environment can change them.
const HARDENED = {
	'core.hooksPath': '/dev/null',
	'core.attributesFile': '/dev/null',
	'attr.tree': EMPTY_TREE,
	'core.fsmonitor': 'false',
	'fetch.recurseSubmodules': 'false',
	'submodule.recurse': 'false',
	'push.recurseSubmodules': 'no',
	'transfer.fsckObjects': 'true',
	'gc.auto': '0',
	'maintenance.auto': 'false',
	'commit.gpgSign': 'false',
	'protocol.allow': 'never',
};

/** A new, empty bare repository that talks to `url` only, with `token` (if any) as GitHub's Actions token. */
export function openRepo({ url, token = '' }) {
	const scheme = /^(https|file):\/\//.exec(url)?.[1];
	if (!scheme) throw new Error(`restack: only https:// and file:// remotes (${url})`);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-bot-restack-'));
	try {
		const run = gitRunner(dir, { ...HARDENED, [`protocol.${scheme}.allow`]: 'always', ...authHeader(url, token) });
		checkVersion(run);
		fs.mkdirSync(path.join(dir, 'template'));
		run(['init', '--quiet', '--bare', `--template=${path.join(dir, 'template')}`, path.join(dir, 'repo.git')], { bare: false });
		return repoApi(run, url, dir);
	} catch (e) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw e;
	}
}

function repoApi(run, url, dir) {
	return {
		fetch: (shas) => run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', url, ...shas]),
		changedFiles: (base, head) => run(['diff', '--name-only', '-z', '--no-renames', base, head]).stdout.split('\0').filter(Boolean),
		sameTree: (a, b, dir) => treeOf(run, a, dir) === treeOf(run, b, dir),
		has: (sha) => run(['cat-file', '-e', `${sha}^{commit}`], { ok: [0, 1, 128] }).status === 0,
		isAncestor: (a, b) => run(['merge-base', '--is-ancestor', a, b], { ok: [0, 1] }).status === 0,
		rebuild: (range) => rebuild(run, range),
		sameChanges: (commits) => sameChanges(run, commits),
		push: (update) => push(run, url, update),
		close: () => fs.rmSync(dir, { recursive: true, force: true }),
	};
}

/**
 * Replay the commits `oldBase..oldHead` (following first parents, so a merge commit replays the changes it made to its
 * branch) onto `newBase`. Returns { status: 'rebuilt', head, commits }, or why it couldn't:
 *   'not-on-base'  oldHead isn't built on oldBase (the branch below changed after this one was made)
 *   'empty'        no commits of its own
 *   'too-many'     more than MAX_COMMITS of its own
 *   'conflict'     replaying `commit` conflicts in `files`
 *   'different'    replayed cleanly, but the changes to the base aren't the same ones (or, on a base with the same
 *                  tree as the old one, the result hasn't the same tree)
 */
function rebuild(run, { oldBase, oldHead, newBase }) {
	if (run(['merge-base', '--is-ancestor', oldBase, oldHead], { ok: [0, 1] }).status !== 0) return { status: 'not-on-base' };
	const commits = run(['rev-list', '--reverse', '--first-parent', `${oldBase}..${oldHead}`]).stdout.split('\n').filter(Boolean);
	const replayed = replayAll(run, commits, newBase);
	if (replayed.status !== 'replayed') return replayed;
	const tip = replayed.head;
	if (changesOf(run, oldBase, oldHead) !== changesOf(run, newBase, tip)) return { status: 'different' };
	// the usual case, right after the merge: the squash commit has the merged head's tree, and then so must this
	if (treeOf(run, oldBase, '') === treeOf(run, newBase, '') && treeOf(run, oldHead, '') !== treeOf(run, tip, '')) return { status: 'different' };
	return { status: 'rebuilt', head: tip, commits: replayed.commits };
}

/** `commits` replayed one by one onto `newBase`: { status: 'replayed', head, commits }, or 'empty', 'too-many' or 'conflict' as for rebuild. */
function replayAll(run, commits, newBase) {
	if (!commits.length) return { status: 'empty' };
	if (commits.length > MAX_COMMITS) return { status: 'too-many', commits: commits.length };
	let tip = newBase;
	for (const commit of commits) {
		const step = replay(run, commit, tip);
		if (step.conflicts) return { status: 'conflict', commit, files: step.conflicts };
		tip = step.commit;
	}
	return { status: 'replayed', head: tip, commits: commits.length };
}

/** `commit`'s changes to its first parent, merged onto `tip` as a new commit with the same author and message. */
function replay(run, commit, tip) {
	const parent = run(['rev-parse', '--verify', `${commit}^1`]).stdout.trim();
	const merged = run(['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', `--merge-base=${parent}`, tip, commit], { ok: [0, 1] });
	const [tree, ...files] = merged.stdout.split('\0').filter(Boolean);
	if (merged.status === 1) return { conflicts: [...new Set(files)] };
	return { commit: recommit(run, commit, tree, tip) };
}

/** A copy of `commit` with `tree` on `parent`: the original author, date and message; the bot as committer. */
function recommit(run, commit, tree, parent) {
	const raw = run(['cat-file', 'commit', commit], { buffer: true }).stdout;
	const end = raw.indexOf('\n\n');
	const headers = raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
	const message = end < 0 ? Buffer.alloc(0) : raw.subarray(end + 2);
	const author = parseIdent(/^author (.*)$/m.exec(headers)?.[1] || '');
	const encoding = /^encoding (.*)$/m.exec(headers)?.[1];
	const env = {
		GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_AUTHOR_DATE: author.date,
		GIT_COMMITTER_NAME: BOT.name, GIT_COMMITTER_EMAIL: BOT.email,
	};
	const options = encoding ? ['-c', `i18n.commitEncoding=${encoding}`] : [];
	return run([...options, 'commit-tree', tree, '-p', parent, '-F', '-'], { input: message, env }).stdout.trim();
}

/** "Name <email> 1700000000 +0100" (a commit's author line) -> { name, email, date } */
function parseIdent(line) {
	const m = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/.exec(line);
	if (!m) throw new Error('restack: a commit has no readable author');
	return { name: m[1], email: m[2], date: `@${m[3]} ${m[4]}` };
}

/**
 * Whether `tested` makes the same changes as `head`, for a PR based on `base` (pr-policy's check of a "Tested at"
 * that isn't the PR's head: tools/same-changes.mjs). The head must be exactly, tree for tree, the tested commit's
 * changes on the base the head is built on (its merge base with `base`), either:
 *   - merged onto it in one go, from the tested commit's own merge base with `base`: a PR rebased or updated ("Update
 *     branch") onto a newer base; or
 *   - its last commits, as many as the head has of its own, replayed onto it one by one as tools/restack.mjs rebuilds
 *     a PR, when what's below them was the PR's base: commits that change nothing there (a stacked PR rebuilt after
 *     the PR below it merged or was rebuilt, whose tested commit still carries that PR's old commits, squashed or
 *     rebuilt on the base since), or a commit the base branch was at before a force-push (`formerBases`, from the
 *     PR's timeline: the PR below rebuilt with other changes, e.g. a conflict resolved by hand).
 * Where each change is counts, not only the lines: a change moved elsewhere is a different change. Which commits are
 * the PR's own counts too: one dropped is a different change, so `below` must be the base it was tested on.
 */
function sameChanges(run, { base, tested, head, formerBases = [] }) {
	const headBase = mergeBase(run, base, head), testedBase = mergeBase(run, base, tested);
	if (!headBase || !testedBase) return false;
	const headTree = treeOf(run, head, '');
	const merged = run(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${testedBase}`, headBase, tested], { ok: [0, 1] });
	if (merged.status === 0 && merged.stdout.trim() === headTree) return true;
	const own = Number(run(['rev-list', '--first-parent', '--count', `${headBase}..${head}`]).stdout.trim());
	if (!own || own > MAX_COMMITS) return false;
	const below = run(['rev-parse', '--verify', '--quiet', `${tested}~${own}`], { ok: [0, 1] }).stdout.trim();
	if (!below || !(formerBases.includes(below) || changesNothing(run, below, headBase))) return false;
	const commits = run(['rev-list', '--reverse', '--first-parent', `${below}..${tested}`]).stdout.split('\n').filter(Boolean);
	const replayed = replayAll(run, commits, headBase);
	return replayed.status === 'replayed' && treeOf(run, replayed.head, '') === headTree;
}

/** Whether `commit` changes nothing on `onto`: it's in it, or what it changes since they parted is there already. */
function changesNothing(run, commit, onto) {
	if (run(['merge-base', '--is-ancestor', commit, onto], { ok: [0, 1] }).status === 0) return true;
	const from = mergeBase(run, onto, commit);
	if (!from) return false;
	const merged = run(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${from}`, onto, commit], { ok: [0, 1] });
	return merged.status === 0 && merged.stdout.trim() === treeOf(run, onto, '');
}

function mergeBase(run, a, b) {
	const out = run(['merge-base', a, b], { ok: [0, 1] });
	return out.status === 0 ? out.stdout.trim() : null;
}

/**
 * What a range changes, as one comparable string, to check a replay: each file's diff header (its name and mode), then
 * the lines it adds and removes, in order. Not the context lines, the hunks' line numbers or the blob ids, which move
 * with the base while the changes stay the same: a base that changed the lines next to a PR's leaves its changes as
 * they were. Only for a replay, which puts each change where git's merge does: this alone can't tell a change that
 * moved within a file.
 */
function changesOf(run, base, head) {
	const patch = run(['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--submodule=short',
		'--src-prefix=a/', '--dst-prefix=b/', '--unified=0', base, head]).stdout;
	return changedLines(patch);
}

/**
 * A patch, as what it changes: its `diff --git` and mode lines, binary data, and the lines it adds and removes (with
 * "\ No newline at end of file"). Not the blob ids, the ---/+++ names (`diff --git` has them), hunk headers or context.
 */
export function changedLines(patch) {
	const kept = [];
	let inHunk = false;
	for (const line of patch.split('\n')) {
		if (line.startsWith('diff --git ')) inHunk = false;
		else if (line.startsWith('@@')) { inHunk = true; continue; }
		if (inHunk ? /^[-+\\]/.test(line) : !/^(index |--- |\+\+\+ )/.test(line)) kept.push(line);
	}
	return kept.join('\n');
}

function treeOf(run, rev, dir) {
	return run(['rev-parse', '--verify', '--quiet', `${rev}:${dir}`], { ok: [0, 1, 128] }).stdout.trim();
}

/** Move `branch` to `head`, but only if it's still at `lease`: never over a push someone made meanwhile. */
function push(run, url, { branch, head, lease }) {
	run(['check-ref-format', `refs/heads/${branch}`], { bare: false });
	const out = run(['push', '--porcelain', '--no-verify', '--recurse-submodules=no', `--force-with-lease=refs/heads/${branch}:${lease}`,
		url, `${head}:refs/heads/${branch}`], { ok: [0, 1] });
	if (out.status === 0) return { status: 'pushed' };
	const text = `${out.stdout}\n${out.stderr}`;
	if (/stale info/.test(text)) return { status: 'moved' };
	return { status: 'refused', message: (/\[rejected\][^\n]*|\[remote rejected\][^\n]*/.exec(text)?.[0] || 'push refused').trim() };
}

/**
 * Runs git in the bare repository with `config` set through the environment (so it's in no file and on no command
 * line), a home of its own, and no system or global config, prompts or pagers.
 */
function gitRunner(dir, config) {
	const keys = Object.entries(config);
	const base = {
		PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
		GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat',
		GIT_CONFIG_COUNT: String(keys.length),
		...Object.fromEntries(keys.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
	};
	const gitDir = path.join(dir, 'repo.git');
	return (args, { ok = [0], input, env = {}, buffer = false, bare = true } = {}) => {
		const out = spawnSync('git', bare ? ['--git-dir', gitDir, ...args] : args, {
			cwd: dir, env: { ...base, ...env }, input, timeout: TIMEOUT_MS, maxBuffer: 512 * 1024 * 1024, encoding: buffer ? 'buffer' : 'utf8',
		});
		if (out.error) throw out.error;
		if (!ok.includes(out.status)) throw new Error(`git ${args.find((a) => !a.startsWith('-'))} exited ${out.status}: ${String(out.stderr).replace(/\s+/g, ' ').trim().slice(0, 300)}`);
		return out;
	};
}

/** GitHub's Actions token as actions/checkout sends it, for `url`'s host only. */
function authHeader(url, token) {
	if (!token || !url.startsWith('https://')) return {};
	const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
	// on stderr: a tool's stdout may be its answer (tools/same-changes.mjs), and the runner reads commands on both
	if (process.env.GITHUB_ACTIONS) process.stderr.write(`::add-mask::${basic}\n`);
	return { [`http.${new URL(url).origin}/.extraheader`]: `AUTHORIZATION: basic ${basic}` };
}

function checkVersion(run) {
	const [major, minor] = (/(\d+)\.(\d+)/.exec(run(['version'], { bare: false }).stdout) || []).slice(1).map(Number);
	if (!(major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]))) throw new Error(`restack: needs git ${MIN_GIT.join('.')} or later`);
}
