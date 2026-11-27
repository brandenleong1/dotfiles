// The PR bot (.github/workflows/pr-bot.yml) merges pull requests; people don't. It reports the `pr-bot` status (the
// name is merge.status in .github/pr-automation.json) on every open PR's head commit, pending with the reason until
// the PR is ready. When it is ready, the bot sets the status to success and merges in the same moment, with the commit
// message docs/pr_guidelines.md asks for (the PR title, a blank line, the PR's URL). The status is never left green,
// so there's no window in which a person could press Merge and type their own message. Drafts and PRs with the hold
// label are left alone.
//
// No code merges unreviewed: an approval holds for the diff it was given on. The bot dismisses any verdict still
// pointing at an older commit, unless that commit makes exactly the same changes (a rebuild, a clean rebase), and asks
// those reviewers to review again.
//
//   node tools/pr-bot.mjs review              set the status on every open PR, and merge the first one that is ready;
//                                             first, if the default branch moved since the bot last did, bring every
//                                             open PR up to date with it (updateAll), as it does right after its merges
//   node tools/pr-bot.mjs update              bring every open PR up to date with its base now, then review
//   node tools/pr-bot.mjs prune-branches      delete branches without an open PR that are merged, or older than
//                                             branches.staleDays (never branches.keep, or the screenshot store)
//   node tools/pr-bot.mjs branches            report every branch: age, PR, ahead/behind, what prune would do
//   add --dry-run to print what it would do
//
// Ready to merge: not a draft, based on the default branch (a stacked PR waits for the one below it), no merge
// conflict, up to date, every check in merge.requiredChecks passed on the head commit, nobody requests changes, every
// requested reviewer (person or team) has responded, and merge.approvals people with write access approved the head
// commit (merge.ciApprovals when the PR changes CI, the rulesets or the PR tools: merge.ciPaths).
//
// Needs GITHUB_TOKEN (contents: write, pull-requests: write, issues: write, statuses: write, checks: read, actions: write)
// and GITHUB_REPOSITORY. Pushes go to GITHUB_SERVER_URL (https://github.com unless set).
import { checkPr } from './check-pr.mjs';
import { loadConfig, keptBranches } from './pr-config.mjs';
import { openRepo } from './restack.mjs';

const CONFIG = loadConfig();
const MAIN = CONFIG.defaultBranch;
const STATUS = CONFIG.merge.status;
const HOLD_LABEL = CONFIG.labels.hold;
const DEPENDS_ON = CONFIG.merge.requiredChecks;
const METHOD = CONFIG.merge.method;
const REBUILD = CONFIG.rebuild.enabled;
// The required checks' workflows, started by the bot on a head it pushed: a push made with the workflow's token starts
// no pull_request workflows. A workflow `withPr` is told which PR to check, and checks that the PR's head is that commit.
const CHECK_WORKFLOWS = CONFIG.rebuild.checkWorkflows;
// After a rebuild, the bot's own workflow runs a review this many minutes later, once those checks have had time to
// finish: their results start no workflow_run (they count as the bot's), and nothing runs on a schedule.
const SELF = 'pr-bot.yml', REVIEW_DELAY_MINUTES = CONFIG.rebuild.reviewDelayMinutes;
const POSTCOMMIT = 'postcommit.yml', PAGES = 'pages.yml';
// A status on the default branch's head once the bot brought the open PRs up to date with it (updateAll), so it does
// that once per commit, whichever run gets there first: a run waiting for its turn is dropped when another one queues.
const UPDATED = `${STATUS}-update`;
const STALE_DAYS = CONFIG.branches.staleDays;
const ASYNC_MERGE_POLLS = 15, ASYNC_MERGE_WAIT_MS = 2000;   // how long to watch an asynchronous merge before retrying next pass
const MOVE_POLLS = 10, MOVE_WAIT_MS = 2000;   // how long to wait for GitHub to move the PRs off a merged branch the bot deleted
const KEEP_BRANCHES = keptBranches(CONFIG);
const BOT = 'github-actions[bot]';
const CAN_APPROVE = new Set(CONFIG.merge.approverAssociations);   // review author_association with write access
// PRs touching these need more approvals: a PR's own workflows run from its files, so it could weaken what checks it
const CI_PATHS = CONFIG.merge.ciPaths.map((re) => new RegExp(re));
const API = 'https://api.github.com';
const REPO = process.env.GITHUB_REPOSITORY;
const GIT_URL = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${REPO}.git`;
const DRY_RUN = process.argv.includes('--dry-run');
const FULL_SHA = /^[0-9a-f]{40}$/;
const PER_HEAD = new Set(['fork', 'hold', 'branch', 'shared', 'ci', 'base-moved']);   // reasons that don't change with the base
const rebuiltHeadsOf = new Map();   // rebuiltHeads, once per PR and head in a run
const changed = { pages: false };   // a merge, push or deletion the bot made, which Pages (if on) should publish

async function main() {
	if (!REPO || !process.env.GITHUB_TOKEN) fail('Set GITHUB_TOKEN and GITHUB_REPOSITORY.');
	const [command] = process.argv.slice(2).filter((a) => a !== '--dry-run');
	await run(command);
	// the bot's merges, pushes and deletions start no push or delete workflows: publish them in one go
	if (changed.pages && CONFIG.pages.enabled) await dispatch(PAGES, { ref: MAIN });
}

async function run(command) {
	if (command === 'review') return reviewAll();
	if (command === 'update') {
		if (!REBUILD) fail('rebuild.enabled is off in .github/pr-automation.json: the bot brings no PR up to date.');
		await updateAll((await github(`/repos/${REPO}/branches/${refPath(MAIN)}`)).commit.sha);
		return reviewAll({ update: false });
	}
	if (command === 'prune-branches') return pruneBranches();
	if (command === 'branches') return reportBranches();
	fail('usage: node tools/pr-bot.mjs review | update | prune-branches | branches [--dry-run]');
}

/**
 * Set the status on every open PR, and merge the first ready one. One merge per pass: it moves the default branch, so
 * every other PR is behind, and the bot brings them up to date before the review right after it sets them back to
 * pending. When the branch moved without the bot (a merge by hand, which runs this through the push), it updates
 * them first.
 */
async function reviewAll({ merge = true, update = merge } = {}) {
	if (update && REBUILD) {
		try {
			const before = (await github(`/repos/${REPO}/branches/${refPath(MAIN)}`)).commit.sha;
			if (!(await updatedTo(before))) await updateAll(before);
		} catch (e) {
			console.log(`could not bring the open PRs up to date with ${MAIN}: ${oneLine(e.message)}`);
		}
	}
	// read after the update, which can take a while: what's up to date is judged against the branch as it is now
	const mainSha = (await github(`/repos/${REPO}/branches/${refPath(MAIN)}`)).commit.sha;
	const pulls = await openPulls();
	for (const pr of pulls) {
		await resetOutdatedReviews(pr);
		const reason = (await notReadyReason(pr, mainSha)) || heldReason(pr, merge);
		if (reason) {
			await setStatus(pr, 'pending', reason);
			continue;
		}
		const mergedSha = await mergeNow(pr);
		if (!mergedSha) continue;
		await afterBotMerge(pr, mergedSha);
		return;
	}
}

/**
 * The bot's own merge doesn't trigger push workflows or close fixed issues (GitHub's rules for its token), so do that
 * work here: close the issues, start postcommit (if on), bring every other open PR up to date (the ones stacked on it
 * still carry its unsquashed commits, and the rest are behind; the ones based on its branch move to the default
 * branch first, by deleting that branch: moveOffMerged), delete the branch if that didn't, and re-check them all.
 */
async function afterBotMerge(pr, mergedSha) {
	changed.pages = true;
	const ownBranch = pr.head.repo?.full_name === REPO;
	await tryTo(`#${pr.number}: close the issues it fixes`, () => closeFixedIssues(pr));
	if (CONFIG.postcommit.enabled) await dispatch(POSTCOMMIT, { ref: MAIN });
	// the PR itself, since right after the merge GitHub may not list it among the closed ones yet
	const merged = { number: pr.number, sha: pr.head.sha, ref: ownBranch ? pr.head.ref : null, mergeCommit: mergedSha };
	if (REBUILD) await tryTo(`bring the open PRs up to date with ${MAIN}`, () => updateAll(mergedSha, { merged }));
	else if (ownBranch) await tryTo(`delete ${pr.head.ref}, #${pr.number}'s branch, for GitHub to move the PRs on it`, () => deleteMergedHead(merged));
	if (ownBranch) await tryTo(`#${pr.number}: delete branch ${pr.head.ref} unless a PR is still based on it`, () => deleteMergedBranch(merged));
	await reviewAll({ merge: false });
}

/** Do one of the steps after a merge; a failure is logged, and the others still happen. Whether it worked. */
async function tryTo(what, run) {
	try {
		await act(what, run);
		return true;
	} catch (e) {
		console.log(`could not ${what.replace(/^#\d+: /, '')}: ${oneLine(e.message)}`);
		return false;
	}
}

/** Start a workflow on `ref` (and `inputs`); whether GitHub took it. A dispatch is the one event the token may start. */
function dispatch(file, { ref, inputs }) {
	const body = inputs ? { ref, inputs } : { ref };
	return tryTo(`run ${file} on ${ref}`, () => github(`/repos/${REPO}/actions/workflows/${file}/dispatches`, 'POST', body));
}

/**
 * Close the issues a merged PR fixes ("Fixes #12" in its description, or linked in its sidebar), with a comment naming
 * the PR. GitHub does this itself when a person merges, but not for a merge made with the workflow's token.
 */
async function closeFixedIssues(pr) {
	const [owner, name] = REPO.split('/');
	const data = await graphql(
		'query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { closingIssuesReferences(first: 25) { nodes { number state repository { nameWithOwner } } } } } }',
		{ owner, name, n: pr.number },
	);
	for (const issue of data?.repository?.pullRequest?.closingIssuesReferences?.nodes || []) {
		if (issue.state !== 'OPEN' || issue.repository?.nameWithOwner !== REPO) continue;
		await act(`#${issue.number}: close it, fixed by #${pr.number}`, async () => {
			await github(`/repos/${REPO}/issues/${issue.number}/comments`, 'POST', { body: `Fixed by #${pr.number}.` });
			await github(`/repos/${REPO}/issues/${issue.number}`, 'PATCH', { state: 'closed', state_reason: 'completed' });
		});
	}
}

function heldReason(pr, merge) {
	if ((pr.labels || []).some((l) => l.name === HOLD_LABEL)) return `Ready, but held: remove the \`${HOLD_LABEL}\` label and the bot merges it`;
	if (!merge) return 'Ready: the bot merges it on its next pass';
	return null;
}

/**
 * Turn the status green and merge at once, pinned to the reviewed head. Returns the merge commit's SHA, or null
 * (with the status set back to pending) when GitHub refuses.
 */
async function mergeNow(pr) {
	if (pr.base?.ref && pr.base.ref !== MAIN) return null;   // notReadyReason holds these; never merge into a side branch
	const title = pr.title.trim();
	const titleErrors = checkPr({ title, author: pr.user?.login || '' }, CONFIG).errors;
	if (titleErrors.length) {
		await setStatus(pr, 'pending', `Title: ${titleErrors[0].replace(/^Title: /, '')}`);
		return null;
	}
	await setStatus(pr, 'success', 'Merging');
	if (DRY_RUN) {
		console.log(`(dry run) #${pr.number}: ${METHOD}-merge "${title}"`);
		return null;
	}
	try {
		const sha = await mergePr(pr, title);
		if (!sha) return null;
		console.log(`#${pr.number}: merged as ${sha.slice(0, 7)}`);
		return sha;
	} catch (e) {
		console.log(`#${pr.number}: merge refused: ${e.message}`);
		await setStatus(pr, 'pending', `GitHub refused the merge; the bot retries: ${e.message.replace(/^\S+ \S+: /, '')}`);
		return null;
	}
}

/**
 * Merge `pr` with merge.method, returning the merge commit's SHA (null if GitHub queued it instead). A squash or merge
 * commit gets the guideline message; a rebase keeps the PR's own commits. GitHub refuses the plain merge endpoint for a
 * PR that has others stacked on it and says to use the asynchronous one, so ask that only then.
 */
async function mergePr(pr, title) {
	const options = { merge_method: METHOD, sha: pr.head.sha, ...(METHOD === 'rebase' ? {} : { commit_title: title, commit_message: pr.html_url }) };
	try {
		return (await github(`/repos/${REPO}/pulls/${pr.number}/merge`, 'PUT', options)).sha;
	} catch (e) {
		if (!/asynchronous merge endpoint/.test(e.message)) throw e;
		return mergeAsync(pr, options);
	}
}

/**
 * The asynchronous merge: submit it, then poll until GitHub says merged, queued or failed (rules are checked then).
 * The answer's uuid, sha and message are in its `details`. The PR itself is polled too, and has the last word: a merge
 * whose result can't be read back may still have happened, and must not be taken for refused.
 */
async function mergeAsync(pr, options) {
	const base = `/repos/${REPO}/pulls/${pr.number}/merge-async`;
	let result = await github(base, 'PUT', { ...options, bypass_rules: false });
	const { uuid } = asyncDetails(result);
	for (let tries = 0; ; tries++) {
		if (result.status === 'merged' && asyncDetails(result).sha) return asyncDetails(result).sha;
		if (result.status === 'enqueued') {
			console.log(`#${pr.number}: added to the merge queue`);
			return null;
		}
		const merged = await mergeCommitOf(pr);
		if (merged) return merged;
		if (result.status === 'failed' || tries >= ASYNC_MERGE_POLLS) break;
		await new Promise((resolve) => setTimeout(resolve, ASYNC_MERGE_WAIT_MS));
		result = (uuid && await github(`${base}/${uuid}`, 'GET', null, [404])) || { status: 'pending' };
	}
	throw new Error(`asynchronous merge ${result.status}: ${asyncDetails(result).message || 'no answer yet; the bot retries'}`);
}

/** The PR's merge commit, if it's merged. */
async function mergeCommitOf(pr) {
	const detail = await github(`/repos/${REPO}/pulls/${pr.number}`);
	return detail.merged ? detail.merge_commit_sha : null;
}

/** An asynchronous merge's answer, with the fields GitHub puts in `details` lifted to the top. */
function asyncDetails(result) {
	return { ...result, ...(result.details || {}) };
}

/** Branches without an open PR: delete them once merged, or after STALE_DAYS without a commit. */
async function pruneBranches() {
	for (const b of await branchReport()) {
		if (b.action === 'keep') continue;
		await act(`delete ${b.name} (${b.action})`, () => deleteBranch(b.name));
	}
}

async function reportBranches() {
	const rows = await branchReport();
	console.log('branch'.padEnd(36), 'age'.padStart(5), 'PR'.padStart(6), 'ahead/behind'.padStart(13), ' prune');
	for (const b of rows) {
		console.log(b.name.padEnd(36), `${b.ageDays}d`.padStart(5), (b.pr ? `#${b.pr}` : '-').padStart(6), `${b.ahead}/${b.behind}`.padStart(13), ` ${b.action}`);
	}
}

// ---- readiness ------------------------------------------------------------------------------------------------------

async function notReadyReason(pr, mainSha) {
	if (pr.draft) return 'Draft';
	const stacked = await stackedReason(pr);
	if (stacked) return stacked;
	const detail = await github(`/repos/${REPO}/pulls/${pr.number}`);
	if (detail.mergeable === false) return `Merge conflict with ${MAIN}`;
	const compare = await github(`/repos/${REPO}/compare/${mainSha}...${pr.head.sha}`);
	if (compare.behind_by > 0) {
		return `${compare.behind_by} commit(s) behind ${MAIN}: ${REBUILD ? `the bot rebuilds it on ${MAIN} after each merge, or comments why it can't` : 'update the branch'}`;
	}
	const unmet = await unmetChecks(pr.head.sha);
	if (unmet.length) return `Waiting for ${unmet.join(', ')}`;
	const verdicts = await currentReviews(pr);
	if (verdicts.some((r) => r.state === 'CHANGES_REQUESTED')) return 'Changes requested';
	const waitingFor = [...(detail.requested_reviewers || []).map((u) => `@${u.login}`), ...(detail.requested_teams || []).map((t) => `team ${t.name}`)];
	if (waitingFor.length) return `Waiting for review from ${waitingFor.join(', ')}`;
	const current = verdicts.some((r) => r.commit_id !== pr.head.sha) ? await rebuiltHeads(pr) : new Set([pr.head.sha]);
	const approvers = verdicts.filter((r) => r.state === 'APPROVED' && current.has(r.commit_id) && CAN_APPROVE.has(r.author_association));
	const ci = await changesCi(pr);
	const needed = ci ? CONFIG.merge.ciApprovals : CONFIG.merge.approvals;
	if (approvers.length >= needed) return null;
	const carried = ci ? [] : await carriedApprovals(pr);
	if (approvers.length + carried.length >= needed) return carryOver(pr, carried.slice(0, needed - approvers.length));
	const has = approvers.length + carried.length;
	return ci
		? `Changes CI or the PR tools: needs ${needed} reviews of the latest commit (has ${has})`
		: needed === 1 ? 'Needs a review of the latest commit' : `Needs ${needed} reviews of the latest commit (has ${has})`;
}

/**
 * Count approvals of a commit with the same changes as the head (merge.carryApprovals): 'count' says so on the PR
 * once per head and counts them; 'review' posts an approval of the head for each (that needs "Allow GitHub Actions to
 * create and approve pull requests", which also lets any workflow approve PRs). Null when they count, else why not.
 */
async function carryOver(pr, carried) {
	if (CONFIG.merge.carryApprovals === 'count') {
		const whose = carried.map((r) => `@${r.user.login}'s approval of ${r.commit_id.slice(0, 7)}`).join(' and ');
		await commentOnce(pr, `carried ${pr.head.sha} ${carried.map((r) => r.id).join(',')}`,
			`The PR bot counts ${whose} for this head, \`${pr.head.sha.slice(0, 7)}\`: it makes exactly the same changes to \`${pr.base.ref}\`, only its parent commits differ.`);
		return null;
	}
	try {
		for (const r of carried) await postCarriedApproval(pr, r);
	} catch (e) {   // e.g. Actions isn't allowed to approve pull requests: report it on this PR, keep going with the others
		return `Could not post the carried-over approval; ask for a review instead: ${e.message.replace(/^\S+ \S+: /, '')}`;
	}
	return null;
}

/**
 * A PR based on another branch than the default one (a stacked PR) waits. Merging it would merge it into that branch.
 * Once the PR below it merges, the bot deletes that branch, and GitHub moves this PR to the default branch
 * (moveOffMerged).
 */
async function stackedReason(pr) {
	const base = pr.base?.ref;
	if (!base || base === MAIN) return null;
	const below = (await openPulls()).find((p) => p.head?.ref === base && p.head?.repo?.full_name === REPO);
	return below
		? `Stacked on #${below.number}: waits for it to merge, then moves to ${MAIN}`
		: `Based on ${base}, not ${MAIN}: change the base branch to ${MAIN}`;
}

async function changesCi(pr) {
	for (let page = 1; ; page++) {
		const files = await github(`/repos/${REPO}/pulls/${pr.number}/files?per_page=100&page=${page}`);
		if (files.some((f) => CI_PATHS.some((re) => re.test(f.filename) || (f.previous_filename && re.test(f.previous_filename))))) return true;
		if (files.length < 100) return false;
	}
}

/** Each reviewer's latest standing verdict (approve / request changes); comments and dismissed reviews don't count. */
async function currentReviews(pr) {
	const latest = new Map();
	for (const r of await github(`/repos/${REPO}/pulls/${pr.number}/reviews?per_page=100`)) {
		if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') latest.set(r.user.login, r);
		if (r.state === 'DISMISSED') latest.delete(r.user.login);
	}
	return [...latest.values()];
}

/**
 * Verdicts given on an older head: dismiss them and ask those reviewers to look again. Not the ones that carry over:
 * on a head the bot rebuilt with the same changes (rebuiltHeads), or by carriedApprovals' comparison.
 */
async function resetOutdatedReviews(pr) {
	const older = (await currentReviews(pr)).filter((r) => r.commit_id !== pr.head.sha && r.user.login !== BOT);
	if (!older.length) return;
	const current = await rebuiltHeads(pr);
	const notRebuilt = older.filter((r) => !current.has(r.commit_id));
	if (!notRebuilt.length) return;
	const carried = new Set((await carriedApprovals(pr)).map((r) => r.id));
	const outdated = notRebuilt.filter((r) => !carried.has(r.id));
	for (const r of outdated) {
		await act(`#${pr.number}: dismiss ${r.user.login}'s ${r.state.toLowerCase()} review (on ${r.commit_id.slice(0, 7)})`, () =>
			github(`/repos/${REPO}/pulls/${pr.number}/reviews/${r.id}/dismissals`, 'PUT', {
				event: 'DISMISS',
				message: `New commits since this review (now at ${pr.head.sha.slice(0, 7)}). Please review again.`,
			}));
	}
	const reviewers = [...new Set(outdated.map((r) => r.user.login))].filter((login) => login !== pr.user?.login);
	if (reviewers.length) {
		await act(`#${pr.number}: re-request ${reviewers.join(', ')}`, () => github(`/repos/${REPO}/pulls/${pr.number}/requested_reviewers`, 'POST', { reviewers }));
	}
}

/**
 * Approvals of an older commit that still hold: each person's latest review is an approval (standing, or dismissed
 * by a push) of a commit that makes the same changes to the base as the head does, from someone with write access
 * other than the PR's author. Never for a PR that changes CI, which needs reviews of what it really is, and never
 * when merge.carryApprovals is 'off'.
 */
async function carriedApprovals(pr) {
	if (CONFIG.merge.carryApprovals === 'off' || await changesCi(pr)) return [];
	const dismissedApprovals = new Set((await github(`/repos/${REPO}/issues/${pr.number}/timeline?per_page=100`))
		.filter((e) => e.event === 'review_dismissed' && e.dismissed_review?.state === 'approved')
		.map((e) => e.dismissed_review.review_id));
	const latest = new Map();
	for (const r of await github(`/repos/${REPO}/pulls/${pr.number}/reviews?per_page=100`)) {
		if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(r.user.login, r);
	}
	const candidates = [...latest.values()].filter((r) => r.user.login !== BOT && r.user.login !== pr.user?.login
		&& CAN_APPROVE.has(r.author_association) && r.commit_id !== pr.head.sha
		&& (r.state === 'APPROVED' || (r.state === 'DISMISSED' && dismissedApprovals.has(r.id))));
	const carried = [];
	for (const r of candidates) {
		if (await sameChanges(pr, r.commit_id)) carried.push(r);
	}
	return carried;
}

/** True when `oldSha` and the PR's head make the same changes to the base (the same files, the same lines changed). */
async function sameChanges(pr, oldSha) {
	const [before, after] = await Promise.all([changesOf(pr.base.ref, oldSha), changesOf(pr.base.ref, pr.head.sha)]);
	return before !== null && after !== null && before === after;
}

/**
 * What `sha` changes against the base as one comparable string, or null when it can't be told (too big, or gone). The
 * patch with its context lines, which place each change; not the hunks' line numbers, which move with the base.
 */
async function changesOf(base, sha) {
	const compare = await github(`/repos/${REPO}/compare/${base}...${sha}`, 'GET', null, [404, 422]);
	const files = compare?.files;
	if (!files || files.length >= 300 || files.some((f) => f.patch === undefined && f.changes > 0)) return null;
	// hunk headers hold line numbers, which move with the base; the lines themselves don't
	return JSON.stringify(files.map((f) => [f.filename, f.previous_filename || '', f.status, (f.patch || '').replace(/^@@[^\n]*$/gm, '@@')]).sort());
}

/** Post an approval of the head that says whose approval it carries, once per head and reviewer. */
async function postCarriedApproval(pr, carried) {
	const reviews = await github(`/repos/${REPO}/pulls/${pr.number}/reviews?per_page=100`);
	const marker = `@${carried.user.login}'s approval`;
	if (reviews.some((r) => r.user.login === BOT && r.state === 'APPROVED' && r.commit_id === pr.head.sha && (r.body || '').includes(marker))) return;
	await act(`#${pr.number}: carry over @${carried.user.login}'s approval of ${carried.commit_id.slice(0, 7)}`, () =>
		github(`/repos/${REPO}/pulls/${pr.number}/reviews`, 'POST', {
			commit_id: pr.head.sha,
			event: 'APPROVE',
			body: `Carrying over ${marker} of ${carried.commit_id.slice(0, 7)}: ${pr.head.sha.slice(0, 7)} makes exactly the same changes to \`${pr.base.ref}\`, only its parent commits differ.`,
		}));
}

/**
 * The PR's head, and the heads it had before the bot rebuilt it (one after another) with exactly the same changes: a
 * verdict on any of them is a verdict on the head. GitHub doesn't move reviews to a new head when no ruleset is
 * enforced, so the bot follows its own force-pushes in the PR's timeline back from the head. A push by anyone else
 * ends the chain: its changes need a new review (or carriedApprovals' comparison).
 */
async function rebuiltHeads(pr) {
	const key = `${pr.number}:${pr.head.sha}`;
	if (rebuiltHeadsOf.has(key)) return rebuiltHeadsOf.get(key);
	const [owner, name] = REPO.split('/');
	const data = await graphql(
		'query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { timelineItems(itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT], last: 100) { nodes { ... on HeadRefForcePushedEvent { actor { login } beforeCommit { oid } afterCommit { oid } } } } } } }',
		{ owner, name, n: pr.number },
	);
	const byBot = (data?.repository?.pullRequest?.timelineItems?.nodes || []).filter((e) => /^github-actions(\[bot\])?$/.test(e.actor?.login || ''));
	const heads = new Set([pr.head.sha]);
	let at = pr.head.sha;
	for (;;) {
		const before = byBot.find((e) => e.afterCommit?.oid === at)?.beforeCommit?.oid;
		if (!before || heads.has(before)) break;
		heads.add(before);
		at = before;
	}
	rebuiltHeadsOf.set(key, heads);
	return heads;
}

/** Checks the bot depends on without a success on `sha`, from check runs (workflows) or commit statuses. */
async function unmetChecks(sha) {
	const runs = (await github(`/repos/${REPO}/commits/${sha}/check-runs?per_page=100`)).check_runs;
	const statuses = (await github(`/repos/${REPO}/commits/${sha}/status`)).statuses;
	const passed = new Set([
		...runs.filter((r) => r.conclusion === 'success').map((r) => r.name),
		...statuses.filter((s) => s.state === 'success').map((s) => s.context),
	]);
	return DEPENDS_ON.filter((name) => !passed.has(name));
}

/** Only writes when the status changes, so the PR's timeline doesn't fill up with repeats. */
async function setStatus(pr, state, description) {
	const current = (await github(`/repos/${REPO}/commits/${pr.head.sha}/status`)).statuses.find((s) => s.context === STATUS);
	if (current && current.state === state && current.description === description) return;
	await act(`#${pr.number} ${pr.head.sha.slice(0, 7)}: ${state} (${description})`, () => github(`/repos/${REPO}/statuses/${pr.head.sha}`, 'POST', {
		state,
		context: STATUS,
		description: description.slice(0, 140),
	}));
}

// ---- branches -------------------------------------------------------------------------------------------------------

/** Every branch but the default one: { name, ageDays, pr, ahead, behind, action: 'keep' | 'merged' | 'stale' } */
async function branchReport() {
	const prByBranch = new Map((await openPulls()).filter((p) => p.head.repo?.full_name === REPO).map((p) => [p.head.ref, p.number]));
	const rows = [];
	for (const branch of await github(`/repos/${REPO}/branches?per_page=100`)) {
		if (branch.name === MAIN || KEEP_BRANCHES.has(branch.name)) continue;
		const commit = await github(`/repos/${REPO}/commits/${branch.commit.sha}`);
		const ageDays = Math.floor((Date.now() - Date.parse(commit.commit.committer.date)) / 86400000);
		// 404: no history in common with the default branch (a hand-made orphan branch); judged by age alone
		const compare = (await github(`/repos/${REPO}/compare/${refPath(MAIN)}...${branch.commit.sha}`, 'GET', null, [404])) || { ahead_by: -1, behind_by: -1 };
		const pr = prByBranch.get(branch.name) || null;
		const merged = !pr && (compare.ahead_by === 0 || (await mergedAsIs(branch)));
		const action = pr ? 'keep' : merged ? 'merged' : ageDays >= STALE_DAYS ? 'stale' : 'keep';
		rows.push({ name: branch.name, ageDays, pr, ahead: compare.ahead_by, behind: compare.behind_by, action });
	}
	return rows;
}

/**
 * Whether a PR merged this branch exactly as it is now (a squash merge leaves the branch "ahead"). A branch with
 * commits pushed after its PR merged isn't counted: that's new work.
 */
async function mergedAsIs(branch) {
	const owner = REPO.split('/')[0];
	const pulls = await github(`/repos/${REPO}/pulls?state=closed&head=${encodeURIComponent(`${owner}:${branch.name}`)}&per_page=10`);
	return pulls.some((p) => p.merged_at && p.head.sha === branch.commit.sha);
}

/**
 * Delete a branch when pruning. It may be no merged PR's head, and GitHub closes the open PRs based on such a branch
 * when it's deleted (it moves them only for a merged PR's head branch: moveOffMerged), so they move to the default
 * branch first. If GitHub won't move one (a PR in a stack: "part of a stack"), it throws before deleting the branch.
 */
async function deleteBranch(name) {
	for (const pr of await github(`/repos/${REPO}/pulls?state=open&base=${encodeURIComponent(name)}&per_page=100`)) {
		await act(`#${pr.number}: change its base from ${name} to ${MAIN}`, () => github(`/repos/${REPO}/pulls/${pr.number}`, 'PATCH', { base: MAIN }));
	}
	return deleteRef(name);
}

/**
 * Delete a merged PR's branch, once no open PR is based on it (moveOffMerged moves those first), and only while it's
 * still at the PR's head: a branch with commits since it merged is new work.
 */
async function deleteMergedBranch({ number, sha, ref }) {
	const tip = await branchTip(ref);
	if (!tip) return;
	if (tip !== sha) return console.log(`#${number}: kept ${ref}: it has commits since #${number} merged it`);
	const based = await github(`/repos/${REPO}/pulls?state=open&base=${encodeURIComponent(ref)}&per_page=100`);
	if (based.length) return console.log(`#${number}: kept ${ref}: ${based.map((p) => `#${p.number}`).join(', ')} still based on it`);
	await deleteRef(ref);
}

/** With rebuild.enabled off: delete a merged PR's branch while it's at the merged head; GitHub moves the PRs on it. */
async function deleteMergedHead({ number, sha, ref }) {
	const tip = await branchTip(ref);
	if (!tip) return;
	if (tip !== sha) return console.log(`#${number}: kept ${ref}: it has commits since #${number} merged it`);
	await deleteRef(ref);
}

/** Delete a branch; one that's gone already is fine. Never the default branch or a kept one. */
async function deleteRef(name) {
	if (name === MAIN || KEEP_BRANCHES.has(name)) throw new Error(`the bot never deletes ${name}`);
	await github(`/repos/${REPO}/git/refs/heads/${refPath(name)}`, 'DELETE', null, [404, 422]);
	changed.pages = true;
}

/** A branch's head commit, or null when there's no such branch. */
async function branchTip(name) {
	return (await github(`/repos/${REPO}/branches/${refPath(name)}`, 'GET', null, [404]))?.commit?.sha || null;
}

/** A branch name as a URL path, each part encoded (a name may hold `;` or `#`). */
function refPath(name) {
	return name.split('/').map(encodeURIComponent).join('/');
}

// ---- keeping PRs up to date ------------------------------------------------------------------------------------------

/**
 * Bring every open PR up to date with its base: after any merge (the bot's own, or one made by hand, which runs the
 * bot through the push), and on demand (`update`). Each PR that's behind its base is rebuilt on it, bottom up through
 * stacks: its own commits are replayed onto the default branch, or onto the rebuilt PR below it, and it must then
 * make exactly the same changes as before, so its approvals stand, and so do the results in its Testing section
 * (pr-policy compares the commit those were for with the new head: tools/same-changes.mjs). It's pushed with a lease
 * on its old head and gets its checks started, and the bot reviews again a few minutes later. A PR the bot can't or
 * mustn't rebuild is left as it was, with a comment saying why (once), and so is everything above it. The commits are
 * only data: see tools/restack.mjs. Last, a status on the branch's head says it's done. Returns the PRs it pushed.
 */
async function updateAll(mainSha, { merged = null } = {}) {
	const merges = await recentMerges(merged);
	// right after a merge GitHub may still list the merged PR as open
	const pulls = (await openPulls()).filter((p) => !merges.some((m) => m.number === p.number));
	const run = { mainSha, merges, cause: merges.find((m) => m.mergeCommit === mainSha) || null, repo: null, pushed: [], failed: false };
	try {
		for (const node of await updateRoots(pulls, run)) await updateSafely(run, node, null);
	} finally {
		run.repo?.close();
	}
	if (run.pushed.length) await dispatch(SELF, { ref: MAIN, inputs: { run: 'review', delay: String(REVIEW_DELAY_MINUTES) } });
	// not after a failure that may pass (git or the API failing, a push that lost its lease): the next review tries again
	if (run.failed) {
		console.log(`${MAIN} ${mainSha.slice(0, 7)}: not every open PR could be brought up to date; the next review tries again`);
		return run.pushed;
	}
	await tryTo(`${MAIN} ${mainSha.slice(0, 7)}: the open PRs are up to date with it`, () => github(`/repos/${REPO}/statuses/${mainSha}`, 'POST', {
		state: 'success',
		context: UPDATED,
		description: `The PR bot brought the open PRs up to date with this commit (${run.pushed.length} rebuilt)`,
	}));
	return run.pushed;
}

/** Whether the bot already brought the open PRs up to date with the default branch at `sha` (updateAll's status). */
async function updatedTo(sha) {
	const { statuses } = await github(`/repos/${REPO}/commits/${sha}/status`);
	return statuses.some((s) => s.context === UPDATED && s.state === 'success');
}

/**
 * PRs merged into the default branch lately, newest first: [{ number, sha (its head), ref (its branch, if in this
 * repository), mergeCommit }]. `merged`, the one the bot just merged, comes first.
 */
async function recentMerges(merged) {
	const closed = await github(`/repos/${REPO}/pulls?state=closed&base=${encodeURIComponent(MAIN)}&sort=updated&direction=desc&per_page=30`);
	const list = closed.filter((p) => p.merged_at && p.number !== merged?.number)
		.sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))
		.map((p) => ({ number: p.number, sha: p.head?.sha, ref: p.head?.repo?.full_name === REPO ? p.head.ref : null, mergeCommit: p.merge_commit_sha }));
	return merged ? [merged, ...list] : list;
}

/**
 * The open PRs based on the default branch, each with the PRs stacked on it: [{ pr, above, sharedWith }] (stackOn).
 * The PRs still based on the branch of a PR that merged (the bot's merge, or one by hand that kept the branch) move to
 * the default branch first, by deleting that branch (moveOffMerged). The ones that don't are left, with a comment:
 * rebuilt while still based on that branch, their diff would change.
 */
async function updateRoots(pulls, run) {
	const ownHead = (ref) => pulls.some((p) => p.head?.ref === ref && p.head?.repo?.full_name === REPO);
	const onMerged = new Map();   // a merged PR's branch: the open PRs based on it
	for (const pr of pulls) {
		const base = pr.base?.ref;
		if (base === MAIN || ownHead(base) || !run.merges.some((m) => m.ref === base)) continue;
		onMerged.set(base, [...(onMerged.get(base) || []), pr]);
	}
	const moved = new Map();   // number: the PR as read back, now on the default branch
	for (const [ref, children] of onMerged) {
		const merged = run.merges.find((m) => m.ref === ref);
		for (const pr of await moveOffMerged(merged, children, { pulls, run })) moved.set(pr.number, pr);
	}
	return pulls.filter((p) => p.base?.ref === MAIN || moved.has(p.number)).map((p) => nodeOf(moved.get(p.number) || p, pulls));
}

/**
 * Move the open PRs based on a merged PR's branch to the default branch by deleting that branch: GitHub then moves
 * each of them to the merged PR's base itself, as it does whenever a merged PR's head branch is deleted. Changing their
 * base instead fails for a PR with others stacked on it ("part of a stack"). Only a branch still at the merged PR's
 * head is deleted: moved, the PRs would take any commits since in, unreviewed. Each PR is read back and must be open
 * and on the default branch before it's rebuilt; the ones that aren't go to putBack. Returns the PRs moved.
 */
async function moveOffMerged(merged, children, { pulls, run }) {
	const onto = { below: null, oldBase: merged.sha, newBase: run.mainSha, cause: run.cause };
	const leave = async (why, kind) => {
		for (const pr of children) await leaveAsIs(nodeOf(pr, pulls), onto, { why, kind });
		return [];
	};
	const tip = await branchTip(merged.ref);
	if (tip && tip !== merged.sha) return leave(`its base, \`${safeName(merged.ref)}\`, has new commits since #${merged.number} merged it`, 'base-moved');
	const list = children.map((p) => `#${p.number}`).join(', ');
	if (DRY_RUN) {
		console.log(`(dry run) delete ${merged.ref}, #${merged.number}'s branch: GitHub moves ${list} to ${MAIN}`);
		return children.map((p) => ({ ...p, base: { ...p.base, ref: MAIN } }));
	}
	if (!(await tryTo(`delete ${merged.ref}, #${merged.number}'s branch, for GitHub to move ${list} to ${MAIN}`, () => deleteRef(merged.ref)))) {
		run.failed = true;
		return leave(`the bot couldn't delete #${merged.number}'s branch, which moves it to \`${MAIN}\` (the PR bot's run log says why)`, 'not-moved');
	}
	const after = await readBack(merged, children, run);
	if (!after) return [];
	const onMain = after.filter((p) => p.state === 'open' && p.base?.ref === MAIN);
	// still on the deleted branch, open or closed (GitHub closes a PR as it was); not one that merged meanwhile
	const stuck = after.filter((p) => !p.merged && p.base?.ref === merged.ref);
	return stuck.length ? [...onMain, ...await putBack(merged, stuck, { pulls, run, onto })] : onMain;
}

/**
 * The PRs that were on the merged PR's branch, as GitHub has them once it's done with its deletion (afterDelete). Null
 * when they can't be read: then the branch is put back for them, and the next review looks again.
 */
async function readBack(merged, children, run) {
	try {
		return await afterDelete(children, merged.ref);
	} catch (e) {
		console.log(`could not read back ${children.map((p) => `#${p.number}`).join(', ')}: ${oneLine(e.message)}`);
		run.failed = true;
		if (!(await branchTip(merged.ref))) await tryTo(`put ${merged.ref} back at ${merged.sha.slice(0, 7)}`, () => restoreRef(merged));
		return null;
	}
}

/** The PRs, read again until none is still open on the deleted branch `ref` (GitHub takes a moment), or MOVE_POLLS reads. */
async function afterDelete(children, ref) {
	for (let tries = 1; ; tries++) {
		const now = [];
		for (const pr of children) now.push(await github(`/repos/${REPO}/pulls/${pr.number}`));
		if (tries >= MOVE_POLLS || !now.some((p) => p.state === 'open' && p.base?.ref === ref)) return now;
		await new Promise((resolve) => setTimeout(resolve, MOVE_WAIT_MS));
	}
}

/**
 * GitHub didn't move these PRs when the bot deleted the merged PR's branch: it closed them (as it can when a branch
 * is deleted right after the merge), or left them on it. Put the branch back at the merged PR's head, reopen the ones
 * it closed, and change their base (GitHub refuses that for a PR in a stack). Then delete the branch again if nothing
 * is left on it. A PR that still isn't moved is left as it was, with the PRs above it, and says why. Returns the PRs
 * it moved.
 */
async function putBack(merged, stuck, { pulls, run, onto }) {
	const restored = (await branchTip(merged.ref)) === merged.sha
		|| await tryTo(`put ${merged.ref} back at ${merged.sha.slice(0, 7)}`, () => restoreRef(merged));
	if (!restored) run.failed = true;   // the PRs still open on it are read again by the next review, which tries again
	const moved = [];
	for (const pr of stuck) {
		const why = restored ? await reopenOnMain(pr, merged) : notPutBack(pr, merged);
		if (why) await leaveAsIs(nodeOf(pr, pulls), onto, { why, kind: 'not-moved' });
		else moved.push({ ...pr, state: 'open', base: { ...pr.base, ref: MAIN } });
	}
	if (restored && moved.length === stuck.length) await tryTo(`delete ${merged.ref} again, now that no PR is based on it`, () => deleteMergedBranch(merged));
	return moved;
}

/** With the merged PR's branch back: reopen `pr` if GitHub closed it, and change its base. Why not, or null. */
async function reopenOnMain(pr, merged) {
	const closed = pr.state !== 'open', putBackAt = `the bot put the branch back at \`${merged.sha.slice(0, 7)}\``;
	if (closed && !(await tryTo(`#${pr.number}: reopen it`, () => github(`/repos/${REPO}/pulls/${pr.number}`, 'PATCH', { state: 'open' })))) {
		return `${notMoved(pr, merged)}; ${putBackAt}, but couldn't reopen this PR: reopen it, then ${moveByHand(merged)}`;
	}
	if (await tryTo(`#${pr.number}: change its base from ${merged.ref} to ${MAIN}`, () => github(`/repos/${REPO}/pulls/${pr.number}`, 'PATCH', { base: MAIN }))) return null;
	return `${notMoved(pr, merged)}; ${putBackAt}${closed ? ' and reopened this PR' : ''}, but GitHub wouldn't let it change the base to \`${MAIN}\` either (the PR bot's run log says why): ${moveByHand(merged)}`;
}

function notPutBack(pr, merged) {
	return `${notMoved(pr, merged)}, and the bot couldn't put the branch back: push \`${merged.sha}\` back to it${pr.state !== 'open' ? ', reopen this PR' : ''}, then ${moveByHand(merged)}`;
}

function notMoved(pr, merged) {
	return `when the bot deleted #${merged.number}'s branch, \`${safeName(merged.ref)}\`, GitHub ${pr.state !== 'open' ? 'closed this PR' : `didn't move it to \`${MAIN}\``}`;
}

function moveByHand(merged) {
	return `change its base to \`${MAIN}\`, or delete \`${safeName(merged.ref)}\` yourself`;
}

/** Put a merged PR's deleted branch back at its head. */
function restoreRef({ ref, sha }) {
	return github(`/repos/${REPO}/git/refs`, 'POST', { ref: `refs/heads/${ref}`, sha });
}

/**
 * The open PRs based on `branch`, each with the ones based on its own branch: [{ pr, above: [...], sharedWith }].
 * `sharedWith`: another open PR with the same head branch, which a rebuild would change too.
 */
function stackOn(branch, pulls, seen = new Set([branch])) {
	return pulls.filter((p) => p.base?.ref === branch).map((p) => nodeOf(p, pulls, seen));
}

function nodeOf(pr, pulls, seen = new Set()) {
	const own = pr.head?.repo?.full_name === REPO && !seen.has(pr.head.ref);
	if (own) seen.add(pr.head.ref);
	const sharedWith = pulls.find((o) => o.number !== pr.number && o.head?.ref === pr.head?.ref && o.head?.repo?.full_name === pr.head?.repo?.full_name);
	return { pr, above: own ? stackOn(pr.head.ref, pulls, seen) : [], sharedWith };
}

/** updateNode, where a failure (the API's, say) leaves this PR and those above it for the next update. */
async function updateSafely(run, node, below) {
	try {
		await updateNode(run, node, below);
	} catch (e) {
		run.failed = true;
		console.log(`#${node.pr.number}: could not bring it up to date: ${oneLine(e.message)}`);
	}
}

/**
 * Bring one PR up to date, then the PRs stacked on it. `below` is the PR it's based on: { pr, oldHead, newHead } when
 * the bot just rebuilt that one (from oldHead to newHead), { pr } when it didn't need to, and null for the default
 * branch. Its own commits start at that old head, or else where it left its base (with the merge base as GitHub's
 * compare finds it, or the head of a PR it was stacked on that has merged since: mergedBase).
 */
async function updateNode(run, node, below) {
	const { pr, above } = node;
	const newBase = below ? below.newHead || below.pr.head.sha : run.mainSha;
	let oldBase = below?.oldHead || null;
	if (!oldBase) {
		const compare = await github(`/repos/${REPO}/compare/${newBase}...${pr.head.sha}`, 'GET', null, [404]);
		if (!compare?.merge_base_commit) return console.log(`#${pr.number}: no history in common with ${newBase.slice(0, 7)}`);
		if (!compare.behind_by) {   // up to date: on to the ones above it
			for (const next of above) await updateSafely(run, next, { pr });
			return;
		}
		oldBase = compare.merge_base_commit.sha;
	}
	const onto = { below: below?.pr || null, rebuiltBelow: !!below?.oldHead, oldBase, newBase, cause: run.cause };
	if (!below) {   // also for a PR it won't rebuild: the command it's told to run starts there too
		try {
			onto.oldBase = mergedBase(gitFor(run, [pr.head.sha]), pr.head.sha, run) || oldBase;
		} catch (e) {
			console.log(`#${pr.number}: fetching it failed: ${oneLine(e.message)}`);
		}
	}
	const outcome = skipReason(node) || rebuiltBranch(run, pr, onto);
	if (outcome.retry) {   // git failed: no comment for what may pass; the next update tries again
		run.failed = true;
		return;
	}
	if (outcome.why) return leaveAsIs(node, onto, outcome);
	console.log(`${DRY_RUN ? '(dry run) ' : ''}#${pr.number}: push ${pr.head.ref} ${pr.head.sha.slice(0, 7)} -> ${outcome.head.slice(0, 7)} (rebuilt on ${newBase.slice(0, 7)})`);
	if (DRY_RUN) return;
	const pushed = pushRebuilt(run.repo, pr, outcome.head);
	if (pushed.status === 'moved') {
		// someone pushed meanwhile, or GitHub showed an old head: never over it, and the next update looks again
		console.log(`#${pr.number}: its branch moved while the bot rebuilt it; left as it is`);
		run.failed = true;
		return;
	}
	if (pushed.status !== 'pushed') return leaveAsIs(node, onto, { why: pushReason(pushed), kind: 'refused' });
	changed.pages = true;
	const unstarted = await startChecks(pr);
	await comment(pr, rebuiltMessage(onto, outcome, { unstarted }));
	run.pushed.push({ number: pr.number, sha: outcome.head });
	for (const next of above) await updateSafely(run, next, { pr, oldHead: pr.head.sha, newHead: outcome.head });
}

/** Why the bot must not rebuild a stack node's PR at all, as { why, kind }, or null. */
function skipReason({ pr, sharedWith }) {
	if (pr.head.repo?.full_name !== REPO) return { why: "it comes from a fork, and the bot can only push to this repository's branches", kind: 'fork' };
	if ((pr.labels || []).some((l) => l.name === HOLD_LABEL)) return { why: `it's labelled \`${HOLD_LABEL}\``, kind: 'hold' };
	if (pr.head.ref === MAIN || KEEP_BRANCHES.has(pr.head.ref)) return { why: `its branch is \`${safeName(pr.head.ref)}\``, kind: 'branch' };
	if (sharedWith) return { why: `its branch is also the head of #${sharedWith.number}, which a rebuild would change too`, kind: 'shared' };
	return null;
}

/** `pr`'s branch rebuilt onto `onto.newBase` (not pushed yet): { head, commits }, or { why, kind? } not. */
function rebuiltBranch(run, pr, onto) {
	try {
		const repo = gitFor(run, [pr.head.sha, onto.newBase]);
		const { oldBase, newBase } = onto;
		const ci = repo.changedFiles(oldBase, pr.head.sha).find((f) => CI_PATHS.some((re) => re.test(f)));
		if (ci) return { why: `it changes CI or the PR tools (\`${safeName(ci)}\`), and the bot never rebuilds those`, kind: 'ci' };
		const result = repo.rebuild({ oldBase, oldHead: pr.head.sha, newBase });
		// its checks will run from the branch's own workflow files: they must be the default branch's
		if (result.status === 'rebuilt' && !repo.sameTree(result.head, run.mainSha, '.github')) return { why: `its \`.github\` isn't \`${MAIN}\`'s`, kind: 'github' };
		return result.status === 'rebuilt' ? result : { why: rebuildProblem(result, onto), kind: result.status };
	} catch (e) {
		console.log(`#${pr.number}: rebuilding it failed: ${oneLine(e.message)}`);
		return { retry: true };
	}
}

/** The run's repository (tools/restack.mjs), opened with the default branch in it the first time, and `shas` fetched. */
function gitFor(run, shas) {
	if (!run.repo) {
		const repo = openRepo({ url: GIT_URL, token: process.env.GITHUB_TOKEN });
		try {
			repo.fetch([run.mainSha]);
		} catch (e) {
			repo.close();
			throw e;
		}
		run.repo = repo;
	}
	const missing = shas.filter((sha) => !run.repo.has(sha));
	if (missing.length) run.repo.fetch(missing);
	return run.repo;
}

/**
 * For a PR on the default branch: the head of a merged PR that its branch is built on, if any. It was stacked on that
 * PR, and GitHub moved it when that branch was deleted; its own commits start there, since the ones below arrived as
 * that PR's squashed (or rebased) commits. The newest such head, if it has all the others.
 */
function mergedBase(repo, head, run) {
	const found = run.merges.filter((m) => FULL_SHA.test(String(m.sha || '')) && repo.has(m.sha)
		&& repo.isAncestor(m.sha, head) && !repo.isAncestor(m.sha, run.mainSha)
		// not once the PR merged the default branch in after that merge: then where it left it is later
		&& !(FULL_SHA.test(String(m.mergeCommit || '')) && repo.has(m.mergeCommit) && repo.isAncestor(m.mergeCommit, head)))
		.map((m) => m.sha);
	return found.find((sha) => found.every((other) => other === sha || repo.isAncestor(other, sha))) || null;
}

function rebuildProblem(result, { oldBase, below }) {
	const under = below ? `#${below.number}` : `\`${MAIN}\``;
	switch (result.status) {
		case 'not-on-base': return `it isn't built on ${under}'s last commit, \`${oldBase.slice(0, 7)}\` (that branch changed after this one was made)`;
		case 'empty': return `it has no commits of its own on top of ${under}`;
		case 'too-many': return `it has ${result.commits} commits of its own, more than the bot replays`;
		case 'conflict': return `replaying its commit \`${result.commit.slice(0, 7)}\` conflicts in ${result.files.slice(0, 5).map((f) => `\`${safeName(f)}\``).join(', ')}${result.files.length > 5 ? ', …' : ''}`;
		case 'different': return 'replayed, it would no longer make exactly the same changes, so a person should look';
		default: return `the rebuild ended with "${result.status}"`;
	}
}

/** Push `head` to `pr`'s branch with a lease on the head the bot rebuilt from. */
function pushRebuilt(repo, pr, head) {
	try {
		return repo.push({ branch: pr.head.ref, head, lease: pr.head.sha });
	} catch (e) {
		console.log(`#${pr.number}: pushing it failed: ${oneLine(e.message)}`);
		return { status: 'refused', message: 'git failed while pushing' };
	}
}

function pushReason(pushed) {
	return `GitHub refused the push (${safeName(pushed.message || '')})`;
}

/**
 * Leave `node`'s PR (and the ones above it) as they are, and say why on it, with what to do by hand. Once, since every
 * update would say it again: a reason that comes from the PR itself (a fork, hold, CI, a shared branch) once per head,
 * any other (a conflict, ...) once per head and base.
 */
async function leaveAsIs({ pr, above }, onto, { why, kind }) {
	const target = onto.below ? onto.below.head.ref : MAIN;
	const stacked = flatten(above).map((p) => `#${p.number}`);
	// a branch named like an option (`--exec=…`) would be one to git: then the command rebases the branch checked out
	const branch = pr.head.ref.startsWith('-') ? '' : ` ${shellWord(pr.head.ref)}`;
	console.log(`#${pr.number}: not rebuilt: ${why}`);
	await commentOnce(pr, `left ${pr.head.sha} ${kind}${PER_HEAD.has(kind) ? '' : ` on ${onto.newBase}`}`, [
		`The PR bot didn't rebuild this PR on ${newBaseName(onto)}${afterMerge(onto)}: ${why}. It left the branch as it was, `
		+ `so this PR needs rebuilding by hand: replay its own commits onto \`${safeName(target)}\`, then push with `
		+ '`--force-with-lease`. For example:',
		'',
		'```sh',
		`git fetch origin && git rebase --onto ${shellWord(`origin/${target}`)} ${onto.oldBase}${branch}`,
		'```',
		...(stacked.length ? ['', `The PRs stacked on this one were left too (${stacked.join(', ')}): rebuild them on top of it.`] : []),
	].join('\n'));
}

function rebuiltMessage(onto, { head, commits }, { unstarted }) {
	const checks = unstarted.length
		? `The bot couldn't start ${unstarted.join(' and ')} on the new head, \`${head.slice(0, 7)}\`: push to the branch, or `
			+ 'ask a maintainer to run them on it (Actions → Run workflow).'
		: `The checks were started on the new head, \`${head.slice(0, 7)}\`.`;
	return [
		`The PR bot rebuilt this PR on ${newBaseName(onto)}${afterMerge(onto)}, to keep it up to date: it replayed the PR's `
		+ `${commits === 1 ? 'commit' : `${commits} commits`} onto \`${onto.newBase.slice(0, 7)}\`, and the PR makes exactly the `
		+ 'same changes as before. So its approvals stand, and so do the results in its Testing section if they were for '
		+ `these changes: \`pr-policy\` compares the commit its "Tested at" names with the new head. ${checks}`,
		'',
		'If you have this branch checked out, update it before you push to it again: `git pull --rebase`.',
	].join('\n');
}

/**
 * Start the required checks on `pr`'s new head; the workflows it couldn't start. The bot's push starts no pull_request
 * workflows (GitHub's rule for the workflow's token), but a dispatch always runs, on the branch's head. Its workflow
 * files are the default branch's (rebuiltBranch).
 */
async function startChecks(pr) {
	const unstarted = [];
	for (const { file, withPr } of CHECK_WORKFLOWS) {
		const inputs = withPr ? { pr: String(pr.number) } : undefined;
		if (!await dispatch(file, { ref: pr.head.ref, inputs })) unstarted.push(`\`${file}\``);
	}
	return unstarted;
}

async function comment(pr, body) {
	try {
		await act(`#${pr.number}: comment`, () => github(`/repos/${REPO}/issues/${pr.number}/comments`, 'POST', { body }));
	} catch (e) {
		console.log(`#${pr.number}: could not comment: ${oneLine(e.message)}`);
	}
}

/** Comment, unless the bot's comments on `pr` already have this `key` (in a hidden line at the end). */
async function commentOnce(pr, key, body) {
	const marker = `<!-- pr-bot: ${key} -->`;
	try {
		for (let page = 1; ; page++) {
			const comments = await github(`/repos/${REPO}/issues/${pr.number}/comments?per_page=100&page=${page}`);
			if (comments.some((c) => c.user?.login === BOT && (c.body || '').includes(marker))) return console.log(`#${pr.number}: said so already`);
			if (comments.length < 100) break;
		}
	} catch (e) {
		console.log(`#${pr.number}: could not read its comments: ${oneLine(e.message)}`);
	}
	await comment(pr, `${body}\n\n${marker}`);
}

/** What a PR is rebuilt on: the default branch, or the PR below it. */
function newBaseName({ below, rebuiltBelow }) {
	if (!below) return `\`${MAIN}\``;
	return rebuiltBelow ? `#${below.number} (which it rebuilt too)` : `#${below.number}`;
}

function afterMerge({ cause }) {
	return cause ? ` after #${cause.number} merged` : '';
}

function flatten(nodes) {
	return nodes.flatMap(({ pr, above }) => [pr, ...flatten(above)]);
}

/** `text` as one shell word (branch names may hold `;`, `$` or `|`, and people paste the command). */
function shellWord(text) {
	return /^[\w./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

/** A file name or message from a PR branch, safe to quote in a comment: no markup, mentions or links. */
function safeName(text) {
	return text.replace(/[^\w./ ()-]/g, '?').slice(0, 120);
}

/** Text as one log line: a line starting with `::` would be a workflow command in the Actions log. */
function oneLine(text) {
	return String(text).replace(/\s+/g, ' ');
}

// ---- GitHub API -----------------------------------------------------------------------------------------------------

function openPulls() {
	return github(`/repos/${REPO}/pulls?state=open&per_page=100`);
}

/** A REST call; `okMissing` lists statuses that mean "already done" (e.g. a branch that's already gone). */
async function github(path, method = 'GET', body = null, okMissing = []) {
	const res = await fetch(API + path, {
		method,
		headers: {
			authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
			accept: 'application/vnd.github+json',
			'x-github-api-version': '2022-11-28',
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (okMissing.includes(res.status)) return null;
	if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
	const text = res.status === 204 ? '' : await res.text();   // some answers (e.g. a dispatch) have no body
	return text ? JSON.parse(text) : null;
}

/** A GraphQL query (for what REST doesn't offer, e.g. the issues a PR closes); returns its data. */
async function graphql(query, variables) {
	const out = await github('/graphql', 'POST', { query, variables });
	if (out?.errors?.length) throw new Error(`GraphQL: ${out.errors.map((e) => e.message).join('; ')}`);
	return out?.data;
}

async function act(what, run) {
	console.log(DRY_RUN ? `(dry run) ${what}` : what);
	if (!DRY_RUN) await run();
}

function fail(message) {
	console.error(message);
	process.exit(2);
}

// Last, so that everything it uses is declared by then (a `const` below a top-level call isn't yet: test/module-order.mjs).
await main();
