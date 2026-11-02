# Changelog

All notable changes to this project are documented here. This file is generated
and maintained by [release-please](https://github.com/googleapis/release-please)
from conventional-commit history — do not edit by hand.

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
