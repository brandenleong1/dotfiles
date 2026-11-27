// Assembles one GitHub Pages artifact from the repository's branches, without running their code or checking them out
// (.github/workflows/pages.yml, from the default branch only). The default branch is the site's root; with
// pages.previews on, every other branch that has the site's entry file is published under `<previewDir>/<branch>/`.
// Only the files pages.include lists are published, read from each branch as git objects: no symlinks, no dotfiles, no
// path outside the branch's directory. A submodule in pages.submodules is fetched at the commit the branch pins, from
// the URL the config gives, never from the branch's .gitmodules.
//
//   node tools/pages.mjs <new-output-directory>     in a clone with every branch fetched (refs/remotes/origin/*)
//
// Each preview's entry HTML gets `<meta name="<previewMeta>" content="<branch>">`, so the site can tell it's a preview
// (e.g. to keep its storage keys apart from the live site's). That is a convenience, not a security boundary: every
// preview runs unreviewed code on the live site's origin, and is public (README.md, "Pages previews").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './pr-config.mjs';

/** Keep the branch's hierarchy while preventing paths outside its preview directory. */
export function branchDirectory(name) {
	if (/[\\:\0]/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) {
		throw new Error(`Invalid branch directory: ${name}`);
	}
	return name;
}

/**
 * Write the site for every branch into `output` (a new directory). `pages` is the config's `pages` section, and
 * `defaultBranch` the branch published at the root.
 */
export function buildPages({ repository, output, pages, defaultBranch }) {
	if (fs.existsSync(output)) throw new Error('Pages output must be a new directory.');
	const branches = remoteBranches(repository);
	if (!branches.some(({ name }) => name === defaultBranch)) throw new Error(`The ${defaultBranch} branch is required.`);
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
	try {
		const modules = path.join(temporary, 'modules.git');
		git(temporary, ['init', '--quiet', '--bare', modules]);
		for (const branch of branches) {
			const root = branch.name === defaultBranch;
			if (!root && !pages.previews) continue;
			const destination = root ? output : path.join(output, pages.previewDir, branchDirectory(branch.name));
			publishBranch({ repository, destination, branch, root, modules, pages });
		}
		fs.writeFileSync(path.join(output, '.nojekyll'), '');
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

function remoteBranches(repository) {
	return git(repository, ['for-each-ref', '--format=%(objectname) %(refname:strip=3)', 'refs/remotes/origin/'])
		.toString().trim().split('\n').filter(Boolean).map((line) => {
			const [sha, name] = line.split(' ');
			return { sha, name };
		}).filter(({ name }) => name !== 'HEAD');
}

function publishBranch({ repository, destination, branch, root, modules, pages }) {
	const entries = treeEntries(repository, branch.sha);
	if (!entries.some(({ name, mode }) => name === pages.entry && ['100644', '100755'].includes(mode))) {
		if (root) throw new Error(`The default branch must contain ${pages.entry}.`);
		console.log(`Skipping ${branch.name}: no site (${pages.entry}).`);
		return;
	}
	writeFiles(repository, destination, entries.filter(({ name }) => isSiteFile(name, pages.include)));
	if (!root) markPreview(path.join(destination, pages.entry), branch.name, pages.previewMeta);
	console.log(`${branch.name}: ${root ? './' : `${pages.previewDir}/${branchDirectory(branch.name)}/`}`);
	for (const [modulePath, url] of Object.entries(pages.submodules)) {
		const pinned = entries.find(({ name, mode }) => name === modulePath && mode === '160000');
		if (!pinned || !isSiteFile(`${modulePath}/`, pages.include)) continue;
		// only the pinned commit, from the configured repository, never a branch's .gitmodules URL
		git(modules, ['fetch', '--quiet', '--depth=1', '--', url, pinned.sha]);
		writeFiles(modules, path.join(destination, modulePath), treeEntries(modules, pinned.sha));
	}
}

/** Add the preview marker to the entry file's <head>, if it's HTML. */
function markPreview(file, branch, metaName) {
	if (!/\.html?$/i.test(file)) return;
	const html = fs.readFileSync(file, 'utf8');
	const head = /<head\b[^>]*>/i;
	if (!head.test(html)) throw new Error(`Preview ${branch} must have a head element in its entry file.`);
	const escaped = branchDirectory(branch).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
	fs.writeFileSync(file, html.replace(head, (opening) => `${opening}\n<meta name="${metaName}" content="${escaped}">`));
}

/** Whether a path is published: it is an `include` entry, or under one that ends with `/`. */
function isSiteFile(name, include) {
	return include.some((entry) => (entry.endsWith('/') ? name.startsWith(entry) : name === entry));
}

function treeEntries(repository, ref) {
	return git(repository, ['ls-tree', '-rz', ref]).toString().split('\0').filter(Boolean).map((entry) => {
		const tab = entry.indexOf('\t');
		const [mode, , sha] = entry.slice(0, tab).split(' ');
		return { mode, sha, name: entry.slice(tab + 1) };
	});
}

function writeFiles(repository, destination, entries) {
	for (const { mode, sha, name } of entries) {
		// Symlinks are excluded: artifact upload dereferences them, potentially outside the site.
		if (mode !== '100644' && mode !== '100755') continue;
		if (name.split('/').some((part) => part.startsWith('.') || part.includes('\\'))) continue;
		const file = path.join(destination, name);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, git(repository, ['cat-file', 'blob', sha]));
	}
}

/** git without the system or global config, so no filter, hook or helper of the runner's applies. */
function git(repository, args) {
	return execFileSync('git', ['-C', repository, ...args], {
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
	});
}

function main() {
	if (!process.argv[2]) throw new Error('Usage: node tools/pages.mjs <new-output-directory>');
	const config = loadConfig();
	buildPages({ repository: process.cwd(), output: path.resolve(process.argv[2]), pages: config.pages, defaultBranch: config.defaultBranch });
}

// Last, so that everything it uses is declared by then (a `const` below a top-level call isn't yet: test/module-order.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
