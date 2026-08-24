#!/usr/bin/env bash
#
# Step 2 of the two-step install: put the artifacts where OpenCode can find them.
#
# OpenCode does NOT auto-discover skills, agents or commands from inside an
# installed plugin. Registering the plugin in opencode.json (Step 1) makes the
# hook layer run; it does not make any skill exist. Skipping this script is a
# SILENT partial install — the plugin loads, nothing errors, and the commands
# and skills simply are not there.
#
# This script therefore does three things the sibling ports' installers do not:
#   * refuses to overwrite any existing file without --force, listing EVERY
#     collision and copying nothing;
#   * verifies after copying, byte for byte, and fails loudly naming each file
#     that is missing or corrupt — a partial copy is the failure this exists to
#     catch, so a check that cannot fail is not verification;
#   * warns when the plugin is not registered in any opencode.json it can see,
#     because that is the OTHER half of the two-step trap.
#
# Usage: install.sh [--global] [--force] [--help]
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
MODE="project"
FORCE=0

usage() {
  cat <<'USAGE'
install.sh — install stride-opencode-lite's skills, agents, commands and lib
             specs where OpenCode discovers them.

  install.sh              install into ./.opencode/         (project-local)
  install.sh --global     install into ~/.config/opencode/  (all projects)
  install.sh --force      overwrite files that are already there
  install.sh --help       this message

This is STEP 2 of a two-step install. Step 1 is registering the plugin in
opencode.json:

    { "plugin": ["github:cheezy/stride-opencode-lite"] }

Neither step works without the other. Step 1 alone gives you hooks and no
skills; step 2 alone gives you skills and no hooks.

--force overwrites single files, and REPLACES each stride-opencode-lite skill
directory wholesale (removing it first), so a file dropped from a skill in a
later release does not survive as a stale sibling.

Nothing here needs elevated privileges. If you are reaching for sudo, the
target path is wrong.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --global) MODE="global" ;;
    --force)  FORCE=1 ;;
    --help|-h) usage; exit 0 ;;
    *)
      # Never ignore an unknown argument: a mistyped --forse must not install
      # anyway and report success.
      printf 'install.sh: unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# Preflight the source. Deliberately NO git-clone fallback: a fallback keyed on
# "the surface looks incomplete" would silently repair a mutilated checkout by
# replacing it, which makes the verification below unfalsifiable.
if [ ! -f "$SRC/package.json" ] || [ ! -d "$SRC/skills" ]; then
  printf 'install.sh: %s does not look like a stride-opencode-lite checkout.\n' "$SRC" >&2
  printf 'Clone the repository and run this script from its root.\n' >&2
  exit 1
fi

if [ "$MODE" = "global" ]; then
  DEST_ROOT="$HOME/.config/opencode"
else
  DEST_ROOT="$PWD/.opencode"
fi

# The manifest is ENUMERATED from the source, never hard-coded: a literal list
# goes stale the first time a skill is added, which is the drift this port has
# already had to fix once elsewhere.
manifest() {
  (
    cd "$SRC" || exit 1
    # ONE predicate — used by the collision preflight, the copy, the byte
    # verification AND the git cross-check below. They used to differ, which
    # left a non-.md file in a skill copied but unverified and outside the
    # clobber guard. Anything not matched here is not installed at all.
    find skills -mindepth 1 -type f -name '*.md' -print
    find agents commands lib -maxdepth 1 -type f -name '*.md' -print
  )
}

skill_dirs() {
  ( cd "$SRC/skills" && find . -mindepth 1 -maxdepth 1 -type d -print | sed 's|^\./||' )
}

# --- Clobber preflight ---------------------------------------------------
# Per PATH, not per directory: $DEST_ROOT/skills exists for anyone who has any
# other skill installed, so a directory-level guard would make --force
# mandatory in practice and protect nothing.
#
# And it runs BEFORE any file is written. A refusal that aborts mid-copy would
# create the partial install this whole script exists to prevent.
COLLISIONS=""
while IFS= read -r rel; do
  dest="$DEST_ROOT/$rel"
  # -L as well as -e: test -e dereferences, so a dangling symlink reads as
  # absent and the copy would follow it.
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    COLLISIONS="$COLLISIONS  $rel
"
  fi
done <<EOF
$(manifest)
EOF

if [ -n "$COLLISIONS" ] && [ "$FORCE" -ne 1 ]; then
  printf 'install.sh: refusing to overwrite %d existing file(s) under %s:\n' \
    "$(printf '%s' "$COLLISIONS" | grep -c .)" "$DEST_ROOT" >&2
  printf '%s' "$COLLISIONS" >&2
  printf '\nNothing was copied. Re-run with --force to overwrite, or move these aside.\n' >&2
  exit 1
fi

# --- Copy ----------------------------------------------------------------
mkdir -p "$DEST_ROOT/skills" "$DEST_ROOT/agents" "$DEST_ROOT/commands" "$DEST_ROOT/lib"

# --force purges each skill directory first, so a file dropped from a skill in
# a later release does not survive as a stale sibling.
if [ "$FORCE" -eq 1 ]; then
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ -d "$DEST_ROOT/skills/$name" ] && rm -rf "${DEST_ROOT:?}/skills/${name:?}"
  done <<EOF
$(skill_dirs)
EOF
fi

# THE COPY IS DRIVEN BY THE MANIFEST, path by path. It used to be `cp -R` of
# each skill directory, which made the copy a THIRD predicate broader than the
# other two: a non-.md file in a skill would be installed while sitting outside
# the collision preflight and outside the byte verification — installed
# unverified, and overwritten without --force being required. One predicate now
# governs the preflight, the copy and the verification alike.
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  mkdir -p "$DEST_ROOT/$(dirname "$rel")"
  # cp -p preserves bytes and mode. Never a read/rewrite round trip: byte
  # identity with stride-lite is the product here.
  cp -p "$SRC/$rel" "$DEST_ROOT/$rel"
done <<EOF
$(manifest)
EOF

# --- Verification --------------------------------------------------------
# Re-enumerated INDEPENDENTLY of the copy above. A verification that re-reads
# the list the copy consumed passes exactly when that list is wrong, which is
# the bug class it exists to catch — the same reasoning as test/smoke.sh's two
# independently-coded extractors.
MISSING=""
DIFFERING=""
EMPTY_SOURCE=""
INSTALLED=0
EXPECTED=0

while IFS= read -r rel; do
  EXPECTED=$((EXPECTED + 1))
  src="$SRC/$rel"
  dest="$DEST_ROOT/$rel"

  if [ ! -f "$dest" ]; then
    # -f, not -e: a directory or a symlink at a destination path is a failure.
    MISSING="$MISSING  $rel
"
  elif [ ! -s "$dest" ]; then
    # Attribute it correctly: if the SOURCE is empty too, the copy was perfect
    # and the source is the problem. Blaming the destination sends the reader
    # to the wrong file.
    if [ ! -s "$src" ]; then
      EMPTY_SOURCE="$EMPTY_SOURCE  $rel (empty)
"
    else
      DIFFERING="$DIFFERING  $rel (empty)
"
    fi
  elif ! cmp -s "$src" "$dest"; then
    DIFFERING="$DIFFERING  $rel (content differs from source)
"
  else
    INSTALLED=$((INSTALLED + 1))
  fi
done <<EOF
$(manifest)
EOF

# --- The independent record ----------------------------------------------
# Everything above enumerates from $SRC, so it structurally CANNOT see a file
# missing from the source itself: an absent file is simply never enumerated,
# and "14 of 14 verified" would be true and useless. That is the partial-copy
# bug class one level up, and it needs a record the source cannot edit by
# losing a file.
#
# git is that record. In a real checkout — which is the actual install
# scenario, since Step 2 says clone and run — a deleted file is still TRACKED,
# so `git ls-files` still lists it and the gap shows.
COUNT_DRIFT=""
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  TRACKED="$(git -C "$SRC" ls-files -- skills agents commands lib 2>/dev/null \
             | grep -E '\.md$' | sort)"
  ENUMERATED="$(manifest | sort)"
  if [ -n "$TRACKED" ] && [ "$TRACKED" != "$ENUMERATED" ]; then
    ABSENT="$(comm -23 <(printf '%s\n' "$TRACKED") <(printf '%s\n' "$ENUMERATED"))"
    if [ -n "$ABSENT" ]; then
      COUNT_DRIFT="$COUNT_DRIFT  tracked in git but absent from the source tree:
$(printf '%s' "$ABSENT" | sed 's/^/    /')
"
    fi
  fi
else
  # Not a checkout — a tarball, or a staged copy. Say so rather than implying a
  # completeness guarantee that was not checked.
  NO_GIT_RECORD=1
fi

# Decisive-path check, the stride-lite precedent: one artifact without which the
# install is inert whatever the counts say. Not a count, so it does not go stale.
for decisive in skills/stride-opencode-lite-workflow/SKILL.md \
                skills/stride-opencode-lite-init/SKILL.md; do
  [ -f "$DEST_ROOT/$decisive" ] || COUNT_DRIFT="$COUNT_DRIFT  $decisive did not land
"
done

# Every category must be non-empty. Catches a wholly missing source directory,
# which the per-path loop also cannot see.
for dir in skills agents commands lib; do
  n=$(find "$DEST_ROOT/$dir" -mindepth 1 | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] || COUNT_DRIFT="$COUNT_DRIFT  $dir/ is empty after install
"
done
d_skills=$(find "$DEST_ROOT/skills" -mindepth 1 -maxdepth 1 -type d -name 'stride-opencode-lite-*' | wc -l | tr -d ' ')

if [ -n "$MISSING" ] || [ -n "$DIFFERING" ] || [ -n "$EMPTY_SOURCE" ] || [ -n "$COUNT_DRIFT" ] || [ "$INSTALLED" -ne "$EXPECTED" ]; then
  printf 'install.sh: INSTALL IS INCOMPLETE — %d of %d files verified at %s\n' \
    "$INSTALLED" "$EXPECTED" "$DEST_ROOT" >&2
  # Name the paths. "12 of 14" without saying which two is not actionable.
  [ -n "$MISSING" ]     && { printf 'Missing after copy:\n' >&2;   printf '%s' "$MISSING" >&2; }
  [ -n "$DIFFERING" ]   && { printf 'Corrupt after copy:\n' >&2;   printf '%s' "$DIFFERING" >&2; }
  [ -n "$EMPTY_SOURCE" ] && { printf 'Empty in the source:\n' >&2;  printf '%s' "$EMPTY_SOURCE" >&2; }
  [ -n "$COUNT_DRIFT" ] && { printf 'Count mismatch:\n' >&2;       printf '%s' "$COUNT_DRIFT" >&2; }
  # No rollback: deleting here risks removing content that --force legitimately
  # overwrote. Say loudly what is wrong and leave it.
  printf 'Do not use this install. Fix the cause and re-run with --force.\n' >&2
  exit 1
fi

printf 'Verified %d of %d files at %s (byte-identical to source).\n' \
  "$INSTALLED" "$EXPECTED" "$DEST_ROOT"
if [ "${NO_GIT_RECORD:-0}" -eq 1 ]; then
  printf '  (source is not a git checkout, so completeness of the SOURCE was not\n'
  printf '   verified — only that everything present in it was copied intact.)\n'
fi
printf '  Skills:   %s\n' "$d_skills"
printf '  Agents:   %s\n' "$(find "$DEST_ROOT/agents" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')"
printf '  Commands: %s\n' "$(find "$DEST_ROOT/commands" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')"
printf '  Lib:      %s\n' "$(find "$DEST_ROOT/lib" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')"

# --- Advisory: is the plugin actually registered? ------------------------
# Artifacts on disk with no plugin registration is the other half of the
# two-step trap, and it is the only thing that makes the two-step story
# operative rather than merely documented. Advisory: the plugin may be
# registered somewhere this script cannot see.
REGISTERED=0
for cfg in "$PWD/opencode.json" "$HOME/.config/opencode/opencode.json"; do
  [ -r "$cfg" ] && grep -q 'stride-opencode-lite' "$cfg" && REGISTERED=1
done
if [ "$REGISTERED" -eq 0 ]; then
  printf '\ninstall.sh: NOTE — the artifacts are installed, but no opencode.json I can\n' >&2
  printf 'see registers this plugin, so no hook section will ever fire. That is step 1\n' >&2
  printf 'of the two-step install:\n\n    { "plugin": ["github:cheezy/stride-opencode-lite"] }\n\n' >&2
  printf 'See README.md. (If you registered it elsewhere, ignore this.)\n' >&2
fi

# --- Advisory: name collisions with the full Stride plugin ---------------
if [ "$MODE" = "global" ] && [ "$FORCE" -eq 1 ]; then
  printf '\ninstall.sh: NOTE — agents/task-explorer.md and agents/task-reviewer.md are\n' >&2
  printf 'generic names that the full stride-opencode plugin also ships. A global\n' >&2
  printf '--force install may have overwritten its copies. Prefer a project-local\n' >&2
  printf 'install when both plugins are in play.\n' >&2
fi
