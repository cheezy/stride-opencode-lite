# stride-opencode-lite — agent notes

> **Scope note.** This file was started by the plugin-wiring task to record the
> hook trigger design that task chose. The documentation task that writes the
> full `AGENTS.md` should **append** to it rather than rewrite it — the trigger
> table and the design record below are the wiring's own contract, and the
> tests assert the table matches the implementation.

## Hook triggers

| Section | OpenCode event | Trigger | Blocking |
|---|---|---|---|
| `before_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-explorer` | yes |
| `after_task` | `tool.execute.before` | a skill-activation tool, skill name exactly `stride-opencode-lite-task-reviewer` | yes |
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

The native **skill-activation tool** — matched against every spelling the full
OpenCode plugin records (`skill`, `activate_skill`, `loadSkill`, `load_skill`) —
with the activated skill's name compared by exact string equality. This is a structural 1:1 with stride-lite's
`subagent_type`: the same discriminator in the same position, naming the same
two roles, on a different host.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Literal `Agent` / `subagent_type` port | Mechanically impossible — OpenCode has no interceptable Agent-dispatch tool call. |
| Matching a `bash` command pattern | An unbounded false-positive class on a **blocking** hook: any shell command resembling the pattern would abort a user's tool call. |
| A write to a task file | Conflates file mutation with a lifecycle point, and cannot distinguish `before_task` from `after_task`. |
| An explicit sentinel file the agent writes | The throw would abort the sentinel write, not the dispatch it stands for — blocking would be nominal rather than real. |
| Matching only the single tool name `skill` | Risks a **dormant hook**: the full OpenCode plugin records four skill-activation spellings, and matching one would leave the hook silently inert on a host emitting another. Widening costs almost nothing because the skill *name* is the real gate. |
| Sniffing the prompt text | Pattern matching on free text, on the blocking path. Same objection as bash matching, with a larger surface. |

### False-positive bound

**Blocking sections.** The path is exact string equality on two fields — the
tool name must be one of the four skill-activation spellings, and the skill name
must equal one of the two constants. The tool name alone can never fire a hook,
which is why widening that list does not widen the bound. No pattern, prefix, or substring match reaches it. The only way to
trigger one without being in the workflow is to activate one of those two named
skills directly, which is a deliberate act. Nothing else in a session can reach
the throw.

**Advisory section.** `after_goal` searches the resolved **arguments** record
for the heading, across every field rather than a named one. The field-agnostic
part is deliberate: the SDK documents no field names for the `edit` and `write`
arguments, so pinning one would give silent **false negatives**, and a missed
advisory hook surfaces nowhere at all.

The search deliberately stops at the arguments and does **not** cover the whole
event. The after phase's `output` is `{title, output, metadata}` — the tool's own
application output — so searching the event would let a heading that a fetched
document, a generated report or a rendered diff merely *contains* decide that a
goal had completed. That would key the trigger on a string untrusted content can
cause to appear. Both trigger tools carry the written text in their arguments,
so narrowing the search costs no legitimate match.

One false positive remains and is accepted: an edit that *removes* the heading
still carries that text in its arguments, so it fires. The section cannot block,
so the cost is one extra advisory run rather than an aborted call.

**Skill names are normalised before comparison** — trimmed, and stripped of a
namespace prefix drawn from a literal allow-list (`stride:`,
`stride-opencode-lite:`), because OpenCode may namespace a skill by its owning
plugin. Comparing the raw value would leave both blocking hooks dormant on such a
host.

The allow-list is what preserves the bound. Stripping an arbitrary `prefix:`
would let the blocking path fire on an unbounded family of names — `evil:<trigger>`
would route — so the bound rests on the allow-list *and* the equality, not on the
equality alone. A near-miss test pins that foreign namespaces route to nothing.

### Known gaps

- **The two blocking triggers depend on the workflow-skill task shipping two
  distinct skills** under the names above. If it ships a single orchestrator
  skill instead, the two sections become indistinguishable and this contract
  must be revisited. No session-ordinal fallback is implemented: a stated
  limitation is better than a fabricated trigger. The constants are exported as
  `BEFORE_TASK_SKILL` and `AFTER_TASK_SKILL`, and the documentation tests compare
  them against the trigger tables — which hold the names literally — so a rename
  breaks a test rather than silently breaking routing.
- **Hook environment variables are not supplied.** stride-lite's bash script
  derives `HOOK_NAME`, `TASK_FILE`, `TASK_TITLE` and similar and exports them
  for the user's commands. The executor here takes no `env` option, so those
  variables are absent. Commands that reference them see empty values rather
  than failing.
- **The two manual tests are owed.** The task asks for exploration against a
  real OpenCode session: whether each section fires at the moment the workflow
  says it does, and whether ordinary unrelated tool use trips a hook. Neither was
  performed, because no live OpenCode session was available. The near-miss suite
  is a genuine automated stand-in for the second — it pins that reads, bash
  writes, wrong basenames, wrong skill names, foreign namespaces and
  wrong-phase events all route to nothing — but **nothing stands in for the
  first**, which needs a real session to confirm the chosen triggers actually
  fire when the workflow reaches those points. That is the check most likely to
  invalidate the trigger design, and it remains outstanding.
- **The advisory handler's `catch` is unreachable today** and is deliberately
  not covered by a test rather than covered by a fabricated one. It is kept as
  defence for the never-blocks contract should the parser or executor ever gain
  a throwing path.
- **The timeout is per command, not per section.** stride-lite's 60s budget
  covers a whole hook invocation; here each command gets its own 60s.

## What this plugin does not do

It performs no API detection, keeps no environment cache, uploads no changed
files, and reads no credential or auth file. It reads exactly one file — the
project's `.stride_lite.md` — and runs the commands the user wrote in it. A test
scans the entry point's source for the forbidden tokens and pins its import list.

## Repository layout

| Path | Holds |
|---|---|
| `src/` | The TypeScript plugin: the hook parser, the executor, and the entry point |
| `lib/` | One markdown **spec** per pure helper — normative documentation, not code |
| `skills/` | Skill definitions |
| `agents/` | Agent definitions |
| `commands/` | Command definitions |
| `fixtures/` | Test fixtures |
| `test/` | Scaffold and packaging tests (module tests are co-located in `src/`) |

## The `lib/` convention

`lib/` holds one markdown **spec** per pure helper — not executable code. Each
spec is the normative definition of a helper that a runtime then implements.

Four helpers are ported from stride-lite, and their specs are the contract:

| Helper | Purpose |
|---|---|
| [`parse_args`](lib/parse_args.md) | Extract the prompt and the `--requirements-dir` / `--output-dir` flags from argv |
| [`load_requirements_dir`](lib/load_requirements_dir.md) | Concatenate a requirements directory's text files, with headers |
| [`slugify`](lib/slugify.md) | Normalise a free-text prompt into a filesystem-safe slug |
| [`resolve_output_path`](lib/resolve_output_path.md) | Resolve a non-existent output path, suffixing `-2`, `-3`, … on collision |

### Transliterate without renaming

**The reference implementations in these specs are normative.** A runtime that
needs an executable helper transliterates the bash from the spec **without
renaming functions or changing exit-code semantics**. `parse_args`,
`load_requirements_dir`, `slugify` and `resolve_output_path` keep those names,
their stdout contracts, and their exit codes wherever they are implemented — a
port that renames them is a port that has broken the contract.

The defaults are part of that contract too: `docs/requirements` for the
requirements directory and `docs/implementation/PENDING` for the output base.

### Adding a new helper to `lib/`

1. Follow the format: **Contract table**, **Spec/Rules**, a bash **reference
   implementation**, **Examples**, and **Edge cases**.
2. Document inputs as a table, and state the stdout contract — including
   trailing-newline behaviour — alongside an exit-codes table.
3. Keep helpers **pure**: no global state, no network, no directory creation.
4. Write errors to stderr, prefixed `<helper_name>: <reason>`.
5. Update the repository layout notes in this file.

## Agents

| File | Mention | Mode | Temp | Tool grants | Purpose |
|---|---|---|---|---|---|
| `agents/create-decomposer.md` | `@create-decomposer` | subagent | 0.3 | *none* | Turns a prompt plus requirements text into a structured decomposition, inline only |
| `agents/task-explorer.md` | `@task-explorer` | subagent | 0.2 | read, grep, glob, edit, write | Enriches a task file with codebase context, writing an `## Exploration Report` into it |
| `agents/task-reviewer.md` | `@task-reviewer` | subagent | 0.2 | read, grep, glob, bash, edit, write | Reviews a diff against a task file, writing a `## Review Report` into it |

### `@mention` dispatch

Agents are invoked by `@mention` — `@task-explorer`, `@task-reviewer`,
`@create-decomposer` — using the bare filename stem. The full OpenCode plugin
documents the same convention (its README names `.opencode/agents/` and gives
`@task-explorer` as the example form), and its tool mapping records `Agent` →
`@agent-name`.

**Agent mentions are a separate namespace from the hook-trigger skill names, and
mentioning an agent fires no hook.** The trigger table above keys on skill
activation because an `@mention` emits no `tool.execute.*` event at all — that is
the whole reason the trigger had to be chosen rather than translated. Naming an
agent file after a trigger skill would therefore buy no wiring while strongly
implying it does, so the two namespaces are kept deliberately distinct.

### The tool grants

The grants are the security boundary of this layer, and each is asserted by a
test rather than left to review:

- **`create-decomposer` gets nothing** — an explicit all-`false` map for all six
  keys, not an omitted `tools:` key. stride-lite asserts this agent's lack of
  access in prose only; declaring it here makes it enforceable. The explicit form
  is also the safe branch under an open question: if an omitted key means
  "inherit the default set", omission would silently hand the agent everything
  with no visible symptom, whereas all-`false` is correct either way.
- **`task-explorer` has no `bash`.** It cannot execute anything *directly* — and
  that qualifier is load-bearing. **Write access is itself an escalation
  primitive, and this repository ships the sink.** `routeAfter` in `src/index.ts`
  fires on any `edit`/`write` whose basename is `goal.md` and whose arguments
  carry `## Completion Summary`, then reads `.stride_lite.md` from disk and
  executes the commands in the matched section. An agent holding write but not
  bash can therefore write `.stride_lite.md` with arbitrary shell, then write any
  `goal.md` containing that heading, and the plugin runs it — no bash grant and no
  human step. The generic sinks are open too: git hooks, `package.json` scripts,
  and an `opencode.json` granting a future session bash.

  What is in place: `permission.bash: deny` and `permission.external_directory:
  deny` on the explorer, and the body scopes `edit`/`write` to the supplied
  `task_file_path`. **The body scope is prose inside a prompt, not host
  enforcement**, and the frontmatter has no path-scoped edit permission to
  express it with. **Still owed:** a `tool.execute.before` guard that rejects an
  `edit`/`write` from this agent whose resolved path is not the task file, and a
  narrower `routeAfter` so an arbitrary agent-authored `goal.md` cannot trigger
  the hook. Both live in `src/index.ts`, not in an agent definition, so they are
  recorded here rather than fixed under a task that ports agents.
- **`task-reviewer`'s `bash` is the only DIRECT execution path in the agent
  layer.** It is bounded twice over. In the body, by an explicit prohibition list
  with a closed allow list — "read-only git" is not a safe class, because
  `git -c core.pager=…`, `git bisect run`, `git fetch ext::…`,
  `git submodule update` and `git grep -O…` all execute arbitrary programs under a
  `git` name, and a plain `git diff` honours `diff.external` and `textconv`, which
  is why the allowed diff invocations carry `--no-ext-diff --no-textconv`. And in
  the frontmatter, by `permission.bash` as a default-`deny` pattern map that allows
  only those five invocations — so an unlisted command is refused by the host
  rather than by the model's own classification.

- **`permission` blocks back every `tools` map.** A six-key `tools` enumeration
  cannot deny a namespace that is open and runtime-extensible: the SDK types it as
  `{ [key: string]: boolean }` over "all available tool IDs, including
  dynamically registered tools", so `patch`, `webfetch` and any MCP-registered
  tool are simply unnamed by it. `permission` is a closed vocabulary — `edit`,
  `bash`, `webfetch`, `doom_loop`, `external_directory` — so it cannot be defeated
  by a new tool appearing. Both layers are declared; where they overlap they
  agree.

**A reading worth being able to overturn.** The task specified "task-explorer
declares read, grep and glob; task-reviewer declares those plus bash", while also
requiring both agents' append-or-replace contract be preserved — a contract that
cannot run without `edit` and `write`. Those grants are therefore included, on the
reading that the specification enumerates the read/search half of the tool
translation and that the constraint being drawn is about **execution** (`bash`),
which is what the pitfalls actually restrict. Note this is not a widening
relative to the source: stride-lite grants both agents `Edit` and `Write`, and
the literal reading would be a *narrowing* that leaves both agents able to
compute a report and unable to emit it. Recorded here so it can be reversed
deliberately rather than discovered.

### Deliberate divergence from stride-lite

`lib/load_requirements_dir.md` is **not** byte-identical to its stride-lite
source, and that is intentional.

The source spec claimed that `find -L` "follows symlinks for regular files, but
symlinked directories are NOT followed beyond the first level — this caps the
recursion depth and avoids cycles." That claim is false about the spec's own
normative implementation: `find -L` descends into symlinked directories to
arbitrary depth. Verified empirically. The consequence was that a runtime
transliterating the bash inherited an unbounded filesystem read *while believing
it was contained* — a symlink inside the requirements directory could pull any
file the invoking user can read into a prompt.

This port therefore:

- states what `find -L` actually does, rather than what the source claimed;
- adds a **containment check** that resolves each candidate — including a
  symlinked final component, up to **8 hops** — and skips anything landing
  outside the resolved directory. A chain still unresolved at the cap is skipped
  outright rather than measured, because a partially-resolved path can sit
  inside the directory while the kernel follows the rest out of it. The cap is
  well below every platform's `SYMLOOP_MAX` (32 on macOS, ~40 on Linux) so it
  binds first and is reachable. Symlinked files pointing *inside* still work,
  which is the behaviour the source meant to describe;
- downgrades the `=== path ===` markers from "an unambiguous boundary" to what
  they are: a readable separator that file content can forge, with the assembled
  block called out as untrusted data.

**stride-lite carries the same defect and should be fixed at the source, after
which this file and the byte-identity check should be reconciled.**

**A second, smaller divergence: the agents carry a secrets instruction the
sources do not.** Security requires all three agents be told never to copy
credentials, tokens or secret-bearing lines into their reports. None of the three
stride-lite sources contains any such instruction — verified by grep for
`secret|credential|token|redact|api key|password`, which returns zero hits across
all three. So this is an **addition**, not a preservation: one bullet per agent,
in each file's existing rules section, placed away from the Review Report's JSON
block so the structured keys stay untouched. stride-lite should gain the same
instruction at source.

**Scoping the byte-identity exemption.** Do **not** blanket-exempt this file —
that would silently accept any future unintended drift in the one helper that is
now security-relevant. Exempt exactly these regions, and require byte-identity
for the rest of the file:

- the symlink bullet in **File selection rules**;
- the two symlink bullets and the unreadable-directory bullet in **Edge cases**;
- output-format rule 2 and the two `===`-marker pitfalls;
- the containment block and the resolved-base lines inside the **reference
  implementation**.

`test/load_requirements_dir.spec.test.ts` pins the behaviour those regions
describe, by extracting and running the spec's own bash. It is the check that
covers what byte-identity no longer can, and it is where a regression in this
control surfaces. The other three helper specs remain faithful ports and are
fully in scope for byte-identity.

### What was deliberately not ported

**Two agents are not ported.** stride-lite's `agents/` holds five;
`hook-diagnostician.md` and `task-enricher.md` are not among the three here. The
same two-phase pattern applies as for `lib/`: the sibling lite port's initial
release shipped exactly these three agents, and those two arrived later bundled
with the workflow-skill steps that dispatch them. A grep of the three ported
agents found **zero** references to either, so nothing dangles. The workflow-port
task owns them.

**Assumptions that task owes a reconciliation.** The agent bodies now name
`stride-opencode-lite-create-goal` and `stride-opencode-lite-create-task`, whose
real names a later task fixes; and `task-reviewer` cites a workflow-skill step
that does not exist yet, though the rule it cites is spelled out inline where it
is used, so nothing is lost while the citation dangles. The agents' several
`v0.6.0` citations are stride-lite release numbers with no referent in this
plugin (which is at `0.0.0` with an unreleased changelog); they are attributed to
stride-lite inline rather than renumbered, since they are accurate citations of
the source.

stride-lite's `lib/` also contains `select_workflow_branch.md`. It is **not**
part of this set. It is consumed by the workflow orchestrator skill, and in
stride-lite's sibling ports it arrived with that skill rather than with the
initial four helpers — so it belongs to the workflow-port task, not here. It is
not host-specific; it is simply sequenced later.
