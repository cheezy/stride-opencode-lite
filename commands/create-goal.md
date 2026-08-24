---
description: Turn a free-text prompt plus an optional requirements directory into a written goal directory at `<output-dir>/<slug>/` containing one `goal.md` and one `taskN.md` per child task — readable markdown mirroring the Stride goal/task field contracts. Never POSTs to any API. Usage: `<prompt> [--requirements-dir <path>] [--output-dir <path>]`, defaulting `--requirements-dir` to `docs/requirements` and `--output-dir` to `docs/implementation/PENDING`.
---

# create-goal

Drive the end-to-end create-goal flow: parse the invocation, load any requirements text, dispatch the decomposer, slugify the goal title, resolve a unique output directory, and write `goal.md` plus one `taskN.md` per child task.

**All orchestration lives in `skills/stride-opencode-lite-create-goal/SKILL.md`** — including the validation gates that fire before any file is written. This command is the surface: it parses `$ARGUMENTS` and activates the skill.

## What to do

Follow these steps in order. Do NOT skip steps.

### Step 1: Parse `$ARGUMENTS`

Usage:

```
<prompt> [--requirements-dir <path>] [--output-dir <path>]
```

Hand the unmodified argument string to the `stride-opencode-lite-create-goal` skill. It runs the `lib/parse_args` contract internally to extract:

- `PROMPT` — the positional argument(s), space-joined
- `REQUIREMENTS_DIR` — the value of `--requirements-dir <path>`, default `docs/requirements`
- `OUTPUT_DIR` — the value of `--output-dir <path>`, default `docs/implementation/PENDING`

If `$ARGUMENTS` carries no positional prompt, the skill exits non-zero with a usage line. **Do NOT pre-validate or default the prompt at this layer** — the skill owns that contract, and defaulting here would make the two layers disagree about what an empty invocation means.

### Step 2: Activate the `stride-opencode-lite-create-goal` skill

Activate the skill and pass `$ARGUMENTS` through verbatim. The skill walks every flow step documented in its own `SKILL.md` — argument parsing, requirements loading, the `@create-decomposer` dispatch, slugification, path resolution, and rendering both file kinds.

**Do not restate that flow as a checklist here.** The skill's steps are its own; a copy in this file is a copy that goes stale the first time the skill changes.

### Step 3: Surface the result

Pass the skill's final stdout to the user verbatim. It prints the resolved directory path and the file list — that is the entire output. This command does NOT add a summary, ask follow-up questions, or chain into another tool.

## Defaults

| Flag | Default |
|---|---|
| `--requirements-dir` | `docs/requirements` |
| `--output-dir` | `docs/implementation/PENDING` |

With both defaults the goal directory lands at `docs/implementation/PENDING/<slug>/` — a sibling of any `docs/implementation/PENDING/tasks/<slug>.md` files the create-task command produces.

## What this command does NOT do

- **No business logic in this file.** Decomposition, validation, slugification, path resolution and rendering all happen in the skill and the `lib/` helpers it invokes. A command that starts making decisions is a command that has to be kept in sync with a skill that already makes them.
- **Never POSTs to any API.** The output is markdown on disk; any follow-up is the user's choice.
- **Never overwrites an existing goal directory.** The `resolve_output_path` contract handles collisions by suffixing `-2`, `-3`, and so on.
- **Never asks the user mid-flow.** The prompt and the requirements directory are the entire input. If they are thin, the decomposer makes conservative choices and records them in `decomposition_notes`.
