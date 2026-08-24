# stride-opencode-lite

A lightweight [Stride](https://www.stridelikeaboss.com) plugin for
[OpenCode](https://opencode.ai) — the OpenCode port of `stride-lite`.

It provides the Stride task lifecycle (claiming, completing, and creating tasks
and goals) as OpenCode skills, agents and commands, driven by a `.stride_lite.md`
hook file.

> **Status: in progress.** The toolchain, hook parser, executor, plugin entry
> point, activation-marker gate, four helper specs, three agents, four skills and
> three commands are in place. **The port is not complete**, and the shortfalls
> are load-bearing rather than cosmetic:
>
> - `lib/select_workflow_branch.md` and the `task-enricher` and
>   `hook-diagnostician` agents are unported (4 of stride-lite's 5 lib specs, 3 of
>   its 5 agents), and no ported skill dispatches them.
> - The two blocking hook triggers are **dormant on today's build** — they key on
>   skills that ship as agents, so `before_task` and `after_task` do not fire.
> - Nothing here has been exercised in a live OpenCode session.
>
> `AGENTS.md` carries the full Known gaps list, which is the authority. This
> README will be expanded when the port is complete.

## Installation — two separate steps

**Installation is two separate steps.** The plugin and the artifacts it drives
are in the same repository but reach OpenCode through different mechanisms, and
each step without the other fails silently in its own way.

### Step 1 — register the plugin

In your project's `opencode.json`, or `~/.config/opencode/opencode.json` for
every project:

```json
{ "plugin": ["github:cheezy/stride-opencode-lite"] }
```

Or clone it into `.opencode/plugins/stride-opencode-lite/` (project) or
`~/.config/opencode/plugins/stride-opencode-lite/` (global). This is what makes
the hook layer run. It does not make any skill exist.

### Step 2 — put the artifacts on disk

> **Important:** OpenCode does NOT auto-discover skills or agents from inside an
> installed plugin. They must live on disk at the documented paths below,
> regardless of whether the plugin is installed via `github:` or locally.

```bash
git clone https://github.com/cheezy/stride-opencode-lite.git
cd stride-opencode-lite
./install.sh            # into ./.opencode/ of the project you are in
./install.sh --global   # into ~/.config/opencode/
```

On Windows, or anywhere with PowerShell:

```powershell
.\install.ps1
.\install.ps1 -Global
```

### What goes wrong if you skip one

| Skipped | Symptom |
|---|---|
| Step 2 | The plugin loads, **nothing errors**, and the commands, skills and agents simply do not exist. This is a **silent partial install** — there is no message telling you what is missing. |
| Step 1 | The skills and commands are discoverable, but no hook section in `.stride_lite.md` ever fires. |

The installers are built around that first failure. Each one refuses to
overwrite an existing file unless you pass `--force` / `-Force`, lists **every**
colliding path, and copies nothing when it refuses. After copying it verifies
what landed **byte for byte** against the source and exits non-zero naming each
file that is missing or corrupt — a partial copy is the exact failure being
guarded against, so a check that cannot fail would be worse than none. It also
warns when no `opencode.json` it can see registers the plugin, which is the only
thing that makes Step 1 visible rather than merely documented.

Neither installer needs elevated privileges. If you are reaching for `sudo`, the
target path is wrong.

**Windows verification status.** `install.ps1` is executed by this repository's
test suite under **PowerShell 7 (`pwsh`) on macOS**, where the suite asserts its
collision refusal, its `-Force` overwrite, its post-copy verification, and that
verification's failure path — plus a parity test requiring it to produce the
identical set of installed paths as `install.sh`. It has **not** been run on
Windows, and not under Windows PowerShell 5.1. Windows-specific behaviour —
`$env:USERPROFILE` resolution, backslash paths, the 260-character path limit,
and execution policy — is therefore **unverified**. `install.sh` is the
installer with real mileage.

## Where the artifacts go

OpenCode walks up from the working directory to the git worktree root looking
for these directories. The first match wins per skill or agent name.

| Resource | Project-local | Global |
|---|---|---|
| Skills | `.opencode/skills/<name>/SKILL.md` (also `.claude/skills/`, `.agents/skills/`) | `~/.config/opencode/skills/<name>/SKILL.md` |
| Agents | `.opencode/agents/<name>.md` | `~/.config/opencode/agents/<name>.md` |
| Commands | `.opencode/commands/<name>.md` | `~/.config/opencode/commands/<name>.md` |

The `lib/` specs are copied to `<config-dir>/lib/` because the skills reference
them by relative path. That is **not** an OpenCode discovery path, and whether
the reference resolves from there in a live session is untested — see the Known
gaps in [AGENTS.md](AGENTS.md).

**A note on names.** The skill directories are namespaced, but the agent and
command filenames are not: `task-explorer.md`, `task-reviewer.md`,
`create-goal.md` and `init.md` are generic, and the full
[`stride-opencode`](https://github.com/cheezy/stride-opencode) plugin ships
agents with two of the same filenames. Prefer a project-local install when both
plugins are in play, and read the collision list if the installer refuses.

**What is not installed**, deliberately: `fixtures/` (a test corpus pinned to
stride-lite, with no runtime role), `src/` (the plugin itself, loaded by
reference rather than copied), `test/`, and `AGENTS.md` — that file is
contributor notes for this repository, not orientation to drop into your project
root.

## Skills

Each skill owns the orchestration for one flow. They activate by intent — from a
command, or from a prompt that matches the skill's description.

| Skill | Does |
|---|---|
| `stride-opencode-lite-create-goal` | Decomposes a prompt into a goal directory: one `goal.md` plus one `taskN.md` per child task |
| `stride-opencode-lite-create-task` | Writes a single task file |
| `stride-opencode-lite-init` | Scaffolds `.stride_lite.md` |
| `stride-opencode-lite-workflow` | Drives a written goal directory task by task, and archives it when done |

## Agents

Agents are dispatched by `@mention`, not by tool call:

| Agent | Role | Tool grants |
|---|---|---|
| `@create-decomposer` | Turns a prompt plus requirements into the goal/task structure | No file or shell access at all — it reasons over what it is given |
| `@task-explorer` | Reads the codebase before a task is implemented | read, grep, glob, edit, write; **no bash** |
| `@task-reviewer` | Reviews a finished task against its own acceptance criteria | All six, with bash restricted to five read-only git invocations |

**Mentioning an agent fires no hook.** `@mention` dispatch emits no
`tool.execute.*` event, which is why the two blocking hook triggers below are
dormant on this build.

## Configuration: `.stride_lite.md`

`init` writes this file at your project root. Hook commands live in it, one
fenced `bash` block per `## section` heading:

````markdown
## email

you@example.com

## before_task

```bash
git pull --ff-only
```

## after_task

```bash
bun test
```

## after_goal

```bash
echo "goal complete"
```
````

The `## email` section is inert data the parser never reads. **No hook context
variables are supplied** — unlike stride-lite's bash runner, this plugin exports
no `TASK_TITLE`, `HOOK_NAME` or similar, so a command referencing one sees an
empty value rather than failing.

## Hook triggers

Hook commands live in your project's `.stride_lite.md`, one fenced `bash` block
per `## section` heading. Each section fires at this point:

| Section | OpenCode event | Trigger | Blocking |
|---|---|---|---|
| `before_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-explorer` | yes |
| `after_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-reviewer` | yes |
| `after_goal` | `tool.execute.after` | tool `edit` or `write`, basename exactly `goal.md`, payload contains `## Completion Summary` | no |

A blocking section aborts the tool call that triggered it when a command fails.
`after_goal` is advisory — its failure is reported but never blocks. A missing
file, a missing section, or an empty block is a clean no-op.

Why these triggers were chosen, and what was rejected, is in [AGENTS.md](AGENTS.md).

## Commands

Each command is a thin shell: it parses arguments and activates the matching
skill, which owns all of the orchestration.

| Command | Activates | Writes |
|---|---|---|
| `create-goal` | `stride-opencode-lite-create-goal` | `<output-dir>/<slug>/goal.md` + one `taskN.md` per child task |
| `create-task` | `stride-opencode-lite-create-task` | `<output-dir>/tasks/<slug>.md` |
| `init` | `stride-opencode-lite-init` | `./.stride_lite.md` |

```
create-goal Add real-time notifications for board comments
create-goal Add notifications --requirements-dir docs/reqs --output-dir build/goals
create-task Fix the typo in the login button label
create-task Harden the CSV importer --requirements-dir docs/reqs
init
init --force
```

## Output layout

```
docs/implementation/PENDING/
  add-real-time-notifications/
    goal.md
    task1.md
    task2.md
  tasks/
    fix-the-login-button-label.md
```

Both create commands default `--requirements-dir` to `docs/requirements` and
`--output-dir` to `docs/implementation/PENDING`. A name collision never
overwrites: the resolver suffixes `-2`, `-3` and so on. When the workflow skill
finishes driving a goal it moves the directory from `PENDING/` to
`IMPLEMENTED/`, preferring `git mv` so the history follows.

## Security model

**Hook commands are arbitrary shell.** Everything in a `.stride_lite.md` section
is executed as verbatim bash with your own privileges. This plugin does not
validate, sanitize or inspect it. If a destructive command is in that file, it
will run. This is the same trust model as a `Makefile` or a git hook — and it
means you should read `.stride_lite.md` before running the workflow in a
repository you did not write.

**The activation marker is not a security control.** The workflow writes
`.stride-opencode-lite/.orchestrator_active` while it is driving a goal, and the
hook layer reads it to decide whether a section may run. It is *coordination,
not security*: writing it is a one-line shell command, so it is trivially
forged, and it is a mode switch rather than an access control. It also **fails
open** — with no marker, a stale one, or an unreadable one, no section runs and
the triggering tool call proceeds untouched. Nothing should ever be authorized
on the strength of it. The real security boundaries in this plugin are the
agents' `tools` maps and `permission` blocks.

## What this plugin does NOT do

- **No Stride API calls.** Nothing here talks to a server. It reads no
  `.stride_auth.md`, needs no token, and cannot claim or complete a task against
  a board. The output is markdown on disk and what you do with it is yours.
- **No environment cache and no changed-files upload.** Two things the full
  Stride plugin does that this one deliberately does not.
- **No `AGENTS.md` installed into your project.** The installers never write it.
- **`init` never runs a hook section.** It writes the config file and stops;
  running one there would execute it twice.
- **Not published to npm.** Install it from the repository.

## Requirements

- [Bun](https://bun.sh)
- `@opencode-ai/plugin` >= 1.0.0 (a peer dependency — this plugin has no runtime
  dependencies of its own)
- `pwsh` is optional, and only for running the `install.ps1` tests; without it
  they report a stated skip rather than passing

## Development

```bash
bun install
bun test          # the suite, including test/smoke.sh and the installer tests
bun run typecheck # tsc --noEmit
```

## Related

- [`stride-lite`](https://github.com/cheezy/stride-lite) — the plugin this port follows
- [`stride-opencode`](https://github.com/cheezy/stride-opencode) — the full Stride plugin for OpenCode

## License

MIT — see [LICENSE](LICENSE).
