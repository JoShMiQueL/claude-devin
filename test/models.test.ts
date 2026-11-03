import { afterEach, describe, expect, test } from "bun:test"

import { clearCachedUserJwt } from "../src/protocol/auth.ts"
import {
  contextWindowFor,
  listAnthropicModels,
  ModelNotFoundError,
  resolveModelId,
} from "../src/devin-anthropic-proxy/models.ts"
import { catalogReply, modelConfig, realFetch, stubFetch, uniqueHost } from "./helpers.ts"

/**
 * The catalog seam is exercised through the wire: stubFetch serves a synthetic
 * GetCascadeModelConfigs reply (plus the GetUserJwt mint it needs first), so
 * these tests run the real catalog decoder â€” no production-code seams needed.
 * A unique (apiKey, host) pair per test dodges the 10-minute catalog cache.
 */
let seq = 0
const key = () => `devin-session-token$models-test-${seq++}`

afterEach(() => {
  globalThis.fetch = realFetch
  clearCachedUserJwt()
})

const serveCatalog = (...uids: Array<string | { uid: string; disabled?: boolean; contextWindow?: number }>) => {
  stubFetch({
    catalog: () =>
      new Response(
        catalogReply(
          uids.map((u) =>
            typeof u === "string"
              ? modelConfig(u)
              : modelConfig(u.uid, { disabled: u.disabled, contextWindow: u.contextWindow }),
          ),
        ),
        { status: 200 },
      ),
  })
}

describe("listAnthropicModels", () => {
  test("returns Anthropic list shape with one model per enabled entry", async () => {
    serveCatalog("claude-sonnet-4-5", "swe-2-high", { uid: "claude-opus-4-1", disabled: true })
    const list = await listAnthropicModels(key(), uniqueHost())
    expect(list.object).toBe("list")
    expect(list.data).toHaveLength(2)
    for (const model of list.data) {
      expect(model.object).toBe("model")
      expect(model.owned_by).toBe("devin")
      expect(model.type).toBe("model")
      expect(typeof model.id).toBe("string")
      expect(typeof model.display_name).toBe("string")
      expect(typeof model.created).toBe("number")
      expect(typeof model.created_at).toBe("string")
    }
    expect(list.data.map((m) => m.id).sort()).toEqual(["claude-sonnet-4-5", "swe-2-high"])
  })

  test("returns an empty list when the catalog fetch fails", async () => {
    stubFetch({ catalog: () => new Response("boom", { status: 500 }) })
    const list = await listAnthropicModels(key(), uniqueHost())
    expect(list).toEqual({ object: "list", data: [] })
  })
})

describe("resolveModelId", () => {
  test("strips the devin/ prefix and resolves a catalog entry", async () => {
    serveCatalog("claude-sonnet-4-5")
    const apiKey = key()
    const host = uniqueHost()
    await expect(resolveModelId("devin/claude-sonnet-4-5", apiKey, host)).resolves.toBe("claude-sonnet-4-5")
  })

  test("resolves a catalog UID without a prefix", async () => {
    serveCatalog("swe-2-high")
    await expect(resolveModelId("swe-2-high", key(), uniqueHost())).resolves.toBe("swe-2-high")
  })

  test("passes through a known UID family absent from the catalog", async () => {
    serveCatalog("swe-2-high")
    // Not in the catalog, but matches the claude- prefix allowlist.
    await expect(resolveModelId("claude-opus-9-9", key(), uniqueHost())).resolves.toBe("claude-opus-9-9")
  })

  test("raises ModelNotFoundError listing valid ids for an unknown model", async () => {
    serveCatalog("claude-sonnet-4-5", "swe-2-high")
    const err = await resolveModelId("gpt-5", key(), uniqueHost()).catch((e) => e)
    expect(err).toBeInstanceOf(ModelNotFoundError)
    expect(err.validIds.sort()).toEqual(["claude-sonnet-4-5", "swe-2-high"])
    expect(err.message).toContain('Unknown model "gpt-5"')
    expect(err.message).toContain("claude-sonnet-4-5")
  })

  test("raises ModelNotFoundError for a disabled catalog entry", async () => {
    serveCatalog({ uid: "claude-opus-4-1", disabled: true }, "claude-sonnet-4-5")
    const err = await resolveModelId("claude-opus-4-1", key(), uniqueHost()).catch((e) => e)
    expect(err).toBeInstanceOf(ModelNotFoundError)
    expect(err.validIds).toEqual(["claude-sonnet-4-5"])
  })

  test("reports an empty valid id list when the catalog is unavailable", async () => {
    stubFetch({ catalog: () => new Response("down", { status: 500 }) })
    const err = await resolveModelId("not-a-model", key(), uniqueHost()).catch((e) => e)
    expect(err).toBeInstanceOf(ModelNotFoundError)
    expect(err.validIds).toEqual([])
    expect(err.message).toContain("Model catalog unavailable")
  })
})

describe("contextWindowFor", () => {
  test("returns the catalog's declared window for the model", async () => {
    serveCatalog(
      { uid: "swe-2-high", contextWindow: 200_000 },
      { uid: "claude-haiku-5-5", contextWindow: 128_000 },
    )
    await expect(contextWindowFor("claude-haiku-5-5", key(), uniqueHost())).resolves.toBe(128_000)
  })

  test("returns 0 for a model absent from the catalog", async () => {
    serveCatalog("swe-2-high")
    await expect(contextWindowFor("claude-opus-9-9", key(), uniqueHost())).resolves.toBe(0)
  })

  test("returns 0 when the catalog is unavailable", async () => {
    stubFetch({ catalog: () => new Response("down", { status: 500 }) })
    await expect(contextWindowFor("swe-2-high", key(), uniqueHost())).resolves.toBe(0)
  })
})
