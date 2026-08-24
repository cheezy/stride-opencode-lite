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

const COMMAND_NOT_DO_HEADING = "## What this command does NOT do";

const readCommand = async (name: string): Promise<string> =>
  Bun.file(join(commandsDir, `${name}.md`)).text();

const frontmatter = (source: string): string => {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  return match![1]!;
};

const bodyOnly = (source: string): string => source.replace(/^---\n[\s\S]*?\n---\n/, "");

/**
 * Every way a command body holds orchestration rather than delegating it.
 *
 * ONE definition, called by both the assertion and its mutation proof. Written
 * as a copy first, and the copy had already drifted from the original in two
 * ways by the time it was reviewed — a duplicated predicate cannot prove the
 * original goes red, because loosening the original leaves the copy untouched.
 *
 * Scoped to the region before the does-NOT block, which legitimately names the
 * forbidden things. Naming a lib helper in delegation prose is fine and must not
 * fire: the signals are executable form and imperative mood, not helper names.
 */
const thinShellViolations = (body: string): string[] => {
  const cut = body.indexOf(COMMAND_NOT_DO_HEADING);
  const doing = cut === -1 ? body : body.slice(0, cut);
  const found: string[] = [];

  // Every fenced block must be an unlabelled usage snippet.
  for (const [, lang, contents] of doing.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)) {
    if (lang !== "") found.push(`labelled fence: \`\`\`${lang}`);
    else if (!contents.includes("[--")) found.push("unlabelled fence that is not the usage snippet");
  }

  for (const raw of doing.split("\n")) {
    // A list marker must not launder an imperative: "1. Slugify the title and
    // write it to <path>" is the most natural shape for orchestration here.
    const line = raw.replace(/^\s*(?:\d+\.|[-*])\s+/, "");

    if (/^\s*(mkdir|printf|echo|cat|sed|awk|tr|git|curl|mv|cp)\s/.test(line)) {
      found.push(`shell command: ${line.trim().slice(0, 40)}`);
    }
    // Imperative addressed to THIS file, as against prose describing the skill
    // ("The skill walks…", "`lib/slugify` — normalise the title").
    if (/^(Write|Create|Slugify|Lowercase|Replace|Resolve|Render) the /.test(line)) {
      found.push(`imperative: ${line.trim().slice(0, 40)}`);
    }
  }

  return found;
};

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
    // The assertions above check that the file makes a promise. This checks the
    // promise is kept — see thinShellViolations for what counts and why.
    expect(thinShellViolations(bodyOnly(await readCommand(name)))).toEqual([]);
  });

  it("has a thin-shell check that goes red on orchestration", async () => {
    // Runs the SAME predicate the assertion above runs, so dropping a signal
    // from it breaks this proof rather than leaving it quietly green.
    const body = bodyOnly(await readCommand(name));
    const cut = body.indexOf(COMMAND_NOT_DO_HEADING);

    for (const injected of [
      '\n```bash\nmkdir -p "$OUTPUT_DIR"\n```\n',
      "\n```\nnot the usage snippet\n```\n",
      "\nprintf '%s' \"$SLUG\" > out.md\n",
      "\nSlugify the title, then write it to docs/implementation/PENDING/tasks/<slug>.md.\n",
      "\n1. Slugify the title and write it to the resolved path\n",
      "\nWrite the rendered markdown to the resolved path.\n",
    ]) {
      // Injected BEFORE the does-NOT block: that block legitimately names the
      // forbidden things, so an injection after it proves nothing.
      const mutated = body.slice(0, cut) + injected + body.slice(cut);

      expect(thinShellViolations(mutated)).not.toEqual([]);
    }
  });

  it("keeps its step prose count-agnostic", async () => {
    // A stated count goes stale the first time the skill gains or loses a step.
    const body = bodyOnly(await readCommand(name));

    // Digits, words and the bare noun in one pattern. Word-spelled-only
    // negatives let "all 7 flow steps" and "its seven steps" through, which is
    // the natural regression now that the files carry literal numbered lists.
    // The list's own "1." markers are excluded — they are the list, not a claim
    // about its length.
    const prose = body
      .split("\n")
      .filter((line) => !/^\d+\. /.test(line))
      .join("\n");

    expect(prose).not.toMatch(
      /\b(\d+|one|two|three|four|five|six|seven|eight|nine)[- ](flow )?steps?\b/i,
    );
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

    // Against the body as well as the whole file: the frontmatter description
    // already names --force, so a whole-file check alone would stand while the
    // body lost the flag entirely.
    expect(source).toContain("--force");
    expect(bodyOnly(source)).toContain("--force");
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
    // Scoped to the section. Over the whole README, `toContain("init")` matches
    // "initial", "initialise" and any prose elsewhere, so it credits a command
    // the section never documents.
    const section = readme.split("## Commands")[1]!.split(/^## /m)[0]!;
    for (const name of Object.keys(COMMANDS)) {
      expect(section).toContain(name);
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

  it("documents the install as two steps, with both failure modes named", async () => {
    const readme = (await Bun.file(join(repoRoot, "README.md")).text()).replace(/\s+/g, " ");

    expect(readme).toContain("two separate steps");
    // The trap. Without this sentence a user registers the plugin, gets no
    // skills, and has nothing to go on.
    expect(readme).toContain("OpenCode does NOT auto-discover skills or agents");
    expect(readme).toContain("silent partial install");
    // Both halves, not just the famous one: artifacts with no plugin
    // registration is equally silent.
    expect(readme).toMatch(/no hook section in `\.stride_lite\.md` ever fires/);
  });

  it("states the Windows verification status without overclaiming", async () => {
    // Matched against whitespace-collapsed text: these are prose claims, and a
    // line rewrap must not read as a regression.
    const readme = (await Bun.file(join(repoRoot, "README.md")).text()).replace(/\s+/g, " ");

    expect(readme).toContain("has **not** been run on Windows");
    expect(readme).toContain("unverified");
    // Deny-listing phrasings is not enough — a plural-only regex walks past the
    // singular, and no list anticipates every way to overclaim. Instead: NO
    // sentence mentioning Windows may make a positive verification claim. That
    // catches a new false claim, not only the ones foreseen.
    const windowsSentences = readme
      .split(/(?<=\.)\s+/)
      .filter((sentence) => /\bwindows\b/i.test(sentence));

    expect(windowsSentences.length).toBeGreaterThan(0);
    for (const sentence of windowsSentences) {
      const positiveClaim = /\b(verified|tested|works|working|supported|supports?)\b/i.test(sentence);
      const negated = /\b(not|never|no|unverified|untested)\b/i.test(sentence);

      if (positiveClaim) expect(sentence).toSatisfy(() => negated);
    }
  });

  it("keeps the dormancy statement as strong as the code requires", async () => {
    // The single easiest place to nominally pass while regressing the document:
    // the count assertions need only the TOKEN "dormant", which survives inside
    // a sentence saying the opposite. Assert the claim, not the word.
    const readme = (await Bun.file(join(repoRoot, "README.md")).text()).replace(/\s+/g, " ");

    expect(readme).toContain("dormant on today's build");
    expect(readme).toContain("`before_task` and `after_task` do not fire");
    // The whole reason, not a two-word fragment: "emits no" is a token that
    // survives inside "emits no fewer events than a tool call", which asserts
    // the opposite. This is the mistake this very test was written to avoid.
    expect(readme).toContain("`@mention` dispatch emits no `tool.execute.*` event");
    // And no sentence may claim the blocking triggers fire.
    for (const sentence of readme.split(/(?<=\.)\s+/)) {
      if (/\b(before_task|after_task|blocking (hook )?triggers?)\b/.test(sentence)) {
        expect(sentence).not.toMatch(/\bfires? (on|when|every)\b/i);
      }
    }
  });

  it("states the security model without overstating it", async () => {
    const readme = (await Bun.file(join(repoRoot, "README.md")).text()).replace(/\s+/g, " ");

    expect(readme).toContain("arbitrary shell");
    expect(readme).toContain("does not validate, sanitize or inspect it");
    expect(readme).toContain("Makefile");
    // The marker must never read as an authorization control.
    expect(readme).toContain("coordination, not security");
    expect(readme).toContain("fails open");
    expect(readme).toContain("trivially forged");
  });

  it("has a hook table matching the constants src/index.ts exports", async () => {
    // A README hook table is the easiest thing in the repo to write
    // aspirationally. Drive it from the source constants.
    const readme = await Bun.file(join(repoRoot, "README.md")).text();
    const index = await Bun.file(join(repoRoot, "src/index.ts")).text();

    const constant = (name: string): string => {
      const m = index.match(new RegExp(`${name} = "([^"]+)"`));
      expect(m).not.toBeNull();
      return m![1]!;
    };

    const table = readme.split("## Hook triggers")[1]!.split(/^## /m)[0]!;
    expect(table).toContain(constant("BEFORE_TASK_SKILL"));
    expect(table).toContain(constant("AFTER_TASK_SKILL"));
    expect(table).toContain(constant("COMPLETION_HEADING"));
    expect(table).toContain("tool.execute.before");
    expect(table).toContain("tool.execute.after");
  });

  it("carries a does-NOT block naming the hard rules", async () => {
    const readme = await Bun.file(join(repoRoot, "README.md")).text();
    const block = readme.split("## What this plugin does NOT do")[1]!.split(/^## /m)[0]!;

    expect(block).toContain("No Stride API calls");
    expect(block).toContain(".stride_auth.md");
    expect(block).toContain("environment cache");
  });

  it("no longer claims the commands are unported", async () => {
    const readme = await Bun.file(join(repoRoot, "README.md")).text();

    // One assertion, not two: the earlier `not.toContain("commands\n> are not
    // yet ported")` was strictly subsumed by this one and could never fail on
    // its own.
    expect(readme).not.toContain("are not yet ported");
  });
});
