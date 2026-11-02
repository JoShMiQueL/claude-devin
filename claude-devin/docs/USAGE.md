# Usage — verified end-to-end flow

Prereqs: Node ≥18 (bun or Node ≥22.6 runs the TypeScript proxy sources),
Claude Code, a Devin subscription.

## 1. Log in

```sh
bin/devin-claude login            # browser PKCE flow
bin/devin-claude login --manual   # paste the authorization code instead
```

Inside Claude Code: `/devin:login` (add `--manual` for the paste flow).

Stores `devin-session-token$<jwt>` at
`~/.config/devin-claude/credentials.json` (mode 0600; honors
`XDG_CONFIG_HOME`). `DEVIN_LLM_API_KEY` overrides the file.

## 2. Start the proxy

```sh
bin/devin-claude start            # binds 127.0.0.1:42100
bin/devin-claude start --port N   # custom port (or DEVIN_CLAUDE_PORT)
```

Health: `curl http://127.0.0.1:42100/health` → `{"status":"ok"}`.

## 3. Point Claude Code at the proxy

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:42100
export ANTHROPIC_AUTH_TOKEN=devin-claude-local
claude
```

Or one step:

```sh
bin/devin-claude launch           # starts proxy if needed, spawns `claude` with env set
```

The auth token is a fixed loopback key (not your Devin credential); every
request must send it as `x-api-key` or `authorization: Bearer`, else 401.

## 4. Verify

```sh
bin/devin-claude status           # proxy up? catalog size?
bin/devin-claude models           # list Cascade model IDs
bin/devin-claude doctor           # credentials + proxy + env diagnostic
```

Slash commands: `/devin:status`, `/devin:models`.

Model IDs in `/v1/messages` requests accept `claude-*`, `swe-*`, `glm-*`
UIDs, optionally `devin/`-prefixed; unknown IDs return 400 listing the
valid IDs.

## Logout

```sh
bin/devin-claude logout           # deletes the credential file
```
