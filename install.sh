#!/usr/bin/env bash
# claude-devin installer — macOS / Linux / WSL.
# Usage:  curl -fsSL https://raw.githubusercontent.com/JoShMiQueL/claude-devin/main/install.sh | bash
set -euo pipefail

REPO="JoShMiQueL/claude-devin"
BRANCH="main"
BASE="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
BIN_DIR="${HOME}/.local/bin"
APP_DIR="${HOME}/.claude-devin"

need() { command -v "$1" >/dev/null 2>&1 || { echo "claude-devin: '$1' is required" >&2; exit 1; }; }
need curl
need node   # Node >=18

mkdir -p "$APP_DIR" "$BIN_DIR"

echo "→ downloading claude-devin…"
curl -fsSL "${BASE}/cli.mjs"          -o "${APP_DIR}/cli.mjs"
curl -fsSL "${BASE}/proxy-bundle.mjs" -o "${APP_DIR}/proxy-bundle.mjs"

cat > "${BIN_DIR}/claude-devin" <<EOF
#!/usr/bin/env bash
exec node "${APP_DIR}/cli.mjs" "\$@"
EOF
chmod +x "${BIN_DIR}/claude-devin"

echo ""
echo "✓ installed to ${APP_DIR}"
echo "✓ launcher at ${BIN_DIR}/claude-devin"
echo ""
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) echo "⚠  ${BIN_DIR} is not in your PATH. Add it:"
     echo "     export PATH=\"${BIN_DIR}:\$PATH\"   # add to ~/.bashrc or ~/.zshrc"
     echo "";;
esac
echo "Next:"
echo "  claude-devin install-claude   # if you don't have Claude Code yet"
echo "  claude-devin login            # sign in with Devin"
echo "  claude-devin                  # start claude on your Devin subscription"
