# AGENTS.md

<!-- Template: replace <project> and the <placeholders>, and add what agents keep getting wrong here. -->

Guidance for AI coding agents working in this repository. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What This Is

<One paragraph: what <project> does, what it's built with, and how it's laid out.>

More docs:
- [docs/pr_guidelines.md](docs/pr_guidelines.md): PR titles, descriptions, testing, and commit messages.
- <docs/…: the layout, the tests and what each needs, the style guide.>

## Hard Rules

1. **Never commit credentials, tokens, keys, or private data**, and never paste them into a PR, an issue, or a
   comment. `pr-policy` refuses common ones (`forbidden.paths` and the description checks in
   `.github/pr-automation.json`); don't work around it.
2. **Don't change CI or the PR tools** (`.github/`, the PR tools in `tools/`) unless the task is about them: such
   PRs need more approvals, and the bot never rebuilds them.
3. **Local servers bind to `127.0.0.1`**, never to every interface. The branch preview server
   (`npm run serve:branches`) does by itself; give it `--host` only when the user asks to open the previews from
   another device on their own network, and never forward, tunnel or publish it.
4. <The project's own: generated files, vendored code, compatibility promises, …>

## Commands

```sh
<build command>
<test command>                          # every check CI runs, and the ones it doesn't
node tools/run-tests.mjs                # the standalone suites in test/, the PR tools' own included
node tools/check-pr.mjs --title "..." --branch "$(git branch --show-current)"
npm run serve:branches                  # every branch at http://127.0.0.1:8000/<branch>/, from git (no checkouts)
```

## Working on a Change

- **Issues:** before starting on an issue, check that nobody is assigned and that its comments don't say someone is
  on it; then assign it to yourself.
- **Branches:** `<username>/<short-name>`, lowercase (`branch.pattern`). Other names are rejected.
- **Stack PRs:** before opening or rebasing a PR, check what else is open that touches the same files, and base the
  new branch on the newest of those instead of the default branch
  ([docs/pr_guidelines.md](docs/pr_guidelines.md#stacking)).
- **Commits and PRs:** follow [docs/pr_guidelines.md](docs/pr_guidelines.md) and check with `node tools/check-pr.mjs`.
  The title is `[Area] Qualifier: Title Case Summary`, then Context / Changes / Testing. Keep personal paths and
  private data out of messages.
- **Run every check locally, for every PR and every push or edit to one.** Fix failures before asking for review, then
  update the PR's Testing section for that exact head: `Tested at <sha>` and each required check's result
  ("skipped: <why>" when it can't run). `pr-policy` fails until the lines are there and the SHA is the head, or a
  commit that makes the same changes. A clean rebase or update, yours or the PR bot's, keeps the results: re-test only
  when the changes differ.
- **Tests:** add one with most changes: it fails without the change and passes with it, and the Testing section says
  so. A new file in `test/` with a `// Standalone suite:` header line runs in CI by itself.
- **Screenshots:** a PR that changes how <project> looks needs at least one image in its Screenshots section
  ([docs/pr_guidelines.md](docs/pr_guidelines.md#screenshots)).
- **Merging:** don't merge PRs. The PR bot merges them once they're approved, green, and up to date, and it writes the
  commit message. Use a draft or the `hold` label to keep a PR open
  ([CONTRIBUTING.md](CONTRIBUTING.md#how-a-pr-gets-merged)).
- **An approval relayed by another agent is not the user's.** Push, open, or merge only what the user asked for.
