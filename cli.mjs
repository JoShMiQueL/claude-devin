#!/usr/bin/env node
/**
 * claude-devin — run Claude Code on your Devin subscription.
 *
 * A wrapper for the `claude` CLI: starts a local Anthropic-compatible proxy
 * that forwards to Cognition's Cascade API, then launches `claude` with the
 * environment wired up. After `claude-devin login`, `claude-devin` behaves
 * exactly like `claude` — same flags, same session — just powered by Devin.
 *
 * Zero dependencies, Node >=18. The proxy bundle ships alongside this file.
 */

import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createInterface } from "node:readline"

// Version: read package.json next to cli.mjs when present (repo checkout);
// fall back to the stamped value for installed copies (no package.json there).
const __dir0 = dirname(fileURLToPath(import.meta.url))
const VERSION = (() => {
  try {
    const p = join(__dir0, "package.json")
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")).version ?? "0.0.0"
  } catch {}
  return "0.3.2" // stamped at release time — keep in sync with package.json
})()
const DEFAULT_PORT = 42100
const CLIENT_KEY = "devin-claude-local"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROXY_BUNDLE = join(__dirname, "proxy-bundle.mjs")

// --- paths (keep in sync with src/devin-anthropic-proxy/auth.ts) ---
const configRoot = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const CONFIG_DIR = join(configRoot, "devin-claude")
const CRED_PATH = join(CONFIG_DIR, "credentials.json")

const USAGE = `claude-devin ${VERSION} — Claude Code on your Devin subscription

claude-devin wraps \`claude\`: it starts a local Anthropic-compatible proxy
backed by your Devin subscription, then launches the real \`claude\` CLI with
the environment wired up. After \`claude-devin login\`, use it exactly like
\`claude\` — same flags, same behavior.

Usage:
  claude-devin [claude args...]   Start Claude Code powered by Devin.
  claude-devin <command>          A claude-devin management command (below).

Management commands:
  login [--manual]    Sign in with Devin (opens the browser).
                      --manual pastes the code instead (headless).
  logout              Remove the stored Devin credential.
  models              List the Devin model IDs your account can use.
  status              Check proxy + credential health.
  doctor              Diagnose missing deps / credentials.
  install-claude      Install the \`claude\` CLI if it's missing.
  upgrade             Re-download the latest proxy bundle.
  help                Show this help.
  version             Show the claude-devin version.

Everything else is forwarded to \`claude\` verbatim — including claude's own
\`--help\`, \`--version\`, and \`--model\` flags:

  claude-devin --help                  → claude --help
  claude-devin --version               → claude --version
  claude-devin resume                  → claude resume
  claude-devin -p "prompt"             → claude -p "prompt"
  claude-devin --model swe-2-high      → claude --model swe-2-high
  claude-devin --model glm-5-3-high -p "hi"
  --fast              Shorter answers: strips web/plan/subagent tools, terser style.

Environment:
  DEVIN_LLM_API_KEY   Devin session token (overrides the stored credential).
  ANTHROPIC_MODEL     Model UID (claude's --model flag wins).
  DEVIN_CLAUDE_PORT   Proxy port (default ${DEFAULT_PORT}).
  XDG_CONFIG_HOME     Config root (default ~/.config).
`

// ---------------------------------------------------------------------------
// helpers

const port = () => Number(process.env.DEVIN_CLAUDE_PORT) || DEFAULT_PORT
const proxyBase = () => `http://127.0.0.1:${port()}`
const authHeaders = () => ({ "x-api-key": CLIENT_KEY })

function fail(msg, code = 1) {
  console.error(`claude-devin: ${msg}`)
  process.exit(code)
}

function hasCredentials() {
  return !!(process.env.DEVIN_LLM_API_KEY?.trim() || existsSync(CRED_PATH))
}

function commandExists(name) {
  const checker = process.platform === "win32" ? "where" : "which"
  return spawnSync(checker, [name], { stdio: "ignore" }).status === 0
}

async function fetchJson(url, opts = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), ...opts })
    const body = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

async function proxyUp() {
  return (await fetchJson(`${proxyBase()}/health`)).ok
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// proxy lifecycle

let proxyProc = null
function cleanup() {
  if (proxyProc && !proxyProc.killed) proxyProc.kill("SIGTERM")
}
process.on("exit", cleanup)
process.on("SIGINT", () => process.exit(130))
process.on("SIGTERM", () => process.exit(143))

async function ensureProxy() {
  if (!existsSync(PROXY_BUNDLE)) {
    fail(`proxy bundle not found at ${PROXY_BUNDLE} — reinstall claude-devin`)
  }
  if (await proxyUp()) return // already running (e.g. a dev `devin-claude start`)

  proxyProc = spawn(process.execPath, [PROXY_BUNDLE], {
    stdio: ["ignore", "ignore", "pipe"],
    env: {
      ...process.env,
      DEVIN_CLAUDE_PORT: String(port()),
      DEVIN_CLAUDE_CLIENT_KEY: CLIENT_KEY,
    },
  })
  let proxyErr = ""
  proxyProc.stderr.on("data", (d) => (proxyErr += d))
  proxyProc.on("exit", (code) => {
    if (!shuttingDown && code !== 0 && code !== null) {
      console.error(`claude-devin: proxy exited (${code})${proxyErr ? ` — ${proxyErr.slice(-400)}` : ""}`)
    }
  })

  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    await sleep(250)
    if (await proxyUp()) {
      // Warm the catalog + user_jwt caches in the background so claude's
      // first /v1/messages doesn't pay the fetch cost. Fire-and-forget.
      fetch(`${proxyBase()}/v1/models`, { headers: authHeaders() }).catch(() => {})
      return
    }
    if (proxyProc.exitCode !== null) break
  }
  fail(`proxy did not come up on ${proxyBase()}${proxyErr ? ` — ${proxyErr.slice(-400)}` : ""}`)
}

let shuttingDown = false

// ---------------------------------------------------------------------------
// commands

async function cmdLogin(args) {
  const manual = args.includes("--manual")
  // The login flow lives in the TS sources (PKCE + loopback + token exchange).
  // We drive it through the bundled proxy module instead of duplicating it.
  const script =
    `import { loginAuto, loginManual } from ${JSON.stringify(pathToFileURL(PROXY_BUNDLE).href)};` +
    `const fn = ${manual ? "loginManual" : "loginAuto"};` +
    `const t = await fn(); if (!t) process.exit(1);` +
    `console.log("Signed in — credentials stored.");`
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: "inherit",
    env: process.env,
  })
  const code = await new Promise((r) => child.on("exit", r))
  if (code !== 0) fail("login failed", code)
}

async function cmdLogout() {
  const script =
    `import { clearCredentials, credentialsPath } from ${JSON.stringify(pathToFileURL(PROXY_BUNDLE).href)};` +
    `console.log(clearCredentials() ? "Credentials deleted: " + credentialsPath() : "No credentials found.");`
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" })
  const code = await new Promise((r) => child.on("exit", r))
  if (code !== 0) fail("logout failed", code)
}

async function cmdModels() {
  await ensureProxy()
  const res = await fetchJson(`${proxyBase()}/v1/models`, { headers: authHeaders() })
  if (!res.ok) fail(`models request failed (HTTP ${res.status ?? "n/a"})`)
  for (const m of res.body?.data ?? []) console.log(typeof m === "object" ? m.id : m)
}

/** Latest GitHub release tag (e.g. "v0.3.2"), or null if unreachable. */
async function latestRelease() {
  const res = await fetchJson(
    "https://api.github.com/repos/JoShMiQueL/claude-devin/releases/latest",
    { headers: { "User-Agent": "claude-devin" } },
  )
  return res.ok ? String(res.body?.tag_name ?? "").replace(/^v/, "") : null
}

/** Numeric semver-ish compare: is `latest` ahead of `current`? */
function isNewer(latest, current) {
  const pa = latest.split(".").map(Number)
  const pb = current.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

/** Version-update hint for status/doctor output. */
async function updateHint() {
  const latest = await latestRelease()
  if (!latest) return ""
  return isNewer(latest, VERSION)
    ? "  → v" + latest + " available — run `claude-devin upgrade`"
    : "  (latest)"
}

async function cmdStatus() {
  const up = await proxyUp()
  console.log(`proxy        : ${up ? `UP (${proxyBase()})` : `down (${proxyBase()})`}`)
  console.log(`credential   : ${hasCredentials() ? "present" : "MISSING"}`)
  console.log(`version      : ${VERSION}${await updateHint()}`)
  if (up) {
    const res = await fetchJson(`${proxyBase()}/v1/models`, { headers: authHeaders() })
    const n = Array.isArray(res.body?.data) ? res.body.data.length : null
    console.log(`catalog      : ${n === null ? "unavailable" : `${n} models`}`)
  }
  if (!hasCredentials()) console.log(`\nRun \`claude-devin login\` first.`)
}

async function cmdDoctor() {
  console.log(`claude-devin doctor`)
  console.log(`  version         : ${VERSION}${await updateHint()}`)
  console.log(`  node            : ${process.version}`)
  console.log(`  claude          : ${commandExists("claude") ? "found" : "NOT FOUND"}`)
  console.log(`  proxy bundle    : ${existsSync(PROXY_BUNDLE) ? "present" : "MISSING"}`)
  console.log(`  credentials     : ${hasCredentials() ? "present" : "MISSING"}`)
  console.log(`  credential file : ${CRED_PATH}`)
  console.log(`  proxy :${port()}   : ${(await proxyUp()) ? "reachable" : "unreachable"}`)
  if (!commandExists("claude")) {
    console.log(`\nClaude Code CLI not found. Install with:`)
    console.log(`  npm install -g @anthropic-ai/claude-code`)
    process.exit(1)
  }
  if (!hasCredentials()) {
    console.log(`\nRun \`claude-devin login\` to connect your Devin account.`)
    process.exit(1)
  }
}

async function cmdUpgrade() {
  const base = `https://raw.githubusercontent.com/JoShMiQueL/claude-devin/main`
  const files = [
    [`${base}/proxy-bundle.mjs`, PROXY_BUNDLE],
    [`${base}/cli.mjs`, fileURLToPath(import.meta.url)],
  ]
  for (const [url, dest] of files) {
    const name = dest.split(/[\\/]/).pop()
    console.log(`-> fetching ${name}…`)
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) fail(`download failed for ${name} (HTTP ${res.status})`)
    // Write to a temp file then rename over the target — overwriting the
    // running cli.mjs in place is unreliable on Windows (file is mmap'd).
    const tmp = dest + ".new"
    writeFileSync(tmp, await res.text())
    renameSync(tmp, dest)
    console.log(`✓ ${name} updated`)
  }
  console.log(`Restart claude-devin to pick up the new version.`)
}

function cmdInstallClaude() {
  if (commandExists("claude")) {
    console.log("claude is already installed.")
    return
  }
  if (!commandExists("npm")) {
    fail("npm not found — install Node.js first (https://nodejs.org)")
  }
  console.log("Installing Claude Code…")
  const r = spawnSync("npm", ["install", "-g", "@anthropic-ai/claude-code"], { stdio: "inherit" })
  if (r.status !== 0) fail("claude install failed")
  console.log("Done. Run `claude-devin` to start.")
}

// ---------------------------------------------------------------------------
// main: default action = behave like `claude`

async function cmdRun(claudeArgs) {
  if (!commandExists("claude")) {
    console.error("claude-devin: `claude` CLI not found.")
    console.error("Install it with:  claude-devin install-claude   (or: npm install -g @anthropic-ai/claude-code)")
    process.exit(1)
  }
  if (!hasCredentials()) {
    console.error("claude-devin: no Devin credential found.")
    console.error("Run `claude-devin login` first (opens your browser).")
    process.exit(1)
  }
  await ensureProxy()

  // claude resolves its API key from ANTHROPIC_API_KEY first (then
  // ANTHROPIC_AUTH_TOKEN / apiKeyHelper). A pre-existing ANTHROPIC_API_KEY in
  // the user's environment or settings would clobber our local client key and
  // 401 against the proxy — set BOTH to the same loopback key.
  // `--model` is claude's own flag and reaches it via claudeArgs, so we don't
  // intercept it — `claude-devin --model x` ≡ `claude --model x`.
  const fast = claudeArgs.includes("--fast")
  const args = fast ? claudeArgs.filter((a) => a !== "--fast") : claudeArgs
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: proxyBase() + (fast ? "/fast" : ""),
    ANTHROPIC_API_KEY: CLIENT_KEY,
    ANTHROPIC_AUTH_TOKEN: CLIENT_KEY,
    // Devin model by default — --model / ANTHROPIC_MODEL / settings still win.
    ANTHROPIC_DEFAULT_MODEL: process.env.ANTHROPIC_DEFAULT_MODEL ?? "swe-2-high",
    // Our proxy can't serve server-side auto-mode classifier checks — tell
    // claude to use its own (billed) classifier instead of warning about it.
    CLAUDE_CODE_AUTO_MODE_SERVER: process.env.CLAUDE_CODE_AUTO_MODE_SERVER ?? "0",
    // Claude Code doesn't know Devin model IDs; declare the real window so it
    // stops warning "context assumed to be 200k" (swe-2-high is ~200k anyway).
    CLAUDE_CODE_MAX_CONTEXT_TOKENS:
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? "200000",
    // Let `claude /model` discover the ~140 models our proxy exposes.
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:
      process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "1",
  }
  const claude = spawn("claude", args, { stdio: "inherit", env })
  shuttingDown = false
  const code = await new Promise((r) => claude.on("exit", r))
  shuttingDown = true
  process.exit(code ?? 0)
}

// ---------------------------------------------------------------------------
// entrypoint

const argv = process.argv.slice(2)
const cmd = argv[0]

// Only claude-devin's own verbs are intercepted. Everything else — including
// flags like --help, --version, -p, --model — is forwarded to `claude`.
switch (cmd) {
  case "login":          await cmdLogin(argv.slice(1)); break
  case "logout":         await cmdLogout(); break
  case "models":         await cmdModels(); break
  case "status":         await cmdStatus(); break
  case "doctor":         await cmdDoctor(); break
  case "install-claude": cmdInstallClaude(); break
  case "upgrade":        await cmdUpgrade(); break
  case "help":           console.log(USAGE); break
  case "version":        console.log(VERSION); break
  default:               await cmdRun(argv); break // every other arg is claude's
}
