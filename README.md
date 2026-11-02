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
| `claude-devin install-claude` | Install the `claude` CLI if missing. |
| `claude-devin logout` | Remove stored credentials. |
| `claude-devin <anything else>` | Forwarded to `claude` verbatim. |

Pick a model with `ANTHROPIC_MODEL` (e.g. `swe-2-high`, `glm-5-3-high`,
`claude-opus-5-5-high` — run `claude-devin models` for the full list of the
~140 your account exposes).

## How it works

```
claude-devin
  ├─ starts a local Anthropic-compatible proxy on 127.0.0.1:42100
  │    └─ translates /v1/messages + /v1/models into Cascade gRPC
  │       calls against server.codeium.com (reverse-engineered, same
  │       as opencode-devin's src/protocol/)
  └─ launches `claude` with
        ANTHROPIC_BASE_URL = http://127.0.0.1:42100
        ANTHROPIC_API_KEY  = devin-claude-local
        ANTHROPIC_AUTH_TOKEN = devin-claude-local
```

Claude Code never knows it isn't talking to Anthropic. Your Devin session
token (obtained once via `login`) mints short-lived `user_jwt`s for the
Cascade RPCs; the local key only protects the loopback proxy.

## Claude Code plugin (optional)

The `claude-devin/` directory is also a valid Claude Code plugin: load it
with `claude --plugin-dir <path>` to get `/devin:login`, `/devin:models`,
and `/devin:status` slash commands inside Claude Code.

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
