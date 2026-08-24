#!/usr/bin/env bash
#
# Template-parity smoke checks.
#
# The taskN.md template is reproduced verbatim in BOTH create skills, and the
# init skill embeds the canonical .stride_lite.md template. Nothing but a check
# keeps those copies in step, so this is that check.
#
# It is built to not be vacuous, because the naive form of it is. The sibling
# lite port shipped a single-extractor version that compared one extraction
# against another produced the same way — and when both came back empty, empty
# equalled empty and the assertion passed while guarding nothing. So:
#
#   * two INDEPENDENTLY CODED extractors per comparison (awk state machine vs
#     sed window pipeline), so one parsing bug cannot make both sides agree;
#   * a non-empty precondition on each extraction, asserted separately;
#   * structural completeness on each side, so a truncated or over-captured
#     extraction is caught rather than compared;
#   * a sha256 pin against the stride-lite source, which is what carries
#     "byte-identical to stride-lite's" once stride-lite is not on disk;
#   * negative controls proving the comparison can fail.
#
# The two mutations that MUST turn this red:
#   1. change `## Where` to `## Where context` in the create-task template
#      -> fails byte-identity AND the sha pin, while leaving 14 headings, so
#         the diff is demonstrably what caught it;
#   2. delete the closing fence of create-goal's template
#      -> fails the 81-line and no-`### ` structural checks.
#
# Test seams, defaulting to the real paths:
#   STRIDE_SMOKE_SKILLS_DIR  point the parity stage at a copied skills tree
#   STRIDE_LITE_ROOT         where to find stride-lite for the cross-check
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SKILLS_DIR="${STRIDE_SMOKE_SKILLS_DIR:-$REPO_ROOT/skills}"
STRIDE_LITE_ROOT="${STRIDE_LITE_ROOT:-$REPO_ROOT/../stride-lite}"

# The stride-lite taskN template, pinned. This is the assertion that survives
# stride-lite being absent, which it always is for a consumer.
EXPECTED_TASKN_SHA256=f5ff7db2802fbe5c9ac4d8ffafddc45ea09bdbca55541aed02f54552567cfedd

PASS=0
FAIL=0
SKIP=0

ok()      { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
nope()    { FAIL=$((FAIL + 1)); printf 'FAIL  %s — %s\n' "$1" "${2:-}" >&2; }
skipped() { SKIP=$((SKIP + 1)); printf 'SKIP  %s — %s\n' "$1" "${2:-}"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- Extractor A: awk forward state machine ------------------------------
extract_a() {
  awk '
    /^### taskN\.md template$/ { armed = 1; next }
    armed && /^```markdown$/   { inblock = 1; next }
    inblock && /^```$/         { exit }
    inblock                    { print }
  ' "$1"
}

# --- Extractor B: sed window pipeline ------------------------------------
# Deliberately a different toolchain and different anchors from A.
extract_b() {
  sed -n '/^#### Task template/,/^### Step 7/p' "$1" \
    | sed -n '/^```markdown$/,/^```$/p' \
    | sed '1d;$d'
}

# --- Extractor for the init canonical template (four-backtick fence) -----
extract_init_a() {
  awk '/^````markdown$/ { inblock = 1; next } inblock && /^````$/ { exit } inblock' "$1"
}
extract_init_b() {
  sed -n '/^````markdown$/,/^````$/p' "$1" | sed '1d;$d'
}

GOAL_SKILL="$SKILLS_DIR/stride-opencode-lite-create-goal/SKILL.md"
TASK_SKILL="$SKILLS_DIR/stride-opencode-lite-create-task/SKILL.md"
INIT_SKILL="$SKILLS_DIR/stride-opencode-lite-init/SKILL.md"

for f in "$GOAL_SKILL" "$TASK_SKILL" "$INIT_SKILL"; do
  if [ ! -r "$f" ]; then
    nope "skill file readable" "$f"
  fi
done

extract_a "$GOAL_SKILL" > "$WORK/goal.txt" 2>/dev/null
extract_b "$TASK_SKILL" > "$WORK/task.txt" 2>/dev/null

# --- Non-empty preconditions, asserted separately ------------------------
PARITY_CREDITED=1
if [ -s "$WORK/goal.txt" ]; then
  ok "create-goal taskN template extracted non-empty"
else
  PARITY_CREDITED=0
  nope "create-goal taskN template extracted non-empty" \
       "no content between '### taskN.md template' and its \`\`\`markdown fence in $GOAL_SKILL"
fi

if [ -s "$WORK/task.txt" ]; then
  ok "create-task taskN template extracted non-empty"
else
  PARITY_CREDITED=0
  nope "create-task taskN template extracted non-empty" \
       "no content between '#### Task template' and its \`\`\`markdown fence in $TASK_SKILL"
fi

# --- Structural completeness --------------------------------------------
structurally_complete() {
  local file="$1" label="$2" bad=0
  [ "$(grep -c '^## ' "$file")" -eq 14 ] || { bad=1; }
  [ "$(wc -l < "$file")" -eq 81 ] || { bad=1; }
  head -1 "$file" | grep -q '^# ' || { bad=1; }
  for heading in '^## Where$' '^## Key files$' '^## Verification steps$' '^## Testing strategy$'; do
    grep -q "$heading" "$file" || { bad=1; }
  done
  # Over-capture guard: running past the closing fence pulls in SKILL.md prose.
  grep -q '^### ' "$file" && bad=1
  grep -q 'Render-time rules' "$file" && bad=1
  return "$bad"
}

if [ "$PARITY_CREDITED" -eq 1 ]; then
  if structurally_complete "$WORK/goal.txt" goal && structurally_complete "$WORK/task.txt" task; then
    ok "both taskN templates are structurally complete (81 lines, 14 sections)"
  else
    PARITY_CREDITED=0
    nope "both taskN templates are structurally complete (81 lines, 14 sections)" \
         "an extraction was truncated or over-captured"
  fi
else
  skipped "both taskN templates are structurally complete (81 lines, 14 sections)" \
          "an extraction was empty"
fi

# --- The parity comparison ----------------------------------------------
if [ "$PARITY_CREDITED" -eq 1 ]; then
  if diff -u "$WORK/goal.txt" "$WORK/task.txt" > "$WORK/diff.out" 2>&1; then
    ok "the two create skills' taskN templates are byte-identical"
  else
    nope "the two create skills' taskN templates are byte-identical" \
         "$(head -20 "$WORK/diff.out")"
  fi
else
  skipped "the two create skills' taskN templates are byte-identical" \
          "an extraction failed its precondition"
fi

# --- The sha pin against stride-lite's source ---------------------------
if [ "$PARITY_CREDITED" -eq 1 ]; then
  sha_mismatch=0
  for side in goal task; do
    actual="$(shasum -a 256 "$WORK/$side.txt" | cut -d' ' -f1)"
    [ "$actual" = "$EXPECTED_TASKN_SHA256" ] || sha_mismatch=1
  done
  if [ "$sha_mismatch" -eq 0 ]; then
    ok "both taskN templates match the stride-lite source hash"
  else
    nope "both taskN templates match the stride-lite source hash" \
         "expected $EXPECTED_TASKN_SHA256"
  fi
else
  skipped "both taskN templates match the stride-lite source hash" "parity not credited"
fi

# --- Third-party cross-check, conditional -------------------------------
STRIDE_LITE_SKILL="$STRIDE_LITE_ROOT/skills/stride-lite-create-goal/SKILL.md"
if [ -r "$STRIDE_LITE_SKILL" ] && [ "$PARITY_CREDITED" -eq 1 ]; then
  extract_a "$STRIDE_LITE_SKILL" > "$WORK/upstream.txt" 2>/dev/null
  if [ -s "$WORK/upstream.txt" ] && diff -q "$WORK/goal.txt" "$WORK/upstream.txt" >/dev/null; then
    ok "taskN template matches stride-lite's copy on disk"
  else
    nope "taskN template matches stride-lite's copy on disk" \
         "upstream diverged, or upstream extraction was empty"
  fi
else
  skipped "stride-lite cross-check" "STRIDE_LITE_ROOT not found"
fi

# --- Negative controls ---------------------------------------------------
if [ "$PARITY_CREDITED" -eq 1 ]; then
  sed '1s/$/ /' "$WORK/goal.txt" > "$WORK/perturbed.txt"
  if diff -q "$WORK/goal.txt" "$WORK/perturbed.txt" >/dev/null 2>&1; then
    nope "the parity comparison detects a one-byte divergence (negative control)" \
         "a one-byte change compared equal"
  else
    ok "the parity comparison detects a one-byte divergence (negative control)"
  fi

  : > "$WORK/empty.txt"
  if [ -s "$WORK/empty.txt" ]; then
    nope "an empty extraction is refused, not credited (negative control)" "empty file read as non-empty"
  else
    ok "an empty extraction is refused, not credited (negative control)"
  fi
else
  skipped "the parity comparison detects a one-byte divergence (negative control)" "parity not credited"
  skipped "an empty extraction is refused, not credited (negative control)" "parity not credited"
fi

# --- The init canonical template ----------------------------------------
extract_init_a "$INIT_SKILL" > "$WORK/init_a.txt" 2>/dev/null
extract_init_b "$INIT_SKILL" > "$WORK/init_b.txt" 2>/dev/null

if [ -s "$WORK/init_a.txt" ] && [ -s "$WORK/init_b.txt" ]; then
  ok "init canonical template extracted non-empty by both extractors"
  if [ "$(grep -c '^## ' "$WORK/init_a.txt")" -eq 4 ]; then
    ok "init canonical template has its four sections"
  else
    nope "init canonical template has its four sections" \
         "found $(grep -c '^## ' "$WORK/init_a.txt")"
  fi
  if diff -q "$WORK/init_a.txt" "$WORK/init_b.txt" >/dev/null; then
    ok "the two init extractors agree"
  else
    nope "the two init extractors agree" "independent extractions differ"
  fi
  for want in '^## email$' '^## before_task$' '^## after_task$' '^## after_goal$'; do
    grep -q "$want" "$WORK/init_a.txt" \
      || nope "init template section present" "$want"
  done
  ok "init template carries the section names the parser recognises"
else
  nope "init canonical template extracted non-empty by both extractors" \
       "one or both extractions were empty"
fi

# --- The clobber guard is symlink-aware ---------------------------------
# Static check, and labelled as one: this greps the skill's written guard.
if grep -q '\-L "\$TARGET"' "$INIT_SKILL"; then
  ok "init's clobber guard tests -L as well as -e (static check)"
else
  nope "init's clobber guard tests -L as well as -e (static check)" \
       "test -e dereferences, so a dangling symlink reads as absent and the write would follow it"
fi

printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
