# Releasing stride-opencode-lite

A release is a version bump, a stamped changelog heading, an annotated tag
and a GitHub release, all in this repository. This file deliberately names no
real version number — see "Where the version lives" for why.

## The three facts

**Where the version lives.** `package.json` (`"version"`), and nowhere else.
The test suite enforces this both ways (`test/scaffold.test.ts`):

- the version string may appear in no tracked `.md`, `.ts`, `.sh` or `.ps1`
  file except `CHANGELOG.md` — so never write a concrete version into a doc,
  this one included, or the suite fails and the doc goes stale next release;
- the first numbered heading in `CHANGELOG.md` (skipping `[Unreleased]`) must
  equal `package.json`'s version.

So the version bump and the changelog stamp have to land in the same commit.

**Changelog shape: appended under `[Unreleased]`, stamped at release.** Work
commits add their entries under `## [Unreleased]` at the top of
`CHANGELOG.md`. The release commit renames that heading to
`## [X.Y.Z] - YYYY-MM-DD` and bumps `package.json`, and nothing else. The
history is not perfectly uniform, and that is worth knowing rather than
smoothing over:

- the second release was tagged on a work commit that did its own bump and
  stamp, rather than on a separate release commit;
- the first release's tag sits two commits after the commit that set its
  version.

The most recent release followed the shape above exactly, and the
`[Unreleased]` heading is back in place for the next one.

**Catalog: none.** OpenCode has no plugin marketplace, so there is no catalog
repository to update. Users install from this repository — an `opencode.json`
entry of `"github:cheezy/stride-opencode-lite"`, or a clone plus
`./install.sh` / `.\install.ps1` (see the README). It is not published to
npm. The README does not currently show a pinned `#vX.Y.Z` form.

## Before you add to the changelog: is the top heading already tagged?

This is the check that would have prevented the one real slip in this
repository's history. A work commit once appended its entry under a heading
that was already tagged and released, editing the record of a shipped
release; the next release commit had to move the entry to a new heading. A
tagged heading records what shipped — it is not a place to add to.

```bash
git tag -l "v$(awk -F'[][]' '/^## \[[0-9]/{print $2; exit}' CHANGELOG.md)"
```

This prints the tag if the newest numbered heading is already released, and
nothing if it is not. While `[Unreleased]` is at the top, add entries there;
if it is ever missing, recreate it rather than appending under a tagged
heading.

## Steps

1. Run the gate (the suite includes the smoke and installer tests and the
   version assertions above):

   ```bash
   bun test
   bun run typecheck
   ```

2. In one commit on `main`: rename `## [Unreleased]` to
   `## [X.Y.Z] - YYYY-MM-DD` in `CHANGELOG.md` and set `"version"` in
   `package.json` to `X.Y.Z`. Run `bun test` again — the version tests now
   check the pair. Push:

   ```bash
   git push origin main
   ```

3. Tag the release commit with an annotated tag and push it:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

4. Publish the GitHub release from the stamped entry:

   ```bash
   gh release create vX.Y.Z --repo cheezy/stride-opencode-lite \
     --title "vX.Y.Z — <summary>" --notes-file <notes.md>
   ```

5. Re-open the changelog for the next cycle: add an empty `## [Unreleased]`
   heading above the new one in a later commit (it is skipped by the version
   test, so it can sit there empty).

## Known gaps on the record

- One older tag is lightweight; the others are annotated. Use annotated tags.
- Every numbered heading so far has a matching tag and GitHub release.
