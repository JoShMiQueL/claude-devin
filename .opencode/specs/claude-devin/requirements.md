# claude-devin-plugin — requirements

## Context

The opencode-devin plugin (cloned into this repo) logs a Devin/Cognition
subscription into OpenCode v2 via PKCE (`/connect`) and publishes `devin/*`
models backed by the Cascade gRPC protocol in `src/protocol/`. Claude Code has
no provider-plugin API — the only documented path is `ANTHROPIC_BASE_URL` +
`ANTHROPIC_AUTH_TOKEN` pointed at an Anthropic-compatible `/v1/messages`
endpoint. The goal is a Claude Code plugin that runs a local Devin→Anthropic
proxy, manages Devin login, and exposes Devin models inside Claude Code.

## Acceptance criteria (EARS)

- AC-1: WHEN `devin-claude login` runs interactively THE SYSTEM SHALL start the
  Devin PKCE flow, open the browser to `app.devin.ai/auth/cli/continue`, and
  store the `devin-session-token$<jwt>` credential under
  `~/.config/devin-claude/credentials.json` with mode 0600.

- AC-2: WHEN `devin-claude login --manual` runs without a loopback callback
  THE SYSTEM SHALL accept a pasted authorization code, exchange it via
  `POST https://api.devin.ai/auth/cli/token`, and store the resulting token.

- AC-3: WHEN the proxy is running with a valid credential THE SYSTEM SHALL
  serve Anthropic-compatible `POST /v1/messages` on 127.0.0.1 that accepts
  `{model, messages, max_tokens, stream}` and forwards to the Cascade
  `GetChatMessage` stream.

- AC-4: WHILE `stream=true` on `/v1/messages` THE SYSTEM SHALL emit valid
  Anthropic SSE events (`message_start`, `content_block_start/delta/stop`,
  `message_delta`, `message_stop`) in real time.

- AC-5: WHEN `GET /v1/models` is called THE SYSTEM SHALL return the live
  per-account Cascade model catalog (`GetCascadeModelConfigs`) as
  Anthropic-shaped `{id, display_name, created_at, type:"model"}` objects.

- AC-6: IF a request arrives without a valid `x-api-key`/`authorization`
  matching the local proxy key THEN THE SYSTEM SHALL return HTTP 401 with an
  Anthropic-style `{type:"error"}` body.

- AC-7: WHEN a requested `model` is not in the catalog THE SYSTEM SHALL
  return HTTP 400 with `error.type="invalid_request_error"` and the list of
  valid model IDs.

- AC-8: THE SYSTEM SHALL ship as a Claude Code plugin directory containing
  `.claude-plugin/plugin.json`, `bin/` executables added to PATH, and at
  least one slash command for login (`/devin:login`) — installable via
  `--plugin-dir` or a marketplace git repo.

- AC-9: WHEN `devin-claude` is invoked with `ANTHROPIC_BASE_URL` pointing at
  the proxy and `ANTHROPIC_AUTH_TOKEN` set THE SYSTEM SHALL proxy Claude
  Code's `/v1/messages` calls end-to-end (verified by a live smoke test or a
  mocked client replaying a real request).

- AC-10: THE SYSTEM SHALL NOT log or echo the session token, authorization
  code, or `user_jwt` to stdout or any file.

## Out of scope

- Registering models in a native picker (Claude Code has no provider API).
- Tool-call passthrough beyond the basic `tools` list → Cascade tool
  definitions (mapping fidelity is best-effort).
- Windsurf-specific account pooling / multi-account rotation (that lives in
  the sibling WindsurfAPI repo).
- Publishing to npm (local install via `--plugin-dir` is the target).
