/**
 * stride-opencode-lite — OpenCode plugin entry point.
 *
 * Wires the three `.stride_lite.md` sections to OpenCode tool events:
 *
 * | Section      | Event               | Trigger                                                        | Blocking |
 * |--------------|---------------------|----------------------------------------------------------------|----------|
 * | before_task  | tool.execute.before | tool `skill`, skill name `stride-opencode-lite-task-explorer`    | yes      |
 * | after_task   | tool.execute.before | tool `skill`, skill name `stride-opencode-lite-task-reviewer`    | yes      |
 * | after_goal   | tool.execute.after  | tool `edit`/`write`, basename `goal.md`, body has the heading    | no       |
 *
 * The two blocking sections live in `tool.execute.before` because that is the
 * only phase where throwing aborts the tool call; `tool.execute.after` fires
 * after execution and can never roll one back, which is exactly why the
 * advisory section lives there.
 *
 * This plugin performs no API detection, keeps no environment cache, and reads
 * no credential or auth file. It reads one file — the project's
 * `.stride_lite.md` — and runs the commands the user wrote in it.
 */

import { basename } from "node:path";

import { parseStrideLiteFile, type HookName } from "./parser";
import { executeHookCommands, hookExitCode, type HookResult } from "./hook-exec";

/** The config file this plugin reads. */
export const CONFIG_FILENAME = ".stride_lite.md";

/**
 * Skill identifiers that mark the two blocking lifecycle points.
 *
 * These are the OpenCode counterpart of stride-lite's `subagent_type`
 * discriminator: same role, same one-value-per-hook shape, different host. The
 * skills themselves are ported by the workflow-skill task; these constants are
 * the contract between that task and this routing, which is why the tests
 * assert their literal values rather than importing them symbolically.
 */
export const BEFORE_TASK_SKILL = "stride-opencode-lite-task-explorer";
export const AFTER_TASK_SKILL = "stride-opencode-lite-task-reviewer";

/** The only tool whose activation can mark a blocking lifecycle point. */
export const BLOCKING_TRIGGER_TOOLS = ["skill"] as const;

/** Tools whose file mutation can mark goal completion. */
export const GOAL_WRITE_TOOLS = ["edit", "write"] as const;

/** The file whose completion marks a goal finished. */
export const GOAL_FILENAME = "goal.md";

/** The heading whose presence in a goal.md write marks the goal complete. */
export const COMPLETION_HEADING = "## Completion Summary";

/** Per-command budget, mirroring the 60s the hook configuration allows. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/** What a routing decision yields: which section, and what matched. */
export interface RoutingDecision {
  hook: HookName;
  source: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * Read the tool name from an event payload.
 *
 * The declared type puts `tool` at the top level of the input, but the runtime
 * payload has been observed nesting it under `input`. Probing both is what
 * keeps the handlers from silently never firing.
 */
export function extractToolName(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;

  return asString(record.tool) ?? asString(asRecord(record.input)?.tool);
}

/**
 * Read a tool's arguments from an event payload.
 *
 * Three probes, in order: `output.args` is where the before phase carries them,
 * `input.args` is the after phase's declared shape, and `input.input` is the
 * observed runtime nesting. Dropping the middle probe blinds the after handler.
 */
export function extractToolArgs(
  input: unknown,
  output?: unknown,
): Record<string, unknown> | undefined {
  const outputRecord = asRecord(output);
  const inputRecord = asRecord(input);

  return (
    asRecord(outputRecord?.args) ??
    asRecord(inputRecord?.args) ??
    asRecord(inputRecord?.input)
  );
}

/**
 * Read the activated skill's name.
 *
 * The SDK does not document the `skill` tool's argument field, so several
 * spellings are probed. Every one is compared by exact equality later — no
 * pattern matching reaches the blocking path.
 */
export function extractSkillName(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;

  return (
    asString(args.name) ??
    asString(args.skill) ??
    asString(args.skillName) ??
    asString(args.skill_name)
  );
}

/**
 * Read the file path a mutation targets.
 *
 * As above, the SDK documents no field names for `edit`/`write`, so the common
 * spellings are probed.
 */
export function extractFilePath(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;

  return (
    asString(args.filePath) ??
    asString(args.file_path) ??
    asString(args.path) ??
    asString(args.file)
  );
}

/**
 * Decide whether a pre-execution event marks a blocking lifecycle point.
 *
 * Exact string equality on two fields — the tool name and the skill name — and
 * no pattern matching anywhere. That is deliberate: this is the path that can
 * abort a user's tool call, so its false-positive surface is bounded to a
 * direct activation of one of the two named skills.
 */
export function routeBefore(input: unknown, output?: unknown): RoutingDecision | null {
  const tool = extractToolName(input);
  if (!tool || !BLOCKING_TRIGGER_TOOLS.includes(tool as "skill")) return null;

  const skill = extractSkillName(extractToolArgs(input, output));
  if (skill === BEFORE_TASK_SKILL) {
    return { hook: "before_task", source: `skill:${skill}` };
  }
  if (skill === AFTER_TASK_SKILL) {
    return { hook: "after_task", source: `skill:${skill}` };
  }

  return null;
}

/**
 * Decide whether a post-execution event marks goal completion.
 *
 * Mirrors stride-lite, which greps the whole serialized payload for the
 * heading rather than reading one field. That is kept deliberately: the SDK
 * documents no field names for `edit`/`write` args, so a field-specific check
 * would produce silent false negatives — and a missed advisory hook surfaces
 * nowhere at all, while its false positive is merely an extra advisory run.
 */
export function routeAfter(input: unknown, output?: unknown): RoutingDecision | null {
  const tool = extractToolName(input);
  if (!tool || !GOAL_WRITE_TOOLS.includes(tool as "edit" | "write")) return null;

  const args = extractToolArgs(input, output);
  const filePath = extractFilePath(args);
  if (!filePath || basename(filePath) !== GOAL_FILENAME) return null;

  let serialized: string;
  try {
    serialized = JSON.stringify({ input, output }) ?? "";
  } catch {
    // A payload that cannot be serialized cannot be searched; treat it as no
    // match rather than guessing.
    return null;
  }

  if (!serialized.includes(COMPLETION_HEADING)) return null;

  return { hook: "after_goal", source: `${tool}:${GOAL_FILENAME}` };
}

/**
 * Run one section and return its result, or null when there is nothing to run.
 */
async function runSection(
  projectDir: string,
  hook: HookName,
): Promise<HookResult | null> {
  const configPath = `${projectDir}/${CONFIG_FILENAME}`;
  const commands = await parseStrideLiteFile(configPath, hook);

  return executeHookCommands(hook, commands, {
    cwd: projectDir,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    onOutput: (chunk) => process.stderr.write(chunk),
  });
}

interface PluginInput {
  directory?: string;
  worktree?: string;
}

/**
 * The OpenCode plugin.
 *
 * `directory` is preferred over `worktree` so the config is read from the
 * project the session is actually working in.
 */
export const StrideOpenCodeLitePlugin = async (input: PluginInput) => {
  const projectDir = input?.directory ?? input?.worktree ?? process.cwd();

  return {
    "tool.execute.before": async (
      hookInput: unknown,
      hookOutput?: unknown,
    ): Promise<void> => {
      const decision = routeBefore(hookInput, hookOutput);
      if (!decision) return;

      const result = await runSection(projectDir, decision.hook);
      if (!result) return;

      // hookExitCode is the single source of truth for whether a failure
      // blocks — never the status alone, which would block on an advisory
      // section too. Throwing here is what aborts the tool call.
      if (hookExitCode(decision.hook, result) === 2) {
        throw new Error(JSON.stringify(result));
      }
    },

    "tool.execute.after": async (
      hookInput: unknown,
      hookOutput?: unknown,
    ): Promise<void> => {
      const decision = routeAfter(hookInput, hookOutput);
      if (!decision) return;

      // The advisory section never blocks, by three independent mechanisms:
      // this phase cannot roll back a tool call, hookExitCode returns 0 for
      // after_goal, and nothing here throws. Its failure is still reported on
      // stderr so a human sees it.
      try {
        const result = await runSection(projectDir, decision.hook);
        if (result && result.status === "failed") {
          process.stderr.write(`${JSON.stringify(result)}\n`);
        }
      } catch (error) {
        // Defence in depth, and unreachable today: parseStrideLiteFile swallows
        // every read error and executeHookCommands catches its own spawn
        // failures, so runSection has no throwing path. It is kept because the
        // advisory contract — this handler never blocks — must survive a future
        // change to either of those, and it is deliberately not covered by a
        // test rather than being covered by a fabricated one.
        process.stderr.write(
          `stride-opencode-lite: after_goal section errored: ${String(error)}\n`,
        );
      }
    },
  };
};

export default StrideOpenCodeLitePlugin;
