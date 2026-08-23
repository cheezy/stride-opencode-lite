# stride-opencode-lite — agent notes

> **Scope note.** This file was started by the plugin-wiring task to record the
> hook trigger design that task chose. The documentation task that writes the
> full `AGENTS.md` should **append** to it rather than rewrite it — the trigger
> table and the design record below are the wiring's own contract, and the
> tests assert the table matches the implementation.

## Hook triggers

| Section | OpenCode event | Trigger | Blocking |
|---|---|---|---|
| `before_task` | `tool.execute.before` | tool `skill`, skill name exactly `stride-opencode-lite-task-explorer` | yes |
| `after_task` | `tool.execute.before` | tool `skill`, skill name exactly `stride-opencode-lite-task-reviewer` | yes |
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

The native **skill-activation tool**, matched on the activated skill's name by
exact string equality. This is a structural 1:1 with stride-lite's
`subagent_type`: the same discriminator in the same position, naming the same
two roles, on a different host.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Literal `Agent` / `subagent_type` port | Mechanically impossible — OpenCode has no interceptable Agent-dispatch tool call. |
| Matching a `bash` command pattern | An unbounded false-positive class on a **blocking** hook: any shell command resembling the pattern would abort a user's tool call. |
| A write to a task file | Conflates file mutation with a lifecycle point, and cannot distinguish `before_task` from `after_task`. |
| An explicit sentinel file the agent writes | The throw would abort the sentinel write, not the dispatch it stands for — blocking would be nominal rather than real. |
| Widening the tool allowlist beyond `skill` | Every added tool widens the blocking path's false-positive surface for no gain. |
| Sniffing the prompt text | Pattern matching on free text, on the blocking path. Same objection as bash matching, with a larger surface. |

### False-positive bound

**Blocking sections.** The path is exact string equality on two fields — the
tool name must be `skill`, and the skill name must equal one of the two
constants. No pattern, prefix, or substring match reaches it. The only way to
trigger one without being in the workflow is to activate one of those two named
skills directly, which is a deliberate act. Nothing else in a session can reach
the throw.

**Advisory section.** `after_goal` inherits stride-lite's whole-payload grep,
and therefore its false positive: an edit that *removes* the completion heading
still contains the heading text in its payload, so it fires. This is deliberate.
The SDK documents no field names for the `edit` and `write` tool arguments, so a
field-specific check would produce silent **false negatives** — and a missed
advisory hook surfaces nowhere at all, while a spurious one merely runs an
advisory section twice. Given the choice, the failure that is visible is the
better one.

### Known gaps

- **The two blocking triggers depend on the workflow-skill task shipping two
  distinct skills** under the names above. If it ships a single orchestrator
  skill instead, the two sections become indistinguishable and this contract
  must be revisited. No session-ordinal fallback is implemented: a stated
  limitation is better than a fabricated trigger. The constants are exported as
  `BEFORE_TASK_SKILL` and `AFTER_TASK_SKILL`, and the tests assert their literal
  values, so a rename breaks a test rather than silently breaking routing.
- **Hook environment variables are not supplied.** stride-lite's bash script
  derives `HOOK_NAME`, `TASK_FILE`, `TASK_TITLE` and similar and exports them
  for the user's commands. The executor here takes no `env` option, so those
  variables are absent. Commands that reference them see empty values rather
  than failing.
- **The timeout is per command, not per section.** stride-lite's 60s budget
  covers a whole hook invocation; here each command gets its own 60s.

## What this plugin does not do

It performs no API detection, keeps no environment cache, uploads no changed
files, and reads no credential or auth file. It reads exactly one file — the
project's `.stride_lite.md` — and runs the commands the user wrote in it. A test
scans the entry point's source for the forbidden tokens and pins its import list.
