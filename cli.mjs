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
import { existsSync, mkdirSync, writeFileSync, readFileSync, readSync, renameSync, openSync, closeSync, unlinkSync, statSync } from "node:fs"
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
  return "0.4.0" // stamped at release time — keep in sync with package.json
})()
const DEFAULT_PORT = 42100
const CLIENT_KEY = "devin-claude-local"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROXY_BUNDLE = join(__dirname, "proxy-bundle.mjs")

// --- service instances -------------------------------------------------------
// The "main" instance is the shared default: every `claude-devin` run reuses
// it (port 42100, proxy.pid/proxy.log). `--instance <name>` (or
// DEVIN_CLAUDE_INSTANCE) runs an isolated service instead — its own port,
// pid and log — so several claude sessions can coexist without sharing state.
// An explicit DEVIN_CLAUDE_PORT always wins over the derived port.

/** FNV-1a-ish hash → a stable per-name port offset. */
function nameOffset(name) {
  let h = 0x811c9dc5
  for (const ch of String(name)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h % 500 // ports 42101–42600 stay clear of the main 42100
}

const VALID_INSTANCE = /^[A-Za-z0-9_-]+$/

function resolveInstance() {
  const args = process.argv.slice(2)
  let name = process.env.DEVIN_CLAUDE_INSTANCE ?? null
  const i = args.indexOf("--instance")
  if (i >= 0) name = args[i + 1] ?? null
  if (name !== null && !VALID_INSTANCE.test(name)) {
    fail(`--instance expects [A-Za-z0-9_-], got '${name}'`)
  }
  const isolated = name !== null && name !== "main"
  const suffix = isolated ? `-${name}` : ""
  return {
    name: isolated ? name : "main",
    port: Number(process.env.DEVIN_CLAUDE_PORT) || (isolated ? DEFAULT_PORT + 1 + nameOffset(name) : DEFAULT_PORT),
    pidFile: join(__dirname, `proxy${suffix}.pid`),
    logFile: join(__dirname, `proxy${suffix}.log`),
  }
}

const INSTANCE = resolveInstance()
const PROXY_PID = INSTANCE.pidFile
const PROXY_LOG = INSTANCE.logFile

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
  service <cmd>       Manage the background proxy service:
                        start    spawn the proxy detached (survives sessions)
                        stop     kill the detached proxy
                        restart  stop + start
                        status   show service state (PID, health)
                        logs [N] tail -f the proxy log (last N lines, then follow)
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
  --shell S           Shell for claude's tools: bash | powershell | auto (default auto).
  --instance NAME     Run against an isolated proxy service named NAME instead of
                      the shared "main" one — its own port, pid and log. Lets
                      several claude sessions run side by side without sharing
                      state. Defaults to the shared main service.

Environment:
  DEVIN_LLM_API_KEY   Devin session token (overrides the stored credential).
  ANTHROPIC_MODEL     Model UID (claude's --model flag wins).
  DEVIN_CLAUDE_PORT   Proxy port (default ${DEFAULT_PORT} for the main service;
                      isolated instances get a per-name port unless this is set).
  DEVIN_CLAUDE_INSTANCE  Default instance name (like --instance).
  XDG_CONFIG_HOME     Config root (default ~/.config).
`

// ---------------------------------------------------------------------------
// helpers

const port = () => INSTANCE.port
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
// proxy lifecycle — the proxy always runs as a detached background service.
// First `claude-devin` invocation spawns it; later ones reuse it for free.

async function ensureProxy() {
  if (!existsSync(PROXY_BUNDLE)) {
    fail(`proxy bundle not found at ${PROXY_BUNDLE} — reinstall claude-devin`)
  }
  if (await proxyUp()) return // service already running — reuse it

  // Rotate the log when it grows past ~5 MB: proxy.log -> proxy.log.1
  // (previous .1 is discarded — two generations max, enough for bug reports).
  try {
    const size = statSync(PROXY_LOG).size
    if (size > 5 * 1024 * 1024) renameSync(PROXY_LOG, PROXY_LOG + ".1")
  } catch {
    // No log yet, or already rotated — either is fine.
  }

  // Spawn detached so the proxy survives this process (persistent service).
  const out = openSync(PROXY_LOG, "a")
  const child = spawn(process.execPath, [PROXY_BUNDLE], {
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      DEVIN_CLAUDE_PORT: String(port()),
      DEVIN_CLAUDE_CLIENT_KEY: CLIENT_KEY,
    },
  })
  child.unref()
  writeFileSync(PROXY_PID, String(child.pid))

  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    await sleep(250)
    if (await proxyUp()) {
      // Warm the catalog + user_jwt caches in the background so claude's
      // first /v1/messages doesn't pay the fetch cost. Fire-and-forget.
      fetch(`${proxyBase()}/v1/models`, { headers: authHeaders() }).catch(() => {})
      return
    }
    if (child.exitCode !== null) break
  }
  fail(`proxy did not come up on ${proxyBase()} — see ${PROXY_LOG}`)
}

// ---------------------------------------------------------------------------
// update check — one GitHub fetch per 24h, cached on disk; stderr only.

const UPDATE_CACHE = join(__dirname, ".last-update-check")

async function maybeNotifyUpdate() {
  try {
    const last = existsSync(UPDATE_CACHE) ? Number(readFileSync(UPDATE_CACHE, "utf8").trim()) : 0
    if (Date.now() - last < 24 * 3600 * 1000) return
    writeFileSync(UPDATE_CACHE, String(Date.now()))
    const latest = await latestRelease()
    if (latest && isNewer(latest, VERSION)) {
      console.error(`claude-devin: v${latest} available (you run ${VERSION}) — \`claude-devin upgrade\``)
    }
  } catch {
    // Never block a session on the update check.
  }
}

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

// ---------------------------------------------------------------------------
// background service — `claude-devin service <start|stop|restart|status>`

function servicePid() {
  try {
    const pid = Number(readFileSync(PROXY_PID, "utf8").trim())
    if (!pid) return null
    // Check the process is alive (signal 0 = existence probe).
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

async function cmdService(args) {
  // `--instance NAME` (and the value) is consumed by resolveInstance() from
  // process.argv; drop it here so `service --instance x start` reads `start`
  // as the subcommand rather than the flag.
  const cleaned = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--instance") { i++; continue }
    cleaned.push(args[i])
  }
  const sub = cleaned[0] ?? "status"
  switch (sub) {
    case "start": {
      if (await proxyUp()) {
        console.log(`service already running on ${proxyBase()} (pid ${servicePid() ?? "?"})`)
        return
      }
      await ensureProxy()
      console.log(`service started — pid ${servicePid() ?? "?"}, ${proxyBase()}, log ${PROXY_LOG}`)
      break
    }
    case "stop": {
      const pid = servicePid()
      if (!pid) {
        console.log("service not running (no pid / not alive)")
        try { unlinkSync(PROXY_PID) } catch {}
        return
      }
      try {
        process.kill(pid, "SIGTERM")
        console.log(`service stopped (pid ${pid})`)
      } catch (e) {
        fail(`could not stop pid ${pid}: ${e.message}`)
      }
      try { unlinkSync(PROXY_PID) } catch {}
      break
    }
    case "restart": {
      await cmdService(["stop"])
      await sleep(400)
      await cmdService(["start"])
      break
    }
    case "status": {
      const pid = servicePid()
      const up = await proxyUp()
      console.log(`service      : ${up ? `UP (${proxyBase()})` : "down"}`)
      console.log(`instance     : ${INSTANCE.name}`)
      console.log(`pid          : ${pid ?? "none"}`)
      if (existsSync(PROXY_LOG)) console.log(`log          : ${PROXY_LOG}`)
      break
    }
    case "logs": {
      // tail -f equivalent: print last N lines, then stream new data.
      if (!existsSync(PROXY_LOG)) {
        console.log(`no log yet at ${PROXY_LOG}`)
        return
      }
      const tailLines = Number(cleaned[1]) || 50
      const content = readFileSync(PROXY_LOG, "utf8")
      const lines = content.split(/\r?\n/)
      console.log(lines.slice(-tailLines).join("\n"))
      // Follow: poll the file for growth every second.
      let offset = statSync(PROXY_LOG).size
      console.error("--- following (Ctrl+C to stop) ---")
      for (;;) {
        await sleep(1000)
        try {
          const size = statSync(PROXY_LOG).size
          if (size < offset) offset = 0 // rotated
          if (size > offset) {
            const fd = openSync(PROXY_LOG, "r")
            const buf = Buffer.alloc(size - offset)
            readSync(fd, buf, 0, buf.length, offset)
            closeSync(fd)
            process.stdout.write(buf.toString("utf8"))
            offset = size
          }
        } catch {
          /* log briefly missing during rotation */
        }
      }
    }
    default:
      fail(`unknown service command '${sub}' — use start|stop|restart|status`)
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
  maybeNotifyUpdate() // fire-and-forget, cached 24h

  // claude-devin's own flags — stripped before forwarding to claude.
  const fast = claudeArgs.includes("--fast")
  const shellIdx = claudeArgs.indexOf("--shell")
  const instIdx = claudeArgs.indexOf("--instance")
  const shellArg = shellIdx >= 0 ? claudeArgs[shellIdx + 1] : null
  // Strip claude-devin-only flags (and their values) before forwarding to claude.
  const dropIdx = new Set()
  for (const i of [shellIdx, instIdx]) {
    if (i >= 0) { dropIdx.add(i); dropIdx.add(i + 1) }
  }
  const args = claudeArgs.filter((a, i) => a !== "--fast" && !dropIdx.has(i))
  if (shellIdx >= 0 && !["bash", "powershell", "pwsh", "auto"].includes(shellArg ?? "")) {
    fail(`--shell expects bash|powershell|auto, got '${shellArg ?? "(missing)"}'`)
  }

  // Session marker in the proxy log — lets `service logs` (and bug reports)
  // be split by invocation: each run leaves one `session s...` line with
  // pid, args, and mode before claude's traffic starts.
  const sessionId = `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  fetch(`${proxyBase()}/mark`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      session: sessionId,
      pid: process.pid,
      fast,
      instance: INSTANCE.name,
      args: args.join(" ").slice(0, 200) || "(interactive)",
      v: VERSION,
    }),
  }).catch(() => {})

  // claude resolves its API key from ANTHROPIC_API_KEY first (then
  // ANTHROPIC_AUTH_TOKEN / apiKeyHelper). A pre-existing ANTHROPIC_API_KEY in
  // the user's environment or settings would clobber our local client key and
  // 401 against the proxy — set BOTH to the same loopback key.
  // `--model` is claude's own flag and reaches it via claudeArgs, so we don't
  // intercept it — `claude-devin --model x` ≡ `claude --model x`.
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: proxyBase() + (fast ? "/fast" : ""),
    ANTHROPIC_API_KEY: CLIENT_KEY,
    ANTHROPIC_AUTH_TOKEN: CLIENT_KEY,
    // Devin model by default. ANTHROPIC_MODEL wins over settings files and
    // ANTHROPIC_DEFAULT_MODEL — set it explicitly so `claude-devin` always
    // uses the Devin backend unless the user passes --model themselves.
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? "swe-2-high",
    ANTHROPIC_DEFAULT_MODEL: process.env.ANTHROPIC_DEFAULT_MODEL ?? "swe-2-high",
    // Our proxy can't serve server-side auto-mode classifier checks — tell
    // claude to use its own (billed) classifier instead of warning about it.
    CLAUDE_CODE_AUTO_MODE_SERVER: process.env.CLAUDE_CODE_AUTO_MODE_SERVER ?? "0",
    // The auto-mode classifier calls a separate model (default: claude-sonnet-5)
    // to judge each tool call — on our backend that model doesn't exist, so
    // every action pays a 502 retry chain. Run the classifier on the Devin
    // model instead (v2.1.302+); users on older claude versions should pass
    // --permission-mode acceptEdits/bypassPermissions themselves.
    CLAUDE_CODE_AUTO_MODE_MODEL:
      process.env.CLAUDE_CODE_AUTO_MODE_MODEL ?? "swe-2-high",
    // Claude Code doesn't know Devin model IDs; declare the real window so it
    // stops warning "context assumed to be 200k" (swe-2-high is ~200k anyway).
    CLAUDE_CODE_MAX_CONTEXT_TOKENS:
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? "200000",
    // Let `claude /model` discover the ~140 models our proxy exposes.
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:
      process.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY ?? "1",
  }

  // --shell bash|powershell|auto: pick the shell claude's tools run under.
  // `auto` (default) leaves claude's own detection alone. On Windows, `bash`
  // also puts Git's bin dir on PATH so `bash`/`sh` resolve even when Git
  // wasn't installed system-wide on PATH.
  if (shellArg === "bash" || shellArg === "sh") {
    const gitBins = [
      process.env.GIT_BASH_PATH,
      "C:/Program Files/Git/bin",
      "C:/Program Files (x86)/Git/bin",
    ].filter(Boolean)
    const gitBin = gitBins.find((d) => existsSync(join(d, "bash.exe")))
    if (gitBin) env.PATH = `${gitBin};${env.PATH ?? env.Path ?? ""}`
    env.SHELL = gitBin ? join(gitBin, "bash.exe") : "bash"
    env.CLAUDE_CODE_GIT_BASH_PATH = env.SHELL // honored by claude on win32
  } else if (shellArg === "powershell" || shellArg === "pwsh") {
    const ps = commandExists("pwsh") ? "pwsh.exe" : "powershell.exe"
    env.SHELL = ps
    delete env.CLAUDE_CODE_GIT_BASH_PATH
  } else if (shellArg === "auto") {
    delete env.SHELL
  }

  const claude = spawn("claude", args, { stdio: "inherit", env })
  const startedAt = Date.now()
  const code = await new Promise((r) => claude.on("exit", r))

  // Session-end marker — pairs with the `session …` line logged at start.
  // Await with a short timeout: the fetch must land before process.exit.
  try {
    await Promise.race([
      fetch(`${proxyBase()}/mark`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          session: sessionId + "-end",
          ms: Date.now() - startedAt,
          exit: code ?? 0,
        }),
      }),
      sleep(1500),
    ])
  } catch {}
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
  case "service":        await cmdService(argv.slice(1)); break
  case "help":           console.log(USAGE); break
  case "version":        console.log(VERSION); break
  default:               await cmdRun(argv); break // every other arg is claude's
}
