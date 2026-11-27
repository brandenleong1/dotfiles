<!--
Title: [Area] Qualifier: Title Case Summary, e.g. "[UI] Fix: Keep the Menu Open after a Click".
See docs/pr_guidelines.md. Merged as one commit: this title, then a link to this PR. Keep personal paths, tokens,
credentials, and anything private out: PRs stay linked from the history for good.
-->

## Context

<!-- What was wrong or missing, why it matters, and how this fixes it. Add one small before/after example when it
     helps (an input, a command, its output on the default branch and on this one). -->

## Changes

- <!-- Past-tense verb first: Added / Changed / Fixed / Removed / Moved ... -->

## Testing

<!-- Run every check locally on the head you push, and update this whenever a push changes what the PR does:
     pr-policy checks the "Tested at" line and each required check's result, and that the SHA is the head or a commit
     with the same changes (a clean rebase or update, the PR bot's too, keeps them: docs/pr_guidelines.md#testing). -->
- Tested at <!-- git rev-parse --short HEAD -->
- Ran <!-- the test command, e.g. `npm test` -->: <!-- e.g. 30 of 30 suites passed -->
- <!-- Tests you added, and that they fail without the change. -->

## Screenshots

<!-- Needed when the PR changes how the project looks (the paths in screenshots.requiredFor): at least one image. Drag
it in, push it to bot/screenshots and link .../blob/bot/screenshots/pr-<n>/<file>.png?raw=true, or, with the
screenshot bot on, write "See the Screenshots comment". Delete for changes with nothing to see. -->

## Issue

<!-- Fixes #123 -->

---

- [ ] Every check ran locally on this head and passed, and Testing says `Tested at <sha>` with the results
- [ ] No credentials, personal paths, or private data in the diff or this description
