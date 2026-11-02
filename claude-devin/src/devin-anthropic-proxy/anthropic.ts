/**
 * Anthropic Messages API ⇄ Cascade chat protocol translation.
 *
 * - `anthropicToChat`  : `POST /v1/messages` body → `StreamChatRequest` parts.
 * - `chatEventToAnthropic` : `ChatEvent` → JSON pieces for non-stream replies.
 * - `streamChatEventsAsAnthropic` : `ChatEvent` stream → Anthropic SSE payloads.
 * - `countTokens` : documented estimate for `/v1/messages/count_tokens`.
 *
 * Node ≥18 ESM, no external deps.
 */

import {
  streamChatEvents,
  type ChatContent,
  type ChatEvent,
  type ChatHistoryItem,
  type ChatImage,
  type ChatToolCall,
  type ChatToolDefinition,
  type CompletionOptions,
  type StreamChatRequest,
} from "../protocol/chat.ts"

/**
 * Test seam: replace the chat-event source without touching the network.
 * `__setStreamChatEventsForTest()` with no argument restores the real impl.
 */
let streamChatEventsImpl: typeof streamChatEvents = streamChatEvents
export function __setStreamChatEventsForTest(impl?: typeof streamChatEvents): void {
  streamChatEventsImpl = impl ?? streamChatEvents
}

// --- Anthropic request types (the subset the proxy accepts) ---

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result"
      tool_use_id: string
      content?: string | AnthropicContentBlock[]
      is_error?: boolean
    }

export interface AnthropicMessage {
  role: "user" | "assistant"
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema?: unknown
}

export interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  max_tokens: number
  stream?: boolean
  temperature?: number
  top_p?: number
  top_k?: number
  system?: string | AnthropicContentBlock[]
  tools?: AnthropicTool[]
  [key: string]: unknown
}

export interface AnthropicSseEvent {
  event: string
  data: Record<string, unknown>
}

export interface ConvertedChat {
  modelUid: string
  messages: ChatHistoryItem[]
  tools?: ChatToolDefinition[]
  completionOpts: CompletionOptions
}

// --- Request conversion ---

const textPart = (text: string): { type: "text"; text: string } => ({ type: "text", text })

/** Collect the text inside a `tool_result` content (string or block array). */
function toolResultText(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
}

/** Images inside a `tool_result` content are forwarded as image parts. */
function toolResultImages(content: string | AnthropicContentBlock[] | undefined): ChatImage[] {
  if (!Array.isArray(content)) return []
  const images: ChatImage[] = []
  for (const block of content) {
    if (block.type === "image" && block.source?.data) {
      images.push({ mimeType: block.source.media_type ?? "image/png", base64Data: block.source.data })
    }
  }
  return images
}

/**
 * Convert an Anthropic `POST /v1/messages` body into the Cascade request
 * pieces. `model` is passed through as `modelUid` — the caller resolves it via
 * `resolveModelId` first. `system` becomes a leading `role:"system"` item;
 * `collapseSystemIntoUser` in protocol/chat.ts folds it into the first user
 * turn at encode time.
 */
export function anthropicToChat(req: AnthropicRequest): ConvertedChat {
  const messages: ChatHistoryItem[] = []

  if (req.system !== undefined && req.system !== null) {
    const text =
      typeof req.system === "string"
        ? req.system
        : req.system
            .map((block) => (block.type === "text" ? block.text : ""))
            .filter(Boolean)
            .join("\n")
    if (text) messages.push({ role: "system", content: [{ type: "text", text }] })
  }

  for (const message of req.messages ?? []) {
    // String content → plain text part for either role.
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: [{ type: "text", text: message.content }] })
      continue
    }
    if (!Array.isArray(message.content)) continue

    if (message.role === "user") {
      // User turns may mix text/image parts with tool_result blocks; each
      // tool_result becomes its own `tool`-role item carrying tool_call_id.
      const parts: Exclude<ChatContent, string> = []
      const flush = () => {
        if (parts.length > 0) {
          messages.push({ role: "user", content: parts.splice(0, parts.length) })
        }
      }
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push(textPart(block.text))
        } else if (block.type === "image" && block.source?.data) {
          parts.push({ type: "image", mimeType: block.source.media_type ?? "image/png", base64Data: block.source.data })
        } else if (block.type === "tool_result") {
          flush()
          const text = toolResultText(block.content)
          const content: Exclude<ChatContent, string> = [
            ...(block.is_error ? [textPart("(tool error)\n" + text)] : [textPart(text)]),
            ...toolResultImages(block.content).map((image) => ({ type: "image" as const, ...image })),
          ]
          messages.push({ role: "tool", content, tool_call_id: block.tool_use_id })
        }
        // thinking/redacted_thinking blocks in history are dropped: Cascade
        // has no channel for replayed reasoning.
      }
      flush()
    } else {
      // assistant: text + tool_use blocks on a single item.
      const parts: Exclude<ChatContent, string> = []
      const toolCalls: ChatToolCall[] = []
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push(textPart(block.text))
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
          })
        }
      }
      const item: ChatHistoryItem = {
        role: "assistant",
        content: parts.length > 0 ? parts : "",
      }
      if (toolCalls.length > 0) item.tool_calls = toolCalls
      // Skip assistant items that carry neither text nor calls.
      if (parts.length > 0 || toolCalls.length > 0) messages.push(item)
    }
  }

  const tools: ChatToolDefinition[] | undefined = req.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema ?? {},
  }))

  const completionOpts: CompletionOptions = {}
  if (typeof req.max_tokens === "number") completionOpts.maxOutputTokens = req.max_tokens
  if (typeof req.temperature === "number") completionOpts.temperature = req.temperature
  if (typeof req.top_p === "number") completionOpts.topP = req.top_p
  if (typeof req.top_k === "number") completionOpts.topK = req.top_k

  return { modelUid: req.model, messages, tools, completionOpts }
}

// --- Finish reason + usage mapping ---

/** Cascade StopReason → Anthropic `stop_reason`. */
export function finishReasonToAnthropic(reason: string | undefined): string {
  switch (reason) {
    case "length":
      return "max_tokens"
    case "tool_calls":
      return "tool_use"
    case "content_filter":
      return "content_filter"
    case "stop_sequence":
      return "stop_sequence"
    case "stop":
    case undefined:
    default:
      return "end_turn"
  }
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// --- Non-streaming JSON pieces ---

export type AnthropicMessagePiece =
  | { piece: "content_block"; block: Record<string, unknown> }
  | { piece: "partial_json"; id: string; jsonDelta: string }
  | { piece: "stop_reason"; stopReason: string }
  | { piece: "usage"; usage: AnthropicUsage }

/**
 * Map one `ChatEvent` to the JSON fragment(s) a non-streaming response needs.
 * Returns an array since one event can imply more than one fragment (none
 * currently do, but the shape keeps callers future-proof). Content blocks are
 * appended in arrival order; `input_json_delta` fragments accumulate under the
 * owning `tool_use` block id.
 */
export function chatEventToAnthropic(event: ChatEvent, accumulated: AnthropicUsage): AnthropicMessagePiece[] {
  switch (event.kind) {
    case "text":
      return [{ piece: "content_block", block: { type: "text", text: event.text } }]
    case "reasoning":
      return [{ piece: "content_block", block: { type: "thinking", thinking: event.text, signature: "" } }]
    case "tool_call_start":
      return [
        { piece: "content_block", block: { type: "tool_use", id: event.id, name: event.name, input: {} } },
      ]
    case "tool_call_args":
      return [{ piece: "partial_json", id: event.id ?? "", jsonDelta: event.argsDelta }]
    case "finish":
      return [{ piece: "stop_reason", stopReason: finishReasonToAnthropic(event.reason) }]
    case "usage": {
      const usage: AnthropicUsage = {
        input_tokens: event.promptTokens ?? accumulated.input_tokens,
        output_tokens: event.completionTokens ?? accumulated.output_tokens,
      }
      if (event.cacheCreationInputTokens) usage.cache_creation_input_tokens = event.cacheCreationInputTokens
      if (event.cachedInputTokens) usage.cache_read_input_tokens = event.cachedInputTokens
      return [{ piece: "usage", usage }]
    }
  }
}

export interface AnthropicMessageResponse {
  id: string
  type: "message"
  role: "assistant"
  model: string
  content: Array<Record<string, unknown>>
  stop_reason: string
  stop_sequence: null
  usage: AnthropicUsage
}

/**
 * Consume a `StreamChatRequest` end-to-end and build the non-streaming
 * Anthropic message body. `tool_call_args` deltas are concatenated into the
 * matching `tool_use.input` (parsed as JSON at the end, raw string fallback).
 */
export async function chatToAnthropicResponse(request: StreamChatRequest): Promise<AnthropicMessageResponse> {
  const content: Array<Record<string, unknown>> = []
  const rawArgs = new Map<number, string>()
  let stopReason = "end_turn"
  const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 }

  for await (const event of streamChatEventsImpl(request)) {
    for (const piece of chatEventToAnthropic(event, usage)) {
      if (piece.piece === "content_block") {
        if (piece.block.type === "text" && content.at(-1)?.type === "text") {
          // Adjacent text deltas merge into one block (the API itself can
          // segment text arbitrarily; one block keeps the response stable).
          ;(content.at(-1) as { text: string }).text += piece.block.text as string
        } else {
          content.push(piece.block)
        }
      } else if (piece.piece === "partial_json") {
        const index = content.findIndex(
          (block) => block.type === "tool_use" && (piece.id === "" || block.id === piece.id),
        )
        const target = index === -1 ? content.length - 1 : index
        rawArgs.set(target, (rawArgs.get(target) ?? "") + piece.jsonDelta)
      } else if (piece.piece === "stop_reason") {
        stopReason = piece.stopReason
      } else {
        Object.assign(usage, piece.usage)
      }
    }
  }

  for (const [index, raw] of rawArgs) {
    const block = content[index]
    if (!block || block.type !== "tool_use") continue
    try {
      block.input = raw ? JSON.parse(raw) : {}
    } catch {
      block.input = { _raw: raw }
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
    usage,
  }
}

// --- SSE streaming ---

interface BlockState {
  kind: "text" | "thinking" | "tool_use"
  index: number
}

/**
 * Wrap `streamChatEvents` and yield complete Anthropic SSE payloads in order:
 * `message_start` (usage placeholders), then per-block
 * `content_block_start`/`content_block_delta`/`content_block_stop`, a final
 * `message_delta` carrying the real usage once a `kind:"usage"` event arrives,
 * and `message_stop`. Reasoning → `thinking` blocks; tool calls → `tool_use`
 * blocks whose arguments stream as `input_json_delta`.
 */
export async function* streamChatEventsAsAnthropic(request: StreamChatRequest): AsyncGenerator<AnthropicSseEvent> {
  const usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 }
  let stopReason: string | null = null
  let current: BlockState | null = null
  let nextIndex = 0

  const closeEvent = (cur: BlockState): AnthropicSseEvent => ({
    event: "content_block_stop",
    data: { type: "content_block_stop", index: cur.index },
  })

  const openEvent = (
    kind: BlockState["kind"],
    index: number,
    extra: Record<string, unknown> = {},
  ): AnthropicSseEvent => ({
    event: "content_block_start",
    data: {
      type: "content_block_start",
      index,
      content_block:
        kind === "text"
          ? { type: "text", text: "" }
          : kind === "thinking"
            ? { type: "thinking", thinking: "", signature: "" }
            : { type: "tool_use", name: "", input: {}, ...extra },
    },
  })

  const delta = (type: string, payload: Record<string, unknown>): AnthropicSseEvent => ({
    event: "content_block_delta",
    data: { type: "content_block_delta", index: current?.index ?? 0, delta: { type, ...payload } },
  })

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
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
  }

  for await (const event of streamChatEventsImpl(request)) {
    if (event.kind === "text") {
      if (current?.kind !== "text") {
        if (current) yield closeEvent(current)
        yield openEvent("text", nextIndex)
        current = { kind: "text", index: nextIndex++ }
      }
      yield delta("text_delta", { text: event.text })
    } else if (event.kind === "reasoning") {
      if (current?.kind !== "thinking") {
        if (current) yield closeEvent(current)
        yield openEvent("thinking", nextIndex)
        current = { kind: "thinking", index: nextIndex++ }
      }
      yield delta("thinking_delta", { thinking: event.text })
    } else if (event.kind === "tool_call_start") {
      if (current) yield closeEvent(current)
      yield openEvent("tool_use", nextIndex, { id: event.id, name: event.name })
      current = { kind: "tool_use", index: nextIndex++ }
    } else if (event.kind === "tool_call_args") {
      if (current?.kind === "tool_use") {
        yield delta("input_json_delta", { partial_json: event.argsDelta })
      }
    } else if (event.kind === "finish") {
      stopReason = finishReasonToAnthropic(event.reason)
    } else if (event.kind === "usage") {
      if (event.promptTokens !== undefined) usage.input_tokens = event.promptTokens
      if (event.completionTokens !== undefined) usage.output_tokens = event.completionTokens
      if (event.cacheCreationInputTokens) usage.cache_creation_input_tokens = event.cacheCreationInputTokens
      if (event.cachedInputTokens) usage.cache_read_input_tokens = event.cachedInputTokens
    }
  }

  if (current) yield closeEvent(current)

  // A single terminal `message_delta` after the source stream ends guarantees
  // `message_delta.usage` carries the real numbers whenever Cascade reported
  // them — including when the usage frame arrives after the finish frame.
  yield {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
  }

  yield { event: "message_stop", data: { type: "message_stop" } }
}

/** Serialize one `AnthropicSseEvent` into SSE wire text (`event:`/`data:`). */
export function sseSerialize(event: AnthropicSseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

// --- Token counting (estimate) ---

/**
 * `/v1/messages/count_tokens` handler.
 *
 * Exact counting is impossible: Cognition's tokenizer is unpublished and the
 * vendored protocol encodes `Math.floor(text.length / 4)` in the prompt's
 * token-count field. This returns the same 4-chars-per-token estimate over the
 * serialized message payload, documented as approximate.
 */
export function countTokens(req: Pick<AnthropicRequest, "messages" | "system" | "tools">): {
  input_tokens: number
} {
  const serialized = JSON.stringify({ messages: req.messages ?? [], system: req.system ?? null, tools: req.tools ?? [] })
  return { input_tokens: Math.ceil(serialized.length / 4) }
}
