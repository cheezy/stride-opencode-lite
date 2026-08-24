import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Executable checks for `lib/load_requirements_dir.md`'s containment control.
 *
 * The helpers in `lib/` are markdown SPECS, not code, and this repository
 * deliberately does not reimplement them — doing so would fork the contract
 * from stride-lite's. So this does not reimplement anything: it EXTRACTS the
 * spec's own normative bash reference implementation and runs it.
 *
 * It exists because the containment check is the one part of that spec this
 * port owns rather than inherits. stride-lite's version claimed containment it
 * did not provide; this port enforces it, which makes it a security control of
 * ours, and an uncommitted shell fixture is not where a security control should
 * be pinned. It is also the file the byte-identity check cannot cover, precisely
 * because it diverges on purpose.
 */

const repoRoot = new URL("..", import.meta.url).pathname;

const scratchDirs: string[] = [];

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Pull the bash function out of the spec's fenced reference implementation. */
const referenceImplementation = async (): Promise<string> => {
  const spec = await Bun.file(join(repoRoot, "lib/load_requirements_dir.md")).text();
  const match = spec.match(/^load_requirements_dir\(\) \{[\s\S]*?^\}$/m);

  expect(match).not.toBeNull();
  return match![0];
};

const runHelper = async (
  dir: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const fn = await referenceImplementation();
  const proc = Bun.spawn(["bash", "-c", `${fn}\nload_requirements_dir "$1"`, "_", dir], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { stdout, stderr, exitCode: await proc.exited };
};

const fixture = async (): Promise<{ reqs: string; outside: string }> => {
  const root = await mkdtemp(join(tmpdir(), "stride-lite-reqs-"));
  scratchDirs.push(root);

  const reqs = join(root, "reqs");
  const outside = join(root, "outside");
  await mkdir(reqs, { recursive: true });
  await mkdir(join(outside, "deep"), { recursive: true });

  await writeFile(join(reqs, "a.md"), "INSIDE_CONTENT\n");
  await writeFile(join(outside, "deep", "leak.md"), "SECRET_CONTENT\n");

  return { reqs, outside };
};

describe("load_requirements_dir containment", () => {
  it("reads real files inside the directory", async () => {
    const { reqs } = await fixture();
    const { stdout, exitCode } = await runHelper(reqs);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("=== a.md ===");
    expect(stdout).toContain("INSIDE_CONTENT");
  });

  it("still follows a symlink that points INSIDE the directory", async () => {
    // The containment control must not cost the behaviour the spec intends.
    const { reqs } = await fixture();
    await symlink("./a.md", join(reqs, "inside-link.md"));

    const { stdout } = await runHelper(reqs);

    expect(stdout).toContain("=== inside-link.md ===");
  });

  it("skips a symlinked FILE pointing outside, and never emits its contents", async () => {
    const { reqs, outside } = await fixture();
    await symlink(join(outside, "deep", "leak.md"), join(reqs, "linkfile.md"));

    const { stdout, stderr } = await runHelper(reqs);

    expect(stdout).not.toContain("SECRET_CONTENT");
    expect(stderr).toContain("skipping (outside dir): linkfile.md");
  });

  it("skips a symlinked DIRECTORY pointing outside", async () => {
    // `find -L` descends into symlinked directories to arbitrary depth, which
    // is exactly the claim stride-lite's spec got wrong.
    const { reqs, outside } = await fixture();
    await symlink(join(outside, "deep"), join(reqs, "linkdir"));

    const { stdout, stderr } = await runHelper(reqs);

    expect(stdout).not.toContain("SECRET_CONTENT");
    expect(stderr).toContain("outside dir");
  });

  it("FAILS CLOSED on a symlink chain longer than the hop cap", async () => {
    // The cap must skip an unresolved chain rather than measure it: a
    // partially-resolved path can still sit inside the directory while the
    // kernel follows the remaining hops out of it. An earlier version of this
    // control failed open exactly here.
    const { reqs, outside } = await fixture();

    // The chain must stay INSIDE the directory for longer than the cap and
    // only then leave it. That is what makes the cap the thing under test: at
    // the cap the partially-resolved path is still inside, so a fail-open
    // implementation passes containment and lets `cat` follow the rest out.
    // A chain that leaves immediately would be caught by containment on its
    // first hop and would never exercise the cap at all.
    //
    // The hops are dotfiles so `find`'s hidden-file rule leaves only the entry
    // point enumerated. 10 hops is above the spec's 8-hop cap and well below
    // SYMLOOP_MAX (32 on macOS, ~40 on Linux), so the OS resolves the chain
    // happily and only this cap stops it.
    let previous = join(outside, "deep", "leak.md");
    for (let i = 0; i < 10; i++) {
      const next = join(reqs, `.hop-${i}`);
      await symlink(previous, next);
      previous = next;
    }
    await symlink(previous, join(reqs, "chain.md"));

    const { stdout, stderr } = await runHelper(reqs);

    expect(stdout).not.toContain("SECRET_CONTENT");
    // Assert the CAP is what stopped it. Without this the test degrades into a
    // duplicate of the containment test the moment the cap stops being
    // exceeded: once the chain fully resolves, containment alone keeps the
    // secret out and the test stays green under any cap value.
    expect(stderr).toContain("unresolved symlink chain");
  });

  it("never emits content for any out-of-scope link, whatever the shape", async () => {
    const { reqs, outside } = await fixture();
    await symlink(join(outside, "deep", "leak.md"), join(reqs, "linkfile.md"));
    await symlink(join(outside, "deep"), join(reqs, "linkdir"));
    await symlink("./a.md", join(reqs, "inside-link.md"));

    const { stdout, exitCode } = await runHelper(reqs);

    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("SECRET_CONTENT");
    // The legitimate content is all still there.
    expect(stdout).toContain("=== a.md ===");
    expect(stdout).toContain("=== inside-link.md ===");
  });

  it("logs rather than silently returning when the directory cannot be resolved", async () => {
    // Must reach the resolution branch, not the pre-existing missing-directory
    // branch: a non-existent path is caught by `[ ! -d ]` and logs a different
    // message, so pointing at one tests nothing new. A directory that EXISTS
    // but cannot be entered is what makes `cd` fail.
    const { reqs } = await fixture();
    const unreadable = join(reqs, "locked");
    await mkdir(unreadable);
    await chmod(unreadable, 0o000);

    try {
      const { stderr, exitCode } = await runHelper(unreadable);

      expect(exitCode).toBe(0);
      expect(stderr).toContain("cannot resolve directory");
    } finally {
      // Restore before teardown, or the scratch cleanup cannot remove it.
      await chmod(unreadable, 0o755);
    }
  });

  it("still logs the distinct missing-directory message for a path that is absent", async () => {
    const { stderr, exitCode } = await runHelper(join(tmpdir(), "definitely-not-here-12345"));

    expect(exitCode).toBe(0);
    expect(stderr).toContain("directory not found");
  });
});
