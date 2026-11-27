// The screenshot bot's trusted half (tools/screenshot-comment.mjs) against an in-memory GitHub
// (test/fixtures/fake-github.mjs): comparing a run's before/ and after/ images by their pixels, the comment and the
// stored images, GitHub timing out or erroring part way, what the PR is told when posting fails, the untrusted
// artifact's checks, and the daily prune. No network.
// Standalone suite: precommit runs it (tools/run-tests.mjs).
//
//   node test/screenshot-comment.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodePng, rgbaPng } from './fixtures/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools/screenshot-comment.mjs');
const FAKE = path.join(ROOT, 'test/fixtures/fake-github.mjs');
const SHA = 'a'.repeat(7) + '1'.repeat(33);
const RUN_URL = 'https://github.com/o/r/actions/runs/777';
const TIMED_OUT = { status: 422, message: "Sorry, your request timed out.  It's likely that your input was too large to process." };
const MARKER = '<!-- pr-automation: screenshots -->';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-comment-test-'));
process.on('exit', () => fs.rmSync(work, { recursive: true, force: true }));
const CONFIG = path.join(work, 'config.json');
fs.writeFileSync(CONFIG, JSON.stringify({ screenshots: { enabled: true, views: ['settings', 'menu'], limits: { views: 100, pngBytes: 3145728, totalBytes: 83886080, pixels: 4096 } } }));

// images: `plain` and `again` show the same pixels in different bytes (another row filter); `other` differs in 3 pixels
const color = (x, y) => [(x * 40) & 255, (y * 60) & 255, 128, 255];
const IMAGES = {
	plain: encodePng({ width: 8, height: 6, sample: color, filter: 0 }),
	again: encodePng({ width: 8, height: 6, sample: color, filter: 'cycle' }),
	other: rgbaPng(8, 6, (x, y) => (y === 2 && x < 3 ? [0, 0, 0, 255] : color(x, y))),
	big: rgbaPng(80, 80, () => [1, 2, 3, 255]),
	big2: rgbaPng(80, 80, () => [1, 2, 4, 255]),
};

/**
 * A Screenshots run's artifact: `views` is [name, status]. 'same' writes the same pixels on both sides (in different
 * bytes), 'changed' different ones, 'added' only after/, 'removed' only before/.
 */
function artifact(views, { before = true } = {}) {
	const dir = fs.mkdtempSync(path.join(work, 'art-'));
	fs.mkdirSync(path.join(dir, 'after'));
	if (before) fs.mkdirSync(path.join(dir, 'before'));
	for (const [name, status] of views) {
		const [b, a] = { same: ['plain', 'again'], changed: ['plain', 'other'], added: [null, 'plain'], removed: ['plain', null] }[status];
		if (a) fs.writeFileSync(path.join(dir, 'after', `${name}.png`), IMAGES[a]);
		if (b && before) fs.writeFileSync(path.join(dir, 'before', `${name}.png`), IMAGES[b]);
	}
	return dir;
}

/** Run the tool (`post` for PR 7's head, unless `args`) against a fake GitHub set up by `fake`; what happened. */
function post(dir, fake = {}, { conclusion = 'success', sha = SHA, args = null } = {}) {
	const out = path.join(work, `out-${Math.random().toString(36).slice(2)}.json`);
	const config = { pulls: [{ number: 7, sha: SHA }], ...fake };
	const env = { ...process.env, PR_AUTOMATION_CONFIG: CONFIG, GITHUB_TOKEN: 'test', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '888', GITHUB_SERVER_URL: 'https://github.com', FAKE_GITHUB: JSON.stringify(config), FAKE_GITHUB_OUT: out };
	return new Promise((done) => {
		const child = spawn(process.execPath, ['--import', pathToFileURL(FAKE).href, TOOL, ...(args || ['post', dir, sha, conclusion, RUN_URL])], { env });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));
		child.on('close', (status) => {
			const seen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
			done({ status, stdout, stderr, ...seen, count: (what) => (seen?.calls || []).filter((c) => c.startsWith(what)).length });
		});
	});
}

const cases = [];
const test = (name, run) => cases.push([name, run]);
const bodyOf = (r) => r.comments.map((c) => c.body).join('\n');
const linksOf = (text) => [...text.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0]);
const FOLDER = 'https://github.com/o/r/tree/bot/screenshots/auto/pr-7/aaaaaaa';
const COMMENT_DOWN = { match: 'POST /issues/7/comments', times: 4, status: 502, message: 'Bad Gateway' };   // all four tries

test('compares by pixels: posts the views that changed, says how many of how many, in screenshots.views order', async () => {
	const r = await post(artifact([['about', 'changed'], ['help', 'same'], ['menu', 'changed'], ['settings', 'added'], ['old', 'removed']]));
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.comments.length, 1);
	const body = bodyOf(r);
	assert.match(body, new RegExp(`^${MARKER}\\n### Screenshots\\n\\n\`main\` next to this PR at aaaaaaa`));
	assert.match(body, /\*\*4 of 5 views look different\.\*\*/);
	assert.deepEqual([...body.matchAll(/^#### `([a-z-]+)`/gm)].map((m) => m[1]), ['settings', 'menu', 'about', 'old'], 'configured views first, then by name');
	assert.match(body, /#### `menu` \(3 pixels differ\)/);
	assert.match(body, /#### `settings` \(new view\)/);
	assert.match(body, /#### `old` \(no longer taken\)/);
	assert.match(body, /<sub>Unchanged: `help`<\/sub>/, 'the same pixels in other bytes are the same');
	assert.match(body, /\(https:\/\/github\.com\/o\/r\/blob\/bot\/screenshots\/auto\/pr-7\/aaaaaaa\/menu\.before\.png\?raw=true\)/, 'links that show in a private repository');
	assert.deepEqual(Object.keys(r.branch).sort(), ['auto/pr-7/aaaaaaa/about.after.png', 'auto/pr-7/aaaaaaa/about.before.png', 'auto/pr-7/aaaaaaa/menu.after.png', 'auto/pr-7/aaaaaaa/menu.before.png', 'auto/pr-7/aaaaaaa/old.before.png', 'auto/pr-7/aaaaaaa/settings.after.png']);
});

test('a base without screenshots: every view is new', async () => {
	const r = await post(artifact([['menu', 'changed']], { before: false }));
	assert.equal(r.status, 0, r.stderr);
	assert.match(bodyOf(r), /\*\*1 of 1 views look different\.\*\*[\s\S]*`menu` \(new view\)/);
});

test('no artifact at all (the script wrote nothing, or screenshots are off on the branch): says so', async () => {
	const r = await post(path.join(work, 'not-downloaded'));
	assert.equal(r.status, 0, r.stderr);
	assert.match(bodyOf(r), /\*\*No screenshots\*\*: the run uploaded no images/);
	assert.equal(r.count('POST /git/blobs'), 0);
});

test('images it cannot decode (interlaced, or over the pixel budget) are compared byte for byte', async () => {
	const dir = artifact([]);
	const interlaced = (v) => encodePng({ width: 2, height: 2, sample: () => [v, 0, 0, 255], interlace: 1 });
	fs.writeFileSync(path.join(dir, 'before', 'odd.png'), interlaced(1));
	fs.writeFileSync(path.join(dir, 'after', 'odd.png'), interlaced(2));
	fs.writeFileSync(path.join(dir, 'before', 'odd-same.png'), interlaced(1));
	fs.writeFileSync(path.join(dir, 'after', 'odd-same.png'), interlaced(1));
	fs.writeFileSync(path.join(dir, 'before', 'large.png'), IMAGES.big);
	fs.writeFileSync(path.join(dir, 'after', 'large.png'), IMAGES.big2);
	const r = await post(dir);
	assert.equal(r.status, 0, r.stderr);
	assert.match(bodyOf(r), /\*\*2 of 3 views look different\.\*\*/);
	assert.match(bodyOf(r), /#### `odd`\n/, 'no pixel count when it could not count them');
	assert.match(r.stdout, /large\.png: compared byte for byte \(80x80 is more than 4096 pixels\)/);
});

test("replaces this PR's older images and leaves everything else on the branch alone", async () => {
	const branch = { 'auto/pr-7/bbbbbbb/menu.after.png': 'old', 'auto/pr-5/ccccccc/x.png': 'five', 'pr-7/by-hand.png': 'hand', 'README.md': 'readme' };
	const r = await post(artifact([['menu', 'changed']]), { branch });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(Object.keys(r.branch).sort(), ['README.md', 'auto/pr-5/ccccccc/x.png', 'auto/pr-7/aaaaaaa/menu.after.png', 'auto/pr-7/aaaaaaa/menu.before.png', 'pr-7/by-hand.png']);
	assert.equal(r.branch['pr-7/by-hand.png'], 'hand');
});

test('describes a tree change, not every file on the branch', async () => {
	const branch = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`auto/pr-${100 + i}/ddddddd/v.png`, `v${i}`]));
	const r = await post(artifact([['menu', 'changed']]), { branch });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(Object.keys(r.branch).length, 302);
	assert.ok(r.treeSizes[0] <= 2, `the tree request carried ${r.treeSizes[0]} entries`);
});

test('creates the branch when there is none', async () => {
	const r = await post(artifact([['menu', 'added']]));
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(Object.keys(r.branch), ['auto/pr-7/aaaaaaa/menu.after.png']);
});

test('edits its comment on a later push instead of adding another', async () => {
	const r = await post(artifact([['menu', 'same']]), { comments: [{ id: 5, number: 7, body: `${MARKER}\nold` }, { id: 6, number: 7, body: 'someone else' }] });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.comments.length, 2);
	assert.match(r.comments[0].body, /No view looks different\*\* \(1 checked\)/);
	assert.equal(r.comments[1].body, 'someone else');
});

test('does nothing when no open PR has that head (pushed again, or merged)', async () => {
	const r = await post(artifact([['menu', 'changed']]), {}, { sha: 'b'.repeat(40) });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /no open PR has head bbbbbbb/);
	assert.equal(r.comments.length, 0);
	assert.equal(r.count('POST'), 0);
});

test('links the run when the Screenshots run itself failed', async () => {
	const r = await post(artifact([]), {}, { conclusion: 'failure' });
	assert.equal(r.status, 0, r.stderr);
	assert.match(bodyOf(r), /couldn't be taken: see \[the run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/777\)/);
});

test('refuses a head that is no SHA, and a run URL on another server', async () => {
	assert.equal((await post(artifact([]), {}, { sha: 'main' })).status, 2);
	assert.equal((await post(artifact([]), {}, { args: ['post', artifact([]), SHA, 'success', 'https://evil.example/o/r/actions/runs/1'] })).status, 2);
});

test('repeats a tree request GitHub timed out on', async () => {
	const r = await post(artifact([['menu', 'changed']]), { faults: [{ match: 'POST /git/trees', times: 2, ...TIMED_OUT }] });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.count('POST /git/trees'), 3);
	assert.equal(r.comments.length, 1);
	assert.match(bodyOf(r), /1 of 1 views look different/);
	assert.equal(Object.keys(r.branch).length, 2);
});

test('repeats requests that got a server error or lost the connection', async () => {
	const r = await post(artifact([['menu', 'changed']]), {
		faults: [{ match: 'GET /pulls', status: 502, message: 'Bad Gateway' }, { match: 'POST /git/blobs', network: true }, { match: 'POST /git/commits', status: 503, message: 'x' }],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.comments.length, 1);
});

test('waits when GitHub says it is rate limiting, then goes on', async () => {
	const r = await post(artifact([['menu', 'changed']]), { faults: [{ match: 'POST /git/blobs', times: 1, status: 403, message: 'secondary rate limit', headers: { 'retry-after': '1' } }] });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.comments.length, 1);
});

test('does not repeat a request that is simply wrong', async () => {
	const r = await post(artifact([['menu', 'changed']]), { branch: { 'README.md': 'readme' }, faults: [{ match: 'POST /git/trees', times: 99, status: 422, message: 'tree.sha is not a valid sha' }] });
	assert.equal(r.status, 1);
	assert.equal(r.count('POST /git/trees'), 2, 'the short form once, then the whole list once');
});

test('sends the whole file list when GitHub refuses the short form for good', async () => {
	const branch = { 'auto/pr-7/bbbbbbb/menu.after.png': 'old', 'auto/pr-5/ccccccc/x.png': 'five', 'pr-7/by-hand.png': 'hand', 'README.md': 'readme' };
	const r = await post(artifact([['menu', 'changed']]), { branch, faults: [{ match: 'POST /git/trees', bodyHas: '"base_tree"', times: 99, status: 422, message: 'base_tree is not supported' }] });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /sending the whole file list instead/);
	assert.deepEqual(r.treeSizes, [3, 5], 'the short form: 1 deleted and 2 added; the whole list: 3 kept and 2 added');
	assert.deepEqual(Object.keys(r.branch).sort(), ['README.md', 'auto/pr-5/ccccccc/x.png', 'auto/pr-7/aaaaaaa/menu.after.png', 'auto/pr-7/aaaaaaa/menu.before.png', 'pr-7/by-hand.png']);
	assert.equal(r.comments.length, 1);
});

test('adds a comment once even if GitHub made it and then lost the answer', async () => {
	const r = await post(artifact([['menu', 'changed']]), { faults: [{ match: 'POST /issues/7/comments', times: 1, status: 502, message: 'Bad Gateway', afterSuccess: true }] });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.comments.length, 1);
	assert.equal(r.count('POST /issues/7/comments'), 1);
});

test('starts again when another run moved the branch first, and keeps what that run stored', async () => {
	const r = await post(artifact([['menu', 'changed']]), { branch: { 'README.md': 'readme' }, race: true });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /moved meanwhile/);
	assert.ok('auto/pr-99/abcdef0/other.png' in r.branch, 'the other run\'s image is gone');
	assert.ok('auto/pr-7/aaaaaaa/menu.after.png' in r.branch);
});

test("tells the PR when the images couldn't be stored, links the run's artifact, and fails the run", async () => {
	const branch = { 'README.md': 'readme', 'auto/pr-5/ccccccc/x.png': 'five' };
	const r = await post(artifact([['menu', 'changed']]), { branch, faults: [{ match: 'POST /git/trees', times: 99, ...TIMED_OUT }] });
	assert.equal(r.status, 1);
	assert.equal(r.count('POST /git/trees'), 4, 'a timeout is repeated, and not answered with a bigger request');
	assert.deepEqual(r.treeSizes, [2, 2, 2, 2]);
	assert.match(r.stderr, /^error: POST \/repos\/o\/r\/git\/trees: 422/m);
	assert.equal(r.comments.length, 1);
	const body = bodyOf(r);
	assert.ok(body.startsWith(MARKER));
	assert.match(body, /screenshots for aaaaaaa were taken but weren't stored/);
	assert.match(body, /artifact of \[the run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/777\)/);
	assert.match(body, /\[this run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/888\)/);
	assert.doesNotMatch(body, /tree\/bot\/screenshots/, 'there is no folder to link');
	assert.doesNotMatch(body, /timed out/);
	assert.deepEqual(Object.keys(r.branch).sort(), ['README.md', 'auto/pr-5/ccccccc/x.png']);
});

test("tells the PR where the images are when they were stored but the comment couldn't be written", async () => {
	const r = await post(artifact([['menu', 'changed'], ['help', 'same']]), { faults: [COMMENT_DOWN] });
	assert.equal(r.status, 1);
	assert.equal(r.comments.length, 1);
	const body = bodyOf(r);
	assert.match(body, /screenshots for aaaaaaa were taken and stored \(\[the images\]\(https:\/\/github\.com\/o\/r\/tree\/bot\/screenshots\/auto\/pr-7\/aaaaaaa\)\), but the comment couldn't be written/);
	assert.doesNotMatch(body, /weren't stored/);
	assert.deepEqual(linksOf(body), [FOLDER, 'https://github.com/o/r/actions/runs/888']);
	assert.deepEqual(Object.keys(r.branch).sort(), ['auto/pr-7/aaaaaaa/menu.after.png', 'auto/pr-7/aaaaaaa/menu.before.png'], 'the folder the link points to exists');
});

test('does not link a folder that was never made when no view looked different', async () => {
	const r = await post(artifact([['menu', 'same']]), { faults: [COMMENT_DOWN] });
	assert.equal(r.status, 1);
	assert.match(bodyOf(r), /were taken, and no view looks different, but the comment couldn't be written/);
	assert.deepEqual(linksOf(bodyOf(r)), ['https://github.com/o/r/actions/runs/888']);
	assert.deepEqual(Object.keys(r.branch), []);
});

test('replaces its own comment with the notice, so there is still one comment', async () => {
	const r = await post(artifact([['menu', 'changed']]), { comments: [{ id: 5, number: 7, body: `${MARKER}\nan older push` }], faults: [{ match: 'POST /git/trees', times: 99, ...TIMED_OUT }] });
	assert.equal(r.status, 1);
	assert.equal(r.comments.length, 1);
	assert.match(r.comments[0].body, /weren't stored/);
});

// ---- the untrusted artifact ------------------------------------------------------------------------------------------

/** Post `dir`; it must be refused (exit 2), with a notice on the PR that quotes nothing from it, and nothing stored. */
async function refused(dir, re) {
	const r = await post(dir);
	assert.equal(r.status, 2, r.stderr);
	if (re) assert.match(r.stderr, re);
	assert.equal(r.comments.length, 1);
	assert.match(bodyOf(r), /weren't stored/);
	assert.doesNotMatch(bodyOf(r), /evil|<img|\.\.\//);
	for (const link of linksOf(bodyOf(r))) assert.match(link, /^https:\/\/github\.com\/o\/r\/actions\/runs\/\d+$/);
	assert.equal(r.count('POST /git/blobs'), 0);
}

test('refuses a file name that could break out of the comment, saying nothing of it', async () => {
	const dir = artifact([['menu', 'changed']]);
	fs.writeFileSync(path.join(dir, 'after', 'x](http:evil.example)<img src=x>.png'), IMAGES.plain);
	await refused(dir, /isn't <view>\.png/);
});

test('refuses anything but before/ and after/ at the top, a subdirectory, and an upper-case or other name', async () => {
	const extra = artifact([['menu', 'same']]);
	fs.writeFileSync(path.join(extra, 'manifest.json'), '{}');
	await refused(extra, /only before\/ and after\//);
	const nested = artifact([['menu', 'same']]);
	fs.mkdirSync(path.join(nested, 'after', 'deep.png'));
	await refused(nested, /not a regular file/);
	const upper = artifact([]);
	fs.writeFileSync(path.join(upper, 'after', 'Menu.png'), IMAGES.plain);
	await refused(upper);
	const jpeg = artifact([]);
	fs.writeFileSync(path.join(jpeg, 'after', 'menu.jpg'), IMAGES.plain);
	await refused(jpeg);
});

test('refuses symbolic links, as files and as directories', async () => {
	const file = artifact([]);
	fs.symlinkSync('/etc/hostname', path.join(file, 'after', 'menu.png'));
	await refused(file, /not a regular file/);
	const dir = artifact([]);
	fs.rmSync(path.join(dir, 'before'), { recursive: true });
	fs.symlinkSync(path.join(dir, 'after'), path.join(dir, 'before'));
	await refused(dir, /before\/: not a plain directory/);
});

test('refuses a file that is not a PNG, and one over the size limit', async () => {
	const fake = artifact([]);
	fs.writeFileSync(path.join(fake, 'after', 'menu.png'), '<svg onload="evil()"/>');
	await refused(fake, /not a PNG/);
	const huge = artifact([]);
	fs.writeFileSync(path.join(huge, 'after', 'menu.png'), Buffer.concat([IMAGES.plain, Buffer.alloc(3145728)]));
	await refused(huge, /more than 3145728/);
});

test('accepts the view limit, and refuses one more', async () => {
	const views = Array.from({ length: 100 }, (_, i) => [`view-${i}`, 'same']);
	const r = await post(artifact(views));
	assert.equal(r.status, 0, r.stderr);
	assert.match(bodyOf(r), /No view looks different\*\* \(100 checked\)/);
	const over = artifact(views);
	fs.writeFileSync(path.join(over, 'after', 'view-100.png'), IMAGES.plain);
	const r2 = await post(over);
	assert.equal(r2.status, 2);
	assert.match(r2.stderr, /more than 100 views/);
	assert.doesNotMatch(bodyOf(r2), /view-/);
});

// ---- the daily prune -------------------------------------------------------------------------------------------------

test("prune deletes the images of PRs closed long ago, keeps the rest, and squashes the branch's history", async () => {
	const branch = { 'auto/pr-3/aaaaaaa/a.after.png': 'old', 'auto/pr-4/bbbbbbb/b.after.png': 'recent', 'auto/pr-7/ccccccc/c.after.png': 'open', 'auto/pr-9/ddddddd/d.after.png': 'gone', 'pr-3/by-hand.png': 'hand' };
	const now = Date.now();
	const closed = [{ number: 3, closedAt: new Date(now - 40 * 86400000).toISOString() }, { number: 4, closedAt: new Date(now - 2 * 86400000).toISOString() }, { number: 7, closedAt: null }];
	const r = await post(null, { branch, closed }, { args: ['prune'] });
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(Object.keys(r.branch).sort(), ['auto/pr-4/bbbbbbb/b.after.png', 'auto/pr-7/ccccccc/c.after.png', 'pr-3/by-hand.png']);
	assert.equal(r.commits[r.commits.length - 1], 'Screenshots for pull requests');
	assert.match(r.stdout, /squashed to one commit/);
});

// every case starts its own node process, so they run side by side
const errors = await Promise.all(cases.map(([, run]) => run().then(() => null, (e) => e)));
let failed = 0;
cases.forEach(([name], i) => {
	if (!errors[i]) return console.log(`ok   ${name}`);
	failed++;
	console.log(`FAIL ${name}\n${String(errors[i].stack || errors[i]).split('\n').slice(0, 8).join('\n')}`);
});
console.log(`${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
