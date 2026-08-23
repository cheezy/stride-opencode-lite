/**
 * stride-opencode-lite — plugin entry point.
 *
 * This module is intentionally empty at the scaffold stage. It exists so that
 * `main`/`module` in package.json resolve and so `tsc --noEmit` has an input to
 * compile; TypeScript reports TS18003 ("No inputs were found") against an empty
 * source tree.
 *
 * The real OpenCode plugin export — and the choice of hook trigger event — is
 * wired up separately, alongside the parser and hook executor.
 */

export {};
