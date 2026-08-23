import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BLOCKING_HOOKS,
  buildCommandList,
  isBlockingHook,
  parseStrideLiteFile,
  parseStrideMd,
} from "./parser";

const scratchDirs: string[] = [];

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const scratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "stride-lite-parser-"));
  scratchDirs.push(dir);
  return dir;
};

describe("parseStrideMd", () => {
  it("returns a section's commands in order", () => {
    const content = `# Config

## before_task

\`\`\`bash
echo first
echo second
echo third
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual([
      "echo first",
      "echo second",
      "echo third",
    ]);
  });

  it("filters comment lines and blank lines", () => {
    const content = `## after_task

\`\`\`bash
# Available: HOOK_NAME TASK_FILE TASK_NUMBER TASK_TITLE
echo kept

# another comment

echo also kept
\`\`\`
`;

    expect(parseStrideMd(content, "after_task")).toEqual([
      "echo kept",
      "echo also kept",
    ]);
  });

  it("returns an empty list for a section that holds only comments", () => {
    const content = `## after_goal

\`\`\`bash
# nothing to do here
# really nothing
\`\`\`
`;

    expect(parseStrideMd(content, "after_goal")).toEqual([]);
  });

  it("returns an empty list for a missing section", () => {
    const content = `## before_task

\`\`\`bash
echo hello
\`\`\`
`;

    expect(parseStrideMd(content, "after_goal")).toEqual([]);
  });

  it("returns an empty list for an empty fenced block", () => {
    const content = `## before_task

\`\`\`bash
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual([]);
  });

  it("returns an empty list for empty content", () => {
    expect(parseStrideMd("", "before_task")).toEqual([]);
  });

  it("stops at the next heading and does not read a later section's block", () => {
    const content = `## before_task

\`\`\`bash
echo mine
\`\`\`

## after_task

\`\`\`bash
echo theirs
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual(["echo mine"]);
    expect(parseStrideMd(content, "after_task")).toEqual(["echo theirs"]);
  });

  it("does not read a second fenced block in the same section", () => {
    const content = `## before_task

\`\`\`bash
echo first block
\`\`\`

Some prose between the blocks.

\`\`\`bash
echo second block
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual(["echo first block"]);
  });

  it("returns an empty list when the section's only block has another language tag", () => {
    const content = `## before_task

\`\`\`text
echo not executable
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual([]);
  });

  it("skips a non-bash block and reads the bash one that follows it", () => {
    const content = `## before_task

\`\`\`text
this is documentation
\`\`\`

\`\`\`bash
echo executable
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual(["echo executable"]);
  });

  it("handles CRLF line endings", () => {
    const content =
      "## before_task\r\n\r\n```bash\r\necho crlf\r\necho second\r\n```\r\n";

    expect(parseStrideMd(content, "before_task")).toEqual([
      "echo crlf",
      "echo second",
    ]);
  });

  it("handles a heading with trailing whitespace", () => {
    // The whitespace is built by concatenation rather than typed into the
    // literal: an editor or formatter that strips trailing spaces on save would
    // silently turn this into a duplicate of the plain-heading test, which is
    // exactly what it did before.
    const heading = "## before_task" + "   \t";
    const content = `${heading}\n\n\`\`\`bash\necho trailing space heading\n\`\`\`\n`;

    expect(content).toMatch(/## before_task[ \t]+\n/);
    expect(parseStrideMd(content, "before_task")).toEqual([
      "echo trailing space heading",
    ]);
  });

  it("does not match a heading with extra leading whitespace, as bash does not", () => {
    // Bash strips the literal "## " prefix and then trims only the tail, so
    // "##  before_task" (two spaces) matches no section and its block never
    // runs. Trimming both ends would make that malformed heading executable
    // here while staying inert under stride-lite.
    const content = `##  before_task

\`\`\`bash
echo should not run
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual([]);
  });

  it("handles a file with no trailing newline", () => {
    const content = "## before_task\n\n```bash\necho no trailing newline\n```";

    expect(parseStrideMd(content, "before_task")).toEqual([
      "echo no trailing newline",
    ]);
  });

  it("does not match a heading that merely starts with the section name", () => {
    const content = `## before_task_extra

\`\`\`bash
echo wrong section
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual([]);
  });

  it("does not treat an h1 or h3 heading as a section boundary match", () => {
    const content = `### before_task

\`\`\`bash
echo not a section
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual([]);
  });

  it("reads an unclosed fenced block to end of file", () => {
    const content = `## before_task

\`\`\`bash
echo unclosed
`;

    expect(parseStrideMd(content, "before_task")).toEqual(["echo unclosed"]);
  });

  it("treats an include-looking line as an ordinary command, never following it", () => {
    // The parser must not resolve any reference construct; only the literal
    // fenced block is executable.
    const content = `## before_task

\`\`\`bash
source ./other-file.md
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual([
      "source ./other-file.md",
    ]);
  });

  it("parses the canonical template's three sections", () => {
    const content = `# Stride Lite Configuration

## email

somebody@example.com

## before_task

\`\`\`bash
git pull origin main
\`\`\`

## after_task

\`\`\`bash
# Available: HOOK_NAME TASK_FILE TASK_NUMBER TASK_TITLE GOAL_DIR
npm test
\`\`\`

## after_goal

\`\`\`bash
echo goal complete
\`\`\`
`;

    expect(parseStrideMd(content, "before_task")).toEqual(["git pull origin main"]);
    expect(parseStrideMd(content, "after_task")).toEqual(["npm test"]);
    expect(parseStrideMd(content, "after_goal")).toEqual(["echo goal complete"]);
  });
});

describe("buildCommandList", () => {
  it("trims surrounding whitespace from each command", () => {
    expect(buildCommandList(["  echo padded  ", "\techo tabbed"])).toEqual([
      "echo padded",
      "echo tabbed",
    ]);
  });

  it("drops blank and whitespace-only lines", () => {
    expect(buildCommandList(["echo one", "", "   ", "\t", "echo two"])).toEqual([
      "echo one",
      "echo two",
    ]);
  });

  it("drops comment lines, including indented ones", () => {
    expect(buildCommandList(["# top", "  # indented", "echo kept"])).toEqual([
      "echo kept",
    ]);
  });

  it("keeps a trailing comment on a command line", () => {
    expect(buildCommandList(["echo hi # not a comment line"])).toEqual([
      "echo hi # not a comment line",
    ]);
  });

  it("returns an empty list for no lines", () => {
    expect(buildCommandList([])).toEqual([]);
  });
});

describe("parseStrideLiteFile", () => {
  it("reads a section from a real file", async () => {
    const dir = await scratchDir();
    const file = join(dir, ".stride_lite.md");
    await writeFile(file, "## before_task\n\n```bash\necho from disk\n```\n");

    expect(await parseStrideLiteFile(file, "before_task")).toEqual([
      "echo from disk",
    ]);
  });

  it("returns an empty list for a missing file", async () => {
    const dir = await scratchDir();

    expect(
      await parseStrideLiteFile(join(dir, "does-not-exist.md"), "before_task"),
    ).toEqual([]);
  });

  it("returns an empty list for an unreadable file", async () => {
    const dir = await scratchDir();
    const file = join(dir, "unreadable.md");
    await writeFile(file, "## before_task\n\n```bash\necho nope\n```\n");
    await chmod(file, 0o000);

    // Bash checks readability as well as existence, so an unreadable file is a
    // clean no-op too, not an error.
    expect(await parseStrideLiteFile(file, "before_task")).toEqual([]);
  });

  it("returns an empty list when the file exists but the section does not", async () => {
    const dir = await scratchDir();
    const file = join(dir, ".stride_lite.md");
    await writeFile(file, "## before_task\n\n```bash\necho hello\n```\n");

    expect(await parseStrideLiteFile(file, "after_goal")).toEqual([]);
  });
});

describe("blocking semantics", () => {
  it("treats before_task and after_task as blocking", () => {
    expect(isBlockingHook("before_task")).toBe(true);
    expect(isBlockingHook("after_task")).toBe(true);
  });

  it("treats after_goal as advisory", () => {
    expect(isBlockingHook("after_goal")).toBe(false);
  });

  it("exposes exactly the two blocking sections", () => {
    expect([...BLOCKING_HOOKS]).toEqual(["before_task", "after_task"]);
  });
});
