// Local branch previews: serves every branch of a remote at once, each under its own path, read straight from git,
// with nothing checked out. The private alternative to the Pages module's public previews (README.md, "Local branch
// previews"). Settings are `localPreviews` in .github/pr-automation.json; the flags override them.
//
//   node tools/serve-branches.mjs                       http://127.0.0.1:8000/ lists the branches
//   node tools/serve-branches.mjs --port 8080 --fetch 60 --remote origin
//   node tools/serve-branches.mjs --host 192.168.1.20   also reachable from your LAN (a phone, a tablet): read the warning
//
// The branch `alice/menu-focus` is at /alice/menu-focus/. Its files are the branch's tip as the last fetch saw it;
// a path under one of localPreviews.submodules comes from the submodule commit that tip pins (fetched into the
// submodule's clone when it's missing). With localPreviews.marker set, every HTML page gets
// `<meta name="<marker>" content="<branch>">`, so the app can tell a preview, and which branch, from the real site.
// `--fetch <seconds>` fetches the remote that often (0: never; run `git fetch` yourself).
//
// What it serves, and to whom:
//   - it listens on 127.0.0.1 unless you pass --host, and only on a loopback or private (LAN) address even then: it
//     refuses public addresses, and refuses 0.0.0.0 or :: while this machine has a public or VPN-range address;
//   - a request's path is only ever a key into a branch's file list (`git ls-tree` of the tip the branch list holds,
//     which comes from `git for-each-ref`): no path from the URL reaches git, no `..` or ref expression is followed,
//     symbolic links aren't served, and the working tree is never read;
//   - there is no authentication: anyone who can reach the port can read every branch.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig, ROOT } from './pr-config.mjs';

const run = promisify(execFile);
const TYPES = {
	'.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif',
	'.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
	'.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml', '.wasm': 'application/wasm',
	'.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};
const TEXT = 'text/plain; charset=utf-8';
const REMOTE_NAME = /^[A-Za-z0-9][\w.-]{0,63}$/;
const MAX_TREES = 200;   // branch tips whose file lists are kept in memory

/**
 * A preview server for the repository at `repoDir` (not listening yet): { server, branches, refresh, close }.
 * `settings` is the config's localPreviews section, with `remote` and `fetchSeconds` as the flags left them.
 */
export function createPreviewServer({ repoDir, settings }) {
	if (!REMOTE_NAME.test(settings.remote)) throw new Error(`not a remote name: ${settings.remote}`);
	const repo = new GitObjects(repoDir);
	const modules = new Map(settings.submodules.map((p) => [p, new GitObjects(path.join(repoDir, p))]));
	const branches = new BranchList({ repoDir, repo, settings });
	const types = { ...TYPES, ...settings.types };
	const server = http.createServer((req, res) => {
		handle(req, res, { repo, modules, branches, settings, types }).catch((error) => fail(res, error));
	});
	let timer = null;
	return {
		server,
		branches,
		refresh: () => branches.refresh(),
		/** Fetch every `seconds` (0: never), and refresh the list after each fetch. */
		startFetching(seconds) {
			if (!seconds) return;
			const once = () => branches.fetch().catch((error) => console.error(`git fetch failed: ${error.message}`));
			let busy = null;
			timer = setInterval(() => { busy ||= once().finally(() => { busy = null; }); }, seconds * 1000);
			busy = once().finally(() => { busy = null; });
		},
		close() {
			if (timer) clearInterval(timer);
			repo.stop();
			for (const m of modules.values()) m.stop();
			return new Promise((resolve) => server.close(() => resolve()));
		},
	};
}

// ---- requests ---------------------------------------------------------------------------------------------------

async function handle(req, res, context) {
	if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, TEXT, 'Only GET and HEAD.', { allow: 'GET, HEAD' });
	const url = new URL(req.url, 'http://preview.invalid');
	let pathname;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		return send(req, res, 400, TEXT, 'Bad request path.');
	}
	const { branches } = context;
	if (pathname === '/') return send(req, res, 200, TYPES['.html'], indexPage(branches));
	const match = branches.find(pathname);
	if (!match) return send(req, res, 404, TEXT, 'No branch at that path. See / for the list.');
	if (!isSafePath(match.rest)) return send(req, res, 400, TEXT, 'Bad file path.');
	if (!match.rest && !pathname.endsWith('/')) return redirect(res, `${url.pathname}/${url.search}`);
	// an entry file in a subdirectory: send the browser there, so the page's relative links resolve
	if (!match.rest && context.settings.entry !== 'index.html') return redirect(res, `${url.pathname}${context.settings.entry.split('/').map(encodeURIComponent).join('/')}`);
	const file = await branchFile(match.branch, match.rest, context);
	if (file === 'directory') return redirect(res, `${url.pathname}/${url.search}`);
	if (!file) return send(req, res, 404, TEXT, `Not on ${match.branch.name}.`);
	serveFile(req, res, { branch: match.branch, name: file.name, blob: file.blob, context });
}

/**
 * The blob a request names in a branch: { name, blob } (`name` with `index.html` added for a directory), 'directory'
 * for a directory asked for without its slash, or null. The path is only looked up in the tip's file list (and a
 * submodule's, at the commit the tip pins), never handed to git.
 */
async function branchFile(branch, rest, { repo, modules }) {
	const name = rest === '' || rest.endsWith('/') ? `${rest}index.html` : rest;
	const tree = await repo.tree(branch.sha);
	const module = [...modules.keys()].find((p) => name.startsWith(`${p}/`));
	if (module) {
		const pinned = tree.files.get(module);
		if (pinned?.mode !== '160000') return null;
		const objects = modules.get(module);
		if (!(await objects.isOwnRepository())) {
			console.error(`${module} isn't a cloned submodule here: run \`git submodule update --init -- ${module}\``);
			return null;
		}
		if (!(await objects.hasCommit(pinned.sha))) await objects.fetchMissing(pinned.sha);
		const inner = await objects.tree(pinned.sha);
		return lookUp(inner, name.slice(module.length + 1), name, objects);
	}
	return lookUp(tree, name, name, repo);
}

async function lookUp(tree, inside, name, objects) {
	if (tree.dirs.has(inside)) return 'directory';
	const entry = tree.files.get(inside);
	// regular files only: not symbolic links (their target is a path outside the tree's control), nor submodules
	if (!entry || (entry.mode !== '100644' && entry.mode !== '100755')) return null;
	const blob = await objects.read(entry.sha);
	return blob?.type === 'blob' ? { name, blob } : null;
}

/**
 * Whether a file path from a URL is one this server would look up at all: no empty, `.` or `..` segments, no control
 * characters or backslashes. (Lookups only ever match a tree's own paths; this is a second line.)
 */
export function isSafePath(rest) {
	if (rest === '') return true;
	if (/[\0-\x1f\x7f\\]/.test(rest)) return false;
	const parts = rest.replace(/\/$/, '').split('/');
	return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function serveFile(req, res, { branch, name, blob, context }) {
	const ext = path.extname(name).toLowerCase();
	const type = context.types[ext] || 'application/octet-stream';
	const isPage = ext === '.html' || ext === '.htm';
	const marks = isPage && (context.settings.marker || context.settings.titlePrefix);
	const etag = `"${blob.sha}${marks ? `-${Buffer.from(branch.name).toString('hex')}` : ''}"`;
	const headers = { 'content-type': type, 'cache-control': 'no-cache', etag, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
	if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
	const body = marks ? markPage(blob.data.toString('utf8'), branch.name, context.settings) : blob.data;
	res.writeHead(200, headers).end(req.method === 'HEAD' ? undefined : body);
}

/** The preview marker after <head>, and the branch in the title, as the settings ask. */
export function markPage(html, branchName, { marker, titlePrefix }) {
	let out = html;
	if (marker) out = out.replace(/<head\b[^>]*>/i, (head) => `${head}\n<meta name="${marker}" content="${escapeHtml(branchName)}">`);
	if (titlePrefix) out = out.replace(/<title\b[^>]*>/i, (title) => `${title}[${escapeHtml(branchName)}] `);
	return out;
}

function send(req, res, status, type, body, extra = {}) {
	res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...extra });
	res.end(req.method === 'HEAD' ? undefined : body);
}

function redirect(res, location) {
	res.writeHead(302, { location }).end();
}

function fail(res, error) {
	console.error(error);
	if (!res.headersSent) res.writeHead(500, { 'content-type': TEXT }).end('The preview server failed on this request; its log says why.');
}

// ---- branches -----------------------------------------------------------------------------------------------------

class BranchList {
	constructor({ repoDir, repo, settings }) {
		this.repoDir = repoDir;
		this.repo = repo;
		this.remote = settings.remote;
		this.entry = settings.entry;
		this.list = [];
		this.fetchedAt = null;
	}

	/** Every branch on the remote whose tip has the entry file, newest first, from `git for-each-ref`. */
	async refresh() {
		const format = '%(refname:lstrip=3)%00%(objectname)%00%(committerdate:iso-strict)%00%(subject)';
		const { stdout } = await run('git', ['for-each-ref', `--format=${format}`, `refs/remotes/${this.remote}/`], { cwd: this.repoDir, maxBuffer: 1 << 24 });
		const all = stdout.split('\n').filter(Boolean).map((line) => {
			const [name, sha, date, subject] = line.split('\0');
			return { name, sha, date, subject };
		}).filter((b) => b.name && b.name !== 'HEAD' && /^[0-9a-f]{40,64}$/.test(b.sha));
		const hasEntry = await Promise.all(all.map(async (b) => (await this.repo.tree(b.sha)).files.has(this.entry)));
		this.list = all.filter((_, i) => hasEntry[i]).sort((a, b) => b.date.localeCompare(a.date));
		return this.list;
	}

	async fetch() {
		await run('git', ['fetch', '--prune', '--quiet', '--', this.remote], { cwd: this.repoDir });
		await this.refresh();
		this.fetchedAt = new Date();
	}

	/** The branch `pathname` is in, and the file path inside it. Longest name first, so `a/b` wins over `a`. */
	find(pathname) {
		const byLength = [...this.list].sort((a, b) => b.name.length - a.name.length);
		for (const branch of byLength) {
			const base = `/${branch.name}`;
			if (pathname === base) return { branch, rest: '' };
			if (pathname.startsWith(`${base}/`)) return { branch, rest: pathname.slice(base.length + 1) };
		}
		return null;
	}
}

// ---- git objects ------------------------------------------------------------------------------------------------

/**
 * One repository's objects: file lists of commits (`git ls-tree`, cached per commit), and blobs by SHA through one
 * long-running `git cat-file --batch`, which is much faster than a process per file when a page loads many.
 */
class GitObjects {
	constructor(cwd) {
		this.cwd = cwd;
		this.process = null;
		this.waiting = [];
		this.buffer = Buffer.alloc(0);
		this.trees = new Map();
	}

	/** { files: Map(path -> { mode, sha }), dirs: Set(path) } of a commit's whole tree. */
	tree(commit) {
		if (!this.trees.has(commit)) {
			if (this.trees.size >= MAX_TREES) this.trees.clear();
			this.trees.set(commit, this.listTree(commit).catch((error) => {
				this.trees.delete(commit);
				throw error;
			}));
		}
		return this.trees.get(commit);
	}

	async listTree(commit) {
		const { stdout } = await run('git', ['ls-tree', '-r', '-z', '--full-tree', commit], { cwd: this.cwd, maxBuffer: 1 << 28, encoding: 'buffer' });
		const files = new Map(), dirs = new Set();
		for (const entry of stdout.toString('utf8').split('\0').filter(Boolean)) {
			const tab = entry.indexOf('\t');
			const [mode, , sha] = entry.slice(0, tab).split(' ');
			const name = entry.slice(tab + 1);
			files.set(name, { mode, sha });
			const parts = name.split('/');
			for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
		}
		return { files, dirs };
	}

	/**
	 * Whether the directory is a repository of its own (a cloned submodule), not a plain directory inside the
	 * superproject, where git would find the superproject's objects instead.
	 */
	isOwnRepository() {
		this.own ||= run('git', ['rev-parse', '--show-toplevel'], { cwd: this.cwd })
			.then(({ stdout }) => fs.realpathSync(stdout.trim()) === fs.realpathSync(this.cwd), () => false);
		return this.own;
	}

	async hasCommit(sha) {
		return (await this.read(`${sha}^{commit}`))?.type === 'commit';
	}

	/** Fetch the submodule's own remote once, for a pinned commit its clone doesn't have yet. */
	async fetchMissing(sha) {
		this.fetching ||= (async () => {
			console.log(`Fetching ${path.basename(this.cwd)} for commit ${sha.slice(0, 7)}…`);
			await run('git', ['fetch', '--quiet', 'origin'], { cwd: this.cwd });
		})().finally(() => { this.fetching = null; });
		await this.fetching;
	}

	/** { sha, type, data } for an object name built by this file (a SHA, or `<sha>^{commit}`), or null. */
	read(name) {
		if (!/^[0-9a-f]{40,64}(\^\{commit\})?$/.test(name)) return Promise.resolve(null);
		this.start();
		return new Promise((resolve, reject) => {
			this.waiting.push({ resolve, reject });
			this.process.stdin.write(`${name}\n`);
		});
	}

	start() {
		if (this.process) return;
		this.process = spawn('git', ['cat-file', '--batch'], { cwd: this.cwd, stdio: ['pipe', 'pipe', 'ignore'] });
		this.process.stdout.on('data', (chunk) => this.receive(chunk));
		this.process.on('exit', (code) => this.stopped(new Error(`git cat-file in ${this.cwd} exited (${code})`)));
		this.process.on('error', (error) => this.stopped(error));
	}

	receive(chunk) {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (let object = this.takeObject(); object !== undefined; object = this.takeObject()) this.waiting.shift()?.resolve(object);
	}

	/** The next whole answer in the buffer (an object, or null for "missing"), or undefined until it has all arrived. */
	takeObject() {
		const end = this.buffer.indexOf(10);
		if (end < 0) return undefined;
		const header = this.buffer.subarray(0, end).toString('utf8');
		if (/ (missing|ambiguous)$/.test(header)) {
			this.buffer = this.buffer.subarray(end + 1);
			return null;
		}
		const [sha, type, size] = header.split(' ');
		const length = Number(size);
		if (this.buffer.length < end + 1 + length + 1) return undefined;
		const data = Buffer.from(this.buffer.subarray(end + 1, end + 1 + length));
		this.buffer = this.buffer.subarray(end + 1 + length + 1);
		return { sha, type, data };
	}

	stopped(error) {
		this.process = null;
		this.buffer = Buffer.alloc(0);
		for (const { reject } of this.waiting.splice(0)) reject(error);
	}

	stop() {
		const process = this.process;
		this.process = null;
		if (process) {
			process.removeAllListeners('exit');
			process.stdin.end();
			process.kill();
		}
	}
}

// ---- the index page ---------------------------------------------------------------------------------------------

function indexPage(branches) {
	const rows = branches.list.map((b) => `
			<tr>
				<td><a href="/${b.name.split('/').map(encodeURIComponent).join('/')}/">${escapeHtml(b.name)}</a></td>
				<td><code>${b.sha.slice(0, 7)}</code></td>
				<td>${escapeHtml(b.date.slice(0, 16).replace('T', ' '))}</td>
				<td>${escapeHtml(b.subject)}</td>
			</tr>`).join('');
	const fetched = branches.fetchedAt ? `last fetched ${branches.fetchedAt.toLocaleTimeString()}` : 'not fetched since it started';
	return `<!DOCTYPE html>
<html>
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Branch previews</title>
		<style>
			:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
			body { margin: 0 auto; padding: 16px; max-width: 1100px; }
			table { border-collapse: collapse; width: 100%; }
			td, th { padding: 6px 8px; text-align: left; border-bottom: 1px solid #8884; vertical-align: top; }
			td:first-child { white-space: nowrap; }
			p { opacity: 0.7; }
			@media (max-width: 640px) { td:nth-child(2), td:nth-child(4), th:nth-child(2), th:nth-child(4) { display: none; } }
		</style>
	</head>
	<body>
		<h1>Branch previews</h1>
		<p>${branches.list.length} branches on ${escapeHtml(branches.remote)}, ${fetched}.</p>
		<table>
			<tr><th>Branch</th><th>Commit</th><th>Date</th><th>Last commit</th></tr>${rows}
		</table>
	</body>
</html>`;
}

function escapeHtml(text) {
	return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---- where it listens -----------------------------------------------------------------------------------------------

/**
 * Whether the server may listen on `host`: { ok, lan, why }. Loopback always; a private (LAN) or link-local address
 * when asked for; 0.0.0.0 or :: only while every address this machine has (`interfaces`, as os.networkInterfaces()
 * gives them) is loopback, private or link-local. Public addresses, VPN-range ones (100.64.0.0/10) and host names
 * other than localhost are refused.
 */
export function checkHost(host, interfaces = os.networkInterfaces()) {
	if (isLoopback(host)) return { ok: true, lan: false };
	if (host === '0.0.0.0' || host === '::') {
		// 0.0.0.0 listens on every IPv4 address; :: on every address
		const v4 = (a) => a.family === 'IPv4' || a.family === 4;
		const exposed = Object.values(interfaces).flat().filter((a) => a && !a.internal && (host === '::' || v4(a)) && !isPrivate(a.address) && !isLoopback(a.address));
		if (exposed.length) return { ok: false, why: `this machine also has ${exposed.map((a) => a.address).join(', ')}, which isn't a private network address: pass the LAN address to listen on instead` };
		return { ok: true, lan: true };
	}
	if (isPrivate(host)) return { ok: true, lan: true };
	return { ok: false, why: `${host} isn't a loopback or private network address: the previews are for this machine, or your own LAN at most` };
}

function isLoopback(host) {
	return host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isPrivate(address) {
	const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address);
	if (v4) {
		const [a, b] = [Number(v4[1]), Number(v4[2])];
		return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
	}
	return /^f[cd][0-9a-f]{2}:/i.test(address) || /^fe[89ab][0-9a-f]:/i.test(address);   // unique local, link-local
}

const LAN_WARNING = [
	'Listening on your local network: anyone on it can open every branch, with no password or login.',
	'Never forward this port on your router, and never tunnel or proxy it to the internet.',
	'On Windows, if asked whether Node may accept connections, allow it on private networks only.',
];

// ---- the command line -----------------------------------------------------------------------------------------------

/** The flags over the config's localPreviews: { port, host, remote, fetchSeconds, repoDir }. */
export function parseArgs(args, settings) {
	const options = { port: settings.port, host: '127.0.0.1', remote: settings.remote, fetchSeconds: settings.fetchSeconds, repoDir: ROOT };
	const usage = 'Options: --port <n> --host <address> --remote <name> --fetch <seconds> --repo <dir>';
	for (let i = 0; i < args.length; i += 2) {
		const [flag, value] = [args[i], args[i + 1]];
		if (value === undefined) throw new Error(`${flag} needs a value. ${usage}`);
		if (flag === '--port') options.port = Number(value);
		else if (flag === '--host') options.host = value;
		else if (flag === '--remote') options.remote = value;
		else if (flag === '--fetch') options.fetchSeconds = Number(value);
		else if (flag === '--repo') options.repoDir = path.resolve(value);
		else throw new Error(`Unknown option ${flag}. ${usage}`);
	}
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('--port takes a port number (0: any free one)');
	if (!Number.isInteger(options.fetchSeconds) || options.fetchSeconds < 0) throw new Error('--fetch takes a number of seconds (0: never)');
	if (!REMOTE_NAME.test(options.remote)) throw new Error(`--remote takes a remote's name, not ${options.remote}`);
	return options;
}

async function main() {
	let options, settings;
	try {
		settings = loadConfig().localPreviews;
		options = parseArgs(process.argv.slice(2), settings);
	} catch (error) {
		console.error(`error: ${error.message}`);
		process.exit(2);
	}
	const where = checkHost(options.host);
	if (!where.ok) {
		console.error(`error: won't listen on ${options.host}: ${where.why}.`);
		process.exit(2);
	}
	const preview = createPreviewServer({ repoDir: options.repoDir, settings: { ...settings, remote: options.remote } });
	await preview.refresh();
	preview.startFetching(options.fetchSeconds);
	preview.server.listen(options.port, options.host, () => {
		const { port } = preview.server.address();
		const shown = options.host === '0.0.0.0' || options.host === '::' ? '127.0.0.1' : options.host.includes(':') ? `[${options.host}]` : options.host;
		console.log(`Serving ${preview.branches.list.length} branches of ${options.remote} at http://${shown}:${port}/`);
		if (!where.lan) return;
		const lan = options.host === '0.0.0.0' || options.host === '::'
			? Object.values(os.networkInterfaces()).flat().filter((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal).map((a) => a.address)
			: [options.host];
		for (const address of lan) console.log(`  on your network: http://${address.includes(':') ? `[${address}]` : address}:${port}/`);
		for (const line of LAN_WARNING) console.log(line);
	});
	const stop = () => preview.close().then(() => process.exit(0));
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}

// Last, so that everything it uses is declared by then (a `const` below a top-level call isn't yet: test/module-order.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
