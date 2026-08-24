# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository scaffold: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`,
  a `README` stub and this changelog, plus the empty `skills/`, `agents/`,
  `commands/`, `lib/` and `fixtures/` directories the port fills in.
- The three ported agents — `create-decomposer` (no tool access), `task-explorer`
  and `task-reviewer` — in OpenCode's agent format, with their tool grants
  declared explicitly and asserted by tests.
- Packaging exclusions in the `files` list, so transient artifacts (`.env`,
  `*.local`, the activation marker, exploratory-testing output) cannot be
  published from inside the packed directories. A bare directory entry in
  `files` is recursive and overrides `.gitignore`, so these have to be stated
  explicitly.
