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

  it("carries no anchor for the not-applicable reason_code rule", async () => {
    // The canon records this port's reason-code-vocabulary row as
    // `not_applicable` -- D302 moved it off `deferred`, since `deferred`
    // selects which checks run rather than saying how settled a decision is.
    // An anchor on a narrowed cell would claim a compliance this port does
    // not have, so its absence is the assertion.
    expect(await readSkill(WORKFLOW)).not.toContain(
      "<!-- canon:reason-code-vocabulary",
    );
  });

  it("keeps exactly one anchor per entry in this skill", async () => {
    const body = await readSkill(WORKFLOW);

    for (const id of [
      "decision-matrix-authority",
      "row-precedence",
      "review-round-cap",
    ]) {
      const hits = body.match(new RegExp(`<!-- canon:${id} v\\d+ -->`, "g"));
      expect(hits).toHaveLength(1);
    }
  });

  // --- G417: the two-round review ceiling (W2172) -------------------------
  // These rules land as prose: src/ wires hooks and the activation marker and
  // never reads a review verdict, so there is no runtime to enforce them in.
  // These pins are therefore the only mechanical bound the repository has.
  // Every one was mutation-tested -- its clause deleted, this suite confirmed
  // red on that named test, the clause restored.

  it("anchors review-round-cap beside the port's own ceiling statement", async () => {
    expect(await readSkill(WORKFLOW)).toContain(
      "<!-- canon:review-round-cap v1 -->\n\n" +
        "**Two review rounds is the ceiling",
    );
  });

  it("performs the clamp in a step rather than only describing it", async () => {
    // A bound stated only in the Inputs table does not bind the procedure
    // that reads the value.
    expect(await readSkill(WORKFLOW)).toContain(
      "min(max_review_iterations, 2)",
    );
  });

  it("records important and minor findings at the ceiling", async () => {
    expect(await readSkill(WORKFLOW)).toContain(
      "**Remaining `important` and `minor` findings are recorded, not fixed.**",
    );
  });

  it("bounds the critical carve-out so it cannot renew", async () => {
    // Pin BOTH halves. An earlier version pinned only the non-renewal
    // sentence, so deleting the grant it bounds was invisible to the suite
    // and left the disposition silently three-way.
    const body = await readSkill(WORKFLOW);
    expect(body).toContain("for exactly one further round");
    expect(body).toContain(
      "The exemption is spent once for the whole task and does not renew",
    );
    expect(body).toContain("**Never record a `critical` and complete.**");
  });

  it("pins the ceiling VALUE, not only the clamp formula", async () => {
    // The clamp pin quotes min(max_review_iterations, 2), which survives a
    // revert of the Inputs-table default -- only smoke.sh caught that.
    const body = await readSkill(WORKFLOW);
    expect(body).toMatch(/\|\s*`max_review_iterations`\s*\|[^|]*\|[^|]*\|\s*`2`\s*\|/);
  });

  it("withholds the record disposition where category cannot be read", async () => {
    // The rendered issue bullet carries no `category`, so on the prose
    // fallback the security carve-out has nothing to select on.
    expect(await readSkill(WORKFLOW)).toContain(
      "**The ceiling's record disposition is unavailable on this path too",
    );
  });

  it("re-dispatches a failed reviewer once in every place that states it", async () => {
    const body = await readSkill(WORKFLOW);
    // Step 7's rule, the Edge-cases bullet and the quick-reference card must
    // agree; the card calls itself "the complete list".
    expect(body).toContain("is re-dispatched **once** and costs no round");
    expect(body).toContain("On a second consecutive failure");
    expect(body).toContain("a SECOND consecutive reviewer dispatch error");
  });

  it("never merely records a security finding, and judges it by subject", async () => {
    const body = await readSkill(WORKFLOW);
    expect(body).toContain("is never merely recorded, at any severity");
    // `category` is a string the reviewer assigns itself, and this port's own
    // contract files a not_met project check under `project_check`.
    expect(body).toContain("**Judge by subject as well as by label:**");
  });

  it("voids the all-cosmetic branch on a standing escalation", async () => {
    // The branch fires BEFORE the increment, so it never reaches the ceiling
    // carve-outs -- every guard it needs, it needs in its own condition.
    const body = await readSkill(WORKFLOW);
    expect(body).toContain("**and no escalation is standing**");
    expect(body).toContain("**voids the branch outright**");
  });

  it("re-reads severity and category in the all-cosmetic branch", async () => {
    const body = await readSkill(WORKFLOW);
    expect(body).toContain(
      "**every** entry is a `minor` whose `category` is not `\"security\"` and whose subject is not security",
    );
    expect(body).toContain("is not coerced here either");
  });

  it("bounds a non-conforming approval by routing it into the loop", async () => {
    // A path that looped without incrementing would be the one place this
    // loop does not terminate by construction.
    expect(await readSkill(WORKFLOW)).toContain(
      "**route into the `changes_requested` branch below**",
    );
  });

  it("tightens the prose fallback so a refusal cannot read as an approval", async () => {
    const body = await readSkill(WORKFLOW);
    expect(body).toContain(
      "**Test for refusal first, and match the affirmative only at the start of the line.**",
    );
    expect(body).toContain(
      "the report's `### Issues` subsection is empty or renders `- (none)`",
    );
  });

  it("admits exactly the two sanctioned non-approval termini at Step 8", async () => {
    expect(await readSkill(WORKFLOW)).toContain(
      "this step reached one of the two sanctioned non-approval termini above",
    );
  });

  it("forbids reporting a refused review as approved", async () => {
    expect(await readSkill(WORKFLOW)).toContain(
      "**Never write that a review which refused was approved.**",
    );
  });

  it("carries the redaction rule at both recorded-finding write sites", async () => {
    // Both write into a committed Completion Summary. Pinned per-site: a
    // whole-file count passes when one site loses the clause and another
    // gains one.
    const body = await readSkill(WORKFLOW);
    expect(body).toContain(
      "write `[REDACTED — text embedded a credential]` in its place and identify the finding by its `file:line`",
    );
    expect(body).toContain(
      "write `[REDACTED — text embedded a credential]` instead and identify it by its `file:line`",
    );
  });

  it("adds no second cap identifier", async () => {
    const body = await readSkill(WORKFLOW);
    const names = new Set(body.match(/max_\w*iterations/g) ?? []);
    expect([...names]).toEqual(["max_review_iterations"]);
    // And the standing prohibition survives verbatim.
    expect(body).toContain(
      "**Do not add a second cap and do not invent a security-specific terminal state**",
    );
  });

  it("records dispatch_count as cannot-apply, by name and with no anchor", async () => {
    // The canon's not_applicable reason cites grounds the port records; until
    // now nothing here named the key, so the citation was uncheckable.
    const body = await readSkill(WORKFLOW);
    expect(body).toContain(
      "**On the fleet-wide `dispatch_count` key — it cannot apply here",
    );
    expect(body).not.toContain("<!-- canon:dispatch-count-telemetry");
  });

  it("describes the canon's reason_code row as not_applicable, not deferred", async () => {
    const body = await readSkill(WORKFLOW);
    expect(body).toContain("The canon carries this port's row as `not_applicable`");
    expect(body).not.toContain("carries this port's row as `deferred`");
  });

  it("declines stride's skip enum from this port's own runtime, not stride-lite's", async () => {
    // The clause dates to the original port commit and was never re-voiced:
    // it argued from stride-lite being Claude-Code-only. This is an OpenCode
    // plugin carrying its own three agents in agents/, so the conclusion holds
    // but the ground had to come from this port. The paste must not return.
    const body = await readSkill(WORKFLOW);
    expect(body).toContain(
      "this port is an OpenCode plugin carrying its own three agents in `agents/`",
    );
    expect(body).not.toContain("stride-lite is Claude-Code-only");
  });

  it("keeps no unenumerated count of unreachable reason_code values", async () => {
    // D302 struck the same clause from the canon's own reasons: it counted how
    // many of the six codes a port's loop cannot reach, named which nowhere,
    // and was contradicted for at least `hook_body_empty`. D305 struck it here
    // for the same reason. The transport ground and the reopen condition are
    // what survive, so the absence of the count is the assertion.
    const body = await readSkill(WORKFLOW);
    expect(body).not.toMatch(/(Four|Two|Three|Five|Six) of the six/);
    expect(body).not.toContain("name conditions this loop cannot reach");
  });

  it("leaves no stale cap-of-three anywhere in the skill", async () => {
    const body = await readSkill(WORKFLOW);
    expect(body).not.toMatch(/default 3|cap of 3|hit 3 iterations|max_review_iterations \(3\)/);
    // The digit forms above missed a stale bullet phrased entirely in words
    // ("Review-loop exhausts max_review_iterations -- and stop without
    // writing the Completion Summary"). Pin the wording too.
    expect(body).not.toContain("Review-loop exhausts max_review_iterations");
    expect(body).not.toContain("explorer or reviewer dispatch errors");
  });
});
