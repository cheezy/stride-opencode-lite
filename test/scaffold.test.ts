import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Scaffold manifest checks.
 *
 * These assert the shape the package and compiler manifests are required to
 * have. They read the JSON through `Bun.file(...).json()` rather than importing
 * it, because tsconfig.json deliberately mirrors stride-opencode's and so does
 * not enable `resolveJsonModule` — an `import pkg from "../package.json"` would
 * fail to typecheck (TS2732).
 */

const repoRoot = new URL("..", import.meta.url).pathname;

const readJson = async (relativePath: string): Promise<Record<string, unknown>> =>
  (await Bun.file(`${repoRoot}${relativePath}`).json()) as Record<string, unknown>;

describe("package.json", () => {
  it("parses and declares the module entry point and type", async () => {
    const pkg = await readJson("package.json");

    expect(pkg.name).toBe("opencode-stride-lite");
    expect(pkg.main).toBe("src/index.ts");
    expect(pkg.module).toBe("src/index.ts");
    expect(pkg.type).toBe("module");
  });

  it("declares the test and typecheck scripts", async () => {
    const pkg = await readJson("package.json");
    const scripts = pkg.scripts as Record<string, string>;

    expect(scripts.test).toBe("bun test");
    expect(scripts.typecheck).toBe("tsc --noEmit");
  });

  it("lists skills, agents and commands in files, and excludes test files", async () => {
    const pkg = await readJson("package.json");
    const files = pkg.files as string[];

    // A github-reference install copies whatever `files` names. Omitting these
    // would ship a plugin with no surface for a consumer to pick up.
    expect(files).toContain("skills/");
    expect(files).toContain("agents/");
    expect(files).toContain("commands/");
    // lib/ ships the four helper contract specs; dropping it from the files
    // list would silently publish a plugin without them.
    expect(files).toContain("lib/");
    // The installers are Step 2 of the install; a github: reference that omits
    // them leaves the user with no way to perform it.
    expect(files).toContain("install.sh");
    expect(files).toContain("install.ps1");

    expect(files).toContain("!src/**/*.test.ts");
    expect(files).not.toContain("test/");
    expect(files.some((entry) => entry.startsWith("test/"))).toBe(false);
  });

  it("re-excludes transient artifacts from the packed directories", async () => {
    const pkg = await readJson("package.json");
    const files = pkg.files as string[];

    // A bare directory entry in `files` is recursive AND overrides .gitignore
    // — npm documents that files named by this field "cannot be excluded
    // through .npmignore or .gitignore", and a root .npmignore was verified not
    // to help under bun. Without these negations, a .env, a *.local scratch
    // file, or an activation marker coming to rest inside skills/, agents/,
    // commands/ or lib/ ships verbatim to every consumer. Those four
    // directories are exactly where the rest of the port lands content, so the
    // exclusions must be asserted rather than assumed.
    //
    // The trailing-glob form matters: "!**/.stride-opencode-lite/**" does NOT
    // match under bun, while the bare "!**/.stride-opencode-lite" does.
    for (const pattern of [
      "!**/.env",
      "!**/.env.*",
      "!**/*.local",
      "!**/.stride",
      "!**/.stride_auth.md",
      "!**/.stride-opencode-lite",
      "!**/.exploratory",
      "!**/.stride-env-cache",
      "!**/.stride-changed-files.json",
      "!**/.stride-diff-upload-state",
      "!**/*.swp",
      "!**/*.swo",
      "!**/*~",
      "!**/.idea",
      "!**/.vscode",
      "!**/*.sublime-*",
      "!**/Thumbs.db",
    ]) {
      expect(files).toContain(pattern);
    }
  });

  it("declares the plugin API as a peer dependency with no runtime dependencies", async () => {
    const pkg = await readJson("package.json");

    expect(pkg).not.toHaveProperty("dependencies");

    const peer = pkg.peerDependencies as Record<string, string>;
    expect(peer["@opencode-ai/plugin"]).toBe(">=1.0.0");

    const dev = pkg.devDependencies as Record<string, string>;
    expect(Object.keys(dev).sort()).toEqual([
      "@opencode-ai/plugin",
      "@types/bun",
      "typescript",
    ]);
  });

  it("states its version in package.json and nowhere else", async () => {
    const pkg = await readJson("package.json");

    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);

    // package.json is the single source. A version duplicated into a skill
    // body, a README badge or an installer goes stale the next release, and
    // nothing would catch it.
    const proc = Bun.spawnSync(
      ["git", "grep", "-l", "--fixed-strings", pkg.version, "--",
       "*.md", "*.ts", "*.sh", "*.ps1"],
      { cwd: repoRoot },
    );
    const files = new TextDecoder()
      .decode(proc.stdout)
      .split("\n")
      .filter(Boolean)
      // This file names the version inside the assertion that governs it.
      .filter((f) => f !== "test/scaffold.test.ts")
      // The CHANGELOG names it by definition, and the test below requires its
      // newest released heading to MATCH package.json — so it is a second
      // statement that cannot drift, rather than a duplicate that can.
      .filter((f) => f !== "CHANGELOG.md");

    expect(files).toEqual([]);
  });

  it("matches the CHANGELOG's newest released entry", async () => {
    const pkg = await readJson("package.json");
    const changelog = await Bun.file(join(repoRoot, "CHANGELOG.md")).text();

    // The first version heading that is not [Unreleased] is what shipped.
    const released = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);

    expect(released).not.toBeNull();
    expect(released![1]).toBe(pkg.version);
  });
});

describe("packing", () => {
  const scratchDirs: string[] = [];

  afterAll(async () => {
    await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * Pack a throwaway copy of this package with extra files planted in it, and
   * return the relative paths the packer says it would ship.
   *
   * The copy is essential: this asserts what `bun pm pack` actually does, not
   * what the `files` patterns look like, and it must not plant scratch files in
   * the real working tree to do so.
   */
  const packWithPlantedFiles = async (
    planted: Record<string, string>,
  ): Promise<string[]> => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-stride-lite-pack-"));
    scratchDirs.push(dir);

    await cp(join(repoRoot, "package.json"), join(dir, "package.json"));
    await cp(join(repoRoot, "README.md"), join(dir, "README.md"));
    await cp(join(repoRoot, "LICENSE"), join(dir, "LICENSE"));
    await mkdir(join(dir, "src"), { recursive: true });
    await cp(join(repoRoot, "src/index.ts"), join(dir, "src/index.ts"));

    for (const [relativePath, contents] of Object.entries(planted)) {
      const target = join(dir, relativePath);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, contents);
    }

    const packed = Bun.spawnSync({
      cmd: ["bun", "pm", "pack", "--dry-run", "--ignore-scripts"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = new TextDecoder().decode(packed.stdout);
    return output
      .split("\n")
      .map((line) => line.match(/^packed\s+\S+\s+(.+)$/)?.[1])
      .filter((path): path is string => Boolean(path));
  };

  it("never ships transient artifacts placed inside the packed directories", async () => {
    // A bare directory entry in `files` is recursive AND overrides .gitignore,
    // so these would otherwise reach every consumer. This asserts the packer's
    // real behaviour rather than the presence of the patterns, because the
    // exclusion is the mitigation for a stated security consideration and the
    // pattern form is subtle — `!**/.stride-opencode-lite/**` does not match
    // under bun, while the bare `!**/.stride-opencode-lite` does.
    const shipped = await packWithPlantedFiles({
      "lib/.env": "SECRET=leak\n",
      "lib/.env.local": "SECRET=leak\n",
      "lib/scratch.local": "scratch\n",
      "agents/.stride_auth.md": "token\n",
      "skills/.stride-opencode-lite/marker": "marker\n",
      "skills/.stride/marker": "marker\n",
      "commands/.exploratory/session": "notes\n",
      "lib/.stride-env-cache": "cache\n",
      // Legitimate content, of several types, must still ship.
      "skills/real.md": "content\n",
      "skills/nested/deep/SKILL.md": "content\n",
      "lib/helper.sh": "content\n",
      "agents/data.json": "{}\n",
    });

    for (const leaked of [
      "lib/.env",
      "lib/.env.local",
      "lib/scratch.local",
      "agents/.stride_auth.md",
      "skills/.stride-opencode-lite/marker",
      "skills/.stride/marker",
      "commands/.exploratory/session",
      "lib/.stride-env-cache",
    ]) {
      expect(shipped).not.toContain(leaked);
    }

    // The negations must not have cost us the directories' actual contents.
    for (const kept of [
      "skills/real.md",
      "skills/nested/deep/SKILL.md",
      "lib/helper.sh",
      "agents/data.json",
    ]) {
      expect(shipped).toContain(kept);
    }
  });

  it("ships the plugin surface directories and excludes the test tree", async () => {
    const shipped = await packWithPlantedFiles({
      "skills/a.md": "x\n",
      "agents/b.md": "x\n",
      "commands/c.md": "x\n",
      "lib/d.md": "x\n",
      "test/example.test.ts": "x\n",
      "fixtures/sample.json": "{}\n",
      "src/helper.test.ts": "x\n",
    });

    expect(shipped).toContain("skills/a.md");
    expect(shipped).toContain("agents/b.md");
    expect(shipped).toContain("commands/c.md");
    expect(shipped).toContain("lib/d.md");
    expect(shipped).toContain("src/index.ts");

    expect(shipped).not.toContain("test/example.test.ts");
    expect(shipped).not.toContain("fixtures/sample.json");
    expect(shipped).not.toContain("src/helper.test.ts");
  });
});

describe("tsconfig.json", () => {
  it("parses and its options match stride-opencode's", async () => {
    const tsconfig = await readJson("tsconfig.json");
    const options = tsconfig.compilerOptions as Record<string, unknown>;

    expect(options.target).toBe("ESNext");
    expect(options.module).toBe("ESNext");
    expect(options.moduleResolution).toBe("bundler");
    expect(options.types).toEqual(["bun-types"]);
    expect(options.strict).toBe(true);
    expect(options.esModuleInterop).toBe(true);
    expect(options.skipLibCheck).toBe(true);
    expect(options.forceConsistentCasingInFileNames).toBe(true);
    expect(options.outDir).toBe("dist");
    expect(options.rootDir).toBe(".");
    expect(options.declaration).toBe(true);
    expect(options.declarationMap).toBe(true);
    expect(options.sourceMap).toBe(true);

    expect(tsconfig.include).toEqual(["src/**/*.ts", "test/**/*.ts"]);
    expect(tsconfig.exclude).toEqual(["node_modules", "dist"]);
  });
});
