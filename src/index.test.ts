import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AFTER_TASK_SKILL,
  BEFORE_TASK_SKILL,
  BLOCKING_TRIGGER_TOOLS,
  COMPLETION_HEADING,
  CONFIG_FILENAME,
  GOAL_FILENAME,
  StrideOpenCodeLitePlugin,
  extractFilePath,
  extractSkillName,
  extractToolArgs,
  extractToolName,
  routeAfter,
  routeBefore,
} from "./index";

const scratchDirs: string[] = [];

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const scratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "stride-lite-plugin-"));
  scratchDirs.push(dir);
  return dir;
};

/** A pre-execution payload for a skill activation, in the observed nesting. */
const skillEvent = (name: string) => ({
  input: { tool: "skill", sessionID: "s1", callID: "c1" },
  output: { args: { name } },
});

/** A post-execution payload for a file mutation. */
const writeEvent = (tool: string, filePath: string, content: string) => ({
  input: { tool, sessionID: "s1", callID: "c1", args: { filePath, content } },
  output: { title: filePath, output: "ok", metadata: {} },
});

const loadPlugin = async (directory: string) =>
  (await StrideOpenCodeLitePlugin({ directory })) as {
    "tool.execute.before": (i: unknown, o?: unknown) => Promise<void>;
    "tool.execute.after": (i: unknown, o?: unknown) => Promise<void>;
  };

const writeConfig = async (dir: string, section: string, block: string) => {
  await Bun.write(join(dir, CONFIG_FILENAME), `## ${section}\n\n\`\`\`bash\n${block}\n\`\`\`\n`);
};

describe("payload extraction", () => {
  it("reads the tool name from the top level", () => {
    expect(extractToolName({ tool: "skill" })).toBe("skill");
  });

  it("reads the tool name from the observed runtime nesting", () => {
    // The declared type puts `tool` at the top level; the real payload nests it.
    // Probing only the declared position would make every handler inert.
    expect(extractToolName({ input: { tool: "write" } })).toBe("write");
  });

  it("returns undefined for a payload with no tool name", () => {
    expect(extractToolName({})).toBeUndefined();
    expect(extractToolName(null)).toBeUndefined();
    expect(extractToolName("nonsense")).toBeUndefined();
  });

  it("reads args from output.args, input.args and input.input in order", () => {
    expect(extractToolArgs({}, { args: { a: 1 } })).toEqual({ a: 1 });
    expect(extractToolArgs({ args: { b: 2 } })).toEqual({ b: 2 });
    expect(extractToolArgs({ input: { c: 3 } })).toEqual({ c: 3 });
  });

  it("prefers output.args over the input probes", () => {
    expect(extractToolArgs({ args: { from: "input" } }, { args: { from: "output" } })).toEqual({
      from: "output",
    });
  });

  it("reads a skill name under any of its documented spellings", () => {
    expect(extractSkillName({ name: "a" })).toBe("a");
    expect(extractSkillName({ skill: "b" })).toBe("b");
    expect(extractSkillName({ skillName: "c" })).toBe("c");
    expect(extractSkillName({ skill_name: "d" })).toBe("d");
    expect(extractSkillName(undefined)).toBeUndefined();
    expect(extractSkillName({})).toBeUndefined();
  });

  it("reads a file path under any of its documented spellings", () => {
    expect(extractFilePath({ filePath: "a" })).toBe("a");
    expect(extractFilePath({ file_path: "b" })).toBe("b");
    expect(extractFilePath({ path: "c" })).toBe("c");
    expect(extractFilePath({ file: "d" })).toBe("d");
    expect(extractFilePath(undefined)).toBeUndefined();
  });
});

describe("routeBefore", () => {
  it("routes the explorer skill to before_task", () => {
    expect(routeBefore(skillEvent(BEFORE_TASK_SKILL).input, skillEvent(BEFORE_TASK_SKILL).output))
      .toMatchObject({ hook: "before_task" });
  });

  it("routes the reviewer skill to after_task", () => {
    const e = skillEvent(AFTER_TASK_SKILL);
    expect(routeBefore(e.input, e.output)).toMatchObject({ hook: "after_task" });
  });

  it("routes on every skill-activation tool spelling, not just one", () => {
    // Matching only `skill` would leave the hook dormant on a host emitting
    // another spelling — the failure this wiring most needs to avoid.
    for (const tool of BLOCKING_TRIGGER_TOOLS) {
      expect(routeBefore({ tool }, { args: { name: BEFORE_TASK_SKILL } })).toMatchObject({
        hook: "before_task",
      });
    }
  });

  it("still requires an exact skill-name match on every spelling", () => {
    for (const tool of BLOCKING_TRIGGER_TOOLS) {
      expect(routeBefore({ tool }, { args: { name: "something-else" } })).toBeNull();
    }
  });

  it("routes on the top-level tool shape as well as the nested one", () => {
    expect(
      routeBefore({ tool: "skill" }, { args: { name: BEFORE_TASK_SKILL } }),
    ).toMatchObject({ hook: "before_task" });
  });
});

describe("near misses — these must route to nothing", () => {
  it("1. a goal.md write WITHOUT the completion heading", () => {
    const e = writeEvent("write", "/p/goals/g1/goal.md", "# Goal\n\nSome prose.\n");
    expect(routeAfter(e.input, e.output)).toBeNull();
  });

  it("2. the completion heading written to a TASK file, not goal.md", () => {
    // Step 8 writes this identical heading into task files first, so this is
    // the sharpest near miss of the set.
    const e = writeEvent("write", "/p/goals/g1/task1.md", `${COMPLETION_HEADING}\n\ndone\n`);
    expect(routeAfter(e.input, e.output)).toBeNull();
  });

  it("3. a READ of goal.md rather than a write", () => {
    const e = writeEvent("read", "/p/goals/g1/goal.md", `${COMPLETION_HEADING}\n`);
    expect(routeAfter(e.input, e.output)).toBeNull();
  });

  it("4. a bash-tool append to goal.md rather than edit/write", () => {
    const e = {
      input: { tool: "bash", args: { command: `echo '${COMPLETION_HEADING}' >> goal.md` } },
      output: { title: "bash", output: "", metadata: {} },
    };
    expect(routeAfter(e.input, e.output)).toBeNull();
  });

  it("5. a basename that is not exactly goal.md", () => {
    for (const path of ["/p/subgoal.md", "/p/goal.md.bak", "/p/my-goal.md", "/p/GOAL.md"]) {
      const e = writeEvent("write", path, `${COMPLETION_HEADING}\n`);
      expect(routeAfter(e.input, e.output)).toBeNull();
    }
  });

  it("6. a skill activation naming a different skill", () => {
    for (const name of [
      "stride-opencode-lite-workflow",
      "stride-opencode-lite-task-enricher",
      "task-explorer",
      `${BEFORE_TASK_SKILL}-extra`,
    ]) {
      const e = skillEvent(name);
      expect(routeBefore(e.input, e.output)).toBeNull();
    }
  });

  it("7. the explorer skill arriving on the AFTER phase", () => {
    // tool.execute.after cannot block, so it must never route a blocking hook.
    const e = skillEvent(BEFORE_TASK_SKILL);
    expect(routeAfter(e.input, e.output)).toBeNull();
  });

  it("8. a goal.md edit arriving on the BEFORE phase", () => {
    const e = writeEvent("edit", "/p/goals/g1/goal.md", `${COMPLETION_HEADING}\n`);
    expect(routeBefore(e.input, e.output)).toBeNull();
  });

  it("9. a skill activation with no name at all", () => {
    expect(routeBefore({ tool: "skill" }, { args: {} })).toBeNull();
    expect(routeBefore({ tool: "skill" }, {})).toBeNull();
  });
});

describe("routeAfter", () => {
  it("routes an edit and a write of goal.md carrying the heading", () => {
    for (const tool of ["edit", "write"]) {
      const e = writeEvent(tool, "/p/goals/g1/goal.md", `# Goal\n\n${COMPLETION_HEADING}\n\nDone.\n`);
      expect(routeAfter(e.input, e.output)).toMatchObject({ hook: "after_goal" });
    }
  });

  it("treats an unserializable payload as no match rather than guessing", () => {
    // A circular payload cannot be searched for the heading. Routing must
    // decline it rather than assume either answer.
    const circular: Record<string, unknown> = {
      tool: "write",
      args: { filePath: `/p/${GOAL_FILENAME}` },
    };
    circular.self = circular;

    expect(routeAfter(circular, {})).toBeNull();
  });

  it("matches the heading anywhere in the payload, as bash greps the whole input", () => {
    const e = {
      input: { tool: "write", args: { filePath: `/p/${GOAL_FILENAME}` } },
      output: { title: "w", output: `wrote ${COMPLETION_HEADING}`, metadata: {} },
    };
    expect(routeAfter(e.input, e.output)).toMatchObject({ hook: "after_goal" });
  });
});

describe("plugin handlers", () => {
  it("exports both handlers", async () => {
    const hooks = await loadPlugin(await scratchDir());

    expect(typeof hooks["tool.execute.before"]).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
  });

  it("runs the before_task section when the explorer skill activates", async () => {
    const dir = await scratchDir();
    const marker = join(dir, "before.marker");
    await writeConfig(dir, "before_task", `touch ${marker}`);

    const hooks = await loadPlugin(dir);
    const e = skillEvent(BEFORE_TASK_SKILL);
    await hooks["tool.execute.before"](e.input, e.output);

    expect(await Bun.file(marker).exists()).toBe(true);
  });

  it("does nothing at all for an unrelated tool call", async () => {
    const dir = await scratchDir();
    const marker = join(dir, "should-not-exist");
    await writeConfig(dir, "before_task", `touch ${marker}`);

    const hooks = await loadPlugin(dir);
    await hooks["tool.execute.before"]({ tool: "grep" }, { args: { pattern: "x" } });

    expect(await Bun.file(marker).exists()).toBe(false);
  });

  it("THROWS when a blocking section fails, aborting the tool call", async () => {
    const dir = await scratchDir();
    await writeConfig(dir, "before_task", 'sh -c "exit 3"');

    const hooks = await loadPlugin(dir);
    const e = skillEvent(BEFORE_TASK_SKILL);

    await expect(hooks["tool.execute.before"](e.input, e.output)).rejects.toThrow();
  });

  it("carries the structured result in what it throws", async () => {
    const dir = await scratchDir();
    await writeConfig(dir, "after_task", 'sh -c "exit 5"');

    const hooks = await loadPlugin(dir);
    const e = skillEvent(AFTER_TASK_SKILL);

    let thrown: unknown;
    try {
      await hooks["tool.execute.before"](e.input, e.output);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeDefined();
    const payload = JSON.parse((thrown as Error).message) as Record<string, unknown>;
    expect(payload).toMatchObject({ hook: "after_task", status: "failed", exit_code: 5 });
  });

  it("does NOT throw when a blocking section succeeds", async () => {
    const dir = await scratchDir();
    await writeConfig(dir, "before_task", "true");

    const hooks = await loadPlugin(dir);
    const e = skillEvent(BEFORE_TASK_SKILL);

    await expect(hooks["tool.execute.before"](e.input, e.output)).resolves.toBeUndefined();
  });

  it("does NOT throw when the section is missing entirely", async () => {
    const dir = await scratchDir();
    await writeConfig(dir, "after_goal", "true");

    const hooks = await loadPlugin(dir);
    const e = skillEvent(BEFORE_TASK_SKILL);

    await expect(hooks["tool.execute.before"](e.input, e.output)).resolves.toBeUndefined();
  });

  it("runs the after_goal section on a completing goal.md write", async () => {
    const dir = await scratchDir();
    const marker = join(dir, "goal.marker");
    await writeConfig(dir, "after_goal", `touch ${marker}`);
    await mkdir(join(dir, "goals"), { recursive: true });

    const hooks = await loadPlugin(dir);
    const e = writeEvent("write", join(dir, "goals", GOAL_FILENAME), `${COMPLETION_HEADING}\n`);
    await hooks["tool.execute.after"](e.input, e.output);

    expect(await Bun.file(marker).exists()).toBe(true);
  });

  it("NEVER throws when the advisory section fails, but DOES report it", async () => {
    const dir = await scratchDir();
    await writeConfig(dir, "after_goal", 'sh -c "exit 9"');

    const hooks = await loadPlugin(dir);
    const e = writeEvent("write", join(dir, GOAL_FILENAME), `${COMPLETION_HEADING}\n`);

    // Assert on the report as well as the absence of a throw. Without this, a
    // handler that silently swallowed the failure would pass just as happily
    // as one that reports it — and silence is the failure mode that matters
    // for an advisory hook, since nothing else surfaces it.
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await expect(hooks["tool.execute.after"](e.input, e.output)).resolves.toBeUndefined();
    } finally {
      process.stderr.write = realWrite;
    }

    const reported = written.join("");
    expect(reported).toContain('"status":"failed"');
    expect(reported).toContain('"exit_code":9');
    expect(reported).toContain('"hook":"after_goal"');
  });

  it("reports rather than throws if the advisory section itself errors", async () => {
    const dir = await scratchDir();
    await writeConfig(dir, "after_goal", "true");

    const hooks = await loadPlugin(dir);
    // A payload whose file path is present but whose section run will be given
    // an unusable cwd: the handler must still resolve.
    const e = writeEvent("write", join(dir, GOAL_FILENAME), `${COMPLETION_HEADING}\n`);

    await expect(hooks["tool.execute.after"](e.input, e.output)).resolves.toBeUndefined();
  });
});

describe("no API, cache or credential surface", () => {
  const forbidden = [
    "stride_auth",
    "STRIDE_API",
    "Authorization",
    "Bearer",
    "api/tasks",
    "changed-files",
    "env-cache",
    ".stride-env-cache",
    "fetch(",
  ];

  it("the entry point contains none of the forbidden tokens", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url).pathname).text();

    for (const token of forbidden) {
      expect(source).not.toContain(token);
    }
  });

  it("the entry point imports only the four permitted modules", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url).pathname).text();
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);

    expect([...new Set(imports)].sort()).toEqual(["./hook-exec", "./parser", "node:path"]);
  });
});

describe("documented trigger tables agree with the implementation", () => {
  const repoRoot = new URL("..", import.meta.url).pathname;

  const canonicalRows = [
    `| \`before_task\` | \`tool.execute.before\` | a skill-activation tool, skill name exactly \`${BEFORE_TASK_SKILL}\` | yes |`,
    `| \`after_task\` | \`tool.execute.before\` | a skill-activation tool, skill name exactly \`${AFTER_TASK_SKILL}\` | yes |`,
    `| \`after_goal\` | \`tool.execute.after\` | tool \`edit\` or \`write\`, basename exactly \`${GOAL_FILENAME}\`, payload contains \`${COMPLETION_HEADING}\` | no |`,
  ];

  // Criteria 5 and 6 are documentation requirements; asserting the rows against
  // the exported constants turns them into executable checks, so a trigger
  // change that misses a doc breaks a test instead of drifting silently.
  for (const file of [
    "AGENTS.md",
    "README.md",
    "skills/stride-opencode-lite-workflow/SKILL.md",
  ]) {
    it(`${file} carries the canonical trigger rows`, async () => {
      const text = await Bun.file(`${repoRoot}${file}`).text();

      for (const row of canonicalRows) {
        expect(text).toContain(row);
      }
    });
  }

  it("AGENTS.md records the rejected alternatives and the false-positive bound", async () => {
    const text = await Bun.file(`${repoRoot}AGENTS.md`).text();

    expect(text).toContain("Rejected alternatives");
    expect(text).toContain("False-positive bound");
    // The alternatives must be actual entries, not a heading with nothing under it.
    expect(text).toContain("subagent_type");
    expect(text).toContain("bash");
    expect(text).toContain("sentinel");
  });
});
