/**
 * .stride_lite.md hook executor
 *
 * Runs a section's commands one at a time, stopping at the first failure, and
 * returns the structured result stride-lite's bash script emits.
 *
 * The key sets below are normative: they mirror the two `printf` calls in
 * `stride-lite/hooks/stride-lite-hook.sh` exactly, field for field and in the
 * same order, so a user comparing a failure across the two implementations sees
 * the same JSON. Both result types are closed object types rather than one
 * interface with optional fields, which makes adding a key the bash script does
 * not emit a compile error rather than a review finding.
 *
 * Security: commands run exactly as written. Nothing derived from a task, goal,
 * or any other plugin-supplied value is interpolated into a command, so no
 * crafted title can become executable text. A command that outruns its budget
 * has its whole process group terminated rather than abandoned, and captured
 * output is bounded before it reaches the result.
 */

import type { HookName } from "./parser";
import { isBlockingHook } from "./parser";

/** Lines of stdout/stderr retained on the failure path (bash uses `tail -50`). */
export const TAIL_LINES = 50;

/** Exit code reported for a command terminated by its timeout. */
export const TIMEOUT_EXIT_CODE = 124;

/** Grace period between SIGTERM and SIGKILL when terminating a process group. */
export const DEFAULT_KILL_GRACE_MS = 2000;

/**
 * Successful run — the 4 keys, in the order bash prints them.
 *
 * Note there is no `commands_output`: the bash implementation streams a
 * succeeding command's output straight to stderr and captures nothing.
 */
export interface HookSuccessResult {
  hook: HookName;
  status: "success";
  commands_completed: string[];
  duration_seconds: number;
}

/** Failed run — the 9 keys, in the order bash prints them. */
export interface HookFailureResult {
  hook: HookName;
  status: "failed";
  failed_command: string;
  command_index: number;
  exit_code: number;
  stdout: string;
  stderr: string;
  commands_completed: string[];
  commands_remaining: string[];
}

export type HookResult = HookSuccessResult | HookFailureResult;

export interface ExecuteHookOptions {
  /** Working directory for each command. */
  cwd?: string;
  /** Per-command budget in milliseconds. `Infinity` disables the timer. */
  timeoutMs?: number;
  /** Delay between SIGTERM and SIGKILL when a budget is exceeded. */
  killGraceMs?: number;
  /** Receives output as it arrives, mirroring bash streaming to stderr. */
  onOutput?: (chunk: string) => void;
  /** Injectable clock, in milliseconds, for deterministic duration tests. */
  now?: () => number;
}

/**
 * Keep only the last `TAIL_LINES` lines, matching `$(tail -50 file)`.
 *
 * Command substitution strips trailing newlines, so this does too — otherwise a
 * trailing blank line would count against the budget and the captured text
 * would differ from bash's for identical output.
 */
export function tailLines(text: string, maxLines: number = TAIL_LINES): string {
  const withoutTrailingNewlines = text.replace(/\n+$/, "");
  if (withoutTrailingNewlines === "") return "";

  const lines = withoutTrailingNewlines.split("\n");
  return lines.slice(-maxLines).join("\n");
}

/**
 * Bounded sink for a command's output.
 *
 * Retains only the trailing lines rather than accumulating the whole stream, so
 * a runaway command cannot grow the result object without limit however long it
 * runs.
 */
function createTailSink(maxLines: number, onOutput?: (chunk: string) => void) {
  let buffer = "";

  return {
    write(chunk: string): void {
      onOutput?.(chunk);
      buffer += chunk;

      // Trim eagerly so memory stays bounded mid-stream, not just at the end.
      // One extra line of slack avoids re-trimming on every single write.
      const lines = buffer.split("\n");
      if (lines.length > maxLines + 1) {
        buffer = lines.slice(-(maxLines + 1)).join("\n");
      }
    },
    value(): string {
      return tailLines(buffer, maxLines);
    },
  };
}

/**
 * Terminate a whole process group: SIGTERM, a grace period, then SIGKILL.
 *
 * Signalling the negative pid reaches the group rather than only the direct
 * child, so a command that spawned its own children does not leave them running
 * after the hook has moved on. Extracted so the escalation is testable without
 * needing a process that ignores SIGTERM.
 */
export async function killProcessGroup(
  pid: number,
  graceMs: number = DEFAULT_KILL_GRACE_MS,
): Promise<void> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Already gone — nothing to escalate to.
    return;
  }

  await Bun.sleep(graceMs);

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Exited during the grace period, which is the intended outcome.
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array> | null,
  sink: { write(chunk: string): void },
): Promise<void> {
  if (!stream) return;

  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    sink.write(decoder.decode(chunk, { stream: true }));
  }
  const rest = decoder.decode();
  if (rest) sink.write(rest);
}

/**
 * Execute a section's commands one at a time, stopping at the first failure.
 *
 * Returns `null` when there is nothing to run. That is the absence of a result,
 * not a result with its own status: the bash implementation prints no JSON at
 * all for a missing file, a missing section, or a block that is empty after
 * filtering, and inventing a third status here would put a line on the wire
 * that bash never writes.
 *
 * Each command runs in its own shell, so `cd` and `export` do not persist
 * across commands — a deliberate consequence of running them one at a time
 * rather than `eval`ing the list as a single script, which is what makes the
 * command index and the completed/remaining partition meaningful.
 *
 * @returns The structured result, or `null` when the command list is empty
 */
export async function executeHookCommands(
  hookName: HookName,
  commands: string[],
  options: ExecuteHookOptions = {},
): Promise<HookResult | null> {
  if (commands.length === 0) return null;

  const {
    cwd,
    timeoutMs = Infinity,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    onOutput,
    now = () => Date.now(),
  } = options;

  const startedAt = now();
  const completed: string[] = [];

  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!;
    const stdoutSink = createTailSink(TAIL_LINES, onOutput);
    const stderrSink = createTailSink(TAIL_LINES, onOutput);

    let exitCode: number;
    let timedOut = false;

    try {
      // The command is passed to the shell verbatim. Nothing is interpolated
      // into it, so it means precisely what the user wrote in their file.
      const proc = Bun.spawn(["sh", "-c", command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        // Its own process group, so a timeout can reach descendants too.
        detached: true,
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          timedOut = true;
          void killProcessGroup(proc.pid, killGraceMs);
        }, timeoutMs);
      }

      try {
        const [status] = await Promise.all([
          proc.exited,
          readStream(proc.stdout as ReadableStream<Uint8Array>, stdoutSink),
          readStream(proc.stderr as ReadableStream<Uint8Array>, stderrSink),
        ]);
        exitCode = status;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (error) {
      // The shell could not be started at all (an unusable cwd, for instance).
      // That is a failure of this command, reported through the same shape.
      exitCode = 127;
      stderrSink.write(String(error));
      timedOut = false;
    }

    if (timedOut) {
      // `exit_code` is the only channel available for this: the bash contract
      // has no timeout field, and 124 is what a shell's own `timeout` reports,
      // so it is already reachable within that contract rather than invented.
      exitCode = TIMEOUT_EXIT_CODE;
      stderrSink.write(
        `\nstride-lite: command timed out after ${timeoutMs}ms and its process group was terminated\n`,
      );
    }

    if (exitCode === 0) {
      completed.push(command);
      continue;
    }

    return {
      hook: hookName,
      status: "failed",
      failed_command: command,
      command_index: index,
      exit_code: exitCode,
      stdout: stdoutSink.value(),
      stderr: stderrSink.value(),
      commands_completed: [...completed],
      // Everything after the failed command. The failed one appears in
      // `failed_command` and belongs to neither array.
      commands_remaining: commands.slice(index + 1),
    };
  }

  return {
    hook: hookName,
    status: "success",
    commands_completed: completed,
    duration_seconds: Math.floor((now() - startedAt) / 1000),
  };
}

/**
 * The exit code a caller should use for this section's result.
 *
 * Mirrors the bash script's outer flow: a blocking section propagates its
 * failure, and every other outcome exits cleanly. This is where `after_goal`'s
 * advisory contract is enforced — its failure is reported in the result but
 * never becomes a blocking outcome.
 */
export function hookExitCode(
  hookName: HookName,
  result: HookResult | null,
): 0 | 2 {
  if (result === null || result.status === "success") return 0;
  return isBlockingHook(hookName) ? 2 : 0;
}
