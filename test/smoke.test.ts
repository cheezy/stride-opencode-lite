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
      "workflow: no activation-marker instruction survives",
      "workflow: the terminal-move carve-out is granted and scoped",
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
