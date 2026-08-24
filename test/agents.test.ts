import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Static shape checks for the three agent definitions.
 *
 * These are markdown definitions with no runtime in this repository, so this is
 * a SHAPE test and nothing more. It is deliberately not the kind of check
 * `test/load_requirements_dir.spec.test.ts` performs — that one extracts a
 * spec's own bash and runs it, which has no analogue here because an agent
 * definition contains nothing executable. Saying so plainly is better than
 * implying equivalent coverage.
 *
 * What it cannot establish, and what therefore stays a known gap in AGENTS.md:
 * that OpenCode honours the `tools` map at all, what an omitted `tools` key
 * would mean, that `@task-explorer` resolves in a live session, and that the
 * agents behave as their bodies document. All three need a running OpenCode
 * session.
 */

const repoRoot = new URL("..", import.meta.url).pathname;
const agentsDir = join(repoRoot, "agents");

const AGENTS = ["create-decomposer", "task-explorer", "task-reviewer"] as const;

/** The tool grant each agent must declare — the security boundary of this layer. */
const EXPECTED_TOOLS: Record<string, Record<string, boolean>> = {
  "create-decomposer": {
    read: false,
    grep: false,
    glob: false,
    bash: false,
    edit: false,
    write: false,
  },
  "task-explorer": {
    read: true,
    grep: true,
    glob: true,
    bash: false,
    edit: true,
    write: true,
  },
  "task-reviewer": {
    read: true,
    grep: true,
    glob: true,
    bash: true,
    edit: true,
    write: true,
  },
};

const readAgent = async (name: string): Promise<string> =>
  Bun.file(join(agentsDir, `${name}.md`)).text();

/**
 * Split the frontmatter without a YAML dependency.
 *
 * `yaml` is present under node_modules only transitively via
 * @opencode-ai/plugin, and depending on a transitive package is how a suite
 * breaks on someone else's dependency bump.
 */
const frontmatter = (source: string): string => {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  return match![1]!;
};

const toolMap = (source: string): Record<string, boolean> => {
  const block = frontmatter(source).match(/^tools:\n((?:[ \t]+\w+:[ \t]*\w+\n?)+)/m);
  expect(block).not.toBeNull();

  const entries = [...block![1]!.matchAll(/^[ \t]+(\w+):[ \t]*(true|false)\s*$/gm)];
  return Object.fromEntries(entries.map((m) => [m[1]!, m[2] === "true"]));
};

describe("the agent roster", () => {
  it("contains exactly the three ported agents", async () => {
    const present = (await readdir(agentsDir))
      .filter((f) => f.endsWith(".md"))
      .sort();

    // Catches a stray fourth agent and a rename alike. The two stride-lite
    // agents not ported here belong to the workflow-port task.
    expect(present).toEqual([...AGENTS].map((a) => `${a}.md`).sort());
  });
});

describe.each([...AGENTS])("%s", (name: string) => {
  it("has valid OpenCode frontmatter", async () => {
    const fm = frontmatter(await readAgent(name));

    expect(fm).toContain("mode: subagent");
    expect(fm).toMatch(/^description: \|/m);
    const temperature = Number(fm.match(/^temperature:\s*([\d.]+)$/m)?.[1]);
    expect(temperature).toBeGreaterThanOrEqual(0.1);
    expect(temperature).toBeLessThanOrEqual(0.3);
  });

  it("carries no Claude Code frontmatter keys", async () => {
    const fm = frontmatter(await readAgent(name));

    // OpenCode takes identity from the filename and has no model key here.
    expect(fm).not.toMatch(/^name:/m);
    expect(fm).not.toMatch(/^model:/m);
  });

  it("declares exactly the six tool keys with the required grants", async () => {
    const tools = toolMap(await readAgent(name));

    // The grants ARE the security boundary of the agent layer, so this asserts
    // the whole vector rather than spot-checking. It fails loudly if someone
    // later "simplifies" the decomposer by deleting its all-false map.
    expect(tools).toEqual(EXPECTED_TOOLS[name]!);
  });

  it("instructs the agent never to copy secrets into its output", async () => {
    // Added by this port; the stride-lite sources carry no secret-handling
    // instruction at all.
    const body = await readAgent(name);

    expect(body).toContain("secret-bearing line");
  });

  it("retains no Claude Code host artifacts in the body", async () => {
    const body = await readAgent(name);

    expect(body).not.toContain("model: inherit");
    expect(body).not.toContain("tools: Read");
    expect(body).not.toContain("/stride-lite:");
  });
});

describe("task-reviewer bash scope", () => {
  it("keeps the section and every prohibition family", async () => {
    const body = await readAgent("task-reviewer");

    expect(body).toContain("## Bash scope");

    // The prohibition list is what makes the scope a rule rather than guidance.
    for (const prohibited of [
      "mix test",
      "npm test",
      "cargo test",
      "curl",
      "wget",
      "nc",
      "git commit",
      "git push",
      "git checkout",
      "git reset",
      "git merge",
      "git rebase",
      "rm",
      "mv",
      "cp",
      "Anything else that is not a read-only git command",
    ]) {
      expect(body).toContain(prohibited);
    }
  });

  it("keeps the read-only git allowances", async () => {
    const body = await readAgent("task-reviewer");

    for (const allowed of ["git diff", "git log", "git rev-parse", "git show"]) {
      expect(body).toContain(allowed);
    }
  });
});

describe("Review Report structured keys", () => {
  it("keeps the schema version and the security_considerations key set", async () => {
    // The workflow skill parses these; renumbering or rewording them is a
    // documented pitfall.
    const body = await readAgent("task-reviewer");

    expect(body).toContain('schema_version `"1.6"`');
    expect(body).toContain("<!-- canon:verdict-note v1 -->");

    for (const key of ["consideration", "status", "evidence", "note", "considerations"]) {
      expect(body).toContain(key);
    }

    for (const value of ["mitigated", "partial", "unmitigated"]) {
      expect(body).toContain(value);
    }
  });
});

describe("the refuse-to-mutate guard", () => {
  it("survives in both report agents", async () => {
    // This guard is what prevents clobbering user content when the report
    // section is not last.
    for (const [name, heading] of [
      ["task-explorer", "## Exploration Report"],
      ["task-reviewer", "## Review Report"],
    ] as const) {
      const body = await readAgent(name);

      expect(body).toContain("State C");
      expect(body).toContain("Do NOT guess at the slice boundary");
      expect(body).toContain("refusing to mutate");
      expect(body).toContain(heading);
    }
  });
});

describe("create-decomposer contract", () => {
  it("keeps the eight-task cap and the output schema", async () => {
    const body = await readAgent("create-decomposer");

    expect(body).toContain("1–8");
    expect(body).toContain("## Output schema (canonical)");
    expect(body).toContain("## What you MUST NOT emit");
  });
});
