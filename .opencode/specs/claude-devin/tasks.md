# claude-devin-plugin — tasks

Ordered. Implement top-down; do not reorder without updating design.md.
The opencode-devin repo is already cloned at the workspace root; its
`src/auth/*` and `src/protocol/*` are vendored unchanged.

- [x] T1 (gen-coder) Scaffold the Claude Code plugin directory at
      `claude-devin-plugin/` with `.claude-plugin/plugin.json`,
      `.claude-plugin/marketplace.json`, `README.md`, `LICENSE`, and
      `commands/devin-{login,status,models}.md` stubs that call
      `bin/devin-claude`.
      files: `claude-devin-plugin/.claude-plugin/plugin.json`,
             `claude-devin-plugin/.claude-plugin/marketplace.json`,
             `claude-devin-plugin/README.md`, `claude-devin-plugin/LICENSE`,
             `claude-devin-plugin/commands/devin-login.md`,
             `claude-devin-plugin/commands/devin-status.md`,
             `claude-devin-plugin/commands/devin-models.md`
      satisfies: AC-8
      verify: `plugin.json` parses; dir loads via `claude --plugin-dir`
              (documented, not executed here)

- [x] T2 (gen-coder) Write `src/devin-anthropic-proxy/auth.ts`
      (credential store) + `src/devin-anthropic-proxy/login.ts`
      (PKCE login CLI logic) + `bin/devin-claude` launcher with
      `login [--manual]`, `start`, `status`, `models`, `doctor`,
      `launch` subcommands.
      files: `src/devin-anthropic-proxy/auth.ts`,
             `src/devin-anthropic-proxy/login.ts`,
             `claude-devin-plugin/bin/devin-claude`,
             `claude-devin-plugin/bin/devin-claude.cmd` (Windows shim)
      satisfies: AC-1, AC-2, AC-9
      verify: `node bin/devin-claude doctor` runs; `--manual` path
              accepts pasted code via stdin

- [x] T3 (gen-coder) Write `src/devin-anthropic-proxy/models.ts`
      (catalog → Anthropic shape) + `src/devin-anthropic-proxy/anthropic.ts`
      (request conversion + SSE/JSON response mapper).
      files: `src/devin-anthropic-proxy/models.ts`,
             `src/devin-anthropic-proxy/anthropic.ts`
      satisfies: AC-4, AC-5, AC-7
      verify: unit tests for request→ChatHistoryItem and
              ChatEvent→SSE event shapes

- [x] T4 (gen-coder) Write `src/devin-anthropic-proxy/server.ts`
      — HTTP server on 127.0.0.1, `GET /health`, `GET /v1/models`,
      `POST /v1/messages` (stream + non-stream),
      `POST /v1/messages/count_tokens`, api-key middleware, 404/405
      Anthropic errors, structured logging (method+path only, no tokens).
      files: `src/devin-anthropic-proxy/server.ts`
      satisfies: AC-3, AC-4, AC-6, AC-10
      verify: `curl localhost:PORT/health` → `{status:"ok"}`;
              `curl -H x-api-key:wrong` → 401

- [x] T5 (gen-coder) Write `test/devin-anthropic-proxy/` unit tests +
      one live smoke test gated on `DEVIN_LLM_API_KEY` env var that
      replays a real `/v1/messages` request.
      files: `test/devin-anthropic-proxy/auth.test.ts`,
             `test/devin-anthropic-proxy/anthropic.test.ts`,
             `test/devin-anthropic-proxy/server.test.ts`,
             `test/devin-anthropic-proxy/live.test.ts`
      satisfies: AC-3..AC-7, AC-9
      verify: `bun test test/devin-anthropic-proxy` passes

- [x] T6 (gen-qa) Final QA gate: review full diff, run tests, verify
      every AC, and update `claude-devin-plugin/README.md` with the
      verified usage (`devin-claude login`, env vars, `/devin:login`).
      files: `claude-devin-plugin/README.md`, `test/devin-anthropic-proxy/`
      satisfies: AC-9, AC-10, all ACs
      verify: all previous tasks ticked; smoke test output captured
