# Worktrunk workflows

Project configuration lives in [`.config/wt.toml`](../.config/wt.toml). Use Worktrunk **0.80+**; the locked Nix development shell supplies it alongside Node.js, Git, Azure CLI, and Hunk. Pi must already be installed/authenticated on your PATH; these workflows reuse your Pi configuration and do not install plugins or change your global settings.

```sh
nix develop
wt config alias show
wt hook show
```

The interactive Nix Bash shell initializes Worktrunk's directory-switching integration for that session. Outside the shell, use your existing Worktrunk shell integration, or follow `wt config shell install`. Launching Pi works without shell integration, but your parent terminal won't follow worktree directory changes.

## Start a worktree in Pi

```sh
wt new-pi --name=feat/publish-comments
```

Or supply a startup prompt:

```sh
wt new-pi --name=feat/publish-comments -- 'Implement explicit publishing of Hunk review notes to ADO.'
```

This creates the branch from the repository's **local default branch**, creates its worktree at your configured Worktrunk location, installs locked dependencies, then launches Pi in the new worktree inside `nix develop`. It does not fetch or update main first.

Arguments after `--` are forwarded to Pi. `--name` must precede that separator. To just create/switch without launching Pi, use the normal `wt switch --create BRANCH` command.

### Open an existing worktree

```sh
wt pi                             # current worktree
wt pi --name=feat/publish-comments # switch to a branch/worktree, then open Pi
wt pi --name=feat/publish-comments -- 'Continue the review workflow.'
```

A missing worktree for an existing branch is created and gets the same dependency hook. Merely switching to an existing worktree does not reinstall dependencies. Run `wt hook pre-start project:dependencies` explicitly when you need to repeat setup.

## Dependency and merge hooks

`pre-start` runs synchronously on creation:

```sh
nix develop --command npm ci --include=dev --ignore-scripts --legacy-peer-deps
```

Using a blocking hook, rather than a background `post-start` hook, ensures installation finishes before `--execute` launches Pi. Development dependencies are included even when your environment defaults to production; npm lifecycle scripts are not executed.

The `pre-merge` pipeline runs after Worktrunk's rebase step, before the target branch moves:

1. Reinstall dependencies from the resulting lockfile using the same `npm ci` command.
2. Run `npm run check` (TypeScript + tests) and `nix flake check` concurrently.
3. Any failed install/check stops the merge. A failed install prevents the check stage from starting.

These hooks also apply to ordinary `wt merge`, not only the finish workflow.

**Approve the project commands when Worktrunk prompts.** Worktrunk's hook gate is local, not a branch-protection policy: `--no-hooks`, disabling verification in user config, or declining hook approval can bypass checks. In particular, Worktrunk continues an operation without project hooks if their approval is declined. Do not decline and assume the merge was blocked. Hook failures after execution do block the operation. Changed commands require renewed approval.

The project does not automatically approve hooks, install global shell integration, copy ignored files/credentials, run `direnv allow`, or start Pi in background hooks. Your ignored personal `.envrc` is not copied into new worktrees; supply any account-specific environment (such as `GH_CONFIG_DIR`) through your own shell configuration.

## Review progress in Hunk

```sh
wt review
wt review --target=main
```

This opens the entire net change from the target's merge base through the working tree: **committed, staged, unstaged, and untracked non-ignored files**. It uses `wt step diff`, not just `git diff`, so committed branch changes and new files aren't missed.

The script writes a private temporary patch, opens `hunk patch` with interactive stdin intact, then removes the patch when Hunk exits. It does not stage files or change the index. This is a local Git review, not an ADO fetch; review notes do not publish anywhere.

## Finish a worktree

Commit your intended changes first, then:

```sh
git add -- path/to/changed/files
git commit -m "feat: publish review comments"
wt finish
```

`wt finish`:

1. Requires a branch other than the target, with no tracked/untracked outstanding changes.
2. Requires the local target to be an ancestor of your branch. If it has diverged, explicitly rebase and resolve conflicts **before** reviewing again.
3. Opens the resulting branch patch in Hunk.
4. After you close Hunk, verifies neither source nor target changed and the checkout is still clean.
5. Asks `Merge … into … and let Worktrunk clean up the worktree? [y/N]`.
6. Only after an explicit yes, runs `wt merge TARGET --no-commit --no-rebase`. Approved pre-merge hooks run before the merge; no implicit commit, squash, or rebase changes what you reviewed.

Closing Hunk alone is **not** approval. No/Enter/EOF cancels; diff/Hunk errors and detected source/target changes stop the workflow. An empty diff is not merged. The workflow does not claim to lock out simultaneous external Git operations: do not run another agent that edits the same worktree during finishing.

Worktrunk performs its normal cleanup after a successful merge, subject to your settings and protections for primary/locked worktrees. Shell integration returns you to the target worktree. This is a **local merge**, not a push; push main explicitly when ready:

```sh
git push origin main
```

Use `wt finish --target=OTHER_LOCAL_BRANCH` for a different target. Flags after the alias are not forwarded to `wt merge`; bypass flags are deliberately not part of this workflow. The finish/review aliases use a foreground script because lifecycle hooks receive JSON stdin, not an interactive terminal.

## Inspect without executing

```sh
wt hook pre-start --dry-run
wt hook pre-merge --dry-run
wt config alias dry-run new-pi -- --name=feat/publish-comments 'Startup prompt'
wt config alias dry-run pi -- --name=feat/publish-comments
wt config alias dry-run review
wt config alias dry-run finish
```

These previews do not create worktrees, start Pi/Hunk, or merge branches.

## Validation

`npm run check` includes workflow tests using disposable Git repositories and fake Pi/Hunk-adjacent commands, without touching this repository's branches. When Worktrunk is installed, additional integration tests exercise real hook ordering, failure propagation, alias expansion, and full-diff/index behavior. Use `nix develop --command npm run check` to ensure Worktrunk is available; those Worktrunk-specific tests skip outside an environment that provides it.

`nix flake check` also runs ShellCheck on the workflow script.

References: [Worktrunk hooks](https://worktrunk.dev/hook/), [aliases and interactive stdin](https://worktrunk.dev/extending/), [switch/execute](https://worktrunk.dev/switch/), [merge semantics](https://worktrunk.dev/merge/).
