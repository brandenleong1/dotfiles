# Contributing

<!-- Template: replace <project>, OWNER/REPO and the commands, and delete what doesn't apply. -->

Thanks for helping. Bug reports, fixes, features, and docs are all welcome.

## Getting Started

```sh
git clone --recurse-submodules https://github.com/OWNER/REPO.git
cd REPO
<build command>                              # e.g. npm ci, or cmake -B build && cmake --build build
<test command>                               # e.g. npm test, or ctest --test-dir build
git switch -c <your-username>/<short-name>   # e.g. alice/menu-focus: other branch names are rejected
npm run serve:branches                       # try any branch: http://127.0.0.1:8000/<branch>/, nothing checked out
```

The branch previews are for your machine. `--host` opens them to your local network (to try a branch on a phone);
anyone on that network can then read every branch, so never forward the port or tunnel it to the internet.

## Ground Rules

1. **No credentials or private data, ever:** not in the code, the history, a PR description, or an issue. `pr-policy`
   refuses common secret files and tokens; don't work around it. If you pushed one, say so at once, so it's rotated.
2. **One change per PR**, with a test that fails without it, where that's possible.
3. <Anything else this project insists on: licensing of contributions, generated files not to edit by hand, …>

## Pull Requests

- Title and description follow [docs/pr_guidelines.md](docs/pr_guidelines.md): `[Area] Qualifier: Title Case
  Summary`, then Context / Changes / Testing.
- **Stack PRs that touch the same files** on each other, rather than opening them side by side
  ([docs/pr_guidelines.md](docs/pr_guidelines.md#stacking)).
- **Run every check locally, for every push.** CI runs only part of them, so you run the rest, fix failures before
  asking for review, then put the results in the Testing section with `Tested at <sha>` for that exact head.
  `pr-policy` fails until you do. A clean rebase or update keeps your results: you re-test only when the changes
  differ ([docs/pr_guidelines.md](docs/pr_guidelines.md#testing)).
- For a change people can see, add screenshots to the description's Screenshots section
  ([docs/pr_guidelines.md](docs/pr_guidelines.md#screenshots)).

## How a PR Gets Merged

**You don't press Merge. The PR bot merges.** It merges each PR as one commit with the message the guidelines ask for
(the PR title, a blank line, the PR's URL), so nobody has to type it and nobody can get it wrong.

The bot merges a PR as soon as all of this is true:

1. **Checks pass:** `precommit` (the checks CI runs) and `pr-policy` (title, description with your local results for
   the current head, branch name, and files).
2. **It's up to date with the default branch.** You don't need to press "Update branch": after every merge the bot
   rebuilds each open PR that's behind by itself ([below](#after-a-merge)). If you update it yourself, with a clean
   rebase or "Update branch", your results and approvals still hold.
3. **People with write access approved the latest commit:** <one person>, or <two> if the PR changes CI or the PR
   tools (`.github/`, the PR tools in `tools/`). A push that changes the PR's diff needs a new review; bringing the
   branch up to date doesn't, because the PR's own changes are the same.
4. **Every requested reviewer has responded.** If anyone requests a review from someone, the bot waits for them. To go
   ahead without them, remove the request.
5. **Nobody requests changes**, there are no conflicts, the PR isn't a draft, and it isn't stacked on another PR.

The **`pr-bot`** status on your PR says what it's waiting for, e.g. "Needs a review of the latest commit" or
"Waiting for pr-policy". It never stays green: it turns green only at the moment the bot merges.

**To stop a ready PR from merging:** keep it a draft, or add the `hold` label. Remove it when you're ready.

<a id="after-a-merge"></a>**After a merge:**
- The bot deletes the PR's branch, and the PRs stacked on it move to the default branch.
- **The bot brings every other open PR up to date.** It replays each one's own commits onto the new default branch
  (a stacked PR onto the rebuilt PR below it, bottom up), checks it makes exactly the same changes, pushes it, and
  starts its checks. Your approvals hold, and so do your local results. If you have the branch checked out, run
  `git pull --rebase` before pushing to it again.
- When the bot can't rebuild a PR (a conflict, a fork, a CI change, or `hold`), it says why on the PR, once, with the
  command to rebuild it by hand. Then test the new head if its changes differ.

**Maintainers:** admins can bypass the rules for a solo maintainer's own PRs, which nobody else can approve. Use
`tools/merge-pr.sh <n> --admin`, so the commit message is still right.

AI agents: see [AGENTS.md](AGENTS.md).
