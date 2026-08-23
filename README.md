# stride-opencode-lite

A lightweight [Stride](https://www.stridelikeaboss.com) plugin for
[OpenCode](https://opencode.ai) — the OpenCode port of `stride-lite`.

It provides the Stride task lifecycle (claiming, completing, and creating tasks
and goals) as OpenCode skills, agents and commands, driven by a `.stride_lite.md`
hook file.

> **Status: in progress.** The repository layout, toolchain, hook parser,
> executor and plugin entry point are in place. The skills, agents and commands
> are not yet ported. This README is a stub and will be replaced when the port
> is complete.

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
