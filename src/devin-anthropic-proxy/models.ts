/**
 * Anthropic `/v1/models` shape on top of the Cascade model catalog.
 *
 * `getCachedCatalog` is the single source of truth for which model UIDs the
 * account may use; this file only re-shapes and resolves IDs. Node ≥18 ESM.
 */

import { getCachedCatalog, type ModelCatalogEntry } from "../protocol/catalog.ts"
import { DEFAULT_API_SERVER, DEFAULT_RELEASED_MS, PROVIDER_ID } from "../constants.ts"

export interface AnthropicModel {
  id: string
  object: "model"
  /** Unix seconds (Anthropic `created` field). */
  created: number
  /** ISO-8601 timestamp (Anthropic `created_at` field). */
  created_at: string
  display_name: string
  owned_by: "devin"
  type: "model"
}

export interface AnthropicModelList {
  object: "list"
  data: AnthropicModel[]
}

/** Raised by `resolveModelId` when the input is not a usable model UID. */
export class ModelNotFoundError extends Error {
  readonly validIds: string[]
  constructor(input: string, validIds: string[]) {
    super(
      validIds.length > 0
        ? `Unknown model "${input}". Valid model ids: ${validIds.join(", ")}`
        : `Unknown model "${input}". Model catalog unavailable.`,
    )
    this.name = "ModelNotFoundError"
    this.validIds = validIds
  }
}

const toAnthropicModel = (entry: ModelCatalogEntry, created: number): AnthropicModel => ({
  id: entry.modelUid,
  object: "model",
  created,
  created_at: new Date(created * 1000).toISOString(),
  display_name: entry.label || entry.modelUid,
  owned_by: "devin",
  type: "model",
})

const enabledEntries = async (apiKey: string, host = DEFAULT_API_SERVER): Promise<{
  entries: readonly ModelCatalogEntry[]
  created: number
}> => {
  const catalog = await getCachedCatalog(apiKey, host)
  if (!catalog) return { entries: [], created: Math.floor(DEFAULT_RELEASED_MS / 1000) }
  return {
    entries: [...catalog.byUid.values()].filter((entry) => !entry.disabled),
    created: Math.floor(catalog.fetchedAt / 1000),
  }
}

/** `GET /v1/models` response body — one entry per non-disabled catalog model. */
export async function listAnthropicModels(apiKey: string, host?: string): Promise<AnthropicModelList> {
  const { entries, created } = await enabledEntries(apiKey, host)
  return { object: "list", data: entries.map((entry) => toAnthropicModel(entry, created)) }
}

/** Single `GET /v1/models/{id}` entry, or null when absent or disabled. */
export async function getAnthropicModel(id: string, apiKey: string, host?: string): Promise<AnthropicModel | null> {
  const { entries, created } = await enabledEntries(apiKey, host)
  const entry = entries.find((candidate) => candidate.modelUid === id)
  return entry ? toAnthropicModel(entry, created) : null
}

/** Enabled model UIDs, in catalog order. */
export async function modelIds(apiKey: string, host?: string): Promise<string[]> {
  const { entries } = await enabledEntries(apiKey, host)
  return entries.map((entry) => entry.modelUid)
}

/** Model UID prefixes known to be served by Cascade. */
const KNOWN_UID_RE = /^(claude|swe|glm)-/

/**
 * Normalize a client-supplied model name to a Cascade model UID.
 *
 * Accepts `claude-*`, `swe-*`, `glm-*` UIDs directly (with optional
 * `devin/<uid>` prefix). Anything else — including a catalog UID outside those
 * families — resolves only when the catalog lists it enabled. A known-but-
 * disabled UID or an unrecognized name raises `ModelNotFoundError` carrying
 * the valid IDs for the Anthropic 400 error body.
 */
export async function resolveModelId(input: string, apiKey: string, host?: string): Promise<string> {
  const raw = (input ?? "").trim()
  const uid = raw.startsWith(`${PROVIDER_ID}/`) ? raw.slice(PROVIDER_ID.length + 1) : raw
  const catalog = await getCachedCatalog(apiKey, host)
  const validIds = catalog ? [...catalog.byUid.values()].filter((e) => !e.disabled).map((e) => e.modelUid) : []

  if (uid && catalog) {
    const entry = catalog.byUid.get(uid)
    if (entry) {
      if (!entry.disabled) return uid
      throw new ModelNotFoundError(input, validIds)
    }
  }
  if (KNOWN_UID_RE.test(uid)) return uid
  throw new ModelNotFoundError(input, validIds)
}
