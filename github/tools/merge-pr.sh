#!/usr/bin/env bash
# Fallback for admins: the PR bot normally merges (README.md, "The PR bot"). Merges a pull request with the method and
# commit message the guidelines ask for (merge.method in .github/pr-automation.json; for squash and merge commits: the
# PR title, a blank line, then the PR's URL). Refuses if the title doesn't pass tools/check-pr.mjs, or if the PR's head
# moved since you looked. GitHub still enforces the ruleset (where your plan enforces rulesets); --admin uses your admin
# bypass (e.g. your own PR, which nobody else can approve). Wait for the required checks first.
#
# Deleting the merged branch (--delete-branch) makes GitHub move the PRs stacked on it to the default branch.
#
#   tools/merge-pr.sh 12 [--admin]
set -euo pipefail
cd "$(dirname "$0")/.."
pr=${1:?usage: tools/merge-pr.sh <pr-number> [--admin]}
[[ "$pr" =~ ^[0-9]+$ ]] || { echo "error: the PR is a number" >&2; exit 2; }
admin=()
[ "${2:-}" = --admin ] && admin=(--admin)

method=$(node tools/pr-config.mjs get merge.method)
title=$(gh pr view "$pr" --json title --jq .title)
url=$(gh pr view "$pr" --json url --jq .url)
head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)

node tools/check-pr.mjs --title "$title"
case "$method" in
	squash) gh pr merge "$pr" --squash --delete-branch --match-head-commit "$head" --subject "$title" --body "$url" "${admin[@]}" ;;
	merge)  gh pr merge "$pr" --merge --delete-branch --match-head-commit "$head" --subject "$title" --body "$url" "${admin[@]}" ;;
	rebase) gh pr merge "$pr" --rebase --delete-branch --match-head-commit "$head" "${admin[@]}" ;;
	*) echo "error: unknown merge.method $method" >&2; exit 2 ;;
esac
