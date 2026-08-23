import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_TAIL_BYTES,
  TAIL_LINES,
  TIMEOUT_EXIT_CODE,
  executeHookCommands,
  hookExitCode,
  createTailSink,
  killProcessGroup,
  tailLines,
} from "./hook-exec";
import { parseStrideLiteFile } from "./parser";

/**
 * The normative key sets, taken from the two `printf` calls in
 * stride-lite/hooks/stride-lite-hook.sh. Order matters: it pins the byte layout
 * that JSON.stringify produces, so a user diffing a failure across the bash and
 * TypeScript implementations sees the same field order.
 */
const BASH_SUCCESS_KEYS = [
  "hook",
  "status",
  "commands_completed",
  "duration_seconds",
];

const BASH_FAILURE_KEYS = [
  "hook",
  "status",
  "failed_command",
  "command_index",
  "exit_code",
  "stdout",
  "stderr",
  "commands_completed",
  "commands_remaining",
];

const scratchDirs: string[] = [];

afterAll(async () => {
  await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const scratchDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "stride-lite-exec-"));
  scratchDirs.push(dir);
  return dir;
};

describe("tailLines", () => {
  it("keeps only the last N lines", () => {
    const text = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const tail = tailLines(text, 50).split("\n");

    expect(tail).toHaveLength(50);
    expect(tail[0]).toBe("line 10");
    expect(tail.at(-1)).toBe("line 59");
  });

  it("returns short text unchanged", () => {
    expect(tailLines("a\nb", 50)).toBe("a\nb");
  });

  // Bash captures via $(tail -50 file), and command substitution strips
  // trailing newlines. Matching that keeps identical output identical.
  it("strips trailing newlines like command substitution", () => {
    expect(tailLines("a\nb\n", 50)).toBe("a\nb");
    expect(tailLines("a\n\n\n", 50)).toBe("a");
  });

  it("returns an empty string for empty or newline-only input", () => {
    expect(tailLines("", 50)).toBe("");
    expect(tailLines("\n\n", 50)).toBe("");
  });

  it("defaults to the bash bound of 50 lines", () => {
    expect(TAIL_LINES).toBe(50);
    const text = Array.from({ length: 80 }, (_, i) => `l${i}`).join("\n");
    expect(tailLines(text).split("\n")).toHaveLength(50);
  });

  it("bounds a single line with no newlines by bytes", () => {
    // A line bound alone is not a bound: newline-free output is one "line"
    // however many bytes it carries, so the byte ceiling is what binds here.
    const oneHugeLine = "x".repeat(MAX_TAIL_BYTES * 3);

    expect(tailLines(oneHugeLine).length).toBe(MAX_TAIL_BYTES);
  });

  it("keeps the trailing bytes of an over-long line, not the leading ones", () => {
    const line = "A".repeat(MAX_TAIL_BYTES) + "TAIL_MARKER";

    expect(tailLines(line).endsWith("TAIL_MARKER")).toBe(true);
  });
});

describe("createTailSink", () => {
  it("bounds retained bytes WHILE the stream arrives, not only at capture", () => {
    // value() caps its return regardless, so it cannot distinguish a buffer
    // trimmed mid-stream from one that grew to gigabytes and was cut at the
    // end. Asserting size() is what pins the memory bound — the security
    // property here is that the hook process does not grow with the stream.
    const sink = createTailSink(TAIL_LINES);

    const chunk = "x".repeat(8 * 1024); // no newlines: the line trim can never fire
    for (let i = 0; i < 400; i++) {
      sink.write(chunk);
      expect(sink.size()).toBeLessThanOrEqual(MAX_TAIL_BYTES * 2 + chunk.length);
    }

    // 400 * 8KB = 3.2MB written; retained must stay near the ceiling.
    expect(sink.size()).toBeLessThanOrEqual(MAX_TAIL_BYTES * 2 + chunk.length);
    expect(sink.value().length).toBe(MAX_TAIL_BYTES);
  });

  it("bounds retained bytes for line-shaped output too", () => {
    const sink = createTailSink(TAIL_LINES);

    for (let i = 0; i < 5000; i++) {
      sink.write(`line ${i}\n`);
    }

    expect(sink.size()).toBeLessThanOrEqual(MAX_TAIL_BYTES * 2);
    expect(sink.value().split("\n")).toHaveLength(TAIL_LINES);
  });
});

describe("executeHookCommands", () => {
  it("returns null for an empty command list", async () => {
    // Bash prints no JSON at all for a no-op, so there is no result object.
    expect(await executeHookCommands("before_task", [])).toBeNull();
  });

  it("runs every command and reports success", async () => {
    const result = await executeHookCommands("before_task", [
      "true",
      "echo hello",
      "true",
    ]);

    expect(result?.status).toBe("success");
    expect(result?.commands_completed).toEqual(["true", "echo hello", "true"]);
  });

  it("emits exactly the bash success key set, in order", async () => {
    const result = await executeHookCommands("after_task", ["true"]);

    expect(Object.keys(result!)).toEqual(BASH_SUCCESS_KEYS);
  });

  it("emits exactly the bash failure key set, in order", async () => {
    const result = await executeHookCommands("after_task", ["exit 3"]);

    expect(Object.keys(result!)).toEqual(BASH_FAILURE_KEYS);
  });

  it("never emits a timeout field, which the bash contract does not have", async () => {
    const result = await executeHookCommands("before_task", ["exit 1"]);

    expect(result).not.toHaveProperty("timed_out");
    expect(result).not.toHaveProperty("budget_ms");
    expect(result).not.toHaveProperty("duration_ms");
  });

  it("omits commands_output on success, as bash does", async () => {
    const result = await executeHookCommands("before_task", ["echo noisy"]);

    expect(result).not.toHaveProperty("commands_output");
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
  });

  it("stops at the first failure and does not run later commands", async () => {
    const dir = await scratchDir();
    const marker = join(dir, "should-not-exist");

    const result = await executeHookCommands(
      "before_task",
      ["true", "exit 1", `touch ${marker}`],
      { cwd: dir },
    );

    expect(result?.status).toBe("failed");
    expect(existsSync(marker)).toBe(false);
  });

  it("partitions completed and remaining at the failure point", async () => {
    const result = await executeHookCommands("before_task", [
      "true",
      "true",
      "exit 7",
      "echo later",
      "echo last",
    ]);

    expect(result).toMatchObject({
      status: "failed",
      failed_command: "exit 7",
      command_index: 2,
      exit_code: 7,
      commands_completed: ["true", "true"],
      commands_remaining: ["echo later", "echo last"],
    });
  });

  it("excludes the failed command from both arrays", async () => {
    const result = await executeHookCommands("before_task", ["exit 1"]);

    expect(result).toMatchObject({
      command_index: 0,
      commands_completed: [],
      commands_remaining: [],
    });
  });

  it("captures stdout and stderr of a command that writes both and fails", async () => {
    const result = await executeHookCommands("before_task", [
      "echo to-stdout; echo to-stderr >&2; exit 4",
    ]);

    expect(result).toMatchObject({ status: "failed", exit_code: 4 });
    expect((result as { stdout: string }).stdout).toContain("to-stdout");
    expect((result as { stderr: string }).stderr).toContain("to-stderr");
  });

  it("bounds captured output to the tail rather than retaining it all", async () => {
    const result = await executeHookCommands("before_task", [
      "for i in $(seq 1 500); do echo line $i; done; exit 1",
    ]);

    const stdout = (result as { stdout: string }).stdout;
    const lines = stdout.split("\n");

    expect(lines).toHaveLength(TAIL_LINES);
    expect(lines.at(-1)).toBe("line 500");
    expect(stdout).not.toContain("line 1\n");
  });

  it("bounds newline-free output, which the line bound alone cannot", async () => {
    // ~300KB in a single line with no newline anywhere. The line-count trim can
    // never fire on this, so it exercises the byte ceiling — both the trim that
    // keeps the in-process buffer bounded while the stream is still arriving,
    // and the cap on what reaches the result object.
    const result = await executeHookCommands("before_task", [
      "head -c 300000 /dev/zero | tr '\\0' 'x'; exit 1",
    ]);

    const stdout = (result as { stdout: string }).stdout;

    expect(stdout).not.toContain("\n");
    expect(stdout.length).toBeLessThanOrEqual(MAX_TAIL_BYTES);
    expect(stdout.length).toBeGreaterThan(0);
  });

  it("streams output to onOutput as it arrives", async () => {
    const chunks: string[] = [];
    await executeHookCommands("before_task", ["echo streamed"], {
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(chunks.join("")).toContain("streamed");
  });

  it("reports duration in whole seconds, as bash does", async () => {
    let clock = 10_000;
    const result = await executeHookCommands("before_task", ["true"], {
      now: () => {
        const value = clock;
        clock += 2_500;
        return value;
      },
    });

    // 2500ms elapsed truncates to 2, matching bash's integer second arithmetic.
    expect((result as { duration_seconds: number }).duration_seconds).toBe(2);
  });

  it("reports a sub-second run as zero seconds", async () => {
    const result = await executeHookCommands("before_task", ["true"]);

    expect((result as { duration_seconds: number }).duration_seconds).toBe(0);
  });

  it("reports a command that cannot be spawned as a failure", async () => {
    const result = await executeHookCommands("before_task", ["true"], {
      cwd: "/nonexistent-directory-for-stride-lite-test",
    });

    expect(result?.status).toBe("failed");
    expect(Object.keys(result!)).toEqual(BASH_FAILURE_KEYS);
  });

  it("gives each command its own shell, so cd does not persist", async () => {
    const dir = await scratchDir();
    const result = await executeHookCommands(
      "before_task",
      ["cd /", "test \"$PWD\" = \"/\""],
      { cwd: dir },
    );

    // Running one command at a time is what makes command_index and the
    // partition meaningful; the cost is that shell state does not carry over.
    expect(result?.status).toBe("failed");
  });
});

describe("timeout", () => {
  it("terminates a command that exceeds its budget and reports exit code 124", async () => {
    const startedAt = Date.now();
    const result = await executeHookCommands("before_task", ["sleep 30"], {
      timeoutMs: 150,
      killGraceMs: 50,
    });

    expect(result).toMatchObject({
      status: "failed",
      exit_code: TIMEOUT_EXIT_CODE,
      failed_command: "sleep 30",
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("explains the timeout in stderr, since no key can carry it", async () => {
    const result = await executeHookCommands("before_task", ["sleep 30"], {
      timeoutMs: 100,
      killGraceMs: 50,
    });

    expect((result as { stderr: string }).stderr).toContain("timed out");
  });

  it("keeps the bash failure key set when a command times out", async () => {
    const result = await executeHookCommands("before_task", ["sleep 30"], {
      timeoutMs: 100,
      killGraceMs: 50,
    });

    expect(Object.keys(result!)).toEqual(BASH_FAILURE_KEYS);
  });

  it("stops the remaining commands after a timeout", async () => {
    const result = await executeHookCommands(
      "before_task",
      ["sleep 30", "echo never"],
      { timeoutMs: 100, killGraceMs: 50 },
    );

    expect((result as { commands_remaining: string[] }).commands_remaining).toEqual([
      "echo never",
    ]);
  });

  it("does not time out a command that finishes inside its budget", async () => {
    const result = await executeHookCommands("before_task", ["true"], {
      timeoutMs: 10_000,
    });

    expect(result?.status).toBe("success");
  });

  it("runs without a timer when no budget is given", async () => {
    const result = await executeHookCommands("before_task", ["true"]);

    expect(result?.status).toBe("success");
  });

  it("terminates the whole process group, leaving no orphaned grandchild", async () => {
    const dir = await scratchDir();
    const pidFile = join(dir, "grandchild.pid");

    // The grandchild deliberately OUTLIVES its parent (120s vs 1s). If the
    // group signal did nothing, the parent would exit on its own after ~1s and
    // the grandchild would still be alive two minutes later — so this cannot
    // pass by simply waiting for both sleeps to end, which is how an earlier
    // version of this test could have gone green against a no-op kill.
    const startedAt = Date.now();
    await executeHookCommands(
      "before_task",
      [`sh -c 'sleep 120 & echo $! > ${pidFile}; sleep 60'`],
      { cwd: dir, timeoutMs: 300, killGraceMs: 50 },
    );

    // A wall-clock ceiling is the second discriminator: waiting out the sleeps
    // would blow straight past it.
    expect(Date.now() - startedAt).toBeLessThan(10_000);

    const pid = Number((await Bun.file(pidFile).text()).trim());
    expect(Number.isFinite(pid)).toBe(true);

    // Poll rather than assert immediately: termination is asynchronous.
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }

    expect(alive).toBe(false);
  });

  it("returns only after termination has completed, not while it is pending", async () => {
    const dir = await scratchDir();
    const pidFile = join(dir, "stubborn.pid");

    // The grandchild IGNORES SIGTERM while its parent does not, and its streams
    // are redirected so it cannot hold the inherited pipe open — otherwise
    // readStream, not the await, would be what gates the return.
    //
    // Awaitedness is asserted by TIMING rather than by liveness. With the
    // escalation awaited, the call cannot return before the budget plus the
    // full grace period; left in flight, it would return as soon as SIGTERM
    // ends the direct child, at roughly the budget alone. Liveness cannot
    // discriminate here: a killed process is briefly a zombie, and signal 0
    // succeeds against a zombie.
    const timeoutMs = 150;
    const killGraceMs = 600;

    const startedAt = Date.now();
    await executeHookCommands(
      "before_task",
      [
        `sh -c 'sh -c "trap \\"\\" TERM; sleep 120" >/dev/null 2>&1 & echo $! > ${pidFile}; sleep 60'`,
      ],
      { cwd: dir, timeoutMs, killGraceMs },
    );
    const elapsed = Date.now() - startedAt;

    // Without the await this lands near `timeoutMs`; with it, past the grace.
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs + killGraceMs - 50);
    expect(elapsed).toBeLessThan(10_000);

    const pid = Number((await Bun.file(pidFile).text()).trim());
    expect(Number.isFinite(pid)).toBe(true);

    // The orphan is gone too — polled, because reaping is asynchronous.
    let alive = true;
    for (let attempt = 0; attempt < 100 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(20);
      } catch {
        alive = false;
      }
    }

    expect(alive).toBe(false);
  });
});

describe("killProcessGroup", () => {
  it("returns quietly when the process is already gone", async () => {
    // A pid that cannot be signalled must not throw — the escalation to
    // SIGKILL has nothing left to reach.
    await expect(killProcessGroup(2_147_483_646, 10)).resolves.toBeUndefined();
  });
});

describe("hookExitCode", () => {
  it("exits zero for a null result", () => {
    expect(hookExitCode("before_task", null)).toBe(0);
    expect(hookExitCode("after_goal", null)).toBe(0);
  });

  it("exits zero for a successful blocking section", async () => {
    const result = await executeHookCommands("before_task", ["true"]);
    expect(hookExitCode("before_task", result)).toBe(0);
  });

  it("exits 2 when a blocking section fails", async () => {
    const result = await executeHookCommands("before_task", ["exit 1"]);

    expect(hookExitCode("before_task", result)).toBe(2);
    expect(hookExitCode("after_task", result)).toBe(2);
  });

  it("never blocks on an advisory after_goal failure", async () => {
    const result = await executeHookCommands("after_goal", ["exit 1"]);

    // The failure is still reported in the result; it just does not block.
    expect(result?.status).toBe("failed");
    expect(hookExitCode("after_goal", result)).toBe(0);
  });
});

describe("end to end: parse a real file and execute it", () => {
  /**
   * Wires parseStrideLiteFile into executeHookCommands against a realistic
   * three-section file. This is the seam the plugin entry point will use, and
   * neither module's own tests exercise it.
   *
   * The commands are inert: they touch marker files inside a scratch directory
   * and nothing else.
   */
  const writeConfig = async (dir: string, markers: Record<string, string>) => {
    const content = `# Stride Lite Configuration

## email

somebody@example.com

## before_task

\`\`\`bash
touch ${markers.before}
\`\`\`

## after_task

\`\`\`bash
# Available: HOOK_NAME TASK_FILE TASK_NUMBER TASK_TITLE GOAL_DIR
touch ${markers.after}
echo after_task ran
\`\`\`

## after_goal

\`\`\`bash
sh -c "exit 9"
\`\`\`
`;
    await Bun.write(join(dir, ".stride_lite.md"), content);
  };

  it("runs each section's own commands and nothing else", async () => {
    const dir = await scratchDir();
    const markers = {
      before: join(dir, "before.marker"),
      after: join(dir, "after.marker"),
    };
    await writeConfig(dir, markers);
    const configPath = join(dir, ".stride_lite.md");

    const beforeCommands = await parseStrideLiteFile(configPath, "before_task");
    const beforeResult = await executeHookCommands("before_task", beforeCommands, {
      cwd: dir,
    });

    expect(beforeResult?.status).toBe("success");
    expect(existsSync(markers.before)).toBe(true);
    // The before_task section must not have run the after_task section's work.
    expect(existsSync(markers.after)).toBe(false);

    const afterCommands = await parseStrideLiteFile(configPath, "after_task");
    // The documentation comment lines are filtered out before execution.
    expect(afterCommands).toEqual([`touch ${markers.after}`, "echo after_task ran"]);

    const afterResult = await executeHookCommands("after_task", afterCommands, {
      cwd: dir,
    });

    expect(afterResult?.status).toBe("success");
    expect(existsSync(markers.after)).toBe(true);
    expect(Object.keys(afterResult!)).toEqual(BASH_SUCCESS_KEYS);
  });

  it("carries an advisory section's failure without turning it into a block", async () => {
    const dir = await scratchDir();
    await writeConfig(dir, {
      before: join(dir, "b.marker"),
      after: join(dir, "a.marker"),
    });

    const commands = await parseStrideLiteFile(
      join(dir, ".stride_lite.md"),
      "after_goal",
    );
    const result = await executeHookCommands("after_goal", commands, { cwd: dir });

    expect(result).toMatchObject({ status: "failed", exit_code: 9 });
    expect(Object.keys(result!)).toEqual(BASH_FAILURE_KEYS);
    // Reported, but advisory — it must not block.
    expect(hookExitCode("after_goal", result)).toBe(0);
  });

  it("is a clean no-op end to end when the file is absent", async () => {
    const dir = await scratchDir();
    const missing = join(dir, ".stride_lite.md");

    const commands = await parseStrideLiteFile(missing, "before_task");
    const result = await executeHookCommands("before_task", commands, { cwd: dir });

    expect(commands).toEqual([]);
    expect(result).toBeNull();
    expect(hookExitCode("before_task", result)).toBe(0);
  });

  it("is a clean no-op end to end when the section is absent", async () => {
    const dir = await scratchDir();
    await Bun.write(
      join(dir, ".stride_lite.md"),
      "## before_task\n\n```bash\ntrue\n```\n",
    );

    const commands = await parseStrideLiteFile(
      join(dir, ".stride_lite.md"),
      "after_goal",
    );
    const result = await executeHookCommands("after_goal", commands, { cwd: dir });

    expect(commands).toEqual([]);
    expect(result).toBeNull();
  });
});

describe("cross-check against the bash implementation", () => {
  const bashScript =
    "/Users/cheezy/dev/elixir/kanban/stride-lite/hooks/stride-lite-hook.sh";
  const hasBashScript = existsSync(bashScript);

  /**
   * Source the script with an empty phase — which returns early, leaving its
   * functions defined — then call the section runner directly. This is the
   * isolation path the script's own header sanctions.
   *
   * Note the command under test must fail in a CHILD process. The script
   * `eval`s each command in its own shell, so a bare `exit 5` would terminate
   * the script itself before it could print anything.
   */
  const runBashSection = async (
    section: string,
    block: string,
  ): Promise<Record<string, unknown>> => {
    const dir = await scratchDir();
    await Bun.write(join(dir, ".stride_lite.md"), `## ${section}\n\n\`\`\`bash\n${block}\n\`\`\`\n`);

    const proc = Bun.spawn(
      [
        "bash",
        "-c",
        'source "$1" ""; run_stride_lite_section "$2"',
        "_",
        bashScript,
        section,
      ],
      {
        cwd: dir,
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const jsonLine = stdout.split("\n").find((line) => line.trim().startsWith("{"));
    // Assert rather than return quietly: a cross-check that silently passes
    // when it produced nothing is worse than no cross-check at all.
    expect(jsonLine).toBeDefined();
    return JSON.parse(jsonLine!) as Record<string, unknown>;
  };

  // The sibling repo is gitignored and absent for consumers, so this is a
  // bonus check. The hard-coded key lists above are the primary assertion.
  it.skipIf(!hasBashScript)(
    "matches the key set the real bash script emits on failure",
    async () => {
      const emitted = await runBashSection("before_task", 'sh -c "exit 5"');

      expect(Object.keys(emitted)).toEqual(BASH_FAILURE_KEYS);
      expect(emitted.exit_code).toBe(5);
      expect(emitted.command_index).toBe(0);
    },
  );

  it.skipIf(!hasBashScript)(
    "matches the key set the real bash script emits on success",
    async () => {
      const emitted = await runBashSection("after_task", "true");

      expect(Object.keys(emitted)).toEqual(BASH_SUCCESS_KEYS);
      expect(emitted.commands_completed).toEqual(["true"]);
    },
  );

  it.skipIf(!hasBashScript)(
    "agrees with this implementation field for field on the same input",
    async () => {
      const fromBash = await runBashSection("before_task", 'sh -c "exit 5"');
      const fromTypeScript = await executeHookCommands("before_task", [
        'sh -c "exit 5"',
      ]);

      expect(Object.keys(fromTypeScript!)).toEqual(Object.keys(fromBash));
      expect(fromTypeScript).toMatchObject({
        hook: fromBash.hook,
        status: fromBash.status,
        failed_command: fromBash.failed_command,
        command_index: fromBash.command_index,
        exit_code: fromBash.exit_code,
        commands_completed: fromBash.commands_completed,
        commands_remaining: fromBash.commands_remaining,
      });
    },
  );
});
