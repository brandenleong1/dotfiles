// The PR automation's one config file, .github/pr-automation.json: its defaults, how a repository's file is merged
// over them, and the checks that keep a bad value from reaching a workflow. Every tool reads it through loadConfig();
// workflows read single values through the command line below. The file's fields are documented in
// .github/pr-automation.schema.json and README.md.
//
//   node tools/pr-config.mjs check                 validate the file; print what's on (exit 1 on an error)
//   node tools/pr-config.mjs get <dotted.path>     one value: a string as is, an array one item per line
//   node tools/pr-config.mjs outputs <section>     a section's plain values as `key=value` lines, appended to
//                                                  $GITHUB_OUTPUT when it's set (for a workflow's `with:` inputs)
//   node tools/pr-config.mjs ruleset <name>        .github/rulesets/<name>.json with the config applied (or `null`
//                                                  when the config makes that ruleset pointless)
//   node tools/pr-config.mjs labels                the labels the setup script creates: name<TAB>color<TAB>description
//   node tools/pr-config.mjs bumps                 the submodules to bump: path<TAB>branch<TAB>title
//
// The file is PR_AUTOMATION_CONFIG if that's set (the tests use it), otherwise .github/pr-automation.json next to this
// tools/ directory. No file at all means every default. Unknown keys are errors, so a typo can't silently do nothing.
// Values that reach a shell (script names, branch names, paths, labels) must match strict patterns, so the workflows
// can pass them through `env:` and quote them without worrying about what they hold.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB_ACTIONS_APP = 15368;   // the GitHub Actions app's id on github.com: statuses its token posts count
const MiB = 1024 * 1024;

/** Every setting, with its default. The shape here is the schema: a file may only set keys that exist here. */
export const DEFAULTS = Object.freeze({
	defaultBranch: 'main',
	title: {
		areas: ['Core', 'API', 'UI', 'Build', 'CI', 'Docs', 'Test', 'Deps'],
		maxTags: 2,
		qualifiers: ['Fix', 'Feature', 'Performance', 'Refactor'],
		maxLength: 80,
		titleCase: true,
		imperative: true,
		example: '[UI] Fix: Keep the Menu Open after a Click',
	},
	branch: {
		pattern: 'user',
		prefixes: [],
		regex: '',
		exempt: [],
	},
	description: {
		requiredSections: ['Context', 'Changes', 'Testing'],
		pastTenseSections: ['Changes', 'Testing'],
		sensitivePatterns: [],
	},
	testing: {
		section: 'Testing',
		requireTestedAt: true,
		localChecks: [
			{
				name: 'the test suite',
				match: '\\b(npm (run )?test|node tools/run-tests\\.mjs|ctest|make (check|test)|pytest|cargo test|go test)\\b',
				paths: [],
				why: '',
			},
		],
	},
	forbidden: {
		paths: ['(^|/)\\.env$', '\\.(pem|key|p12|pfx|keystore|jks)$', '(^|/)id_(rsa|dsa|ecdsa|ed25519)$'],
		message: 'look like credentials or private keys. Never add them; rotate any that were pushed.',
	},
	merge: {
		method: 'squash',
		status: 'pr-bot',
		requiredChecks: ['precommit', 'pr-policy'],
		approvals: 1,
		ciApprovals: 2,
		ciPaths: [
			'^\\.github/',
			'^tools/(pr-bot|pr-config|check-pr|same-changes|restack|screenshot-comment|png|pages|run-tests)\\.mjs$',
			'^tools/(github-setup|merge-pr)\\.sh$',
		],
		approverAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
		carryApprovals: 'count',
	},
	rebuild: {
		enabled: true,
		checkWorkflows: [{ file: 'precommit.yml', withPr: false }, { file: 'pr-policy.yml', withPr: true }],
		reviewDelayMinutes: 5,
	},
	ruleset: {
		requiredChecks: ['pr-bot'],
	},
	branches: {
		staleDays: 30,
		keep: [],
	},
	labels: {
		hold: 'hold',
		extra: [],
	},
	precommit: {
		syntaxCheck: true,
		npmCi: false,
		scripts: [],
		runTests: true,
	},
	postcommit: {
		enabled: false,
	},
	screenshots: {
		requiredFor: [],
		enabled: false,
		script: 'screenshots',
		install: '',
		views: [],
		branch: 'bot/screenshots',
		pruneDays: 30,
		limits: { views: 100, pngBytes: 3 * MiB, totalBytes: 80 * MiB, pixels: 4096 * 4096 },
	},
	pages: {
		enabled: false,
		previews: true,
		include: ['index.html'],
		entry: 'index.html',
		previewDir: 'branches',
		previewMeta: 'branch-preview',
		submodules: {},
	},
	stale: {
		enabled: false,
		closePrs: true,
		days: 30,
		label: 'stale',
		exemptLabel: 'keep-open',
		pruneBranches: true,
	},
	submodules: {
		enabled: false,
		bumps: [],
	},
	localPreviews: {
		remote: 'origin',
		port: 8000,
		fetchSeconds: 120,
		entry: 'index.html',
		submodules: [],
		marker: '',
		titlePrefix: false,
		types: {},
	},
});

// ---- patterns for values that reach a shell, git or a URL --------------------------------------------------------------

const PATTERNS = {
	branch: /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock(\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,99}(?<![/.])$/,
	script: /^[A-Za-z0-9][\w:.-]{0,63}$/,
	workflow: /^[A-Za-z0-9][\w-]{0,63}\.ya?ml$/,
	check: /^[\w][\w .:()/-]{0,99}$/,
	label: /^[^\s,][^\n\r,]{0,49}$/,
	color: /^[0-9a-fA-F]{6}$/,
	path: /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*\/?$/,
	word: /^[A-Z][A-Za-z0-9]{0,23}$/,
	section: /^[A-Z][A-Za-z ]{0,31}$/,
	association: /^(OWNER|MEMBER|COLLABORATOR|CONTRIBUTOR|FIRST_TIME_CONTRIBUTOR|FIRST_TIMER|MANNEQUIN|NONE)$/,
	url: /^https:\/\/[\w.-]+(:\d+)?\/[\w./~-]+$/,
	line: /^[^\n\r]{1,200}$/,
};

/** Field-specific checks: path -> (value) => error message or null. Arrays are checked item by item ('[]'). */
const RULES = {
	'defaultBranch': branch,
	'title.areas[]': (v) => match(v, PATTERNS.word, 'an area: one capitalised word'),
	'title.maxTags': (v) => range(v, 0, 3),
	'title.qualifiers[]': (v) => match(v, PATTERNS.word, 'a qualifier: one capitalised word'),
	'title.maxLength': (v) => range(v, 20, 200),
	'title.example': (v) => match(v, PATTERNS.line, 'one line'),
	'branch.pattern': (v) => oneOf(v, ['user', 'prefix', 'regex', 'any']),
	'branch.prefixes[]': (v) => match(v, /^[a-z0-9][a-z0-9-]{0,31}$/, 'a lower-case prefix'),
	'branch.regex': (v) => (v === '' ? null : regex(v)),
	'branch.exempt[]': branch,
	'description.requiredSections[]': (v) => match(v, PATTERNS.section, 'a section heading'),
	'description.pastTenseSections[]': (v) => match(v, PATTERNS.section, 'a section heading'),
	'description.sensitivePatterns[]': (v) => object(v, { pattern: regex, what: (w) => match(w, PATTERNS.line, 'one line') }),
	'testing.section': (v) => match(v, PATTERNS.section, 'a section heading'),
	'testing.localChecks[]': (v) => object(v, {
		name: (n) => match(n, PATTERNS.line, 'one line'),
		match: regex,
		paths: (p) => list(p, regex),
		why: (w) => (w === '' ? null : match(w, PATTERNS.line, 'one line')),
	}, ['name', 'match']),
	'forbidden.paths[]': regex,
	'forbidden.message': (v) => match(v, PATTERNS.line, 'one line'),
	'merge.method': (v) => oneOf(v, ['squash', 'merge', 'rebase']),
	'merge.status': (v) => match(v, PATTERNS.check, 'a status name'),
	'merge.requiredChecks[]': (v) => match(v, PATTERNS.check, 'a check name'),
	'merge.approvals': (v) => range(v, 1, 10),
	'merge.ciApprovals': (v) => range(v, 1, 10),
	'merge.ciPaths[]': regex,
	'merge.approverAssociations[]': (v) => match(v, PATTERNS.association, 'an author_association'),
	'merge.carryApprovals': (v) => oneOf(v, ['count', 'review', 'off']),
	'rebuild.checkWorkflows[]': (v) => object(v, { file: (f) => match(f, PATTERNS.workflow, 'a workflow file name'), withPr: bool }, ['file']),
	'rebuild.reviewDelayMinutes': (v) => range(v, 0, 99),
	'ruleset.requiredChecks[]': (v) => match(v, PATTERNS.check, 'a check name'),
	'branches.staleDays': (v) => range(v, 1, 3650),
	'branches.keep[]': branch,
	'labels.hold': (v) => match(v, PATTERNS.label, 'a label'),
	'labels.extra[]': (v) => object(v, {
		name: (n) => match(n, PATTERNS.label, 'a label'),
		color: (c) => match(c, PATTERNS.color, 'six hex digits'),
		description: (d) => match(d, /^[^\n\r]{0,100}$/, 'one line'),
	}, ['name']),
	'precommit.scripts[]': (v) => match(v, PATTERNS.script, 'an npm script name'),
	'screenshots.requiredFor[]': regex,
	'screenshots.script': (v) => match(v, PATTERNS.script, 'an npm script name'),
	'screenshots.install': (v) => (v === '' ? null : match(v, PATTERNS.script, 'an npm script name')),
	'screenshots.views[]': (v) => match(v, /^[a-z0-9][a-z0-9-]{0,47}$/, 'a view name: lower case, digits and dashes'),
	'screenshots.branch': branch,
	'screenshots.pruneDays': (v) => range(v, 1, 3650),
	'screenshots.limits': (v) => object(v, {
		views: (n) => range(n, 1, 500),
		pngBytes: (n) => range(n, 1024, 20 * MiB),
		totalBytes: (n) => range(n, 1024, 500 * MiB),
		pixels: (n) => range(n, 1, 8192 * 8192),
	}, ['views', 'pngBytes', 'totalBytes', 'pixels']),
	'pages.include[]': (v) => match(v, PATTERNS.path, 'a path in the repository'),
	'pages.entry': (v) => match(v, PATTERNS.path, 'a path in the repository'),
	'pages.previewDir': (v) => match(v, /^[a-z0-9][a-z0-9-]{0,31}$/, 'a directory name'),
	'pages.previewMeta': (v) => match(v, /^[a-z][a-z0-9-]{0,31}$/, 'a meta tag name'),
	'pages.submodules': (v) => {
		if (!isPlainObject(v)) return 'expected an object of { path: https URL }';
		for (const [p, url] of Object.entries(v)) {
			const bad = match(p, PATTERNS.path, 'a submodule path') || match(url, PATTERNS.url, 'an https:// URL');
			if (bad) return `${p}: ${bad}`;
		}
		return null;
	},
	'stale.days': (v) => range(v, 1, 3650),
	'stale.label': (v) => match(v, PATTERNS.label, 'a label'),
	'stale.exemptLabel': (v) => match(v, PATTERNS.label, 'a label'),
	'localPreviews.remote': (v) => match(v, /^[A-Za-z0-9][\w.-]{0,63}$/, "a remote's name"),
	'localPreviews.port': (v) => range(v, 0, 65535),
	'localPreviews.fetchSeconds': (v) => range(v, 0, 86400),
	'localPreviews.entry': (v) => match(v, /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*$/, 'a file path in the repository'),
	'localPreviews.submodules[]': (v) => match(v, /^(?!.*(^|\/)\.\.?(\/|$))[\w.-]+(\/[\w.-]+)*$/, 'a submodule path, without a trailing slash'),
	'localPreviews.marker': (v) => (v === '' ? null : match(v, /^[a-z][a-z0-9-]{0,31}$/, 'a meta tag name, or "" for none')),
	'localPreviews.types': (v) => {
		if (!isPlainObject(v)) return 'expected an object of { ".ext": "type/subtype" }';
		for (const [ext, type] of Object.entries(v)) {
			const bad = match(ext, /^\.[a-z0-9]{1,10}$/, 'a lower-case file extension with its dot') || match(type, /^[a-z]+\/[\w.+-]+(; ?charset=[\w-]+)?$/i, 'a content type');
			if (bad) return `${ext}: ${bad}`;
		}
		return null;
	},
	'submodules.bumps[]': (v) => object(v, {
		path: (p) => match(p, PATTERNS.path, 'a submodule path'),
		branch,
		title: (t) => match(t, /^[^\n\r"$\\]{1,120}$/, 'one line without double quotes, $ or \\ (use {sha} for the new commit)'),
	}, ['path', 'branch', 'title']),
};

// ---- loading ------------------------------------------------------------------------------------------------------------

const cache = new Map();

/** The config: the file (if any) merged over DEFAULTS, validated. Cached per file. Throws with every problem found. */
export function loadConfig(file = configPath()) {
	if (cache.has(file)) return cache.get(file);
	const raw = fs.existsSync(file) ? parseFile(file) : {};
	const config = resolveConfig(raw, path.relative(process.cwd(), file) || file);
	cache.set(file, config);
	return config;
}

/** `raw` (a parsed file) merged over DEFAULTS and validated; `where` names it in errors. */
export function resolveConfig(raw, where = 'config') {
	const errors = [];
	const merged = mergeOver(DEFAULTS, raw, '', errors);
	for (const [rulePath, rule] of Object.entries(RULES)) checkRule(merged, rulePath, rule, errors);
	crossCheck(merged, errors);
	if (errors.length) throw new Error(`${where}: ${errors.join('; ')}`);
	return deepFreeze(merged);
}

export function configPath() {
	return process.env.PR_AUTOMATION_CONFIG || path.join(ROOT, '.github', 'pr-automation.json');
}

function parseFile(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(`${file}: not valid JSON (${e.message})`);
	}
}

/** `value` over `base`: objects key by key (unknown keys are errors), anything else replaced, with its type checked. */
function mergeOver(base, value, at, errors) {
	if (value === undefined) return clone(base);
	if (isPlainObject(base) && Object.keys(base).length === 0) {
		// a free-form map (pages.submodules): taken as it is; RULES checks it
		return isPlainObject(value) ? clone(value) : (errors.push(`${at}: expected an object`), {});
	}
	if (isPlainObject(base)) {
		if (!isPlainObject(value)) {
			errors.push(`${at || 'the file'}: expected an object`);
			return clone(base);
		}
		const out = {};
		for (const key of Object.keys(value)) {
			if (!(key in base) && !key.startsWith('$')) errors.push(`${join(at, key)}: unknown setting`);
		}
		for (const [key, def] of Object.entries(base)) out[key] = mergeOver(def, value[key], join(at, key), errors);
		return out;
	}
	if (Array.isArray(base)) {
		if (!Array.isArray(value)) errors.push(`${at}: expected a list`);
		return Array.isArray(value) ? clone(value) : clone(base);
	}
	if (typeof value !== typeof base) {
		errors.push(`${at}: expected a ${typeof base}`);
		return base;
	}
	return value;
}

function checkRule(config, rulePath, rule, errors) {
	const each = rulePath.endsWith('[]');
	const keyPath = each ? rulePath.slice(0, -2) : rulePath;
	const value = getPath(config, keyPath);
	const items = each ? (Array.isArray(value) ? value : []) : [value];
	items.forEach((item, i) => {
		const problem = rule(item);
		if (problem) errors.push(`${keyPath}${each ? `[${i}]` : ''}: ${problem}`);
	});
}

/** Rules across fields. */
function crossCheck(c, errors) {
	if (c.merge.ciApprovals < c.merge.approvals) errors.push('merge.ciApprovals: must be at least merge.approvals');
	if (c.branch.pattern === 'prefix' && !c.branch.prefixes.length) errors.push('branch.prefixes: list at least one prefix for pattern "prefix"');
	if (c.branch.pattern === 'regex' && !c.branch.regex) errors.push('branch.regex: set it for pattern "regex"');
	if (c.title.maxTags === 0 && c.title.areas.length) errors.push('title.areas: tags are off (maxTags 0); empty the list');
	if (c.merge.requiredChecks.includes(c.merge.status)) errors.push(`merge.requiredChecks: not the bot's own status (${c.merge.status})`);
	const testedSection = c.testing.section;
	if (c.testing.requireTestedAt && !c.description.requiredSections.includes(testedSection)) {
		errors.push(`description.requiredSections: include "${testedSection}" (testing.requireTestedAt is on)`);
	}
}

// ---- helpers for the rules ------------------------------------------------------------------------------------------------

function branch(v) {
	return match(v, PATTERNS.branch, 'a branch name');
}

function match(v, re, what) {
	return typeof v === 'string' && re.test(v) ? null : `expected ${what}, got ${JSON.stringify(v).slice(0, 60)}`;
}

function oneOf(v, options) {
	return options.includes(v) ? null : `expected one of ${options.join(', ')}`;
}

function range(v, min, max) {
	return Number.isInteger(v) && v >= min && v <= max ? null : `expected a whole number from ${min} to ${max}`;
}

function bool(v) {
	return typeof v === 'boolean' ? null : 'expected true or false';
}

function regex(v) {
	if (typeof v !== 'string' || !v) return 'expected a regular expression';
	try {
		new RegExp(v);
		return null;
	} catch (e) {
		return `not a regular expression (${e.message})`;
	}
}

function list(v, each) {
	if (!Array.isArray(v)) return 'expected a list';
	for (const item of v) {
		const bad = each(item);
		if (bad) return bad;
	}
	return null;
}

/** An object with exactly these fields (`required` ones must be there), each checked. */
function object(v, fields, required = []) {
	if (!isPlainObject(v)) return 'expected an object';
	for (const key of Object.keys(v)) if (!(key in fields)) return `unknown field "${key}"`;
	for (const key of required) if (!(key in v)) return `missing "${key}"`;
	for (const [key, check] of Object.entries(fields)) {
		if (!(key in v)) continue;
		const bad = check(v[key]);
		if (bad) return `${key}: ${bad}`;
	}
	return null;
}

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
	return JSON.parse(JSON.stringify(v));
}

function deepFreeze(v) {
	if (v && typeof v === 'object') {
		for (const child of Object.values(v)) deepFreeze(child);
		Object.freeze(v);
	}
	return v;
}

function join(at, key) {
	return at ? `${at}.${key}` : key;
}

export function getPath(config, dotted) {
	return dotted.split('.').reduce((v, key) => (v == null ? undefined : v[key]), config);
}

// ---- what the config derives -------------------------------------------------------------------------------------------

/**
 * Branches the bot never deletes or rebuilds: the configured ones, and the screenshot branch, which holds images for
 * PR descriptions (pr-<n>/) whether or not the screenshot module is on.
 */
export function keptBranches(config) {
	return new Set([...config.branches.keep, config.screenshots.branch]);
}

/** Branch names pr-policy accepts whatever the pattern: the exempt ones and the submodule bump branches. */
export function exemptBranches(config) {
	return new Set([...config.branch.exempt, ...(config.submodules.enabled ? config.submodules.bumps.map((b) => b.branch) : [])]);
}

/** A ruleset file with the config applied, or null when the config makes it pointless. */
export function renderRuleset(name, config, template) {
	const ruleset = clone(template);
	if (name === 'main') return mainRuleset(ruleset, config);
	if (name === 'branch-names') return branchNamesRuleset(ruleset, config);
	return ruleset;
}

function mainRuleset(ruleset, config) {
	const { method, approvals } = config.merge;
	ruleset.rules = ruleset.rules.flatMap((rule) => {
		if (rule.type === 'required_linear_history' && method === 'merge') return [];
		if (rule.type === 'pull_request') {
			rule.parameters = { ...rule.parameters, required_approving_review_count: approvals, allowed_merge_methods: [method] };
		}
		if (rule.type === 'required_status_checks') {
			if (!config.ruleset.requiredChecks.length) return [];
			rule.parameters = {
				...rule.parameters,
				required_status_checks: config.ruleset.requiredChecks.map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP })),
			};
		}
		return [rule];
	});
	return ruleset;
}

/** Only branches named as the config wants can be created: `<name>/<thing>` or `<prefix>/<thing>`. */
function branchNamesRuleset(ruleset, config) {
	const { pattern, prefixes } = config.branch;
	if (pattern !== 'user' && pattern !== 'prefix') return null;
	const allowed = pattern === 'user' ? ['refs/heads/*/*'] : prefixes.map((p) => `refs/heads/${p}/*`);
	const exempt = [...exemptBranches(config), ...keptBranches(config)].map((b) => `refs/heads/${b}`);
	ruleset.conditions.ref_name.exclude = [...new Set(['~DEFAULT_BRANCH', ...allowed, ...exempt])];
	return ruleset;
}

/** The labels to create: [{ name, color, description }] */
export function labelsOf(config) {
	const labels = [{ name: config.labels.hold, color: 'fbca04', description: 'The PR bot does not merge this PR while it has this label' }];
	if (config.stale.enabled && config.stale.closePrs) {
		labels.push({ name: config.stale.label, color: 'cfd3d7', description: `No activity for ${config.stale.days} days` });
		labels.push({ name: config.stale.exemptLabel, color: '0e8a16', description: 'Never closed as stale' });
	}
	for (const l of config.labels.extra) labels.push({ color: 'ededed', description: '', ...l });
	return labels;
}

// ---- the command line ------------------------------------------------------------------------------------------------

function main() {
	const [command, arg] = process.argv.slice(2);
	let config;
	try {
		config = loadConfig();
	} catch (e) {
		console.error(`error: ${e.message}`);
		process.exit(1);
	}
	if (command === 'check') return printSummary(config);
	if (command === 'get' && arg) return printValue(getPath(config, arg), arg);
	if (command === 'outputs' && arg) return writeOutputs(getPath(config, arg), arg);
	if (command === 'ruleset' && arg) return printRuleset(arg, config);
	if (command === 'labels') return labelsOf(config).forEach((l) => console.log([l.name, l.color, l.description].join('\t')));
	if (command === 'bumps') return (config.submodules.enabled ? config.submodules.bumps : []).forEach((b) => console.log([b.path, b.branch, b.title].join('\t')));
	console.error('usage: node tools/pr-config.mjs check | get <path> | outputs <section> | ruleset <name> | labels | bumps');
	process.exit(2);
}

function printSummary(config) {
	const on = ['postcommit', 'screenshots', 'pages', 'stale', 'submodules'].filter((m) => config[m].enabled);
	console.log(`ok: ${path.relative(process.cwd(), configPath()) || configPath()}${fs.existsSync(configPath()) ? '' : ' (not there: all defaults)'}`);
	console.log(`merging: ${config.merge.method} into ${config.defaultBranch} on ${config.merge.requiredChecks.join(', ')}, ${config.merge.approvals} approval(s), ${config.merge.ciApprovals} for CI changes`);
	console.log(`modules on: ${on.join(', ') || 'none'}`);
}

function printValue(value, at) {
	if (value === undefined) fail(`no setting ${at}`);
	if (Array.isArray(value)) {
		for (const item of value) {
			if (item !== null && typeof item === 'object') fail(`${at}: a list of objects; ask for one field`);
			console.log(String(item));
		}
		return;
	}
	console.log(value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
}

/** A section's strings, numbers and booleans (and lists of them, comma-separated) as step outputs. */
function writeOutputs(section, at) {
	if (!isPlainObject(section)) fail(`${at} is not a section`);
	const lines = [];
	for (const [key, value] of Object.entries(section)) {
		const text = Array.isArray(value) ? (value.every((v) => typeof v !== 'object') ? value.join(',') : null) : typeof value === 'object' ? null : String(value);
		if (text === null) continue;
		if (/[\r\n]/.test(text)) fail(`${at}.${key}: more than one line`);
		lines.push(`${key}=${text}`);
	}
	if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
	else console.log(lines.join('\n'));
}

function printRuleset(name, config) {
	if (!/^[a-z0-9-]+$/.test(name)) fail(`bad ruleset name: ${name}`);
	const file = path.join(ROOT, '.github', 'rulesets', `${name}.json`);
	if (!fs.existsSync(file)) fail(`no ruleset ${file}`);
	console.log(JSON.stringify(renderRuleset(name, config, JSON.parse(fs.readFileSync(file, 'utf8'))), null, '\t'));
}

function fail(message) {
	console.error(`error: ${message}`);
	process.exit(1);
}

// Last, so that everything it uses is declared by then (a `const` below a top-level call isn't yet: test/module-order.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
