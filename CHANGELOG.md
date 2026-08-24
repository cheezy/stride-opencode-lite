# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-24

First release. The OpenCode port of `stride-lite`: it turns a prompt into
Stride-shaped goal and task markdown on disk, and runs the hook sections a
project writes in `.stride_lite.md`. It talks to no server and reads no
credentials.

**Installing it is two steps, and neither works alone.** Registering the plugin
in `opencode.json` starts the hook layer but creates no skills; OpenCode does
not auto-discover skills or agents from inside an installed plugin. Running
`install.sh` (or `install.ps1`) copies them to the discovery paths. Skipping the
second step is a silent partial install — the plugin loads, nothing errors, and
the commands simply are not there. See the README.

**This release is built from what `stride-lite` ships today, and is not at
parity with it.** The behaviours it does not have are listed in the README's
"Not yet ported from stride-lite" section rather than left for a future reader
to rediscover by diffing the two plugins.

### Added

- `install.sh` and `install.ps1`: step two of the two-step install, with a
  per-path clobber refusal that copies nothing when it refuses, and a post-copy
  verification that compares bytes and exits non-zero naming every missing or
  corrupt file.
- A README documenting the two-step install and the silent partial install that
  follows from skipping either half, the discovery paths, the security model,
  and a does-NOT block — with tests asserting the claims rather than the words.
- `AGENTS.md`: the Claude Code to OpenCode tool-name mapping, the installer
  contract and its deliberate divergences, and the hard rules.
- A smoke stage asserting the documented counts against both the repository and
  what `install.sh` actually delivers.
- Vendored stride-lite's fixture corpus (`fixtures/`) at commit `ffb670b`, with
  `fixtures/README.md` recording the source commit and the per-file hashes, and
  byte-identity stages in `test/smoke.sh` that pin all three files offline and
  diff them against stride-lite when it is on disk.
- Pinned the `goal.md` template block, which until now was extracted by nothing
  and compared to nothing — it could have been rewritten with the suite green.
- A conformance stage asserting each fixture carries its template's `## `
  headings in the same order, derived from the template at check time.
- Vendored both template blocks under `fixtures/templates/`, so a template
  failure prints a real `diff -u` offline instead of two hashes — the only case
  a consumer ever has.
- A stage that resolves the recorded stride-lite commit in that repository and
  compares the vendored files — artifacts and templates alike — against that
  commit's content rather than against a moving working tree.

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
