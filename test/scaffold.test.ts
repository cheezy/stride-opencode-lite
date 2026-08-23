import { describe, expect, it } from "bun:test";

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

  it("starts below the version this plugin will first ship as", async () => {
    const pkg = await readJson("package.json");

    // The scaffold predates the first shipped release (0.1.0).
    expect(pkg.version).toBe("0.0.0");
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
