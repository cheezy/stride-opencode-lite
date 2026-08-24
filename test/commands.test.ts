import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Static shape checks for the three commands.
 *
 * As with the agent and skill checks, these are markdown files with no runtime
 * here, so every assertion is a shape check. What this CANNOT establish, and
 * what stays a known gap in AGENTS.md: that OpenCode discovers `commands/`,
 * that these names are invocable, or that activating a skill from a command
 * works at all. That needs a running OpenCode session.
 *
 * The assertions that matter most are the thin-shell ones. A command that
 * starts holding orchestration has to be kept in sync with a skill that already
 * holds it, and the two will disagree — so the boundary is pinned rather than
 * left to review.
 */

const repoRoot = new URL("..", import.meta.url).pathname;
const commandsDir = join(repoRoot, "commands");

/** Each command and the skill it must activate. */
const COMMANDS: Record<string, string> = {
  "create-goal": "stride-opencode-lite-create-goal",
  "create-task": "stride-opencode-lite-create-task",
  init: "stride-opencode-lite-init",
};

const readCommand = async (name: string): Promise<string> =>
  Bun.file(join(commandsDir, `${name}.md`)).text();

const frontmatter = (source: string): string => {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  return match![1]!;
};

const bodyOnly = (source: string): string => source.replace(/^---\n[\s\S]*?\n---\n/, "");

describe("the commands directory", () => {
  it("contains exactly the three ported commands", async () => {
    const present = (await readdir(commandsDir))
      .filter((f) => f.endsWith(".md"))
      .sort();

    expect(present).toEqual(Object.keys(COMMANDS).map((c) => `${c}.md`).sort());
  });
});

describe.each(Object.keys(COMMANDS))("%s", (name) => {
  it("has OpenCode frontmatter carrying only a description", async () => {
    const fm = frontmatter(await readCommand(name));

    expect(fm).toMatch(/^description: /m);
    // Claude Code keys with no OpenCode equivalent. Carrying them would claim a
    // contract the host does not honour.
    expect(fm).not.toMatch(/^allowed-tools:/m);
    expect(fm).not.toMatch(/^argument-hint:/m);
  });

  it("states its usage in the description and in the body", async () => {
    // With no argument-hint key, the hint has to live in prose or it does not
    // exist at all.
    const source = await readCommand(name);
    const fm = frontmatter(source);

    expect(fm).toContain("Usage:");
    expect(bodyOnly(source)).toContain("Usage:");
  });

  it("activates the skill whose name corresponds to it", async () => {
    const body = bodyOnly(await readCommand(name));

    expect(body).toContain(`Activate the \`${COMMANDS[name]}\` skill`);
    expect(body).toContain("pass `$ARGUMENTS` through verbatim");
  });

  it("is a thin shell holding no orchestration", async () => {
    const body = bodyOnly(await readCommand(name));

    expect(body).toContain("## What this command does NOT do");
    expect(body).toContain("No business logic in this file");
    expect(body).toContain("Never POSTs to any API");
  });

  it("keeps its step prose count-agnostic", async () => {
    // A stated count goes stale the first time the skill gains or loses a step.
    const body = bodyOnly(await readCommand(name));

    expect(body).not.toMatch(/all (three|four|five|six|seven|eight|nine) flow steps/i);
    expect(body).not.toMatch(/the (three|four|five|six|seven|eight|nine)-step/i);
    expect(body).toContain("every flow step documented in");
  });

  it("carries no Claude Code host artifacts", async () => {
    const source = await readCommand(name);

    for (const artifact of ["hooks.json", "exit 2", "Claude Code", "/stride-lite:", "PreToolUse"]) {
      expect(source).not.toContain(artifact);
    }
  });
});

describe("the create commands", () => {
  const creates = ["create-goal", "create-task"];

  it.each(creates)("%s carries the defaults table", async (name) => {
    const body = bodyOnly(await readCommand(name));

    expect(body).toContain("## Defaults");
    expect(body).toContain("`--requirements-dir` | `docs/requirements`");
    expect(body).toContain("`--output-dir` | `docs/implementation/PENDING`");
  });

  it("state identical defaults", async () => {
    // The defaults are a cross-command contract; a drift between the two would
    // send the same prompt to two different places.
    const goal = bodyOnly(await readCommand("create-goal"));
    const task = bodyOnly(await readCommand("create-task"));

    for (const row of [
      "| `--requirements-dir` | `docs/requirements` |",
      "| `--output-dir` | `docs/implementation/PENDING` |",
    ]) {
      expect(goal).toContain(row);
      expect(task).toContain(row);
    }
  });
});

describe("the init command", () => {
  it("documents the force flag", async () => {
    const source = await readCommand("init");

    expect(source).toContain("--force");
    expect(bodyOnly(source)).toContain("overwrite an existing");
  });

  it("states that it never executes a hook section, and why", async () => {
    const body = bodyOnly(await readCommand("init"));

    expect(body).toContain("Never executes the hook sections itself");
    // The reason matters: running one here would double-execute it.
    expect(body).toContain("twice");
    // And it must describe THIS plugin's mechanism.
    expect(body).toContain("src/index.ts");
    expect(body).toContain("tool.execute.before");
  });

  it("has no defaults table, having no defaulted flags", async () => {
    expect(bodyOnly(await readCommand("init"))).not.toContain("## Defaults");
  });
});

describe("README", () => {
  it("documents all three commands with copy-paste examples", async () => {
    const readme = await Bun.file(join(repoRoot, "README.md")).text();

    expect(readme).toContain("## Commands");
    for (const name of Object.keys(COMMANDS)) {
      expect(readme).toContain(name);
    }
    // A table row is not an example; require an invocation line per command.
    expect(readme).toMatch(/^create-goal /m);
    expect(readme).toMatch(/^create-task /m);
    expect(readme).toMatch(/^init$/m);
  });

  it("no longer claims the commands are unported", async () => {
    const readme = await Bun.file(join(repoRoot, "README.md")).text();

    expect(readme).not.toContain("commands\n> are not yet ported");
    expect(readme).not.toContain("are not yet ported");
  });
});
