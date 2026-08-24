import { afterAll, describe, expect, it } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs `test/smoke.sh` under `bun test`.
 *
 * The smoke script is where the template-parity assertions live, and the task
 * that added it names that file specifically. But `package.json` runs `bun
 * test`, so a bare `.sh` would never execute in the suite and would be free to
 * rot — a parity check nobody runs guards nothing. This wrapper is what makes
 * the named file real AND wired in. Running bash from a bun test is already
 * this repo's idiom; `load_requirements_dir.spec.test.ts` does the same.
 *
 * Note what is asserted: not merely the exit code, but that each parity stage
 * actually REPORTED. A smoke script that silently skipped the whole stage would
 * still exit 0, and crediting that would be the same vacuity the script itself
 * is built to avoid.
 */

const repoRoot = new URL("..", import.meta.url).pathname;
const scratchDirs: string[] = [];

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const run = async (
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn(["bash", join(repoRoot, "test/smoke.sh")], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode: await proc.exited };
};

/** A copy of a top-level tree, so a mutation never touches the working tree. */
const treeCopy = async (name: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `stride-lite-smoke-${name}-`));
  scratchDirs.push(dir);
  await cp(join(repoRoot, name), join(dir, name), { recursive: true });
  return join(dir, name);
};

/** A copy of the skills tree, so a mutation never touches the working tree. */
const skillsCopy = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "stride-lite-smoke-"));
  scratchDirs.push(dir);
  await cp(join(repoRoot, "skills"), join(dir, "skills"), { recursive: true });
  return join(dir, "skills");
};

describe("test/smoke.sh", () => {
  it("passes, and every parity stage actually ran", async () => {
    const { stdout, exitCode } = await run();

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^\d+ passed, 0 failed/m);

    // Each stage asserted by its label. Exit code alone cannot distinguish
    // "every check passed" from "the checks never ran".
    // The PASS prefix is required: skipped() prints the IDENTICAL label, so a
    // bare substring match cannot tell a stage that passed from one that was
    // skipped — the very distinction this assertion exists to make.
    for (const label of [
      "create-goal taskN template extracted non-empty",
      "create-task taskN template extracted non-empty",
      "both taskN templates are structurally complete",
      "the hash pin rejects altered content",
      "the two create skills' taskN templates are byte-identical",
      "both taskN templates match the stride-lite source hash",
      "the parity comparison detects a one-byte divergence",
      "an empty extraction is refused, not credited",
      "init canonical template has its four sections",
      "init's clobber guard tests -L as well as -e",
      "workflow: the step headings appear in order",
      "workflow: the activation contract requires both intent and a path",
      "workflow: the termination contract states a single exit",
      "workflow: the review cap is 3 in Step 7",
      "workflow: the hook contract table carries the three canonical rows",
      "workflow: the contract supplies no hook context variables",
      "workflow: no OpenCode-foreign host artifacts",
      "workflow: the allow list keeps the terminal-move carve-out",
      "workflow: the deny list keeps the runner, network and mutating-git entries",
      "workflow: the allow and deny regions do not overlap (negative control)",
      "workflow: the walkthrough never hand-executes a hook section",
      "workflow: the archive move keeps git-mv preference, collision suffixing and the PENDING guard",
      "workflow: the activation marker is written at Step 0 and cleared on every stop",
      "workflow: the marker is documented as coordination and as fail-open",
      "workflow: the terminal-move carve-out is granted and scoped",
      "the goal.md template is extracted non-empty by both extractors",
      "the goal.md template is structurally complete (33 lines, 7 sections)",
      "the two goal.md template extractors agree",
      "the goal.md template matches the stride-lite source hash",
      "the goal.md template hash pin rejects altered content (negative control)",
      "fixtures: every vendored file is present and non-empty",
      "fixtures: the vendored tree holds exactly the expected files and no symlinks",
      "fixtures: every vendored file matches its pinned stride-lite sha256",
      "fixtures: README.md records the stride-lite source commit",
      "fixtures: README.md pins the same hashes and paths the check does",
      "fixtures: no CR bytes, and every file ends with a newline",
      "fixtures: no timestamp or machine-specific path in any vendored file",
      "fixtures: task1.md carries the taskN template's headings, in order",
      "fixtures: goal.md carries the goal template's headings, in order",
      "fixtures: the conformance check detects a renamed heading (negative control)",
      "fixtures: the byte and presence gates reject a one-byte change and an absent file (negative control)",
      "commands: every activated skill name resolves to a skill on disk",
      "commands: the create commands' defaults match the lib/parse_args spec",
      "commands: each flow list has one entry per step in the skill it activates",
      "commands: every command check detects a mutation (negative control)",
      "Command-file assertions pass",
    ]) {
      expect(stdout).toContain(`PASS  ${label}`);
    }
  });

  it("fails when the two taskN templates diverge by one token", async () => {
    // The executable form of the manual check: prove the parity assertion can
    // go red, using a divergence that leaves the structure intact so the diff
    // — not the structural check — is what catches it.
    const skills = await skillsCopy();
    const target = join(skills, "stride-opencode-lite-create-task/SKILL.md");
    const source = await Bun.file(target).text();

    const start = source.indexOf("#### Task template");
    const fence = source.indexOf("```markdown", start);
    const close = source.indexOf("\n```\n", fence);
    const block = source.slice(fence, close);
    const mutated = block.replace("<task.description>", "<task.desc>");
    expect(mutated).not.toBe(block);

    await Bun.write(target, source.slice(0, fence) + mutated + source.slice(close));

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_SKILLS_DIR: skills });

    expect(exitCode).not.toBe(0);
    // The specific label matters: a non-zero exit from an unrelated stage
    // would otherwise be credited as this control passing.
    expect(stderr).toContain("FAIL  the two create skills' taskN templates are byte-identical");
    expect(stderr).toContain("FAIL  both taskN templates match the stride-lite source hash");
  });

  it("fails when an extraction is truncated", async () => {
    const skills = await skillsCopy();
    const target = join(skills, "stride-opencode-lite-create-goal/SKILL.md");
    const source = await Bun.file(target).text();

    const start = source.indexOf("### taskN.md template");
    const fence = source.indexOf("```markdown", start);
    const close = source.indexOf("\n```\n", fence);
    await Bun.write(target, source.slice(0, close) + "\n" + source.slice(close + 5));

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_SKILLS_DIR: skills });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("FAIL  both taskN templates are structurally complete");
  });

  it("fails when a command names a skill that does not exist", async () => {
    // The command stage reads two trees and requires them to agree. Prove it
    // goes red rather than trusting that it ran: the label assertion above only
    // shows the stage reported, not that it can fail.
    const commands = await treeCopy("commands");
    const target = join(commands, "init.md");
    const source = await Bun.file(target).text();
    await Bun.write(
      target,
      source.replace(
        "Activate the `stride-opencode-lite-init` skill",
        "Activate the `stride-opencode-lite-gone` skill",
      ),
    );

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_COMMANDS_DIR: commands });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("FAIL  commands: every activated skill name resolves to a skill on disk");
    expect(stderr).toContain("FAIL  Command-file assertions pass");
  });

  it("fails when a command's flow list drifts from its skill's step count", async () => {
    // This is the check that would have caught a restored step list being lost
    // to a working-copy checkout, which is how it actually went missing.
    const commands = await treeCopy("commands");
    const target = join(commands, "create-goal.md");
    const source = await Bun.file(target).text();
    await Bun.write(target, source.replace(/^8\. .*\n/m, ""));

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_COMMANDS_DIR: commands });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "FAIL  commands: each flow list has one entry per step in the skill it activates",
    );
  });

  it("fails when a command's default drifts from the lib/parse_args spec", async () => {
    const commands = await treeCopy("commands");
    const target = join(commands, "create-goal.md");
    const source = await Bun.file(target).text();
    await Bun.write(
      target,
      source.replace(
        "| `--output-dir` | `docs/implementation/PENDING` |",
        "| `--output-dir` | `docs/elsewhere` |",
      ),
    );

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_COMMANDS_DIR: commands });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("FAIL  commands: the create commands' defaults match the lib/parse_args spec");
  });

  it("fails when a vendored fixture is missing, and never skips it", async () => {
    // Read this together with the test immediately below. Two superficially
    // similar absences, opposite verdicts: a file WE ship going missing is our
    // defect and must FAIL; stride-lite not being checked out is not our repo
    // and must SKIP. Keeping the two adjacent is the only documentation of that
    // line that survives a refactor.
    const fixtures = await treeCopy("fixtures");
    await rm(join(fixtures, "expected-output/task1.md"));

    const { stdout, stderr, exitCode } = await run({ STRIDE_SMOKE_FIXTURES_DIR: fixtures });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("FAIL  fixtures: every vendored file is present and non-empty");
    expect(stderr).toContain("task1.md");
    // Never credited, and never softened into a skip.
    expect(stdout).not.toContain("PASS  fixtures: every vendored file is present and non-empty");
    expect(stdout).not.toContain("SKIP  fixtures: every vendored file is present and non-empty");
    expect(stdout).not.toContain("PASS  fixtures: every vendored file matches its pinned stride-lite sha256");
  });

  it("fails when a vendored fixture changes by one byte, and shows the hashes", async () => {
    const fixtures = await treeCopy("fixtures");
    const target = join(fixtures, "expected-output/goal.md");
    await Bun.write(target, (await Bun.file(target).text()) + "\n");

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_FIXTURES_DIR: fixtures });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("FAIL  fixtures: every vendored file matches its pinned stride-lite sha256");
    // Both hashes named: "it differs" without saying how is not a usable failure.
    expect(stderr).toContain("00ae81dc1a6907d97c0ce37712fce58b096756100fc55fffd7a095cc83b4de55");
    expect(stderr).toMatch(/got [0-9a-f]{64}/);
  });

  it("fails when fixtures/README.md names a different stride-lite commit", async () => {
    const fixtures = await treeCopy("fixtures");
    const target = join(fixtures, "README.md");
    const source = await Bun.file(target).text();
    await Bun.write(target, source.replaceAll("ffb670bbc29096916d0111ca64944e0c92f968ee", "0".repeat(40)));

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_FIXTURES_DIR: fixtures });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("FAIL  fixtures: README.md records the stride-lite source commit");
  });

  it("fails when an extra file appears under fixtures/", async () => {
    // An unchecked fixture is a rot vector: it looks like corpus and is pinned
    // by nothing.
    const fixtures = await treeCopy("fixtures");
    await Bun.write(join(fixtures, "stray.md"), "x\n");

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_FIXTURES_DIR: fixtures });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(
      "FAIL  fixtures: the vendored tree holds exactly the expected files and no symlinks",
    );
  });

  it("names CRLF as the cause rather than only failing the hash", async () => {
    const fixtures = await treeCopy("fixtures");
    const target = join(fixtures, "expected-output/task1.md");
    await Bun.write(target, (await Bun.file(target).text()).replaceAll("\n", "\r\n"));

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_FIXTURES_DIR: fixtures });

    expect(exitCode).not.toBe(0);
    // The EOL stage exists to EXPLAIN the hash failure, not to replace it —
    // so both must fire.
    expect(stderr).toContain("FAIL  fixtures: no CR bytes, and every file ends with a newline");
    expect(stderr).toContain("FAIL  fixtures: every vendored file matches its pinned stride-lite sha256");
  });

  it("fails on a one-character change to the taskN template, and shows the diff", async () => {
    // Criterion 5, half one: a single character deleted from a heading.
    const skills = await skillsCopy();
    const target = join(skills, "stride-opencode-lite-create-task/SKILL.md");
    const source = await Bun.file(target).text();
    const mutated = source.replace("\n## Pitfalls\n", "\n## Pitfall\n");
    expect(mutated).not.toBe(source);
    await Bun.write(target, mutated);

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_SKILLS_DIR: skills });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("FAIL  the two create skills' taskN templates are byte-identical");
    expect(stderr).toContain("FAIL  both taskN templates match the stride-lite source hash");
    // "and shows the diff" is a requirement, not decoration.
    expect(stderr).toMatch(/^[-+]## Pitfall/m);
  });

  it("fails on a one-character change to the goal.md template, and shows the diff", async () => {
    // Criterion 5, half two — the template that until now was pinned by
    // nothing at all.
    const skills = await skillsCopy();
    const target = join(skills, "stride-opencode-lite-create-goal/SKILL.md");
    const source = await Bun.file(target).text();
    const mutated = source.replace("\n## Tasks\n", "\n## Task\n");
    expect(mutated).not.toBe(source);
    await Bun.write(target, mutated);

    const { stderr, exitCode } = await run({ STRIDE_SMOKE_SKILLS_DIR: skills });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("FAIL  the goal.md template matches the stride-lite source hash");
    expect(stderr).toContain("FAIL  fixtures: goal.md carries the goal template's headings, in order");
    expect(stderr).toMatch(/^[-+]## Task/m);
  });

  it("SKIPS the stride-lite cross-check when stride-lite is absent, never passes it", async () => {
    // stride-lite is gitignored and absent for any consumer, so the
    // cross-check must degrade to a stated skip rather than a pass or a
    // failure. A skip credited as a pass is its own vacuity vector.
    const { stdout, exitCode } = await run({ STRIDE_LITE_ROOT: "/nonexistent/stride-lite" });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("SKIP  stride-lite cross-check");
    expect(stdout).not.toContain("PASS  taskN template matches stride-lite's copy on disk");
    expect(stdout).toMatch(/\d+ skipped/);
  });
});
