# Changelog

All notable changes to this project are documented here. This file is generated
and maintained by [release-please](https://github.com/googleapis/release-please)
from conventional-commit history — do not edit by hand.

## [0.5.1](https://github.com/JoShMiQueL/claude-devin/compare/v0.5.0...v0.5.1) (2026-11-03)


### Documentation

* document merge-commit release syncs and English PR convention ([2671e85](https://github.com/JoShMiQueL/claude-devin/commit/2671e85107538c69ba4f2c9a093295930daa14f4))

## [0.5.0](https://github.com/JoShMiQueL/claude-devin/compare/v0.4.0...v0.5.0) (2026-11-03)


### Features

* isolated service instances via --instance / DEVIN_CLAUDE_INSTANCE ([#14](https://github.com/JoShMiQueL/claude-devin/issues/14)) ([b199ece](https://github.com/JoShMiQueL/claude-devin/commit/b199ecec7ed1b422ff6ba86b66b53a5a34b8eadf))


### Bug Fixes

* **cli:** use readSync for log-follow reads so service logs actually tails ([#13](https://github.com/JoShMiQueL/claude-devin/issues/13)) ([a889503](https://github.com/JoShMiQueL/claude-devin/commit/a8895035d3bfb307485e6245566eccc687ff7253))
* **proxy:** use catalog contextWindow for maxInputTokens ([#15](https://github.com/JoShMiQueL/claude-devin/issues/15)) ([d445c25](https://github.com/JoShMiQueL/claude-devin/commit/d445c25c6f297d4f11dc7086b2b63c17db18893d))

## [0.4.0](https://github.com/JoShMiQueL/claude-devin/releases/tag/v0.4.0) (2026-10-31)

### Features

* `claude` tool-shell selector — `--shell bash|powershell|auto`
* Persistent auto-service + 24h update check on launch
* `service` command — persistent background proxy management
* Rich request telemetry — TTFT, tokens, tools, stop reason, session end
* Session markers + request IDs for splittable logs
* Leveled logging + rotation + `service logs`
* POSIX launcher for Git Bash alongside `.cmd`

### Bug Fixes

* Await session-end mark before exit (fire-and-forget raced `process.exit`)
* Run auto-mode classifier on `swe-2-high` (was 502-retrying on `claude-sonnet-5`)
* Force `ANTHROPIC_MODEL=swe-2-high` so claude can't pick a non-Devin model
