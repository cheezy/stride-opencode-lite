/**
 * stride-opencode-lite — OpenCode plugin entry point.
 *
 * Wires the three `.stride_lite.md` sections to OpenCode tool events:
 *
 * | Section      | Event               | Trigger                                                        | Blocking |
 * |--------------|---------------------|----------------------------------------------------------------|----------|
 * | before_task  | tool.execute.before | skill-activation tool, skill `stride-opencode-lite-task-explorer` | yes      |
 * | after_task   | tool.execute.before | skill-activation tool, skill `stride-opencode-lite-task-reviewer` | yes      |
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

import type { Plugin } from "@opencode-ai/plugin";

import { gateHookExecution } from "./gate";
import { parseStrideLiteFile, type HookName } from "./parser";
import { executeHookCommands, hookExitCode, type HookResult } from "./hook-exec";

/**
 * Plugin namespaces whose prefix may be stripped from a skill name.
 *
 * An allow-list, not a pattern. Stripping any `prefix:` would mean the blocking
 * path fired on an unbounded family of names — `evil:<trigger>` would route —
 * which is precisely the widening the bound claims not to have.
 */
export const STRIPPABLE_SKILL_NAMESPACES = ["stride", "stride-opencode-lite"] as const;

/** The config file this plugin reads. */
export const CONFIG_FILENAME = ".stride_lite.md";

/**
 * Skill identifiers that mark the two blocking lifecycle points.
 *
 * These are the OpenCode counterpart of stride-lite's `subagent_type`
 * discriminator: same role, same one-value-per-hook shape, different host. The
 * skills themselves are ported by the workflow-skill task; these constants are
 * the contract between that task and this routing. A rename is caught by the
 * documentation tests, which compare the exported values against the trigger
 * tables — those hold the names literally, so the two must be changed together.
 */
export const BEFORE_TASK_SKILL = "stride-opencode-lite-task-explorer";
export const AFTER_TASK_SKILL = "stride-opencode-lite-task-reviewer";

/**
 * Tools whose activation can mark a blocking lifecycle point.
 *
 * Taken from the skill-activation tool names the full OpenCode plugin
 * observed, not narrowed to the one name seen most often: matching too few
 * would leave the hook DORMANT on a host that emits another spelling, which is
 * the failure mode this wiring most needs to avoid. Widening this list costs
 * almost nothing, because the skill NAME below is the real gate and is matched
 * by exact equality — a tool name alone can never fire a hook.
 */
export const BLOCKING_TRIGGER_TOOLS = [
  "skill",
  "activate_skill",
  "loadSkill",
  "load_skill",
] as const;

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
 * Read the activated skill's name, normalised for comparison.
 *
 * The SDK does not document the `skill` tool's argument field, so several
 * spellings are probed. The value is then trimmed and stripped of an optional
 * `<plugin>:` prefix, because OpenCode may deliver a skill name namespaced by
 * the plugin that owns it — the full plugin's own gate documents this and
 * normalises the same way. Without it, a genuine activation would compare
 * unequal and both blocking hooks would sit silently dormant, which is the
 * failure this routing most needs to avoid.
 *
 * Normalising the prefix does not widen the false-positive bound: what remains
 * is still whole-string equality against a fixed name, never a prefix or
 * substring match.
 */
export function extractSkillName(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;

  const raw =
    asString(args.name) ??
    asString(args.skill) ??
    asString(args.skillName) ??
    asString(args.skill_name);

  if (raw === undefined) return undefined;

  const trimmed = raw.trim();

  for (const namespace of STRIPPABLE_SKILL_NAMESPACES) {
    const prefix = `${namespace}:`;
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }

  return trimmed;
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
  if (!tool || !(BLOCKING_TRIGGER_TOOLS as readonly string[]).includes(tool)) return null;

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
 * The heading is searched for across the whole resolved ARGUMENTS record rather
 * than any single named field, because the SDK documents no field names for
 * `edit`/`write` args and a field-specific check would give silent false
 * negatives — a missed advisory hook surfaces nowhere at all.
 *
 * It is deliberately NOT searched across the whole event. The after phase's
 * `output` is `{title, output, metadata}`, so serializing the event would put
 * the tool's own application output into the searched text — and a heading that
 * a fetched document, a generated report or a rendered diff merely *contains*
 * would then decide that a goal had completed. The written text always reaches
 * the arguments for both trigger tools, so narrowing the search costs no
 * legitimate match.
 */
export function routeAfter(input: unknown, output?: unknown): RoutingDecision | null {
  const tool = extractToolName(input);
  if (!tool || !(GOAL_WRITE_TOOLS as readonly string[]).includes(tool)) return null;

  const args = extractToolArgs(input, output);
  const filePath = extractFilePath(args);
  if (!filePath || basename(filePath) !== GOAL_FILENAME) return null;

  let serialized: string;
  try {
    serialized = JSON.stringify(args) ?? "";
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

/**
 * The OpenCode plugin.
 *
 * `directory` is preferred over `worktree` so the config is read from the
 * project the session is actually working in.
 */
export const StrideOpenCodeLitePlugin: Plugin = async (input) => {
  const projectDir = input?.directory ?? input?.worktree ?? process.cwd();

  return {
    "tool.execute.before": async (
      hookInput: unknown,
      hookOutput?: unknown,
    ): Promise<void> => {
      const decision = routeBefore(hookInput, hookOutput);
      if (!decision) return;

      // The gate runs only once a trigger has matched, and it FAILS OPEN: with
      // no marker, a stale one, or an unreadable one, no section runs and this
      // tool call proceeds untouched. Blocking here instead would mean that
      // merely installing the plugin breaks ordinary edits in any project that
      // is not mid-workflow.
      const gate = gateHookExecution({ projectDir });
      if (gate.decision === "skip") {
        process.stderr.write(
          `stride-opencode-lite: ${decision.hook} not run — ${gate.reason}\n`,
        );
        return;
      }

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

      const gate = gateHookExecution({ projectDir });
      if (gate.decision === "skip") {
        process.stderr.write(
          `stride-opencode-lite: ${decision.hook} not run — ${gate.reason}\n`,
        );
        return;
      }

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
