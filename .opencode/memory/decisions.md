# decisions

## 2026-11-02 — claude-devin-plugin

Built a Claude Code plugin that mirrors `opencode-devin` (connect Devin
subscription → models).

Key decisions:

- Claude Code has **no provider plugin API**. The only documented custom-model
  path is `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` pointed at an
  Anthropic-compatible `/v1/messages` endpoint. So the plugin ships a local
  HTTP proxy (`src/devin-anthropic-proxy/`) that translates Anthropic
  `/v1/messages` + `/v1/models` onto the vendored Cascade gRPC protocol
  (`src/protocol/*`) — the same upstream `opencode-devin` uses.
- Vendored `src/auth/*` + `src/protocol/*` from `opencode-devin` **unchanged**;
  they are OpenCode-free already. Only `loopback.ts`/`browser.ts` are
  Bun-specific, so `src/devin-anthropic-proxy/login.ts` re-implements them
  with `node:http`/`child_process`.
- Credentials stored at `~/.config/devin-claude/credentials.json` (0600,
  XDG-aware); `DEVIN_LLM_API_KEY` env overrides.
- Local client key `devin-claude-local` guards the proxy (downstream Bearer).
  Upstream auth = `devin-session-token$<jwt>` + auto-minted `user_jwt` (~24min,
  handled by `getCachedUserJwt`).
- Port `42100` default, configurable via `DEVIN_CLAUDE_PORT`.
- `devin-claude launch` wraps `claude` with env vars set — workaround for
  plugins not being able to set session env vars.
- Tested: 151 tests pass (bun test), 0 fail. Live `live.test.ts` gated on
  `DEVIN_LLM_API_KEY`.
