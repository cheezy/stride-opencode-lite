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

    // Assert the whole key set, not a deny-list of two. A deny-list credits any
    // key nobody thought to forbid — including the Claude Code keys below, which
    // are named in the message rather than in the assertion for that reason.
    const keys = fm
      .split("\n")
      .filter((line) => /^\S/.test(line))
      .map((line) => line.split(":")[0]);

    expect(keys).toEqual(["description"]);
    // Named explicitly so a regression reads as what it is: these are Claude
    // Code keys with no OpenCode equivalent.
    expect(keys).not.toContain("allowed-tools");
    expect(keys).not.toContain("argument-hint");
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

  it("names a skill that actually exists on disk", async () => {
    // The map above is edited alongside the command file, so on its own it
    // proves nothing: a command naming a skill that does not exist would pass.
    // Consult the directory instead.
    const present = (await readdir(join(repoRoot, "skills"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    expect(present).toContain(COMMANDS[name]!);
  });

  it("is a thin shell holding no orchestration", async () => {
    const body = bodyOnly(await readCommand(name));

    expect(body).toContain("## What this command does NOT do");
    expect(body).toContain("No business logic in this file");
    expect(body).toContain("Never POSTs to any API");
  });

  it("holds the thin-shell promise, not merely states it", async () => {
    // The assertions above check that the file makes a promise. These check the
    // promise is kept. Naming a helper in prose is delegation and is fine — what
    // must not appear is a step this file would carry out itself, so the test
    // looks for executable form rather than for helper names.
    const body = bodyOnly(await readCommand(name));

    // Every fenced block must be an unlabelled usage snippet. A command that
    // grew a bash block doing slugification or file-writing fails here.
    const fences = [...body.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)];
    expect(fences.length).toBeGreaterThan(0);
    for (const [, lang, contents] of fences) {
      expect(lang).toBe("");
      expect(contents).toContain("[--");
    }

    // No imperative shell line. These do not occur in prose, so a match is a
    // step this file performs rather than delegates.
    for (const line of body.split("\n")) {
      expect(line).not.toMatch(/^\s*(mkdir|printf|echo|cat|sed|awk|tr|git|curl|mv|cp)\s/);
    }
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

    for (const artifact of [
      "hooks.json",
      "exit 2",
      "Claude Code",
      "/stride-lite:",
      "PreToolUse",
      "PostToolUse",
      ".claude/",
      "allowed-tools",
      "argument-hint",
      "CLAUDE_PROJECT_DIR",
    ]) {
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

  it("state defaults that match the lib/parse_args spec", async () => {
    // Drive the assertion from the helper that owns the contract rather than
    // re-stating it here — a literal copy cannot detect a command drifting
    // from the spec, because the copy drifts with it.
    const spec = await Bun.file(join(repoRoot, "lib/parse_args.md")).text();
    const specRow = (flag: string): string => {
      const m = spec.match(new RegExp(`\\| \`${flag} <path>\`\\s*\\| \`([^\`]+)\``));
      expect(m).not.toBeNull();
      return m![1]!;
    };

    const requirementsDefault = specRow("--requirements-dir");
    const outputDefault = specRow("--output-dir");
    expect(requirementsDefault).toBe("docs/requirements");
    expect(outputDefault).toBe("docs/implementation/PENDING");

    for (const name of ["create-goal", "create-task"]) {
      const body = bodyOnly(await readCommand(name));
      expect(body).toContain(`| \`--requirements-dir\` | \`${requirementsDefault}\` |`);
      expect(body).toContain(`| \`--output-dir\` | \`${outputDefault}\` |`);
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

  it("states counts that match what is on disk", async () => {
    // The status banner is the first thing a reader believes. A hand-written
    // count in it goes stale the moment a spec or agent lands, so drive it from
    // the directories rather than trusting the prose.
    const readme = await Bun.file(join(repoRoot, "README.md")).text();
    const count = async (dir: string, dirsOnly: boolean): Promise<number> =>
      (await readdir(join(repoRoot, dir), { withFileTypes: true })).filter((e) =>
        dirsOnly ? e.isDirectory() : e.isFile() && e.name.endsWith(".md"),
      ).length;

    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven"];
    expect(readme).toContain(`${words[await count("lib", false)]} helper specs`);
    expect(readme).toContain(`${words[await count("agents", false)]} agents`);
    expect(readme).toContain(`${words[await count("skills", true)]} skills`);
    expect(readme).toContain(`${words[await count("commands", false)]} commands`);
  });

  it("does not claim the port is complete while gaps remain", async () => {
    // The banner overclaimed before: it listed what was in place and said
    // nothing about what was not, while AGENTS.md recorded three unported
    // artifacts and two dormant triggers.
    const readme = await Bun.file(join(repoRoot, "README.md")).text();
    const agents = await Bun.file(join(repoRoot, "AGENTS.md")).text();

    expect(readme).toContain("The port is not complete");
    for (const gap of ["select_workflow_branch", "task-enricher", "hook-diagnostician", "dormant"]) {
      // Each gap AGENTS.md records must also be visible from the README.
      expect(agents).toContain(gap);
      expect(readme).toContain(gap);
    }
  });

  it("no longer claims the commands are unported", async () => {
    const readme = await Bun.file(join(repoRoot, "README.md")).text();

    expect(readme).not.toContain("commands\n> are not yet ported");
    expect(readme).not.toContain("are not yet ported");
  });
});
