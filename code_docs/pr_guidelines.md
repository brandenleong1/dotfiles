# Pull Request Guidelines

How to write a pull request's title and description, how to test it, and the commit message it's merged as. Every
change reaches the default branch as one commit: the PR title, then a link to the PR. The details stay in the PR,
where the discussion is too.

These are the general rules. A repository that uses the PR automation template (`../github/`, see its
[README](../github/README.md)) enforces them with its `pr-policy` check, using the settings in its
`.github/pr-automation.json`; its own `docs/pr_guidelines.md` is this guide with that repository's specifics filled in.
Where the two differ, the repository's file wins. The config field that sets each rule is named in brackets, e.g.
(`title.areas`).

**Run every check locally, for every push.** CI runs only what is cheap and safe to run on every PR. Before asking for
review, and again after every push that changes what the PR does, run all the checks yourself, fix what fails, and
report the results for that exact commit in the Testing section ([Testing](#testing)).

## Title

Format: `[Area][Sub-area] Qualifier: Title Case Summary`. The sub-area is optional. The whole title is at most 80
characters (`title.maxLength`).

**Area** (required): the part of the project the change lives in. Add one sub-area if it helps, e.g. `[API][Auth]` or
`[UI][Settings]`.

| Area | Covers |
|---|---|
| `[Core]` | the main logic: the library, the engine, the domain code |
| `[API]` | public interfaces: endpoints, a library's exported surface, file formats, a CLI's options |
| `[UI]` | what users see and touch: pages, views, styles, text |
| `[Build]` | the build system, packaging, toolchains |
| `[CI]` | workflows and the PR tools |
| `[Docs]` | documentation |
| `[Test]` | test suites and fixtures |
| `[Deps]` | dependency and submodule bumps |

Projects add their own areas for their parts (`title.areas`), e.g. `[Parser]` or `[Storage]`: keep the list short,
one word each, and say in the repository's guide what each covers.

**Qualifier** (required, `title.qualifiers`): one of

| Qualifier | Use it for |
|---|---|
| `Fix:` | a bug: a crash, a wrong result, a broken control |
| `Feature:` | something new: an option, a view, an endpoint, a tool |
| `Performance:` | faster, or less memory, with the same results |
| `Refactor:` | restructuring with no change in behaviour |

For docs, tests, tools, and CI, use `Feature:` when the change adds something and `Fix:` when it corrects something.

**Summary:** Title Case, and imperative: say what the change *does*, not what was wrong ("Keep the Menu Open", not
"Menu Closes" or "Kept the Menu Open"). No full stop.

Title Case is book-title style. Capitalise every word except:
- **articles:** a, an, the;
- **conjunctions:** and, but, or, nor, for;
- **prepositions:** of, to, in, on, at, by, with, from, into, per, via, and the rest.

Those stay lower case unless they're the first or last word, e.g. "Make the PR Bot Wait for a Stacked PR's Base to
Merge". Words that are often adverbs or the particle of a phrasal verb may be either, as in "Set Up the Panel" or
"Wait Until It Merges": up, down, in, on, off, out, over, through, around, after, before, since, until, so, and yet.
Code in backticks counts as a capitalised word.

Examples:

- `[UI] Fix: Keep the Menu Open after a Click`
- `[Core][Cache] Performance: Drop Entries When They Expire`
- `[API] Feature: Page through Results with Two or More Filters`
- `[Build] Fix: Find the Compiler on Paths with Spaces`
- `` [Deps] Fix: Bump the Parser to `0b1f1a9` ``
- `[Docs] Feature: Add a Style Guide`

Check a title before opening the PR: `node tools/check-pr.mjs --title "..." --branch you/thing`.

## Branch

Name your branch `<your GitHub username>/<short-name>`: lowercase, one slash, e.g. `alice/menu-focus`
(`branch.pattern`). Other names can't be pushed where the branch-name ruleset is enforced, and fail `pr-policy`. A
branch is deleted when its PR merges, and a branch with no open PR is pruned after it has gone long enough without a
commit.

## Stacking

**Stack PRs whenever they would otherwise conflict.** Before opening or rebasing a PR, look at what else is open (and
what you have locally) that touches the same files, and base the new branch on the newest of those branches instead
of the default branch. One chain of PRs is better than several parallel ones off the default branch that conflict with
each other.

- **A stacked PR waits** for the PR below it: its status says "Stacked on #N". Merging it would merge it into that
  branch, not into the default branch. You don't need a `hold` label for that.
- **When the PR below merges**, the bot deletes that PR's branch, GitHub moves the stacked PR to the default branch,
  and the bot rebuilds it there (and every PR above it, bottom up): it replays each PR's own commits, checks each
  makes exactly the same changes, and pushes with a lease. Approvals and test results hold ([below](#same-changes)).
- **When the bot can't rebuild one** (a conflict, other changes, a fork, a CI change), it says so on the PR with the
  command to run. Rebuild the whole chain, not just the PR that conflicts:
  1. Replay each PR's own commits onto the new base: `git rebase --onto origin/<new base> <old base sha> <branch>`.
  2. Check each makes the same changes: `git diff <new base> <new head>` against `git diff <old base> <old head>`.
  3. Push the chain in one go, each with a lease on its old head: `git push --force-with-lease=<branch>:<old head sha>`.
  4. Re-test the PRs whose changes differ, and update their Testing sections.
- If you rebuild by hand, push the tested commit before the rebuilt one, so `Tested at` stays fetchable.

## Description

Use the template (`.github/pull_request_template.md`). Leave a blank line between paragraphs and sections. The
description isn't copied into the commit; the commit links to it, so write it for someone arriving from `git log`.

| Section | What goes in it |
|---|---|
| Context | What was wrong or missing, why it matters, and how the change addresses it. See [Writing a good Context](#writing-a-good-context). |
| Changes | Bullets, each starting with a past-tense verb (Added, Changed, Fixed, Removed, Moved). Say what changed and where, e.g. "Fixed the retry delay in `fetchPage` for timeouts." Don't start a bullet with a file name. |
| Testing | Bullets, each starting with a past-tense verb. First `Tested at <sha>`, then the result of each local check for that commit ([Testing](#testing)). Name the tests you added, and show they fail without the change and pass with it. Before/after numbers go here too. |
| Screenshots | Images of what the change looks like ([Screenshots](#screenshots)). Required, with at least one image, when the PR changes how the project looks. Delete the section for changes with nothing to see. |
| Issue | `Fixes #123` when this PR finishes the issue: merging it closes the issue (the bot does that for its own merges too). `Part of #123` when the issue needs more PRs. Write `Fixes` only in the PR that does the last part. |

`Context`, `Changes`, and `Testing` must not be empty (`description.requiredSections`).

**Keep personal and sensitive detail out.** PRs are linked from the history for good, and may be public.

- **Never include:** personal paths (`/home/<you>/…`, `C:\Users\<you>\…`), tokens, keys, or credentials (`pr-policy`
  refuses the common ones, and any `description.sensitivePatterns`).
- **Never include:** other people's data, or anything your project treats as private.
- **Never add** credentials or private keys as files either (`forbidden.paths`); rotate any that were pushed.
- If a bug only shows with private data, describe it in words and reproduce it with made-up data.

## Testing

You run the checks CI doesn't, locally, for every PR and every push or edit that changes what it does:

- **The project's required checks** (`testing.localChecks`): by default one line for the test suite (`npm test`,
  `ctest`, `make check`, `pytest`, `cargo test`, `go test`, or `node tools/run-tests.mjs`); a project can require
  more, some only for PRs that change certain paths (a benchmark for the engine, a browser suite for the UI).
- **What will land:** bring the branch up to date with the default branch first, so you test what will merge.
- **Fix failures first.** A red result is fixed before asking for review, not pushed.
- **Then update the Testing section** for that exact commit: a `Tested at <sha>` line (7 characters or more of the
  commit you tested) and each check with its result. A result is a count that passed or failed ("45 passed, 0
  failed", "30 of 30 suites passed"), or `skipped: <why>` when it can't run. `pr-policy` checks the SHA and each
  required line, so a push that changes what the PR does fails it until you update them.

```sh
git fetch origin && git merge origin/main              # test what will land (or rebase)
ctest --test-dir build --output-on-failure             # each required check (here, a CMake project's tests)
node tools/check-pr.mjs --title "<your PR title>" --branch "$(git branch --show-current)"
git rev-parse --short HEAD                             # the "Tested at" SHA
```

For example:

```markdown
## Testing

- Tested at 3f9c2e1.
- Ran `ctest`: 120 of 120 tests passed.
- Ran `make bench`: skipped: no benchmark machine here; the change doesn't touch the hot loop.
- Added `test_retry_backoff`, which fails without the fix and passes with it.
```

<a id="same-changes"></a>**The same changes keep your results.** `Tested at` may name an earlier commit that makes the
same changes as the head: `pr-policy` fetches both and compares them. So a clean rebase, "Update branch", and the PR
bot's own rebuilds keep your results, and there's no need to press "Update branch" at all: after every merge the bot
brings each open PR up to date by itself. Re-test, and update `Tested at`, only when the changes differ: new commits,
a change moved elsewhere, a conflict you resolved, or a dropped commit. "The same changes" means the head is exactly
your commit's changes on the base it's built on, as a clean rebase or merge makes them, or, for a stacked PR rebuilt on
the PR below it (by the bot, or by hand after that PR's conflict was resolved), your commit's own commits replayed
onto it. Keep the tested commit pushed: when GitHub doesn't have it, `pr-policy` fails ("push the tested commit, or
re-test this head").

## Screenshots

A PR that changes how the project looks (the paths in `screenshots.requiredFor`) shows it, with at least one image in
its Screenshots section. Never use real users' data in them.

- **Drag the image into the description** on github.com; or
- **push it to the screenshot branch** (`screenshots.branch`, `bot/screenshots` by default) under `pr-<n>/`, and link
  it as `![What it shows](https://github.com/OWNER/REPO/blob/bot/screenshots/pr-<n>/<file>.png?raw=true)`. That works
  in a private repository; a `raw.githubusercontent.com` link doesn't; or
- **with the screenshot bot on**, write "See the Screenshots comment": it posts before/after images of the project's
  fixed views on every push. Add images of anything it doesn't cover.

## Writing a Good Context

Context is what a reviewer reads first, and what a future reader finds through `git blame`. It should explain the
change without them opening the issue. It has two parts: a short explanation, always, and one real example, when it
helps.

### 1. Summary and Explanation (Always)

Open with one sentence saying what the change does, and in which situation. Then cover, in one or two short
paragraphs:

- **The problem:** which part does what wrong, with what kind of input. Describe the mechanism, not just the symptom.
- **Why it matters:** what a user sees (a wrong result, a crash, a slow page, a confusing message).
- **The fix:** how the change solves it, and why this is the right place. If there's an obvious alternative you
  rejected, say why in one sentence.

### 2. One Real Example (When It Helps)

Show the smallest case that demonstrates the change, before and after:

- The input, and the one-line command that runs it.
- **Bugs:** the error, or the wrong value and where it shows up.
- **The output on the default branch and with this change.** Run both; don't write the "before" from memory.
- **Performance:** a small before/after table of the numbers that move.
- **Features:** a short before/after of what the user sees.
- **No example** for refactors, renames, docs, and CI changes.

### Keep It Short

- **Prose:** at most about six sentences.
- **Example:** at most about 15 lines. Keep the lines that matter and cut the rest with `…`.
- **Full logs and the investigation story:** in Testing, or on the issue.

### Write for a Reviewer Who Knows the Code but not This Bug

Name functions and data with inline code, explain any domain term the reader might not know, and say which rule or
specification the change follows.

### Example (Illustrative)

Weak:

> Fixes #12. Retries were broken.

Better:

> Makes the HTTP client back off between retries instead of retrying at once.
>
> `fetchPage` retried a timed-out request immediately, up to five times, so a server that was briefly overloaded got
> six requests in a few milliseconds and stayed overloaded. Users saw the whole import fail after one slow response.
>
> Retries now wait 100 ms, then double each time, with jitter, as the server's rate-limit guide asks. A `Retry-After`
> header, when there is one, wins.
>
> `import --source=staging`: before, "6 attempts in 0.04 s, giving up". After, the third attempt succeeds at 0.7 s.

## Commit Messages

What lands on the default branch is one commit per PR: the PR title, then a blank line, then the PR's URL:

```
[Docs] Feature: Add Contributing Docs

https://github.com/OWNER/REPO/pull/12
```

- **Subject:** the PR title, exactly, without the ` (#12)` GitHub appends (the link replaces it).
- **Body:** only the PR's URL. Context, changes, and testing live in the PR.

**The PR bot writes it.** People don't merge: once a PR is approved, green, and up to date, the bot merges it with
exactly this message. Only an admin's manual merge could get it wrong, and `tools/merge-pr.sh` writes the message for
those. To check a commit: `git log -1 --format=%B | node tools/check-pr.mjs --commit`. (With `merge.method` set to
`rebase`, the PR's own commits land as they are, so write each of them in this title format.)

**Commits on your branch** are squashed away, so write them however helps you. Using the same title format makes the
PR easier to review.

## Before Opening the PR

- [ ] The title and every section follow this guide, and the code follows the [style guide](style_guide.md).
- [ ] The branch is stacked on any open PR that touches the same files.
- [ ] Every check ran locally on this head and passed ([Testing](#testing)); the Testing section says `Tested at <sha>`
      with each result.
- [ ] No credentials, personal paths, or private data in the diff or the description.
- [ ] For changes that show: screenshots in the Screenshots section.
