/**
 * PKCE login for the devin-claude CLI (Node ≥18).
 *
 * Reuses the vendored, runtime-agnostic pieces of `src/auth/` (pkce, url,
 * exchange) but re-implements the loopback server and browser launch with
 * `node:http` / `node:child_process` — the vendored `loopback.ts` and
 * `browser.ts` are Bun-only.
 *
 * Both flows end in `exchangeCode` → `devin-session-token$<jwt>` →
 * `saveCredentials`. Nothing here prints the token or the auth code.
 */

import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createInterface } from "node:readline"

import { CALLBACK_PATH } from "../constants.ts"
import { exchangeCode } from "../auth/exchange.ts"
import { challengeFor, generateState, generateVerifier } from "../auth/pkce.ts"
import { authorizeUrl } from "../auth/url.ts"
import { saveCredentials, type StoredCredential } from "./auth.ts"

/** How long the loopback listener waits for the browser redirect. */
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000

/** Shape of the credential persisted by the login flows. */
export function toStoredCredential(token: string): StoredCredential {
  return saveCredentials({ apiKey: token, apiServerUrl: undefined })
}

/** Render the minimal success/error page shown in the browser after login. */
const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${body}</p></body></html>`

/** Open a URL in the system browser (best-effort, fire-and-forget). */
function openBrowser(url: string): void {
  const detached = { detached: true, stdio: "ignore" as const }
  if (process.platform === "win32") {
    // `cmd /c start` truncates URLs at "&"; rundll32 passes it verbatim.
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], detached).unref()
    return
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open"
  spawn(cmd, [url], detached).unref()
}

interface LoopbackWaiter {
  redirectUri: string
  /** Resolves with the authorization code once the browser redirects back. */
  code: Promise<string>
  close: () => void
}

/** One-shot HTTP server on 127.0.0.1 that captures `GET /callback?code=…`. */
function startCallbackServer(state: string, timeoutMs = CALLBACK_TIMEOUT_MS): Promise<LoopbackWaiter> {
  return new Promise((resolve, reject) => {
    let settle: ((code: string) => void) | undefined
    let fail: ((error: Error) => void) | undefined
    const code = new Promise<string>((res, rej) => {
      settle = res
      fail = rej
    })

    let stopped = false
    let timer: NodeJS.Timeout | undefined
    const stop = () => {
      if (stopped) return
      stopped = true
      if (timer) clearTimeout(timer)
      server.close()
    }

    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const send = (status: number, title: string, body: string) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
        res.end(page(title, body))
      }
      if (url.pathname !== CALLBACK_PATH) return send(404, "Not found", "")
      if (url.searchParams.get("state") !== state) {
        return send(400, "Invalid state parameter", "This may indicate a security issue. Please try again.")
      }
      const received = url.searchParams.get("code")
      if (!received) {
        return send(400, "No authorization code received", "Please return to the terminal and try again.")
      }
      settle?.(received)
      if (timer) clearTimeout(timer)
      return send(200, "Signed in to Devin", "You can close this tab and return to the terminal.")
    })

    server.once("error", (cause) => reject(cause instanceof Error ? cause : new Error("Failed to bind loopback server")))
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo
      timer = setTimeout(() => {
        fail?.(new Error(`Login timed out after ${Math.round(timeoutMs / 1000)}s`))
        stop()
      }, timeoutMs)
      resolve({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        code,
        close: () => {
          fail?.(new Error("Login cancelled"))
          stop()
        },
      })
    })
  })
}

/**
 * Automatic login: bind the loopback callback server, open the browser, wait
 * for the redirect, exchange the code, and store the session token.
 */
export async function loginAuto(): Promise<string> {
  const verifier = generateVerifier()
  const state = generateState()
  const server = await startCallbackServer(state)
  const url = authorizeUrl({ state, challenge: await challengeFor(verifier), redirectUri: server.redirectUri })

  console.log("Opening Devin sign-in in your browser…")
  console.log(`If it does not open, visit:\n${url}`)
  openBrowser(url)

  try {
    const code = await server.code
    const token = await exchangeCode({ code, verifier })
    toStoredCredential(token)
    return token
  } finally {
    server.close()
  }
}

/**
 * Manual login: print the authorize URL (no redirect_uri → the webapp shows a
 * code), read the pasted code from stdin, exchange it, and store the token.
 */
export async function loginManual(readLine?: () => Promise<string>): Promise<string> {
  const verifier = generateVerifier()
  const state = generateState()
  const url = authorizeUrl({ state, challenge: await challengeFor(verifier) })

  console.log("Open this URL in your browser and paste the code it shows:")
  console.log(url)

  const prompt =
    readLine ??
    (() => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      return new Promise<string>((resolve) => {
        rl.question("Authorization code: ", (answer) => {
          rl.close()
          resolve(answer)
        })
      })
    })

  const code = (await prompt()).trim()
  if (!code) throw new Error("Manual login requires the pasted authorization code")
  const token = await exchangeCode({ code, verifier })
  toStoredCredential(token)
  return token
}
