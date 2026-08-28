import {
  __resetOpenAICompatibleStreamingCapabilityCacheForTests,
  OpenAICompatibleProvider,
} from "@/src/translation/providers/openai-compatible";
import { scheduleTranslation } from "@/src/translation/scheduler";
import { NTransError } from "@/src/shared/errors";
import { runtimeErrorToken } from "@/src/shared/runtime-errors";
import { createProtectedText } from "@/src/translation/protected-text";
import type { TranslationResult } from "@/src/translation/types";
import { afterEach, describe, expect, it, vi } from "vitest";

const request = {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  mode: "ai" as const,
  segments: [{ id: "segment-1", text: "Hello" }],
};

const multiRequest = {
  ...request,
  segments: [
    { id: "segment-1", text: "Hello" },
    { id: "segment-2", text: "World" },
    { id: "segment-3", text: "Again" },
  ],
};

function provider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider("ai", {
    baseUrl: "https://provider.example/v1",
    apiKey: "test-only-key",
    model: "test-model",
    systemPrompt: "Translate",
    timeoutMs: 5_000,
  });
}

function gptProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider("ai", {
    baseUrl: "https://provider.example/v1",
    apiKey: "test-only-key",
    model: "gpt-5.5",
    systemPrompt: "Translate",
    timeoutMs: 5_000,
  });
}

function anthropicProvider(): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider("ai", {
    protocol: "anthropic-messages",
    baseUrl: "https://claude.example",
    apiKey: "test-only-claude-key",
    model: "claude-test-model",
    systemPrompt: "Translate",
    timeoutMs: 5_000,
  });
}

function completion(content: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function anthropicCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: content }],
      stop_reason: "end_turn",
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function sseEvent(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

function anthropicSseEvent(content: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } })}\n\n`;
}

function chunkedSseResponse(initial: string): {
  response: Response;
  append(value: string): void;
  close(): void;
} {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        for (let index = 0; index < initial.length; index += 7) {
          controller.enqueue(encoder.encode(initial.slice(index, index + 7)));
        }
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
  return {
    response,
    append(value) {
      streamController?.enqueue(encoder.encode(value));
    },
    close() {
      streamController?.close();
    },
  };
}

function wireSegmentsFromRequest(
  init?: RequestInit,
): Array<[string, string, ...unknown[]]> {
  if (typeof init?.body !== "string") {
    throw new Error("missing OpenAI-compatible request body");
  }
  const payload = JSON.parse(init.body) as {
    messages?: Array<{ role?: string; content?: string }>;
  };
  const userMessage = payload.messages?.find(
    (message) => message.role === "user",
  );
  const input = JSON.parse(userMessage?.content ?? "{}") as {
    segments?: Array<[unknown, unknown, ...unknown[]]>;
  };
  const segments = input.segments ?? [];
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        typeof segment[0] !== "string" || typeof segment[1] !== "string",
    )
  ) {
    throw new Error("missing compact wire IDs in request body");
  }
  return segments as Array<[string, string, ...unknown[]]>;
}

function wireIdsFromRequest(init?: RequestInit): string[] {
  return wireSegmentsFromRequest(init).map((segment) => segment[0]);
}

function remapReadableFixtureIds(value: string, wireIds: readonly string[]) {
  const mapped = value.replace(/segment-(\d+)/gu, (stableId, ordinal) => {
    const index = Number(ordinal) - 1;
    return (
      wireIds[index] ??
      (wireIds.length === 1 ? (wireIds[0] ?? stableId) : stableId)
    );
  });
  return wireIds.length === 1
    ? mapped.replaceAll("protected", wireIds[0] ?? "protected")
    : mapped;
}

function responseWithRequestWireIds(
  response: Response,
  init?: RequestInit,
): Response {
  if (!response.body) return response;
  const wireIds = wireIdsFromRequest(init);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline + 1);
          pending = pending.slice(newline + 1);
          controller.enqueue(
            encoder.encode(remapReadableFixtureIds(line, wireIds)),
          );
          newline = pending.indexOf("\n");
        }
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) {
          controller.enqueue(
            encoder.encode(remapReadableFixtureIds(pending, wireIds)),
          );
        }
      },
    }),
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function stubWireFetch(fetchMock: typeof globalThis.fetch): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      responseWithRequestWireIds(await fetchMock(input, init), init),
    ),
  );
}

describe("OpenAI-compatible translation responses", () => {
  afterEach(() => {
    __resetOpenAICompatibleStreamingCapabilityCacheForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("accepts a fenced top-level array and common translation field", async () => {
    stubWireFetch(
      vi.fn(() =>
        Promise.resolve(
          completion('```json\n[{"id":"segment-1","translation":"你好"}]\n```'),
        ),
      ),
    );

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
  });

  it("accepts the compact result-pair protocol", async () => {
    stubWireFetch(
      vi.fn(() =>
        Promise.resolve(
          completion('{"results":[["segment-1","你好"],["segment-2","世界"]]}'),
        ),
      ),
    );

    await expect(
      provider().translateBatch(
        { ...request, segments: multiRequest.segments.slice(0, 2) },
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      { id: "segment-1", translatedText: "你好" },
      { id: "segment-2", translatedText: "世界" },
    ]);
  });

  it("streams compact result pairs progressively", async () => {
    const stream = chunkedSseResponse(
      `${sseEvent('{"results":[["segment-1","第一条"],')}\n`,
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stream.response);
    stubWireFetch(fetch);
    const progress: TranslationResult[] = [];
    const translated = provider().translateBatch(
      { ...request, segments: multiRequest.segments.slice(0, 2) },
      new AbortController().signal,
      (result) => {
        progress.push(result);
      },
    );

    await vi.waitFor(() =>
      expect(progress).toEqual([{ id: "segment-1", translatedText: "第一条" }]),
    );
    stream.append(`${sseEvent('["segment-2","第二条"]]}')}data: [DONE]\n\n`);
    stream.close();

    await expect(translated).resolves.toEqual([
      { id: "segment-1", translatedText: "第一条" },
      { id: "segment-2", translatedText: "第二条" },
    ]);
  });

  it("uses the standard Anthropic Messages request and response contract", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        anthropicCompletion(
          '{"results":[{"id":"segment-1","translatedText":"Claude 译文"}]}',
        ),
      ),
    );
    stubWireFetch(fetch);

    await expect(
      anthropicProvider().translateBatch(
        { ...request, responseMode: "batch" },
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "Claude 译文" }]);

    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe("https://claude.example/v1/messages");
    const headers = new Headers(call?.[1]?.headers);
    expect(headers.get("x-api-key")).toBe("test-only-claude-key");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe(
      "true",
    );
    expect(headers.get("authorization")).toBeNull();
    const body = call?.[1]?.body;
    const payload: unknown =
      typeof body === "string" ? (JSON.parse(body) as unknown) : {};
    expect(payload).toMatchObject({
      model: "claude-test-model",
      max_tokens: 8_192,
      messages: [{ role: "user" }],
    });
    expect(payload).toHaveProperty(
      "system",
      expect.stringContaining("Return compact JSON only"),
    );
    expect(payload).not.toHaveProperty("temperature");
    expect(payload).not.toHaveProperty("response_format");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).toHaveProperty("output_config.format.type", "json_schema");
  });

  it("streams Anthropic text deltas through the shared progressive result parser", async () => {
    const stream = chunkedSseResponse(
      anthropicSseEvent(
        '{"results":[{"id":"segment-1","translatedText":"第一条"},',
      ),
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stream.response);
    stubWireFetch(fetch);
    const progress: TranslationResult[] = [];
    const translated = anthropicProvider().translateBatch(
      { ...request, segments: multiRequest.segments.slice(0, 2) },
      new AbortController().signal,
      (result) => {
        progress.push(result);
      },
    );

    await vi.waitFor(() =>
      expect(progress).toEqual([{ id: "segment-1", translatedText: "第一条" }]),
    );
    stream.append(
      `${anthropicSseEvent('{"id":"segment-2","translatedText":"第二条"}]}')}event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
    );
    stream.close();

    await expect(translated).resolves.toEqual([
      { id: "segment-1", translatedText: "第一条" },
      { id: "segment-2", translatedText: "第二条" },
    ]);
  });

  it("downgrades unsupported Anthropic structured output once per endpoint and model", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "output_config is unsupported",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(
          anthropicCompletion(
            '{"results":[{"id":"segment-1","translatedText":"Claude 译文"}]}',
          ),
        ),
      );
    stubWireFetch(fetch);

    await anthropicProvider().translateBatch(
      { ...request, responseMode: "batch" },
      new AbortController().signal,
    );
    await anthropicProvider().translateBatch(
      { ...request, responseMode: "batch" },
      new AbortController().signal,
    );

    const payloads: unknown[] = fetch.mock.calls.map(([, init]): unknown =>
      typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : {},
    );
    expect(payloads[0]).toHaveProperty("output_config");
    expect(payloads[1]).not.toHaveProperty("output_config");
    expect(payloads[2]).not.toHaveProperty("output_config");
  });

  it("rejects an Anthropic stream that omits its terminal message_stop", async () => {
    const stream = `${anthropicSseEvent('{"results":[{"id":"segment-1","translatedText":"不完整"}]}')}event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n`;
    stubWireFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        ),
      ),
    );

    const outcome = anthropicProvider().translateBatch(
      request,
      new AbortController().signal,
    );
    await expect(outcome).rejects.toMatchObject({ code: "invalid_response" });
    await outcome.catch((error: unknown) => {
      expect(
        typeof error === "object" && error !== null && "details" in error
          ? String(error.details)
          : "",
      ).toContain("message_stop");
    });
  });

  it("keeps AI batch mode non-streaming while preserving strict JSON", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      ),
    );
    stubWireFetch(fetch);
    const progress = vi.fn();

    await expect(
      provider().translateBatch(
        { ...request, responseMode: "batch" },
        new AbortController().signal,
        progress,
      ),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);

    const body = fetch.mock.calls[0]?.[1]?.body;
    const payload: unknown = typeof body === "string" ? JSON.parse(body) : {};
    expect(payload).not.toHaveProperty("stream");
    expect(payload).toHaveProperty("response_format.type", "json_schema");
    expect(payload).toHaveProperty(
      "response_format.json_schema.schema.properties.results.items.type",
      "array",
    );
    expect(payload).toHaveProperty(
      "response_format.json_schema.schema.properties.results.items.maxItems",
      2,
    );
    expect(payload).toHaveProperty(
      "messages.0.content",
      expect.stringContaining('{"results":[["<input id>","<translation>"]]}'),
    );
    expect(progress).not.toHaveBeenCalled();
  });

  it("single-flights the first streaming probe across normalized provider instances", async () => {
    const firstResult = { id: "segment-1", translatedText: "首次结果" };
    const secondResult = { id: "segment-1", translatedText: "等待者结果" };
    const firstStream = chunkedSseResponse(
      `${sseEvent(JSON.stringify({ results: [firstResult] }))}data: [DONE]\n\n`,
    );
    firstStream.close();
    const secondStream = chunkedSseResponse(
      `${sseEvent(JSON.stringify({ results: [secondResult] }))}data: [DONE]\n\n`,
    );
    secondStream.close();
    let resolveProbe: ((response: Response) => void) | undefined;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveProbe = resolve;
          }),
      )
      .mockResolvedValueOnce(secondStream.response);
    stubWireFetch(fetch);
    const firstProvider = provider();
    const waitingProvider = new OpenAICompatibleProvider("ai", {
      baseUrl: "https://provider.example/v1/",
      apiKey: "another-test-key",
      model: "test-model",
      systemPrompt: "Translate",
      timeoutMs: 5_000,
    });

    const first = firstProvider.translateBatch(
      request,
      new AbortController().signal,
    );
    const waiting = waitingProvider.translateBatch(
      request,
      new AbortController().signal,
    );

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    resolveProbe?.(firstStream.response);
    await expect(first).resolves.toEqual([firstResult]);
    await expect(waiting).resolves.toEqual([secondResult]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      const body = call[1]?.body;
      expect(typeof body === "string" ? JSON.parse(body) : {}).toHaveProperty(
        "stream",
        true,
      );
    }
  });

  it("releases concurrent streaming batches after the probe response headers arrive", async () => {
    const firstResult = { id: "segment-1", translatedText: "首批结果" };
    const secondResult = { id: "segment-1", translatedText: "并发结果" };
    const firstStream = chunkedSseResponse("");
    const secondStream = chunkedSseResponse(
      `${sseEvent(JSON.stringify({ results: [secondResult] }))}data: [DONE]\n\n`,
    );
    secondStream.close();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(firstStream.response)
      .mockResolvedValueOnce(secondStream.response);
    stubWireFetch(fetch);

    const first = provider().translateBatch(
      request,
      new AbortController().signal,
    );
    const second = provider().translateBatch(
      request,
      new AbortController().signal,
    );

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    firstStream.append(
      `${sseEvent(JSON.stringify({ results: [firstResult] }))}data: [DONE]\n\n`,
    );
    firstStream.close();
    await expect(first).resolves.toEqual([firstResult]);
    await expect(second).resolves.toEqual([secondResult]);
  });

  it("does not let a buffered streaming probe serialize concurrent batches", async () => {
    const firstResult = { id: "segment-1", translatedText: "流式结果" };
    const secondResult = { id: "segment-1", translatedText: "并发完整结果" };
    const firstStream = chunkedSseResponse(
      `${sseEvent(JSON.stringify({ results: [firstResult] }))}data: [DONE]\n\n`,
    );
    firstStream.close();
    let resolveProbe: ((response: Response) => void) | undefined;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveProbe = resolve;
          }),
      )
      .mockResolvedValueOnce(
        completion(
          JSON.stringify({
            results: [secondResult],
          }),
        ),
      );
    stubWireFetch(fetch);

    const first = provider().translateBatch(
      request,
      new AbortController().signal,
    );
    const second = provider().translateBatch(
      request,
      new AbortController().signal,
    );

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), {
      timeout: 1_000,
    });
    const secondBody = fetch.mock.calls[1]?.[1]?.body;
    expect(
      typeof secondBody === "string" ? JSON.parse(secondBody) : {},
    ).not.toHaveProperty("stream");
    await expect(second).resolves.toEqual([secondResult]);

    resolveProbe?.(firstStream.response);
    await expect(first).resolves.toEqual([firstResult]);
  });

  it("does not send a request after a waiter cancels during the first streaming probe", async () => {
    const result = { id: "segment-1", translatedText: "探测结果" };
    const stream = chunkedSseResponse(
      `${sseEvent(JSON.stringify({ results: [result] }))}data: [DONE]\n\n`,
    );
    stream.close();
    let resolveProbe: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    stubWireFetch(fetch);
    const owner = provider().translateBatch(
      request,
      new AbortController().signal,
    );
    const waiterController = new AbortController();
    const waiter = provider().translateBatch(request, waiterController.signal);

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    waiterController.abort();
    await expect(waiter).rejects.toMatchObject({ code: "cancelled" });
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveProbe?.(stream.response);
    await expect(owner).resolves.toEqual([result]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("emits each complete SSE result before the final response across transport and escape boundaries", async () => {
    const first = {
      id: "segment-1",
      translatedText: '路径 C:\\tmp 与 "引号"',
    };
    const second = { id: "segment-2", translatedText: "第二条" };
    const stream = chunkedSseResponse(
      sseEvent(`{"results":[${JSON.stringify(first)},`),
    );
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(stream.response);
    stubWireFetch(fetch);
    const progress: Array<{ id: string; translatedText: string }> = [];
    const translation = provider().translateBatch(
      { ...request, segments: multiRequest.segments.slice(0, 2) },
      new AbortController().signal,
      (result) => {
        progress.push(result);
      },
    );

    await vi.waitFor(() => expect(progress).toEqual([first]));
    stream.append(`${sseEvent(`${JSON.stringify(second)}]}`)}data: [DONE]\n\n`);
    stream.close();

    await expect(translation).resolves.toEqual([first, second]);
    expect(progress).toEqual([first, second]);
    const body = fetch.mock.calls[0]?.[1]?.body;
    expect(typeof body === "string" ? JSON.parse(body) : {}).toMatchObject({
      stream: true,
    });
  });

  it("reports valid out-of-order SSE objects as soon as each one arrives", async () => {
    const first = { id: "segment-1", translatedText: "第一条" };
    const second = { id: "segment-2", translatedText: "第二条" };
    const stream = chunkedSseResponse(
      `${sseEvent(`{"results":[${JSON.stringify(second)},`)}${sseEvent(`${JSON.stringify(first)}]}`)}data: [DONE]\n\n`,
    );
    stream.close();
    stubWireFetch(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(stream.response),
    );
    const progress: TranslationResult[] = [];

    await expect(
      provider().translateBatch(
        { ...request, segments: multiRequest.segments.slice(0, 2) },
        new AbortController().signal,
        (result) => {
          progress.push(result);
        },
      ),
    ).resolves.toEqual([first, second]);
    expect(progress).toEqual([second, first]);
  });

  it("accepts Responses-style output-text delta events from compatible gateways", async () => {
    const result = { id: "segment-1", translatedText: "你好" };
    const content = JSON.stringify({ results: [result] });
    const stream = chunkedSseResponse(
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: content })}\n\ndata: [DONE]\n\n`,
    );
    stream.close();
    stubWireFetch(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(stream.response),
    );
    const progress: TranslationResult[] = [];

    await expect(
      provider().translateBatch(
        request,
        new AbortController().signal,
        (translated) => {
          progress.push(translated);
        },
      ),
    ).resolves.toEqual([result]);
    expect(progress).toEqual([result]);
  });

  it("keeps a complete streamed result without retrying when malformed trailing output repeats its ID", async () => {
    const result = { id: "segment-1", translatedText: "你好" };
    const stream = chunkedSseResponse(
      `${sseEvent(`{"results":[${JSON.stringify(result)},${JSON.stringify(result)}]}`)}data: [DONE]\n\n`,
    );
    stream.close();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(stream.response);
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([result]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("recovers only missing IDs after a multi-segment stream is truncated", async () => {
    const first = { id: "segment-1", translatedText: "第一条" };
    const second = { id: "segment-2", translatedText: "第二条" };
    const stream = chunkedSseResponse(
      `${sseEvent(`{"results":[${JSON.stringify(first)},`)}${sseEvent("BROKEN]}")}data: [DONE]\n\n`,
    );
    stream.close();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(completion(JSON.stringify({ results: [second] })));
    stubWireFetch(fetch);
    const progress: TranslationResult[] = [];

    await expect(
      provider().translateBatch(
        { ...request, segments: multiRequest.segments.slice(0, 2) },
        new AbortController().signal,
        (result) => {
          progress.push(result);
        },
      ),
    ).resolves.toEqual([first, second]);
    // The provider reports genuinely streamed items immediately. The scheduler
    // reports the recovered non-streaming item from the final returned array.
    expect(progress).toEqual([first]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const retryRequestBody = fetch.mock.calls[1]?.[1]?.body;
    if (typeof retryRequestBody !== "string") {
      throw new Error("missing partial-stream recovery request body");
    }
    const retryPayload = JSON.parse(retryRequestBody) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const retryInput = JSON.parse(
      retryPayload.messages?.find((message) => message.role === "user")
        ?.content ?? "{}",
    ) as { segments?: Array<[string, ...unknown[]]> };
    expect(retryInput.segments?.map((segment) => segment[0])).toEqual(["0"]);
  });

  it("recovers only missing IDs when a stream closes with valid but incomplete JSON", async () => {
    const first = { id: "segment-1", translatedText: "第一条" };
    const second = { id: "segment-2", translatedText: "第二条" };
    const stream = chunkedSseResponse(
      `${sseEvent(JSON.stringify({ results: [first] }))}data: [DONE]\n\n`,
    );
    stream.close();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(completion(JSON.stringify({ results: [second] })));
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(
        { ...request, segments: multiRequest.segments.slice(0, 2) },
        new AbortController().signal,
      ),
    ).resolves.toEqual([first, second]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("publishes valid non-streaming IDs before missing-ID recovery fails", async () => {
    const first = { id: "segment-1", translatedText: "第一条" };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(completion(JSON.stringify({ results: [first] })))
      .mockResolvedValueOnce(completion('{"results":[]}'));
    stubWireFetch(fetch);
    const progress: TranslationResult[] = [];

    await expect(
      provider().translateBatch(
        { ...request, segments: multiRequest.segments.slice(0, 2) },
        new AbortController().signal,
        (result) => {
          progress.push(result);
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });

    expect(progress).toEqual([first]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const retryRequestBody = fetch.mock.calls[1]?.[1]?.body;
    if (typeof retryRequestBody !== "string") {
      throw new Error("missing partial JSON recovery request body");
    }
    const retryPayload = JSON.parse(retryRequestBody) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    const retryInput = JSON.parse(
      retryPayload.messages?.find((message) => message.role === "user")
        ?.content ?? "{}",
    ) as { segments?: Array<[string, ...unknown[]]> };
    expect(retryInput.segments?.map((segment) => segment[0])).toEqual(["0"]);
  });

  it("publishes a recovered missing stream result exactly once through the scheduler", async () => {
    const first = { id: "segment-1", translatedText: "第一条" };
    const second = { id: "segment-2", translatedText: "第二条" };
    const stream = chunkedSseResponse(
      `${sseEvent(`{"results":[${JSON.stringify(first)},`)}${sseEvent("BROKEN]}")}data: [DONE]\n\n`,
    );
    stream.close();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(completion(JSON.stringify({ results: [second] })));
    stubWireFetch(fetch);
    const progress: TranslationResult[] = [];

    await expect(
      scheduleTranslation(
        provider(),
        { ...request, segments: multiRequest.segments.slice(0, 2) },
        new AbortController().signal,
        (result) => {
          progress.push(result);
        },
      ),
    ).resolves.toEqual([first, second]);
    expect(progress).toEqual([first, second]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back once to non-streaming when an SSE completion is empty", async () => {
    const stream = chunkedSseResponse("data: [DONE]\n\n");
    stream.close();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      )
      .mockResolvedValueOnce(
        completion(
          '{"results":[{"id":"segment-1","translatedText":"再次你好"}]}',
        ),
      );
    stubWireFetch(fetch);
    const subject = provider();

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
    await expect(
      subject.translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "再次你好" }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const firstBody = fetch.mock.calls[0]?.[1]?.body;
    const fallbackBody = fetch.mock.calls[1]?.[1]?.body;
    const nextBody = fetch.mock.calls[2]?.[1]?.body;
    expect(
      typeof firstBody === "string" ? JSON.parse(firstBody) : {},
    ).toHaveProperty("stream", true);
    expect(
      typeof fallbackBody === "string" ? JSON.parse(fallbackBody) : {},
    ).not.toHaveProperty("stream");
    expect(
      typeof nextBody === "string" ? JSON.parse(nextBody) : {},
    ).not.toHaveProperty("stream");
  });

  it("falls back once when a malformed SSE completion emitted no result ID", async () => {
    const stream = chunkedSseResponse(
      `${sseEvent('{"results":[["segment-1",BROKEN]]}')}data: [DONE]\n\n`,
    );
    stream.close();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(completion('{"results":[["segment-1","你好"]]}'));
    stubWireFetch(fetch);
    const progress = vi.fn();

    await expect(
      provider().translateBatch(
        request,
        new AbortController().signal,
        progress,
      ),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(progress).not.toHaveBeenCalled();
    const firstBody = fetch.mock.calls[0]?.[1]?.body;
    const fallbackBody = fetch.mock.calls[1]?.[1]?.body;
    expect(
      typeof firstBody === "string" ? JSON.parse(firstBody) : {},
    ).toHaveProperty("stream", true);
    expect(
      typeof fallbackBody === "string" ? JSON.parse(fallbackBody) : {},
    ).not.toHaveProperty("stream");
  });

  it("caches an explicit stream rejection across provider instances", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"detail":"stream is unsupported"}', { status: 400 }),
      )
      .mockResolvedValueOnce(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      )
      .mockResolvedValueOnce(
        completion(
          '{"results":[{"id":"segment-1","translatedText":"再次你好"}]}',
        ),
      );
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "再次你好" }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const fallbackBody = fetch.mock.calls[1]?.[1]?.body;
    const cachedBody = fetch.mock.calls[2]?.[1]?.body;
    expect(
      typeof fallbackBody === "string" ? JSON.parse(fallbackBody) : {},
    ).not.toHaveProperty("stream");
    expect(
      typeof cachedBody === "string" ? JSON.parse(cachedBody) : {},
    ).not.toHaveProperty("stream");
  });

  it("caches a provider that silently returns JSON for a streaming request", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      )
      .mockResolvedValueOnce(
        completion(
          '{"results":[{"id":"segment-1","translatedText":"再次你好"}]}',
        ),
      );
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "再次你好" }]);

    const firstBody = fetch.mock.calls[0]?.[1]?.body;
    const secondBody = fetch.mock.calls[1]?.[1]?.body;
    expect(
      typeof firstBody === "string" ? JSON.parse(firstBody) : {},
    ).toHaveProperty("stream", true);
    expect(
      typeof secondBody === "string" ? JSON.parse(secondBody) : {},
    ).not.toHaveProperty("stream");
  });

  it("does not cache transient streaming failures", async () => {
    const result = { id: "segment-1", translatedText: "恢复结果" };
    const stream = chunkedSseResponse(
      `${sseEvent(JSON.stringify({ results: [result] }))}data: [DONE]\n\n`,
    );
    stream.close();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(stream.response);
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "request_failed", retryable: true });
    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([result]);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      const body = call[1]?.body;
      expect(typeof body === "string" ? JSON.parse(body) : {}).toHaveProperty(
        "stream",
        true,
      );
    }
  });

  it("accepts array-based content parts and a translations envelope", async () => {
    stubWireFetch(
      vi.fn(() =>
        Promise.resolve(
          completion([
            {
              type: "text",
              text: '{"translations":[{"id":"segment-1","translated_text":"你好"}]}',
            },
          ]),
        ),
      ),
    );

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
  });

  it("still rejects a successful HTTP response without usable results", async () => {
    stubWireFetch(
      vi.fn(() => Promise.resolve(completion('{"message":"done"}'))),
    );

    const error: unknown = await provider()
      .translateBatch(request, new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NTransError);
    if (!(error instanceof NTransError)) return;
    expect(error.code).toBe("invalid_response");
    expect(error.message).toBe(runtimeErrorToken("invalid_response"));
    expect(error.details).toContain("Top-level keys: message");
  });

  it("reports safe JSON and ID diagnostics without exposing response text", async () => {
    const secretResponse = "Bearer super-secret-token not-json";
    stubWireFetch(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        new Response(secretResponse, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const malformed: unknown = await provider()
      .translateBatch(
        { ...request, responseMode: "batch" },
        new AbortController().signal,
      )
      .catch((reason: unknown) => reason);
    expect(malformed).toBeInstanceOf(NTransError);
    if (!(malformed instanceof NTransError)) return;
    expect(malformed.code).toBe("invalid_response");
    expect(malformed.details).toContain("not valid JSON");
    expect(malformed.details).not.toContain("super-secret-token");

    stubWireFetch(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          completion(
            '{"results":[{"id":"unexpected-id","translatedText":"你好"}]}',
          ),
        ),
    );
    const unknownId: unknown = await provider()
      .translateBatch(
        { ...request, responseMode: "batch" },
        new AbortController().signal,
      )
      .catch((reason: unknown) => reason);
    expect(unknownId).toBeInstanceOf(NTransError);
    if (!(unknownId instanceof NTransError)) return;
    expect(unknownId.code).toBe("invalid_response");
    expect(unknownId.details).toMatch(
      /Unknown compact result ID.*unexpected-id/u,
    );
  });

  it("accepts keyed result maps", async () => {
    stubWireFetch(
      vi.fn(() =>
        Promise.resolve(completion('{"results":{"segment-1":"你好"}}')),
      ),
    );

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
  });

  it("accepts a parsed result object with alternate segment fields", async () => {
    stubWireFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    parsed: {
                      result: {
                        segmentId: "segment-1",
                        targetText: "你好",
                      },
                    },
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
  });

  it("retries only IDs missing from an otherwise valid JSON response", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        completion(
          JSON.stringify({
            results: [
              { id: "segment-1", translatedText: "你好" },
              { id: "segment-2", translatedText: "世界" },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        completion(
          JSON.stringify({
            results: [{ id: "segment-3", translatedText: "再次" }],
          }),
        ),
      );
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(multiRequest, new AbortController().signal),
    ).resolves.toEqual([
      { id: "segment-1", translatedText: "你好" },
      { id: "segment-2", translatedText: "世界" },
      { id: "segment-3", translatedText: "再次" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const retryRequestBody = fetch.mock.calls[1]?.[1]?.body;
    if (typeof retryRequestBody !== "string") {
      throw new Error("missing JSON retry request body");
    }
    const retryBody = JSON.parse(retryRequestBody) as {
      messages: Array<{ role: string; content: string }>;
    };
    const retryPayload = JSON.parse(retryBody.messages[1]?.content ?? "{}") as {
      segments?: Array<[string, ...unknown[]]>;
    };
    expect(retryPayload.segments?.map((segment) => segment[0])).toEqual(["0"]);
  });

  it("discards unknown and duplicate IDs while recovering every valid ID", async () => {
    const first = { id: "segment-1", translatedText: "你好" };
    const second = { id: "segment-2", translatedText: "世界" };
    const third = { id: "segment-3", translatedText: "再次" };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        completion(
          JSON.stringify({
            results: [
              first,
              { id: "unexpected-id", translatedText: "未知" },
              { id: "segment-1", translatedText: "重复" },
            ],
          }),
        ),
      )
      .mockImplementation((_input, init) => {
        const segments = wireSegmentsFromRequest(init);
        return Promise.resolve(
          completion(
            JSON.stringify({
              results: segments.map(([id, text]) => ({
                id,
                translatedText:
                  text === "Hello"
                    ? "你好"
                    : text === "World"
                      ? "世界"
                      : "再次",
              })),
            }),
          ),
        );
      });
    stubWireFetch(fetch);
    const progress: TranslationResult[] = [];

    await expect(
      provider().translateBatch(
        multiRequest,
        new AbortController().signal,
        (result) => {
          progress.push(result);
        },
      ),
    ).resolves.toEqual([first, second, third]);
    expect(progress).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);

    const retryRequestBody = fetch.mock.calls[1]?.[1]?.body;
    if (typeof retryRequestBody !== "string") {
      throw new Error("missing anomalous-ID recovery request body");
    }
    const retryBody = JSON.parse(retryRequestBody) as {
      messages: Array<{ role: string; content: string }>;
    };
    const retryPayload = JSON.parse(retryBody.messages[1]?.content ?? "{}") as {
      segments?: Array<[string, ...unknown[]]>;
    };
    expect(retryPayload.segments?.map((segment) => segment[0])).toEqual([
      "0",
      "1",
    ]);
  });

  it("rejects extra result IDs even when every requested ID is present", async () => {
    const expected = { id: "segment-1", translatedText: "你好" };
    stubWireFetch(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        completion(
          JSON.stringify({
            results: [
              expected,
              { id: "unexpected-id", translatedText: "未知" },
            ],
          }),
        ),
      ),
    );
    const progress: TranslationResult[] = [];

    const extraIdError: unknown = await provider()
      .translateBatch(request, new AbortController().signal, (result) => {
        progress.push(result);
      })
      .catch((error: unknown) => error);
    expect(extraIdError).toBeInstanceOf(NTransError);
    if (!(extraIdError instanceof NTransError)) return;
    expect(extraIdError.code).toBe("invalid_response");
    expect(extraIdError.details).toContain("Unknown compact result ID");
    expect(progress).toEqual([]);
  });

  it("retains safe unknown and duplicate ID diagnostics when recovery fails", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        completion(
          JSON.stringify({
            results: [
              { id: "segment-1", translatedText: "你好" },
              { id: "unexpected-id", translatedText: "未知" },
              { id: "segment-1", translatedText: "重复" },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(completion('{"results":[]}'));
    stubWireFetch(fetch);

    const error: unknown = await provider()
      .translateBatch(multiRequest, new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(NTransError);
    if (!(error instanceof NTransError)) return;
    expect(error.code).toBe("invalid_response");
    expect(error.details).toContain("Provider returned no usable IDs");
    expect(error.details).toContain("Expected IDs: segment-1, segment-2");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a request that returned zero usable IDs", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(completion('{"results":[]}'));
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not recursively split a multi-segment empty completion", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(completion("   "));
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(multiRequest, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("splits a malformed multi-segment response into smaller JSON requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(completion("not json"))
      .mockResolvedValueOnce(
        completion(
          JSON.stringify({
            results: [
              { id: "segment-1", translatedText: "你好" },
              { id: "segment-2", translatedText: "世界" },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        completion(
          JSON.stringify({
            results: [{ id: "segment-3", translatedText: "再次" }],
          }),
        ),
      );
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(multiRequest, new AbortController().signal),
    ).resolves.toHaveLength(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("caps adaptive recovery so a malformed provider cannot create request storms", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "{}";
      const payload = JSON.parse(body) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const user = payload.messages?.find((message) => message.role === "user");
      const input = JSON.parse(user?.content ?? "{}") as {
        segments?: Array<[string, ...unknown[]]>;
      };
      const inputSegments = input.segments ?? [];
      return Promise.resolve(
        inputSegments.length === 1 && inputSegments[0]
          ? completion(
              JSON.stringify({
                results: [
                  {
                    id: inputSegments[0][0],
                    translatedText: "Translated",
                  },
                ],
              }),
            )
          : completion("not json"),
      );
    });
    stubWireFetch(fetch);
    const segments = Array.from({ length: 16 }, (_, index) => ({
      id: `segment-${index + 1}`,
      text: `Text ${index + 1}`,
    }));

    await expect(
      provider().translateBatch(
        { ...request, segments },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("adds a compact JSON-only protocol instruction to custom prompts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      ),
    );
    stubWireFetch(fetch);

    await provider().translateBatch(request, new AbortController().signal);

    const requestBody = fetch.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== "string") {
      throw new Error("missing JSON request body");
    }
    const body = JSON.parse(requestBody) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages[0]?.content).toContain("Return compact JSON only");
    expect(body.messages[0]?.content).toContain("Include every input id");
    expect(() => {
      JSON.parse(body.messages[1]?.content ?? "");
    }).not.toThrow();
  });

  it("sends protected format and a concise marker-preservation instruction", async () => {
    const source = createProtectedText(["Hello ", "world"]);
    const translated = source
      .replace("Hello ", "你好")
      .replace("world", "世界");
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        completion(
          JSON.stringify({
            results: [{ id: "protected", translatedText: translated }],
          }),
        ),
      ),
    );
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(
        {
          ...request,
          responseMode: "batch",
          segments: [
            { id: "protected", text: source, format: "protected-text-v1" },
          ],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ id: "protected", translatedText: translated }]);

    const body = fetch.mock.calls[0]?.[1]?.body;
    if (typeof body !== "string") throw new Error("missing request body");
    const payload = JSON.parse(body) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(payload.messages[0]?.content).toContain("format=protected-text-v1");
    expect(payload.messages[0]?.content).toContain("verbatim, exactly once");
    expect(JSON.parse(payload.messages[1]?.content ?? "{}")).toMatchObject({
      segments: [["0", source, [], [], "p"]],
    });
  });

  it("rejects a batch result with invalid protected markers", async () => {
    const source = createProtectedText(["Hello", "world"]);
    stubWireFetch(
      vi.fn(() =>
        Promise.resolve(
          completion(
            JSON.stringify({
              results: [
                {
                  id: "protected",
                  translatedText: source.replace(/:1:close\uE001/u, ""),
                },
              ],
            }),
          ),
        ),
      ),
    );

    await expect(
      provider().translateBatch(
        {
          ...request,
          responseMode: "batch",
          segments: [
            { id: "protected", text: source, format: "protected-text-v1" },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects an invalid protected SSE item before progress", async () => {
    const source = createProtectedText(["Hello", "world"]);
    const invalid = {
      id: "protected",
      translatedText: source.replace(/:1:close\uE001/u, ""),
    };
    const stream = chunkedSseResponse(
      `${sseEvent(JSON.stringify({ results: [invalid] }))}data: [DONE]\n\n`,
    );
    stream.close();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(stream.response)
      .mockImplementation((_input, init) =>
        Promise.resolve(
          completion(
            JSON.stringify({
              results: [
                {
                  id: wireIdsFromRequest(init)[0],
                  translatedText: invalid.translatedText,
                },
              ],
            }),
          ),
        ),
      );
    stubWireFetch(fetch);
    const progress = vi.fn();

    await expect(
      provider().translateBatch(
        {
          ...request,
          segments: [
            { id: "protected", text: source, format: "protected-text-v1" },
          ],
        },
        new AbortController().signal,
        progress,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(progress).not.toHaveBeenCalled();
  });

  it("uses no reasoning for supported GPT translation models", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      ),
    );
    stubWireFetch(fetch);

    await gptProvider().translateBatch(request, new AbortController().signal);

    const requestBody = fetch.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== "string") {
      throw new Error("missing low-latency request body");
    }
    expect(JSON.parse(requestBody)).toMatchObject({
      model: "gpt-5.5",
      reasoning_effort: "none",
    });
  });

  it("retries without reasoning control when a compatible endpoint rejects it", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"detail":"reasoning_effort is unsupported"}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      );
    stubWireFetch(fetch);

    await expect(
      gptProvider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const fallbackBody = fetch.mock.calls[1]?.[1]?.body;
    if (typeof fallbackBody !== "string") {
      throw new Error("missing reasoning fallback request body");
    }
    expect(JSON.parse(fallbackBody)).not.toHaveProperty("reasoning_effort");
    expect(JSON.parse(fallbackBody)).toHaveProperty("response_format");
  });

  it("remembers a rejected reasoning control for later batches", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"detail":"reasoning_effort is unsupported"}', {
          status: 400,
        }),
      )
      .mockImplementation(() =>
        Promise.resolve(completion('{"results":[["segment-1","你好"]]}')),
      );
    stubWireFetch(fetch);
    const activeProvider = gptProvider();

    await activeProvider.translateBatch(request, new AbortController().signal);
    await activeProvider.translateBatch(request, new AbortController().signal);

    expect(fetch).toHaveBeenCalledTimes(3);
    const laterBody = fetch.mock.calls[2]?.[1]?.body;
    if (typeof laterBody !== "string") {
      throw new Error("missing later reasoning request body");
    }
    expect(JSON.parse(laterBody)).not.toHaveProperty("reasoning_effort");
  });

  it("falls back to prompt-only JSON when a provider rejects json_schema with 422", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"detail":"response_format is unsupported"}', {
          status: 422,
        }),
      )
      .mockResolvedValueOnce(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      );
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const fallbackBody = fetch.mock.calls[1]?.[1]?.body;
    if (typeof fallbackBody !== "string") {
      throw new Error("missing prompt-only fallback request body");
    }
    expect(JSON.parse(fallbackBody)).not.toHaveProperty("response_format");
  });

  it("keeps JSON enforcement by falling back from json_schema to json_object", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"detail":"json_schema is unsupported"}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      );
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const fallbackBody = fetch.mock.calls[1]?.[1]?.body;
    if (typeof fallbackBody !== "string") {
      throw new Error("missing json_object fallback request body");
    }
    expect(JSON.parse(fallbackBody)).toMatchObject({
      response_format: { type: "json_object" },
    });
  });

  it("remembers json_object support for later batches", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"detail":"json_schema is unsupported"}', {
          status: 400,
        }),
      )
      .mockImplementation(() =>
        Promise.resolve(completion('{"results":[["segment-1","你好"]]}')),
      );
    stubWireFetch(fetch);
    const activeProvider = provider();

    await activeProvider.translateBatch(request, new AbortController().signal);
    await activeProvider.translateBatch(request, new AbortController().signal);

    expect(fetch).toHaveBeenCalledTimes(3);
    const laterBody = fetch.mock.calls[2]?.[1]?.body;
    if (typeof laterBody !== "string") {
      throw new Error("missing later response format request body");
    }
    expect(JSON.parse(laterBody)).toMatchObject({
      response_format: { type: "json_object" },
    });
  });

  it("removes response_format only after json_schema and json_object are explicitly rejected", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"detail":"json_schema is unsupported"}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          '{"detail":"response_format json_object is unsupported"}',
          {
            status: 400,
          },
        ),
      )
      .mockResolvedValueOnce(
        completion('{"results":[{"id":"segment-1","translatedText":"你好"}]}'),
      );
    stubWireFetch(fetch);

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
    expect(fetch).toHaveBeenCalledTimes(3);
    const finalBody = fetch.mock.calls[2]?.[1]?.body;
    if (typeof finalBody !== "string") {
      throw new Error("missing prompt-only fallback request body");
    }
    expect(JSON.parse(finalBody)).not.toHaveProperty("response_format");
  });

  it("remembers prompt-only JSON mode for later batches", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response('{"detail":"json_schema is unsupported"}', {
          status: 400,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          '{"detail":"response_format json_object is unsupported"}',
          { status: 400 },
        ),
      )
      .mockImplementation(() =>
        Promise.resolve(completion('{"results":[["segment-1","你好"]]}')),
      );
    stubWireFetch(fetch);
    const activeProvider = provider();

    await activeProvider.translateBatch(request, new AbortController().signal);
    await activeProvider.translateBatch(request, new AbortController().signal);

    expect(fetch).toHaveBeenCalledTimes(4);
    const laterBody = fetch.mock.calls[3]?.[1]?.body;
    if (typeof laterBody !== "string") {
      throw new Error("missing later prompt-only request body");
    }
    expect(JSON.parse(laterBody)).not.toHaveProperty("response_format");
  });

  it("deduplicates repeated AI context into a compact indexed JSON table", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        completion(
          '{"results":[{"id":"segment-1","translatedText":"你好"},{"id":"segment-2","translatedText":"世界"}]}',
        ),
      ),
    );
    stubWireFetch(fetch);

    await provider().translateBatch(
      {
        ...request,
        segments: [
          {
            id: "segment-1",
            text: "Hello",
            contextBefore: ["Earlier sentence"],
            contextAfter: ["Shared context", "Later sentence"],
          },
          {
            id: "segment-2",
            text: "World",
            contextBefore: ["Earlier sentence", "Shared context"],
            contextAfter: ["Later sentence"],
          },
        ],
      },
      new AbortController().signal,
    );

    const requestBody = fetch.mock.calls[0]?.[1]?.body;
    if (typeof requestBody !== "string") {
      throw new Error("missing compact context request body");
    }
    const body = JSON.parse(requestBody) as {
      messages: Array<{ role: string; content: string }>;
    };
    const input = JSON.parse(body.messages[1]?.content ?? "{}") as {
      segments?: Array<[string, string, string[], string[]]>;
    };
    expect(input.segments).toEqual([
      [
        "0",
        "Hello",
        ["Earlier sentence"],
        ["Shared context", "Later sentence"],
      ],
      [
        "1",
        "World",
        ["Earlier sentence", "Shared context"],
        ["Later sentence"],
      ],
    ]);
    expect(body.messages[0]?.content).toContain(
      "before/after are ordered reference context",
    );
  });

  it("accepts structured results returned through tool-call arguments", async () => {
    stubWireFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    tool_calls: [
                      {
                        function: {
                          arguments:
                            '{"items":[{"segment_id":"segment-1","translated":"你好"}]}',
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        ),
      ),
    );

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "segment-1", translatedText: "你好" }]);
  });

  it("does not expose an HTTP response body in request failures", async () => {
    stubWireFetch(
      vi.fn(() =>
        Promise.resolve(
          new Response('{"error":"secret provider detail"}', { status: 429 }),
        ),
      ),
    );

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "request_failed",
      message: runtimeErrorToken("request_failed"),
      retryable: true,
    });
  });

  it("normalizes low-level network failures to a stable safe error", async () => {
    stubWireFetch(
      vi.fn(() =>
        Promise.reject(
          new Error("request to https://provider.example/?key=secret failed"),
        ),
      ),
    );

    await expect(
      provider().translateBatch(request, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "request_failed",
      message: runtimeErrorToken("request_failed"),
      retryable: true,
    });
  });

  it("reports the provider deadline as a retryable request failure", async () => {
    vi.useFakeTimers();
    stubWireFetch(
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Timed out", "AbortError")),
              { once: true },
            );
          }),
      ),
    );

    const translation = provider().translateBatch(
      request,
      new AbortController().signal,
    );
    const rejection = expect(translation).rejects.toMatchObject({
      code: "request_failed",
      message: runtimeErrorToken("request_failed"),
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    await rejection;
  });

  it("keeps an external abort classified as an explicit cancellation", async () => {
    stubWireFetch(
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Cancelled", "AbortError")),
              { once: true },
            );
          }),
      ),
    );
    const controller = new AbortController();
    const translation = provider().translateBatch(request, controller.signal);
    const rejection = expect(translation).rejects.toMatchObject({
      code: "cancelled",
      message: runtimeErrorToken("cancelled"),
      retryable: true,
    });

    controller.abort();

    await rejection;
  });
});
