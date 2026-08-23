# stride-opencode-lite

A lightweight [Stride](https://www.stridelikeaboss.com) plugin for
[OpenCode](https://opencode.ai) — the OpenCode port of `stride-lite`.

It provides the Stride task lifecycle (claiming, completing, and creating tasks
and goals) as OpenCode skills, agents and commands, driven by a `.stride_lite.md`
hook file.

> **Status: scaffold.** The repository layout, package manifest and toolchain are
> in place; the skills, agents, commands and plugin entry point are not yet
> ported. This README is a stub and will be replaced when the port is complete.

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
