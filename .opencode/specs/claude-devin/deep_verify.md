# deep_verify — claude-devin-plugin AC re-verification (2026-11-02)

Scope: every AC in requirements.md vs produced artifacts. Evidence = file:line or
observed command output.

## Commands run

- `bun test` → **151 pass, 3 skip, 0 fail** (154 tests, 16 files, ~1.3s). The 3
  skips are the live.test.ts cases gated on DEVIN_LLM_API_KEY (absent here).
- `node claude-devin-plugin/bin/devin-claude doctor` →
  ```
  devin-claude doctor
    credentials file   : C:\Users\Josemi\.config\devin-claude\credentials.json
    credential present : NO
    DEVIN_LLM_API_KEY  : unset
    effective api key  : NO
    proxy :42100       : reachable
  Run `devin-claude login` or set DEVIN_LLM_API_KEY.   (exit 1)
  ```
  Note: "reachable" is a pre-existing stray `node` process (PID 20152) bound to
  127.0.0.1:42100 returning `{"status":"ok","authenticated":false}` — i.e., an
  earlier `devin-claude start` instance of THIS proxy still running, not foreign.
- Secret-logging grep: no `console.*(token|jwt|secret|apiKey|authorization)` hits
  in new source; src/auth has zero console/file writes; src/protocol has zero
  file writes. Only `login.ts` prints the authorize URL (contains code_challenge
  + state, NOT verifier/code/token — matches vendored opencode-devin behavior;
  state/challenge are public PKCE params). Credential write path is
  writeFileSync(mode 0o600)+chmodSync only (auth.ts:72-77).

## Per-AC verdicts

- AC-1 PASS — login.ts:116-134 loginAuto (loopback server on 127.0.0.1,
  state-check, PKCE S256 via auth/pkce.ts); url.ts:17 builds
  `app.devin.ai/auth/cli/continue`; saveCredentials writes
  `~/.config/devin-claude/credentials.json` mode 0600 (auth.ts:38,64-79);
  auth.test.ts:55-65 asserts path+0600 (POSIX; Windows chmod best-effort —
  documented caveat).
- AC-2 PASS — login.ts:140-164 loginManual (no redirect_uri → webapp shows
  code; readline paste; exchange.ts:21 `POST api.devin.ai/auth/cli/token` →
  `devin-session-token$<jwt>`; saveCredentials).
- AC-3 PASS — server.ts:197-238 validates {model,messages,max_tokens}, resolves
  model, builds StreamChatRequest; protocol/chat.ts:437 POSTs
  `GetChatMessage` Connect-RPC. Bind is 127.0.0.1 (server.ts:293).
- AC-4 PASS — anthropic.ts:356-455 yields message_start →
  content_block_start/delta/stop → message_delta → message_stop as SSE;
  server.ts:240-265 writes `text/event-stream` incrementally
  (`res.write(sseSerialize)` per event); anthropic.test.ts:259-322 asserts
  order and wire format.
- AC-5 PASS — models.ts:42-50 shapes {id,object:"model",created_at,
  display_name,type:"model"}; catalog.ts:97 calls GetCascadeModelConfigs;
  models.test.ts:38-59 stubs wire reply → verifies shape; server.ts:160-163.
- AC-6 PASS — server.ts:69-75 key extraction, :137-140 401
  `authentication_error` + `{type:"error"}` body (errorBody :34-37);
  server.test.ts:66-77.
- AC-7 PASS — ModelNotFoundError carries validIds (models.ts:29-40);
  server.ts:219-223 → 400 invalid_request_error; server.test.ts:151-168
  asserts message contains valid ids. Caveat: `claude-/swe-/glm-` UIDs not in
  catalog pass through (models.ts:84,108) — intentional passthrough, only
  unrecognized names 400.
- AC-8 PASS — `.claude-plugin/plugin.json` + `marketplace.json` valid JSON;
  `bin/devin-claude` + `.cmd` on PATH; commands/devin-{login,status,models}.md
  use `${CLAUDE_PLUGIN_ROOT}/bin/devin-claude` → `/devin:login`. README:25
  documents `--plugin-dir`; marketplace.json present for git-repo install.
- AC-9 PASS (mocked leg) / UNVERIFIED live — launch sets ANTHROPIC_BASE_URL +
  ANTHROPIC_AUTH_TOKEN and spawns claude (bin/devin-claude:249-252). AC permits
  "live smoke OR mocked client": server.test.ts replays a real
  `/v1/messages` request through the real HTTP server; anthropic.test.ts
  verifies SSE over a stubbed Cascade source; live.test.ts exists but skipped
  (no DEVIN_LLM_API_KEY on this machine). No literal ANTHROPIC_* test.
- AC-10 PASS — greps clean; server log = method+path+status only
  (server.ts:92-94); doctor prints booleans not values (bin/devin-claude:196-212);
  exchange.ts and protocol files never print token/code/user_jwt. The only
  printed URL is the authorize URL (public PKCE params) — acceptable.

## Loose ends (not AC failures)

- Stray proxy still running on 42100 (PID 20152) from earlier session.
- resolveModelId passthrough for known UID families means "not in catalog" is
  softer than AC-7's strict wording for claude-*/swe-*/glm-* names — design
  choice, documented in models.ts:87-93.
- 0600 is best-effort on Windows (chmod no-op) — documented in auth.ts:76.
