---
name: stride-opencode-lite-workflow
description: Orchestrates the stride-lite task lifecycle in OpenCode. STUB — the plugin-wiring task created this file to carry the hook contract table; the workflow-port task supplies the orchestration procedure.
---

# stride-opencode-lite workflow

> **Scope note — this file is a stub.** The plugin-wiring task created it to
> hold the hook contract table below, because the wiring's tests assert that
> this table matches the implementation. The workflow-port task should
> **append** the orchestration procedure to it rather than rewrite it, and
> should keep the table byte-identical unless it also changes `src/index.ts`
> and the copies in `AGENTS.md` and `README.md`.

## Hook contract

| Section | OpenCode event | Trigger | Blocking |
|---|---|---|---|
| `before_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-explorer` | yes |
| `after_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-reviewer` | yes |
| `after_goal` | `tool.execute.after` | tool `edit` or `write`, basename exactly `goal.md`, payload contains `## Completion Summary` | no |

The two blocking sections abort the tool call that triggered them when they
fail. `after_goal` is advisory: its failure is reported but never blocks,
because `tool.execute.after` fires after execution and cannot roll a tool call
back.

The rationale for these triggers, the alternatives that were rejected, and the
false-positive bound are recorded in [AGENTS.md](../../AGENTS.md).

## Configuration

Hook commands live in the project's `.stride_lite.md`, one fenced `bash` block
per `## section` heading. Commands run one at a time and stop at the first
failure. A missing file, a missing section, or an empty block is a clean no-op.
