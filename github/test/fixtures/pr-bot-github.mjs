// A fake GitHub API for test/pr-bot.mjs, loaded with `node --import` before tools/pr-bot.mjs. The scene is in the
// PR_BOT_SCENE environment variable (JSON). It prints each write the bot makes, one JSON line per call, for the test
// to read.
//
// { prs: [{ number, base, ref, approved, labels?, files?, fixes?, hasStack?, asyncLost?, carry? }], branches?, failDelete?, checks? }:
// every PR up to date with main, with green checks (`checks`, the names that passed: precommit and pr-policy unless
// given). `carry: 'same' | 'different'`: bob approved an older commit (`old<number>`)
// and a push dismissed it; that commit's changes to main are the head's ('same') or not ('different'). An asynchronous
// merge happens when its result is polled; `asyncLost`: the result can't be read back, but the PR did merge.
// `branches`: the repository's branches, for pruning (a commit named `stale-…` is years old); `failDelete`: a branch
// GitHub won't delete.
//
// With `git` (a bare repository standing in for the repo's branches) and `state` (a JSON file kept across runs, so a
// test can run several passes, and change things between them, such as a merge made by hand): { git, state, race?,
// fail?, prs: [{ number, base, ref, approved, body?, hasStack?, fork?, labels?, apiHead? }] }. Heads, diffs, conflicts
// and merges come from the repository: a merge squashes the PR onto main in it. As in a private repository on GitHub
// Free, nothing protects `main`: a push leaves reviews where they were, on their old commit. Each push to a PR's
// branch is in its timeline as a force-push by github-actions. The checks pass on the scene's first heads, and on a
// head that precommit.yml and pr-policy.yml were dispatched on; pr-policy only if tools/check-pr.mjs passes the PR's
// description for that head, with its files and tools/same-changes.mjs's verdict on its "Tested at" (which fetches
// from the repository), as the workflow checks it. Comments and the bot's `pr-bot-update` statuses are kept. `race`:
// a commit main moves to just before the next merge. `apiHead`: the API still reports this head after someone pushed
// to the branch. A force-push to a PR's base branch is in its timeline too, as GitHub has it (with git, that's a push
// the fake saw: one made after a call to it). `fail: ['retarget' | 'dispatch' | 'restore']`: GitHub refuses changing
// a PR's base, dispatching a workflow, or creating a branch.
//
// As GitHub does now, it refuses changing the base of a PR that others are based on (422 "part of a stack"). When
// a branch is deleted, it moves the open PRs based on it to the base of the merged PR whose head the branch was, and
// closes them when no merged PR had it (each printed for the test); `onDelete: 'close' | 'leave'` closes them, or
// leaves them on the deleted branch, even then. A deleted branch can be created again, and a closed PR reopened while
// its base exists.
//
// Time is the fake's too: a timer fires at once and moves the clock on, so the bot's waits take no real time.
import fs from 'node:fs';
import { checkPr } from '../../tools/check-pr.mjs';
import { git, gitStatus, changes } from './git-repos.mjs';

const scene = JSON.parse(process.env.PR_BOT_SCENE);
const REPO = 'o/r';
const BOT = 'github-actions[bot]';
const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const missing = () => ({ ok: false, status: 404, text: async () => '{"message":"Not Found"}' });
const unprocessable = (message) => ({ ok: false, status: 422, text: async () => JSON.stringify({ message }) });
const refused = (message) => ({ ok: false, status: 403, text: async () => JSON.stringify({ message }) });
const logWrite = (method, path, body) => console.log(JSON.stringify({ method, path, body: body ? JSON.parse(body) : null }));

globalThis.fetch = scene.git ? gitFetch : sceneFetch;
let clock = Date.now();
const realSetTimeout = globalThis.setTimeout;
Date.now = () => clock;
globalThis.setTimeout = (fn, ms = 0, ...args) => {
	clock += ms;
	return realSetTimeout(fn, 0, ...args);
};

const pulls = scene.prs.map((p) => ({
	number: p.number,
	title: `[Docs] Fix: Thing ${p.number}`,
	labels: (p.labels || []).map((name) => ({ name })),
	draft: false,
	user: { login: 'alice' },
	html_url: `https://github.com/${REPO}/pull/${p.number}`,
	head: { sha: `h${p.number}`, ref: p.ref, repo: { full_name: REPO } },
	base: { ref: p.base },
}));
const postedReviews = [];   // reviews the bot posted: later reads list them
const sceneComments = {};   // comments the bot posted, by PR: later reads list them
const asyncMerged = new Set();
const byNumber = (p) => scene.prs.find((x) => String(x.number) === p);

async function sceneFetch(url, { method = 'GET', body } = {}) {
	const path = new URL(url).pathname;
	let m;
	if (path === '/graphql') return graphqlAnswer(body, () => [], () => []);
	if (method !== 'GET') {
		logWrite(method, path, body);
		if (method === 'DELETE' && path.endsWith(`/heads/${scene.failDelete}`)) return refused('Cannot delete branch');
		if ((m = path.match(/\/issues\/(\d+)\/comments$/))) (sceneComments[m[1]] ||= []).push({ user: { login: BOT }, body: JSON.parse(body).body });
		if (/\/pulls\/\d+\/reviews$/.test(path)) postedReviews.push({ id: 8, user: { login: BOT }, state: 'APPROVED', commit_id: JSON.parse(body).commit_id, body: JSON.parse(body).body, author_association: 'NONE' });
		if ((m = path.match(/\/pulls\/(\d+)\/merge$/))) {   // a PR with others stacked on it: GitHub wants the asynchronous endpoint
			if (byNumber(m[1]).hasStack) return refused('Merging stacked PRs via this endpoint is not supported. Use the asynchronous merge endpoint instead.');
			return ok({ sha: 'merged', merged: true });
		}
		if ((m = path.match(/\/pulls\/(\d+)\/merge-async$/))) {   // the answer's fields are in `details`, as GitHub documents
			if (byNumber(m[1]).asyncLost) asyncMerged.add(+m[1]);
			return ok({ status: 'pending', details: { uuid: 'u1', message: 'Merge request accepted', expected_head_sha: JSON.parse(body).sha } });
		}
		return ok({});
	}
	if ((m = path.match(/\/pulls\/(\d+)\/merge-async\/u1$/))) {   // merged once polled (or lost: merged, but no answer)
		if (byNumber(m[1]).asyncLost) return missing();
		asyncMerged.add(+m[1]);
		return ok({ status: 'merged', details: { message: 'Merged', sha: 'asyncmerged' } });
	}
	if (path === `/repos/${REPO}/branches/main`) return ok({ commit: { sha: 'm0' } });
	if (path === `/repos/${REPO}/branches`) return ok(scene.branches || []);
	if ((m = path.match(/^\/repos\/o\/r\/branches\/(.+)$/))) {   // a PR's branch, at its head
		const pr = pulls.find((p) => p.head.ref === decodeURIComponent(m[1]));
		return pr ? ok({ commit: { sha: pr.head.sha } }) : missing();
	}
	if (/\/commits\/stale-/.test(path)) return ok({ commit: { committer: { date: '2020-01-01T00:00:00Z' } } });
	if (path === `/repos/${REPO}/pulls`) {
		if (new URL(url).searchParams.get('state') === 'closed') return ok([]);
		const base = new URL(url).searchParams.get('base');
		return ok(base ? pulls.filter((p) => p.base.ref === base) : pulls);
	}
	if ((m = path.match(/\/pulls\/(\d+)$/))) {
		const merged = asyncMerged.has(+m[1]);
		return ok({ mergeable: true, merged, merge_commit_sha: merged ? 'asyncmerged' : null, requested_reviewers: [], requested_teams: [] });
	}
	if ((m = path.match(/\/issues\/(\d+)\/timeline$/))) {
		return ok(byNumber(m[1]).carry ? [{ event: 'review_dismissed', dismissed_review: { review_id: 7, state: 'approved' } }] : []);
	}
	if ((m = path.match(/\/compare\/main\.\.\.(old|h)(\d+)$/))) {   // what a commit changes against main (hunk line numbers move)
		const pr = byNumber(m[2]), older = m[1] === 'old';
		const patch = `@@ -${older ? 1 : 40},2 +${older ? 1 : 40},2 @@ fn\n-x\n+${older && pr.carry === 'different' ? 'z' : 'y'}`;
		return ok({ files: [{ filename: 'js/a.js', status: 'modified', changes: 2, patch }] });
	}
	if ((m = path.match(/\/pulls\/(\d+)\/reviews$/)) && byNumber(m[1]).carry) {
		return ok([{ id: 7, user: { login: 'bob' }, state: 'DISMISSED', commit_id: `old${m[1]}`, author_association: 'COLLABORATOR' }, ...postedReviews]);
	}
	if ((m = path.match(/\/pulls\/(\d+)\/reviews$/))) {
		return ok(byNumber(m[1]).approved ? [{ id: 1, user: { login: 'bob' }, state: 'APPROVED', commit_id: `h${m[1]}`, author_association: 'COLLABORATOR' }] : []);
	}
	if ((m = path.match(/\/pulls\/(\d+)\/files$/))) return ok((byNumber(m[1]).files || ['docs/x.md']).map((filename) => ({ filename })));
	if ((m = path.match(/\/issues\/(\d+)\/comments$/))) return ok(new URL(url).searchParams.get('page') > 1 ? [] : sceneComments[m[1]] || []);
	if (/\/compare\//.test(path)) return ok({ behind_by: 0, ahead_by: 1 });
	if (/\/check-runs$/.test(path)) return ok({ check_runs: (scene.checks || ['precommit', 'pr-policy']).map((name) => ({ name, conclusion: 'success', status: 'completed' })) });
	if (/\/status$/.test(path)) return ok({ statuses: [] });
	if (/\/git\/refs\/heads\//.test(path)) return ok({});
	if (/\/actions\/workflows\//.test(path)) return ok({});
	throw new Error(`unmocked GET ${path}`);
}

/**
 * GraphQL: the issues a PR closes (the scene's `fixes`: [{ number, state, repo }]), or the force-pushes to its branch
 * (`pushesOf`) or to its base branch (`basePushesOf`).
 */
function graphqlAnswer(body, pushesOf, basePushesOf) {
	const { query, variables: { n } } = JSON.parse(body);
	const timeline = (nodes) => ok({ data: { repository: { pullRequest: { timelineItems: { nodes } } } } });
	if (/BASE_REF_FORCE_PUSHED_EVENT/.test(query)) return timeline(basePushesOf(n));
	if (/timelineItems/.test(query)) return timeline(pushesOf(n));
	const nodes = (scene.prs.find((p) => p.number === n)?.fixes || []).map((f) => ({ number: f.number, state: f.state || 'OPEN', repository: { nameWithOwner: f.repo || REPO } }));
	return ok({ data: { repository: { pullRequest: { closingIssuesReferences: { nodes } } } } });
}

// ---- with git -------------------------------------------------------------------------------------------------------

let refs = null, refsStamp = '';   // the repository's refs, { 'refs/heads/main': sha, ... }, read again when they change
const state = scene.git ? loadState() : null;

function loadState() {
	if (fs.existsSync(scene.state)) return JSON.parse(fs.readFileSync(scene.state, 'utf8'));
	const s = { prs: {}, seen: {}, bases: {}, checks: {}, race: scene.race || null, comments: {}, updated: [] };
	for (const p of scene.prs) {
		const pr = { number: p.number, base: p.base, ref: p.ref, body: p.body || '', open: true, fork: !!p.fork, labels: p.labels || [], hasStack: !!p.hasStack, apiHead: p.apiHead || null, reviews: [], pushes: [], basePushes: [] };
		s.prs[p.number] = pr;
		const head = headOf(pr);
		s.seen[p.number] = head;
		s.bases[p.number] = { ref: pr.base, sha: sha(`refs/heads/${pr.base}`) };
		s.checks[head] = ['precommit', 'pr-policy'];
		if (p.approved) pr.reviews.push({ id: p.number * 10, user: { login: 'bob' }, state: 'APPROVED', commit_id: head, author_association: 'COLLABORATOR' });
	}
	return s;
}

function saveState() {
	fs.writeFileSync(scene.state, JSON.stringify(state));
}

/** When the repository's refs last changed: git writes a ref by renaming a file into its directory, or packs them. */
function refsChanged() {
	const times = [];
	const walk = (dir) => {
		times.push(fs.statSync(dir).mtimeMs);
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			if (e.isDirectory()) walk(`${dir}/${e.name}`);
			else times.push(fs.statSync(`${dir}/${e.name}`).mtimeMs);
		}
	};
	walk(`${scene.git}/refs`);
	if (fs.existsSync(`${scene.git}/packed-refs`)) times.push(fs.statSync(`${scene.git}/packed-refs`).mtimeMs);
	return times.join(',');
}

/** A commit's SHA: a full ref, a branch name or a SHA ('' if there's no such thing). */
function sha(rev) {
	const stamp = refsChanged();
	if (!refs || stamp !== refsStamp) {
		refs = Object.fromEntries(git(scene.git, ['for-each-ref', '--format=%(refname) %(objectname)']).split('\n').filter(Boolean).map((l) => l.split(' ')));
		refsStamp = stamp;
	}
	if (/^[0-9a-f]{40}$/.test(rev)) return rev;
	return refs[rev] || refs[`refs/heads/${rev}`] || git(scene.git, ['rev-parse', '--verify', '--quiet', rev], { ok: [0, 1] });
}
function headOf(pr) {
	if (pr.merged) return pr.mergedHead;
	return pr.apiHead || sha(pr.fork ? `refs/pull/${pr.number}/head` : `refs/heads/${pr.ref}`);
}

/**
 * Pushes since the last call go in the PR's timeline as the bot's force-pushes, and a force-push to its base branch
 * as a base force-push. Reviews stay where they are.
 */
function notePushes() {
	for (const pr of Object.values(state.prs).filter((p) => p.open)) {
		noteBasePush(pr);
		const head = headOf(pr);
		if (head === state.seen[pr.number]) continue;
		pr.pushes.push({ actor: { login: 'github-actions' }, beforeCommit: { oid: state.seen[pr.number] }, afterCommit: { oid: head } });
		state.seen[pr.number] = head;
	}
}

function noteBasePush(pr) {
	const was = state.bases[pr.number], now = sha(`refs/heads/${pr.base}`);
	const forced = was?.ref === pr.base && was.sha && now && was.sha !== now && gitStatus(scene.git, ['merge-base', '--is-ancestor', was.sha, now]) !== 0;
	if (forced) pr.basePushes.push({ beforeCommit: { oid: was.sha }, afterCommit: { oid: now } });
	state.bases[pr.number] = { ref: pr.base, sha: now };
}

function pullOf(pr) {
	return {
		number: pr.number,
		title: `[Docs] Fix: Thing ${pr.number}`,
		body: pr.body,
		labels: pr.labels.map((name) => ({ name })),
		draft: false,
		user: { login: 'alice' },
		html_url: `https://github.com/${REPO}/pull/${pr.number}`,
		head: { sha: headOf(pr), ref: pr.ref, repo: { full_name: pr.fork ? 'mallory/r' : REPO } },
		base: { ref: pr.base },
		merged_at: pr.merged ? '2026-01-01T00:00:00Z' : null,
		merge_commit_sha: pr.mergeCommit || null,
	};
}

/** GitHub's squash merge, onto main as it is now (after a `race`, if one is waiting). */
function squash(pr) {
	if (state.race) {
		git(scene.git, ['update-ref', 'refs/heads/main', state.race]);
		state.race = null;
	}
	const main = sha('refs/heads/main'), head = headOf(pr);
	const tree = git(scene.git, ['merge-tree', '--write-tree', main, head]);
	const commit = git(scene.git, ['commit-tree', tree, '-p', main, '-m', `[Docs] Fix: Thing ${pr.number}`]);
	git(scene.git, ['update-ref', 'refs/heads/main', commit, main]);
	Object.assign(pr, { open: false, merged: true, mergeCommit: commit, mergedHead: head });
	return commit;
}

async function gitFetch(url, { method = 'GET', body } = {}) {
	notePushes();
	try {
		return await gitRoute(new URL(url), method, body ? JSON.parse(body) : null, body);
	} finally {
		saveState();
	}
}

async function gitRoute(url, method, data, raw) {
	const path = url.pathname;
	const prOf = (n) => state.prs[n];
	let m;
	if (path === '/graphql') return graphqlAnswer(raw, (n) => prOf(n)?.pushes || [], (n) => prOf(n)?.basePushes || []);
	if (method !== 'GET') {
		logWrite(method, path, raw);
		const fail = scene.fail || [];
		if ((fail.includes('retarget') && method === 'PATCH' && data.base) || (fail.includes('dispatch') && /\/dispatches$/.test(path))
			|| (fail.includes('restore') && method === 'POST' && path.endsWith('/git/refs'))) {
			return { ok: false, status: 500, text: async () => '{"message":"Server Error"}' };
		}
		if ((m = path.match(/\/pulls\/(\d+)\/merge$/))) {
			if (prOf(m[1]).hasStack) return refused('Merging stacked PRs via this endpoint is not supported. Use the asynchronous merge endpoint instead.');
			return ok({ sha: squash(prOf(m[1])), merged: true });
		}
		if (/\/pulls\/\d+\/merge-async$/.test(path)) return ok({ status: 'pending', details: { uuid: 'u1', expected_head_sha: data.sha } });
		if ((m = path.match(/\/pulls\/(\d+)$/)) && method === 'PATCH') {
			const pr = prOf(m[1]);
			if (data.base && basedOn(pr.ref).length && !pr.fork) return unprocessable('Cannot change the base branch because the pull request is part of a stack.');
			if (data.state === 'open' && (pr.merged || !sha(`refs/heads/${pr.base}`))) return unprocessable('Cannot reopen this pull request.');
			if (data.state === 'open') pr.open = true;
			if (data.base) pr.base = data.base;
			if (data.body != null) pr.body = data.body;
		}
		if ((m = path.match(/\/git\/refs\/heads\/(.+)$/)) && method === 'DELETE') {
			const ref = decodeURIComponent(m[1]);
			if (!sha(`refs/heads/${ref}`)) return unprocessable('Reference does not exist');
			git(scene.git, ['update-ref', '-d', `refs/heads/${ref}`]);
			baseDeleted(ref);
		}
		if (path === `/repos/${REPO}/git/refs` && method === 'POST') {
			if (sha(data.ref)) return unprocessable('Reference already exists');
			git(scene.git, ['update-ref', data.ref, data.sha]);
		}
		if ((m = path.match(/\/pulls\/(\d+)\/reviews\/(\d+)\/dismissals$/))) prOf(m[1]).reviews.find((r) => r.id === +m[2]).state = 'DISMISSED';
		if ((m = path.match(/\/actions\/workflows\/([^/]+)\/dispatches$/))) await noteDispatch(m[1], data);
		if ((m = path.match(/\/issues\/(\d+)\/comments$/))) (state.comments[m[1]] ||= []).push({ user: { login: BOT }, body: data.body });
		if ((m = path.match(/\/statuses\/([0-9a-f]{40})$/)) && data.context === 'pr-bot-update') state.updated.push(m[1]);
		return ok({});
	}
	if ((m = path.match(/\/pulls\/(\d+)\/merge-async\/u1$/))) return ok({ status: 'merged', details: { message: 'Merged', sha: squash(prOf(m[1])) } });
	if ((m = path.match(/^\/repos\/o\/r\/branches\/(.+)$/))) {
		const tip = sha(`refs/heads/${decodeURIComponent(m[1])}`);
		return tip ? ok({ commit: { sha: tip } }) : missing();
	}
	if (path === `/repos/${REPO}/pulls`) {
		const base = url.searchParams.get('base'), closed = url.searchParams.get('state') === 'closed';
		return ok(Object.values(state.prs).filter((p) => p.open === !closed && (!base || p.base === base)).map(pullOf));
	}
	if ((m = path.match(/\/issues\/(\d+)\/comments$/))) return ok(url.searchParams.get('page') > 1 ? [] : state.comments[m[1]] || []);
	if ((m = path.match(/\/pulls\/(\d+)$/))) {
		const pr = prOf(m[1]);
		return ok({ ...pullOf(pr), state: pr.open ? 'open' : 'closed', mergeable: pr.open ? mergeable(pr) : null, merged: !!pr.merged, merge_commit_sha: pr.mergeCommit || null, requested_reviewers: [], requested_teams: [] });
	}
	if ((m = path.match(/\/issues\/(\d+)\/timeline$/))) {
		return ok(prOf(m[1]).reviews.filter((r) => r.state === 'DISMISSED').map((r) => ({ event: 'review_dismissed', dismissed_review: { review_id: r.id, state: 'approved' } })));
	}
	if ((m = path.match(/\/pulls\/(\d+)\/reviews$/))) return ok(prOf(m[1]).reviews);
	if ((m = path.match(/\/pulls\/(\d+)\/files$/))) return ok(filesOf(prOf(m[1])).map((filename) => ({ filename })));
	if ((m = path.match(/\/compare\/(.+)\.\.\.([^/]+)$/))) return compare(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
	if ((m = path.match(/\/commits\/([^/]+)\/check-runs$/))) {
		return ok({ check_runs: (state.checks[m[1]] || []).map((name) => ({ name, conclusion: 'success', status: 'completed' })) });
	}
	if ((m = path.match(/\/commits\/([^/]+)\/status$/))) {
		return ok({ statuses: state.updated.includes(m[1]) ? [{ context: 'pr-bot-update', state: 'success' }] : [] });
	}
	if ((m = path.match(/\/commits\/([0-9a-fA-F]+)$/))) {   // a commit by its SHA, abbreviated or not, as GitHub resolves one
		const out = git(scene.git, ['rev-parse', '--verify', '--quiet', `${m[1]}^{commit}`], { ok: [0, 1, 128] });
		if (/^[0-9a-f]{40}$/.test(out)) return ok({ sha: out });
		const ambiguous = gitStatus(scene.git, ['rev-parse', '--disambiguate=' + m[1]]) === 0 && git(scene.git, ['rev-parse', '--disambiguate=' + m[1]]).split('\n').length > 1;
		return unprocessable(ambiguous ? `short SHA ${m[1]} is ambiguous` : `No commit found for SHA: ${m[1]}`);
	}
	throw new Error(`unmocked GET ${path}`);
}

/** The open PRs based on branch `ref`. */
function basedOn(ref) {
	return Object.values(state.prs).filter((p) => p.open && p.base === ref);
}

/**
 * GitHub, once branch `ref` is deleted: the open PRs based on it move to the base of the merged PR it was the head of,
 * or are closed when it was no merged PR's head (or as `onDelete` says). Printed for the test.
 */
function baseDeleted(ref) {
	const merged = Object.values(state.prs).find((p) => p.merged && !p.fork && p.ref === ref);
	const how = scene.onDelete || (merged ? 'retarget' : 'close');
	const prs = basedOn(ref);
	for (const pr of prs) {
		if (how === 'retarget') pr.base = merged.base;
		if (how === 'close') pr.open = false;
	}
	if (prs.length) console.log(JSON.stringify({ fake: 'base-deleted', ref, how, prs: prs.map((p) => p.number) }));
}

/** Whether the PR merges into its base without conflicts. */
function mergeable(pr) {
	return gitStatus(scene.git, ['merge-tree', '--write-tree', sha(`refs/heads/${pr.base}`), headOf(pr)]) === 0;
}

/**
 * A dispatched check passes on the branch's head: precommit always, and pr-policy for the PR whose head it is when
 * tools/check-pr.mjs passes its description for that head, its files and tools/same-changes.mjs's verdict, as the
 * workflow runs them (printed for the test).
 */
async function noteDispatch(workflow, { ref, inputs }) {
	const head = sha(`refs/heads/${ref}`);
	const pass = (name) => { state.checks[head] = [...new Set([...(state.checks[head] || []), name])]; };
	if (workflow === 'precommit.yml') pass('precommit');
	if (workflow !== 'pr-policy.yml') return;
	const pr = state.prs[inputs?.pr];
	if (!pr || !pr.open || pr.ref !== ref || headOf(pr) !== head) return;
	// imported here, not above: run as a command under this fake, the tool must start once the fake is in place
	const { testedChanges } = await import('../../tools/same-changes.mjs');
	const tested = await testedChanges({ repo: REPO, serverUrl: process.env.GITHUB_SERVER_URL, body: pr.body, head, baseRef: pr.base, pr: pr.number });
	const { errors, notes } = checkPr({ body: pr.body, headSha: head, files: filesOf(pr), testedChanges: tested });
	console.log(JSON.stringify({ fake: 'pr-policy', pr: pr.number, head, tested, errors, notes }));
	if (!errors.length) pass('pr-policy');
}

function filesOf(pr) {
	const from = git(scene.git, ['merge-base', sha(`refs/heads/${pr.base}`), headOf(pr)]);
	return git(scene.git, ['diff', '--name-only', '--no-renames', '--diff-filter=d', from, headOf(pr)]).split('\n').filter(Boolean);
}

/** GitHub's three-dot compare: how far apart, and what `head` changes since it left `base` (hunks only, per file). */
function compare(base, head) {
	const [b, h] = [sha(base), sha(head)];
	if (!b || !h) return missing();
	const [behind, ahead] = git(scene.git, ['rev-list', '--left-right', '--count', `${b}...${h}`]).split(/\s+/).map(Number);
	const from = git(scene.git, ['merge-base', b, h]);
	const files = git(scene.git, ['diff', '--name-status', '--no-renames', from, h]).split('\n').filter(Boolean).map((line) => {
		const [code, filename] = line.split('\t');
		const patch = git(scene.git, ['diff', '--no-renames', from, h, '--', filename]).replace(/^[\s\S]*?(?=^@@)/m, '');
		return { filename, status: { A: 'added', D: 'removed' }[code] || 'modified', changes: 1, patch };
	});
	return ok({ behind_by: behind, ahead_by: ahead, merge_base_commit: { sha: from }, files });
}
