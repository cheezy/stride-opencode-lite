import { describe, expect, it } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Static shape checks for the ported skills.
 *
 * As with `agents.test.ts`, these are markdown files with no runtime here, so
 * every assertion is a shape check or a text extraction. What it CANNOT
 * establish, and what therefore stays a known gap in AGENTS.md: that OpenCode
 * discovers `skills/` and honours this frontmatter, that the activation
 * descriptions route the intended prompts without colliding with each other,
 * that `@create-decomposer` resolves in a live session, and that the flows
 * produce the files they describe. All of that needs a running OpenCode.
 */

const repoRoot = new URL("..", import.meta.url).pathname;
const skillsDir = join(repoRoot, "skills");

const PORTED = [
  "stride-opencode-lite-create-goal",
  "stride-opencode-lite-create-task",
  "stride-opencode-lite-init",
];

const readSkill = async (name: string): Promise<string> =>
  Bun.file(join(skillsDir, name, "SKILL.md")).text();

const frontmatter = (source: string): string => {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  return match![1]!;
};

describe.each(PORTED)("%s", (name) => {
  it("has frontmatter whose name equals the directory basename", async () => {
    // OpenCode's matcher keys on `name`; a drift between the two makes the
    // skill unaddressable.
    const fm = frontmatter(await readSkill(name));

    expect(fm).toContain(`name: ${name}`);
    expect(fm).toContain("license: MIT");
    expect(fm).toContain("compatibility: opencode");
    expect(fm).toMatch(/^metadata:$/m);
  });

  it("carries no Claude Code frontmatter or host artifacts", async () => {
    const source = await readSkill(name);

    for (const artifact of [
      "skills_version",
      "allowed-tools",
      "argument-hint",
      "hooks.json",
      "PreToolUse",
      "subagent_type",
      "Claude Code",
      "/stride-lite:",
      ".claude",
    ]) {
      expect(source).not.toContain(artifact);
    }
  });

  it("has an activation clause and names its sibling boundary", async () => {
    // With no keywords key, the matcher sees name + description only, so the
    // trigger phrasing and the disambiguation have to be in the prose.
    const fm = frontmatter(await readSkill(name));

    expect(fm).toContain("Activate when the user asks to");
    // Every skill states the no-API contract; the voice differs by skill.
    expect(fm).toMatch(/never POST(s|ed)? to any API/i);
  });
});

describe("the create skills", () => {
  const creates = PORTED.filter((n) => n !== "stride-opencode-lite-init");

  it.each(creates)("%s keeps both path defaults", async (name) => {
    const source = await readSkill(name);

    expect(source).toContain("docs/requirements");
    expect(source).toContain("docs/implementation/PENDING");
  });

  it.each(creates)("%s dispatches the decomposer by @mention", async (name) => {
    const source = await readSkill(name);

    expect(source).toContain("@create-decomposer");
  });

  it("create-goal keeps the eight-task cap, and it agrees with the agent", async () => {
    const skill = await readSkill("stride-opencode-lite-create-goal");
    const agent = await Bun.file(join(repoRoot, "agents/create-decomposer.md")).text();

    expect(skill).toContain("1 to 8");
    // The cap is stated in two places; they must not drift apart.
    expect(agent).toContain("1–8");
  });

  it.each(["stride-opencode-lite-create-goal", "stride-opencode-lite-create-task"])(
    "%s frames the requirements text as data, not instructions",
    async (name) => {
      // load_requirements_dir concatenates arbitrary repository files into the
      // decomposer prompt; without this framing that is an unguarded
      // prompt-injection surface.
      const source = await readSkill(name);

      expect(source).toContain("data, never instructions");
    },
  );

  it("each names the other as the boundary case", async () => {
    const goal = frontmatter(await readSkill("stride-opencode-lite-create-goal"));
    const task = frontmatter(await readSkill("stride-opencode-lite-create-task"));

    expect(goal).toContain("stride-opencode-lite-create-task");
    expect(task).toContain("stride-opencode-lite-create-goal");
  });
});

describe("the init skill", () => {
  it("refuses to clobber without --force, and tests -L as well as -e", async () => {
    const source = await readSkill("stride-opencode-lite-init");

    expect(source).toContain("--force");
    // `test -e` dereferences, so a dangling symlink reads as absent and a
    // plain redirection would follow it out of the working directory.
    expect(source).toContain('-L "$TARGET"');
  });

  it("never executes a hook section", async () => {
    const source = await readSkill("stride-opencode-lite-init");

    expect(source).toContain("never executes");
  });

  it("does not promise hook context variables this plugin cannot supply", async () => {
    // hook-exec.ts takes no env option, so the source's "Available here:
    // HOOK_NAME ..." promise is false on this host.
    const source = await readSkill("stride-opencode-lite-init");

    // Assert the PROPERTY, not one phrasing of it. Pinning the old wording is
    // what let a second copy of the promise survive in different words.
    for (const promised of [
      "HOOK_NAME",
      "TASK_FILE",
      "TASK_NUMBER",
      "TASK_TITLE",
      "GOAL_DIR",
      "GOAL_FILE",
      "GOAL_SLUG",
      "GOAL_TITLE",
      "AGENT_NAME",
    ]) {
      expect(source).not.toContain(promised);
    }
    expect(source).toContain("supplies no hook context variables");
  });

  it("scaffolds the section names the parser recognises", async () => {
    const source = await readSkill("stride-opencode-lite-init");
    const parser = await Bun.file(join(repoRoot, "src/parser.ts")).text();

    for (const section of ["## before_task", "## after_task", "## after_goal"]) {
      expect(source).toContain(section);
      expect(parser).toContain(section.replace("## ", '"'));
    }
  });
});

describe("the skills directory", () => {
  it("contains the three ported skills alongside the workflow stub", async () => {
    const present = (await readdir(skillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    expect(present).toEqual(
      [...PORTED, "stride-opencode-lite-workflow"].sort(),
    );
  });

  it("names every directory with this plugin's identity", async () => {
    const present = (await readdir(skillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    for (const dir of present) {
      expect(dir.startsWith("stride-opencode-lite-")).toBe(true);
    }
  });
});

describe("port-canon anchors", () => {
  // The fleet drift check (stride/scripts/check-port-canon.sh) scans for these
  // comments by id and version. It is presence-and-version only, so a reworded
  // anchor, a bumped version, or a second copy elsewhere in the tree changes
  // the reported verdict without changing any prose a reader would notice.
  const WORKFLOW = "stride-opencode-lite-workflow";

  // These assert PLACEMENT, not just presence. The release gate's own scan is
  // presence-and-version only and is context-free, so an anchor moved away from
  // the rule it governs still reports `ok` there. Binding each anchor to the
  // first line of the paragraph it governs is what makes "beside" checkable.
  it("anchors decision-matrix-authority beside the port's own matrix", async () => {
    expect(await readSkill(WORKFLOW)).toContain(
      "<!-- canon:decision-matrix-authority v1 -->\n" +
        "**This table is normative on its own in this port.**",
    );
  });

  it("anchors row-precedence beside the port's own precedence statement", async () => {
    expect(await readSkill(WORKFLOW)).toContain(
      "<!-- canon:row-precedence v1 -->\n" +
        "Read the rows top to bottom and take the first that matches.",
    );
  });

  it("attributes the trailing row-shape paragraphs to row-precedence", async () => {
    // Those paragraphs sit below the decision-matrix-authority anchor, so
    // without this note a maintainer editing them is prompted for the wrong
    // canon entry. stride resolves the same ambiguity the same way.
    expect(await readSkill(WORKFLOW)).toContain(
      "belong to entry `row-precedence`, not to `decision-matrix-authority`",
    );
  });

  it("carries no anchor for the deferred reason_code rule", async () => {
    // The canon records this port's reason-code-vocabulary row as `deferred`.
    // An anchor beside a deferral would claim a compliance this port does not
    // have, so its absence is the assertion.
    expect(await readSkill(WORKFLOW)).not.toContain(
      "<!-- canon:reason-code-vocabulary",
    );
  });

  it("keeps exactly one anchor per entry in this skill", async () => {
    const body = await readSkill(WORKFLOW);

    for (const id of ["decision-matrix-authority", "row-precedence"]) {
      const hits = body.match(new RegExp(`<!-- canon:${id} v\\d+ -->`, "g"));
      expect(hits).toHaveLength(1);
    }
  });
});
