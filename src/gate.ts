/**
 * Activation-marker gate.
 *
 * The workflow skill writes a marker when it starts driving a goal and clears it
 * on every exit path. This gate reads that marker and decides whether a hook
 * section may run. Its purpose is **coordination, not security**: it stops a
 * project's `.stride_lite.md` sections firing during ordinary work that merely
 * happens to touch a trigger, and it is trivially bypassed by anyone who wants
 * to — writing the marker is a one-line shell command. Treat it as a mode
 * switch, never as an access control.
 *
 * It FAILS OPEN. With no marker, a stale one, or an unreadable one, the decision
 * is `skip`: no hook section runs and **the triggering tool call proceeds
 * untouched**. The full Stride plugin's equivalent fails closed and throws,
 * because there the gate also guards direct skill activation; here the only
 * consequence of a missing marker must be that a hook does not fire. Blocking
 * the call instead would mean that merely installing this plugin starts breaking
 * ordinary edits in any project without a marker.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Marker directory, deliberately distinct from the full plugin's `.stride/`.
 *
 * A project may have both plugins installed. Sharing a path would let one
 * plugin's workflow arm the other's hooks.
 */
export const MARKER_DIR = ".stride-opencode-lite";

/** Marker filename inside {@link MARKER_DIR}. */
export const MARKER_FILE = ".orchestrator_active";

/**
 * Override, deliberately distinct from the full plugin's `STRIDE_ALLOW_DIRECT`
 * for the same reason the path is.
 *
 * Set to `"1"` to run sections without a marker — for plugin debugging and for
 * scripted CI, where no interactive workflow exists to write one.
 */
export const OVERRIDE_ENV = "STRIDE_OPENCODE_LITE_ALLOW_DIRECT";

/**
 * How long a marker stays valid.
 *
 * A crashed or killed run leaves its marker behind, so an existing marker is
 * not evidence of a live session — the window is what stops yesterday's
 * abandoned marker arming today's hooks.
 */
export const MARKER_FRESHNESS_MS = 4 * 60 * 60 * 1000;

/** What the gate decided, and why — the reason is for logging, never for control flow. */
export type GateDecision =
  | { decision: "run" }
  | { decision: "skip"; reason: string };

export interface GateInput {
  /** Project root the marker is resolved against. */
  projectDir: string;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable clock, so the freshness window is testable without waiting. */
  now?: number;
  /** Injectable filesystem, so tests need no real marker on disk. */
  fs?: {
    existsSync: (path: string) => boolean;
    readFileSync: (path: string, encoding: "utf8") => string;
  };
}

/** Absolute path to the marker for a given project root. */
export function markerPath(projectDir: string): string {
  return join(projectDir, MARKER_DIR, MARKER_FILE);
}

/**
 * Decide whether a hook section may run.
 *
 * Every failure mode returns `skip`, never a throw: the caller's contract is
 * that a gate refusal leaves the triggering tool call untouched.
 */
export function gateHookExecution(input: GateInput): GateDecision {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now();
  const fs = input.fs ?? { existsSync, readFileSync };

  if (env[OVERRIDE_ENV] === "1") {
    return { decision: "run" };
  }

  const path = markerPath(input.projectDir);

  if (!fs.existsSync(path)) {
    return { decision: "skip", reason: "no activation marker — no workflow is driving this session" };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (error) {
    return { decision: "skip", reason: `activation marker unreadable: ${String(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written marker is not a live session. Skipping is the safe read,
    // and it is what a crashed writer leaves behind.
    return { decision: "skip", reason: "activation marker is not valid JSON" };
  }

  const startedAt =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).started_at
      : undefined;

  if (typeof startedAt !== "string") {
    return { decision: "skip", reason: "activation marker has no started_at" };
  }

  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return { decision: "skip", reason: "activation marker has an unparseable started_at" };
  }

  const ageMs = now - startedMs;
  if (ageMs < 0) {
    // A future-dated marker is as suspect as an expired one — a clock change or
    // a hand-edited file, neither of which is a live session.
    return { decision: "skip", reason: "activation marker is dated in the future" };
  }
  if (ageMs > MARKER_FRESHNESS_MS) {
    return { decision: "skip", reason: `activation marker is stale (${Math.floor(ageMs / 1000)}s old)` };
  }

  return { decision: "run" };
}
