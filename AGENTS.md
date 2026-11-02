# AGENTS.md — working agreements for coding agents

Rules an agent must follow when working in this repo. Read `CONTRIBUTING.md`
for the full GitFlow rationale; this file is the short operational contract.

## What this project is

`claude-devin` — a drop-in `claude` CLI wrapper that routes requests through a
local Anthropic-compatible proxy (`proxy-bundle.mjs`) to Cognition's Devin
subscription. `cli.mjs` runs on **Node ≥18**; `src/` is TypeScript built with
Bun. `src/protocol/` = Cascade wire protocol, `src/auth/` = Devin PKCE,
`src/devin-anthropic-proxy/` = adapter + HTTP server.

## Commands

```bash
bun run verify      # lint + bun check + bun test — run this, always
bun run lint        # oxlint, strict (.oxlintrc.json)
bun run typecheck   # bun check
bun test            # test suite; test/live.test.ts needs DEVIN_LLM_API_KEY, skips without it
bun run build       # rebuild proxy-bundle.mjs
```

A lefthook pre-push hook runs lint + typecheck (~2s). It is installed via the
`prepare` script — do not bypass it (`--no-verify`) unless the user asks.

## Git rules (enforced — you cannot bypass them)

- **Never push directly to `main` or `develop`.** Both are protected: no force
  push, no deletion, squash-only merges, all CI checks required, admins
  included. Everything goes through a PR.
- **Base branch**: `feat/*`, `fix/*`, `chore/*`, `docs/*` → PR to **`develop`**.
  Only `hotfix/*` and `release-please--*` may target `main` (CI `branch-gate`
  fails the merge otherwise).
- **Commit and PR title format: conventional commits, always.** The squash
  commit message and `CHANGELOG.md` are generated from them:
  `feat:` minor bump, `fix:`/`perf:` patch, `feat!:`/`BREAKING CHANGE:` major,
  `chore:`/`ci:`/`docs:`/`test:`/`build:` no bump.
- **Use the PR template** (`.github/pull_request_template.md`) — fill every
  section; don't leave the HTML comments unanswered.
- Do not bump `package.json` `version` or edit `CHANGELOG.md` by hand —
  release-please owns both.
- Pinned dependencies: GitHub Actions pin to full SHA (comment the version).
  npm devDeps are exact. Dependabot proposes the bumps — don't hand-edit pins.

## Code style

- TypeScript strict, ES modules, `.ts` extension in imports (`allowImportingTsExtensions`).
- Keep helpers at module scope — oxlint flags functions recreated inside
  per-request closures (`consistent-function-scoping`) as errors.
- `cli.mjs` must keep working on Node 18+ — no Bun-only APIs outside
  `src/auth/loopback.ts`/`browser.ts` (see comments there for the split).

## When in doubt

Open a draft PR to `develop` rather than pushing anywhere else — CI will tell
you if the branch name or checks are wrong before a human looks.
