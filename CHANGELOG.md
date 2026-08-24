# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
