/**
 * Credential store for the devin-claude Anthropic proxy.
 *
 * Stores the Devin session token (`devin-session-token$<jwt>`) at
 * `$XDG_CONFIG_HOME/devin-claude/credentials.json` (default
 * `~/.config/devin-claude/credentials.json`) with mode 0600 best-effort.
 * The `DEVIN_LLM_API_KEY` environment variable always wins over the file.
 *
 * Node-compatible (no Bun APIs) — the `devin-claude` CLI runs under Node ≥18.
 * Never logs or echoes the stored token.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { LLM_ENV_VAR } from "../constants.ts"

/**
 * API key Claude Code sends to the local proxy (`x-api-key` / bearer).
 * It is a fixed, non-secret loopback key: the proxy binds 127.0.0.1 only, and
 * the real credential is the Devin session token loaded by the server.
 */
export const LOCAL_CLIENT_KEY = "devin-claude-local"

export interface StoredCredential {
  /** Devin session token in the `devin-session-token$<jwt>` form. */
  apiKey: string
  /** Optional tenant API server override (Cascade gRPC host). */
  apiServerUrl?: string
  /** ISO-8601 timestamp of when the credential was stored. */
  createdAt: string
}

/** Directory holding `credentials.json` (honors XDG_CONFIG_HOME). */
export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  return join(xdg || join(homedir(), ".config"), "devin-claude")
}

/** Absolute path of the stored credential file. */
export function credentialsPath(): string {
  return join(configDir(), "credentials.json")
}

/** Read the stored credential, or null when absent/unreadable/malformed. */
export function loadCredentials(): StoredCredential | null {
  try {
    const path = credentialsPath()
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoredCredential> | null
    if (!parsed || typeof parsed.apiKey !== "string" || !parsed.apiKey) return null
    return {
      apiKey: parsed.apiKey,
      apiServerUrl: typeof parsed.apiServerUrl === "string" ? parsed.apiServerUrl : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    }
  } catch {
    return null
  }
}

/** Persist the credential (mkdir -p, mode 0600 best-effort). */
export function saveCredentials(input: { apiKey: string; apiServerUrl?: string }): StoredCredential {
  const credential: StoredCredential = {
    apiKey: input.apiKey,
    apiServerUrl: input.apiServerUrl,
    createdAt: new Date().toISOString(),
  }
  mkdirSync(configDir(), { recursive: true })
  const path = credentialsPath()
  writeFileSync(path, JSON.stringify(credential, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows ACLs are best-effort; documented limitation.
  }
  return credential
}

/** Remove the stored credential file. Returns true when a file was deleted. */
export function clearCredentials(): boolean {
  const path = credentialsPath()
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}

/**
 * Resolve the effective Devin API key: `DEVIN_LLM_API_KEY` env var wins over
 * the credential file. Returns null when neither is set.
 */
export function getApiKey(): string | null {
  const env = process.env[LLM_ENV_VAR]?.trim()
  if (env) return env
  return loadCredentials()?.apiKey ?? null
}
