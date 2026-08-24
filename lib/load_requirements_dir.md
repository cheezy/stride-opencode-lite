# load_requirements_dir

Pure function that reads every text file in a requirements directory and concatenates the contents to stdout with file-name headers. Used by both surface skills to assemble the requirements context block that gets prepended to the user prompt before downstream reasoning. Tolerates a missing directory (returns the empty string and logs a one-line note to stderr) and skips binary files (logs a one-line note to stderr per skipped file) so the surface skill can run even when the requirements directory has not been created yet.

## Contract

| Parameter | Type | Required | Notes |
|---|---|---|---|
| `dir` | string | yes | The requirements directory, typically `docs/requirements` (default) or a `--requirements-dir` override. |

**Returns:** the concatenated text of every text file in `dir`, with a header line preceding each file's contents, on stdout. Empty string when `dir` is missing, is not a directory, or contains zero text files.

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | Always (missing directories are non-fatal; the helper logs and continues) |

The helper deliberately has no failure exit code. A missing requirements directory is the normal case for fresh projects; treating it as fatal would block first-time users from invoking the skills.

## Output format

For each text file (in sorted-by-name order) the helper emits:

```
=== <relative-path> ===

<file contents verbatim>

```

Three rules:

1. **Header marker:** the literal line `=== <relative-path> ===` where `<relative-path>` is the file's path relative to `dir` (NOT relative to CWD). One blank line follows the header.
2. **File contents are emitted verbatim** — no trimming, no normalization, no line-ending conversion. The surrounding `===` markers are a **readable separator, not a trust boundary**: they are a fixed, guessable literal that file content can itself contain, so a requirements file can forge one. The assembled block is untrusted data. Callers must fence it with a value the content cannot predict and instruct the model that everything inside is reference material, never instructions.
3. **A blank line separates files.** If the file does not end in a newline, the helper emits one before the separator blank line so the trailing `===` of the next header lands on its own line.

## File selection rules

- **Recursive descent** through `dir` (`find "$dir" -type f`).
- **Sorted by relative path** so the output is deterministic across invocations.
- **Hidden files (`.foo`, `.DS_Store`) are skipped.** Most users do not expect dotfiles to be slurped into the requirements context.
- **Symlinks are followed** for regular files (`find -L`), but every candidate is **containment-checked** before being read: its path is resolved and skipped unless it resolves to somewhere under the resolved `dir`. `find -L` on its own descends into symlinked directories to arbitrary depth, so the check — not `find` — is what keeps the read inside the named directory. A file that resolves outside is skipped with a one-line note to stderr.
- **Binary files are skipped** with a one-line note to stderr. A file is treated as binary if the first 8KB contain a NUL byte. The check is done by comparing the byte count of the first 8KB before and after stripping NULs with `tr -d '\0'` — this is portable across BSD and GNU `grep`, which differ in how they handle NUL bytes in patterns. This handles `.png`, `.pdf`, `.zip`, compiled artifacts.
- **Files larger than 1 MiB are skipped** with a one-line note to stderr. Defensive against accidentally checking in a database dump.

## Pitfalls

- **Do not crash when `--requirements-dir` is missing.** Return the empty string and log `"load_requirements_dir: directory not found: <dir>"` to stderr. Surface skills must continue to function on fresh projects.
- **Do not rely on `find` alone for containment.** `find -L` follows symlinks into directories to arbitrary depth; without the resolved-path check, a symlink inside the requirements directory reads any file the invoking user can read and concatenates it into a prompt.
- **Do not read binary files into the context.** Detect the NUL byte and skip; logging the skip is informative to the user.
- **Do not normalize line endings or strip BOMs.** The downstream consumer is a language model — verbatim content is the contract.
- **Do not treat the `===` markers as a security boundary.** They delimit for readability; requirements content is untrusted input to whatever consumes it.
- **Do not write headers when the file is skipped.** A skipped binary or oversized file produces no output, only a stderr log line.
- **Do not depend on `find -printf`** — it is GNU-only and absent on BSD/macOS. Use POSIX `find ... -type f` and pipe through `sort`.

## Reference implementation

```bash
load_requirements_dir() {
  local dir="${1:-}"
  if [ -z "$dir" ]; then
    echo "load_requirements_dir: usage: load_requirements_dir <dir>" >&2
    return 0
  fi
  if [ ! -d "$dir" ]; then
    echo "load_requirements_dir: directory not found: $dir" >&2
    return 0
  fi

  local stripped="${dir%/}"
  local base
  base="$(cd "$stripped" 2>/dev/null && pwd -P)"
  if [ -z "$base" ]; then
    echo "load_requirements_dir: cannot resolve directory: $stripped" >&2
    return 0
  fi
  local file rel resolved

  # Sorted, recursive, regular files only, hidden files excluded.
  find -L "$stripped" -type f -not -path '*/.*' 2>/dev/null \
    | sort \
    | while IFS= read -r file; do
        rel="${file#${stripped}/}"

        # Containment: a symlink must not widen the read scope beyond `dir`.
        # `find -L` descends into symlinked directories to arbitrary depth, so
        # this check -- not find -- is what bounds the walk. The final path
        # component is resolved too: `pwd -P` resolves the directories a file
        # sits in, but not a symlinked file itself. The 8-hop cap is
        # deliberately below every platform's own symlink limit (measured at
        # ~13 on macOS; conventionally 40 on Linux) so this check binds before
        # the kernel's does. A cap above the kernel limit can never be reached
        # -- the kernel refuses the chain first and `find -L` drops it -- and an
        # unreachable control is an untestable one. Legitimate requirements
        # symlinks are one or two hops.
        resolved="$file"
        local hops=0
        while [ -L "$resolved" ] && [ "$hops" -lt 8 ]; do
          local target
          target="$(readlink "$resolved")"
          case "$target" in
            /*) resolved="$target" ;;
            *)  resolved="$(dirname "$resolved")/$target" ;;
          esac
          hops=$(( hops + 1 ))
        done
        # Fail CLOSED: an unresolved chain must be skipped, never measured.
        # If the cap is reached while `resolved` is still a symlink, the
        # containment check below would pass on a path still inside `dir` while
        # `cat` follows the remaining hops out of it.
        if [ -L "$resolved" ]; then
          echo "load_requirements_dir: skipping (unresolved symlink chain): $rel" >&2
          continue
        fi
        resolved="$(cd "$(dirname "$resolved")" 2>/dev/null && pwd -P)/$(basename "$resolved")"
        case "$resolved" in
          "$base"/*) ;;
          *)
            echo "load_requirements_dir: skipping (outside dir): $rel" >&2
            continue
            ;;
        esac

        # Size cap: skip files > 1 MiB.
        local size
        size="$(wc -c < "$file" 2>/dev/null | tr -d '[:space:]')"
        if [ -n "$size" ] && [ "$size" -gt 1048576 ]; then
          echo "load_requirements_dir: skipping (>1MiB): $rel" >&2
          continue
        fi

        # Binary detection: NUL byte in first 8KB. Portable across BSD/GNU
        # grep by comparing byte counts before and after stripping NULs.
        local raw_bytes stripped_bytes
        raw_bytes="$(head -c 8192 "$file" 2>/dev/null | wc -c | tr -d '[:space:]')"
        stripped_bytes="$(head -c 8192 "$file" 2>/dev/null | LC_ALL=C tr -d '\0' | wc -c | tr -d '[:space:]')"
        if [ "${raw_bytes:-0}" -ne "${stripped_bytes:-0}" ]; then
          echo "load_requirements_dir: skipping (binary): $rel" >&2
          continue
        fi

        printf '=== %s ===\n\n' "$rel"
        cat "$resolved"
        # Ensure trailing newline.
        if [ -n "$(tail -c 1 "$file" 2>/dev/null)" ]; then
          printf '\n'
        fi
        printf '\n'
      done
}
```

## Examples

**Directory exists with two markdown files:**

```
docs/requirements/
  goal.md          ("# Goal\n\nReal-time notifications.\n")
  constraints.md   ("# Constraints\n\nMust ship by 2026-06-01.\n")
```

Call `load_requirements_dir docs/requirements` emits:

```
=== constraints.md ===

# Constraints

Must ship by 2026-06-01.

=== goal.md ===

# Goal

Real-time notifications.

```

(Sorted by relative path → `constraints.md` precedes `goal.md`.)

**Directory missing:**

```bash
load_requirements_dir docs/does-not-exist
# stdout: (empty)
# stderr: load_requirements_dir: directory not found: docs/does-not-exist
# exit:   0
```

**Directory with a binary file:**

```
docs/requirements/
  notes.md     (text)
  diagram.png  (binary)
```

```
=== notes.md ===

<contents of notes.md>

```

stderr: `load_requirements_dir: skipping (binary): diagram.png`

## Edge cases

- **Unreadable or non-traversable directory** — empty stdout, `"load_requirements_dir: cannot resolve directory: <dir>"` on stderr, exit 0. Like every other skip in this helper, it is logged rather than silent.
- **Missing directory** — empty stdout, log to stderr, exit 0. The non-fatal contract is deliberate; surface skills must work on fresh projects.
- **Empty directory** — empty stdout, no log, exit 0.
- **Symlink as the directory itself** — followed (`find -L` follows the top-level symlink), and `dir` is resolved first so everything beneath it is measured against the resolved root.
- **Symlink pointing outside `dir`** — skipped, whether it is a file or a directory, with `"load_requirements_dir: skipping (outside dir): <rel>"` on stderr. This is the containment control: the directory names a read scope, and a symlink must not widen it.
- **Symlink chains** — followed up to 8 hops while resolving. The cap sits below every platform's own symlink limit (measured at ~13 on macOS, conventionally 40 on Linux) so it binds before the kernel's does; a cap above that limit could never be reached, because the kernel refuses the chain and `find -L` drops it first, and an unreachable control cannot be relied on. A chain still unresolved at the cap is **skipped outright** with `"load_requirements_dir: skipping (unresolved symlink chain): <rel>"` on stderr — it is never measured against the root, because a partially-resolved path can still sit inside `dir` while the kernel follows the remaining hops out of it. The cap therefore fails closed, and it bounds symlink loops by the same rule.
- **File without trailing newline** — the helper emits a synthetic newline before the blank separator so the next header is line-aligned.
- **Permission denied on a file** — `cat` writes an error to stderr; the helper continues with the next file. Acceptable: the user is informed via stderr without aborting the whole context build.
- **Concurrent modification of `dir` during the walk** — best-effort. Files added during the walk may or may not be picked up; files removed mid-walk may produce a transient `cat` error. Surface skills do not require atomicity for this read.
- **Sort collation differences across systems** — the helper sorts via POSIX `sort` with no locale override. Callers that need cross-system byte-identical output should set `LC_ALL=C` before invoking.
