/**
 * Local Anthropic-compatible HTTP proxy → Cascade (Devin) backend.
 *
 * Binds 127.0.0.1 only. Every route except `/health` requires the loopback
 * client key (`x-api-key` or `authorization: Bearer`) — the real credential is
 * the Devin session token resolved by `getApiKey()`.
 *
 * Access logging prints method + path + status only; headers, bodies, and
 * tokens are never logged. Node ≥18 ESM, zero npm dependencies.
 */

import { createServer as httpCreateServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

import { getApiKey, loadCredentials, LOCAL_CLIENT_KEY } from "./auth.ts"
import { contextWindowFor, getAnthropicModel, listAnthropicModels, ModelNotFoundError, resolveModelId } from "./models.ts"
import {
  anthropicToChat,
  chatToAnthropicResponse,
  countTokens,
  sseSerialize,
  streamChatEventsAsAnthropic,
  type AnthropicRequest,
} from "./anthropic.ts"
import { getCachedCatalog } from "../protocol/catalog.ts"
import { CloudChatError, type StreamChatRequest } from "../protocol/chat.ts"

const DEFAULT_PORT = 42_100
const MAX_BODY_BYTES = 32 * 1024 * 1024

// --- logging ---------------------------------------------------------------
// Levels: error < warn < info < debug. DEVIN_CLAUDE_LOG_LEVEL selects the
// threshold; default "info" keeps startup + abnormal requests + upstream
// errors, without the per-request noise (health probes poll every 250ms).
type LogLevel = "error" | "warn" | "info" | "debug"
const LOG_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 }
const LOG_THRESHOLD: number =
  LOG_ORDER[(process.env.DEVIN_CLAUDE_LOG_LEVEL ?? "info").toLowerCase() as LogLevel] ??
  LOG_ORDER.info

function logAt(level: LogLevel, msg: string): void {
  if (LOG_ORDER[level] > LOG_THRESHOLD) return
  const line = `[${new Date().toISOString()}] [devin-proxy] ${level.toUpperCase()} ${msg}`
  if (level === "error") console.error(line)
  else console.log(line)
}
export const log = {
  error: (m: string) => logAt("error", m),
  warn: (m: string) => logAt("warn", m),
  info: (m: string) => logAt("info", m),
  debug: (m: string) => logAt("debug", m),
}

/** Short request id — correlates request start/finish/upstream-error lines. */
let reqSeq = 0
const nextRid = (): string => `r${(++reqSeq).toString(36)}`

type JsonObject = Record<string, unknown>

/** Per-request finish line, tagged with the request id so it can be joined
 * with upstream-error lines: 5xx are warn-worthy; the rest is debug noise
 * (health probes from the CLI poll every 250ms on startup). */
const logRequest = (rid: string, method: string, path: string, status: number, ms: number): void => {
  const line = `${method} ${path} -> ${status} ${ms}ms [${rid}]`
  // /v1/messages is the only request that matters at info level — log it
  // always (success or failure) so service logs show real traffic, while
  // health/models probes stay at debug.
  if (path === "/v1/messages") {
    if (status >= 400) log.warn(line)
    else log.info(line)
  } else if (status >= 500) log.warn(line)
  else if (status >= 400 && path !== "/api/hello") log.info(line)
  else log.debug(line)
}

/** Compact fingerprint of a credential for 401 logs — never the full key. */
const fp = (s: string | null) =>
  s === null ? "null" : `len=${s.length} head="${s.slice(0, 6)}" tail="${s.slice(-4)}"`

interface RequestCtx {
  rid: string
  method: string
  path: string
  t0: number
}

/** Write a JSON response and emit the per-request finish log line. */
const sendJson = (res: ServerResponse, ctx: RequestCtx, status: number, body: JsonObject): void => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) })
  res.end(payload)
  logRequest(ctx.rid, ctx.method, ctx.path, status, Date.now() - ctx.t0)
}

/** Write a JSON error envelope and emit the finish log line. */
const sendError = (res: ServerResponse, ctx: RequestCtx, status: number, type: string, message: string): void => {
  sendJson(res, ctx, status, errorBody(type, message))
}

const errorBody = (type: string, message: string): JsonObject => ({
  type: "error",
  error: { type, message },
})

/** Tools stripped in --fast mode: web + planning + subagent tools claude rarely needs. */
const FAST_DROP_TOOLS = new Set([
  "WebFetch", "WebSearch", "Task", "AskUserQuestion",
  "EnterPlanMode", "ExitPlanMode", "NotebookEdit",
])

export interface ProxyServerOptions {
  port?: number
  clientKey?: string
}

export interface ProxyServer {
  server: Server
  port: number
}

/** Read the request body, enforcing a size cap. Rejects on overflow. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on("data", (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        rejectPromise(new Error("request body too large"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolvePromise(Buffer.concat(chunks)))
    req.on("error", rejectPromise)
  })
}

/**
 * Extract the loopback client key. Claude Code (and the Anthropic SDKs)
 * may send it under `x-api-key`, `authorization` (Bearer or raw), or
 * `anthropic-api-key`; accept any of them.
 */
function clientKeyOf(req: IncomingMessage): string | null {
  for (const name of ["x-api-key", "anthropic-api-key", "api-key"] as const) {
    const v = req.headers[name]
    if (typeof v === "string" && v) return v
  }
  const auth = req.headers.authorization
  if (typeof auth === "string" && auth) {
    return auth.startsWith("Bearer ") ? auth.slice(7) : auth
  }
  return null
}

export async function createServer(options: ProxyServerOptions = {}): Promise<ProxyServer> {
  const clientKey = options.clientKey ?? process.env.DEVIN_CLAUDE_CLIENT_KEY ?? LOCAL_CLIENT_KEY
  const wantedPort = options.port ?? (Number(process.env.DEVIN_CLAUDE_PORT) || DEFAULT_PORT)

  // Set once a catalog fetch has succeeded; surfaced on /health.
  const state: { catalogSize?: number } = {}
  const noteCatalog = async (apiKey: string): Promise<void> => {
    try {
      const catalog = await getCachedCatalog(apiKey)
      if (catalog) state.catalogSize = catalog.byUid.size
    } catch {
      // Catalog is best-effort; /health simply omits catalogSize.
    }
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET"
    const t0 = Date.now()
    const rid = nextRid()
    const rawPath = (new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/")
    const fast = rawPath === "/fast" || rawPath.startsWith("/fast/")
    const path = fast ? rawPath.slice("/fast".length) || "/" : rawPath
    const ctx = { rid, method, path, t0 }

    // --- unauthenticated route ---
    if (path === "/health") {
      if (method !== "GET") {
        sendError(res, ctx, 405, "not_found_error", `Method ${method} not allowed`)
        return
      }
      const body: JsonObject = { status: "ok" }
      if (state.catalogSize !== undefined) body.catalogSize = state.catalogSize
      body.authenticated = getApiKey() !== null
      sendJson(res, ctx, 200, body)
      return
    }

    // --- session marker (authenticated; writes one line so the log can be
    //     split by session when reporting bugs) ---
    if (path === "/mark") {
      const presentedKey = clientKeyOf(req)
      if (presentedKey !== clientKey) {
        sendError(res, ctx, 401, "authentication_error", "invalid x-api-key")
        return
      }
      if (method !== "POST") {
        sendError(res, ctx, 405, "not_found_error", `Method ${method} not allowed`)
        return
      }
      const bodyBuf = await readBody(req).catch(() => null)
      let meta: JsonObject = {}
      try { meta = bodyBuf ? (JSON.parse(bodyBuf.toString("utf8")) as JsonObject) : {} } catch {}
      const sid = typeof meta.session === "string" ? meta.session.slice(0, 40) : "?"
      const details = Object.entries(meta)
        .filter(([k]) => k !== "session")
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ")
      log.info(`session ${sid} ${details}`.trim())
      sendJson(res, ctx, 200, { ok: true })
      return
    }

    // --- known authenticated paths (for 405 vs 404) ---
    const isMessages = path === "/v1/messages"
    const isCountTokens = path === "/v1/messages/count_tokens"
    const isModels = path === "/v1/models"
    const modelIdMatch = path.startsWith("/v1/models/") ? decodeURIComponent(path.slice("/v1/models/".length)) : null
    const knownPath = isMessages || isCountTokens || isModels || modelIdMatch !== null

    if (!knownPath) {
      sendError(res, ctx, 404, "not_found_error", `Not found: ${path}`)
      return
    }

    // --- client-key middleware ---
    const presentedKey = clientKeyOf(req)
    if (presentedKey !== clientKey) {
      // Debug aid: never log the presented key itself, only which header
      // carried it and whether it was absent vs mismatched.
      const whichHeader = req.headers["x-api-key"]
        ? "x-api-key"
        : req.headers["anthropic-api-key"]
          ? "anthropic-api-key"
          : req.headers["api-key"]
            ? "api-key"
            : req.headers.authorization
              ? "authorization"
              : "none"
      log.warn(
        `401 auth on ${path}: header=${whichHeader} ${presentedKey === null ? "absent" : `mismatch ${fp(presentedKey)} (expected ${fp(clientKey)})`}`,
      )
      sendError(res, ctx, 401, "authentication_error", "invalid x-api-key")
      return
    }

    const apiKey = getApiKey() ?? ""

    // --- GET /v1/models ---
    if (isModels || modelIdMatch !== null) {
      if (method !== "GET") {
        sendError(res, ctx, 405, "not_found_error", `Method ${method} not allowed`)
        return
      }
      if (modelIdMatch !== null) {
        const model = await getAnthropicModel(modelIdMatch, apiKey)
        await noteCatalog(apiKey)
        if (!model) {
          sendError(res, ctx, 404, "not_found_error", `model: ${modelIdMatch}`)
          return
        }
        sendJson(res, ctx, 200, model as unknown as JsonObject)
        return
      }
      const list = await listAnthropicModels(apiKey)
      await noteCatalog(apiKey)
      sendJson(res, ctx, 200, list as unknown as JsonObject)
      return
    }

    // --- POST routes need a JSON body ---
    if (method !== "POST") {
      sendError(res, ctx, 405, "not_found_error", `Method ${method} not allowed`)
      return
    }

    let body: AnthropicRequest
    try {
      const raw = await readBody(req)
      const parsed: unknown = JSON.parse(raw.toString("utf8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object")
      body = parsed as AnthropicRequest
    } catch (err) {
      sendError(res, ctx, 400, "invalid_request_error", `Invalid JSON body: ${(err as Error).message}`)
      return
    }

    // --- POST /v1/messages/count_tokens ---
    if (isCountTokens) {
      if (typeof body.model !== "string" || !body.model) {
        sendError(res, ctx, 400, "invalid_request_error", "missing required field: model")
        return
      }
      if (!Array.isArray(body.messages)) {
        sendError(res, ctx, 400, "invalid_request_error", "missing required field: messages")
        return
      }
      sendJson(res, ctx, 200, countTokens(body) as unknown as JsonObject)
      return
    }

    // --- POST /v1/messages ---
    if (typeof body.model !== "string" || !body.model) {
      sendError(res, ctx, 400, "invalid_request_error", "missing required field: model")
      return
    }
    if (!Array.isArray(body.messages)) {
      sendError(res, ctx, 400, "invalid_request_error", "missing required field: messages")
      return
    }
    if (typeof body.max_tokens !== "number") {
      sendError(res, ctx, 400, "invalid_request_error", "missing required field: max_tokens")
      return
    }
    if (!apiKey) {
      sendError(res, ctx, 401, "authentication_error", "no Devin credential — run `devin-claude login`")
      return
    }

    let modelUid: string
    try {
      modelUid = await resolveModelId(body.model, apiKey)
      await noteCatalog(apiKey)
    } catch (err) {
      if (err instanceof ModelNotFoundError) {
        sendError(res, ctx, 400, "invalid_request_error", err.message)
        return
      }
      throw err
    }

    // Use the catalog's real context window for this model as the input cap —
    // the previous flat 64k default let the input overflow smaller windows and
    // under-used larger ones. Falls back to the constant when the catalog has
    // no window for this UID.
    const contextWindow = await contextWindowFor(modelUid, apiKey)

    if (fast) {
      if (Array.isArray(body.tools)) {
        body.tools = body.tools.filter((t) => !FAST_DROP_TOOLS.has(String((t as { name?: string }).name)))
      }
      if (typeof body.max_tokens === "number") body.max_tokens = Math.min(body.max_tokens, 16_384)
      const terse = "\n\n[claude-devin --fast] Be terse: minimal prose; prefer tool calls over explanation; no summaries unless asked."
      if (typeof body.system === "string") body.system += terse
      else if (Array.isArray(body.system)) {
        const last = body.system[body.system.length - 1]
        if (last && last.type === "text" && typeof last.text === "string") last.text += terse
      }
    }

    const converted = anthropicToChat({ ...body, model: modelUid })
    const abort = new AbortController()
    res.on("close", () => abort.abort())
    const request: StreamChatRequest = {
      apiKey,
      apiServerUrl: loadCredentials()?.apiServerUrl,
      modelUid: converted.modelUid,
      messages: converted.messages,
      tools: converted.tools,
      completionOpts: {
        ...converted.completionOpts,
        // Catalog-derived input cap (0 → encoder falls back to its default).
        ...(contextWindow > 0 ? { maxInputTokens: contextWindow } : {}),
      },
      signal: abort.signal,
    }

    // Compact input summary for the log: message count + tools offered.
    const toolsOffered = Array.isArray(body.tools) ? body.tools.length : 0
    log.info(
      `${method} ${path} [${rid}] model=${body.model} msgs=${body.messages.length} tools=${toolsOffered} max_tok=${body.max_tokens}${fast ? " fast" : ""}`,
    )

    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      // Stream telemetry: TTFT (first content byte), tools invoked, and the
      // final usage from message_delta — enough to explain any slow turn.
      let ttft = -1
      const toolNames = new Set<string>()
      let inTok = 0
      let outTok = 0
      let stopReason = "?"
      let blocks = 0
      try {
        for await (const event of streamChatEventsAsAnthropic(request)) {
          if (ttft < 0 && event.event === "content_block_start") ttft = Date.now() - t0
          if (event.event === "content_block_start") blocks++
          if (event.event === "content_block_start") {
            const block = (event.data as { content_block?: { type?: string; name?: string } }).content_block
            if (block?.type === "tool_use" && block.name) toolNames.add(block.name)
          }
          if (event.event === "message_start") {
            const u = (event.data as { message?: { usage?: { input_tokens?: number } } }).message?.usage
            if (typeof u?.input_tokens === "number" && u.input_tokens > 0) inTok = u.input_tokens
          }
          if (event.event === "message_delta") {
            const d = event.data as { delta?: { stop_reason?: string }; usage?: { output_tokens?: number } }
            if (d.delta?.stop_reason) stopReason = d.delta.stop_reason
            if (typeof d.usage?.output_tokens === "number") outTok = d.usage.output_tokens
          }
          res.write(sseSerialize(event))
        }
        log.info(
          `${method} ${path} -> 200 [${rid}] ttft=${ttft}ms total=${Date.now() - t0}ms stop=${stopReason} in=${inTok}tok out=${outTok}tok blocks=${blocks} tools=[${[...toolNames].join(",")}]`,
        )
      } catch (err) {
        const e = err as Error
        log.warn(`stream error ${method} ${path} model=${body.model} [${rid}]: ${e.message.slice(0, 300)}`)
        const type =
          e instanceof ModelNotFoundError
            ? "invalid_request_error"
            : e instanceof CloudChatError
              ? "api_error"
              : "api_error"
        res.write(`event: error\ndata: ${JSON.stringify(errorBody(type, e.message))}\n\n`)
        if (!(e instanceof ModelNotFoundError)) {
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        }
      }
      res.end()
      return
    }

    try {
      const message = await chatToAnthropicResponse(request)
      const toolNames = message.content.filter((b) => b.type === "tool_use").map((b) => String((b as { name?: string }).name))
      log.info(
        `${method} ${path} -> 200 [${rid}] total=${Date.now() - t0}ms stop=${message.stop_reason} in=${message.usage.input_tokens}tok out=${message.usage.output_tokens}tok tools=[${toolNames.join(",")}]`,
      )
      sendJson(res, ctx, 200, message as unknown as JsonObject)
    } catch (err) {
      const e = err as Error
      const status = e instanceof ModelNotFoundError ? 400 : e instanceof CloudChatError ? 502 : 500
      const type = e instanceof ModelNotFoundError ? "invalid_request_error" : "api_error"
      if (status >= 500) {
        log.warn(`upstream error ${method} ${path} model=${body.model} -> ${status} [${rid}]: ${e.message.slice(0, 300)}`)
      }
      sendError(res, ctx, status, type, e.message)
    }
  }

  const server = httpCreateServer((req, res) => {
    handle(req, res).catch((err) => {
      // Last-resort handler: never leak stack details beyond the message.
      if (!res.headersSent) {
        const path = req.url ?? "/"
        sendError(res, { rid: "r?", method: req.method ?? "GET", path, t0: Date.now() }, 500, "api_error", (err as Error).message)
      } else {
        res.end()
      }
    })
  })

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise)
    server.listen(wantedPort, "127.0.0.1", () => resolvePromise())
  })

  const address = server.address()
  const port = typeof address === "object" && address ? address.port : wantedPort

  // Warm the catalog + user_jwt caches in the background so the first
  // /v1/messages doesn't pay the Cascade round-trip (~1-3s on cold start).
  // Fire-and-forget: failures are retried lazily on the real request.
  const apiKey = getApiKey()
  if (apiKey) {
    noteCatalog(apiKey).catch(() => {})
  }

  return { server, port }
}

// --- direct execution: `node|bun server.ts` ---
// NOTE: inside the bundled `proxy-bundle.mjs`, every module shares the same
// import.meta.url (the bundle file), so this check would ALSO fire there and
// double-start the server. Gate it on an env flag the bundle sets? Simpler:
// only auto-start when the file was invoked as `server.ts`/`server` by name.
const invokedAsScript =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href &&
  /server\.(ts|mjs|js)$/.test(process.argv[1])

if (invokedAsScript && process.env.NODE_ENV !== "test") {
  const port = Number(process.env.DEVIN_CLAUDE_PORT) || DEFAULT_PORT
  const clientKey = process.env.DEVIN_CLAUDE_CLIENT_KEY || LOCAL_CLIENT_KEY
  createServer({ port, clientKey })
    .then(({ port: bound }) => log.info(`listening on http://127.0.0.1:${bound}`))
    .catch((err) => {
      log.error(`failed to start: ${(err as Error).message}`)
      process.exit(1)
    })
}
