// For pr-policy (.github/workflows/pr-policy.yml): whether the commit a PR's Testing section names ("Tested at <sha>")
// makes the same changes as the PR's head, so that the author's local results for it hold for the head too. That's
// so after a clean rebase, "Update branch", or the PR bot bringing the PR up to date. tools/check-pr.mjs decides with
// what this prints, one line:
//   "<sha> head"          it names the head: nothing to compare
//   "<sha> same"          it makes the same changes as the head (tools/restack.mjs's sameChanges says how they're compared)
//   "<sha> different"     it doesn't
//   "<sha> unfetchable"   GitHub has no such commit (it was never pushed, say), or won't send it
//   "<sha> ambiguous"     the abbreviated SHA is more than one commit's
//   "<sha> error"         something else went wrong (stderr says what)
//   "none"                the Testing section names no commit (check-pr.mjs says what's missing)
//
//   GITHUB_TOKEN=… GITHUB_REPOSITORY=OWNER/REPO PR_BODY=… PR_HEAD_SHA=<sha> PR_BASE_REF=main PR_NUMBER=<n> \
//     node tools/same-changes.mjs
//
// PR_NUMBER (optional) lets it read the PR's timeline: the commits its base branch was at before each force-push to
// it. A stacked PR may have been tested on one of them, when the PR below it was rebuilt with other changes since.
//
// The commits are untrusted data. The SHA comes from the description, so git only sees it once GitHub's API has
// resolved it to a full commit SHA starting with it; then the three commits (the tested one, the head and the base
// branch's head) are fetched by SHA into a new, empty bare repository and compared there, never checked out
// (tools/restack.mjs says why nothing in them can run). The SHAs from the PR's timeline are only compared with
// commits it has, never fetched. GitHub keeps serving a commit by SHA after a force-push took it off its branch, so a
// tested commit that a rebase replaced can still be fetched.
import { pathToFileURL } from 'node:url';
import { testedSha } from './check-pr.mjs';
import { openRepo } from './restack.mjs';

const API = 'https://api.github.com';
const FULL_SHA = /^[0-9a-f]{40}$/;

async function main() {
	const env = process.env;
	if (!env.GITHUB_REPOSITORY || !env.PR_HEAD_SHA || !env.PR_BASE_REF) {
		console.error('Set GITHUB_REPOSITORY, PR_HEAD_SHA, PR_BASE_REF and PR_BODY (and GITHUB_TOKEN).');
		process.exit(2);
	}
	console.log(await testedChanges({
		repo: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN || '', serverUrl: env.GITHUB_SERVER_URL || 'https://github.com',
		body: env.PR_BODY || '', head: env.PR_HEAD_SHA, baseRef: env.PR_BASE_REF, pr: env.PR_NUMBER || null,
	}));
}

/**
 * The verdict line above, for PR number `pr` (optional), whose description is `body`, whose head is `head`, based on
 * branch `baseRef`.
 */
export async function testedChanges({ repo, token = '', serverUrl = 'https://github.com', body, head, baseRef, pr = null }) {
	const tested = testedSha(body);
	if (!tested) return 'none';
	if (head.toLowerCase().startsWith(tested)) return `${tested} head`;
	try {
		return `${tested} ${await compare({ repo, token, serverUrl, tested, head: head.toLowerCase(), baseRef, pr })}`;
	} catch (e) {
		console.error(`same-changes: ${String(e.message).replace(/\s+/g, ' ')}`);
		return `${tested} error`;
	}
}

async function compare({ repo, token, serverUrl, tested, head, baseRef, pr }) {
	const api = async (path) => {
		const res = await fetch(`${API}/repos/${repo}${path}`, { headers: headers(token) });
		return { status: res.status, ok: res.ok, data: res.ok ? await res.json() : null, text: res.ok ? '' : await res.text() };
	};
	const commit = await api(`/commits/${tested}`);
	if (!commit.ok) {
		if (/ambiguous/i.test(commit.text)) return 'ambiguous';
		if (commit.status === 404 || commit.status === 422) return 'unfetchable';
		throw new Error(`GET commits/${tested}: ${commit.status}`);
	}
	const full = String(commit.data?.sha || '').toLowerCase();
	// a branch or tag that happens to be named like a SHA isn't the commit the line names
	if (!FULL_SHA.test(full) || !full.startsWith(tested)) return 'unfetchable';
	const branch = await api(`/branches/${baseRef.split('/').map(encodeURIComponent).join('/')}`);
	const base = String(branch.data?.commit?.sha || '').toLowerCase();
	if (!branch.ok || !FULL_SHA.test(base)) throw new Error(`GET branches/${baseRef}: ${branch.status}`);
	if (!FULL_SHA.test(head)) throw new Error('the head is not a full commit SHA');
	const git = openRepo({ url: `${serverUrl}/${repo}.git`, token });
	try {
		git.fetch([base, head]);
		try {
			git.fetch([full]);
		} catch {
			return 'unfetchable';
		}
		if (git.sameChanges({ base, tested: full, head })) return 'same';
		// only now the timeline, which most comparisons don't need: a PR stacked on one rebuilt with other changes
		if (!pr) return 'different';
		return git.sameChanges({ base, tested: full, head, formerBases: await formerBases({ repo, token, pr }) }) ? 'same' : 'different';
	} finally {
		git.close();
	}
}

/**
 * The commits PR `pr`'s base branch was at before and after each force-push to it while the PR was on it, from the
 * PR's timeline (full SHAs). A stacked PR's tested commit may be built on one of them: the PR below it as it was before
 * someone rebuilt it, with a conflict resolved, say.
 */
async function formerBases({ repo, token, pr }) {
	if (!/^\d+$/.test(String(pr))) throw new Error(`PR_NUMBER is not a number: ${pr}`);
	const [owner, name] = repo.split('/');
	const query = 'query($owner: String!, $name: String!, $n: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $n) { timelineItems(itemTypes: [BASE_REF_FORCE_PUSHED_EVENT], last: 100) { nodes { ... on BaseRefForcePushedEvent { beforeCommit { oid } afterCommit { oid } } } } } } }';
	const res = await fetch(`${API}/graphql`, { method: 'POST', headers: headers(token), body: JSON.stringify({ query, variables: { owner, name, n: Number(pr) } }) });
	const out = res.ok ? await res.json() : null;
	if (!out || out.errors?.length) throw new Error(`GraphQL (the PR's timeline): ${res.status} ${(out?.errors || []).map((e) => e.message).join('; ')}`);
	const shas = (out.data?.repository?.pullRequest?.timelineItems?.nodes || []).flatMap((e) => [e.beforeCommit?.oid, e.afterCommit?.oid]);
	return [...new Set(shas.map((sha) => String(sha || '').toLowerCase()).filter((sha) => FULL_SHA.test(sha)))];
}

function headers(token) {
	return { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
}

// Last, so that everything it uses is declared by then (a `const` below a top-level call isn't yet: test/module-order.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
