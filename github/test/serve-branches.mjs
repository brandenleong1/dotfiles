// Local branch previews (tools/serve-branches.mjs) against a temporary repository with branches on a remote and a
// submodule: the index lists the branches with a site; each branch serves its own files, and the submodule at the
// commit it pins (fetched when the clone lacks it); the preview marker and title only when configured; `..`, odd refs,
// the working tree, symbolic links and other methods are refused; fetching picks up new branches; and it listens on
// loopback unless told otherwise, refusing public addresses even then. Every server it starts is closed.
// Standalone suite: precommit runs it (tools/run-tests.mjs).
//
//   node test/serve-branches.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer, parseArgs, checkHost, isSafePath, markPage } from '../tools/serve-branches.mjs';
import { DEFAULTS } from '../tools/pr-config.mjs';
import { git } from './fixtures/git-repos.mjs';

// the servers' own git runs in this process: keep it off the machine's config, as the fixtures' git is
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });

const here = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(here, '..', 'tools', 'serve-branches.mjs');
const CONFIG_FILE = path.join(here, 'fixtures', 'pr-automation.test.json');
const SETTINGS = { ...DEFAULTS.localPreviews, submodules: ['lib/theme'] };

let passed = 0, failed = 0;
function check(name, ok, detail = '') {
	if (ok) passed++;
	else { failed++; console.log(`FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'serve-branches-test-'));
const open = [];   // servers and processes to stop, whatever happens
try {
	const r = makeRepos();
	const plain = await start(r.work, SETTINGS);
	const get = (p, options) => request(plain.port, p, options);

	// ---- the index ------------------------------------------------------------------------------------------------
	const index = await get('/');
	check('the index lists the branches that have a site', index.status === 200 && ['main', 'alice/feature', 'bob/newer'].every((b) => index.body.includes(`>${b}</a>`)), index.body);
	check('…not one without the entry file', !index.body.includes('bot/images'));
	check('…with names escaped, and links encoded per segment', index.body.includes('>carol/x&#38;y</a>') && index.body.includes('href="/carol/x%26y/"'), index.body.match(/carol[^<]*/g)?.join(' | '));

	// ---- each branch serves its own files ---------------------------------------------------------------------------
	const mainPage = await get('/main/'), alicePage = await get('/alice/feature/');
	check('each branch serves its own entry page', mainPage.body === r.files.mainHtml && alicePage.body === r.files.aliceHtml, `${mainPage.body} | ${alicePage.body}`);
	const mainJs = await get('/main/app.js'), aliceJs = await get('/alice/feature/app.js');
	check('…and its own files, with their content types', mainJs.body === 'main();\n' && aliceJs.body === 'alice();\n' && mainJs.headers['content-type'] === 'text/javascript; charset=utf-8' && mainJs.headers['x-content-type-options'] === 'nosniff', JSON.stringify([mainJs.body, aliceJs.body, mainJs.headers]));
	check('…the tip as the last fetch saw it, not the working tree', (await get('/main/app.js')).body === 'main();\n' && fs.readFileSync(path.join(r.work, 'app.js'), 'utf8') === 'edited, not committed\n');
	const toSlash = await get('/main'), dir = await get('/main/docs'), dirIndex = await get('/main/docs/');
	check('a branch or directory without its slash redirects to it', toSlash.status === 302 && toSlash.headers.location === '/main/' && dir.status === 302 && dir.headers.location === '/main/docs/' && dirIndex.body === '<p>docs</p>\n', JSON.stringify([toSlash.status, toSlash.headers.location, dir.headers.location, dirIndex.body]));
	check('a path in a branch whose name is a prefix of another goes to the longer one', (await get('/alice/feature/app.js')).body === 'alice();\n');
	const cached = await get('/main/app.js', { headers: { 'if-none-match': mainJs.headers.etag } });
	const head = await get('/main/app.js', { method: 'HEAD' });
	check('an unchanged file answers 304, and HEAD has no body', cached.status === 304 && head.status === 200 && head.body === '' && head.headers['content-type'].startsWith('text/javascript'));

	// ---- the submodule, at the commit each branch pins ----------------------------------------------------------------
	const mainTheme = await get('/main/lib/theme/colors.css'), aliceTheme = await get('/alice/feature/lib/theme/colors.css');
	check('the submodule is served at the commit each branch pins', mainTheme.body === 'old colors\n' && aliceTheme.body === 'new colors\n', JSON.stringify([mainTheme.body, aliceTheme.body]));
	const fetched = await get('/bob/newer/lib/theme/colors.css');
	check("…fetching a pinned commit the submodule's clone doesn't have yet", fetched.body === 'newest colors\n', JSON.stringify(fetched));
	check('…and the gitlink itself is no file', (await get('/main/lib/theme')).status === 404);

	// ---- the marker, only when configured ------------------------------------------------------------------------------
	check('no marker or title change unless configured: pages served byte for byte', mainPage.body === r.files.mainHtml && !/branch-preview/.test(alicePage.body));
	const marked = await start(r.work, { ...SETTINGS, marker: 'branch-preview', titlePrefix: true });
	const markedPage = await request(marked.port, '/alice/feature/');
	check('with a marker: the meta tag names the branch, and the title shows it', markedPage.body.includes('<head>\n<meta name="branch-preview" content="alice/feature">') && markedPage.body.includes('<title>[alice/feature] Site</title>'), markedPage.body);
	check('…only in HTML pages', (await request(marked.port, '/alice/feature/app.js')).body === 'alice();\n' && (await request(marked.port, '/alice/feature/docs/')).body === '<p>docs</p>\n');
	check('…each branch\'s page cached apart', markedPage.headers.etag !== (await request(marked.port, '/main/')).headers.etag);
	check('…and a branch name is escaped in it', markPage('<head><title>t</title>', 'a/"<b>', { marker: 'm', titlePrefix: true }) === '<head>\n<meta name="m" content="a/&#34;&#60;b&#62;"><title>[a/&#34;&#60;b&#62;] t</title>');

	// ---- what it refuses -----------------------------------------------------------------------------------------------
	const statusOf = async (p, options) => (await get(p, options)).status;
	const escapes = ['/main/docs/%2e%2e%2fapp.js', '/main/a%2F..%2F..%2F..%2Fetc%2Fpasswd', '/main/x/..%5C..%5Capp.js', '/main/%00', '/main/docs//index.html'];
	const escaped = await Promise.all(escapes.map((p) => statusOf(p)));
	check('a `..`, `.` or empty segment, a backslash or a control character is refused', escaped.every((s) => s === 400), JSON.stringify(escapes.map((p, i) => `${p} ${escaped[i]}`)));
	const normalised = await Promise.all(['/main/../../etc/passwd', '/main/%2e%2e/%2e%2e/etc/passwd'].map((p) => get(p)));
	check('…and dot segments the URL resolves leave no branch', normalised.every((x) => x.status === 404 && !/root:/.test(x.body)), JSON.stringify(normalised.map((x) => x.status)));
	check('…or stay inside it', (await get('/main/./docs/../app.js')).body === 'main();\n');
	const mainSha = git(r.work, ['rev-parse', 'origin/main']);
	const refs = ['/HEAD/index.html', '/origin/main/index.html', '/refs/remotes/origin/main/index.html', '/main~1/index.html', '/main%5E/index.html', '/main@%7B1%7D/index.html', `/${mainSha}/index.html`, `/${mainSha.slice(0, 7)}/`, '/main:index.html', '/bot/images/'];
	const refStatus = await Promise.all(refs.map((p) => statusOf(p)));
	check('refs, revisions and SHAs in the URL are no branches', refStatus.every((s) => s === 404), JSON.stringify(refs.map((p, i) => `${p} ${refStatus[i]}`)));
	const tree = await Promise.all(['/main/secret.txt', '/main/.git/config', '/main/link', '/main/lib/theme/.git'].map((p) => statusOf(p)));
	check('untracked files, the .git directory and symbolic links aren\'t served', tree.every((s) => s === 404), JSON.stringify(tree));
	check('other methods are refused', (await statusOf('/main/', { method: 'POST' })) === 405 && (await statusOf('/main/', { method: 'DELETE' })) === 405);
	check('isSafePath', isSafePath('') && isSafePath('a/b.js') && isSafePath('dir/') && isSafePath('..hidden/x') && !isSafePath('a/../b') && !isSafePath('..') && !isSafePath('a//b') && !isSafePath('./a') && !isSafePath('a\\b') && !isSafePath('a\nb'));

	// ---- a submodule that isn't cloned here ----------------------------------------------------------------------------
	const bare = path.join(root, 'fresh');
	git(root, ['clone', '--quiet', r.server, bare]);
	const fresh = await start(bare, SETTINGS);
	const notCloned = await request(fresh.port, '/main/lib/theme/colors.css');
	check("a submodule that isn't cloned: no file, and the superproject's objects aren't served in its place", notCloned.status === 404 && (await request(fresh.port, '/main/app.js')).body === 'main();\n', JSON.stringify(notCloned));

	// ---- fetching ----------------------------------------------------------------------------------------------------
	git(r.work, ['switch', '--quiet', '-c', 'dave/later', 'origin/main']);
	fs.writeFileSync(path.join(r.work, 'index.html'), '<html><head><title>Site</title></head><body>later</body></html>\n');
	git(r.work, ['commit', '--quiet', '-am', 'Later']);
	git(r.work, ['push', '--quiet', 'origin', 'dave/later']);
	git(r.work, ['update-ref', '-d', 'refs/remotes/origin/dave/later']);
	check('before a fetch, a new branch isn\'t there', (await get('/dave/later/')).status === 404);
	await plain.preview.branches.fetch();
	check('…after one it is', (await get('/dave/later/')).status === 200 && /last fetched/.test((await get('/')).body));

	// ---- where it listens ----------------------------------------------------------------------------------------------
	const defaults = parseArgs([], DEFAULTS.localPreviews);
	check('it listens on 127.0.0.1 by default, on the configured port', defaults.host === '127.0.0.1' && defaults.port === 8000 && defaults.fetchSeconds === 120 && defaults.remote === 'origin');
	check('the flags override the config', JSON.stringify(parseArgs(['--port', '0', '--fetch', '0', '--remote', 'upstream'], DEFAULTS.localPreviews)) === JSON.stringify({ ...defaults, port: 0, remote: 'upstream', fetchSeconds: 0 }));
	for (const bad of [['--remote', '--upload-pack=x'], ['--port', '99999'], ['--fetch', '-1'], ['--host'], ['--bind', '0.0.0.0']]) {
		let threw = false;
		try { parseArgs(bad, DEFAULTS.localPreviews); } catch { threw = true; }
		check(`parseArgs refuses ${bad.join(' ')}`, threw);
	}
	const lanOnly = { eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }], lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] };
	const publicToo = { ...lanOnly, eth1: [{ address: '203.0.113.7', family: 'IPv4', internal: false }] };
	const vpn = { ...lanOnly, tun0: [{ address: '100.101.102.103', family: 'IPv4', internal: false }] };
	const globalV6 = { ...lanOnly, eth2: [{ address: '2001:db8::5', family: 'IPv6', internal: false }] };
	const host = (h, i) => checkHost(h, i);
	check('checkHost: loopback, without a LAN warning', host('127.0.0.1', publicToo).ok && !host('127.0.0.1').lan && host('localhost').ok && host('::1').ok);
	check('…a private address, with one', host('192.168.1.20', publicToo).ok && host('192.168.1.20').lan && host('10.0.0.5').ok && host('172.20.1.1').ok && host('fd12:3456::1').ok);
	check('…0.0.0.0 only while every IPv4 address is private', host('0.0.0.0', lanOnly).ok && !host('0.0.0.0', publicToo).ok && !host('0.0.0.0', vpn).ok && host('0.0.0.0', globalV6).ok);
	check('…:: only while every address is', host('::', lanOnly).ok && !host('::', globalV6).ok);
	check('…never a public address, a VPN-range one, or a host name', !host('203.0.113.7').ok && !host('8.8.8.8').ok && !host('100.64.0.1').ok && !host('172.32.0.1').ok && !host('example.com').ok && !host('2001:db8::5').ok);

	// the command, as `npm run serve:branches` starts it
	const cli = await runCli(['--port', '0', '--fetch', '0', '--repo', r.work], /^Serving \d+ branches of origin at (http:\S+)$/m);
	check('the command serves on 127.0.0.1 by default, with no LAN warning', /^http:\/\/127\.0\.0\.1:\d+\/$/.test(cli.url || '') && !/local network/.test(cli.out), cli.out);
	if (cli.url) check('…and answers there', (await request(Number(new URL(cli.url).port), '/')).status === 200);
	const refused = await runCli(['--port', '0', '--fetch', '0', '--repo', r.work, '--host', '203.0.113.7']);
	check('…and won\'t listen on a public address', refused.code === 2 && /won't listen on 203\.0\.113\.7/.test(refused.err) && !/Serving/.test(refused.out), JSON.stringify(refused));
} finally {
	for (const item of open.reverse()) await item.stop();
	fs.rmSync(root, { recursive: true, force: true });
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

/**
 * A remote with branches `main` (the submodule at its first commit), `alice/feature` (at its second), `bob/newer` (at a
 * third, which the working clone's submodule hasn't fetched), `carol/x&y`, and `bot/images` (no site); a working clone
 * that fetched them all, with an untracked file and an uncommitted edit.
 */
function makeRepos() {
	const theme = path.join(root, 'theme');
	git(root, ['init', '--quiet', '-b', 'main', theme]);
	const themeCommit = (text) => {
		fs.writeFileSync(path.join(theme, 'colors.css'), `${text}\n`);
		git(theme, ['add', '-A']);
		git(theme, ['commit', '--quiet', '-m', text]);
		return git(theme, ['rev-parse', 'HEAD']);
	};
	const [oldTheme, newTheme] = [themeCommit('old colors'), themeCommit('new colors')];
	const server = path.join(root, 'origin.git');
	git(root, ['init', '--quiet', '--bare', server]);
	const work = path.join(root, 'work');
	git(root, ['init', '--quiet', '-b', 'main', work]);
	git(work, ['remote', 'add', 'origin', server]);
	const files = {
		mainHtml: '<!DOCTYPE html>\n<html><head><title>Site</title></head><body>main</body></html>\n',
		aliceHtml: '<!DOCTYPE html>\n<html><head><title>Site</title></head><body>alice</body></html>\n',
	};
	const write = (name, text) => {
		fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
		fs.writeFileSync(path.join(work, name), text);
	};
	write('index.html', files.mainHtml);
	write('app.js', 'main();\n');
	write('docs/index.html', '<p>docs</p>\n');
	fs.symlinkSync('/etc/hostname', path.join(work, 'link'));
	git(work, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', theme, 'lib/theme']);
	git(path.join(work, 'lib/theme'), ['checkout', '--quiet', oldTheme]);
	git(work, ['add', '-A']);
	git(work, ['commit', '--quiet', '-m', 'Main']);
	git(work, ['switch', '--quiet', '-c', 'alice/feature']);
	write('index.html', files.aliceHtml);
	write('app.js', 'alice();\n');
	git(work, ['add', 'index.html', 'app.js']);
	git(work, ['update-index', '--cacheinfo', `160000,${newTheme},lib/theme`]);
	git(work, ['commit', '--quiet', '-m', 'Alice']);   // not -a: that would stage the submodule's checkout again
	git(work, ['switch', '--quiet', '-c', 'bob/newer', 'main']);
	const newest = themeCommit('newest colors');   // after the clone: its submodule doesn't have this one
	git(work, ['update-index', '--cacheinfo', `160000,${newest},lib/theme`]);
	git(work, ['commit', '--quiet', '-m', 'Bob']);
	git(work, ['switch', '--quiet', '-c', 'carol/x&y', 'main']);
	git(work, ['commit', '--quiet', '--allow-empty', '-m', 'Carol']);
	const emptyTree = git(work, ['mktree'], { input: '' });
	git(work, ['update-ref', 'refs/heads/bot/images', git(work, ['commit-tree', emptyTree, '-m', 'Images only'])]);
	git(work, ['switch', '--quiet', 'main']);
	git(work, ['push', '--quiet', 'origin', 'main', 'alice/feature', 'bob/newer', 'carol/x&y', 'bot/images']);
	git(work, ['fetch', '--quiet', 'origin']);
	fs.writeFileSync(path.join(work, 'secret.txt'), 'untracked\n');
	fs.writeFileSync(path.join(work, 'app.js'), 'edited, not committed\n');
	return { work, server, files };
}

/** A preview server on 127.0.0.1 and a free port: { preview, port }. */
async function start(repoDir, settings) {
	const preview = createPreviewServer({ repoDir, settings });
	await preview.refresh();
	await new Promise((resolve) => preview.server.listen(0, '127.0.0.1', resolve));
	open.push({ stop: () => preview.close() });
	return { preview, port: preview.server.address().port };
}

/** A request with the path sent exactly as given: { status, headers, body }. */
function request(port, rawPath, { method = 'GET', headers = {} } = {}) {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, path: rawPath, method, headers, agent: false }, (res) => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', (chunk) => { body += chunk; });
			res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
		});
		req.on('error', reject);
		req.end();
	});
}

/** Start the command; once `ready` matches its output (or it exits), { url, out, err, code }. It is stopped after. */
function runCli(args, ready = null) {
	const child = spawn(process.execPath, [TOOL, ...args], { env: { ...process.env, PR_AUTOMATION_CONFIG: CONFIG_FILE }, stdio: ['ignore', 'pipe', 'pipe'] });
	open.push({ stop: () => new Promise((resolve) => { if (child.exitCode !== null || child.signalCode) return resolve(); child.once('exit', resolve); child.kill(); }) });
	return new Promise((resolve) => {
		let out = '', err = '';
		const timer = setTimeout(() => resolve({ out, err, code: null }), 20000);
		const done = (result) => { clearTimeout(timer); resolve({ out, err, ...result }); };
		child.stdout.on('data', (chunk) => {
			out += chunk;
			const m = ready && ready.exec(out);
			if (m) done({ url: m[1], code: null });
		});
		child.stderr.on('data', (chunk) => { err += chunk; });
		child.on('exit', (code) => done({ code }));
	});
}
