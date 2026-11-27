// The Pages publisher (tools/pages.mjs) against real git fixtures: the default branch at the root and every other
// branch with the entry file as a preview, only the configured files, a submodule fetched at the commit each branch
// pins from the configured URL, symlinks and dotfiles left out, branch names kept inside the preview directory, a
// deleted branch's preview gone on the next build, and previews off.
// Standalone suite: precommit runs it (tools/run-tests.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { branchDirectory, buildPages } from '../tools/pages.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-test-'));
try {
	const repository = init('site');
	const theme = init('theme');
	write(theme, 'colors.css', 'old colors');
	git(theme, ['add', '.']);
	const oldTheme = commit(theme);
	write(theme, 'colors.css', 'new colors');
	git(theme, ['add', '.']);
	const newTheme = commit(theme);
	const pages = {
		previews: true, include: ['index.html', 'app.js', 'css/', 'lib/', 'data/'], entry: 'index.html',
		previewDir: 'branches', previewMeta: 'branch-preview', submodules: { 'lib/theme': theme },
	};
	const liveHtml = '<html><head><link href="lib/theme/colors.css"></head><body>main</body></html>';
	write(repository, 'index.html', liveHtml);
	write(repository, 'app.js', 'throw new Error("Do not run branch code");');
	write(repository, 'data/items.json', '{}');
	write(repository, 'css/site.css', 'body {}');
	write(repository, 'test/private.mjs', 'not for publication');
	write(repository, 'tools/private.txt', 'not for publication');
	write(repository, '.github/private.txt', 'not for publication');
	write(repository, 'css/.hidden', 'not for publication');
	git(repository, ['add', '.']);
	git(repository, ['update-index', '--add', '--cacheinfo', `160000,${oldTheme},lib/theme`]);
	const main = commit(repository);
	git(repository, ['update-ref', 'refs/remotes/origin/main', main]);
	git(repository, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
	write(repository, 'index.html', '<html><head></head><body>preview</body></html>');
	git(repository, ['add', 'index.html']);
	git(repository, ['update-index', '--cacheinfo', `160000,${newTheme},lib/theme`]);
	// A symlink pointing outside the artifact must never be dereferenced.
	const link = git(repository, ['hash-object', '-w', '--stdin'], '/etc/passwd').trim();
	git(repository, ['update-index', '--add', '--cacheinfo', `120000,${link},data/link`]);
	const preview = commit(repository);
	for (const name of ['alice/feature', 'bob/feature/js', 'alice.feature', 'alice/feature&more']) {
		git(repository, ['update-ref', `refs/remotes/origin/${name}`, preview]);
	}
	// A fork publishes its own origin, even when another remote is present locally.
	git(repository, ['update-ref', 'refs/remotes/upstream/upstream-only', preview]);
	const emptyTree = git(repository, ['mktree'], '').trim();
	const images = git(repository, ['commit-tree', emptyTree, '-m', 'Images only']).trim();
	git(repository, ['update-ref', 'refs/remotes/origin/bot/screenshots', images]);
	const output = path.join(temporary, 'output');
	buildPages({ repository, output, pages, defaultBranch: 'main' });
	assert.equal(read(output, 'index.html'), liveHtml);
	assert.equal(read(output, 'lib/theme/colors.css'), 'old colors');
	assert.equal(read(output, 'data/items.json'), '{}');
	assert.equal(read(output, 'css/site.css'), 'body {}');
	const branch = `branches/${branchDirectory('alice/feature')}`;
	assert.match(read(output, `${branch}/index.html`), /<head>\n<meta name="branch-preview" content="alice\/feature">/);
	assert.equal(read(output, `${branch}/lib/theme/colors.css`), 'new colors');
	assert.match(read(output, `branches/${branchDirectory('bob/feature/js')}/index.html`), /content="bob\/feature\/js"/);
	assert.match(read(output, 'branches/alice.feature/index.html'), /content="alice.feature"/);
	assert.match(read(output, 'branches/alice/feature&more/index.html'), /content="alice\/feature&amp;more"/);
	for (const file of ['tools', 'test', '.github', '.git', 'css/.hidden', `${branch}/data/link`, 'branches/bot/screenshots', 'branches/upstream-only']) {
		assert.equal(fs.existsSync(path.join(output, file)), false, file);
	}
	assert.equal(fs.existsSync(path.join(output, '.nojekyll')), true);
	assert.throws(() => buildPages({ repository, output, pages, defaultBranch: 'main' }), /new directory/);
	assert.throws(() => buildPages({ repository, output: path.join(temporary, 'x'), pages, defaultBranch: 'trunk' }), /The trunk branch is required/);
	git(repository, ['update-ref', '-d', 'refs/remotes/origin/bob/feature/js']);
	git(repository, ['update-ref', '-d', 'refs/remotes/origin/alice/feature']);
	const next = path.join(temporary, 'next');
	buildPages({ repository, output: next, pages, defaultBranch: 'main' });
	assert.equal(fs.existsSync(path.join(next, branch)), false);
	assert.equal(read(next, 'index.html'), read(output, 'index.html'));
	const rootOnly = path.join(temporary, 'root-only');
	buildPages({ repository, output: rootOnly, pages: { ...pages, previews: false }, defaultBranch: 'main' });
	assert.equal(fs.existsSync(path.join(rootOnly, 'branches')), false);
	const noTheme = path.join(temporary, 'no-theme');
	buildPages({ repository, output: noTheme, pages: { ...pages, include: ['index.html'], submodules: {} }, defaultBranch: 'main' });
	assert.deepEqual(fs.readdirSync(noTheme).sort(), ['.nojekyll', 'branches', 'index.html']);
	for (const name of ['alice/feature', 'a.b', 'a-b', 'A-b', 'é', 'a/b/c']) {
		assert.equal(branchDirectory(name), name);
	}
	for (const name of ['../js', '/js', 'a/../js', 'a/./js', 'a//js', 'a\\js', 'C:/js']) {
		assert.throws(() => branchDirectory(name), /Invalid branch directory/);
	}
	console.log('Pages: root, previews, submodule pins, exclusions, names, deletion and previews off: 1 passed, 0 failed');
} finally {
	fs.rmSync(temporary, { recursive: true, force: true });
}

function init(name) {
	const directory = path.join(temporary, name);
	fs.mkdirSync(directory);
	git(directory, ['init', '--quiet']);
	git(directory, ['config', 'user.name', 'Pages Test']);
	git(directory, ['config', 'user.email', 'pages@example.invalid']);
	return directory;
}

function commit(directory) {
	git(directory, ['commit', '--quiet', '-m', 'Fixture']);
	return git(directory, ['rev-parse', 'HEAD']).trim();
}

function write(directory, name, content) {
	const file = path.join(directory, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function read(directory, name) {
	return fs.readFileSync(path.join(directory, name), 'utf8');
}

function git(directory, args, input) {
	return execFileSync('git', ['-C', directory, ...args], {
		encoding: 'utf8', input, windowsHide: true,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
	});
}
