# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-09-06

### Added — the two-round review ceiling, and what reaching it now does (W2172)

The fleet canon (`stride/docs/port-canon.md`, entry `review-round-cap`) puts the
review loop's ceiling at two rounds and makes the terminus depend on what is
still outstanding. Both of its applicability grounds hold here — this port runs
a reviewer and a fix-then-re-review loop that can fail to converge — so the rule
is adopted rather than narrowed.

`max_review_iterations` now defaults to two, and a larger value is clamped
rather than honoured; one is still honoured, because lowering a ceiling is
always safe. The clamp is **performed by a step** in Step 7 rather than
described in the Inputs table, since a bound stated only in a table cell does
not bind the procedure that reads the value. A round is now defined as a
reviewer dispatch that left a readable `## Review Report`, so a dispatch that
errored or wrote nothing is re-dispatched once at no cost in rounds; a
prose-only report is explicitly not an unreadable one and still costs a round.

Reaching the ceiling splits four ways. Remaining `important` and `minor`
findings are recorded in the Completion Summary — by severity, category and
`file:line`, restated rather than pasted — and the task completes, which is a
terminus this port did not have before. A `critical` that still stands is
exempt for exactly one further round, spent once for the whole task and never
renewed; if it still stands after that round the drive stops. A finding whose
`category` is `"security"` is never merely recorded at any severity, and is
judged by what it describes rather than by a label the reviewer assigns itself
— this port's own contract files a `not_met` project check under
`project_check`, which a label-only test would miss. A standing Step 6a or 6c
escalation takes the stop path too.

**This adds no second cap and no new terminal state**, and the standing
prohibition saying so is left unedited: every carve-out routes to the stop Step
7 already had. Only the ordinary terminus moved.

Two things the reference implementation has are recorded here as unable to
apply. There is no round-scoped dispatch, because this port passes its agents
nothing but a task-file path — so round two is a full re-review, which forgoes
a token saving but not the evidence. And there is no durable round-count file:
the plugin writes no state outside the goal directory, and its `## Review
Report` is append-or-replace, so round one's report is overwritten and cannot
serve as the tally either.

### Added — a cosmetic finding is a disposition, and an all-cosmetic round ends the loop (W2172)

An `issues[]` entry may carry an optional boolean `cosmetic` (canon entry
`cosmetic-finding-class`). It is a disposition, not a fourth severity: the entry
keeps its place, its severity and its category, and the top-level verdict is
decided exactly as before. Three shapes are refused — beside any severity other
than `minor`, beside `category: "security"` at any severity, and any value that
is not a real boolean. **The security exclusion ships in the same block as the
flag**, because a port carrying the flag without it would be worse off than one
carrying neither.

The flag is documented locally rather than by citation, on the ground this file
already gives for `security_considerations`: a citation into another repository
cannot be checked from this one. Only the three keys the workflow actually reads
are restated — `severity`, `category`, `cosmetic` — because a fuller local table
becomes a second definition free to drift from the one it was copied from. No
`issue_counts` key was added; it has no consumer here and no rule requires it,
and its absence is pinned negatively.

A `changes_requested` round whose entries are every one of them a real-boolean
`cosmetic` on a non-security `minor`, **with no escalation standing**, does not
increment and does not loop. Every one of those is a conjunct of when the branch
fires, not an observation about what it reads — the branch runs before the
increment, so it never reaches the ceiling's carve-outs and needs each guard of
its own. Step 7 re-reads severity and category itself rather than trusting the
flag, because this port has no submission step and no validator: the report is
written to a file and read straight back, so the reviewer's refusals are
producer-side convention and Step 7 is the only downstream there is.

### Fixed — an approval could carry findings, and the prose fallback read a refusal as one (W2172)

The reviewer's summary-line rule emitted "Approved" whenever there were no
critical or important issues, which let a `minor` carrying
`category: "security"` ride an approval into Step 8, past every carve-out, to be
recorded rather than fixed. `approved` now requires an **empty** `issues[]`,
every severity with `minor` named explicitly, and the top-level verdict
vocabulary — the one field Step 7 actually reads — is documented locally for the
first time. Step 7 additionally refuses a non-conforming approval that carries
findings, routing it into the `changes_requested` branch so it increments and is
bounded like any other refusal rather than looping unbounded.

The JSON-parse fallback substring-matched `"Approved"` first and unanchored, so
a non-conforming summary line reading `Not Approved — 3 issues found` matched —
and non-conforming reports are the only ones that reach this path, since a
conforming one emits JSON. It now tests for refusal first, matches the
affirmative only at the start of the line, and requires the `### Issues`
subsection to be empty. No terminus wording anywhere in the skill may contain
the token that fallback keys on, and the skill says so.

Step 8's review-outcome contract asserted the status is `approved` "by
contract", which both new termini falsify; it now has a third shape that cites
the status the report actually carries and forbids reporting a refused review as
approved. The reviewer's cited `schema_version` moves to the version where the
`cosmetic` key arrived upstream, pinned negatively so a half-done bump across
its two citation sites cannot pass.

### Not applicable — the fleet `dispatch_count` key has nothing to sit on here (W2172)

The canon's `dispatch-count-telemetry` entry puts an optional integer on a
`workflow_steps` entry and binds it to a set of reading limits. This plugin
emits no `workflow_steps` object — its telemetry is a bare array in a committed
markdown file — and has no completion endpoint, so there is no entry in a
submitted payload for the key to sit on and no consumer that could carry the
limits. The canon already records this port `not_applicable`; the grounds its
row cites are now stated in the port under the key's own name, where a reader
looking for the rule will find them, rather than only under a neighbouring
heading.

A second fact is recorded beside it and deliberately labelled differently: the
port's one-entry-per-name telemetry rule, which totals duration across
dispatches, is a design decision taken here rather than a structural
impossibility. Adopting the key would mean revisiting it. Conflating the two
would misfile a chosen divergence as a cannot-apply. **No anchor was added** —
an anchor on a narrowed cell claims a compliance the port does not have.

### Fixed — the ceiling could not evaluate its own security carve-out on the prose-fallback path (W2172)

The reviewer's rendered `### Issues` bullet carries severity, `file:line` and a description — **no `category`**, which lives only in the fenced JSON block. So on a report resolved by the prose fallback the security carve-out had nothing to select on, and the record bullet's instruction to list each finding by `severity`, `category` and `file:line` could not be complied with. This release scoped only the all-cosmetic branch out of that path and said nothing about the record disposition, leaving the guarantee that a `critical` or a security finding never reaches a Completion Summary unbacked on exactly the path carrying the least information.

Reaching the ceiling with a prose-only report now takes the stop path. Recording is available only where the fields the carve-outs turn on are present. Fixed in all three lite ports before any was released, since all three ship the same rendering template and the same scoping sentence.

### Fixed — three restatements of the ceiling contradicted the rule they restate (W2172)

All three found by review, none caught by the suite, and all three the same shape: the change edited Step 7 and left a downstream summary describing the behaviour it replaced.

The `## Edge cases` ceiling bullet still read as an unconditional stop, byte-identical to its pre-change form, while Step 7 now records remaining `important` and `minor` findings and completes. An agent consulting the failure-modes list — the section whose job is exactly this terminal state — would stop the task incomplete on the path the change exists to make complete. Both sibling ports had rewritten the same bullet; this one was missed.

The new re-dispatch-once rule for a failed reviewer dispatch was contradicted in two places: the Edge-cases dispatch bullet and the quick-reference card's self-described "complete list" of what stops the drive. A transient first failure would have aborted the whole goal drive, discarding the free retry Step 7 had just granted.

The quick-reference card also had no entry for the release's headline behaviour. It is the file's designated index into the gates, so it now carries the two termini that complete without an approval — and the note that neither is available on the prose-fallback path.

### Fixed — a closed exception list foreclosed the documented no-review branch (W2172)

The tightened Step 8 conjunction enumerated the two sanctioned non-approval termini as "the only exceptions", which excluded the `skip-all` no-review branch that the same step requires to reach Step 8. The pre-change sentence was merely silent about that path; making the list explicit turned silence into a contradiction. The no-review branch is now named as a different case rather than a third exception — the first conjunct is vacuous there, and the two escalation conjuncts still bind, which matters because Step 6c is gated independently of the decision matrix and a `skip-all` task can genuinely carry a real security consideration.

### Fixed — the summary line and the top-level verdict could disagree (W2172)

The reviewer's prose summary line required an empty `issues[]` and met acceptance criteria; the top-level `status` rule added below it carried a third condition the summary line did not, that no section verdict is `failed`. A `failed` `testing_strategy` with an empty `issues[]` is reachable here, and there the reviewer would have written "Approved" in the human-readable line beside a `changes_requested` verdict — in the file this port calls its whole audit trail. The two rules now state the same three conditions.

The critical carve-out also regained the fleet's closing guard, **Never record a `critical` and complete.**, which both sibling ports carry at that position and this port had dropped, plus the clarification that its extra round is a full re-review since this port passes its agents no parameters.

### Fixed — three restatements that survived the round-2 sweep (W2172)

Found by the round-2 review, which approved the change with these outstanding, and fixed after it — so they carry no review of their own.

The new prose-fallback paragraph restated Step 8's guarantee without its scoping, as though a `critical` or a security finding never appears in a Completion Summary at all. Step 8 scopes it to the recorded-rather-than-fixed bullet, and separately **mandates** recording a *discovered* Critical with its provenance label and carrying it into `goal.md`. A reader taking the unscoped form at face value could have suppressed that mandatory bullet, dropping a real finding from the port's only audit trail. Now scoped as Step 8 scopes it.

The quick-reference card's new block headed "exactly two, both in Step 7" reintroduced one section later exactly the closed-list shape that was removed from the Step 8 conjunction this round: the no-review branch is a third Step 7 path that completes without an approval. The card now carries the reviewed-task qualifier and points at the clean-skip block beside it.

The security-escalation branch's standing prohibition was deliberately left unedited and its normative half is still true — no second cap, and the carve-out routes to the stop Step 7 already had. Its trailing *rationale* had gone stale: exhausting the loop on a consideration is now equivalent to exhausting it on a review finding only for a `critical` or a security one. The rationale is corrected; the prohibition itself is untouched.

All three are the same class as the three fixed earlier in the round — a rule restated in a second place that drifts from the rule. That class is the whole of this release's residual risk, and the presence-check pins cannot see it.

### Fixed — the workflow skill described the canon's reason_code row as deferred (W2172)

The row was moved to `not_applicable` by D302, on the ground that `deferred`
selects which checks run rather than saying how settled a decision is. The
skill, its test comment and the entries above still described the old status.
Corrected in all three; the structural argument and the reopen condition are
unchanged, and the absent anchor remains correct.

### Added — the ported rules are pinned by this port's own suite (W2172)

Both ported rules land as prose: the TypeScript under `src/` wires hooks and the
activation marker and never reads a review verdict, so there is no runtime to
enforce them in, and putting a counter there would mean inventing state nothing
consults. The Bun suite is therefore the only mechanical bound the repository
has, and the skill says plainly that it is a CI gate rather than something a
live drive runs.

Pins were added covering the ceiling and its performing clamp, each of the four
ceiling dispositions including the non-renewal of the `critical` carve-out and
the judge-by-subject clause, the all-cosmetic branch's escalation conjunct and
its severity/category re-check, the non-conforming-approval routing, the
tightened fallback, Step 8's non-approval shape, the redaction rule at both
recorded-finding write sites, both canon anchors at exactly one occurrence, and
negative pins proving no second cap identifier, no `issue_counts` and no anchor
on a narrowed cell.

**Each pin was mutation-tested against the clause it quotes** — that clause
deleted on a verified copy, the suite required to go red on that named test,
the clause restored. Every one binds its own needle.

**That is a narrower claim than it sounds, and review proved why.** A pin binds
the sentence it quotes, not the proposition a reader takes from its name. The
pin named for bounding the `critical` carve-out quoted only the non-renewal
sentence, so deleting the grant it bounds — the one further round itself —
passed the whole suite green; and the clamp pin quoted the formula rather than
the value, so reverting the Inputs-table default was caught only by `smoke.sh`.
Both now pin both halves. Read a pin's coverage from its needle, never from its
name.

**Two limits, stated rather than left implied.** These are presence checks:
they pin a clause against silent deletion and cannot detect a contradiction
added elsewhere in the file — which is how a stale ceiling bullet survived, see
below. And the staleness pin originally tested four digit literals, so a stale
claim phrased entirely in words passed it; it now pins the wording too.


### Added — canon anchors for `decision-matrix-authority` and `row-precedence` (W2119)

The port's workflow skill now carries a `<!-- canon:<id> v<version> -->` anchor
beside each of the two rules it states in its own voice: `row-precedence` beside
the instruction to read the matrix rows top to bottom, and
`decision-matrix-authority` beside the statement that the table is normative on
its own here. Neither anchor restates the rule's substance — the canon owns
that, and a second copy of it in a port is the drift the anchors exist to catch.
`test/skills.test.ts` pins both — binding each anchor to the first line of the
paragraph it governs, so the assertions check placement and not merely
presence — and pins that neither is duplicated. The release gate's own scan is
presence-and-version only and context-free, so an anchor drifting away from its
rule would still report `ok` there.

A short **Canon-governed** note now attributes the matrix rows and the
row-shape paragraphs below to `row-precedence` rather than to
`decision-matrix-authority`, whose anchor precedes them. Without it a
maintainer editing `No separate defect row` — which the canon's `applies_to`
reason for this port quotes — is prompted for the wrong entry. stride resolves
the same ambiguity the same way in its own workflow skill.

No anchor was added for `reason-code-vocabulary`. The canon records this port's
row as `not_applicable`, and an anchor on a narrowed cell would report a
compliance the port does not have; the test asserts its absence for that reason.

### Fixed — the workflow skill's description of its own canon row (W2119)

The `reason_code` section said the canon "marks it required for every port" and
that the drift check "reports the cell missing", with the canon's row named as
the thing still to correct. All three were true when written and none is now:
the canon records per-port applicability, this port's row is `not_applicable`
with the same structural reason the section gives, and the check reads the cell
as narrowed rather than missing. The structural argument, and the condition
under which it reopens, are unchanged.

Documentation and tests only. No rule, flow or reference implementation moved.

## [0.1.0] - 2026-08-24

First release. The OpenCode port of `stride-lite`: it turns a prompt into
Stride-shaped goal and task markdown on disk, and runs the hook sections a
project writes in `.stride_lite.md`. It talks to no server and reads no
credentials.

**Installing it is two steps, and neither works alone.** Registering the plugin
in `opencode.json` starts the hook layer but creates no skills; OpenCode does
not auto-discover skills or agents from inside an installed plugin. Running
`install.sh` (or `install.ps1`) copies them to the discovery paths. Skipping the
second step is a silent partial install — the plugin loads, nothing errors, and
the commands simply are not there. See the README.

**This release is built from what `stride-lite` ships today, and is not at
parity with it.** The behaviours it does not have are listed in the README's
"Not yet ported from stride-lite" section rather than left for a future reader
to rediscover by diffing the two plugins.

### Added

- `install.sh` and `install.ps1`: step two of the two-step install, with a
  per-path clobber refusal that copies nothing when it refuses, and a post-copy
  verification that compares bytes and exits non-zero naming every missing or
  corrupt file.
- A README documenting the two-step install and the silent partial install that
  follows from skipping either half, the discovery paths, the security model,
  and a does-NOT block — with tests asserting the claims rather than the words.
- `AGENTS.md`: the Claude Code to OpenCode tool-name mapping, the installer
  contract and its deliberate divergences, and the hard rules.
- A smoke stage asserting the documented counts against both the repository and
  what `install.sh` actually delivers.
- Vendored stride-lite's fixture corpus (`fixtures/`) at commit `ffb670b`, with
  `fixtures/README.md` recording the source commit and the per-file hashes, and
  byte-identity stages in `test/smoke.sh` that pin all three files offline and
  diff them against stride-lite when it is on disk.
- Pinned the `goal.md` template block, which until now was extracted by nothing
  and compared to nothing — it could have been rewritten with the suite green.
- A conformance stage asserting each fixture carries its template's `## `
  headings in the same order, derived from the template at check time.
- Vendored both template blocks under `fixtures/templates/`, so a template
  failure prints a real `diff -u` offline instead of two hashes — the only case
  a consumer ever has.
- A stage that resolves the recorded stride-lite commit in that repository and
  compares the vendored files — artifacts and templates alike — against that
  commit's content rather than against a moving working tree.

- Repository scaffold: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`,
  a `README` stub and this changelog, plus the empty `skills/`, `agents/`,
  `commands/`, `lib/` and `fixtures/` directories the port fills in.
- The `create-goal`, `create-task` and `init` skills, with OpenCode frontmatter
  and activation descriptions, the decomposer dispatched by `@mention`, and
  `test/smoke.sh` enforcing template parity under `bun test`.
- The `create-goal`, `create-task` and `init` commands as thin shells that parse
  arguments and activate their skill, documented in the README with copy-paste
  examples.
- The activation-marker gate: `src/gate.ts` with a four-hour freshness window and
  a plugin-specific override, wired in after trigger detection and failing open so
  a missing marker never blocks a tool call.
- The workflow orchestrator skill: the eight-step loop with its activation and
  termination contracts, the review cap, the decision matrix, the Bash scope and
  the PENDING-to-IMPLEMENTED archive move, with the hook-execution contract
  written against this plugin rather than a Claude Code hook file.
- The three ported agents — `create-decomposer` (no tool access), `task-explorer`
  and `task-reviewer` — in OpenCode's agent format, with their tool grants
  declared explicitly and asserted by tests.
- Packaging exclusions in the `files` list, so transient artifacts (`.env`,
  `*.local`, the activation marker, exploratory-testing output) cannot be
  published from inside the packed directories. A bare directory entry in
  `files` is recursive and overrides `.gitignore`, so these have to be stated
  explicitly.
