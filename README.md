# stride-opencode-lite

A lightweight [Stride](https://www.stridelikeaboss.com) plugin for
[OpenCode](https://opencode.ai) — the OpenCode port of `stride-lite`.

It provides the Stride task lifecycle (claiming, completing, and creating tasks
and goals) as OpenCode skills, agents and commands, driven by a `.stride_lite.md`
hook file.

> **Status: in progress.** The toolchain, hook parser, executor, plugin entry
> point, activation-marker gate, helper specs, agents, skills and commands are in
> place. This README will be expanded when the port is complete.

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

Both create commands default `--requirements-dir` to `docs/requirements` and
`--output-dir` to `docs/implementation/PENDING`. Neither POSTs to any API — the
output is markdown on disk. `init` only writes the config file; it never runs a
hook section.

## Requirements

- [Bun](https://bun.sh)
- `@opencode-ai/plugin` >= 1.0.0 (a peer dependency — this plugin has no runtime
  dependencies of its own)

## Development

```bash
bun install
bun test          # run the test suite
bun run typecheck # tsc --noEmit
```

## Related

- [`stride-lite`](https://github.com/cheezy/stride-lite) — the plugin this port follows
- [`stride-opencode`](https://github.com/cheezy/stride-opencode) — the full Stride plugin for OpenCode

## License

MIT — see [LICENSE](LICENSE).
