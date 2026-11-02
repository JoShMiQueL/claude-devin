# claude-devin-plugin — design

## Approach

Claude Code has no provider plugin API; the only documented way to use a
custom model is `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` pointing at an
Anthropic-compatible `/v1/messages` endpoint. So the "plugin" is a Claude
Code plugin directory that ships:

- a `bin/` helper `devin-claude` (Node, zero deps) that does Devin PKCE login
  and launches the local proxy,
- a local HTTP proxy (`src/devin-anthropic-proxy/`) that translates Anthropic
  `/v1/messages` (SSE and non-stream) + `/v1/models` onto the vendored
  Cascade gRPC protocol in `src/protocol/`, and
- slash commands (`/devin:login`, `/devin:status`, `/devin:models`) that call
  the helper.

The user still sets the two env vars once (or the helper writes them into a
`claude`-wrapped launcher); everything else is plugin-side.

## Architecture / changes

- NEW `claude-devin-plugin/.claude-plugin/plugin.json` — manifest.
- NEW `claude-devin-plugin/.claude-plugin/marketplace.json` — for
  `claude plugin install` from git.
- NEW `claude-devin-plugin/.mcp.json` — optional MCP stub (status tool); kept
  minimal so it never blocks plugin load.
- NEW `claude-devin-plugin/bin/devin-claude` — Node ESM launcher:
  `login [--manual]`, `start [--port]`, `status`, `models`, `doctor`,
  `launch` (spawn `claude` with env set).
- NEW `claude-devin-plugin/commands/devin-login.md` —
  `/devin:login` → `bin/devin-claude login`.
- NEW `claude-devin-plugin/commands/devin-status.md` —
  `/devin:status` → health + catalog summary.
- NEW `claude-devin-plugin/commands/devin-models.md` —
  `/devin:models` → `bin/devin-claude models`.
- NEW `claude-devin-plugin/hooks/hooks.json` — `SessionStart` hook: checks
  credential file exists; prints a `systemMessage` reminder if missing.
- NEW `claude-devin-plugin/README.md`, `LICENSE` (MIT).
- NEW `src/devin-anthropic-proxy/server.ts` — HTTP server on 127.0.0.1:
  `GET /health`, `GET/POST /v1/models`, `POST /v1/messages`,
  `POST /v1/messages/count_tokens`, `*` → Anthropic 404.
- NEW `src/devin-anthropic-proxy/auth.ts` — credential store:
  `~/.config/devin-claude/credentials.json` (0600), loads `DEVIN_LLM_API_KEY`
  env override, `XDG_CONFIG_HOME` aware.
- NEW `src/devin-anthropic-proxy/login.ts` — wraps `src/auth/login.ts`:
  `loginAuto()` (loopback) + `loginManual()` (paste code), then
  `toCredentialsFile()`.
- NEW `src/devin-anthropic-proxy/anthropic.ts` — Anthropic request →
  `ChatHistoryItem[]`/`ChatToolDefinition[]` conversion (incl. `system`
  folding, `tool_use`/`tool_result` blocks → Cascade tool calls), and
  Cascade `ChatEvent` → Anthropic JSON / SSE.
- NEW `src/devin-anthropic-proxy/models.ts` — catalog → Anthropic model
  shape; single `/v1/models` payload and `id` lookup.
- NEW `test/devin-anthropic-proxy/` — unit tests for the Anthropic mapper,
  SSE envelope, auth store, and model validation (live test gated on env
  var).
- EXISTING `src/auth/*`, `src/protocol/*` — vendored unchanged; the proxy
  imports them directly (they are OpenCode-free already).

## Requirement → change map

- AC-1 → `bin/devin-claude login` + `src/devin-anthropic-proxy/login.ts`
  (uses `loginAuto`, `toStoredCredential`, writes
  `~/.config/devin-claude/credentials.json` mode 0600).
- AC-2 → `bin/devin-claude login --manual` +
  `src/devin-anthropic-proxy/login.ts` (`loginManual` + `exchangeCode`).
- AC-3 → `src/devin-anthropic-proxy/server.ts` +
  `anthropic.ts` (accepts `{model,messages,max_tokens,stream}`, calls
  `streamChatEvents`).
- AC-4 → `anthropic.ts` SSE mapper emitting `message_start`…`message_stop`.
- AC-5 → `src/devin-anthropic-proxy/models.ts` +
  `src/protocol/catalog.ts` (`getCachedCatalog`).
- AC-6 → `server.ts` auth middleware comparing `x-api-key` /
  `authorization` to the local key.
- AC-7 → `server.ts` + `models.ts`: unknown model → 400
  `invalid_request_error` with valid IDs.
- AC-8 → plugin dir: `.claude-plugin/plugin.json`, `bin/`,
  `commands/devin-*.md`.
- AC-9 → `bin/devin-claude launch` sets env and spawns `claude`; smoke test
  in `test/devin-anthropic-proxy/` replays a real `/v1/messages` request
  through the proxy.
- AC-10 → credential/token never logged (server logs only method+path);
  `login.ts` masks output.

## Risks / gotchas

- Bun vs Node: `src/auth/*` and `src/protocol/*` use `Bun.serve`/`Bun.spawn`
  only in `browser.ts`/`loopback.ts`; protocol code is pure
  fetch/Buffer/zlib. The proxy runs on Node ≥18 (undici fetch). The
  loopback login server must be re-implemented with `http` for the CLI; the
  vendored `loopback.ts` stays Bun-only for the OpenCode plugin.
- Protobuf wire layout is reverse-engineered; `test/live.test.ts` in the
  cloned repo validates against the real API — reuse those expectations in
  the new proxy tests.
- Claude Code tool-use fidelity: `tools` are passed through to Cascade but
  schema translation is lossy for `input_schema`/`parameters`; mitigate by
  stringifying JSON schemas identically to `encodeToolDef`.
- `user_jwt` lifetime ~24 min: already handled by `getCachedUserJwt` cache;
  server must catch 401s and re-mint (existing `clearCachedUserJwt` path).
- Token file permissions: `credentials.json` must be created 0600; on
  Windows the ACL is best-effort (fs.chmod), which the CLI documents.

## Constitution check

- [x] artifact-first respected (all source on disk, no long dumps in
  context)
- [x] v2 schema keys only (`.claude-plugin/plugin.json`, `.mcp.json`,
  `hooks/hooks.json` shapes from code.claude.com docs)
- [x] English names/prompts throughout
- [x] fits 16K ctx (proxy loads catalog on demand; no giant files inline)
