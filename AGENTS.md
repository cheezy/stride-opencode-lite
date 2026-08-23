# stride-opencode-lite — agent notes

> **Scope note.** This file was started by the plugin-wiring task to record the
> hook trigger design that task chose. The documentation task that writes the
> full `AGENTS.md` should **append** to it rather than rewrite it — the trigger
> table and the design record below are the wiring's own contract, and the
> tests assert the table matches the implementation.

## Hook triggers

| Section | OpenCode event | Trigger | Blocking |
|---|---|---|---|
| `before_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-explorer` | yes |
| `after_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-reviewer` | yes |
| `after_goal` | `tool.execute.after` | tool `edit` or `write`, basename exactly `goal.md`, payload contains `## Completion Summary` | no |

## Why these triggers

### The problem

stride-lite fires its two blocking sections off an **Agent dispatch**, keyed on
`subagent_type == task-explorer` / `task-reviewer`. That trigger cannot be
ported literally: OpenCode dispatches subagents by `@mention`, which emits no
`tool.execute.*` event, so there is nothing to intercept. A trigger had to be
chosen rather than translated.

The phase split, by contrast, was not a choice. Throwing inside
`tool.execute.before` aborts the tool call, and `tool.execute.after` fires after
execution and can never roll one back. So the two blocking sections must live in
the before phase and the advisory one in the after phase — the requirement that
blocking sections block and the advisory one does not is satisfied structurally,
not by convention.

### The chosen trigger

The native **skill-activation tool** — matched against every spelling the full
OpenCode plugin records (`skill`, `activate_skill`, `loadSkill`, `load_skill`) —
with the activated skill's name compared by exact string equality. This is a structural 1:1 with stride-lite's
`subagent_type`: the same discriminator in the same position, naming the same
two roles, on a different host.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Literal `Agent` / `subagent_type` port | Mechanically impossible — OpenCode has no interceptable Agent-dispatch tool call. |
| Matching a `bash` command pattern | An unbounded false-positive class on a **blocking** hook: any shell command resembling the pattern would abort a user's tool call. |
| A write to a task file | Conflates file mutation with a lifecycle point, and cannot distinguish `before_task` from `after_task`. |
| An explicit sentinel file the agent writes | The throw would abort the sentinel write, not the dispatch it stands for — blocking would be nominal rather than real. |
| Matching only the single tool name `skill` | Risks a **dormant hook**: the full OpenCode plugin records four skill-activation spellings, and matching one would leave the hook silently inert on a host emitting another. Widening costs almost nothing because the skill *name* is the real gate. |
| Sniffing the prompt text | Pattern matching on free text, on the blocking path. Same objection as bash matching, with a larger surface. |

### False-positive bound

**Blocking sections.** The path is exact string equality on two fields — the
tool name must be one of the four skill-activation spellings, and the skill name
must equal one of the two constants. The tool name alone can never fire a hook,
which is why widening that list does not widen the bound. No pattern, prefix, or substring match reaches it. The only way to
trigger one without being in the workflow is to activate one of those two named
skills directly, which is a deliberate act. Nothing else in a session can reach
the throw.

**Advisory section.** `after_goal` searches the resolved **arguments** record
for the heading, across every field rather than a named one. The field-agnostic
part is deliberate: the SDK documents no field names for the `edit` and `write`
arguments, so pinning one would give silent **false negatives**, and a missed
advisory hook surfaces nowhere at all.

The search deliberately stops at the arguments and does **not** cover the whole
event. The after phase's `output` is `{title, output, metadata}` — the tool's own
application output — so searching the event would let a heading that a fetched
document, a generated report or a rendered diff merely *contains* decide that a
goal had completed. That would key the trigger on a string untrusted content can
cause to appear. Both trigger tools carry the written text in their arguments,
so narrowing the search costs no legitimate match.

One false positive remains and is accepted: an edit that *removes* the heading
still carries that text in its arguments, so it fires. The section cannot block,
so the cost is one extra advisory run rather than an aborted call.

**Skill names are normalised before comparison** — trimmed, and stripped of a
namespace prefix drawn from a literal allow-list (`stride:`,
`stride-opencode-lite:`), because OpenCode may namespace a skill by its owning
plugin. Comparing the raw value would leave both blocking hooks dormant on such a
host.

The allow-list is what preserves the bound. Stripping an arbitrary `prefix:`
would let the blocking path fire on an unbounded family of names — `evil:<trigger>`
would route — so the bound rests on the allow-list *and* the equality, not on the
equality alone. A near-miss test pins that foreign namespaces route to nothing.

### Known gaps

- **The two blocking triggers depend on the workflow-skill task shipping two
  distinct skills** under the names above. If it ships a single orchestrator
  skill instead, the two sections become indistinguishable and this contract
  must be revisited. No session-ordinal fallback is implemented: a stated
  limitation is better than a fabricated trigger. The constants are exported as
  `BEFORE_TASK_SKILL` and `AFTER_TASK_SKILL`, and the documentation tests compare
  them against the trigger tables — which hold the names literally — so a rename
  breaks a test rather than silently breaking routing.
- **Hook environment variables are not supplied.** stride-lite's bash script
  derives `HOOK_NAME`, `TASK_FILE`, `TASK_TITLE` and similar and exports them
  for the user's commands. The executor here takes no `env` option, so those
  variables are absent. Commands that reference them see empty values rather
  than failing.
- **The two manual tests are owed.** The task asks for exploration against a
  real OpenCode session: whether each section fires at the moment the workflow
  says it does, and whether ordinary unrelated tool use trips a hook. Neither was
  performed, because no live OpenCode session was available. The near-miss suite
  is a genuine automated stand-in for the second — it pins that reads, bash
  writes, wrong basenames, wrong skill names, foreign namespaces and
  wrong-phase events all route to nothing — but **nothing stands in for the
  first**, which needs a real session to confirm the chosen triggers actually
  fire when the workflow reaches those points. That is the check most likely to
  invalidate the trigger design, and it remains outstanding.
- **The advisory handler's `catch` is unreachable today** and is deliberately
  not covered by a test rather than covered by a fabricated one. It is kept as
  defence for the never-blocks contract should the parser or executor ever gain
  a throwing path.
- **The timeout is per command, not per section.** stride-lite's 60s budget
  covers a whole hook invocation; here each command gets its own 60s.

## What this plugin does not do

It performs no API detection, keeps no environment cache, uploads no changed
files, and reads no credential or auth file. It reads exactly one file — the
project's `.stride_lite.md` — and runs the commands the user wrote in it. A test
scans the entry point's source for the forbidden tokens and pins its import list.
