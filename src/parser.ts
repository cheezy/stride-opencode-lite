/**
 * .stride_lite.md parser module
 *
 * Extracts hook commands from a .stride_lite.md file by locating a `## section`
 * heading and reading the first ```bash block beneath it. Handles CRLF/LF,
 * missing trailing newlines, comments, blank lines, and adjacent sections.
 *
 * Security: only the literal fenced block in the named section is executable.
 * This parser follows no include, import, or reference construct — a line that
 * looks like a directive to pull in another file is treated as an ordinary
 * command line and nothing more.
 */

/**
 * The three sections a .stride_lite.md file may define.
 *
 * stride-lite has three, not the five the full Stride plugin uses. `before_task`
 * and `after_task` are blocking; `after_goal` is advisory.
 */
export type HookName = "before_task" | "after_task" | "after_goal";

/** Sections whose failure blocks the action that triggered them. */
export const BLOCKING_HOOKS: readonly HookName[] = ["before_task", "after_task"];

/**
 * Whether a failure in this section should block.
 *
 * `after_goal` is advisory by contract: it reports failures but never blocks.
 */
export function isBlockingHook(hookName: HookName): boolean {
  return BLOCKING_HOOKS.includes(hookName);
}

/**
 * Parse .stride_lite.md content and extract the commands for one section.
 *
 * Finds the `## ` heading matching hookName, then takes the lines of the first
 * ```bash block under it. Stops at the closing fence, at the next `## ` heading,
 * or at end of input — so a second fenced block in the same section is never
 * read, and a neighbouring section is never crossed into.
 *
 * A fence tagged with any other language is skipped rather than captured.
 *
 * @param content - Raw file content (LF or CRLF)
 * @param hookName - The section to extract
 * @returns Executable command strings, comments and blanks removed
 */
export function parseStrideMd(content: string, hookName: HookName): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let found = false;
  let capture = false;
  const rawLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (found) break;
      // Strip trailing whitespace only, never leading. The bash implementation
      // removes the literal "## " prefix and then trims the tail, so a heading
      // with extra leading space ("##  before_task") matches no section and is
      // a clean no-op there. Trimming both ends here would make that malformed
      // heading live — its block would execute under this plugin while staying
      // inert under stride-lite.
      const section = line.slice(3).replace(/\s+$/, "");
      if (section === hookName) {
        found = true;
      }
      continue;
    }

    if (found) {
      if (line.startsWith("```bash")) {
        capture = true;
        continue;
      }
      if (line.startsWith("```")) {
        if (capture) break;
        continue;
      }
      if (capture) {
        rawLines.push(line);
      }
    }
  }

  return buildCommandList(rawLines);
}

/**
 * Read a .stride_lite.md file and extract one section's commands.
 *
 * A missing, unreadable, or otherwise unopenable file is a clean no-op yielding
 * an empty list — never an error. The bash implementation tests both existence
 * and readability before reading, so the failure here is caught broadly rather
 * than narrowed to a missing-file condition.
 *
 * @param filePath - Absolute path to the .stride_lite.md file
 * @param hookName - The section to extract
 * @returns Executable command strings, or an empty list for any unreadable file
 */
export async function parseStrideLiteFile(
  filePath: string,
  hookName: HookName,
): Promise<string[]> {
  let content: string;
  try {
    content = await Bun.file(filePath).text();
  } catch {
    return [];
  }
  return parseStrideMd(content, hookName);
}

/**
 * Filter and clean raw command lines from a code block.
 *
 * Trims each line, then drops blanks and `#` comment lines. A block holding
 * only comments therefore yields an empty list, which is a clean no-op.
 *
 * @param lines - Raw lines from a ```bash block
 * @returns Cleaned executable commands
 */
export function buildCommandList(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}
