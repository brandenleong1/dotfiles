// Tiny git repositories for the PR bot's tests (test/restack.mjs, test/pr-bot.mjs): a working repository to make
// commits in, and a bare "server" it pushes to, which stands in for GitHub. Git runs without the system or global
// config, so the tests don't depend on (or touch) the machine's settings.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV = {
	PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
	GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
	GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: 'alice@example.com', GIT_AUTHOR_DATE: '@1700000000 +0100',
	GIT_COMMITTER_NAME: 'Alice', GIT_COMMITTER_EMAIL: 'alice@example.com', GIT_COMMITTER_DATE: '@1700000000 +0100',
};

/** git in `cwd`; its stdout, trimmed. Throws on failure unless `ok` lists the exit code. */
export function git(cwd, args, { ok = [0], input } = {}) {
	const out = spawnSync('git', args, { cwd, env: ENV, input, encoding: 'utf8' });
	if (!ok.includes(out.status)) throw new Error(`git ${args.join(' ')} (in ${cwd}) exited ${out.status}: ${out.stderr}`);
	return out.stdout.trim();
}

/** git's exit code in `cwd`. */
export function gitStatus(cwd, args) {
	return spawnSync('git', args, { cwd, env: ENV }).status;
}

/**
 * A scratch directory with `work` (a repository on `main`, one commit) and `server` (a bare copy it pushes to), at
 * `o/r.git`: GITHUB_SERVER_URL=file://<root> and GITHUB_REPOSITORY=o/r point the PR bot at it.
 */
export function makeRepos(files = { 'a.txt': lines(1, 10) }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-automation-git-'));
	const work = path.join(root, 'work');
	git(root, ['init', '--quiet', '-b', 'main', work]);
	writeFiles(work, files);
	commitAll(work, 'Base');
	const server = path.join(root, 'o', 'r.git');
	git(root, ['init', '--quiet', '--bare', server]);
	git(work, ['remote', 'add', 'origin', server]);
	git(work, ['push', '--quiet', 'origin', 'main']);
	return { root, work, server, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Write `files` ({ path: content }, null to delete) and commit them on the current branch; the new commit's SHA. */
export function commitFiles(work, message, files, { author } = {}) {
	writeFiles(work, files);
	return commitAll(work, message, author);
}

function commitAll(work, message, author) {
	git(work, ['add', '-A']);
	git(work, ['commit', '--quiet', '--allow-empty', '-m', message, ...(author ? [`--author=${author}`] : [])]);
	return git(work, ['rev-parse', 'HEAD']);
}

function writeFiles(work, files) {
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(work, name);
		if (content === null) {
			fs.rmSync(file, { force: true });
			continue;
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}
}

/** "1\n2\n...\n10\n", with `changes` ({ lineNumber: text }) applied. */
export function lines(from, to, changes = {}) {
	let out = '';
	for (let i = from; i <= to; i++) out += `${changes[i] ?? i}\n`;
	return out;
}

/** What `base..head` changes, the way the bot compares it: the patch without blob ids and hunk line numbers. */
export function changes(repo, base, head) {
	return git(repo, ['diff', '--no-renames', base, head]).split('\n').filter((l) => !l.startsWith('index ')).map((l) => (l.startsWith('@@') ? '@@' : l)).join('\n');
}
