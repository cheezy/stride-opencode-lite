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
#   STRIDE_SMOKE_SKILLS_DIR    point the parity stage at a copied skills tree
#   STRIDE_SMOKE_COMMANDS_DIR  point the command stage at a copied commands tree
#   STRIDE_SMOKE_FIXTURES_DIR  point the fixture stages at a copied fixtures tree
#   STRIDE_LITE_ROOT         where to find stride-lite for the cross-check
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SKILLS_DIR="${STRIDE_SMOKE_SKILLS_DIR:-$REPO_ROOT/skills}"
COMMANDS_DIR="${STRIDE_SMOKE_COMMANDS_DIR:-$REPO_ROOT/commands}"
FIXTURES_DIR="${STRIDE_SMOKE_FIXTURES_DIR:-$REPO_ROOT/fixtures}"
# The two template blocks, vendored from stride-lite alongside the artifacts.
# These make the offline failure a real diff rather than two hashes: a sha
# mismatch says something changed without saying what, and a consumer never has
# stride-lite on disk, so offline IS their case.
VENDORED_GOAL_TPL="$FIXTURES_DIR/templates/goal.md.tpl"
VENDORED_TASKN_TPL="$FIXTURES_DIR/templates/taskN.md.tpl"
STRIDE_LITE_ROOT="${STRIDE_LITE_ROOT:-$REPO_ROOT/../stride-lite}"

# The stride-lite taskN template, pinned. This is the assertion that survives
# stride-lite being absent, which it always is for a consumer.
EXPECTED_TASKN_SHA256=f5ff7db2802fbe5c9ac4d8ffafddc45ea09bdbca55541aed02f54552567cfedd

# The goal.md template block, pinned the same way. Until W2042 this block was
# extracted by nothing and compared to nothing — it could have been rewritten
# and the whole suite would have stayed green.
EXPECTED_GOAL_TEMPLATE_SHA256=63b444f8cb7c84b0a2d8ec39ceafc8e7d74c8e80433f530e5adf7168b4273234

# Changing any pinned hash in this file is a CROSS-PORT DECISION. stride-lite,
# stride-copilot-lite and this port must land the change together, in the same
# change set. If you are updating a hash to make a test pass, stop.

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
# The comparison is a function so the negative controls below can drive THE
# PRODUCTION PATH rather than re-implementing a diff. Controls that build their
# own comparison test diff(1), not this script, and stay green while the real
# assertion is neutered.
templates_agree() {
  diff -u "$1" "$2" > "$WORK/diff.out" 2>&1
}

matches_pinned_hash() {
  [ "$(shasum -a 256 "$1" | cut -d' ' -f1)" = "$EXPECTED_TASKN_SHA256" ]
}

if [ "$PARITY_CREDITED" -eq 1 ]; then
  if templates_agree "$WORK/goal.txt" "$WORK/task.txt"; then
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
  sha_mismatch=""
  # Record WHICH side drifted, not merely that one did: the failure body below
  # diffs that side, and diffing the wrong one prints an empty diff under a
  # failure message — the shape this stage was just fixed to avoid.
  for side in goal task; do
    matches_pinned_hash "$WORK/$side.txt" || sha_mismatch="$sha_mismatch $side"
  done
  if [ -z "$sha_mismatch" ]; then
    ok "both taskN templates match the stride-lite source hash"
  else
    nope "both taskN templates match the stride-lite source hash" \
         "$(for side in $sha_mismatch; do
              [ -r "$VENDORED_TASKN_TPL" ] && diff -u "$VENDORED_TASKN_TPL" "$WORK/$side.txt" | head -20
            done)
expected $EXPECTED_TASKN_SHA256; drifted side(s):$sha_mismatch"
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
         "$(diff -u "$WORK/upstream.txt" "$WORK/goal.txt" | head -20)
upstream diverged, or upstream extraction was empty"
  fi
else
  skipped "stride-lite cross-check" "STRIDE_LITE_ROOT not found"
fi

# --- Negative controls ---------------------------------------------------
if [ "$PARITY_CREDITED" -eq 1 ]; then
  # Drive templates_agree — the same function the real assertion calls — with a
  # known-divergent pair. If someone neuters that function, this goes red too.
  sed '1s/$/ /' "$WORK/goal.txt" > "$WORK/perturbed.txt"
  if templates_agree "$WORK/goal.txt" "$WORK/perturbed.txt"; then
    nope "the parity comparison detects a one-byte divergence (negative control)" \
         "templates_agree returned success for a one-byte divergence"
  else
    ok "the parity comparison detects a one-byte divergence (negative control)"
  fi

  # Same for the hash pin: drive matches_pinned_hash with content that must not
  # match, rather than asserting a property of the shell.
  if matches_pinned_hash "$WORK/perturbed.txt"; then
    nope "the hash pin rejects altered content (negative control)" \
         "matches_pinned_hash accepted a perturbed template"
  else
    ok "the hash pin rejects altered content (negative control)"
  fi

  # And that an empty extraction cannot be credited by the same comparison.
  : > "$WORK/empty.txt"
  if templates_agree "$WORK/empty.txt" "$WORK/goal.txt"; then
    nope "an empty extraction is refused, not credited (negative control)" \
         "an empty file compared equal to the template"
  else
    ok "an empty extraction is refused, not credited (negative control)"
  fi
else
  skipped "the hash pin rejects altered content (negative control)" "parity not credited"
  skipped "the parity comparison detects a one-byte divergence (negative control)" "parity not credited"
  skipped "an empty extraction is refused, not credited (negative control)" "parity not credited"
fi

# --- The goal.md template ------------------------------------------------
# Same shape as the taskN parity block above: two independently-coded
# extractors, a non-empty precondition, a structural gate, and a hash pin. This
# template lives in exactly ONE place in this port (create-task reproduces only
# the task template), so there is no second copy to diff against — the two
# extractors guard the extraction, and the pin carries "identical to
# stride-lite's".
extract_goal_a() {  # awk forward state machine
  awk '
    /^### goal\.md template$/ { armed = 1; next }
    armed && /^```markdown$/  { inblock = 1; next }
    inblock && /^```$/        { exit }
    inblock                   { print }
  ' "$1"
}

extract_goal_b() {  # sed window between the two template headings
  sed -n '/^### goal\.md template$/,/^### taskN\.md template$/p' "$1" \
    | sed -n '/^```markdown$/,/^```$/p' \
    | sed '1d;$d'
}

matches_goal_template_hash() {
  [ "$(shasum -a 256 "$1" | cut -d' ' -f1)" = "$EXPECTED_GOAL_TEMPLATE_SHA256" ]
}

goal_template_complete() {
  [ "$(grep -c '^## ' "$1")" -eq 7 ] || return 1
  [ "$(wc -l < "$1" | tr -d ' ')" -eq 33 ] || return 1
  grep -q '^### ' "$1" && return 1
  # Over-capture guard: this line lives outside the fence.
  grep -q 'The "Tasks" section' "$1" && return 1
  return 0
}

GOAL_TPL_CREDITED=0
extract_goal_a "$GOAL_SKILL" > "$WORK/gt_a.txt" 2>/dev/null
extract_goal_b "$GOAL_SKILL" > "$WORK/gt_b.txt" 2>/dev/null

if [ -s "$WORK/gt_a.txt" ] && [ -s "$WORK/gt_b.txt" ]; then
  ok "the goal.md template is extracted non-empty by both extractors"
  GOAL_TPL_CREDITED=1
else
  nope "the goal.md template is extracted non-empty by both extractors" \
       "awk extractor $(wc -c < "$WORK/gt_a.txt") bytes, sed extractor $(wc -c < "$WORK/gt_b.txt") bytes"
fi

if [ "$GOAL_TPL_CREDITED" -eq 1 ]; then
  if goal_template_complete "$WORK/gt_a.txt"; then
    ok "the goal.md template is structurally complete (33 lines, 7 sections)"
  else
    nope "the goal.md template is structurally complete (33 lines, 7 sections)" \
         "$(grep -c '^## ' "$WORK/gt_a.txt") sections, $(wc -l < "$WORK/gt_a.txt" | tr -d ' ') lines"
  fi

  if templates_agree "$WORK/gt_a.txt" "$WORK/gt_b.txt"; then
    ok "the two goal.md template extractors agree"
  else
    nope "the two goal.md template extractors agree" \
         "$(diff -u "$WORK/gt_a.txt" "$WORK/gt_b.txt" | head -20)"
  fi

  if matches_goal_template_hash "$WORK/gt_a.txt"; then
    ok "the goal.md template matches the stride-lite source hash"
  else
    # "Shows the diff" is a requirement, not decoration. Diff against the
    # VENDORED template, which is always on disk — the earlier version fell back
    # to printing the current file's own heading spine when stride-lite was
    # absent, which showed nothing at all for a non-heading edit.
    if [ -r "$VENDORED_GOAL_TPL" ]; then
      GOAL_DIFF="$(diff -u "$VENDORED_GOAL_TPL" "$WORK/gt_a.txt" | head -20)"
    else
      GOAL_DIFF="fixtures/templates/goal.md.tpl is missing — see the fixture FAIL above"
    fi
    nope "the goal.md template matches the stride-lite source hash" \
         "expected $EXPECTED_GOAL_TEMPLATE_SHA256, got $(shasum -a 256 "$WORK/gt_a.txt" | cut -d' ' -f1)
$GOAL_DIFF"
  fi

  # Cross-check against stride-lite on disk. SKIPs, never passes, when absent —
  # a consumer will never have stride-lite checked out.
  UPSTREAM_GOAL_SKILL="$STRIDE_LITE_ROOT/skills/stride-lite-create-goal/SKILL.md"
  if [ -r "$UPSTREAM_GOAL_SKILL" ]; then
    extract_goal_a "$UPSTREAM_GOAL_SKILL" > "$WORK/gt_upstream.txt" 2>/dev/null
    if [ -s "$WORK/gt_upstream.txt" ] && diff -q "$WORK/gt_a.txt" "$WORK/gt_upstream.txt" >/dev/null; then
      ok "goal.md template matches stride-lite's copy on disk"
    else
      nope "goal.md template matches stride-lite's copy on disk" \
           "$(diff -u "$WORK/gt_upstream.txt" "$WORK/gt_a.txt" | head -20)"
    fi
  else
    skipped "goal.md template stride-lite cross-check" "STRIDE_LITE_ROOT not found"
  fi

  # Negative control on the pin, driven through the production predicate.
  sed '1s/$/ /' "$WORK/gt_a.txt" > "$WORK/gt_perturbed.txt"
  if matches_goal_template_hash "$WORK/gt_perturbed.txt"; then
    nope "the goal.md template hash pin rejects altered content (negative control)" \
         "matches_goal_template_hash accepted a perturbed template"
  else
    ok "the goal.md template hash pin rejects altered content (negative control)"
  fi
else
  skipped "the goal.md template is structurally complete (33 lines, 7 sections)" "extraction not credited"
  skipped "the two goal.md template extractors agree" "extraction not credited"
  skipped "the goal.md template matches the stride-lite source hash" "extraction not credited"
  skipped "the goal.md template hash pin rejects altered content (negative control)" "extraction not credited"
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
  sections_ok=1
  for want in '^## email$' '^## before_task$' '^## after_task$' '^## after_goal$'; do
    grep -q "$want" "$WORK/init_a.txt" || sections_ok=0
  done
  if [ "$sections_ok" -eq 1 ]; then
    ok "init template carries the section names the parser recognises"
  else
    nope "init template carries the section names the parser recognises" \
         "a required section heading is missing"
  fi
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


# ========================================================================
# The workflow skill: steps, contracts and scope lists.
#
# Every stage below runs against a SLICED REGION, never the whole file. A
# `toContain`-style match over a 1000-line markdown document is satisfied by
# prose anywhere in it, which is how a check ends up naming one thing and
# guarding another. Each slice also gets its own non-empty precondition —
# mandatory for the two NEGATIVE stages, where a grep-and-fail over an empty
# slice passes while guarding nothing.
# ========================================================================
WORKFLOW="$SKILLS_DIR/stride-opencode-lite-workflow/SKILL.md"

# Slice a "## Heading" region up to the next "## ".
section() {
  awk -v h="$1" '$0 == h { inb = 1; next } inb && /^## / { exit } inb' "$WORKFLOW"
}
# Slice a "### Heading" region up to the next "### " or "## ".
subsection() {
  awk -v h="$1" '$0 == h { inb = 1; next } inb && /^#{2,3} / { exit } inb' "$WORKFLOW"
}

slice_nonempty() {
  if [ -s "$2" ]; then
    ok "workflow: the $1 region is non-empty"
    return 0
  fi
  nope "workflow: the $1 region is non-empty" "slice came back empty — the heading moved or was renamed"
  return 1
}

if [ ! -r "$WORKFLOW" ]; then
  nope "workflow skill readable" "$WORKFLOW"
else

# --- Steps, in order -----------------------------------------------------
STEPS="$(grep -oE '^### Step [0-9]+[a-c]?' "$WORKFLOW" | sed 's/^### Step //' | tr '\n' ',')"
if [ "$STEPS" = "0,1,1a,2,3,3a,4,5,6,6a,6b,6c,7,8," ]; then
  ok "workflow: the step headings appear in order"
else
  nope "workflow: the step headings appear in order" "got [$STEPS]"
fi

# --- Activation contract -------------------------------------------------
section '## When to invoke' > "$WORK/wf_activate.txt"
if slice_nonempty "activation-contract" "$WORK/wf_activate.txt"; then
  if grep -q 'if and ONLY if \*\*both\*\*' "$WORK/wf_activate.txt" \
     && grep -q 'Explicit intent' "$WORK/wf_activate.txt" \
     && grep -q 'Path supplied' "$WORK/wf_activate.txt" \
     && grep -q 'do NOT activate' "$WORK/wf_activate.txt"; then
    ok "workflow: the activation contract requires both intent and a path"
  else
    nope "workflow: the activation contract requires both intent and a path" \
         "one of the two conditions or the do-not-activate rule is missing"
  fi
fi

# --- Termination contract ------------------------------------------------
subsection '### Termination contract' > "$WORK/wf_term.txt"
if slice_nonempty "termination-contract" "$WORK/wf_term.txt"; then
  if grep -q 'exactly once' "$WORK/wf_term.txt" && grep -q 'after_goal' "$WORK/wf_term.txt" \
     && grep -qi 'do \*\*not\*\* re-enter\|do not re-enter' "$WORK/wf_term.txt"; then
    ok "workflow: the termination contract states a single exit"
  else
    nope "workflow: the termination contract states a single exit" "a required clause is missing"
  fi
fi

# --- Review cap, pinned in two independent places ------------------------
awk '/^### Step 7/ { inb = 1; next } inb && /^#{2,3} / { exit } inb' "$WORKFLOW" > "$WORK/wf_step7.txt"
if slice_nonempty "step-7" "$WORK/wf_step7.txt"; then
  # A bare `3` is satisfied by any region containing the digit, so require the
  # cap named alongside it.
  if grep -q 'max_review_iterations' "$WORK/wf_step7.txt" \
     && grep -qE 'max_review_iterations[^0-9]*3|3[^0-9]*max_review_iterations|cap[^0-9]*3' "$WORK/wf_step7.txt"; then
    ok "workflow: the review cap is 3 in Step 7"
  else
    nope "workflow: the review cap is 3 in Step 7" "the cap sentence is missing from the Step 7 region"
  fi
fi
if grep -qE '^\|.*`max_review_iterations`.*`3`' "$WORKFLOW"; then
  ok "workflow: the review cap is 3 in the inputs table"
else
  nope "workflow: the review cap is 3 in the inputs table" "the inputs row no longer pins 3"
fi

# --- Hook contract region ------------------------------------------------
section '## Hook execution contract' > "$WORK/wf_hook.txt"
if slice_nonempty "hook-contract" "$WORK/wf_hook.txt"; then
  hook_rows=0
  grep -Fq '| `before_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-explorer` | yes |' "$WORK/wf_hook.txt" && hook_rows=$((hook_rows+1))
  grep -Fq '| `after_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-reviewer` | yes |' "$WORK/wf_hook.txt" && hook_rows=$((hook_rows+1))
  grep -Fq '| `after_goal` | `tool.execute.after` | tool `edit` or `write`, basename exactly `goal.md`, payload contains `## Completion Summary` | no |' "$WORK/wf_hook.txt" && hook_rows=$((hook_rows+1))
  if [ "$hook_rows" -eq 3 ]; then
    ok "workflow: the hook contract table carries the three canonical rows"
  else
    nope "workflow: the hook contract table carries the three canonical rows" "found $hook_rows of 3"
  fi
  if grep -q 'supplies no hook context variables' "$WORK/wf_hook.txt"; then
    ok "workflow: the contract supplies no hook context variables"
  else
    nope "workflow: the contract supplies no hook context variables" "the statement is missing"
  fi
fi

# --- No host artifacts (negative; precondition is the file itself) -------
if [ -s "$WORKFLOW" ]; then
  artifacts=""
  for tok in 'hooks.json' 'PreToolUse' 'PostToolUse' 'subagent_type' 'Claude Code' \
             'CLAUDE_PROJECT_DIR' '/stride-lite:' 'HOOK_NAME' 'TASK_FILE' 'TASK_NUMBER' \
             'TASK_TITLE' 'GOAL_DIR' 'GOAL_FILE' 'GOAL_SLUG' 'GOAL_TITLE' 'AGENT_NAME'; do
    grep -Fq "$tok" "$WORKFLOW" && artifacts="$artifacts $tok"
  done
  if [ -z "$artifacts" ]; then
    ok "workflow: no OpenCode-foreign host artifacts"
  else
    nope "workflow: no OpenCode-foreign host artifacts" "found:$artifacts"
  fi
else
  nope "workflow: no OpenCode-foreign host artifacts" "workflow file is empty"
fi

# --- Bash scope: allow and deny regions, and their disjointness ---------
section '## Bash scope' > "$WORK/wf_scope.txt"
if slice_nonempty "bash-scope" "$WORK/wf_scope.txt"; then
  grep '^- ✅' "$WORK/wf_scope.txt" > "$WORK/wf_allow.txt" || true
  grep '^- ❌' "$WORK/wf_scope.txt" > "$WORK/wf_deny.txt" || true

  if [ -s "$WORK/wf_allow.txt" ] && [ -s "$WORK/wf_deny.txt" ]; then
    ok "workflow: the Bash scope has both an allow and a deny list"
  else
    nope "workflow: the Bash scope has both an allow and a deny list" "one side is empty"
  fi

  missing=""
  for entry in 'mv' 'git mv' 'git rev-parse --is-inside-work-tree' 'git ls-files' 'mkdir -p'; do
    grep -Fq "$entry" "$WORK/wf_allow.txt" || missing="$missing [$entry]"
  done
  if [ -z "$missing" ]; then
    ok "workflow: the allow list keeps the terminal-move carve-out"
  else
    nope "workflow: the allow list keeps the terminal-move carve-out" "missing:$missing"
  fi

  missing=""
  for entry in 'mix test' 'npm test' 'cargo' 'curl' 'wget' 'nc' \
               'git commit' 'git push' 'git checkout' 'git reset' 'git merge' 'git rebase'; do
    grep -Fq "$entry" "$WORK/wf_deny.txt" || missing="$missing [$entry]"
  done
  if [ -z "$missing" ]; then
    ok "workflow: the deny list keeps the runner, network and mutating-git entries"
  else
    nope "workflow: the deny list keeps the runner, network and mutating-git entries" "missing:$missing"
  fi

  # Disjointness: the mutation that makes both lists "pass" while the scope
  # means nothing is pasting one region into the other.
  # Structural, not token-based: a deny bullet may legitimately NAME a
  # carve-out while describing the exception, so matching tokens across the
  # regions false-positives on prose. What must never happen is a grant marker
  # appearing in the deny region or a prohibition marker in the allow region,
  # which is exactly what pasting one list into the other produces.
  overlap=""
  grep -q '^- ✅' "$WORK/wf_deny.txt" && overlap="$overlap [grant-in-deny]"
  grep -q '^- ❌' "$WORK/wf_allow.txt" && overlap="$overlap [prohibition-in-allow]"
  for entry in 'git commit' 'git push' 'curl'; do
    grep -Fq "$entry" "$WORK/wf_allow.txt" && overlap="$overlap [allow:$entry]"
  done
  if [ -z "$overlap" ]; then
    ok "workflow: the allow and deny regions do not overlap (negative control)"
  else
    nope "workflow: the allow and deny regions do not overlap (negative control)" "overlap:$overlap"
  fi
fi

# --- The walkthrough must not teach hand-execution -----------------------
section '## Concrete walkthrough' > "$WORK/wf_walk.txt"
if slice_nonempty "walkthrough" "$WORK/wf_walk.txt"; then
  if [ "$(grep -c 'Nothing to run by hand' "$WORK/wf_walk.txt")" -ge 2 ]; then
    ok "workflow: the walkthrough disclaims hand-execution on both hook bullets"
  else
    nope "workflow: the walkthrough disclaims hand-execution on both hook bullets" \
         "expected the disclaimer at least twice"
  fi
  if grep -qiE '(run|execute) the .*(hook|section)|read .*\.stride_lite\.md' "$WORK/wf_walk.txt"; then
    nope "workflow: the walkthrough never hand-executes a hook section" \
         "found an instruction to run or read a hook section"
  else
    ok "workflow: the walkthrough never hand-executes a hook section"
  fi
fi

# --- The archive move ----------------------------------------------------
# The archive move lives under a bold "Final-task detection." paragraph inside
# Step 8, not under a heading, so anchor on that rather than on a heading —
# slicing the whole step would pull in the telemetry apparatus and name a
# region far wider than the assertions below actually check.
awk '/^\*\*Final-task detection\.\*\*/ { inb = 1 } inb && /^## / { exit } inb' "$WORKFLOW" > "$WORK/wf_step8.txt"
if slice_nonempty "step-8" "$WORK/wf_step8.txt"; then
  missing=""
  for entry in 'git rev-parse --is-inside-work-tree' 'git ls-files' 'n=2' '1000' 'PENDING'; do
    grep -Fq "$entry" "$WORK/wf_step8.txt" || missing="$missing [$entry]"
  done
  if [ -z "$missing" ]; then
    ok "workflow: the archive move keeps git-mv preference, collision suffixing and the PENDING guard"
  else
    nope "workflow: the archive move keeps git-mv preference, collision suffixing and the PENDING guard" \
         "missing:$missing"
  fi
fi

fi

# --- The activation marker, pinned (inverted from the earlier no-marker rule)
# This stage previously asserted that NO marker instruction survived, because
# the plugin read no marker and the instruction kept regenerating. The gate task
# reversed that decision, so the stage is INVERTED rather than deleted: a pinned
# decision that reverses should force the reversal to be acknowledged, not
# quietly dropped. It now asserts the workflow both arms and clears the marker.
if [ -s "$WORKFLOW" ]; then
  writes="$(grep -c 'stride-opencode-lite/\.orchestrator_active' "$WORKFLOW")"
  clears="$(grep -ci 'clear the activation marker' "$WORKFLOW")"
  # A count threshold cannot tell WHICH stop lost its clear, and the one that
  # matters most is the ordinary successful exit: leaving the marker armed after
  # a clean run means the next unrelated tool call fires the user's hooks. Pin
  # that path and the normative rule by name, not by counting.
  clean_exit=0
  grep -q 'Clear the activation marker — `rm -f .stride-opencode-lite/.orchestrator_active`' "$WORKFLOW" && clean_exit=1
  every_exit=0
  grep -q 'EVERY exit clears the marker' "$WORKFLOW" && every_exit=1
  # Distinct from the full plugin's path and variable — a project may have both.
  collides=0
  grep -qE '(^|[^-])\.stride/\.orchestrator_active' "$WORKFLOW" && collides=1
  grep -q 'STRIDE_ALLOW_DIRECT' "$WORKFLOW" && collides=1
  if [ "$writes" -ge 2 ] && [ "$clears" -ge 8 ] && [ "$clean_exit" -eq 1 ] \
     && [ "$every_exit" -eq 1 ] && [ "$collides" -eq 0 ]; then
    ok "workflow: the activation marker is written at Step 0 and cleared on every stop"
  else
    nope "workflow: the activation marker is written at Step 0 and cleared on every stop" \
         "$writes path reference(s), $clears clear instruction(s), clean-exit-clear=$clean_exit, every-exit-rule=$every_exit, collides-with-full-plugin=$collides"
  fi

  if grep -q 'coordination, not security' "$WORKFLOW" && grep -q 'fails open' "$WORKFLOW"; then
    ok "workflow: the marker is documented as coordination and as fail-open"
  else
    nope "workflow: the marker is documented as coordination and as fail-open" \
         "the coordination-not-security or the fail-open statement is missing"
  fi
else
  nope "workflow: the activation marker is written at Step 0 and cleared on every stop" "workflow file is empty"
fi

# --- The terminal-move grant is a GRANT, not prose mentioning a verb -----
# `grep -Fq 'mv'` over the allow region also matches the prohibition
# "no `mkdir`, no `mv`, no `rmdir`" in a sibling bullet, so match the grant
# bullets themselves and require the carve-out's own qualifier.
if [ -s "$WORK/wf_allow.txt" ]; then
  carve=0
  grep -qE '^- ✅ .*`git mv`' "$WORK/wf_allow.txt" && carve=$((carve+1))
  grep -qE '^- ✅ .*`git rev-parse --is-inside-work-tree`' "$WORK/wf_allow.txt" && carve=$((carve+1))
  grep -qE '^- ✅ .*`git ls-files' "$WORK/wf_allow.txt" && carve=$((carve+1))
  grep -qE '^- ✅ .*`mkdir -p' "$WORK/wf_allow.txt" && carve=$((carve+1))
  qualified="$(grep -c 'Forbidden elsewhere in the skill body' "$WORK/wf_allow.txt")"
  if [ "$carve" -eq 4 ] && [ "$qualified" -ge 4 ]; then
    ok "workflow: the terminal-move carve-out is granted and scoped"
  else
    nope "workflow: the terminal-move carve-out is granted and scoped" \
         "granted $carve/4 as ✅ bullets, $qualified carry the Forbidden-elsewhere qualifier"
  fi
fi


# --- Fixtures: byte-identity with stride-lite ----------------------------
#
# THE FAIL-vs-SKIP RULE, which the stages below depend on and which is easy to
# collapse by accident:
#
#   Every promise has an offline form that ALWAYS runs. The live cross-check
#   against stride-lite is strictly redundant confirmation, and only redundant
#   confirmation may skip. A skip that removes the ONLY evidence for a claim is
#   a FAIL.
#
# So: a vendored file of ours going missing is a FAIL (we ship it; its absence
# is our defect). stride-lite not being checked out is a SKIP (not our repo,
# absent for every consumer). But stride-lite present with a fixture path
# missing under it is a FAIL — that is upstream restructuring, a cross-port
# decision we must be told about, not a degradation to shrug at.
#
# require_fixture() and the upstream stage are deliberately SEPARATE and must
# stay separate. A single check_file() with a --strict flag is how these two
# verdicts get merged by a well-meaning refactor.
#
# What these stages do NOT establish: that these skills, driven by a live model,
# emit these bytes. The fixtures are hand-authored simulations of a real run —
# expected-output/goal.md says so in its own body — so no offline check can
# render them from the placeholder templates. See fixtures/README.md.

EXPECTED_SAMPLE_SHA256=0a6cd5605c149a3b3021600b5745d5826bc18ef1dc729ee133f7c3994e3d933d
EXPECTED_GOAL_FIXTURE_SHA256=00ae81dc1a6907d97c0ce37712fce58b096756100fc55fffd7a095cc83b4de55
EXPECTED_TASK1_FIXTURE_SHA256=141afe6f06ca27f240631357fee077aa0a9160025297ad242dbb4bbbfc9b9a97
EXPECTED_STRIDE_LITE_COMMIT=ffb670bbc29096916d0111ca64944e0c92f968ee

FIXTURE_FILES="README.md expected-output/goal.md expected-output/task1.md sample-requirements.md templates/goal.md.tpl templates/taskN.md.tpl"

# An absent, unreadable, empty or symlinked fixture is a failure — never a skip.
require_fixture() {
  [ -e "$1" ] || return 1
  [ -L "$1" ] && return 1
  [ -r "$1" ] || return 1
  [ -s "$1" ] || return 1
  return 0
}

matches_fixture_hash() {
  [ "$(shasum -a 256 "$1" | cut -d' ' -f1)" = "$2" ]
}

# The fixture's `## ` spine must equal the template's, in order.
headings_conform() {  # $1 template extraction, $2 fixture
  diff -q <(grep '^## ' "$1") <(grep '^## ' "$2") >/dev/null
}

FIXTURES_CREDITED=1
missing_fixtures=""
for rel in $FIXTURE_FILES; do
  require_fixture "$FIXTURES_DIR/$rel" || missing_fixtures="$missing_fixtures $rel"
done
if [ -z "$missing_fixtures" ]; then
  ok "fixtures: every vendored file is present and non-empty"
else
  FIXTURES_CREDITED=0
  nope "fixtures: every vendored file is present and non-empty" "missing or unusable:$missing_fixtures"
fi

# An unchecked extra file under fixtures/ is a rot vector.
actual_fixtures="$(cd "$FIXTURES_DIR" 2>/dev/null && find . -type f -not -name .gitkeep | sed 's|^\./||' | sort | tr '\n' ' ')"
expected_fixtures="$(printf '%s\n' $FIXTURE_FILES | sort | tr '\n' ' ')"
fixture_links="$(cd "$FIXTURES_DIR" 2>/dev/null && find . -type l | wc -l | tr -d ' ')"
if [ "$actual_fixtures" = "$expected_fixtures" ] && [ "$fixture_links" -eq 0 ]; then
  ok "fixtures: the vendored tree holds exactly the expected files and no symlinks"
else
  FIXTURES_CREDITED=0
  nope "fixtures: the vendored tree holds exactly the expected files and no symlinks" \
       "found [$actual_fixtures] wanted [$expected_fixtures], symlinks=$fixture_links"
fi

if [ "$FIXTURES_CREDITED" -eq 1 ]; then
  hashdrift=""
  # The templates are pinned to the SAME constants the live extractions are, so
  # `diff -u vendored extracted` and the hash comparison become two statements
  # about one frozen copy rather than a free-floating file. Without this the
  # reference the offline diff rests on is asserted by nothing.
  for pair in "sample-requirements.md:$EXPECTED_SAMPLE_SHA256" \
              "expected-output/goal.md:$EXPECTED_GOAL_FIXTURE_SHA256" \
              "expected-output/task1.md:$EXPECTED_TASK1_FIXTURE_SHA256" \
              "templates/goal.md.tpl:$EXPECTED_GOAL_TEMPLATE_SHA256" \
              "templates/taskN.md.tpl:$EXPECTED_TASKN_SHA256"; do
    rel="${pair%%:*}"; want="${pair##*:}"
    got="$(shasum -a 256 "$FIXTURES_DIR/$rel" | cut -d' ' -f1)"
    matches_fixture_hash "$FIXTURES_DIR/$rel" "$want" || hashdrift="$hashdrift
  $rel expected $want got $got"
  done
  if [ -z "$hashdrift" ]; then
    ok "fixtures: every vendored file matches its pinned stride-lite sha256"
  else
    nope "fixtures: every vendored file matches its pinned stride-lite sha256" "$hashdrift"
  fi

  if grep -Fq "$EXPECTED_STRIDE_LITE_COMMIT" "$FIXTURES_DIR/README.md"; then
    ok "fixtures: README.md records the stride-lite source commit"
  else
    nope "fixtures: README.md records the stride-lite source commit" \
         "$EXPECTED_STRIDE_LITE_COMMIT not found in fixtures/README.md"
  fi

  # Two-source agreement: a vendor refresh must touch the README and this file
  # together, or one silently describes a version the other does not check.
  readme_gap=""
  for want in "$EXPECTED_SAMPLE_SHA256" "$EXPECTED_GOAL_FIXTURE_SHA256" "$EXPECTED_TASK1_FIXTURE_SHA256"; do
    grep -Fq "$want" "$FIXTURES_DIR/README.md" || readme_gap="$readme_gap $want"
  done
  for rel in sample-requirements.md expected-output/goal.md expected-output/task1.md \
             templates/goal.md.tpl templates/taskN.md.tpl; do
    grep -Fq "$rel" "$FIXTURES_DIR/README.md" || readme_gap="$readme_gap $rel"
  done
  # The re-vendor procedure names the constants to update; a stale name there
  # sends the next person looking for a variable that does not exist.
  for var in EXPECTED_SAMPLE_SHA256 EXPECTED_GOAL_FIXTURE_SHA256 EXPECTED_TASK1_FIXTURE_SHA256 \
             EXPECTED_GOAL_TEMPLATE_SHA256 EXPECTED_TASKN_SHA256 EXPECTED_STRIDE_LITE_COMMIT; do
    grep -Fq "$var" "$FIXTURES_DIR/README.md" || readme_gap="$readme_gap $var"
  done
  if [ -z "$readme_gap" ]; then
    ok "fixtures: README.md pins the same hashes and paths the check does"
  else
    nope "fixtures: README.md pins the same hashes and paths the check does" "absent from README:$readme_gap"
  fi

  # Line endings: named explicitly so a CRLF checkout explains itself instead of
  # failing the hash stage mystifyingly.
  eol=""
  for rel in $FIXTURE_FILES; do
    LC_ALL=C grep -q "$(printf '\r')" "$FIXTURES_DIR/$rel" && eol="$eol $rel:CR"
    [ "$(tail -c 1 "$FIXTURES_DIR/$rel" | xxd -p)" = "0a" ] || eol="$eol $rel:no-final-newline"
  done
  if [ -z "$eol" ]; then
    ok "fixtures: no CR bytes, and every file ends with a newline"
  else
    nope "fixtures: no CR bytes, and every file ends with a newline" "$eol"
  fi

  # The pitfall against comparing per-run-varying values, enforced for the NEXT
  # refresh rather than for today's known-clean corpus.
  varying=""
  for rel in $FIXTURE_FILES; do
    # README.md records the vendoring date, which is the one legitimate date in
    # the tree. Everything else opts in by default, so the next vendored file
    # cannot land outside this loop unnoticed.
    [ "$rel" = "README.md" ] && continue
    grep -qE '[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{2}:[0-9]{2}|/Users/|/home/|/tmp/' "$FIXTURES_DIR/$rel" \
      && varying="$varying $rel"
  done
  if [ -z "$varying" ]; then
    ok "fixtures: no timestamp or machine-specific path in any vendored file"
  else
    nope "fixtures: no timestamp or machine-specific path in any vendored file" "found in:$varying"
  fi

  # Conformance: the honest substitute for "render and diff". The spines are
  # derived from the templates at check time — a hardcoded list would drift with
  # the template and prove nothing.
  if [ "$GOAL_TPL_CREDITED" -eq 1 ] && [ "$PARITY_CREDITED" -eq 1 ]; then
    if headings_conform "$WORK/goal.txt" "$FIXTURES_DIR/expected-output/task1.md"; then
      ok "fixtures: task1.md carries the taskN template's headings, in order"
    else
      nope "fixtures: task1.md carries the taskN template's headings, in order" \
           "$(diff -u <(grep '^## ' "$WORK/goal.txt") <(grep '^## ' "$FIXTURES_DIR/expected-output/task1.md") | head -20)"
    fi

    if headings_conform "$WORK/gt_a.txt" "$FIXTURES_DIR/expected-output/goal.md"; then
      ok "fixtures: goal.md carries the goal template's headings, in order"
    else
      nope "fixtures: goal.md carries the goal template's headings, in order" \
           "$(diff -u <(grep '^## ' "$WORK/gt_a.txt") <(grep '^## ' "$FIXTURES_DIR/expected-output/goal.md") | head -20)"
    fi

    # Negative control, driven through the production predicate.
    sed 's/^## Where$/## Where context/' "$WORK/goal.txt" > "$WORK/tpl_renamed.txt"
    if headings_conform "$WORK/tpl_renamed.txt" "$FIXTURES_DIR/expected-output/task1.md"; then
      nope "fixtures: the conformance check detects a renamed heading (negative control)" \
           "headings_conform accepted a renamed heading"
    else
      ok "fixtures: the conformance check detects a renamed heading (negative control)"
    fi
  else
    skipped "fixtures: task1.md carries the taskN template's headings, in order" "template extraction not credited"
    skipped "fixtures: goal.md carries the goal template's headings, in order" "template extraction not credited"
    skipped "fixtures: the conformance check detects a renamed heading (negative control)" "template extraction not credited"
  fi

  # The recorded commit must RESOLVE, and the comparison must be against that
  # commit's content. Grepping the sha out of the README only proves the README
  # contains a string; diffing the working tree can pass green against an
  # arbitrary later commit while the README still claims ffb670b.
  # Exact toplevel, not --is-inside-work-tree: that walks UPWARD, so a plain
  # directory sitting inside the enclosing kanban checkout would resolve the
  # commit against the wrong repository and fail rather than skip.
  SL_TOPLEVEL="$(git -C "$STRIDE_LITE_ROOT" rev-parse --show-toplevel 2>/dev/null)"
  SL_REALPATH="$(cd "$STRIDE_LITE_ROOT" 2>/dev/null && pwd -P)"
  # Both must be NON-EMPTY as well as equal: an absent directory makes both the
  # empty string, and empty-equals-empty would enter the branch and resolve the
  # commit against nothing.
  if [ -n "$SL_TOPLEVEL" ] && [ "$SL_TOPLEVEL" = "$SL_REALPATH" ]; then
    if ! git -C "$STRIDE_LITE_ROOT" cat-file -e "$EXPECTED_STRIDE_LITE_COMMIT^{commit}" 2>/dev/null; then
      nope "fixtures: the recorded stride-lite commit resolves in that repository" \
           "$EXPECTED_STRIDE_LITE_COMMIT is not a commit in $STRIDE_LITE_ROOT"
    else
      commitdrift=""
      for rel in sample-requirements.md expected-output/goal.md expected-output/task1.md; do
        if ! git -C "$STRIDE_LITE_ROOT" cat-file -e "$EXPECTED_STRIDE_LITE_COMMIT:fixtures/$rel" 2>/dev/null; then
          commitdrift="$commitdrift
  fixtures/$rel absent at $EXPECTED_STRIDE_LITE_COMMIT"
        else
          git -C "$STRIDE_LITE_ROOT" show "$EXPECTED_STRIDE_LITE_COMMIT:fixtures/$rel" > "$WORK/at_commit.md" 2>/dev/null
          diff -q "$FIXTURES_DIR/$rel" "$WORK/at_commit.md" >/dev/null || commitdrift="$commitdrift
$(diff -u "$WORK/at_commit.md" "$FIXTURES_DIR/$rel" | head -20)"
        fi
      done
      # The vendored TEMPLATES are not under stride-lite's fixtures/, so the loop
      # above cannot reach them — without this they are tied to stride-lite by
      # nothing at all, only to a constant in this file.
      UPSTREAM_SKILL_AT_COMMIT="$EXPECTED_STRIDE_LITE_COMMIT:skills/stride-lite-create-goal/SKILL.md"
      if git -C "$STRIDE_LITE_ROOT" cat-file -e "$UPSTREAM_SKILL_AT_COMMIT" 2>/dev/null; then
        git -C "$STRIDE_LITE_ROOT" show "$UPSTREAM_SKILL_AT_COMMIT" > "$WORK/skill_at_commit.md" 2>/dev/null
        extract_goal_a "$WORK/skill_at_commit.md" > "$WORK/tpl_goal_at_commit.txt" 2>/dev/null
        extract_a "$WORK/skill_at_commit.md" > "$WORK/tpl_taskn_at_commit.txt" 2>/dev/null
        for pair in "templates/goal.md.tpl:tpl_goal_at_commit" \
                    "templates/taskN.md.tpl:tpl_taskn_at_commit"; do
          rel="${pair%%:*}"; at="${pair##*:}"
          # Non-empty precondition, as every other extraction in this file has.
          # Without it an upstream heading rename prints the whole vendored file
          # as a deletion, which reads as template drift rather than as the
          # upstream restructure it actually is.
          if [ ! -s "$WORK/$at.txt" ]; then
            commitdrift="$commitdrift
  $rel: the block was not found at $EXPECTED_STRIDE_LITE_COMMIT — upstream restructured its headings"
          elif ! diff -q "$FIXTURES_DIR/$rel" "$WORK/$at.txt" >/dev/null; then
            commitdrift="$commitdrift
$(diff -u "$WORK/$at.txt" "$FIXTURES_DIR/$rel" | head -20)"
          fi
        done
      else
        commitdrift="$commitdrift
  skills/stride-lite-create-goal/SKILL.md absent at $EXPECTED_STRIDE_LITE_COMMIT"
      fi

      if [ -z "$commitdrift" ]; then
        ok "fixtures: the recorded stride-lite commit resolves in that repository"
      else
        nope "fixtures: the recorded stride-lite commit resolves in that repository" "$commitdrift"
      fi
    fi
  else
    skipped "fixtures: the recorded stride-lite commit resolves in that repository" \
            "STRIDE_LITE_ROOT is not a git repository"
  fi

  # Live cross-check. SKIPs when stride-lite is absent; FAILS when it is present
  # but a path under it is missing — see the rule at the top of this section.
  if [ -d "$STRIDE_LITE_ROOT/fixtures" ]; then
    updrift=""
    for rel in sample-requirements.md expected-output/goal.md expected-output/task1.md; do
      if [ ! -r "$STRIDE_LITE_ROOT/fixtures/$rel" ]; then
        updrift="$updrift
  $rel absent upstream — upstream restructured"
      elif ! diff -q "$FIXTURES_DIR/$rel" "$STRIDE_LITE_ROOT/fixtures/$rel" >/dev/null; then
        updrift="$updrift
$(diff -u "$STRIDE_LITE_ROOT/fixtures/$rel" "$FIXTURES_DIR/$rel" | head -20)"
      fi
    done
    if [ -z "$updrift" ]; then
      ok "fixtures: the vendored copies match stride-lite's files on disk"
    else
      nope "fixtures: the vendored copies match stride-lite's files on disk" "$updrift
(this stage compares stride-lite's WORKING TREE; the commit stage above compares
blob bytes. stride-lite ships no .gitattributes, so a checkout with
core.autocrlf=true produces exactly this symptom with nothing actually diverged
— if the commit stage passed, trust it.)"
    fi
  else
    skipped "fixtures stride-lite cross-check" "STRIDE_LITE_ROOT not found"
  fi
else
  for lbl in "fixtures: every vendored file matches its pinned stride-lite sha256" \
             "fixtures: README.md records the stride-lite source commit" \
             "fixtures: README.md pins the same hashes and paths the check does" \
             "fixtures: no CR bytes, and every file ends with a newline" \
             "fixtures: no timestamp or machine-specific path in any vendored file" \
             "fixtures: task1.md carries the taskN template's headings, in order" \
             "fixtures: goal.md carries the goal template's headings, in order" \
             "fixtures: the conformance check detects a renamed heading (negative control)" \
             "fixtures: the recorded stride-lite commit resolves in that repository" \
             "fixtures: the vendored copies match stride-lite's files on disk"; do
    skipped "$lbl" "a vendored fixture is missing or unusable — see the FAIL above"
  done
fi

# In-script proof that the two fixture gates are not vacuous.
sed '1s/$/ /' "$FIXTURES_DIR/expected-output/goal.md" > "$WORK/fixture_perturbed.md" 2>/dev/null
if matches_fixture_hash "$WORK/fixture_perturbed.md" "$EXPECTED_GOAL_FIXTURE_SHA256"; then
  nope "fixtures: the byte and presence gates reject a one-byte change and an absent file (negative control)" \
       "matches_fixture_hash accepted a perturbed fixture"
elif require_fixture "$WORK/definitely-absent.md"; then
  nope "fixtures: the byte and presence gates reject a one-byte change and an absent file (negative control)" \
       "require_fixture accepted a path that does not exist"
elif require_fixture "/dev/null"; then
  nope "fixtures: the byte and presence gates reject a one-byte change and an absent file (negative control)" \
       "require_fixture accepted an empty file"
elif ln -sf "$FIXTURES_DIR/README.md" "$WORK/link.md" && require_fixture "$WORK/link.md"; then
  # A symlink reads bytes from outside the tree, so the branch that rejects one
  # is load-bearing — and it was previously exercised by nothing.
  nope "fixtures: the byte and presence gates reject a one-byte change and an absent file (negative control)" \
       "require_fixture accepted a symlink"
else
  ok "fixtures: the byte and presence gates reject a one-byte change and an absent file (negative control)"
fi

# --- Commands: cross-file consistency ------------------------------------
# These are the assertions test/commands.test.ts structurally cannot make on
# its own terms: each one reads TWO files and requires them to agree, so a
# command and the thing it names cannot drift together the way a command and a
# hardcoded map in its own test can.
commands_ok=1

# 1. Every activated skill name resolves to a skill directory that exists.
missing_skill=""
for cmd in "$COMMANDS_DIR"/*.md; do
  named="$(sed -n 's/.*Activate the `\([a-z0-9-]*\)` skill.*/\1/p' "$cmd" | head -1)"
  if [ -z "$named" ]; then
    missing_skill="$missing_skill $(basename "$cmd"):no-activation-line"
  elif [ ! -d "$SKILLS_DIR/$named" ]; then
    missing_skill="$missing_skill $(basename "$cmd")->$named"
  fi
done
if [ -z "$missing_skill" ]; then
  ok "commands: every activated skill name resolves to a skill on disk"
else
  commands_ok=0
  nope "commands: every activated skill name resolves to a skill on disk" "unresolved:$missing_skill"
fi

# 2. The create commands' documented defaults match lib/parse_args, which owns
#    them. A literal copy in a test cannot catch a command drifting from the
#    spec, because the copy drifts with it.
PARSE_ARGS="$REPO_ROOT/lib/parse_args.md"
drift=""
for flag in --requirements-dir --output-dir; do
  spec="$(sed -n "s/^| \`$flag <path>\` *| \`\([^\`]*\)\`.*/\1/p" "$PARSE_ARGS" | head -1)"
  if [ -z "$spec" ]; then
    drift="$drift $flag:absent-from-spec"
    continue
  fi
  for cmd in create-goal create-task; do
    grep -Fq "| \`$flag\` | \`$spec\` |" "$COMMANDS_DIR/$cmd.md" || drift="$drift $cmd:$flag"
  done
done
if [ -z "$drift" ]; then
  ok "commands: the create commands' defaults match the lib/parse_args spec"
else
  commands_ok=0
  nope "commands: the create commands' defaults match the lib/parse_args spec" "drifted:$drift"
fi

# 3. Each command's enumerated flow list must have one entry per `### Step` in
#    the skill it activates. This is what catches a command whose list was
#    dropped or went stale — the drift stride-lite already had to fix once, and
#    the drift a checked-out working copy silently reintroduced here.
listdrift=""
for cmd in "$COMMANDS_DIR"/*.md; do
  named="$(sed -n 's/.*Activate the `\([a-z0-9-]*\)` skill.*/\1/p' "$cmd" | head -1)"
  if [ -z "$named" ] || [ ! -d "$SKILLS_DIR/$named" ]; then
    # Not silently skipped: stage 1 already fails on this, and continuing here
    # with an empty $named would make `[ -d "$SKILLS_DIR/" ]` true and print
    # PASS after an "integer expression expected" error.
    listdrift="$listdrift $(basename "$cmd"):unresolved-skill"
    continue
  fi
  want="$(grep -c '^### Step' "$SKILLS_DIR/$named/SKILL.md")"
  got="$(grep -c '^[0-9]\+\. ' "$cmd")"
  if [ "$got" -eq 0 ]; then
    listdrift="$listdrift $(basename "$cmd"):no-list(skill-has-$want)"
  elif [ "$got" -ne "$want" ]; then
    listdrift="$listdrift $(basename "$cmd"):$got-vs-$want"
  fi
done
if [ -z "$listdrift" ]; then
  ok "commands: each flow list has one entry per step in the skill it activates"
else
  commands_ok=0
  nope "commands: each flow list has one entry per step in the skill it activates" "drifted:$listdrift"
fi

# 4. Negative control. All checks above must be able to go red, or a later
#    refactor that quietly disables them would read as green.
CTRL="$WORK/commands_ctrl"
mkdir -p "$CTRL"
cp "$COMMANDS_DIR"/*.md "$CTRL/"
sed -i.bak 's/Activate the `stride-opencode-lite-init` skill/Activate the `stride-opencode-lite-no-such-skill` skill/' "$CTRL/init.md"
sed -i.bak 's/^| `--output-dir` | `docs\/implementation\/PENDING` |/| `--output-dir` | `docs\/elsewhere` |/' "$CTRL/create-task.md"
rm -f "$CTRL"/*.bak
sed -i.bak '/^3\. Dispatch `@create-decomposer`/d' "$CTRL/create-goal.md"
rm -f "$CTRL"/*.bak
ctrl_skill=0
ctrl_default=0
ctrl_list=0
[ -d "$SKILLS_DIR/$(sed -n 's/.*Activate the `\([a-z0-9-]*\)` skill.*/\1/p' "$CTRL/init.md" | head -1)" ] || ctrl_skill=1
grep -Fq '| `--output-dir` | `docs/implementation/PENDING` |' "$CTRL/create-task.md" || ctrl_default=1
ctrl_want="$(grep -c '^### Step' "$SKILLS_DIR/stride-opencode-lite-create-goal/SKILL.md")"
ctrl_got="$(grep -c '^[0-9]\+\. ' "$CTRL/create-goal.md")"
if [ "$ctrl_got" -ne "$ctrl_want" ]; then ctrl_list=1; fi
if [ "$ctrl_skill" -eq 1 ] && [ "$ctrl_default" -eq 1 ] && [ "$ctrl_list" -eq 1 ]; then
  ok "commands: every command check detects a mutation (negative control)"
else
  commands_ok=0
  nope "commands: every command check detects a mutation (negative control)" \
       "skill-rename detected=$ctrl_skill, default-drift detected=$ctrl_default, list-drift detected=$ctrl_list"
fi

if [ "$commands_ok" -eq 1 ]; then
  ok "Command-file assertions pass"
else
  nope "Command-file assertions pass" "one or more command stages failed above"
fi

printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
