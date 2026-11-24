/** Constants local to claude-devin — the protocol ones live in devin-core. */

/** OpenCode-style provider ID. Models appear as `devin/<uid>` in /models output. */
export const PROVIDER_ID = "devin"

/** Environment variable holding a Devin session token (`devin-session-token$...`). */
export const LLM_ENV_VAR = "DEVIN_LLM_API_KEY"

/** Credential lifetime reported to the client (the token itself is long-lived). */
export const CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000

/** Fallback release date for catalog models that do not expose one (epoch ms). */
export const DEFAULT_RELEASED_MS = Date.parse("2025-01-01T00:00:00Z")
