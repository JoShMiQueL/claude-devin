import { afterEach, describe, expect, test } from "bun:test"

import {
  __setStreamChatEventsForTest,
  anthropicToChat,
  chatEventToAnthropic,
  chatToAnthropicResponse,
  countTokens,
  finishReasonToAnthropic,
  sseSerialize,
  streamChatEventsAsAnthropic,
  type AnthropicRequest,
  type AnthropicSseEvent,
} from "../../src/devin-anthropic-proxy/anthropic.ts"
import type { ChatEvent, StreamChatRequest } from "../../src/protocol/chat.ts"

const chatRequest: StreamChatRequest = { apiKey: "k", modelUid: "claude-test", messages: [] }

afterEach(() => {
  __setStreamChatEventsForTest()
})

const stubEvents = (events: ChatEvent[]) => {
  __setStreamChatEventsForTest(async function* () {
    for (const event of events) yield event
  })
}

const collect = async (gen: AsyncGenerator<AnthropicSseEvent>) => {
  const out: AnthropicSseEvent[] = []
  for await (const event of gen) out.push(event)
  return out
}

describe("anthropicToChat", () => {
  test("string content becomes a single text part per message", () => {
    const req: AnthropicRequest = {
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "again" },
      ],
    }
    const out = anthropicToChat(req)
    expect(out.modelUid).toBe("claude-sonnet-4-5")
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ])
    expect(out.completionOpts.maxOutputTokens).toBe(64)
  })

  test("system string becomes a leading system item", () => {
    const out = anthropicToChat({
      model: "m",
      max_tokens: 1,
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "be terse" }] })
    expect(out.messages[1]!.role).toBe("user")
  })

  test("system block array is flattened to joined text", () => {
    const out = anthropicToChat({
      model: "m",
      max_tokens: 1,
      system: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ],
      messages: [{ role: "user", content: "hi" }],
    })
    expect(out.messages[0]).toEqual({ role: "system", content: [{ type: "text", text: "part one\npart two" }] })
  })

  test("assistant tool_use and user tool_result round-trip into chat roles", () => {
    const out = anthropicToChat({
      model: "m",
      max_tokens: 1,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "let me check" },
            { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "/a" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "file bytes" },
            { type: "text", text: "what next?" },
          ],
        },
      ],
    })
    const assistant = out.messages[0]!
    expect(assistant.role).toBe("assistant")
    expect(assistant.tool_calls).toEqual([{ id: "tu_1", name: "read_file", arguments: JSON.stringify({ path: "/a" }) }])
    const tool = out.messages[1]!
    expect(tool.role).toBe("tool")
    expect(tool.tool_call_id).toBe("tu_1")
    expect(tool.content).toEqual([{ type: "text", text: "file bytes" }])
    const trailing = out.messages[2]!
    expect(trailing.role).toBe("user")
    expect(trailing.content).toEqual([{ type: "text", text: "what next?" }])
  })

  test("is_error tool_result is prefixed", () => {
    const out = anthropicToChat({
      model: "m",
      max_tokens: 1,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "boom", is_error: true }] },
      ],
    })
    expect(out.messages[0]!.content).toEqual([{ type: "text", text: "(tool error)\nboom" }])
  })

  test("image blocks become image parts (user turn and tool_result)", () => {
    const out = anthropicToChat({
      model: "m",
      max_tokens: 1,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
            {
              type: "tool_result",
              tool_use_id: "t2",
              content: [
                { type: "text", text: "screenshot" },
                { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "REVG" } },
              ],
            },
          ],
        },
      ],
    })
    const user = out.messages[0]!
    expect(user.content).toEqual([
      { type: "text", text: "look" },
      { type: "image", mimeType: "image/png", base64Data: "QUJD" },
    ])
    const tool = out.messages[1]!
    expect(tool.role).toBe("tool")
    expect(tool.content).toEqual([
      { type: "text", text: "screenshot" },
      { type: "image", mimeType: "image/jpeg", base64Data: "REVG" },
    ])
  })

  test("tools and sampling options map to chat definitions", () => {
    const out = anthropicToChat({
      model: "m",
      max_tokens: 32,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 5,
      tools: [{ name: "grep", description: "search", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "x" }],
    })
    expect(out.tools).toEqual([{ name: "grep", description: "search", parameters: { type: "object" } }])
    expect(out.completionOpts).toEqual({ maxOutputTokens: 32, temperature: 0.2, topP: 0.9, topK: 5 })
  })
})

describe("finishReasonToAnthropic", () => {
  test("maps every Cascade reason", () => {
    expect(finishReasonToAnthropic("length")).toBe("max_tokens")
    expect(finishReasonToAnthropic("tool_calls")).toBe("tool_use")
    expect(finishReasonToAnthropic("content_filter")).toBe("content_filter")
    expect(finishReasonToAnthropic("stop_sequence")).toBe("stop_sequence")
    expect(finishReasonToAnthropic("stop")).toBe("end_turn")
    expect(finishReasonToAnthropic(undefined)).toBe("end_turn")
    expect(finishReasonToAnthropic("anything-else")).toBe("end_turn")
  })
})

describe("chatEventToAnthropic", () => {
  const usage = { input_tokens: 0, output_tokens: 0 }

  test("text / reasoning / tool events produce the right pieces", () => {
    expect(chatEventToAnthropic({ kind: "text", text: "hi" }, usage)).toEqual([
      { piece: "content_block", block: { type: "text", text: "hi" } },
    ])
    expect(chatEventToAnthropic({ kind: "reasoning", text: "hmm" }, usage)).toEqual([
      { piece: "content_block", block: { type: "thinking", thinking: "hmm", signature: "" } },
    ])
    expect(chatEventToAnthropic({ kind: "tool_call_start", id: "t", name: "ls" }, usage)).toEqual([
      { piece: "content_block", block: { type: "tool_use", id: "t", name: "ls", input: {} } },
    ])
    expect(chatEventToAnthropic({ kind: "tool_call_args", id: "t", argsDelta: "{}" }, usage)).toEqual([
      { piece: "partial_json", id: "t", jsonDelta: "{}" },
    ])
    expect(chatEventToAnthropic({ kind: "finish", reason: "length" }, usage)).toEqual([
      { piece: "stop_reason", stopReason: "max_tokens" },
    ])
  })

  test("usage event forwards every token dimension", () => {
    const pieces = chatEventToAnthropic(
      {
        kind: "usage",
        promptTokens: 10,
        completionTokens: 5,
        cachedInputTokens: 3,
        cacheCreationInputTokens: 2,
      },
      usage,
    )
    expect(pieces).toEqual([
      {
        piece: "usage",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
        },
      },
    ])
  })
})

describe("chatToAnthropicResponse", () => {
  test("merges text deltas, parses tool args, propagates usage", async () => {
    stubEvents([
      { kind: "text", text: "Hello " },
      { kind: "text", text: "world" },
      { kind: "tool_call_start", id: "tu_9", name: "f" },
      { kind: "tool_call_args", argsDelta: "{\"x\":" },
      { kind: "tool_call_args", argsDelta: "1}" },
      { kind: "finish", reason: "tool_calls" },
      { kind: "usage", promptTokens: 12, completionTokens: 7 },
    ])
    const res = await chatToAnthropicResponse(chatRequest)
    expect(res.type).toBe("message")
    expect(res.role).toBe("assistant")
    expect(res.model).toBe("claude-test")
    expect(res.id.startsWith("msg_")).toBe(true)
    expect(res.stop_reason).toBe("tool_use")
    expect(res.stop_sequence).toBeNull()
    expect(res.content).toEqual([
      { type: "text", text: "Hello world" },
      { type: "tool_use", id: "tu_9", name: "f", input: { x: 1 } },
    ])
    expect(res.usage).toMatchObject({ input_tokens: 12, output_tokens: 7 })
  })
})

describe("streamChatEventsAsAnthropic", () => {
  test("emits SSE events in Anthropic order with usage in message_delta", async () => {
    stubEvents([
      { kind: "text", text: "a" },
      { kind: "text", text: "b" },
      { kind: "tool_call_start", id: "tu_1", name: "run" },
      { kind: "tool_call_args", argsDelta: "{}" },
      { kind: "finish", reason: "stop" },
      { kind: "usage", promptTokens: 20, completionTokens: 4 },
    ])
    const events = await collect(streamChatEventsAsAnthropic(chatRequest))
    const names = events.map((e) => e.event)
    expect(names).toEqual([
      "message_start",
      "content_block_start", // text block
      "content_block_delta", // "a"
      "content_block_delta", // "b"
      "content_block_stop",
      "content_block_start", // tool_use block
      "content_block_delta", // input_json_delta
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])

    expect(events[0]!.data.type).toBe("message_start")
    expect((events[0]!.data.message as Record<string, unknown>).model).toBe("claude-test")
    expect(events[1]!.data.content_block).toEqual({ type: "text", text: "" })
    expect((events[2]!.data.delta as Record<string, unknown>).text).toBe("a")
    expect(events[5]!.data.content_block).toMatchObject({ type: "tool_use", id: "tu_1", name: "run" })
    expect(events[6]!.data.delta).toEqual({ type: "input_json_delta", partial_json: "{}" })
    const delta = events[8]!.data
    expect(delta.type).toBe("message_delta")
    expect((delta.delta as Record<string, unknown>).stop_reason).toBe("end_turn")
    expect((delta.usage as Record<string, unknown>).output_tokens).toBe(4)
    expect(events[9]!.data).toEqual({ type: "message_stop" })
  })

  test("reasoning streams as a thinking block", async () => {
    stubEvents([
      { kind: "reasoning", text: "thinking..." },
      { kind: "text", text: "answer" },
      { kind: "finish", reason: "stop" },
    ])
    const events = await collect(streamChatEventsAsAnthropic(chatRequest))
    const names = events.map((e) => e.event)
    expect(names).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(events[1]!.data.content_block).toEqual({ type: "thinking", thinking: "", signature: "" })
    expect(events[2]!.data.delta).toEqual({ type: "thinking_delta", thinking: "thinking..." })
    expect(events[4]!.data.content_block).toEqual({ type: "text", text: "" })
  })

  test("sseSerialize writes event/data wire format", () => {
    const text = sseSerialize({ event: "message_stop", data: { type: "message_stop" } })
    expect(text).toBe('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  })
})

describe("countTokens", () => {
  test("returns an input_tokens estimate", () => {
    const result = countTokens({ messages: [{ role: "user", content: "hello world" }] })
    expect(result.input_tokens).toBeGreaterThan(0)
    expect(Number.isInteger(result.input_tokens)).toBe(true)
    // estimate is ceil(JSON length / 4)
    const serialized = JSON.stringify({
      messages: [{ role: "user", content: "hello world" }],
      system: null,
      tools: [],
    })
    expect(result.input_tokens).toBe(Math.ceil(serialized.length / 4))
  })
})
