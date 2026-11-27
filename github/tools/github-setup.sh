#!/usr/bin/env bash
# Apply the repository settings the PR automation expects (README.md, "Adopting it"), idempotently:
#   - merging: only merge.method from .github/pr-automation.json (squash or merge commits titled with the PR title and
#     an empty body), head branches deleted on merge, "Update branch" offered;
#   - Actions: a read-only token by default, and NOT allowed to create or approve pull requests, so no workflow can
#     stand in for a reviewer (merge.carryApprovals "review" needs that allowed: pass --allow-actions-approvals);
#   - the rulesets in .github/rulesets/, with the config applied (tools/pr-config.mjs ruleset), created or updated in
#     place by name. Where the plan doesn't enforce rulesets (a private repository on GitHub Free), it says so and
#     goes on: then the PR bot's own checks are the only gate;
#   - the labels the bot and the modules use (tools/pr-config.mjs labels).
# It also checks that the repository's default branch is the config's defaultBranch. It never publishes Pages: that
# is a choice to make in Settings → Pages (README.md, "Pages previews").
#
# Needs `gh`, logged in as a repository admin, and node.
#
#   tools/github-setup.sh OWNER/REPO [--dry-run] [--allow-actions-approvals]
set -euo pipefail
cd "$(dirname "$0")/.."

repo=${1:-}
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "usage: tools/github-setup.sh OWNER/REPO [--dry-run] [--allow-actions-approvals]" >&2; exit 2; }
shift
dry_run=false
allow_approvals=false
for arg in "$@"; do
	case "$arg" in
		--dry-run) dry_run=true ;;
		--allow-actions-approvals) allow_approvals=true ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

node tools/pr-config.mjs check >/dev/null   # stop here on a bad config
cfg() { node tools/pr-config.mjs get "$1"; }

# `gh api` with its arguments, or what it would be, under --dry-run
api() {
	if $dry_run; then
		echo "(dry run) gh api $*" >&2
		return 0
	fi
	gh api "$@"
}

method=$(cfg merge.method)
default_branch=$(cfg defaultBranch)
carry=$(cfg merge.carryApprovals)

# ---- the default branch ---------------------------------------------------------------------------------------------
if ! $dry_run; then
	actual=$(gh api "repos/$repo" --jq .default_branch)
	if [ "$actual" != "$default_branch" ]; then
		echo "warning: $repo's default branch is $actual, but defaultBranch in .github/pr-automation.json is $default_branch" >&2
	fi
fi

# ---- merging --------------------------------------------------------------------------------------------------------
case "$method" in
	squash) merge_args=(-F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false
		-f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=BLANK) ;;
	merge) merge_args=(-F allow_squash_merge=false -F allow_merge_commit=true -F allow_rebase_merge=false
		-f merge_commit_title=PR_TITLE -f merge_commit_message=BLANK) ;;
	rebase) merge_args=(-F allow_squash_merge=false -F allow_merge_commit=false -F allow_rebase_merge=true) ;;
esac
api -X PATCH "repos/$repo" "${merge_args[@]}" -F delete_branch_on_merge=true -F allow_update_branch=true >/dev/null
echo "merging: $method only, head branches deleted on merge"

# ---- Actions ----------------------------------------------------------------------------------------------------------
can_approve=false
if [ "$carry" = review ]; then
	if $allow_approvals; then
		can_approve=true
		echo "warning: letting GitHub Actions approve pull requests (merge.carryApprovals is \"review\"): any workflow with" \
			"pull-requests: write can now approve a PR in a person's place" >&2
	else
		echo "warning: merge.carryApprovals is \"review\", which needs Actions to approve pull requests; left off." \
			"Pass --allow-actions-approvals to allow it, or use \"count\"" >&2
	fi
fi
api -X PUT "repos/$repo/actions/permissions/workflow" -f default_workflow_permissions=read -F can_approve_pull_request_reviews=$can_approve >/dev/null
echo "actions: read-only token by default; may approve pull requests: $can_approve; may not create them"

# ---- rulesets -------------------------------------------------------------------------------------------------------
existing='[]'
if ! $dry_run; then
	if ! existing=$(gh api "repos/$repo/rulesets" 2>&1); then
		echo "warning: can't read $repo's rulesets ($(echo "$existing" | head -c 200)). On GitHub Free a private repository's" \
			"rulesets aren't enforced: the PR bot's checks are the only gate, and anyone with write access can merge by hand." >&2
		existing=skip
	fi
fi
for file in .github/rulesets/*.json; do
	name=$(basename "$file" .json)
	rendered=$(node tools/pr-config.mjs ruleset "$name")
	if [ "$rendered" = null ]; then
		echo "ruleset $name: not used with this config (branch.pattern); delete it on GitHub if it's there"
		continue
	fi
	if [ "$existing" = skip ]; then
		echo "ruleset $name: skipped (rulesets unavailable)"
		continue
	fi
	title=$(node -e 'console.log(JSON.parse(process.argv[1]).name)' "$rendered")
	if $dry_run; then
		echo "(dry run) ruleset $title: would be created, or updated in place if one has that name"
		continue
	fi
	id=$(node -e 'const list = JSON.parse(process.argv[1]); console.log((list.find((r) => r.name === process.argv[2]) || {}).id || "")' "$existing" "$title")
	if [ -n "$id" ]; then
		echo "$rendered" | api -X PUT "repos/$repo/rulesets/$id" --input - >/dev/null
		echo "ruleset $title: updated ($id)"
	elif out=$(echo "$rendered" | api -X POST "repos/$repo/rulesets" --input - 2>&1); then
		echo "ruleset $title: created"
	else
		echo "warning: ruleset $title not created: $(echo "$out" | head -c 300)" >&2
	fi
done

# ---- labels -----------------------------------------------------------------------------------------------------------
while IFS=$'\t' read -r name color description; do
	[ -n "$name" ] || continue
	if $dry_run; then
		echo "(dry run) gh label create $name --color $color" >&2
	else
		gh label create "$name" --repo "$repo" --color "$color" --description "$description" --force >/dev/null
	fi
	echo "label: $name"
done < <(node tools/pr-config.mjs labels)

if [ "$(cfg pages.enabled)" = true ]; then
	echo "pages: on in the config. Publishing is yours to switch on: Settings → Pages → Source: GitHub Actions, and"
	echo "       Settings → Environments → github-pages → deployment branches: only $default_branch. Every preview is public."
fi
