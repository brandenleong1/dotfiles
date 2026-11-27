// Checks a pull request or a commit message against docs/pr_guidelines.md, with the rules .github/pr-automation.json
// sets (tools/pr-config.mjs): the title's tags and qualifiers, the branch name, the description's sections, the local
// checks the Testing section reports, screenshots for the paths that need them, and files no PR may add.
//
//   node tools/check-pr.mjs                                    PR from the environment (PR_TITLE, PR_BODY, PR_AUTHOR,
//                                                              PR_BRANCH, PR_HEAD_SHA, PR_FILES one per line, and
//                                                              PR_TESTED_CHANGES from tools/same-changes.mjs; CI)
//   gh pr view 12 --json title,body,author,headRefName,headRefOid,files | node tools/check-pr.mjs --json
//   node tools/check-pr.mjs --title "[Docs] Feature: Add a Style Guide"
//   node tools/check-pr.mjs --branch alice/docs [--author alice]
//   git log -1 --format=%B | node tools/check-pr.mjs --commit  a merged commit: title, blank line, PR URL
//
// Errors fail (exit 1); warnings and notes are printed only. In GitHub Actions they show up as annotations.
//
// "Tested at <sha>" may name another commit than the head, if it makes the same changes (a clean rebase or update,
// the PR bot's too). pr-policy compares them with git and sets PR_TESTED_CHANGES; run by hand, without it, this has no
// git to compare with, so it takes the line at its word and only warns.
import { pathToFileURL } from 'node:url';
import { loadConfig, exemptBranches } from './pr-config.mjs';

/**
 * Book-title case: articles, conjunctions, and prepositions are lower case, unless they're the first or last word;
 * every other word is capitalised. Words that are often adverbs or the particle of a phrasal verb ("Set Up", "Turn
 * On", "Wait Until") may be either.
 */
const LOWER_WORDS = new Set(['a', 'an', 'the', 'and', 'but', 'or', 'nor', 'for', 'as', 'at', 'by', 'from', 'into', 'of',
	'onto', 'per', 'to', 'upon', 'via', 'vs', 'with', 'within', 'without', 'about', 'above', 'across', 'against', 'along',
	'among', 'behind', 'below', 'beneath', 'beside', 'between', 'beyond', 'during', 'except', 'inside', 'near', 'outside',
	'past', 'than', 'throughout', 'toward', 'towards', 'under']);
const EITHER_WORDS = new Set(['up', 'down', 'out', 'off', 'over', 'in', 'on', 'through', 'around', 'so', 'yet', 'after',
	'before', 'since', 'until', 'till']);
const quoteList = (ws) => ws.slice(0, 3).map((w) => `"${w}"`).join(', ') + (ws.length > 3 ? ', …' : '');
const USER_BRANCH = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([a-z0-9][a-z0-9._-]*)$/;
const TESTED_AT = /\bTested at:? +`?([0-9a-f]{7,40})\b/i;
// a result: a count that passed or failed ("45 passed, 0 failed", "30 of 30 suites passed"), or "skipped: <why>"
const CHECK_RESULT = /\b\d+\b[^\n]{0,40}?\b(passed|failed|pass|fail)\b|\bskipped: *\S/i;
const IMAGE = /!\[[^\]]*\]\([^)\s]+[^)]*\)|<img\b/i;
const BOT_COMMENT = /\bsee the screenshots comment\b/i;
const PAST_TENSE = /^(\w+ed|Ran|Made|Wrote|Built|Kept|Split|Set|Put|Cut|Left|Took|Gave|Found|Brought|Rewrote|Undid|Bumped)$/;
const NOT_IMPERATIVE = /^(Added|Adds|Fixed|Fixes|Changed|Changes|Removed|Removes|Moved|Moves|Updated|Updates|Renamed|Improved|Improves|Refactored|Implemented|Created|Deleted|Replaced|Made|Makes|Used|Uses)$/;
const SENSITIVE = [
	[/\/home\/(?!<)[\w.-]+\//, 'a personal path (/home/<name>/...)'],
	[/\/Users\/(?!<)[\w.-]+\//, 'a personal path (/Users/<name>/...)'],
	[/[A-Za-z]:\\Users\\(?!<)[\w.-]+/, 'a personal path (C:\\Users\\<name>)'],
	[/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
	[/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];

async function main() {
	const args = process.argv.slice(2);
	const config = loadConfig();
	const report = args.includes('--commit') ? checkCommit(await readStdin(), config) : checkPr(await readPr(args), config);
	for (const n of report.notes || []) annotate('notice', n);
	for (const w of report.warnings) annotate('warning', w);
	for (const e of report.errors) annotate('error', e);
	if (!report.errors.length) console.log(`ok${report.warnings.length ? ` (${report.warnings.length} warning(s))` : ''}`);
	process.exit(report.errors.length ? 1 : 0);
}

/**
 * A pull request: { title, body, author, branch, headSha, files, testedChanges } -> { errors, warnings, notes }.
 * Omitted fields aren't checked: `headSha` (the PR's head commit) asks the description for the local check results of
 * that head, and `files` (the paths it adds or changes) for screenshots when it changes the paths that need them, and
 * for no forbidden files. `testedChanges` is pr-policy's verdict on a "Tested at" that isn't the head
 * (tools/same-changes.mjs, e.g. "3f9c2e1 same"); without it that line is taken at its word, with a warning.
 */
export function checkPr({ title = null, body = null, author = '', branch = null, headSha = null, files = null, testedChanges = null }, config = loadConfig()) {
	const report = { errors: [], warnings: [], notes: [] };
	if (title != null) checkTitle(title, report, config);
	if (body != null) checkBody(body, report, { headSha, files, testedChanges }, config);
	if (branch != null) checkBranch(branch, author, report, config);
	if (files) checkForbidden(files, report, config);
	return report;
}

/**
 * A merged commit: the PR title, a blank line, then the PR's URL and nothing else (as the PR bot writes it). For a
 * rebase merge there's no such commit: the PR's own commits land as they are, so this isn't asked.
 */
export function checkCommit(message, config = loadConfig(), { serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com', repo = process.env.GITHUB_REPOSITORY || '' } = {}) {
	const report = { errors: [], warnings: [], notes: [] };
	const [subject, blank, ...rest] = message.replace(/\s+$/, '').split('\n');
	if (/ \(#\d+\)$/.test(subject)) report.errors.push('Commit: drop the " (#N)" GitHub appends to the title; the PR\'s URL goes in the body.');
	checkTitle(subject.replace(/ \(#\d+\)$/, ''), report, config);
	const body = rest.join('\n').trim();
	if (blank !== undefined && blank.trim() !== '') report.errors.push('Commit: leave a blank line after the title.');
	const where = repo ? escapeRe(`${serverUrl}/${repo}`) : `${escapeRe(serverUrl)}/[\\w.-]+/[\\w.-]+`;
	if (!new RegExp(`^${where}/pull/\\d+$`).test(body)) {
		report.errors.push(`Commit: the body must be only the PR's URL (${repo ? `${serverUrl}/${repo}` : `${serverUrl}/<owner>/<repo>`}/pull/<n>). Merge with tools/merge-pr.sh.`);
	}
	return report;
}

/** The branch name, as `branch.pattern` asks: `<username>/<short-name>`, `<prefix>/<short-name>`, a regex, or any. */
function checkBranch(branch, author, report, config) {
	const { pattern, prefixes, regex } = config.branch;
	if (pattern === 'any' || exemptBranches(config).has(branch)) return;
	if (pattern === 'regex') {
		if (!new RegExp(regex).test(branch)) report.errors.push(`Branch: "${branch}" should match ${regex}.`);
		return;
	}
	if (pattern === 'prefix') {
		const m = USER_BRANCH.exec(branch);
		if (!m || !prefixes.includes(m[1])) report.errors.push(`Branch: "${branch}" should be <${prefixes.join('|')}>/<short-name>, lowercase (e.g. ${prefixes[0]}/docs).`);
		return;
	}
	const m = USER_BRANCH.exec(branch);
	const expected = `${author || '<username>'}/<short-name>, lowercase (e.g. ${author || 'alice'}/docs)`;
	if (!m) {
		report.errors.push(`Branch: "${branch}" should be ${expected}.`);
		return;
	}
	if (author && m[1].toLowerCase() !== author.toLowerCase()) report.errors.push(`Branch: "${branch}" should start with your username: ${expected}.`);
}

/** The title format the config describes: `[Area][Sub-area] Qualifier: Title Case Summary`, or the parts it keeps. */
function titleFormat({ maxTags, qualifiers }) {
	const tags = maxTags === 0 ? '' : maxTags === 1 ? '[Area] ' : '[Area][Sub-area] ';
	return `${tags}${qualifiers.length ? 'Qualifier: ' : ''}Title Case Summary`;
}

function checkTitle(title, report, config) {
	const rules = config.title;
	const t = title.trim();
	if (t.length > rules.maxLength) report.errors.push(`Title: ${t.length} characters; keep it to ${rules.maxLength}.`);
	const tagPart = rules.maxTags ? `((?:\\[[^\\]]+\\]){1,${rules.maxTags}}) ` : '()';
	const qualifierPart = rules.qualifiers.length ? '(\\w+): ' : '()';
	const m = new RegExp(`^${tagPart}${qualifierPart}(.+)$`).exec(t);
	if (!m) {
		report.errors.push(`Title: use "${titleFormat(rules)}", e.g. "${rules.example}".`);
		return;
	}
	const [, tags, qualifier, summary] = m;
	if (rules.maxTags) checkTags(tags, report, rules);
	if (rules.qualifiers.length && !rules.qualifiers.includes(qualifier)) {
		report.errors.push(`Title: unknown qualifier "${qualifier}:"; use one of ${rules.qualifiers.map((q) => `${q}:`).join(' ')}.`);
	}
	checkSummary(summary, report, rules);
}

/** The summary's words that break book-title case: { capitalise: [...], lower: [...] } */
export function titleCaseProblems(words) {
	const capitalise = [], lower = [];
	words.forEach((word, i) => {
		const bare = word.replace(/^[^A-Za-z0-9]+/, '').split('-')[0].replace(/[^A-Za-z0-9']+$/, '');
		if (!/^[A-Za-z]/.test(bare)) return;   // numbers, symbols, code
		const key = bare.toLowerCase();
		const edge = i === 0 || i === words.length - 1;
		const isLower = /^[a-z]/.test(bare);
		if (edge || (!LOWER_WORDS.has(key) && !EITHER_WORDS.has(key))) {
			if (isLower) capitalise.push(bare);
		} else if (LOWER_WORDS.has(key) && !isLower) {
			lower.push(bare);
		}
	});
	return { capitalise, lower };
}

/** `[Area]` from the configured list (any capitalised word when the list is empty), then an optional `[Sub-area]`. */
function checkTags(tags, report, { areas }) {
	const [area, ...subs] = tags.slice(1, -1).split('][');
	if (areas.length ? !areas.includes(area) : !/^[A-Z][A-Za-z0-9]*$/.test(area)) {
		report.errors.push(areas.length
			? `Title: unknown area "[${area}]"; use one of ${areas.map((a) => `[${a}]`).join(' ')}.`
			: `Title: area "[${area}]" should be one capitalised word.`);
	}
	for (const sub of subs) {
		if (!/^[A-Z][A-Za-z0-9]*$/.test(sub)) report.errors.push(`Title: sub-area "[${sub}]" should be one capitalised word.`);
	}
}

function checkSummary(summary, report, rules) {
	const words = summary.replace(/`[^`]*`/g, 'Code').split(/\s+/);
	if (rules.imperative && NOT_IMPERATIVE.test(words[0])) report.errors.push(`Title: say what the change does, imperative ("${imperativeOf(words[0])}", not "${words[0]}").`);
	if (rules.titleCase) {
		const { capitalise, lower } = titleCaseProblems(words);
		if (capitalise.length) report.errors.push(`Title: capitalise ${quoteList(capitalise)}; in Title Case every word starts with a capital except articles, conjunctions, and prepositions.`);
		if (lower.length) report.errors.push(`Title: write ${quoteList(lower)} in lower case; articles, conjunctions, and prepositions are lower case unless they're the first or last word.`);
	}
	if (/[.!]$/.test(summary)) report.errors.push('Title: no full stop at the end.');
}

function checkBody(body, report, { headSha, files, testedChanges }, config) {
	const text = withoutComments(body);
	const sensitive = [...SENSITIVE, ...config.description.sensitivePatterns.map(({ pattern, what }) => [new RegExp(pattern), what])];
	for (const [pattern, what] of sensitive) if (pattern.test(text)) report.errors.push(`Description: contains ${what}. Descriptions stay with the history; remove it.`);
	const sections = sectionsOf(text);
	for (const name of config.description.requiredSections) {
		const content = (sections.get(name) || '').replace(/^\s*-\s*$/gm, '').trim();
		if (!content) report.errors.push(`Description: fill in the "## ${name}" section.`);
	}
	for (const name of config.description.pastTenseSections) checkBullets(name, sections.get(name) || '', report);
	const testing = sections.get(config.testing.section) || '';
	if (headSha) checkTested(testing, headSha, testedChanges, report, files, config);
	if (files) checkScreenshots(sections.get('Screenshots') || '', files, report, config);
}

/** No PR adds a file `forbidden.paths` matches (credentials, by default). */
function checkForbidden(files, report, config) {
	const patterns = config.forbidden.paths.map((p) => new RegExp(p, 'i'));
	const found = files.filter((f) => patterns.some((re) => re.test(f)));
	if (!found.length) return;
	report.errors.push(`Files: ${found.slice(0, 3).map((f) => `\`${f}\``).join(', ')}${found.length > 3 ? ', …' : ''} ${config.forbidden.message}`);
}

/**
 * The Testing section holds the author's local run for the PR's current head: "Tested at <sha>" (7+ characters of a
 * commit), and a result for each of `testing.localChecks` (a check with `paths` only when the PR changes one of them).
 * The commit is the head, or one that makes the same changes (checkSameChanges): a push with other changes fails this
 * until the section is updated.
 */
function checkTested(testing, headSha, testedChanges, report, files, config) {
	const section = config.testing.section;
	if (config.testing.requireTestedAt) {
		const sha = TESTED_AT.exec(testing)?.[1]?.toLowerCase();
		const head = headSha.toLowerCase();
		if (!sha) {
			report.errors.push(`Description: the ${section} section needs a "Tested at ${head.slice(0, 7)}" line: run the checks locally on this head (docs/pr_guidelines.md#testing).`);
		} else if (!head.startsWith(sha)) {
			checkSameChanges(sha, head, testedChanges, report);
		}
	}
	const items = testingItems(testing);
	for (const { name, match, paths = [], why = '' } of config.testing.localChecks) {
		const pathRes = paths.map((p) => new RegExp(p));
		if (pathRes.length && !(files && files.some((f) => pathRes.some((re) => re.test(f))))) continue;
		const mentioned = new RegExp(match);
		if (!items.some((item) => mentioned.test(item) && CHECK_RESULT.test(item))) {
			report.errors.push(`Description: the ${section} section needs ${name} with its result${why ? ` (${why})` : ''}, e.g. "45 passed, 0 failed" or "skipped: <why>".`);
		}
	}
}

/**
 * "Tested at" names another commit than the head. Its results hold for the head if it makes the same changes: after
 * a clean rebase, "Update branch", or the PR bot bringing the PR up to date. pr-policy compares the two with git
 * (tools/same-changes.mjs) and passes its verdict, "<sha> <verdict>", as `testedChanges`. Without one (run by hand)
 * the line is taken at its word.
 */
function checkSameChanges(sha, head, testedChanges, report) {
	const notHead = `"Tested at ${sha}" isn't this PR's head (${head.slice(0, 7)})`;
	if (testedChanges == null) {
		report.warnings.push(`Description: ${notHead}. pr-policy passes it only if ${sha} makes the same changes as the head; if it doesn't, run the checks on the head and update the Testing section.`);
		return;
	}
	// its last line: the verdict (anything before it, e.g. a workflow command, isn't)
	const [named, verdict] = (String(testedChanges).trim().split('\n').pop() || '').trim().split(/\s+/);
	if (named === sha && verdict === 'same') {
		report.notes.push(`Tested at ${sha}, which makes the same changes as this head (${head.slice(0, 7)}).`);
	} else if (named === sha && verdict === 'different') {
		report.errors.push(`Description: ${notHead}, and it makes different changes: run the checks on the new head, then update the Testing section.`);
	} else if (named === sha && verdict === 'unfetchable') {
		report.errors.push(`Description: ${notHead}, and GitHub has no commit ${sha} to compare it with: push the tested commit, or re-test this head and update the Testing section.`);
	} else if (named === sha && verdict === 'ambiguous') {
		report.errors.push(`Description: "Tested at ${sha}" matches more than one commit: give more of its SHA.`);
	} else {
		report.errors.push(`Description: ${notHead}, and pr-policy couldn't compare their changes (its run log says why): re-run it, or re-test this head and update the Testing section.`);
	}
}

/** The commit a description's Testing section names ("Tested at <sha>", lower case), or null. */
export function testedSha(body, config = loadConfig()) {
	return TESTED_AT.exec(sectionsOf(withoutComments(body || '')).get(config.testing.section) || '')?.[1]?.toLowerCase() || null;
}

function withoutComments(body) {
	return body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r/g, '');
}

/** The section's bullets (with their wrapped lines) and paragraphs, each as one string. */
function testingItems(content) {
	const items = [];
	for (const line of content.split('\n')) {
		if (!line.trim()) items.push('');
		else if (/^\s*[-*] /.test(line) || !items.length || items[items.length - 1] === '') items.push(line);
		else items[items.length - 1] += ` ${line.trim()}`;
	}
	return items.filter(Boolean);
}

/**
 * A PR that changes how the project looks shows it: when it changes a path `screenshots.requiredFor` matches, a
 * "## Screenshots" section with at least one image, or, with the screenshot module on, "See the Screenshots comment".
 */
function checkScreenshots(section, files, report, config) {
	const paths = config.screenshots.requiredFor.map((p) => new RegExp(p));
	const changed = files.find((f) => paths.some((re) => re.test(f)));
	if (!changed || IMAGE.test(section) || (config.screenshots.enabled && BOT_COMMENT.test(section))) return;
	const alternative = config.screenshots.enabled ? ', or write "See the Screenshots comment"' : '';
	report.errors.push(`Description: this PR changes how it looks (\`${changed}\`), so add a "## Screenshots" section with at least one image${alternative}: drag it into the editor, or push it to ${config.screenshots.branch} and link it (docs/pr_guidelines.md#screenshots).`);
}

/** Bullets in the past-tense sections start with a past-tense verb (Added, Fixed, Ran...). A style warning, not an error. */
function checkBullets(name, content, report) {
	for (const line of content.split('\n')) {
		const m = /^- +(\S+)/.exec(line);
		if (m && !PAST_TENSE.test(m[1].replace(/[^\w]/g, ''))) report.warnings.push(`Description: ${name} bullets should start with a past-tense verb ("${line.trim().slice(0, 50)}").`);
	}
}

function sectionsOf(text) {
	const sections = new Map();
	let current = null;
	for (const line of text.split('\n')) {
		const h = /^##\s+(.+?)\s*$/.exec(line);
		if (h) { current = h[1]; sections.set(current, ''); continue; }
		if (current) sections.set(current, sections.get(current) + line + '\n');
	}
	return sections;
}

function imperativeOf(word) {
	return word.replace(/ied$/, 'y').replace(/(ed|es|s)$/, '').replace(/^Mad$/, 'Make').replace(/^Us$/, 'Use');
}

function escapeRe(text) {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

async function readPr(args) {
	if (args.includes('--json')) {
		const pr = JSON.parse(await readStdin());
		return { title: pr.title, body: pr.body ?? '', author: pr.author?.login || '', branch: pr.headRefName ?? null,
			headSha: pr.headRefOid ?? null, files: pr.files ? pr.files.map((f) => f.path) : null };
	}
	const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] || '' : null);
	if (option('--title') != null || option('--branch') != null) {
		return { title: option('--title'), branch: option('--branch'), author: option('--author') || '' };
	}
	const env = process.env;
	return {
		title: env.PR_TITLE || '', body: env.PR_BODY ?? '', author: env.PR_AUTHOR || '', branch: env.PR_BRANCH ?? null,
		headSha: env.PR_HEAD_SHA || null, files: env.PR_FILES != null ? env.PR_FILES.split('\n').map((f) => f.trim()).filter(Boolean) : null,
		testedChanges: env.PR_TESTED_CHANGES ?? null,   // set in CI, even when the comparison failed: then it fails closed
	};
}

function readStdin() {
	return new Promise((resolve) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (d) => { data += d; });
		process.stdin.on('end', () => resolve(data));
	});
}

/** One annotation line. PR text in it is flattened to one line, so it can't start a workflow command of its own. */
function annotate(level, message) {
	const text = String(message).replace(/[\r\n]+/g, ' ');
	console.log(process.env.GITHUB_ACTIONS ? `::${level}::${text}` : `${level}: ${text}`);
}

// Last, so that everything it uses is declared by then (a `const` below a top-level call isn't yet: test/module-order.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
