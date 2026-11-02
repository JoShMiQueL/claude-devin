// src/devin-anthropic-proxy/server.ts
import { createServer as httpCreateServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// src/devin-anthropic-proxy/auth.ts
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// src/constants.ts
var PROVIDER_ID = "devin";
var LLM_ENV_VAR = "DEVIN_LLM_API_KEY";
var WEBAPP_URL = "https://app.devin.ai";
var AUTH_API_URL = "https://api.devin.ai";
var DEFAULT_API_SERVER = "https://server.codeium.com";
var TOKEN_PREFIX = "devin-session-token$";
var CALLBACK_PATH = "/callback";
var CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;
var DEFAULT_RELEASED_MS = Date.parse("2025-01-01T00:00:00Z");

// src/devin-anthropic-proxy/auth.ts
var LOCAL_CLIENT_KEY = "devin-claude-local";
function configDir() {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(homedir(), ".config"), "devin-claude");
}
function credentialsPath() {
  return join(configDir(), "credentials.json");
}
function loadCredentials() {
  try {
    const path = credentialsPath();
    if (!existsSync(path))
      return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed.apiKey !== "string" || !parsed.apiKey)
      return null;
    return {
      apiKey: parsed.apiKey,
      apiServerUrl: typeof parsed.apiServerUrl === "string" ? parsed.apiServerUrl : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : ""
    };
  } catch {
    return null;
  }
}
function saveCredentials(input) {
  const credential = {
    apiKey: input.apiKey,
    apiServerUrl: input.apiServerUrl,
    createdAt: new Date().toISOString()
  };
  mkdirSync(configDir(), { recursive: true });
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(credential, null, 2) + `
`, { encoding: "utf8", mode: 384 });
  try {
    chmodSync(path, 384);
  } catch {}
  return credential;
}
function clearCredentials() {
  const path = credentialsPath();
  if (!existsSync(path))
    return false;
  rmSync(path);
  return true;
}
function getApiKey() {
  const env = process.env[LLM_ENV_VAR]?.trim();
  if (env)
    return env;
  return loadCredentials()?.apiKey ?? null;
}

// src/protocol/wire.ts
import * as zlib from "node:zlib";
function encodeVarint(value) {
  let v = BigInt(value);
  if (v < 0n)
    throw new RangeError(`encodeVarint: negative input not supported (got ${value})`);
  const bytes = [];
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 128);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}
function encodeTag(fieldNum, wire) {
  return encodeVarint(fieldNum << 3 | wire);
}
function encodeString(fieldNum, value) {
  const buf = Buffer.from(value, "utf8");
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(buf.length), buf]);
}
function encodeMessage(fieldNum, body) {
  return Buffer.concat([encodeTag(fieldNum, 2), encodeVarint(body.length), body]);
}
function encodeVarintField(fieldNum, value) {
  return Buffer.concat([encodeTag(fieldNum, 0), encodeVarint(value)]);
}
function encodeTimestampBody() {
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const nanos = now % 1000 * 1e6;
  return Buffer.concat([
    encodeVarintField(1, seconds),
    nanos > 0 ? encodeVarintField(2, nanos) : Buffer.alloc(0)
  ]);
}
function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= BigInt(byte & 127) << shift;
    if (!(byte & 128))
      return [result, i];
    shift += 7n;
  }
  throw new Error("truncated varint");
}
function* iterFields(buf) {
  let i = 0;
  while (i < buf.length) {
    const [tagBig, afterTag] = decodeVarint(buf, i);
    i = afterTag;
    const tag = Number(tagBig);
    const num = tag >> 3;
    const wire = tag & 7;
    if (wire === 0) {
      const [value, afterValue] = decodeVarint(buf, i);
      i = afterValue;
      yield { num, wire, value };
    } else if (wire === 1) {
      if (i + 8 > buf.length)
        return;
      yield { num, wire, value: buf.slice(i, i + 8) };
      i += 8;
    } else if (wire === 2) {
      const [lengthBig, afterLength] = decodeVarint(buf, i);
      i = afterLength;
      const length = Number(lengthBig);
      if (length < 0 || i + length > buf.length)
        return;
      yield { num, wire, value: buf.slice(i, i + length) };
      i += length;
    } else if (wire === 5) {
      if (i + 4 > buf.length)
        return;
      yield { num, wire, value: buf.slice(i, i + 4) };
      i += 4;
    } else {
      return;
    }
  }
}
function frameConnectStream(body, compress = true) {
  let payload = body;
  let flags = 0;
  if (compress) {
    payload = zlib.gzipSync(body);
    flags |= 1;
  }
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// src/protocol/metadata.ts
var VERSION_STRING = "2.0.0";
function osName() {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "linux":
      return "linux";
    case "win32":
      return "windows";
    default:
      return process.platform;
  }
}
function buildMetadata(input) {
  const version = input.version ?? VERSION_STRING;
  const os = input.osName ?? osName();
  const parts = [
    encodeString(1, "windsurf"),
    encodeString(2, version),
    encodeString(3, input.apiKey),
    encodeString(4, "en"),
    encodeString(5, os),
    encodeString(7, version),
    encodeVarintField(9, input.requestId),
    encodeString(10, input.sessionId),
    encodeString(12, "windsurf"),
    encodeMessage(16, encodeTimestampBody()),
    encodeString(25, input.triggerId),
    encodeString(26, "Unset"),
    encodeString(28, "windsurf")
  ];
  if (input.userJwt)
    parts.push(encodeString(21, input.userJwt));
  return Buffer.concat(parts);
}

// src/protocol/auth.ts
var MINT_TIMEOUT_MS = 30000;
var FALLBACK_JWT_TTL_SECONDS = 600;

class CloudAuthError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "CloudAuthError";
    this.status = status;
  }
}
async function mintUserJwt(apiKey, host = DEFAULT_API_SERVER, signal) {
  const metadata = buildMetadata({
    apiKey,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID()
  });
  const request = encodeMessage(1, metadata);
  const timeout = AbortSignal.timeout(MINT_TIMEOUT_MS);
  const response = await fetch(`${host.replace(/\/$/, "")}/exa.auth_pb.AuthService/GetUserJwt`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body: new Uint8Array(request),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  const buf = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new CloudAuthError(`GetUserJwt HTTP ${response.status}: ${buf.toString("utf8").slice(0, 400)}`, response.status);
  }
  let jwt = null;
  for (const field of iterFields(buf)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      const candidate = field.value.toString("utf8");
      if (/^eyJ[A-Za-z0-9_-]{10,}={0,2}\.[A-Za-z0-9_-]+={0,2}\.[A-Za-z0-9_-]+={0,2}$/.test(candidate)) {
        jwt = candidate;
        break;
      }
    }
  }
  if (!jwt) {
    throw new CloudAuthError(`GetUserJwt 200 but no field-1 JWT found (${buf.length} bytes)`, response.status);
  }
  let expiresAt = Math.floor(Date.now() / 1000) + FALLBACK_JWT_TTL_SECONDS;
  try {
    const parts = jwt.split(".");
    const pad = (s) => s + "=".repeat((4 - s.length % 4) % 4);
    const payload = JSON.parse(Buffer.from(pad(parts[1]).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (typeof payload.exp === "number")
      expiresAt = payload.exp;
  } catch {}
  return { jwt, expiresAt };
}
var KEY_SEPARATOR = "\x1F";
var credentialKey = (host, apiKey) => `${host}${KEY_SEPARATOR}${apiKey}`;
var cache = null;
var inFlight = new Map;
var cacheEpoch = 0;
async function getCachedUserJwt(apiKey, host = DEFAULT_API_SERVER, signal) {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.apiKey === apiKey && cache.host === host && cache.expiresAt > now + 60) {
    return cache.jwt;
  }
  const key = credentialKey(host, apiKey);
  const pending = inFlight.get(key);
  if (pending)
    return (await pending).jwt;
  const promise = mintUserJwt(apiKey, host, signal);
  inFlight.set(key, promise);
  const epochAtStart = cacheEpoch;
  try {
    const minted = await promise;
    if (cacheEpoch === epochAtStart) {
      cache = { ...minted, apiKey, host };
    }
    return minted.jwt;
  } finally {
    inFlight.delete(key);
  }
}
function clearCachedUserJwt() {
  cache = null;
  inFlight.clear();
  cacheEpoch++;
}

// src/protocol/effort.ts
var EFFORT_LEVELS = ["none", "low", "medium", "high", "xhigh", "max"];
var EFFORT_SUFFIX = new RegExp(`-(${EFFORT_LEVELS.join("|")})$`);
function splitEffortSuffix(modelUid) {
  const match = modelUid.match(EFFORT_SUFFIX);
  const effortLevel = match?.[1];
  if (!effortLevel)
    return { baseModelUid: modelUid };
  return { baseModelUid: modelUid.slice(0, -(effortLevel.length + 1)), effortLevel };
}

// src/protocol/catalog.ts
var CATALOG_TTL_MS = 10 * 60 * 1000;
var CATALOG_FETCH_TIMEOUT_MS = 1e4;
async function fetchCatalog(apiKey, host, signal) {
  const userJwt = await getCachedUserJwt(apiKey, host, signal);
  const metadata = buildMetadata({
    apiKey,
    userJwt,
    sessionId: crypto.randomUUID(),
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID()
  });
  const request = encodeMessage(1, metadata);
  const timeout = AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS);
  const response = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs`, {
    method: "POST",
    headers: { "Content-Type": "application/proto", "Connect-Protocol-Version": "1" },
    body: new Uint8Array(request),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401)
      clearCachedUserJwt();
    throw new Error(`GetCascadeModelConfigs HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  const byUid = new Map;
  for (const field of iterFields(buf)) {
    if (field.num !== 1 || field.wire !== 2 || !Buffer.isBuffer(field.value))
      continue;
    const entry = decodeModelConfig(field.value);
    if (entry)
      byUid.set(entry.modelUid, entry);
  }
  return { byUid, fetchedAt: Date.now(), apiKey, host };
}
function decodeModelConfig(buf) {
  let label = "";
  let modelUid = "";
  let disabled = false;
  let contextWindow = 0;
  let pricing;
  let capabilities;
  for (const field of iterFields(buf)) {
    if (field.num === 1 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      label = field.value.toString("utf8");
    } else if (field.num === 4 && field.wire === 0) {
      disabled = field.value === 1n;
    } else if (field.num === 18 && field.wire === 0) {
      contextWindow = Number(field.value);
    } else if (field.num === 22 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      modelUid = field.value.toString("utf8");
    } else if (field.num === 30 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      capabilities = [];
      for (const feature of iterFields(field.value)) {
        if (feature.num !== 2 || feature.wire !== 2 || !Buffer.isBuffer(feature.value))
          continue;
        let name = "";
        let enabled = false;
        let value;
        for (const part of iterFields(feature.value)) {
          if (part.num === 1 && part.wire === 2 && Buffer.isBuffer(part.value)) {
            name = part.value.toString("utf8");
          } else if (part.num === 1 && part.wire === 0) {
            enabled = part.value === 1n;
          } else if (part.num === 2 && part.wire === 2 && Buffer.isBuffer(part.value)) {
            value = part.value.toString("utf8");
          }
        }
        if (name)
          capabilities.push({ name, enabled, value });
      }
    } else if (field.num === 32 && field.wire === 2 && Buffer.isBuffer(field.value)) {
      pricing ??= { input: 0, cachedInput: 0, output: 0 };
      let type = "";
      let price = 0;
      for (const part of iterFields(field.value)) {
        if (part.num === 1 && part.wire === 2 && Buffer.isBuffer(part.value)) {
          type = part.value.toString("utf8").toLowerCase();
        } else if (part.num === 2 && part.wire === 5 && Buffer.isBuffer(part.value) && part.value.length === 4) {
          price = part.value.readFloatLE(0);
        }
      }
      const normalized = type.trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (normalized === "input")
        pricing.input = price;
      else if (normalized === "cached_input" || normalized === "cache_read")
        pricing.cachedInput = price;
      else if (normalized === "output")
        pricing.output = price;
    }
  }
  if (modelUid.length === 0)
    return;
  const { baseModelUid, effortLevel } = splitEffortSuffix(modelUid);
  return {
    modelUid,
    label: label || modelUid,
    disabled,
    contextWindow,
    pricing,
    capabilities,
    baseModelUid,
    effortLevel
  };
}
var cached = null;
var inFlight2 = null;
var inFlightKey = null;
var flightKey = (apiKey, host) => credentialKey(host, apiKey);
async function getCachedCatalog(apiKey, host = DEFAULT_API_SERVER, signal) {
  if (cached && cached.apiKey === apiKey && cached.host === host && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) {
    return cached;
  }
  const key = flightKey(apiKey, host);
  if (inFlight2 && inFlightKey === key) {
    try {
      return await inFlight2;
    } catch {
      return null;
    }
  }
  const promise = fetchCatalog(apiKey, host, signal);
  inFlight2 = promise;
  inFlightKey = key;
  try {
    const result = await promise;
    cached = result;
    return result;
  } catch {
    return null;
  } finally {
    if (inFlight2 === promise) {
      inFlight2 = null;
      inFlightKey = null;
    }
  }
}

// src/devin-anthropic-proxy/models.ts
class ModelNotFoundError extends Error {
  validIds;
  constructor(input, validIds) {
    super(validIds.length > 0 ? `Unknown model "${input}". Valid model ids: ${validIds.join(", ")}` : `Unknown model "${input}". Model catalog unavailable.`);
    this.name = "ModelNotFoundError";
    this.validIds = validIds;
  }
}
var toAnthropicModel = (entry, created) => ({
  id: entry.modelUid,
  object: "model",
  created,
  created_at: new Date(created * 1000).toISOString(),
  display_name: entry.label || entry.modelUid,
  owned_by: "devin",
  type: "model"
});
var enabledEntries = async (apiKey, host = DEFAULT_API_SERVER) => {
  const catalog = await getCachedCatalog(apiKey, host);
  if (!catalog)
    return { entries: [], created: Math.floor(DEFAULT_RELEASED_MS / 1000) };
  return {
    entries: [...catalog.byUid.values()].filter((entry) => !entry.disabled),
    created: Math.floor(catalog.fetchedAt / 1000)
  };
};
async function listAnthropicModels(apiKey, host) {
  const { entries, created } = await enabledEntries(apiKey, host);
  return { object: "list", data: entries.map((entry) => toAnthropicModel(entry, created)) };
}
async function getAnthropicModel(id, apiKey, host) {
  const { entries, created } = await enabledEntries(apiKey, host);
  const entry = entries.find((candidate) => candidate.modelUid === id);
  return entry ? toAnthropicModel(entry, created) : null;
}
var KNOWN_UID_RE = /^(claude|swe|glm)-/;
async function resolveModelId(input, apiKey, host) {
  const raw = (input ?? "").trim();
  const uid = raw.startsWith(`${PROVIDER_ID}/`) ? raw.slice(PROVIDER_ID.length + 1) : raw;
  const catalog = await getCachedCatalog(apiKey, host);
  const validIds = catalog ? [...catalog.byUid.values()].filter((e) => !e.disabled).map((e) => e.modelUid) : [];
  if (uid && catalog) {
    const entry = catalog.byUid.get(uid);
    if (entry) {
      if (!entry.disabled)
        return uid;
      throw new ModelNotFoundError(input, validIds);
    }
  }
  if (KNOWN_UID_RE.test(uid))
    return uid;
  throw new ModelNotFoundError(input, validIds);
}

// src/protocol/chat.ts
import * as zlib2 from "node:zlib";
var STREAM_IDLE_MS = 120000;
var STREAM_TTFB_MS = 60000;
var MAX_TOOL_DESC_LEN = 6998;

class CloudChatError extends Error {
  code;
  traceId;
  constructor(message, code, traceId) {
    super(message);
    this.name = "CloudChatError";
    this.code = code;
    this.traceId = traceId;
  }
}
var SOURCE_BY_ROLE = { user: 1, assistant: 2, system: 1, tool: 4 };
function encodeImageData(image) {
  const parts = [encodeString(1, image.base64Data), encodeString(2, image.mimeType)];
  if (image.caption)
    parts.push(encodeString(3, image.caption));
  return Buffer.concat(parts);
}
function encodeToolCall(call) {
  return Buffer.concat([encodeString(1, call.id), encodeString(2, call.name), encodeString(3, call.arguments)]);
}
function encodePrompt(content, source, opts) {
  const text = content.filter((part) => part.type === "text").map((part) => part.text).join(`
`);
  const images = content.filter((part) => part.type === "image");
  const parts = [
    encodeVarintField(2, source),
    encodeString(3, text),
    encodeVarintField(4, Math.max(1, Math.floor(text.length / 4))),
    encodeVarintField(5, 1)
  ];
  if (opts?.toolCallId)
    parts.push(encodeString(7, opts.toolCallId));
  if (opts?.toolCalls)
    for (const call of opts.toolCalls)
      parts.push(encodeMessage(6, encodeToolCall(call)));
  for (const image of images)
    parts.push(encodeMessage(10, encodeImageData(image)));
  return Buffer.concat(parts);
}
function textOf(content) {
  if (typeof content === "string")
    return content;
  return content.filter((part) => part.type === "text").map((part) => part.text).join(`
`);
}
function collapseSystemIntoUser(messages) {
  if (!messages.some((message) => message.role === "system"))
    return messages;
  const out = [];
  let pendingSystem = [];
  for (const message of messages) {
    if (message.role === "system") {
      const text = textOf(message.content);
      if (text)
        pendingSystem.push(text);
    } else if (message.role === "user" && pendingSystem.length > 0) {
      const content = normalizeContent(message.content);
      const images = content.filter((part) => part.type === "image");
      const wrapped = `<system>
${pendingSystem.join(`

`)}
</system>
${textOf(content)}`;
      out.push({ role: "user", content: [{ type: "text", text: wrapped }, ...images] });
      pendingSystem = [];
    } else {
      out.push(message);
    }
  }
  if (pendingSystem.length > 0) {
    out.push({ role: "user", content: [{ type: "text", text: `<system>
${pendingSystem.join(`

`)}
</system>` }] });
  }
  return out;
}
function normalizeContent(content) {
  if (typeof content === "string")
    return [{ type: "text", text: content }];
  const out = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "image" && typeof part.base64Data === "string") {
      out.push({ type: "image", mimeType: part.mimeType ?? "image/png", base64Data: part.base64Data, caption: part.caption });
    }
  }
  return out;
}
function encodeToolDef(tool) {
  const raw = tool.description ?? "";
  const description = raw.length > MAX_TOOL_DESC_LEN ? `${raw.slice(0, MAX_TOOL_DESC_LEN - 24)}
…(truncated for cloud)` : raw;
  return Buffer.concat([
    encodeString(1, tool.name),
    encodeString(2, description),
    encodeString(3, JSON.stringify(tool.parameters ?? {}))
  ]);
}
function encodeCompletionConfiguration(opts) {
  const float64 = (fieldNum, value) => {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value, 0);
    return Buffer.concat([Buffer.from([fieldNum << 3 | 1]), buf]);
  };
  return Buffer.concat([
    encodeVarintField(1, 1),
    encodeVarintField(2, opts.maxInputTokens ?? 64000),
    encodeVarintField(3, opts.maxOutputTokens ?? 128000),
    float64(5, opts.temperature ?? 0.7),
    float64(6, opts.topP ?? 0.95),
    encodeVarintField(7, opts.topK ?? 50),
    float64(8, 1),
    float64(11, 1)
  ]);
}
var SESSION_CACHE_LIMIT = 4;
var sessionCache = new Map;
function getOrAllocateSessionIds(apiKey, host, cascadeIdOverride) {
  const key = credentialKey(host, apiKey);
  let ids = sessionCache.get(key);
  if (!ids) {
    ids = { sessionId: crypto.randomUUID(), cascadeId: cascadeIdOverride ?? crypto.randomUUID() };
    if (sessionCache.size >= SESSION_CACHE_LIMIT) {
      const oldest = sessionCache.keys().next();
      if (!oldest.done)
        sessionCache.delete(oldest.value);
    }
    sessionCache.set(key, ids);
  } else if (cascadeIdOverride && ids.cascadeId !== cascadeIdOverride) {
    ids = { sessionId: ids.sessionId, cascadeId: cascadeIdOverride };
    sessionCache.set(key, ids);
  }
  return ids;
}
function buildGetChatMessageRequest(args) {
  const metadata = buildMetadata({
    apiKey: args.apiKey,
    userJwt: args.userJwt,
    sessionId: args.sessionId,
    requestId: args.requestId,
    triggerId: args.triggerId
  });
  const collapsed = collapseSystemIntoUser(args.messages);
  const promptParts = collapsed.map((message) => encodeMessage(3, encodePrompt(normalizeContent(message.content), SOURCE_BY_ROLE[message.role] ?? 1, {
    toolCallId: message.tool_call_id,
    toolCalls: message.tool_calls
  })));
  const toolParts = (args.tools ?? []).map((tool) => encodeMessage(10, encodeToolDef(tool)));
  return Buffer.concat([
    encodeMessage(1, metadata),
    ...promptParts,
    encodeVarintField(7, 5),
    encodeMessage(8, encodeCompletionConfiguration(args.completionOpts ?? {})),
    ...toolParts,
    encodeString(16, args.cascadeId),
    encodeString(21, args.modelUid),
    encodeString(22, args.promptId)
  ]);
}
function* decodeChatFrame(buf) {
  for (const field of iterFields(buf)) {
    if (field.num === 5 && field.wire === 0) {
      const value = Number(field.value);
      let reason = "stop";
      if (value === 10)
        reason = "tool_calls";
      else if (value === 11)
        reason = "content_filter";
      else if (value === 1 || value === 3)
        reason = "length";
      yield { kind: "finish", reason };
      continue;
    }
    if (field.wire !== 2 || !Buffer.isBuffer(field.value))
      continue;
    if (field.num === 3) {
      const text = field.value.toString("utf8");
      if (text)
        yield { kind: "text", text };
    } else if (field.num === 6) {
      let id;
      let name;
      let argsDelta;
      for (const part of iterFields(field.value)) {
        if (part.wire !== 2 || !Buffer.isBuffer(part.value))
          continue;
        const text = part.value.toString("utf8");
        if (part.num === 1)
          id = text;
        else if (part.num === 2)
          name = text;
        else if (part.num === 3)
          argsDelta = text;
      }
      if (id !== undefined && name !== undefined)
        yield { kind: "tool_call_start", id, name };
      if (argsDelta !== undefined)
        yield { kind: "tool_call_args", argsDelta, ...id !== undefined ? { id } : {} };
    } else if (field.num === 9) {
      const text = field.value.toString("utf8");
      if (text)
        yield { kind: "reasoning", text };
    } else if (field.num === 28) {
      const usage = decodeUsageBlock(field.value);
      if (usage)
        yield usage;
    }
  }
}
function decodeUsageBlock(buf) {
  let promptTokens;
  let completionTokens;
  let cachedInputTokens;
  let cacheCreationInputTokens;
  let reasoningTokens;
  for (const field of iterFields(buf)) {
    if (field.num !== 2 || field.wire !== 2 || !Buffer.isBuffer(field.value))
      continue;
    let metric;
    let value;
    for (const entry of iterFields(field.value)) {
      if (entry.num === 5 && entry.wire === 2 && Buffer.isBuffer(entry.value)) {
        metric = entry.value.toString("utf8");
      } else if (entry.num === 4 && entry.wire === 2 && Buffer.isBuffer(entry.value)) {
        for (const inner of iterFields(entry.value)) {
          if (inner.num === 2 && inner.wire === 5 && Buffer.isBuffer(inner.value)) {
            value = inner.value.readFloatLE(0);
            break;
          }
        }
      }
    }
    if (metric && value !== undefined && Number.isFinite(value)) {
      const tokens = Math.round(value);
      if (metric === "input_tokens")
        promptTokens = tokens;
      else if (metric === "output_tokens")
        completionTokens = tokens;
      else if (metric === "cached_input_tokens" || metric === "cache_read_input_tokens")
        cachedInputTokens = (cachedInputTokens ?? 0) + tokens;
      else if (metric === "cache_creation_input_tokens")
        cacheCreationInputTokens = (cacheCreationInputTokens ?? 0) + tokens;
      else if (metric === "reasoning_tokens" || metric === "output_reasoning_tokens")
        reasoningTokens = tokens;
    }
  }
  if (promptTokens === undefined && completionTokens === undefined)
    return null;
  const total = (promptTokens ?? 0) + (completionTokens ?? 0);
  return {
    kind: "usage",
    promptTokens,
    completionTokens,
    totalTokens: total > 0 ? total : undefined,
    cachedInputTokens,
    cacheCreationInputTokens,
    reasoningTokens
  };
}
var TRACE_ID_RE = /\(trace ID: ([0-9a-f]+)\)/i;
var isAuthFailure = (code) => code === "unauthenticated" || code === "unauthorized" || code === "invalid_token";
async function* streamChatEvents(request) {
  const host = (request.apiServerUrl ?? DEFAULT_API_SERVER).replace(/\/$/, "");
  const userJwt = await getCachedUserJwt(request.apiKey, host, request.signal);
  const sessionIds = getOrAllocateSessionIds(request.apiKey, host, request.cascadeId);
  const proto = buildGetChatMessageRequest({
    apiKey: request.apiKey,
    userJwt,
    modelUid: request.modelUid,
    messages: request.messages,
    tools: request.tools,
    cascadeId: sessionIds.cascadeId,
    promptId: crypto.randomUUID(),
    sessionId: sessionIds.sessionId,
    requestId: BigInt(Date.now()),
    triggerId: crypto.randomUUID(),
    completionOpts: request.completionOpts
  });
  const body = frameConnectStream(proto, true);
  const ttfbTimeout = AbortSignal.timeout(STREAM_TTFB_MS);
  const response = await fetch(`${host}/exa.api_server_pb.ApiServerService/GetChatMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/connect+proto",
      "Connect-Protocol-Version": "1",
      "Connect-Content-Encoding": "gzip",
      "Connect-Accept-Encoding": "gzip"
    },
    body: new Uint8Array(body),
    signal: request.signal ? AbortSignal.any([request.signal, ttfbTimeout]) : ttfbTimeout
  });
  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401)
      clearCachedUserJwt();
    throw new CloudChatError(`GetChatMessage HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  if (!response.body)
    throw new CloudChatError("GetChatMessage response had no body stream");
  const reader = response.body.getReader();
  const chunks = [];
  let queuedBytes = 0;
  let trailerError = null;
  let sawEos = false;
  let idleTimer = null;
  const cancelBody = (reason) => reader.cancel(reason).catch(() => {});
  const peek = (n) => {
    if (queuedBytes < n)
      return null;
    if (chunks.length === 1 && chunks[0].length >= n)
      return chunks[0].slice(0, n);
    const parts = [];
    let remaining = n;
    for (const chunk of chunks) {
      if (remaining <= 0)
        break;
      if (chunk.length <= remaining) {
        parts.push(chunk);
        remaining -= chunk.length;
      } else {
        parts.push(chunk.slice(0, remaining));
        remaining = 0;
      }
    }
    return Buffer.concat(parts, n);
  };
  const drop = (n) => {
    queuedBytes -= n;
    let remaining = n;
    while (remaining > 0 && chunks.length > 0) {
      const head = chunks[0];
      if (head.length <= remaining) {
        chunks.shift();
        remaining -= head.length;
      } else {
        chunks[0] = head.slice(remaining);
        remaining = 0;
      }
    }
  };
  try {
    if (request.signal?.aborted)
      throw request.signal.reason;
    request.signal?.addEventListener("abort", () => cancelBody(request.signal?.reason), { once: true });
    while (true) {
      if (idleTimer)
        clearTimeout(idleTimer);
      idleTimer = setTimeout(() => cancelBody(new Error(`idle timeout (${STREAM_IDLE_MS}ms)`)), STREAM_IDLE_MS);
      const { value, done } = await reader.read();
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (done)
        break;
      if (value) {
        chunks.push(Buffer.from(value));
        queuedBytes += value.length;
      }
      while (queuedBytes >= 5) {
        const header = peek(5);
        if (!header)
          break;
        const flags = header[0];
        const length = header.readUInt32BE(1);
        if (queuedBytes < 5 + length)
          break;
        drop(5);
        const raw = peek(length) ?? Buffer.alloc(0);
        drop(length);
        let payload = raw;
        if (flags & 1) {
          try {
            payload = zlib2.gunzipSync(raw);
          } catch (cause) {
            throw new CloudChatError(`Connect frame gunzip failed: ${cause.message}`);
          }
        }
        if ((flags & 2) !== 0) {
          sawEos = true;
          const text = payload.toString("utf8");
          if (text && text.includes('"error"')) {
            let code;
            let message = text;
            try {
              const parsed = JSON.parse(text);
              code = parsed.error?.code;
              if (parsed.error?.message)
                message = parsed.error.message;
            } catch {}
            const traceId = message.match(TRACE_ID_RE)?.[1];
            trailerError = { code, message, traceId };
          }
          continue;
        }
        yield* decodeChatFrame(payload);
      }
    }
  } finally {
    if (idleTimer)
      clearTimeout(idleTimer);
    await cancelBody("stream finished");
    try {
      reader.releaseLock();
    } catch {}
  }
  if (trailerError) {
    const isOpaque = trailerError.code === "permission_denied" && /an internal error occurred/i.test(trailerError.message);
    if (isOpaque) {
      throw new CloudChatError(`Cognition denied model access for "${request.modelUid}". Check your account tier. (trace: ${trailerError.traceId ?? "n/a"})`, trailerError.code, trailerError.traceId);
    }
    if (isAuthFailure(trailerError.code))
      clearCachedUserJwt();
    throw new CloudChatError(trailerError.message, trailerError.code, trailerError.traceId);
  }
  if (!sawEos) {
    throw new CloudChatError("Cloud stream ended without EOS trailer. Connection likely dropped.", "truncated_stream");
  }
}

// src/devin-anthropic-proxy/anthropic.ts
var streamChatEventsImpl = streamChatEvents;
var textPart = (text) => ({ type: "text", text });
function toolResultText(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return "";
  return content.map((block) => block.type === "text" ? block.text : "").filter(Boolean).join(`
`);
}
function toolResultImages(content) {
  if (!Array.isArray(content))
    return [];
  const images = [];
  for (const block of content) {
    if (block.type === "image" && block.source?.data) {
      images.push({ mimeType: block.source.media_type ?? "image/png", base64Data: block.source.data });
    }
  }
  return images;
}
function anthropicToChat(req) {
  const messages = [];
  if (req.system !== undefined && req.system !== null) {
    const text = typeof req.system === "string" ? req.system : req.system.map((block) => block.type === "text" ? block.text : "").filter(Boolean).join(`
`);
    if (text)
      messages.push({ role: "system", content: [{ type: "text", text }] });
  }
  for (const message of req.messages ?? []) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: [{ type: "text", text: message.content }] });
      continue;
    }
    if (!Array.isArray(message.content))
      continue;
    if (message.role === "user") {
      const parts = [];
      const flush = () => {
        if (parts.length > 0) {
          messages.push({ role: "user", content: parts.splice(0, parts.length) });
        }
      };
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push(textPart(block.text));
        } else if (block.type === "image" && block.source?.data) {
          parts.push({ type: "image", mimeType: block.source.media_type ?? "image/png", base64Data: block.source.data });
        } else if (block.type === "tool_result") {
          flush();
          const text = toolResultText(block.content);
          const content = [
            ...block.is_error ? [textPart(`(tool error)
` + text)] : [textPart(text)],
            ...toolResultImages(block.content).map((image) => ({ type: "image", ...image }))
          ];
          messages.push({ role: "tool", content, tool_call_id: block.tool_use_id });
        }
      }
      flush();
    } else {
      const parts = [];
      const toolCalls = [];
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push(textPart(block.text));
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {})
          });
        }
      }
      const item = {
        role: "assistant",
        content: parts.length > 0 ? parts : ""
      };
      if (toolCalls.length > 0)
        item.tool_calls = toolCalls;
      if (parts.length > 0 || toolCalls.length > 0)
        messages.push(item);
    }
  }
  const tools = req.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema ?? {}
  }));
  const completionOpts = {};
  if (typeof req.max_tokens === "number")
    completionOpts.maxOutputTokens = req.max_tokens;
  if (typeof req.temperature === "number")
    completionOpts.temperature = req.temperature;
  if (typeof req.top_p === "number")
    completionOpts.topP = req.top_p;
  if (typeof req.top_k === "number")
    completionOpts.topK = req.top_k;
  return { modelUid: req.model, messages, tools, completionOpts };
}
function finishReasonToAnthropic(reason) {
  switch (reason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    case "stop_sequence":
      return "stop_sequence";
    case "stop":
    case undefined:
    default:
      return "end_turn";
  }
}
function chatEventToAnthropic(event, accumulated) {
  switch (event.kind) {
    case "text":
      return [{ piece: "content_block", block: { type: "text", text: event.text } }];
    case "reasoning":
      return [{ piece: "content_block", block: { type: "thinking", thinking: event.text, signature: "" } }];
    case "tool_call_start":
      return [
        { piece: "content_block", block: { type: "tool_use", id: event.id, name: event.name, input: {} } }
      ];
    case "tool_call_args":
      return [{ piece: "partial_json", id: event.id ?? "", jsonDelta: event.argsDelta }];
    case "finish":
      return [{ piece: "stop_reason", stopReason: finishReasonToAnthropic(event.reason) }];
    case "usage": {
      const usage = {
        input_tokens: event.promptTokens ?? accumulated.input_tokens,
        output_tokens: event.completionTokens ?? accumulated.output_tokens
      };
      if (event.cacheCreationInputTokens)
        usage.cache_creation_input_tokens = event.cacheCreationInputTokens;
      if (event.cachedInputTokens)
        usage.cache_read_input_tokens = event.cachedInputTokens;
      return [{ piece: "usage", usage }];
    }
  }
}
async function chatToAnthropicResponse(request) {
  const content = [];
  const rawArgs = new Map;
  let stopReason = "end_turn";
  const usage = { input_tokens: 0, output_tokens: 0 };
  for await (const event of streamChatEventsImpl(request)) {
    for (const piece of chatEventToAnthropic(event, usage)) {
      if (piece.piece === "content_block") {
        if (piece.block.type === "text" && content.at(-1)?.type === "text") {
          content.at(-1).text += piece.block.text;
        } else {
          content.push(piece.block);
        }
      } else if (piece.piece === "partial_json") {
        const index = content.findIndex((block) => block.type === "tool_use" && (piece.id === "" || block.id === piece.id));
        const target = index === -1 ? content.length - 1 : index;
        rawArgs.set(target, (rawArgs.get(target) ?? "") + piece.jsonDelta);
      } else if (piece.piece === "stop_reason") {
        stopReason = piece.stopReason;
      } else {
        Object.assign(usage, piece.usage);
      }
    }
  }
  for (const [index, raw] of rawArgs) {
    const block = content[index];
    if (!block || block.type !== "tool_use")
      continue;
    try {
      block.input = raw ? JSON.parse(raw) : {};
    } catch {
      block.input = { _raw: raw };
    }
  }
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: request.modelUid,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage
  };
}
async function* streamChatEventsAsAnthropic(request) {
  const usage = { input_tokens: 0, output_tokens: 0 };
  let stopReason = null;
  let current = null;
  let nextIndex = 0;
  const closeEvent = (cur) => ({
    event: "content_block_stop",
    data: { type: "content_block_stop", index: cur.index }
  });
  const openEvent = (kind, index, extra = {}) => ({
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index,
      content_block: kind === "text" ? { type: "text", text: "" } : kind === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "tool_use", name: "", input: {}, ...extra }
    }
  });
  const delta = (type, payload) => ({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: current?.index ?? 0, delta: { type, ...payload } }
  });
  yield {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        model: request.modelUid,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }
  };
  for await (const event of streamChatEventsImpl(request)) {
    if (event.kind === "text") {
      if (current?.kind !== "text") {
        if (current)
          yield closeEvent(current);
        yield openEvent("text", nextIndex);
        current = { kind: "text", index: nextIndex++ };
      }
      yield delta("text_delta", { text: event.text });
    } else if (event.kind === "reasoning") {
      if (current?.kind !== "thinking") {
        if (current)
          yield closeEvent(current);
        yield openEvent("thinking", nextIndex);
        current = { kind: "thinking", index: nextIndex++ };
      }
      yield delta("thinking_delta", { thinking: event.text });
    } else if (event.kind === "tool_call_start") {
      if (current)
        yield closeEvent(current);
      yield openEvent("tool_use", nextIndex, { id: event.id, name: event.name });
      current = { kind: "tool_use", index: nextIndex++ };
    } else if (event.kind === "tool_call_args") {
      if (current?.kind === "tool_use") {
        yield delta("input_json_delta", { partial_json: event.argsDelta });
      }
    } else if (event.kind === "finish") {
      stopReason = finishReasonToAnthropic(event.reason);
    } else if (event.kind === "usage") {
      if (event.promptTokens !== undefined)
        usage.input_tokens = event.promptTokens;
      if (event.completionTokens !== undefined)
        usage.output_tokens = event.completionTokens;
      if (event.cacheCreationInputTokens)
        usage.cache_creation_input_tokens = event.cacheCreationInputTokens;
      if (event.cachedInputTokens)
        usage.cache_read_input_tokens = event.cachedInputTokens;
    }
  }
  if (current)
    yield closeEvent(current);
  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens }
    }
  };
  yield { event: "message_stop", data: { type: "message_stop" } };
}
function sseSerialize(event) {
  return `event: ${event.event}
data: ${JSON.stringify(event.data)}

`;
}
function countTokens(req) {
  const serialized = JSON.stringify({ messages: req.messages ?? [], system: req.system ?? null, tools: req.tools ?? [] });
  return { input_tokens: Math.ceil(serialized.length / 4) };
}

// src/devin-anthropic-proxy/server.ts
var DEFAULT_PORT = 42100;
var MAX_BODY_BYTES = 32 * 1024 * 1024;
var errorBody = (type, message) => ({
  type: "error",
  error: { type, message }
});
var FAST_DROP_TOOLS = new Set([
  "WebFetch",
  "WebSearch",
  "Task",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "NotebookEdit"
]);
function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectPromise(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", rejectPromise);
  });
}
function clientKeyOf(req) {
  for (const name of ["x-api-key", "anthropic-api-key", "api-key"]) {
    const v = req.headers[name];
    if (typeof v === "string" && v)
      return v;
  }
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth) {
    return auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  }
  return null;
}
async function createServer(options = {}) {
  const clientKey = options.clientKey ?? process.env.DEVIN_CLAUDE_CLIENT_KEY ?? LOCAL_CLIENT_KEY;
  const wantedPort = options.port ?? (Number(process.env.DEVIN_CLAUDE_PORT) || DEFAULT_PORT);
  const state = {};
  const noteCatalog = async (apiKey) => {
    try {
      const catalog = await getCachedCatalog(apiKey);
      if (catalog)
        state.catalogSize = catalog.byUid.size;
    } catch {}
  };
  const log = (method, path, status) => {
    console.log(`[devin-proxy] ${method} ${path} -> ${status}`);
  };
  const sendJson = (res, method, path, status, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
    res.end(payload);
    log(method, path, status);
  };
  const sendError = (res, method, path, status, type, message) => {
    sendJson(res, method, path, status, errorBody(type, message));
  };
  const handle = async (req, res) => {
    const method = req.method ?? "GET";
    const rawPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/";
    const fast = rawPath === "/fast" || rawPath.startsWith("/fast/");
    const path = fast ? rawPath.slice("/fast".length) || "/" : rawPath;
    if (path === "/health") {
      if (method !== "GET") {
        sendError(res, method, path, 405, "not_found_error", `Method ${method} not allowed`);
        return;
      }
      const body = { status: "ok" };
      if (state.catalogSize !== undefined)
        body.catalogSize = state.catalogSize;
      body.authenticated = getApiKey() !== null;
      sendJson(res, method, path, 200, body);
      return;
    }
    const isMessages = path === "/v1/messages";
    const isCountTokens = path === "/v1/messages/count_tokens";
    const isModels = path === "/v1/models";
    const modelIdMatch = path.startsWith("/v1/models/") ? decodeURIComponent(path.slice("/v1/models/".length)) : null;
    const knownPath = isMessages || isCountTokens || isModels || modelIdMatch !== null;
    if (!knownPath) {
      sendError(res, method, path, 404, "not_found_error", `Not found: ${path}`);
      return;
    }
    const presentedKey = clientKeyOf(req);
    if (presentedKey !== clientKey) {
      const whichHeader = req.headers["x-api-key"] ? "x-api-key" : req.headers["anthropic-api-key"] ? "anthropic-api-key" : req.headers["api-key"] ? "api-key" : req.headers.authorization ? "authorization" : "none";
      const fp = (s) => s === null ? "null" : `len=${s.length} head="${s.slice(0, 6)}" tail="${s.slice(-4)}"`;
      console.error(`[devin-proxy] 401 auth on ${path}: header=${whichHeader} ${presentedKey === null ? "absent" : `mismatch ${fp(presentedKey)} (expected ${fp(clientKey)})`}`);
      sendError(res, method, path, 401, "authentication_error", "invalid x-api-key");
      return;
    }
    const apiKey = getApiKey() ?? "";
    if (isModels || modelIdMatch !== null) {
      if (method !== "GET") {
        sendError(res, method, path, 405, "not_found_error", `Method ${method} not allowed`);
        return;
      }
      if (modelIdMatch !== null) {
        const model = await getAnthropicModel(modelIdMatch, apiKey);
        await noteCatalog(apiKey);
        if (!model) {
          sendError(res, method, path, 404, "not_found_error", `model: ${modelIdMatch}`);
          return;
        }
        sendJson(res, method, path, 200, model);
        return;
      }
      const list = await listAnthropicModels(apiKey);
      await noteCatalog(apiKey);
      sendJson(res, method, path, 200, list);
      return;
    }
    if (method !== "POST") {
      sendError(res, method, path, 405, "not_found_error", `Method ${method} not allowed`);
      return;
    }
    let body;
    try {
      const raw = await readBody(req);
      const parsed = JSON.parse(raw.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("body must be a JSON object");
      body = parsed;
    } catch (err) {
      sendError(res, method, path, 400, "invalid_request_error", `Invalid JSON body: ${err.message}`);
      return;
    }
    if (isCountTokens) {
      if (typeof body.model !== "string" || !body.model) {
        sendError(res, method, path, 400, "invalid_request_error", "missing required field: model");
        return;
      }
      if (!Array.isArray(body.messages)) {
        sendError(res, method, path, 400, "invalid_request_error", "missing required field: messages");
        return;
      }
      sendJson(res, method, path, 200, countTokens(body));
      return;
    }
    if (typeof body.model !== "string" || !body.model) {
      sendError(res, method, path, 400, "invalid_request_error", "missing required field: model");
      return;
    }
    if (!Array.isArray(body.messages)) {
      sendError(res, method, path, 400, "invalid_request_error", "missing required field: messages");
      return;
    }
    if (typeof body.max_tokens !== "number") {
      sendError(res, method, path, 400, "invalid_request_error", "missing required field: max_tokens");
      return;
    }
    if (!apiKey) {
      sendError(res, method, path, 401, "authentication_error", "no Devin credential — run `devin-claude login`");
      return;
    }
    let modelUid;
    try {
      modelUid = await resolveModelId(body.model, apiKey);
      await noteCatalog(apiKey);
    } catch (err) {
      if (err instanceof ModelNotFoundError) {
        sendError(res, method, path, 400, "invalid_request_error", err.message);
        return;
      }
      throw err;
    }
    if (fast) {
      if (Array.isArray(body.tools)) {
        body.tools = body.tools.filter((t) => !FAST_DROP_TOOLS.has(String(t.name)));
      }
      if (typeof body.max_tokens === "number")
        body.max_tokens = Math.min(body.max_tokens, 16384);
      const terse = `

[claude-devin --fast] Be terse: minimal prose; prefer tool calls over explanation; no summaries unless asked.`;
      if (typeof body.system === "string")
        body.system += terse;
      else if (Array.isArray(body.system)) {
        const last = body.system[body.system.length - 1];
        if (last && last.type === "text" && typeof last.text === "string")
          last.text += terse;
      }
    }
    const converted = anthropicToChat({ ...body, model: modelUid });
    const abort = new AbortController;
    res.on("close", () => abort.abort());
    const request = {
      apiKey,
      apiServerUrl: loadCredentials()?.apiServerUrl,
      modelUid: converted.modelUid,
      messages: converted.messages,
      tools: converted.tools,
      completionOpts: converted.completionOpts,
      signal: abort.signal
    };
    if (body.stream === true) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
      });
      log(method, path, 200);
      try {
        for await (const event of streamChatEventsAsAnthropic(request)) {
          res.write(sseSerialize(event));
        }
      } catch (err) {
        const e = err;
        const type = e instanceof ModelNotFoundError ? "invalid_request_error" : e instanceof CloudChatError ? "api_error" : "api_error";
        res.write(`event: error
data: ${JSON.stringify(errorBody(type, e.message))}

`);
        if (!(e instanceof ModelNotFoundError)) {
          res.write(`event: message_stop
data: {"type":"message_stop"}

`);
        }
      }
      res.end();
      return;
    }
    try {
      const message = await chatToAnthropicResponse(request);
      sendJson(res, method, path, 200, message);
    } catch (err) {
      const e = err;
      const status = e instanceof ModelNotFoundError ? 400 : e instanceof CloudChatError ? 502 : 500;
      const type = e instanceof ModelNotFoundError ? "invalid_request_error" : "api_error";
      sendError(res, method, path, status, type, e.message);
    }
  };
  const server = httpCreateServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) {
        const path = req.url ?? "/";
        sendError(res, req.method ?? "GET", path, 500, "api_error", err.message);
      } else {
        res.end();
      }
    });
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(wantedPort, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : wantedPort;
  const apiKey = getApiKey();
  if (apiKey) {
    noteCatalog(apiKey).catch(() => {});
  }
  return { server, port };
}
var invokedAsScript = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href && /server\.(ts|mjs|js)$/.test(process.argv[1]);
if (invokedAsScript && true) {
  const port = Number(process.env.DEVIN_CLAUDE_PORT) || DEFAULT_PORT;
  const clientKey = process.env.DEVIN_CLAUDE_CLIENT_KEY || LOCAL_CLIENT_KEY;
  createServer({ port, clientKey }).then(({ port: bound }) => console.log(`[devin-proxy] listening on http://127.0.0.1:${bound}`)).catch((err) => {
    console.error(`[devin-proxy] failed to start: ${err.message}`);
    process.exit(1);
  });
}
// src/devin-anthropic-proxy/login.ts
import { spawn } from "node:child_process";
import { createServer as createServer2 } from "node:http";
import { createInterface } from "node:readline";

// src/auth/exchange.ts
class DevinAuthError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.name = "DevinAuthError";
    this.status = status;
  }
}
async function exchangeCode(input) {
  const response = await fetch(`${AUTH_API_URL}/auth/cli/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code: input.code, code_verifier: input.verifier }),
    signal: AbortSignal.timeout(30000)
  }).catch((cause) => {
    throw new DevinAuthError(`Token exchange request to ${AUTH_API_URL} failed: ${String(cause)}`, 0);
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text || `Token exchange failed with HTTP ${response.status}`;
    try {
      const err = JSON.parse(text);
      if (err.message)
        message = err.message;
    } catch {}
    throw new DevinAuthError(message, response.status);
  }
  const token = JSON.parse(text).token;
  if (!token)
    throw new DevinAuthError("Token exchange succeeded but the response had no token", response.status);
  return `${TOKEN_PREFIX}${token}`;
}

// src/auth/pkce.ts
var encoder = new TextEncoder;
function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}
function generateVerifier() {
  return randomToken();
}
async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  return base64url(new Uint8Array(digest));
}
function generateState() {
  return randomToken();
}

// src/auth/url.ts
function authorizeUrl(input) {
  const url = new URL("/auth/cli/continue", WEBAPP_URL);
  if (input.redirectUri)
    url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// src/devin-anthropic-proxy/login.ts
var CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
function toStoredCredential(token) {
  return saveCredentials({ apiKey: token, apiServerUrl: undefined });
}
function openBrowser(url) {
  const detached = { detached: true, stdio: "ignore" };
  if (process.platform === "win32") {
    spawn("rundll32", ["url.dll,FileProtocolHandler", url], detached).unref();
    return;
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(cmd, [url], detached).unref();
}
function startCallbackServer(state, timeoutMs = CALLBACK_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settle;
    let fail;
    const code = new Promise((res, rej) => {
      settle = res;
      fail = rej;
    });
    let stopped = false;
    let timer;
    const stop = () => {
      if (stopped)
        return;
      stopped = true;
      if (timer)
        clearTimeout(timer);
      server.close();
    };
    const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` + `<body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>${body}</p></body></html>`;
    const server = createServer2((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status, title, body) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page(title, body));
      };
      if (url.pathname !== CALLBACK_PATH)
        return send(404, "Not found", "");
      if (url.searchParams.get("state") !== state) {
        return send(400, "Invalid state parameter", "This may indicate a security issue. Please try again.");
      }
      const received = url.searchParams.get("code");
      if (!received) {
        return send(400, "No authorization code received", "Please return to the terminal and try again.");
      }
      settle?.(received);
      if (timer)
        clearTimeout(timer);
      return send(200, "Signed in to Devin", "You can close this tab and return to the terminal.");
    });
    server.once("error", (cause) => reject(cause instanceof Error ? cause : new Error("Failed to bind loopback server")));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      timer = setTimeout(() => {
        fail?.(new Error(`Login timed out after ${Math.round(timeoutMs / 1000)}s`));
        stop();
      }, timeoutMs);
      resolve({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        code,
        close: () => {
          fail?.(new Error("Login cancelled"));
          stop();
        }
      });
    });
  });
}
async function loginAuto() {
  const verifier = generateVerifier();
  const state = generateState();
  const server = await startCallbackServer(state);
  const url = authorizeUrl({ state, challenge: await challengeFor(verifier), redirectUri: server.redirectUri });
  console.log("Opening Devin sign-in in your browser…");
  console.log(`If it does not open, visit:
${url}`);
  openBrowser(url);
  try {
    const code = await server.code;
    const token = await exchangeCode({ code, verifier });
    toStoredCredential(token);
    return token;
  } finally {
    server.close();
  }
}
async function loginManual(readLine) {
  const verifier = generateVerifier();
  const state = generateState();
  const url = authorizeUrl({ state, challenge: await challengeFor(verifier) });
  console.log("Open this URL in your browser and paste the code it shows:");
  console.log(url);
  const prompt = readLine ?? (() => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question("Authorization code: ", (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  });
  const code = (await prompt()).trim();
  if (!code)
    throw new Error("Manual login requires the pasted authorization code");
  const token = await exchangeCode({ code, verifier });
  toStoredCredential(token);
  return token;
}
// src/devin-anthropic-proxy/bundle-entry.ts
import { resolve as resolve2 } from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";
var isMain = typeof process !== "undefined" && !!process.argv[1] && import.meta.url === pathToFileURL2(resolve2(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.DEVIN_CLAUDE_PORT) || 42100;
  const clientKey = process.env.DEVIN_CLAUDE_CLIENT_KEY || LOCAL_CLIENT_KEY;
  createServer({ port, clientKey }).then(({ port: bound }) => console.log(`[devin-proxy] listening on http://127.0.0.1:${bound}`)).catch((err) => {
    console.error(`[devin-proxy] failed to start: ${err.message}`);
    process.exit(1);
  });
  if (!getApiKey()) {
    console.warn("[devin-proxy] warning: no Devin credential — run `claude-devin login`");
  }
}
export {
  LOCAL_CLIENT_KEY,
  clearCredentials,
  createServer,
  credentialsPath,
  getApiKey,
  loadCredentials,
  loginAuto,
  loginManual,
  saveCredentials
};
