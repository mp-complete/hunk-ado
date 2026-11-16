#!/usr/bin/env bash
# Explicit interactive review/finish workflows, called by .config/wt.toml.
set -euo pipefail

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

if [[ $# != 2 || ( "$1" != review && "$1" != finish ) ]]; then
  die "Usage: worktree.sh <review|finish> <local-target-branch>"
fi
mode=$1
target=$2
cd -- "$(git rev-parse --show-toplevel)"
if [[ "$target" == -* ]] || ! git check-ref-format "refs/heads/$target" >/dev/null; then
  die "Invalid target branch."
fi
target_ref="refs/heads/$target"
target_commit=$(git rev-parse --verify "$target_ref^{commit}") ||
  die "Target must be an existing local branch."
source_commit=$(git rev-parse --verify HEAD)
branch=$(git symbolic-ref --quiet --short HEAD) ||
  die "Switch to a branch before reviewing or finishing."

require_clean() {
  [[ -z "$(git status --porcelain --untracked-files=normal)" ]] ||
    die "Commit or remove outstanding changes first. Use wt review for an in-progress review."
}

require_unchanged() {
  [[ "$(git symbolic-ref --quiet --short HEAD)" == "$branch" &&
     "$(git rev-parse HEAD)" == "$source_commit" &&
     "$(git rev-parse --verify "$target_ref^{commit}")" == "$target_commit" ]] ||
    die "The source or target changed during review. Run wt finish again."
  require_clean
}

if [[ "$mode" == finish ]]; then
  [[ "$branch" != "$target" ]] || die "Cannot finish the target branch itself."
  require_clean
  git merge-base --is-ancestor "$target_ref" HEAD ||
    die "Rebase onto $target explicitly, resolve conflicts, then rerun wt finish to review the resulting commits."
fi

# A file (not a pipe into Hunk) preserves interactive stdin, propagates diff errors,
# and allows Hunk to reload the patch while it is open. Never touch Git's index.
umask 077
patch_dir=$(mktemp -d "${TMPDIR:-/tmp}/hunk-ado-worktree.XXXXXX")
trap 'rm -rf -- "$patch_dir"' EXIT
patch="$patch_dir/review.diff"
wt step diff "$target" -- --no-ext-diff --no-textconv --no-color --binary --full-index > "$patch"

if [[ ! -s "$patch" ]]; then
  printf 'No changes to review against %s.\n' "$target"
  if [[ "$mode" == finish ]]; then exit 1; fi
  exit 0
fi

hunk patch "$patch"

if [[ "$mode" == finish ]]; then
  require_unchanged
  printf '\nMerge %s into %s and let Worktrunk clean up the worktree? [y/N] ' "$branch" "$target" >&2
  answer=
  read -r answer || die "Merge cancelled."
  case "$answer" in
    y|Y|yes|YES) ;;
    *) die "Merge cancelled." ;;
  esac
  require_unchanged
  # Do not silently rewrite the reviewed commits or stage additional changes.
  # Worktrunk's approved pre-merge hooks run before the target branch moves.
  wt merge "$target" --no-commit --no-rebase
fi
