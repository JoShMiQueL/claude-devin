# claude-devin

Use **Claude Code on your Devin subscription**. `claude-devin` is a drop-in
wrapper for the `claude` CLI that routes requests through Cognition's Cascade
API — the same upstream [`opencode-devin`](https://github.com/JoShMiQueL/opencode-devin)
uses — instead of api.anthropic.com.

```bash
claude-devin login     # sign in with Devin (opens your browser)
claude-devin           # start Claude Code, powered by Devin
```

Every `claude` flag works unchanged — `claude-devin` passes them through:

```bash
claude-devin --help        # = claude --help
claude-devin resume        # resume a session
claude-devin -p "prompt"   # non-interactive print
```

## Install

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/JoShMiQueL/claude-devin/main/install.ps1 | iex
```

### macOS / Linux / WSL

```bash
curl -fsSL https://raw.githubusercontent.com/JoShMiQueL/claude-devin/main/install.sh | bash
```

Requirements: **Node.js ≥18** and a Devin (Cognition) subscription. Claude Code
itself is installed on first use via `claude-devin install-claude` (or
`npm i -g @anthropic-ai/claude-code`).

## Usage

| Command | What it does |
| --- | --- |
| `claude-devin` | Start `claude` with the Devin proxy wired up. |
| `claude-devin login` | Sign in to Devin (PKCE). Stores `~/.config/devin-claude/credentials.json`. |
| `claude-devin login --manual` | Headless login — paste the code Devin shows you. |
| `claude-devin models` | List the model IDs your account can use. |
| `claude-devin status` | Health check of the proxy + credential. |
| `claude-devin doctor` | Diagnose missing deps / credentials / proxy. |
| `claude-devin service <cmd>` | Manage the background proxy — `start`, `stop`, `restart`, `status`. |
| `claude-devin install-claude` | Install the `claude` CLI if missing. |
| `claude-devin logout` | Remove stored credentials. |
| `claude-devin <anything else>` | Forwarded to `claude` verbatim. |

The default model is **`swe-2-high`**. Override it per-run with claude's own
`--model` flag, or for all runs with `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_MODEL`
(e.g. `glm-5-3-high`, `claude-opus-5-5-high` — run `claude-devin models` for
the ~140 IDs your account exposes). Interactive `/model` inside claude
discovers the same list straight from the proxy.

### `--fast` mode

For shorter, cheaper runs, add `--fast` — claude-devin's own flag:

```bash
claude-devin --fast -p "fix the bug in sum.js"
```

`--fast` strips web tools (`WebFetch`, `WebSearch`), planning/subagent tools
(`Task`, `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`, `NotebookEdit`),
caps `max_tokens` at 16k, and nudges the model to be terse. In benchmarks
against the regular mode it's **~25-60% faster** with **~20-60% fewer output
tokens** (see Benchmarks below). Works alongside any other `claude` flags.

## How it works

```
claude-devin
  ├─ ensures the background proxy is up on 127.0.0.1:42100
  │    ├─ reuses a running service if one exists (instant)
  │    └─ otherwise spawns it detached (survives the session)
  │       → translates /v1/messages + /v1/models into Cascade gRPC
  │          calls against server.codeium.com (reverse-engineered,
  │          same as opencode-devin's src/protocol/)
  └─ launches `claude` with
        ANTHROPIC_BASE_URL = http://127.0.0.1:42100   (+ "/fast" when --fast)
        ANTHROPIC_API_KEY  = devin-claude-local
        ANTHROPIC_AUTH_TOKEN = devin-claude-local
```

The proxy runs as a **persistent background service**: the first `claude-devin`
invocation spawns it detached (pid + log in `~/.claude-devin/`), and every
later invocation reuses it — catalog and auth caches stay warm, so subsequent
runs start faster. Use `claude-devin service restart` after an `upgrade` to
pick up a new bundle; `service stop` shuts it down.

Claude Code never knows it isn't talking to Anthropic. Your Devin session
token (obtained once via `login`) mints short-lived `user_jwt`s for the
Cascade RPCs; the local key only protects the loopback proxy.

An update check runs at most once per 24h on launch and prints a one-line
notice to stderr when a newer release exists — `claude-devin upgrade` then
pulls it.

## Logging

The service writes `~/.claude-devin/proxy.log` (rotated to `proxy.log.1`
at ~5 MB on start):

- **Session markers**: every `claude-devin` run logs
  `session <id> pid=… fast=… args=… v=…` before its traffic, so the log
  can be split by invocation.
- **Request IDs**: each request gets `[r<n>]` correlated across its
  start/finish/upstream-error lines.
- **Levels**: `DEVIN_CLAUDE_LOG_LEVEL=debug|info|warn|error` (default
  `info` = startup + abnormal requests + upstream errors; `debug` logs
  every request).
- **Tail it** with `claude-devin service logs [N]` — last N lines then
  follow.

## Claude Code plugin (optional)

The `claude-devin/` directory is also a valid Claude Code plugin: load it
with `claude --plugin-dir <path>` to get `/devin:login`, `/devin:models`,
and `/devin:status` slash commands inside Claude Code.

## Benchmarks

Measured end-to-end on agentic tasks with `swe-2-high` (`n=2` per cell, all
runs passing the task checks):

| Task | claude-devin | claude-devin --fast | Δ |
|---|---|---|---|
| search-and-fix | 57.0s | **31.6s** | -45% |
| web-research | 71.6s | **28.9s** | -60% |
| parallel-research | 34.4s | **29.6s** | -14% |
| build-json-db | 30.7s | **22.9s** | -25% |

`--fast` cuts the verbose exploration loop: fewer tool calls, no web fetches,
terser output (~20-60% fewer output tokens). Numbers vary with prompt style;
treat as directional.

## Development

Source lives under `src/` (TypeScript, vendored from `opencode-devin`):
`src/protocol/` = Cascade wire protocol, `src/auth/` = Devin PKCE auth,
`src/devin-anthropic-proxy/` = Anthropic↔Cascade adapter + HTTP server.

Rebuild the single-file proxy bundle (bundled with `bun`):

```bash
bun build src/devin-anthropic-proxy/bundle-entry.ts --target node --outfile proxy-bundle.mjs
```

## License

MIT
