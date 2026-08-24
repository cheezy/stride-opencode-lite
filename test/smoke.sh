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
  sha_mismatch=0
  for side in goal task; do
    matches_pinned_hash "$WORK/$side.txt" || sha_mismatch=1
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

printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ]
