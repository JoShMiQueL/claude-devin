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
import { getAnthropicModel, listAnthropicModels, ModelNotFoundError, resolveModelId } from "./models.ts"
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

type JsonObject = Record<string, unknown>

const errorBody = (type: string, message: string): JsonObject => ({
  type: "error",
  error: { type, message },
})

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

  const log = (method: string, path: string, status: number): void => {
    console.log(`[devin-proxy] ${method} ${path} -> ${status}`)
  }

  const sendJson = (res: ServerResponse, method: string, path: string, status: number, body: JsonObject): void => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) })
    res.end(payload)
    log(method, path, status)
  }

  const sendError = (res: ServerResponse, method: string, path: string, status: number, type: string, message: string): void => {
    sendJson(res, method, path, status, errorBody(type, message))
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? "GET"
    const path = (new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/")

    // --- unauthenticated route ---
    if (path === "/health") {
      if (method !== "GET") {
        sendError(res, method, path, 405, "not_found_error", `Method ${method} not allowed`)
        return
      }
      const body: JsonObject = { status: "ok" }
      if (state.catalogSize !== undefined) body.catalogSize = state.catalogSize
      body.authenticated = getApiKey() !== null
      sendJson(res, method, path, 200, body)
      return
    }

    // --- known authenticated paths (for 405 vs 404) ---
    const isMessages = path === "/v1/messages"
    const isCountTokens = path === "/v1/messages/count_tokens"
    const isModels = path === "/v1/models"
    const modelIdMatch = path.startsWith("/v1/models/") ? decodeURIComponent(path.slice("/v1/models/".length)) : null
    const knownPath = isMessages || isCountTokens || isModels || modelIdMatch !== null

    if (!knownPath) {
      sendError(res, method, path, 404, "not_found_error", `Not found: ${path}`)
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
      const fp = (s: string | null) =>
        s === null ? "null" : `len=${s.length} head="${s.slice(0, 6)}" tail="${s.slice(-4)}"`
      console.error(
        `[devin-proxy] 401 auth on ${path}: header=${whichHeader} ${presentedKey === null ? "absent" : `mismatch ${fp(presentedKey)} (expected ${fp(clientKey)})`}`,
      )
      sendError(res, method, path, 401, "authentication_error", "invalid x-api-key")
      return
    }

    const apiKey = getApiKey() ?? ""

    // --- GET /v1/models ---
    if (isModels || modelIdMatch !== null) {
      if (method !== "GET") {
        sendError(res, method, path, 405, "not_found_error", `Method ${method} not allowed`)
        return
      }
      if (modelIdMatch !== null) {
        const model = await getAnthropicModel(modelIdMatch, apiKey)
        await noteCatalog(apiKey)
        if (!model) {
          sendError(res, method, path, 404, "not_found_error", `model: ${modelIdMatch}`)
          return
        }
        sendJson(res, method, path, 200, model as unknown as JsonObject)
        return
      }
      const list = await listAnthropicModels(apiKey)
      await noteCatalog(apiKey)
      sendJson(res, method, path, 200, list as unknown as JsonObject)
      return
    }

    // --- POST routes need a JSON body ---
    if (method !== "POST") {
      sendError(res, method, path, 405, "not_found_error", `Method ${method} not allowed`)
      return
    }

    let body: AnthropicRequest
    try {
      const raw = await readBody(req)
      const parsed: unknown = JSON.parse(raw.toString("utf8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object")
      body = parsed as AnthropicRequest
    } catch (err) {
      sendError(res, method, path, 400, "invalid_request_error", `Invalid JSON body: ${(err as Error).message}`)
      return
    }

    // --- POST /v1/messages/count_tokens ---
    if (isCountTokens) {
      if (typeof body.model !== "string" || !body.model) {
        sendError(res, method, path, 400, "invalid_request_error", "missing required field: model")
        return
      }
      if (!Array.isArray(body.messages)) {
        sendError(res, method, path, 400, "invalid_request_error", "missing required field: messages")
        return
      }
      sendJson(res, method, path, 200, countTokens(body) as unknown as JsonObject)
      return
    }

    // --- POST /v1/messages ---
    if (typeof body.model !== "string" || !body.model) {
      sendError(res, method, path, 400, "invalid_request_error", "missing required field: model")
      return
    }
    if (!Array.isArray(body.messages)) {
      sendError(res, method, path, 400, "invalid_request_error", "missing required field: messages")
      return
    }
    if (typeof body.max_tokens !== "number") {
      sendError(res, method, path, 400, "invalid_request_error", "missing required field: max_tokens")
      return
    }
    if (!apiKey) {
      sendError(res, method, path, 401, "authentication_error", "no Devin credential — run `devin-claude login`")
      return
    }

    let modelUid: string
    try {
      modelUid = await resolveModelId(body.model, apiKey)
      await noteCatalog(apiKey)
    } catch (err) {
      if (err instanceof ModelNotFoundError) {
        sendError(res, method, path, 400, "invalid_request_error", err.message)
        return
      }
      throw err
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
      completionOpts: converted.completionOpts,
      signal: abort.signal,
    }

    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      log(method, path, 200)
      try {
        for await (const event of streamChatEventsAsAnthropic(request)) {
          res.write(sseSerialize(event))
        }
      } catch (err) {
        const e = err as Error
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
      sendJson(res, method, path, 200, message as unknown as JsonObject)
    } catch (err) {
      const e = err as Error
      const status = e instanceof ModelNotFoundError ? 400 : e instanceof CloudChatError ? 502 : 500
      const type = e instanceof ModelNotFoundError ? "invalid_request_error" : "api_error"
      sendError(res, method, path, status, type, e.message)
    }
  }

  const server = httpCreateServer((req, res) => {
    handle(req, res).catch((err) => {
      // Last-resort handler: never leak stack details beyond the message.
      if (!res.headersSent) {
        const path = req.url ?? "/"
        sendError(res, req.method ?? "GET", path, 500, "api_error", (err as Error).message)
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
    .then(({ port: bound }) => console.log(`[devin-proxy] listening on http://127.0.0.1:${bound}`))
    .catch((err) => {
      console.error(`[devin-proxy] failed to start: ${(err as Error).message}`)
      process.exit(1)
    })
}
