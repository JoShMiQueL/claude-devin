import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "node:http"

import { clearCachedUserJwt } from "../src/protocol/auth.ts"
import { createServer } from "../src/devin-anthropic-proxy/server.ts"
import { LOCAL_CLIENT_KEY } from "../src/devin-anthropic-proxy/auth.ts"
import { catalogReply, modelConfig, realFetch, stubFetch } from "./helpers.ts"

/**
 * Boots the real HTTP server on an ephemeral port. Network access to Cognition
 * is stubbed via globalThis.fetch except in the explicitly-gated live test.
 * XDG_CONFIG_HOME is redirected to a temp dir so the host machine's stored
 * credential can never leak into these tests.
 */

const ENV_KEY = "DEVIN_LLM_API_KEY"

let proxy: { server: Server; port: number }
let base = ""
let dir = ""
let savedXdg: string | undefined
let savedKey: string | undefined

// Client calls go through realFetch so the upstream stub never swallows them.
const req = (path: string, init?: RequestInit) => realFetch(`${base}${path}`, init)

type Json = Record<string, any>
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

beforeAll(async () => {
  savedXdg = process.env.XDG_CONFIG_HOME
  savedKey = process.env[ENV_KEY]
  dir = mkdtempSync(join(tmpdir(), "devin-claude-srv-"))
  process.env.XDG_CONFIG_HOME = dir
  delete process.env[ENV_KEY]
  proxy = await createServer({ port: 0, clientKey: LOCAL_CLIENT_KEY })
  base = `http://127.0.0.1:${proxy.port}`
})

afterAll(async () => {
  await new Promise<void>((resolvePromise) => proxy.server.close(() => resolvePromise()))
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  if (savedKey === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedKey
  rmSync(dir, { recursive: true, force: true })
})

afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
  delete process.env[ENV_KEY]
})

describe("proxy server", () => {
  test("GET /health returns 200 {status:'ok'} without auth", async () => {
    const res = await req("/health")
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.status).toBe("ok")
  })

  test("GET /v1/models without the client key â†’ 401 authentication_error", async () => {
    const res = await req("/v1/models")
    expect(res.status).toBe(401)
    const body = await json(res)
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("authentication_error")
  })

  test("GET /v1/models with a wrong client key â†’ 401", async () => {
    const res = await req("/v1/models", { headers: { "x-api-key": "nope" } })
    expect(res.status).toBe(401)
  })

  test("GET /v1/models with client key but no Devin credential â†’ Anthropic error shape or empty list", async () => {
    // No DEVIN_LLM_API_KEY and no credential file: the catalog call is made
    // with an empty apiKey and the stubbed upstream fails fast, so the proxy
    // degrades to an empty list rather than hanging on the network.
    stubFetch()
    const res = await req("/v1/models", { headers: { "x-api-key": LOCAL_CLIENT_KEY } })
    const body = await json(res)
    if (res.status === 200) {
      expect(body).toEqual({ object: "list", data: [] })
    } else {
      expect(res.status).toBeGreaterThanOrEqual(500)
      expect(body.type).toBe("error")
    }
  })

  test("GET /v1/models with a credential serves the catalog", async () => {
    process.env[ENV_KEY] = "devin-session-token$srv-models"
    stubFetch({
      catalog: () => new Response(catalogReply([modelConfig("claude-sonnet-4-5")]), { status: 200 }),
    })
    const res = await req("/v1/models", { headers: { "x-api-key": LOCAL_CLIENT_KEY } })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(body.object).toBe("list")
    expect(body.data.map((m: { id: string }) => m.id)).toEqual(["claude-sonnet-4-5"])
  })

  test("unknown route â†’ 404 not_found_error", async () => {
    const res = await req("/v1/nope", { headers: { "x-api-key": LOCAL_CLIENT_KEY } })
    expect(res.status).toBe(404)
    const body = await json(res)
    expect(body.error.type).toBe("not_found_error")
  })

  test("POST /v1/messages with malformed JSON â†’ 400 invalid_request_error", async () => {
    const res = await req("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": LOCAL_CLIENT_KEY, "Content-Type": "application/json" },
      body: "{not json",
    })
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
  })

  test("POST /v1/messages missing fields â†’ 400 invalid_request_error", async () => {
    for (const bad of [
      { messages: [], max_tokens: 8 }, // no model
      { model: "claude-sonnet-4-5", max_tokens: 8 }, // no messages
      { model: "claude-sonnet-4-5", messages: [] }, // no max_tokens
    ]) {
      const res = await req("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": LOCAL_CLIENT_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(bad),
      })
      expect(res.status).toBe(400)
      expect((await json(res)).error.type).toBe("invalid_request_error")
    }
  })

  test("POST /v1/messages without a Devin credential â†’ 401 authentication_error", async () => {
    const res = await req("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": LOCAL_CLIENT_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [], max_tokens: 8 }),
    })
    expect(res.status).toBe(401)
    expect((await json(res)).error.type).toBe("authentication_error")
  })

  test("POST /v1/messages unknown model â†’ 400 with the valid ids", async () => {
    process.env[ENV_KEY] = "devin-session-token$srv-unknown-model"
    stubFetch({
      catalog: () =>
        new Response(catalogReply([modelConfig("claude-sonnet-4-5"), modelConfig("swe-2-high")]), { status: 200 }),
    })
    const res = await req("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": LOCAL_CLIENT_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "totally-bogus", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
    })
    expect(res.status).toBe(400)
    const body = await json(res)
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("claude-sonnet-4-5")
    expect(body.error.message).toContain("swe-2-high")
  })

  test("POST /v1/messages/count_tokens returns input_tokens", async () => {
    const res = await req("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "x-api-key": LOCAL_CLIENT_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hello" }] }),
    })
    expect(res.status).toBe(200)
    const body = await json(res)
    expect(Number.isInteger(body.input_tokens)).toBe(true)
    expect(body.input_tokens).toBeGreaterThan(0)
  })

  test("PUT /v1/messages â†’ 405", async () => {
    const res = await req("/v1/messages", { method: "PUT", headers: { "x-api-key": LOCAL_CLIENT_KEY } })
    expect(res.status).toBe(405)
  })
})
