---
description: Scaffold a project-local `.stride_lite.md` config file in the current working directory with the canonical four sections (`## email`, `## before_task`, `## after_task`, `## after_goal`). Refuses to clobber an existing `.stride_lite.md` unless `--force` is supplied. This command never executes the hook sections — it only writes the file. Never POSTs to any API. Usage: `[--force]`.
---

# init

Scaffold a project-local `.stride_lite.md` in the current working directory.

**All orchestration lives in `skills/stride-opencode-lite-init/SKILL.md`** — argument parsing, the canonical template, the collision check and the success-message contract. This command is the surface: it parses `$ARGUMENTS` and activates the skill.

## What to do

Follow these steps in order. Do NOT skip steps.

### Step 1: Parse `$ARGUMENTS`

Usage:

```
[--force]
```

Hand the unmodified argument string to the `stride-opencode-lite-init` skill. It parses the single optional flag internally:

- **(no args)** — write `.stride_lite.md` only if nothing is already there
- **`--force`** — overwrite an existing `.stride_lite.md`, or proceed normally when none exists

Any other argument is a hard error surfaced by the skill, **not silently absorbed by this command**.

### Step 2: Activate the `stride-opencode-lite-init` skill

Activate the skill and pass `$ARGUMENTS` through verbatim.
The skill walks every flow step documented in `skills/stride-opencode-lite-init/SKILL.md`:

1. Parse the optional `--force` flag
2. Collision-check `./.stride_lite.md` and write the canonical four-section template
3. Print the success message instructing the user to fill in the fields

**This list mirrors the skill; it does not define it.** The skill owns the flow, and the introducing sentence deliberately says "every flow step" rather than naming a number, so the list can gain or lose an entry without this prose becoming false.

### Step 3: Surface the result

Pass the skill's stdout to the user verbatim. It prints a multi-line success message identifying the written file and listing the sections the user needs to fill in. This command does NOT add a summary, ask follow-up questions, or chain into another tool.

## What this command does NOT do

- **No business logic in this file.** Parsing, collision-checking, template-writing and message-printing all happen in the skill.
- **Never POSTs to any API.** This plugin makes no network calls.
- **Never executes the hook sections itself.** This command is a pure scaffolder. The sections it writes are fired by this plugin's own hooks from `src/index.ts`: `before_task` and `after_task` from `tool.execute.before`, where a failure throws and aborts the triggering tool call, and `after_goal` from `tool.execute.after`, which is advisory because that phase cannot roll a call back. Running a section here as well would execute it twice.
- **Never writes outside the current working directory.** The target is always `./.stride_lite.md`, relative to the cwd at invocation.
- **Never asks the user mid-flow.** The invocation is fire-and-forget — no prompts, no confirmations.
