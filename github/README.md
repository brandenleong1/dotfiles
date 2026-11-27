# PR automation for GitHub

A drop-in set of GitHub Actions workflows and Node tools that run a repository's pull requests:

- **A PR bot merges, people don't.** It keeps a `pr-bot` status on every open PR, pending with the reason until the
  PR is ready, then turns it green and merges in the same moment with a fixed commit message (the PR title, a blank
  line, the PR's URL). Nobody can press Merge in between and type their own.
- **It keeps every open PR up to date.** After any merge it replays each behind PR's own commits onto the new base,
  stacks bottom up, checks the PR still makes exactly the same changes, and pushes with a lease. Approvals and test
  results carry over, because the changes are the same.
- **PR policy** checks the title, branch name, description, and files, and asks the author for their own local test
  results for the exact head ("Tested at `<sha>`"), which a clean rebase or the bot's rebuild keeps valid.
- **Optional modules:** before/after screenshots posted on each PR, per-branch GitHub Pages previews (or, for a
  private repository, local branch previews served from git on your own machine), closing stale PRs and pruning
  branches, submodule bumps, and post-merge checks.

Everything is configured in one file, [`.github/pr-automation.json`](.github/pr-automation.json), documented by
[its schema](.github/pr-automation.schema.json). The tools are plain Node (22, no dependencies) and git 2.40 or later.

The general rules the template enforces are written up, for any project and for AI agents, in
[`../code_docs/pr_guidelines.md`](../code_docs/pr_guidelines.md) (its areas, qualifiers and Testing lines match this
config's defaults), next to a code style guide, [`../code_docs/style_guide.md`](../code_docs/style_guide.md). That
is the only copy: when you adopt the template, copy it into the repository as `docs/pr_guidelines.md` (the path the
tools and docs here link to) and fill in the project's specifics.

## Contents

```
.github/
  pr-automation.json             the config: every setting, at its default (edit this)
  pr-automation.schema.json      what each setting does, its type and default
  pull_request_template.md       Context / Changes / Testing / Screenshots / Issue
  rulesets/main.json             default branch: PRs only, approvals, the bot's status, linear history (rendered with the config)
  rulesets/branch-names.json     only branches named as branch.pattern says can be created
  workflows/
    precommit.yml                every PR: node --check, your npm scripts, tools/run-tests.mjs; read-only
    pr-policy.yml                every PR: tools/check-pr.mjs and tools/same-changes.mjs, from the default branch
    pr-bot.yml                   the bot: review and merge, keep PRs up to date, prune by hand
    pr-reviewed.yml              wakes the bot after a review (fork reviews get no write token)
    postcommit.yml               module: commit format and precommit on the default branch, after merges and weekly
    screenshots.yml              module, untrusted half: your screenshot script on the PR's base and the PR
    screenshot-comment.yml       module, trusted half: compare, store on a branch, comment; daily prune
    pages-trigger.yml            module: a push to any branch signals Pages, with no permissions
    pages.yml                    module: publish the default branch and every branch's preview, from the default branch
    stale.yml                    module: close stale PRs; prune merged and stale branches
    update-submodules.yml        module: push submodule bumps to branches, with a one-click "open the PR" link
tools/
  pr-config.mjs                  loads, merges and validates the config; a command line for workflows and setup
  pr-bot.mjs                     the PR bot
  check-pr.mjs                   the PR policy check (titles, branches, descriptions, files, commit messages)
  same-changes.mjs               does the commit "Tested at" names make the same changes as the head?
  restack.mjs                    replays commits as data in a fresh bare repository; compares changes
  screenshot-comment.mjs         the screenshot bot's trusted half
  png.mjs                        a bounded PNG decoder for comparing screenshots by their pixels
  pages.mjs                      assembles the Pages site from every branch, as git objects
  serve-branches.mjs             local branch previews: every branch at /<branch>/, from git, on 127.0.0.1
  run-tests.mjs                  runs every standalone suite in test/
  github-setup.sh                applies merge settings, Actions permissions, rulesets and labels (idempotent)
  merge-pr.sh                    an admin's fallback merge, with the right method and message
test/
  pr-bot.mjs, check-pr.mjs, same-changes.mjs, restack.mjs, pr-config.mjs, screenshot-comment.mjs, png.mjs,
  pages.mjs, serve-branches.mjs  the tools' tests, against fake GitHubs and real local git repositories
  module-order.mjs               no module's top-level main() runs before a const it uses is declared
  workflows.mjs                  the workflows' security properties, read from the files
  fixtures/                      the fake GitHubs, git helpers, a PNG writer, and the tests' config
(docs/pr_guidelines.md)          not here: copy ../code_docs/pr_guidelines.md in when adopting (see below)
(CONTRIBUTING.md, AGENTS.md)     not here either: templates in ../code_docs/, copied in when adopting
```

## Adopting it

1. **Copy the tree** into the repository's root: `.github/`, `tools/`, `test/`, [`../code_docs/pr_guidelines.md`](../code_docs/pr_guidelines.md)
   as `docs/pr_guidelines.md` (add the repository's own areas and required checks to it), and, if the
   repository has none, [`../code_docs/CONTRIBUTING.md`](../code_docs/CONTRIBUTING.md) and
   [`../code_docs/AGENTS.md`](../code_docs/AGENTS.md) into its root. Replace the placeholders (`OWNER/REPO`, `<project>`, the
   commands) in the docs. If the repository already has a `tools/` or `test/` with other files, the two live side by
   side: `tools/run-tests.mjs` runs every file in `test/` whose header has a `// Standalone suite:` line, yours too.
2. **Edit `.github/pr-automation.json`.** At least: `title.areas`, `testing.localChecks` (the lines each PR's Testing
   section must report: your test commands), `screenshots.requiredFor`, `forbidden.paths`, `precommit.scripts`, and the
   modules you want on. `node tools/pr-config.mjs check` validates it and says what's on. If the default branch isn't
   `main`, set `defaultBranch` and change `branches: [main]` in `pr-bot.yml` and `postcommit.yml` (a workflow's `on:`
   can't read a file).
3. **Delete the workflows of modules you don't want**, or leave them: each module's workflow reads its `enabled`
   setting first and skips everything when it's off, but it still starts a short run on its trigger.
4. **Run the setup script** as a repository admin: `tools/github-setup.sh OWNER/REPO` (add `--dry-run` first to see
   what it would do). It sets the merge method, deletes merged branches, makes the Actions token read-only by default
   and forbids Actions from approving or creating PRs, applies the rulesets with the config applied, and creates the
   labels. It's safe to re-run after a config change. It never publishes Pages ([Pages previews](#pages-previews)).
5. **Open the adoption PR.** Its own checks run from its own files (pr-policy reads the default branch's tools, which
   aren't there yet, so merge this first PR by hand: `tools/merge-pr.sh <n> --admin`). From then on the bot merges.

To run the tools' tests: `node tools/run-tests.mjs` (about two minutes; they make throwaway git repositories under
the system temp directory, and touch no network).

## How it works

### The PR bot

`tools/pr-bot.mjs review` sets the `pr-bot` status on every open PR and merges the first one that's ready. A PR is
ready when it:

- isn't a draft, has no conflict, and doesn't carry the `hold` label (`labels.hold`);
- is based on the default branch: a **stacked PR** (based on another PR's branch) waits with "Stacked on #N";
- is up to date with the default branch;
- has every check in `merge.requiredChecks` green on its head (by default `precommit` and `pr-policy`);
- has no reviewer requesting changes and no review request outstanding;
- has `merge.approvals` approvals of its head commit from people with write access (`merge.approverAssociations`), or
  `merge.ciApprovals` when it changes `merge.ciPaths` (CI, the rulesets, these tools): a PR's own workflows run from
  its files, so it could weaken what checks it;
- has a title that passes `tools/check-pr.mjs`.

It merges one PR per pass, since a merge puts every other PR behind. After its own merge it does what GitHub doesn't
do for a merge made with the workflow's token: it closes the issues the PR fixes, starts postcommit (if on), brings
the other PRs up to date, deletes the merged branch, and publishes Pages (if on). It runs after Precommit, PR Policy
and PR Reviewed finish (`workflow_run`), on label and ready-for-review changes (`pull_request_target`), after a push
to the default branch (a merge by hand), and by hand (Actions → PR Bot → Run workflow: `review`, `update`,
`prune-branches`). Nothing runs it on a schedule, except the stale module's daily prune.

**No code merges unreviewed.** A verdict on an older head is dismissed and its reviewer asked again, unless that head
makes exactly the same changes: one the bot rebuilt from (it follows its own force-pushes in the PR's timeline), or,
by `merge.carryApprovals`, any commit whose diff against the base is the same, file for file and line for line. With
`count` (the default) the bot counts that approval and says so on the PR; with `review` it posts an approval of the
head naming whose it carries (this needs "Allow GitHub Actions to create and approve pull requests", which also lets
any workflow approve PRs, so the setup script asks before allowing it); with `off` a new review is needed. A PR that
changes CI never carries an approval over.

### Keeping PRs up to date ("rebuilds")

After every merge (the bot's own, or one by hand through the push), and by hand (`update`), the bot brings every open
PR that's behind its base up to date (`rebuild.enabled`):

1. **Stacks move first.** A PR based on a merged PR's branch must be on the default branch before it's rebuilt. The
   bot doesn't change its base: GitHub refuses that for a PR in a stack. It deletes the merged PR's branch instead,
   and GitHub moves every open PR based on it to the merged PR's base. Only while that branch is still at the merged
   head (moved, the PRs would take any later commits in, unreviewed). It reads each PR back, and when GitHub closed or
   didn't move one, puts the branch back, reopens the PR and tries changing its base; if even that fails, it leaves
   the PR and says what to do.
2. **Replay.** Each PR's own commits are replayed onto the new base, or onto the rebuilt PR below it, bottom up.
3. **Same changes.** The rebuilt PR must add and remove exactly the lines it did before, file for file.
4. **Push with a lease** on the old head, so someone's push meanwhile is never overwritten.
5. **Checks.** The bot's push starts no `pull_request` runs, so it dispatches `rebuild.checkWorkflows` on the branch,
   and itself, `rebuild.reviewDelayMinutes` later, to merge once they pass.
6. **A comment** says it was rebuilt, once. A PR the bot can't or mustn't rebuild (a conflict, other changes, a fork,
   a CI change, `hold`, a branch shared by two PRs) is left as it was, with a comment saying why and the command to
   rebuild it by hand, once per head (and per base, for a conflict).

A `pr-bot-update` status on the default branch's head records that the PRs are up to date with it, so a run dropped
from the queue loses nothing: the next review sees no mark and does it.

### pr-policy and the "Tested at" model

CI runs what's cheap and safe to run on every PR (precommit). Everything else (browser suites, benchmarks, anything
that needs data or hardware CI doesn't have) the author runs locally, and reports in the PR's Testing section:

```markdown
## Testing

- Tested at 3f9c2e1.
- Ran `npm test`: 30 of 30 suites passed.
- Ran `npm run test:e2e`: 45 passed, 0 failed.
```

`pr-policy` requires a `Tested at <sha>` line and, for each of `testing.localChecks`, a line naming that check with a
result: a count that passed or failed, or `skipped: <why>`. A check with `paths` is required only of PRs that change
one of them. The SHA must be the PR's head, **or a commit that makes the same changes**: `tools/same-changes.mjs`
resolves it through the API, fetches it, the head and the base into an empty repository, and compares them. The head
must be exactly the tested commit's changes on the base the head is built on, either merged onto it in one go (a clean
rebase, "Update branch", the bot's rebuild of a plain PR) or its own last commits replayed onto it (a stacked PR
rebuilt after the PR below it merged, or was rebuilt with a conflict resolved, which the PR's timeline shows as a
force-push of its base). So a push that only brings the PR up to date keeps the author's results; a push that changes
what the PR does fails `pr-policy` until they re-test and update the line. When the tested commit was never pushed it
fails ("push the tested commit, or re-test this head"), and when the comparison itself fails, it fails closed. Run by
hand without git, `node tools/check-pr.mjs` takes the line at its word and warns.

This is an honour system for what CI doesn't run: `pr-policy` checks the report is there and for the current changes,
not that the tests ran.

### The modules

Each is a workflow (or two) and a section of the config with `enabled: false` by default.

- **postcommit** (`postcommit.yml`): on the default branch after each merge (the bot dispatches it after its own) and
  weekly: the merged commit's message (`git log -1 --format=%B | node tools/check-pr.mjs --commit`; not for rebase
  merges) and precommit's checks, called as a reusable workflow.
- **screenshots** (`screenshots.yml` + `screenshot-comment.yml`). **The hook:** an npm script, `screenshots.script`,
  that writes `<view>.png` files (lower case, digits, dashes) into the empty directory `$SCREENSHOTS_DIR`, optionally
  taking the views listed in `$SCREENSHOT_VIEWS` (`screenshots.views`, comma-separated). `screenshots.install` runs
  first if set (to install a browser, say). The untrusted workflow runs the script in a checkout of the PR's base and
  of the PR and uploads the two folders. The trusted one, from the default branch, checks every file, compares each
  view's pixels (`tools/png.mjs`; byte for byte when it can't decode one), stores the changed, new and removed views
  on `screenshots.branch` under `auto/pr-<n>/<sha>/`, and keeps one comment per PR with before/after tables. Make the
  script deterministic (fixed data, fonts, sizes; no clocks), or every view shows as changed.
- **pages** (`pages-trigger.yml` + `pages.yml`): the default branch at the site's root and, with `pages.previews`,
  every branch that has `pages.entry` under `pages.previewDir/<branch>/`. Only `pages.include` is published; see
  [Pages previews](#pages-previews) before turning it on.
- **stale** (`stale.yml`), daily: closes PRs with no activity for `stale.days` (actions/stale, without deleting their
  branches, since deleting a branch other PRs are based on closes them too), and runs the bot's `prune-branches`:
  branches with no open PR that are merged, or have had no commit for `branches.staleDays`. A PR based on a branch it
  prunes is moved to the default branch first. `branches.keep` and the screenshot branch are never pruned.
- **submodules** (`update-submodules.yml`), daily: for each of `submodules.bumps` whose submodule moved, pushes the
  bump to its branch and puts an "Open the pull request" link in the run summary. A person opens the PR (a workflow
  opening it would need Actions allowed to create PRs, which also allows approving them), and it goes through review
  like any other. The bump branches are exempt from the branch-name rule.
- **local previews** (`tools/serve-branches.mjs`, no workflow): every branch of a remote, served at once on your own
  machine, each at `/<branch>/`, straight from git. See [Local branch previews](#local-branch-previews).

## Configuration

`.github/pr-automation.json`, merged over the defaults in `tools/pr-config.mjs` (objects key by key, lists replaced).
Every field is documented in [`.github/pr-automation.schema.json`](.github/pr-automation.schema.json); editors that
read `$schema` complete and check it. Unknown keys and unsafe values (a script name that could be an option, a branch
name git would refuse, a bad regex, a path that climbs out of the repository) are errors, reported all at once.

| Section | What it sets |
|---|---|
| `defaultBranch` | the branch PRs merge into (`main`) |
| `title` | `areas` (the `[Area]` tags), `maxTags`, `qualifiers` (`Fix:` …), `maxLength`, `titleCase`, `imperative`, `example` |
| `branch` | `pattern`: `user` (`<username>/<name>`), `prefix` (`<prefix>/<name>`), `regex`, or `any`; `prefixes`, `regex`, `exempt` |
| `description` | `requiredSections`, `pastTenseSections` (a warning), extra `sensitivePatterns` no description may contain |
| `testing` | the `section`'s name, `requireTestedAt`, and `localChecks`: `{ name, match, paths?, why? }` |
| `forbidden` | `paths` no PR may add (credentials and private keys by default) and the `message` |
| `merge` | `method` (`squash`, `merge`, `rebase`), the bot's `status` name, `requiredChecks`, `approvals`, `ciApprovals`, `ciPaths`, `approverAssociations`, `carryApprovals` |
| `rebuild` | `enabled`, `checkWorkflows` to dispatch on a rebuilt PR, `reviewDelayMinutes` |
| `ruleset` | `requiredChecks` for the default branch's ruleset (only the bot's status: see the quirks) |
| `branches` | `staleDays` for pruning, branches to `keep` |
| `labels` | `hold`, and `extra` labels for the setup script |
| `precommit` | `syntaxCheck`, `npmCi`, `scripts`, `runTests` |
| `postcommit`, `screenshots`, `pages`, `stale`, `submodules` | the modules, each with `enabled` (above) |
| `localPreviews` | the local previews: `remote`, `port`, `fetchSeconds`, `entry`, `submodules` served at each branch's pinned commit, an optional `marker` meta tag and `titlePrefix`, extra content `types` |

`screenshots.requiredFor` (paths whose change needs a Screenshots section with an image) works with the module off
too: then the author drags an image in, or pushes it to `screenshots.branch` under `pr-<n>/` and links
`https://github.com/OWNER/REPO/blob/<branch>/pr-<n>/<file>.png?raw=true`, which shows in a private repository too
(a `raw.githubusercontent.com` link doesn't). With the module on, "See the Screenshots comment" also passes.

## Security model

The bot holds a write token, and PRs are untrusted code, often from forks. These properties hold everywhere, and
`test/workflows.mjs` checks the ones that live in the workflow files:

- **Privileged workflows never check out or run PR code.** `pull_request_target`, `workflow_run`, schedules and
  dispatches check out the default branch (`ref: ${{ github.event.repository.default_branch }}`) and run its tools.
  `workflow_run` runs the default branch's copy of the workflow file whatever triggered it, so a PR can't change
  them either. `pr-policy` runs on `pull_request` with a read-only token, but still runs the default branch's checker,
  never the PR's or its base's.
- **Event text reaches scripts only through `env:`**, never through `${{ }}` inside `run:`, where a PR title like
  `"; curl … | sh` would become shell code. Values are then quoted, and the config's values that reach a shell are
  validated against strict patterns first.
- **Fork artifacts are data.** The screenshot artifact must be two plain directories of regular PNG files with strict
  names and bounded sizes; symlinks, other files and other names are refused. Pixels are read with a bounded decoder
  (it never inflates past what the header allows, and refuses images over a pixel budget). Nothing from the files
  reaches the comment except the validated view names; the reason for a refusal stays in the log, never on the PR.
- **Rebuilds replay commits as data.** `tools/restack.mjs` fetches the commits by SHA into a fresh, empty bare
  repository (no template, so no hooks) and replays them with `git merge-tree` and `git commit-tree`: nothing is ever
  checked out. `core.hooksPath` points nowhere and pushes skip hooks; the system and global config are ignored and
  attributes are read from an empty tree, so no filter, textconv, merge or diff driver can run; submodules are never
  fetched; objects are checked as they're fetched; only `https://` and `file://` remotes; the token goes in an HTTP
  header for that host only, masked in the log. Pushes use `--force-with-lease` on the head the bot rebuilt from.
- **Same-changes verification.** A rebuilt PR must make exactly the changes it made before, or it isn't pushed; a
  "Tested at" SHA from a description is used only after the API resolved it to a full commit SHA that starts with it.
  The bot never rebuilds a PR that changes CI or the PR tools, and a rebuilt PR's `.github/` must be the default
  branch's, since its dispatched checks run from the branch's workflow files.
- **Least privilege.** Every workflow declares `permissions:`; privileged ones grant per job only what that job uses.
  Workflows that run a PR's code have no write permission at all. Checkouts keep no credentials
  (`persist-credentials: false`), except the submodule bump, which pushes and runs only the default branch's code.
- **Validated dispatch inputs.** `pr-bot.yml`'s `delay` must be one or two digits; `pr-policy.yml`'s `pr` must be a
  number, and a dispatched run checks the PR is open, in this repository, with this branch at this run's commit.
- **No trigger loops.** The bot's pushes, merges and deletions use `GITHUB_TOKEN`, which starts no workflows (only
  dispatches, which the bot makes on purpose, once each). So its own pushes can't wake it again.
- **No workflow can approve.** The setup script forbids Actions from creating or approving PRs, so no workflow can
  stand in for a reviewer; the bot never submits reviews unless `merge.carryApprovals` is `review` and you allowed it.

- **The local preview server stays local.** `tools/serve-branches.mjs` listens on `127.0.0.1` unless `--host` says
  otherwise, refuses public and VPN-range addresses (and `0.0.0.0` while the machine has one), and has no way to be
  published. A request's path is only a key into the branch tip's file list (from `git for-each-ref` and
  `git ls-tree`): nothing from the URL reaches git as a ref or path expression, `..` is refused, symbolic links aren't
  served, and the working tree is never read (`test/serve-branches.mjs`).

Third-party actions are referenced by tag (`actions/checkout@v7` …). For supply-chain safety, pin them to commit
SHAs, and let a bot like Dependabot keep the pins current.

**Known limits.** The rules guarantee that every change is approved by someone other than its author (or merged with
an admin's deliberate bypass). Anyone with write access can still run their own workflow on their own branch and post
a green `pr-bot` status, or press Merge where rulesets aren't enforced: give write access only to people you trust
with that. Fork contributors can't, since fork PRs get read-only tokens. A PR's own `pull_request` workflows run from
its files, so it can weaken its own precommit: that's why CI changes need more approvals. The screenshot branch isn't
protected, so treat screenshots as a review aid. And the Testing section is the author's word.

## Plan caveats

- **Rulesets aren't enforced on private repositories on GitHub Free.** The API refuses them ("Upgrade to GitHub Pro",
  and the setup script says so and goes on). There, the bot's own checks are the only gate: it never merges a PR that
  isn't ready, but anyone with write access can press Merge or push to the default branch. Upgrade, or keep write
  access to people who won't.
- **On paid plans, a private repository's Pages site is still public** unless your plan offers private Pages (GitHub
  Enterprise Cloud) and you choose it, or you unpublish it. Every preview of every branch is on it.
- **Merge queues** aren't available for repositories owned by a personal account; the bot's rebuild-then-merge
  gives the same guarantee (what merges was checked on what it lands on) without one.
- On GitHub Enterprise Server, the GitHub Actions app's id in `.github/rulesets/main.json` (15368, github.com's) may
  differ.

### Pages previews

Turning the Pages module on publishes the default branch, and with `pages.previews` every branch with an entry file,
to `https://OWNER.github.io/REPO/`. That makes each branch's files reachable by anyone on the internet, whatever the
repository's visibility, and runs every branch's code, reviewed or not, on the live site's origin: a preview can read
and change the live site's cookies and storage. The publisher marks each preview's entry file with
`<meta name="branch-preview" content="<branch>">` so your site can keep a preview's storage keys apart, but that's a
convenience, not a boundary. The private alternative is to leave the module off (or `pages.previews: false`, for the
default branch only) and preview locally, with [local branch previews](#local-branch-previews). If you do turn it on:
Settings → Pages → Source: GitHub Actions; Settings → Environments → `github-pages` → deployment branches: the
default branch only, so no branch's own workflow file can deploy.

### Local branch previews

`tools/serve-branches.mjs` serves every branch of a remote at once, on your own machine: `http://127.0.0.1:8000/`
lists the branches whose tip has `localPreviews.entry`, newest first, and each is at `/<branch>/` (the branch
`alice/menu-focus` at `/alice/menu-focus/`). It reads the files straight from git (the branch's tip as the last fetch
saw it), so nothing is checked out and the working tree doesn't matter, and it fetches the remote every
`localPreviews.fetchSeconds` (`--fetch <seconds>`; `0`: never). A path under one of `localPreviews.submodules` comes from
the submodule commit that branch pins, fetched into the submodule's clone when it's missing. Add the start command to
`package.json`:

```json
"scripts": { "serve:branches": "node tools/serve-branches.mjs" }
```

and run `npm run serve:branches` (options: `--port`, `--fetch`, `--remote`, `--repo`, `--host`). It serves files as
they are, unless you set `localPreviews.marker`: then every HTML page gets `<meta name="<marker>" content="<branch>">`
after `<head>`, so your app can tell a preview, and which branch, from the real site (to keep each branch's stored
settings apart, say), and `localPreviews.titlePrefix` puts the branch in the tab's title.

**It's for this machine.** It listens on `127.0.0.1` only, and has no authentication. To open the previews from a
phone or tablet, `--host <your LAN address>` (or `--host 0.0.0.0`) also listens on your local network, and prints the
addresses to open and a warning: **anyone on that network can read every branch**, with no password or login.
Never forward the port on a router, or tunnel or proxy it to the internet. On Windows, when asked whether Node may
accept connections, allow it on private networks only. The server refuses a public address, a VPN-range one
(`100.64.0.0/10`), or `0.0.0.0` while the machine has either, so it can't be bound to the internet by accident.

## GitHub quirks we learned

- **Pushes made with `GITHUB_TOKEN` start no `pull_request` runs** (nor push, nor anything but dispatches). In a
  private repository they also leave held runs on the PR, "This workflow requires approval from a maintainer", as if
  the Actions bot were a first-time contributor. The bot leaves them (GitHub's endpoint for approving runs is meant
  for fork PRs) and dispatches the checks itself.
- **`workflow_dispatch` check runs don't satisfy a ruleset's required checks**, even with the right name, on the PR's
  head commit. So the default-branch ruleset requires only the bot's status (`ruleset.requiredChecks`), and the bot
  requires the check runs itself (`merge.requiredChecks`), which it reads by name from the commit. Runs that a
  dispatch started also count as the bot's, so their results start no `workflow_run`: hence the bot's delayed review.
- **`workflow_run` always runs the default branch's copy of the workflow**, whatever branch triggered it. That's what
  makes it safe for privileged work, and why a change to such a workflow only takes effect once merged.
- **"Cannot change the base branch because the pull request is part of a stack"** (422): GitHub refuses changing the
  base of a PR that other PRs are based on.
- **Deleting a merged PR's head branch makes GitHub move the PRs based on it** to the merged PR's base. Deleting an
  unmerged branch that PRs are based on closes them instead (and GitHub has also closed them when a merged branch was
  deleted a second after the merge). Hence: the bot moves stacks by deleting the merged branch, reads them back, and
  puts the branch back if they were closed; pruning moves PRs to the default branch before deleting a branch.
- **Force-pushed-away commits stay fetchable by SHA**, so a tested commit that a rebase replaced can still be compared
  with the new head. A commit that was never pushed can't.
- **The plain merge endpoint refuses a PR with others stacked on it** and asks for the asynchronous one, whose answer
  keeps its fields under `details`, and whose result can be lost even though the PR merged: the bot checks the PR.
- **A merge made with `GITHUB_TOKEN` doesn't close the issues the PR fixes**, so the bot does.
- **Review events from forks get a read-only token**: hence `pr-reviewed.yml`, which does nothing but wake the bot.
- **Without enforced rulesets, GitHub leaves reviews on the commit they were given on**; with "dismiss stale
  approvals" it moves them to a new head only when the diff didn't change. The bot follows its own force-pushes
  instead of relying on either.
- **A `raw.githubusercontent.com` image link doesn't show in a private repository**; `…/blob/<branch>/<path>?raw=true`
  does, for anyone who can see the repository.
- **A top-level `await main()` runs before the `const`s below it are initialised** when the file is run as a command,
  but not when a test imports it: `test/module-order.mjs` keeps every entry call last.

## Admins

The bot never merges a PR its only maintainer opened, since nobody else can approve it. Merge those with
`tools/merge-pr.sh <n> --admin` (the rulesets let repository admins bypass, but only when merging a PR), after the
checks pass: it uses the configured method and message, refuses a bad title, and pins the head you looked at. Once
there's a second maintainer, remove the bypass from `.github/rulesets/main.json` and review each other's PRs.

`GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=OWNER/REPO node tools/pr-bot.mjs branches` reports every branch
(age, PR, ahead/behind, what a prune would do) without changing anything; add `--dry-run` to `review`, `update` or
`prune-branches` to preview them.
