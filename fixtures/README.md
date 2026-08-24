# Fixtures

Vendored verbatim from **stride-lite**, the source of truth for the lite family's
on-disk artifacts.

| Field | Value |
|---|---|
| Source repo | `stride-lite` |
| Source commit | `ffb670bbc29096916d0111ca64944e0c92f968ee` |
| Vendored at | 2026-08-24 |
| Source tree state | clean (`git status --porcelain` empty at that commit) |

## What is here

| File | sha256 | Bytes |
|---|---|---|
| `sample-requirements.md` | `0a6cd5605c149a3b3021600b5745d5826bc18ef1dc729ee133f7c3994e3d933d` | 2032 |
| `expected-output/goal.md` | `00ae81dc1a6907d97c0ce37712fce58b096756100fc55fffd7a095cc83b4de55` | 2644 |
| `expected-output/task1.md` | `141afe6f06ca27f240631357fee077aa0a9160025297ad242dbb4bbbfc9b9a97` | 4541 |
| `templates/goal.md.tpl` | `63b444f8cb7c84b0a2d8ec39ceafc8e7d74c8e80433f530e5adf7168b4273234` | 33 lines |
| `templates/taskN.md.tpl` | `f5ff7db2802fbe5c9ac4d8ffafddc45ea09bdbca55541aed02f54552567cfedd` | 81 lines |

`templates/` holds the two template blocks extracted verbatim from stride-lite's
`create-goal` SKILL.md at the commit above — `test/smoke.sh` re-extracts them
from `git show <commit>:skills/stride-lite-create-goal/SKILL.md` and diffs, so
they are tied to stride-lite itself rather than only to a constant in the script. They are not decoration: they are what lets a template
failure print a real `diff -u` **offline**, which is the only case a consumer
ever has. A sha256 mismatch on its own says something changed without saying
what.

Copied with a plain `cp` and **no normalization of any kind**. All three end with
a single trailing newline and contain no CR bytes; a newline or line-ending
massage would itself be the divergence these files exist to detect.

## Verbatim means verbatim — do not re-brand

`expected-output/goal.md` names `/stride-lite:create-goal` in its body. That is
**deliberate and must not be changed** to this port's command name: these files
are upstream's bytes, and re-branding them is precisely the divergence the pinned
hashes exist to catch.

Consequence for future work: `test/skills.test.ts`, `test/agents.test.ts` and
`test/commands.test.ts` each scan for the `/stride-lite:` token as a foreign-host
artifact. Those scans are scoped to `skills/`, `agents/` and `commands/` and do
not reach here. **Any future repo-wide foreign-token scan must exclude
`fixtures/`** or it will flag this file and invite exactly the edit that breaks
byte-identity.

## Why the commit matters

Without it, a passing check tells you the copies match *something* — not which
version of the cross-port promise is being asserted. The commit is what lets a
future reader answer "does this still hold today, or did it hold once?"

To re-vendor after an upstream change, copy the files again, update the commit
and the hashes in this table together, and update these constants in
`test/smoke.sh`: `EXPECTED_SAMPLE_SHA256`, `EXPECTED_GOAL_FIXTURE_SHA256`,
`EXPECTED_TASK1_FIXTURE_SHA256`, `EXPECTED_GOAL_TEMPLATE_SHA256`,
`EXPECTED_TASKN_SHA256` and `EXPECTED_STRIDE_LITE_COMMIT`. Updating one without
the others is the failure mode this table exists to make visible — and the
`fixtures: README.md pins the same hashes and paths the check does` stage fails
when they drift apart.

A re-vendor is a **cross-port decision**, not a local fix: `stride-lite`,
`stride-copilot-lite` and this port land it together. If you are updating a hash
to make a test pass, stop.

## What these files are — and are NOT

`expected-output/goal.md` and `expected-output/task1.md` are **hand-authored
simulations** of what a real create-goal run against `sample-requirements.md`
would produce. `goal.md` says so in its own text: a real run would produce two
additional sibling tasks, and only `task1.md` is shipped to keep the example
focused.

They are therefore **not** mechanically derivable from the skills' template
blocks, which are placeholder-driven (`<task.title>`, `<task.description>`, …).
Substituting placeholders for real prose is the decomposer's job, and it needs a
model. No offline check can render these files from the templates, and stride-lite
does not attempt it either.

What they are good for is what the checks in `test/smoke.sh` actually do with
them: pin them byte-for-byte so a copy cannot drift from upstream unnoticed, and
assert that the rendered artifact still carries exactly the template's section
structure. See the fixture stages there for the precise claims.
