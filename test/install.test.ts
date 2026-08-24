import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Integration tests for install.sh and install.ps1.
 *
 * SAFETY RULE, and the reason every case looks the way it does: each run gets a
 * fresh `cwd` AND a fresh `HOME`, both from mkdtemp. No installer bug can then
 * write into the developer's real ~/.config/opencode. The global-mode case
 * asserts the temp home was actually used BEFORE asserting anything about the
 * payload — without that guard the test would pass while having installed to
 * the real home, which is the vacuity that matters most here.
 *
 * cwd and HOME are the seams deliberately, rather than an env-var target
 * override: they are the real resolution inputs, so overriding them exercises
 * the resolution code instead of bypassing the line most likely to be wrong.
 */

const repoRoot = new URL("..", import.meta.url).pathname;
const scratch: string[] = [];
const pwshPresent = ["/opt/homebrew/bin/pwsh", "/usr/local/bin/pwsh", "/usr/bin/pwsh"].some(existsSync);

afterAll(async () => {
  await Promise.all(scratch.map((d) => rm(d, { recursive: true, force: true })));
});

const tmp = async (label: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), `stride-install-${label}-`));
  scratch.push(dir);
  return dir;
};

/** A copy of the installable surface, so a mutation never touches the tree. */
const stagedSource = async (): Promise<string> => {
  const dir = await tmp("src");
  for (const entry of ["install.sh", "install.ps1", "package.json"]) {
    await cp(join(repoRoot, entry), join(dir, entry));
  }
  for (const entry of ["skills", "agents", "commands", "lib"]) {
    await cp(join(repoRoot, entry), join(dir, entry), { recursive: true });
  }
  return dir;
};

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  cwd: string;
  home: string;
}

const run = async (
  src: string,
  opts: { args?: string[]; cwd?: string; home?: string; ps?: boolean } = {},
): Promise<RunResult> => {
  const cwd = opts.cwd ?? (await tmp("proj"));
  const home = opts.home ?? (await tmp("home"));
  const cmd = opts.ps
    ? ["pwsh", "-NoProfile", "-File", join(src, "install.ps1"), ...(opts.args ?? [])]
    : ["bash", join(src, "install.sh"), ...(opts.args ?? [])];

  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited, cwd, home };
};

/** Every relative path under a destination root, sorted. */
const installedPaths = async (root: string): Promise<string[]> => {
  const walk = async (dir: string, prefix = ""): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)));
      else out.push(rel);
    }
    return out;
  };
  return (await walk(root)).sort();
};

const sameBytes = async (a: string, b: string): Promise<boolean> =>
  Buffer.compare(await readFile(a), await readFile(b)) === 0;

describe("install.sh", () => {
  it("installs project-local, byte-identically, and verifies what landed", async () => {
    const src = await stagedSource();
    const { stdout, exitCode, cwd } = await run(src);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Verified \d+ of \d+ files/);

    const dest = join(cwd, ".opencode");
    const paths = await installedPaths(dest);
    // Enumerated from the source, not hardcoded — a literal list here would go
    // stale exactly as a literal list in the installer would. `.gitkeep`
    // placeholders are deliberately not installed: they exist to keep empty
    // directories in git and have no runtime role.
    const wanted = (await installedPaths(src)).filter(
      (p) => /^(skills|agents|commands|lib)\//.test(p) && p.endsWith(".md"),
    );
    expect(paths).toEqual(wanted.sort());

    for (const rel of paths) {
      expect(await sameBytes(join(src, rel), join(dest, rel))).toBe(true);
    }
    // Test corpus and plugin source are deliberately not installed.
    expect(existsSync(join(dest, "fixtures"))).toBe(false);
    expect(existsSync(join(dest, "src"))).toBe(false);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(false);
  });

  it("installs global into the given HOME, and nowhere else", async () => {
    const src = await stagedSource();
    const { exitCode, cwd, home } = await run(src, { args: ["--global"] });

    expect(exitCode).toBe(0);
    // FIRST: prove the temp HOME was honoured. If it were not, every assertion
    // below would pass while the files sat in the developer's real home.
    expect(existsSync(join(home, ".config/opencode"))).toBe(true);
    expect((await installedPaths(join(home, ".config/opencode"))).length).toBeGreaterThan(0);
    expect(existsSync(join(cwd, ".opencode"))).toBe(false);
  });

  it("refuses to clobber without --force, and copies nothing when it refuses", async () => {
    const src = await stagedSource();
    const first = await run(src);
    expect(first.exitCode).toBe(0);

    const dest = join(first.cwd, ".opencode");
    const edited = join(dest, "lib/slugify.md");
    await writeFile(edited, (await readFile(edited, "utf8")) + "\nUSER EDIT\n");
    // Delete a DIFFERENT installed file. If the refusal happened mid-copy, this
    // one would be restored — which is the partial install the refusal exists
    // to prevent.
    await rm(join(dest, "agents/task-reviewer.md"));

    const second = await run(src, { cwd: first.cwd, home: first.home });

    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain("refusing to overwrite");
    expect(second.stderr).toContain("lib/slugify.md");
    expect(await readFile(edited, "utf8")).toContain("USER EDIT");
    expect(existsSync(join(dest, "agents/task-reviewer.md"))).toBe(false);
  });

  it("--force overwrites and purges stale files inside a skill", async () => {
    const src = await stagedSource();
    const first = await run(src);
    const dest = join(first.cwd, ".opencode");
    const edited = join(dest, "lib/slugify.md");
    await writeFile(edited, "clobbered\n");
    const stale = join(dest, "skills/stride-opencode-lite-init/STALE.md");
    await writeFile(stale, "stale\n");

    const second = await run(src, { args: ["--force"], cwd: first.cwd, home: first.home });

    expect(second.exitCode).toBe(0);
    expect(await sameBytes(join(src, "lib/slugify.md"), edited)).toBe(true);
    // A file dropped from a skill in a later release must not survive.
    expect(existsSync(stale)).toBe(false);
  });

  it("fails when a source file is missing, naming it", async () => {
    // The source must be a git checkout for this to be detectable at all: the
    // manifest is enumerated FROM the source, so an absent file is simply never
    // enumerated. git still tracks it, which is the independent record.
    const src = await tmp("gitsrc");
    const clone = Bun.spawnSync(["git", "clone", "--quiet", repoRoot, src]);
    expect(clone.exitCode).toBe(0);
    await cp(join(repoRoot, "install.sh"), join(src, "install.sh"));
    await rm(join(src, "agents/task-reviewer.md"));

    const { stdout, stderr, exitCode } = await run(src);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("INSTALL IS INCOMPLETE");
    expect(stderr).toContain("agents/task-reviewer.md");
    expect(stdout).not.toContain("Verified");
  });

  it("fails when a source file is empty, blaming the source and not the copy", async () => {
    // Distinct from missing: proves the check is not existence-only. And the
    // heading matters — the copy was byte-perfect here, so reporting it under
    // "Corrupt after copy" would send the reader to the wrong file.
    const src = await stagedSource();
    await writeFile(join(src, "lib/slugify.md"), "");

    const { stderr, exitCode } = await run(src);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("INSTALL IS INCOMPLETE");
    expect(stderr).toContain("Empty in the source:");
    expect(stderr).toContain("lib/slugify.md (empty)");
    expect(stderr).not.toContain("Corrupt after copy:");
  });

  it("fails when a decisive skill did not land", async () => {
    const src = await stagedSource();
    await rm(join(src, "skills/stride-opencode-lite-workflow"), { recursive: true });

    const { stderr, exitCode } = await run(src);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("skills/stride-opencode-lite-workflow/SKILL.md did not land");
  });

  it("says so when the source is not a git checkout, rather than implying completeness", async () => {
    const src = await stagedSource();
    const { stdout, exitCode } = await run(src);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("not a git checkout");
  });

  it("warns when the plugin is not registered, and not when it is", async () => {
    // The other half of the two-step trap: artifacts on disk with no plugin
    // registration means no hook section ever fires.
    const src = await stagedSource();
    const without = await run(src);
    expect(without.exitCode).toBe(0);
    expect(without.stderr).toContain("no opencode.json I can");

    const cwd = await tmp("registered");
    await writeFile(
      join(cwd, "opencode.json"),
      JSON.stringify({ plugin: ["github:cheezy/stride-opencode-lite"] }),
    );
    const withCfg = await run(src, { cwd });
    expect(withCfg.exitCode).toBe(0);
    expect(withCfg.stderr).not.toContain("no opencode.json I can");
  });

  it("prints usage for --help and rejects an unknown flag", async () => {
    const src = await stagedSource();

    const help = await run(src, { args: ["--help"] });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--global");
    expect(help.stdout).toContain("--force");
    expect(help.stdout).toContain("STEP 2");

    // A mistyped flag must not install anyway and report success.
    const bad = await run(src, { args: ["--forse"] });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain("unknown argument");
  });

  it("handles a target path containing spaces", async () => {
    // Named as an edge case by the task. Quoting bugs in a shell installer are
    // the classic way this breaks, and they break silently-ish.
    const src = await stagedSource();
    const parent = await tmp("spaces");
    const cwd = join(parent, "my project dir");
    await mkdir(cwd, { recursive: true });

    const { stdout, exitCode } = await run(src, { cwd });

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Verified \d+ of \d+ files/);
    expect((await installedPaths(join(cwd, ".opencode"))).length).toBeGreaterThan(0);
  });

  it("leaves another plugin's skills and agents alone", async () => {
    // Named as an edge case by the task. .opencode/ is shared ground: a user
    // with any other plugin installed already has these directories.
    const src = await stagedSource();
    const cwd = await tmp("shared");
    await mkdir(join(cwd, ".opencode/skills/some-other-plugin"), { recursive: true });
    await mkdir(join(cwd, ".opencode/agents"), { recursive: true });
    await writeFile(join(cwd, ".opencode/skills/some-other-plugin/SKILL.md"), "other\n");
    await writeFile(join(cwd, ".opencode/agents/unrelated.md"), "other\n");

    const { exitCode } = await run(src, { cwd });

    expect(exitCode).toBe(0);
    // Untouched, and — because the refusal is per path — not even a collision.
    expect(await readFile(join(cwd, ".opencode/skills/some-other-plugin/SKILL.md"), "utf8")).toBe("other\n");
    expect(await readFile(join(cwd, ".opencode/agents/unrelated.md"), "utf8")).toBe("other\n");
  });

  it("installs an untracked new skill rather than rejecting it", async () => {
    // The git cross-check asks "is anything TRACKED but absent from the tree?",
    // never "is everything in the tree tracked". A contributor adding a skill
    // that is not committed yet must not be blocked from installing it.
    const src = await tmp("gitsrc-untracked");
    expect(Bun.spawnSync(["git", "clone", "--quiet", repoRoot, src]).exitCode).toBe(0);
    await cp(join(repoRoot, "install.sh"), join(src, "install.sh"));
    await mkdir(join(src, "skills/stride-opencode-lite-brand-new"), { recursive: true });
    await writeFile(join(src, "skills/stride-opencode-lite-brand-new/SKILL.md"), "# new\n");

    const { stdout, exitCode, cwd } = await run(src);

    expect(exitCode).toBe(0);
    expect(existsSync(join(cwd, ".opencode/skills/stride-opencode-lite-brand-new/SKILL.md"))).toBe(true);
    // Derived, not hardcoded: the assertion that matters is "the untracked
    // skill was counted", not "the number is 5". A literal would break the day
    // a fifth real skill lands, for reasons unrelated to this test.
    const skillCount = (await readdir(join(src, "skills"), { withFileTypes: true })).filter((e) =>
      e.isDirectory(),
    ).length;
    expect(stdout).toMatch(new RegExp(`Skills:\\s+${skillCount}`));
  });

  it("refuses to install when a skill holds a file the manifest cannot match", async () => {
    // One predicate governs the preflight, the copy AND the verification, so
    // anything it does not match is neither installed nor reported — "broken
    // but green", strictly worse than the "installed but unverified" it
    // replaced. Nothing trips this today; the guard is what keeps that true.
    const src = await stagedSource();
    await writeFile(join(src, "skills/stride-opencode-lite-workflow/template.txt"), "x\n");

    const { stderr, exitCode } = await run(src);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("are inside a skill but are not .md");
    expect(stderr).toContain("template.txt");
  });

  it("installs a nested .md inside a skill", async () => {
    // The manifest is `find skills -mindepth 1 -type f -name '*.md'`, so depth
    // is not the limit — the extension is. Pinned so the guard above is
    // understood as narrow rather than as "skills are flat".
    const src = await stagedSource();
    await mkdir(join(src, "skills/stride-opencode-lite-workflow/refs"), { recursive: true });
    await writeFile(join(src, "skills/stride-opencode-lite-workflow/refs/deep.md"), "# deep\n");

    const { exitCode, cwd } = await run(src);

    expect(exitCode).toBe(0);
    expect(existsSync(join(cwd, ".opencode/skills/stride-opencode-lite-workflow/refs/deep.md"))).toBe(true);
  });

  it("is idempotent under --force", async () => {
    const src = await stagedSource();
    const first = await run(src);
    const second = await run(src, { args: ["--force"], cwd: first.cwd, home: first.home });

    expect(second.exitCode).toBe(0);
    const dest = join(first.cwd, ".opencode");
    for (const rel of await installedPaths(dest)) {
      expect(await sameBytes(join(src, rel), join(dest, rel))).toBe(true);
    }
  });
});

// pwsh start-up is ~1.5s per invocation and some cases spawn it three times,
// which overruns bun's 5s default. Raised deliberately rather than by trimming
// the cases: the multi-invocation ones are the clobber/force sequences, which
// are the point.
const PWSH_TIMEOUT_MS = 30_000;

describe.skipIf(!pwshPresent)("install.ps1 under pwsh", () => {
  it("installs the identical path set that install.sh does", async () => {
    // The assertion that stops install.ps1 rotting. Without it the PowerShell
    // script is shipped, never run, and free to diverge silently.
    const src = await stagedSource();
    const sh = await run(src);
    const ps = await run(src, { ps: true });

    expect(sh.exitCode).toBe(0);
    expect(ps.exitCode).toBe(0);
    expect(await installedPaths(join(ps.cwd, ".opencode"))).toEqual(
      await installedPaths(join(sh.cwd, ".opencode")),
    );
  }, PWSH_TIMEOUT_MS);

  it("copies byte-identically", async () => {
    const src = await stagedSource();
    const { cwd, exitCode } = await run(src, { ps: true });

    expect(exitCode).toBe(0);
    const dest = join(cwd, ".opencode");
    for (const rel of await installedPaths(dest)) {
      expect(await sameBytes(join(src, rel), join(dest, rel))).toBe(true);
    }
  }, PWSH_TIMEOUT_MS);

  it("refuses to clobber without -Force, and -Force overwrites", async () => {
    const src = await stagedSource();
    const first = await run(src, { ps: true });
    const edited = join(first.cwd, ".opencode/lib/slugify.md");
    await writeFile(edited, "clobbered\n");

    const refused = await run(src, { ps: true, cwd: first.cwd, home: first.home });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("refusing to overwrite");
    expect(await readFile(edited, "utf8")).toBe("clobbered\n");

    const forced = await run(src, { ps: true, args: ["-Force"], cwd: first.cwd, home: first.home });
    expect(forced.exitCode).toBe(0);
    expect(await sameBytes(join(src, "lib/slugify.md"), edited)).toBe(true);
  }, PWSH_TIMEOUT_MS);

  it("fails verification on an empty source file, with the same attribution", async () => {
    const src = await stagedSource();
    await writeFile(join(src, "lib/slugify.md"), "");

    const { stderr, exitCode } = await run(src, { ps: true });

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("INSTALL IS INCOMPLETE");
    expect(stderr).toContain("Empty in the source:");
    expect(stderr).not.toContain("Corrupt after copy:");
  }, PWSH_TIMEOUT_MS);

  it("names itself, not install.sh, in its messages", async () => {
    // Parity of behaviour, not of the script name: printing "install.sh" at a
    // user who ran install.ps1 would be a defect dressed as consistency.
    const src = await stagedSource();
    const first = await run(src, { ps: true });
    const refused = await run(src, { ps: true, cwd: first.cwd, home: first.home });

    expect(refused.stderr).toContain("install.ps1:");
    expect(refused.stderr).not.toContain("install.sh:");
    expect(refused.stderr).toContain("-Force");
  }, PWSH_TIMEOUT_MS);

  it("prints usage for -Help", async () => {
    const src = await stagedSource();
    const { stdout, exitCode } = await run(src, { ps: true, args: ["-Help"] });

    expect(exitCode).toBe(0);
    expect(stdout).toContain("-Global");
    expect(stdout).toContain("STEP 2");
  }, PWSH_TIMEOUT_MS);
});
