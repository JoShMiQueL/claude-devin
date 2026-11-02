import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Credential store tests. Every test runs against a fresh XDG_CONFIG_HOME so
 * no real ~/.config/devin-claude/credentials.json is touched — and the saved
 * env is restored afterwards so nothing leaks into other test files.
 */

let dir = ""
let savedXdg: string | undefined
let savedKey: string | undefined

const ENV_KEY = "DEVIN_LLM_API_KEY"

beforeEach(async () => {
  savedXdg = process.env.XDG_CONFIG_HOME
  savedKey = process.env[ENV_KEY]
  dir = mkdtempSync(join(tmpdir(), "devin-claude-test-"))
  process.env.XDG_CONFIG_HOME = dir
  delete process.env[ENV_KEY]
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  if (savedKey === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedKey
  rmSync(dir, { recursive: true, force: true })
})

const auth = () => import("../../src/devin-anthropic-proxy/auth.ts")

describe("auth credential store", () => {
  test("loadCredentials returns null when no file exists", async () => {
    const { loadCredentials } = await auth()
    expect(loadCredentials()).toBeNull()
  })

  test("saveCredentials writes then loadCredentials reads it back", async () => {
    const { saveCredentials, loadCredentials } = await auth()
    const saved = saveCredentials({ apiKey: "devin-session-token$abc", apiServerUrl: "https://h.test" })
    expect(saved.apiKey).toBe("devin-session-token$abc")
    expect(saved.apiServerUrl).toBe("https://h.test")
    expect(saved.createdAt).toBeTruthy()

    const loaded = loadCredentials()
    expect(loaded).not.toBeNull()
    expect(loaded!.apiKey).toBe("devin-session-token$abc")
    expect(loaded!.apiServerUrl).toBe("https://h.test")
  })

  test("saveCredentials stores the file under XDG_CONFIG_HOME/devin-claude with mode 0600", async () => {
    const { saveCredentials, credentialsPath } = await auth()
    saveCredentials({ apiKey: "devin-session-token$perm" })
    const path = credentialsPath()
    expect(path.startsWith(dir)).toBe(true)
    expect(existsSync(path)).toBe(true)
    if (process.platform !== "win32") {
      // Windows ignores POSIX modes; documented best-effort limitation.
      expect(statSync(path).mode & 0o777).toBe(0o600)
    }
  })

  test("loadCredentials returns null on malformed JSON or missing apiKey", async () => {
    const { loadCredentials, credentialsPath } = await auth()
    mkdirSync(join(dir, "devin-claude"), { recursive: true })

    writeFileSync(credentialsPath(), "not json{{{")
    expect(loadCredentials()).toBeNull()

    writeFileSync(credentialsPath(), JSON.stringify({ apiKey: "" }))
    expect(loadCredentials()).toBeNull()

    writeFileSync(credentialsPath(), JSON.stringify({ nope: true }))
    expect(loadCredentials()).toBeNull()
  })

  test("clearCredentials removes the file and reports whether one existed", async () => {
    const { saveCredentials, clearCredentials, loadCredentials, credentialsPath } = await auth()
    expect(clearCredentials()).toBe(false)
    saveCredentials({ apiKey: "devin-session-token$gone" })
    expect(existsSync(credentialsPath())).toBe(true)
    expect(clearCredentials()).toBe(true)
    expect(existsSync(credentialsPath())).toBe(false)
    expect(loadCredentials()).toBeNull()
  })

  test("getApiKey prefers DEVIN_LLM_API_KEY over the stored credential", async () => {
    const { saveCredentials, getApiKey } = await auth()
    saveCredentials({ apiKey: "devin-session-token$file" })
    expect(getApiKey()).toBe("devin-session-token$file")

    process.env[ENV_KEY] = "devin-session-token$env"
    expect(getApiKey()).toBe("devin-session-token$env")

    process.env[ENV_KEY] = "   "
    expect(getApiKey()).toBe("devin-session-token$file")

    delete process.env[ENV_KEY]
    expect(getApiKey()).toBe("devin-session-token$file")
  })

  test("getApiKey returns null when neither env nor file has a key", async () => {
    const { getApiKey } = await auth()
    expect(getApiKey()).toBeNull()
  })
})
