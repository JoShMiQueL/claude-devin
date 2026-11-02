import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "node:http"

/**
 * Opt-in live smoke test: boots the real proxy and replays a streaming
 * /v1/messages request end-to-end against Cognition's Cascade backend.
 *
 *   DEVIN_LLM_API_KEY=devin-session-token$... bun test test/devin-anthropic-proxy/live.test.ts
 *
 * Skipped entirely when the env var is absent. No fetch stubbing here — the
 * point is to hit the real service.
 */

const API_KEY = process.env.DEVIN_LLM_API_KEY
const RUN_LIVE = Boolean(API_KEY)

const maybe = RUN_LIVE ? test : test.skip

if (!RUN_LIVE) {
  console.log("[live-proxy] skipped: set DEVIN_LLM_API_KEY to run the live proxy smoke test")
}

let proxy: { server: Server; port: number }
let base = ""
let dir = ""
let savedXdg: string | undefined
let savedKey: string | undefined

beforeAll(async () => {
  if (!RUN_LIVE) return
  savedXdg = process.env.XDG_CONFIG_HOME
  savedKey = process.env.DEVIN_LLM_API_KEY
  dir = mkdtempSync(join(tmpdir(), "devin-claude-live-"))
  process.env.XDG_CONFIG_HOME = dir
  process.env.DEVIN_LLM_API_KEY = API_KEY
  const { createServer } = await import("../../src/devin-anthropic-proxy/server.ts")
  const { LOCAL_CLIENT_KEY } = await import("../../src/devin-anthropic-proxy/auth.ts")
  proxy = await createServer({ port: 0, clientKey: LOCAL_CLIENT_KEY })
  base = `http://127.0.0.1:${proxy.port}`
})

afterAll(async () => {
  if (!RUN_LIVE) return
  await new Promise<void>((resolvePromise) => proxy.server.close(() => resolvePromise()))
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  if (savedKey === undefined) delete process.env.DEVIN_LLM_API_KEY
  else process.env.DEVIN_LLM_API_KEY = savedKey
  rmSync(dir, { recursive: true, force: true })
})

describe("live proxy", () => {
  maybe("POST /v1/messages streams a real Anthropic SSE reply", async () => {
    const { LOCAL_CLIENT_KEY } = await import("../../src/devin-anthropic-proxy/auth.ts")
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": LOCAL_CLIENT_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: [{ type: "text", text: "Say OK" }] }],
        max_tokens: 8,
        stream: true,
      }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")

    const wire = await res.text()
    const events: Array<{ event: string; data: Record<string, unknown> }> = []
    for (const frame of wire.split("\n\n")) {
      const trimmed = frame.trim()
      if (!trimmed) continue
      const name = trimmed.match(/^event: (.+)$/m)?.[1]
      const dataLine = trimmed.match(/^data: (.+)$/m)?.[1]
      if (name && dataLine) events.push({ event: name, data: JSON.parse(dataLine) })
    }

    const names = events.map((e) => e.event)
    // First event is always message_start; the stream always ends message_stop.
    expect(names[0]).toBe("message_start")
    expect(names.at(-1)).toBe("message_stop")
    // A text reply carries at least one text_delta.
    const deltas = events.filter((e) => e.event === "content_block_delta")
    expect(deltas.some((e) => (e.data.delta as { type?: string }).type === "text_delta")).toBe(true)
    // The terminal message_delta reports a stop_reason.
    const messageDelta = events.find((e) => e.event === "message_delta")
    expect(messageDelta).toBeDefined()
    expect((messageDelta!.data.delta as { stop_reason?: string }).stop_reason).toBeTruthy()

    const text = deltas
      .map((e) => (e.data.delta as { text?: string }).text ?? "")
      .join("")
    console.log(`  live proxy reply: ${JSON.stringify(text.slice(0, 80))}`)
    expect(text.length).toBeGreaterThan(0)
  }, 120_000)
})
