import { NTransError } from "@/src/shared/errors";
import { runtimeErrorToken } from "@/src/shared/runtime-errors";
import type { AiProviderId } from "@/src/shared/settings";
import {
  assertValidProtectedTranslation,
  protectedTextParts,
  rebuildProtectedTranslation,
} from "@/src/translation/protected-text";
import type {
  ProviderCapabilities,
  TranslationMode,
  TranslationProvider,
  TranslationProgressCallback,
  TranslationRequest,
  TranslationResult,
} from "@/src/translation/types";

export interface OpenAICompatibleConfig {
  /** Defaults to the legacy OpenAI-compatible wire protocol. */
  protocol?: AiProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  timeoutMs: number;
}

interface ChatCompletionResponse {
  type?: unknown;
  delta?: unknown;
  output_text?: unknown;
  content?: unknown;
  error?: unknown;
  stop_reason?: unknown;
  choices?: Array<{
    text?: unknown;
    message?: {
      content?: unknown;
      parsed?: unknown;
      tool_calls?: Array<{
        function?: { arguments?: unknown };
      }>;
    };
    delta?: {
      content?: unknown;
    };
  }>;
}

const JSON_PROTOCOL_PROMPT =
  'Return compact JSON only: {"results":[["<input id>","<translation>"]]}. Each item is exactly [id, translation]. Include every input id exactly once, copied verbatim and kept in input order. Translation must be non-empty and translate only the text referenced by that segment; context is reference only. If uncertain, provide the best translation instead of omitting an id. No markdown, commentary, labels, or extra keys.';
const ANTHROPIC_JSON_PROTOCOL_PROMPT =
  'Return compact JSON only: {"results":[{"id":"<input id>","translatedText":"<translation>"}]}. Include every input id exactly once, copied verbatim and kept in input order. Translation must be non-empty and translate only the text referenced by that segment; context is reference only. If uncertain, provide the best translation instead of omitting an id. No markdown, commentary, labels, or extra keys.';
const COMPACT_CONTEXT_PROMPT =
  "Each input segment is [id,text,before,after,format?]. Translate only text from that same tuple; before/after are ordered reference context. format p means protected-text-v1. mediaTitle is reference context only and must not be returned.";
const PROTECTED_TEXT_PROMPT =
  "For format=protected-text-v1, copy every private-use NT1 open/close marker verbatim, exactly once, with unchanged order and nesting; translate only enclosed text.";
const MAX_ADAPTIVE_REQUESTS = 6;
const MAX_STREAMING_CAPABILITY_ENTRIES = 64;
const MAX_OPTIONAL_CAPABILITY_ENTRIES = 64;
// A gateway may buffer response headers until the whole streamed completion is
// ready. Do not let that capability probe serialize every other page batch.
const STREAMING_PROBE_WAIT_MS = 250;

type StreamingCapability = "supported" | "unsupported";
type StreamingProbeOutcome = StreamingCapability | "unknown";

interface StreamingCapabilityEntry {
  status?: StreamingCapability;
  flight?: Promise<StreamingProbeOutcome>;
  settle?: (outcome: StreamingProbeOutcome) => void;
}

interface StreamingDecision {
  useStream: boolean;
  completeProbe?: (outcome: StreamingProbeOutcome) => void;
}

const streamingCapabilities = new Map<string, StreamingCapabilityEntry>();

type ResponseFormatMode = "json-schema" | "json-object" | "none";

interface OptionalRequestCapabilities {
  responseFormatMode?: ResponseFormatMode;
  reasoningEffortSupported?: boolean;
  anthropicOutputFormatSupported?: boolean;
}

const optionalRequestCapabilities = new Map<
  string,
  OptionalRequestCapabilities
>();

function configuredProtocol(config: OpenAICompatibleConfig): AiProviderId {
  return config.protocol === "anthropic-messages"
    ? "anthropic-messages"
    : "openai-compatible";
}

function streamingCapabilityKey(config: OpenAICompatibleConfig): string {
  const protocol = configuredProtocol(config);
  let normalizedBaseUrl = endpoint(config.baseUrl, protocol);
  try {
    const parsed = new URL(normalizedBaseUrl);
    parsed.hash = "";
    normalizedBaseUrl = parsed.toString().replace(/\/+$/u, "");
  } catch {
    // Configuration validation reports malformed URLs when the request runs.
  }
  return `${protocol}\u001f${normalizedBaseUrl}\u001f${config.model.trim().normalize("NFC")}`;
}

function touchStreamingCapability(
  key: string,
  entry: StreamingCapabilityEntry,
): void {
  streamingCapabilities.delete(key);
  streamingCapabilities.set(key, entry);
}

function optionalCapabilitiesFor(key: string): OptionalRequestCapabilities {
  const existing = optionalRequestCapabilities.get(key);
  if (existing) {
    optionalRequestCapabilities.delete(key);
    optionalRequestCapabilities.set(key, existing);
    return existing;
  }
  if (optionalRequestCapabilities.size >= MAX_OPTIONAL_CAPABILITY_ENTRIES) {
    const oldestKey = optionalRequestCapabilities.keys().next().value;
    if (typeof oldestKey === "string")
      optionalRequestCapabilities.delete(oldestKey);
  }
  const created: OptionalRequestCapabilities = {};
  optionalRequestCapabilities.set(key, created);
  return created;
}

function makeStreamingCapabilityRoom(): boolean {
  if (streamingCapabilities.size < MAX_STREAMING_CAPABILITY_ENTRIES)
    return true;
  for (const [key, entry] of streamingCapabilities) {
    if (!entry.flight) {
      streamingCapabilities.delete(key);
      return true;
    }
  }
  return false;
}

function rememberStreamingCapability(
  key: string,
  status: StreamingCapability,
): void {
  const existing = streamingCapabilities.get(key);
  if (existing?.flight) return;
  if (!existing && !makeStreamingCapabilityRoom()) return;
  const entry = existing ?? {};
  entry.status = status;
  touchStreamingCapability(key, entry);
}

function waitForStreamingProbe(
  flight: Promise<StreamingProbeOutcome>,
  signal: AbortSignal,
): Promise<StreamingProbeOutcome> {
  if (signal.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (outcome: StreamingProbeOutcome): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      globalThis.clearTimeout(timeout);
      resolve(outcome);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      globalThis.clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = globalThis.setTimeout(
      () => finish("unknown"),
      STREAMING_PROBE_WAIT_MS,
    );
    signal.addEventListener("abort", abort, { once: true });
    void flight.then(finish);
  });
}

async function streamingDecision(
  key: string,
  signal: AbortSignal,
): Promise<StreamingDecision> {
  const existing = streamingCapabilities.get(key);
  if (existing) {
    touchStreamingCapability(key, existing);
    if (existing.status) return { useStream: existing.status === "supported" };
    if (existing.flight) {
      const outcome = await waitForStreamingProbe(existing.flight, signal);
      // An inconclusive probe is not cached. Existing waiters use a normal
      // request for this batch instead of immediately creating a probe storm.
      return { useStream: outcome === "supported" };
    }
  }

  if (!makeStreamingCapabilityRoom()) return { useStream: false };

  let settleFlight: (outcome: StreamingProbeOutcome) => void = () => undefined;
  const entry: StreamingCapabilityEntry = {};
  entry.flight = new Promise((resolve) => {
    settleFlight = resolve;
  });
  entry.settle = settleFlight;
  streamingCapabilities.set(key, entry);

  let completed = false;
  return {
    useStream: true,
    completeProbe(outcome) {
      if (completed) return;
      completed = true;
      const current = streamingCapabilities.get(key);
      settleFlight(outcome);
      if (current !== entry) return;
      if (outcome === "unknown") {
        streamingCapabilities.delete(key);
        return;
      }
      entry.status = outcome;
      delete entry.flight;
      delete entry.settle;
      touchStreamingCapability(key, entry);
    },
  };
}

export function __resetOpenAICompatibleStreamingCapabilityCacheForTests(): void {
  for (const entry of streamingCapabilities.values()) entry.settle?.("unknown");
  streamingCapabilities.clear();
  optionalRequestCapabilities.clear();
}

function compactRequestInput(request: TranslationRequest): {
  sourceLanguage: string;
  targetLanguage: string;
  mode: TranslationMode;
  mediaTitle?: string;
  segments: Array<[string, string, string[], string[], "p"?]>;
} {
  const segments = request.segments.map(
    (segment): [string, string, string[], string[], "p"?] => {
      const tuple: [string, string, string[], string[], "p"?] = [
        segment.id,
        segment.text,
        segment.contextBefore ?? [],
        segment.contextAfter ?? [],
      ];
      if (segment.format === "protected-text-v1") tuple.push("p");
      return tuple;
    },
  );
  return {
    sourceLanguage: request.sourceLanguage,
    targetLanguage: request.targetLanguage,
    mode: request.mode,
    ...(request.mediaTitle ? { mediaTitle: request.mediaTitle } : {}),
    segments,
  };
}

interface WireRequestAliases {
  request: TranslationRequest;
  restoreResults(results: readonly TranslationResult[]): TranslationResult[];
  restoreProgress?: TranslationProgressCallback;
}

/**
 * Stable cue IDs remain part of the extension contract and cache identity, but
 * repeating them in both directions wastes tokens. Each physical Provider call
 * uses short positional aliases and maps validated results back immediately.
 */
function wireRequestAliases(
  request: TranslationRequest,
  onProgress?: TranslationProgressCallback,
): WireRequestAliases {
  const stableIdByWireId = new Map<string, string>();
  const wireSegments = request.segments.map((segment, index) => {
    const wireId = index.toString(36);
    stableIdByWireId.set(wireId, segment.id);
    return { ...segment, id: wireId };
  });
  const restoreResult = (result: TranslationResult): TranslationResult => {
    const stableId = stableIdByWireId.get(result.id);
    if (!stableId) {
      throw invalidResponse(
        `Unknown compact result ID: ${diagnosticId(result.id)}.`,
      );
    }
    return { id: stableId, translatedText: result.translatedText };
  };
  return {
    request: { ...request, segments: wireSegments },
    restoreResults: (results) => results.map(restoreResult),
    ...(onProgress
      ? {
          restoreProgress: async (result: TranslationResult) => {
            await onProgress(restoreResult(result));
          },
        }
      : {}),
  };
}

function endpoint(baseUrl: string, protocol: AiProviderId): string {
  const url = new URL(baseUrl.trim());
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError(
      "Provider Base URL must not contain credentials, query, or fragment.",
    );
  }
  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  if (protocol === "anthropic-messages") {
    url.pathname = normalizedPath.endsWith("/messages")
      ? normalizedPath
      : normalizedPath.endsWith("/v1")
        ? `${normalizedPath}/messages`
        : `${normalizedPath}/v1/messages`;
  } else {
    url.pathname = normalizedPath.endsWith("/chat/completions")
      ? normalizedPath
      : `${normalizedPath}/chat/completions`;
  }
  return url.toString();
}

function responseFormat(expectedResults: number) {
  return {
    type: "json_schema",
    json_schema: {
      name: "translation_results",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: {
            type: "array",
            minItems: expectedResults,
            maxItems: expectedResults,
            items: {
              type: "array",
              items: { type: "string" },
              minItems: 2,
              maxItems: 2,
            },
          },
        },
        required: ["results"],
      },
    },
  };
}

function anthropicOutputFormat() {
  return {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string" },
                translatedText: { type: "string" },
              },
              required: ["id", "translatedText"],
            },
          },
        },
        required: ["results"],
      },
    },
  };
}

function jsonObjectResponseFormat() {
  return { type: "json_object" };
}

function lowLatencyReasoningEffort(model: string): "none" | undefined {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("-pro")) return undefined;
  return /^gpt-5\.(?:[1-9]\d*)(?:-|$)/u.test(normalized) ? "none" : undefined;
}

function rejectsOptionalParameter(
  response: { status: number; body: string },
  parameter:
    "response_format" | "reasoning_effort" | "output_config" | "stream",
): boolean {
  if (response.status !== 400 && response.status !== 422) return false;
  const body = response.body.toLowerCase();
  const mentionsParameter =
    parameter === "response_format"
      ? /response[_ -]?format|json[_ -]?schema|structured/iu.test(body)
      : parameter === "reasoning_effort"
        ? /reasoning[_ -]?effort/iu.test(body)
        : parameter === "output_config"
          ? /output[_ -]?config|json[_ -]?schema|structured/iu.test(body)
          : /\bstream(?:ing)?\b/iu.test(body);
  return (
    mentionsParameter &&
    /unsupported|not support|unknown|unrecognized|unexpected|invalid|extra|additional/iu.test(
      body,
    )
  );
}

function rejectionTargetsJsonSchema(body: string): boolean {
  return /json[_ -]?schema|structured(?:[_ -]?output)?|schema type/iu.test(
    body,
  );
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (isRecord(content) && typeof content.text === "string") {
    return content.text;
  }
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      isRecord(part) && typeof part.text === "string" ? [part.text] : [],
    )
    .join("");
}

function streamedEventContent(payload: ChatCompletionResponse): string {
  if (
    payload.type === "content_block_delta" &&
    isRecord(payload.delta) &&
    payload.delta.type === "text_delta"
  ) {
    return typeof payload.delta.text === "string" ? payload.delta.text : "";
  }
  const chatContent = (payload.choices ?? [])
    .map((choice) =>
      textContent(
        choice.delta?.content ?? choice.message?.content ?? choice.text,
      ),
    )
    .join("");
  if (chatContent) return chatContent;
  if (payload.type === "response.output_text.delta") {
    return textContent(payload.delta);
  }
  return textContent(payload.output_text);
}

function resultsArrayStart(text: string): number | undefined {
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') break;
      index += 1;
    }
    if (index >= text.length) return undefined;
    let key: unknown;
    try {
      key = JSON.parse(text.slice(start, index + 1)) as unknown;
    } catch {
      return undefined;
    }
    index += 1;
    if (key !== "results") continue;
    while (/\s/u.test(text[index] ?? "")) index += 1;
    if (text[index] !== ":") continue;
    index += 1;
    while (/\s/u.test(text[index] ?? "")) index += 1;
    if (index >= text.length) return undefined;
    if (text[index] === "[") return index;
  }
  return undefined;
}

function completeResultItems(text: string): unknown[] {
  const arrayStart = resultsArrayStart(text);
  if (arrayStart === undefined) return [];
  const items: unknown[] = [];
  let index = arrayStart + 1;
  while (index < text.length) {
    while (/\s|,/u.test(text[index] ?? "")) index += 1;
    if (index >= text.length || text[index] === "]") return items;
    if (text[index] !== "{" && text[index] !== "[")
      throw invalidResponse(
        `A streamed result item must be an object or a two-string array. Received prefix: ${JSON.stringify(text[index] ?? "")}.`,
      );
    const objectStart = index;
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (index < text.length) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
      } else if (character === '"') inString = true;
      else if (character === "{" || character === "[") depth += 1;
      else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          let item: unknown;
          try {
            item = JSON.parse(text.slice(objectStart, index + 1)) as unknown;
          } catch {
            throw invalidResponse();
          }
          items.push(item);
          index += 1;
          break;
        }
      }
      index += 1;
    }
    if (depth > 0 || inString) return items;
  }
  return items;
}

function canonicalStreamingResult(value: unknown): TranslationResult {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    value[1].trim()
  ) {
    return { id: value[0], translatedText: value[1] };
  }
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.translatedText !== "string" ||
    !value.translatedText.trim()
  ) {
    throw invalidResponse(
      `A streamed result must contain a string id and non-empty translatedText. Received type: ${Array.isArray(value) ? "array" : typeof value}.`,
    );
  }
  return { id: value.id, translatedText: value.translatedText };
}

class StreamingResultsParser {
  private text = "";
  private emittedCount = 0;
  private readonly emittedIds = new Set<string>();
  private readonly emitted: TranslationResult[] = [];
  private readonly expectedSegments: ReadonlyMap<
    string,
    TranslationRequest["segments"][number]
  >;

  constructor(
    segments: TranslationRequest["segments"],
    private readonly onProgress?: TranslationProgressCallback,
  ) {
    this.expectedSegments = new Map(
      segments.map((segment) => [segment.id, segment]),
    );
  }

  async push(chunk: string): Promise<void> {
    this.text += chunk;
    const items = completeResultItems(this.text);
    for (const value of items.slice(this.emittedCount)) {
      const result = canonicalStreamingResult(value);
      if (
        !this.expectedSegments.has(result.id) ||
        this.emittedIds.has(result.id)
      ) {
        throw invalidResponse(
          `${this.expectedSegments.has(result.id) ? "Duplicate" : "Unknown"} streamed result ID: ${diagnosticId(result.id)}`,
        );
      }
      const segment = this.expectedSegments.get(result.id);
      if (!segment) {
        throw invalidResponse(
          `Unknown streamed result ID: ${diagnosticId(result.id)}`,
        );
      }
      // Never expose a partial result until its protected marker contract has
      // been verified against the exact source segment.
      assertValidProtectedTranslation(segment, result.translatedText);
      this.emittedIds.add(result.id);
      this.emitted.push(result);
      this.emittedCount += 1;
      await this.onProgress?.(result);
    }
  }

  content(): string {
    return this.text;
  }

  emittedResults(): number {
    return this.emittedCount;
  }

  results(): TranslationResult[] {
    return [...this.emitted];
  }
}

async function readStreamingContent(
  response: Response,
  request: TranslationRequest,
  protocol: AiProviderId,
  onProgress?: TranslationProgressCallback,
): Promise<{ content: string; emittedResults: TranslationResult[] }> {
  if (!response.body) return { content: "", emittedResults: [] };
  const parser = new StreamingResultsParser(request.segments, onProgress);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  let stopReason: string | undefined;
  let sawMessageStop = false;

  const consumeEvent = async (event: string): Promise<void> => {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    let payload: ChatCompletionResponse;
    try {
      payload = JSON.parse(data) as ChatCompletionResponse;
    } catch {
      throw invalidResponse(
        `Invalid server-sent event JSON. Event length: ${data.length} characters.`,
      );
    }
    if (payload.type === "error") {
      const errorType =
        isRecord(payload.error) && typeof payload.error.type === "string"
          ? diagnosticId(payload.error.type)
          : "unknown";
      throw new NTransError(
        runtimeErrorToken("request_failed"),
        "request_failed",
        errorType === "overloaded_error" ||
          errorType === "rate_limit_error" ||
          errorType === "api_error" ||
          errorType === "timeout_error",
        `The streamed Provider response reported an error event of type ${errorType}.`,
      );
    }
    if (payload.type === "message_delta" && isRecord(payload.delta)) {
      stopReason =
        typeof payload.delta.stop_reason === "string"
          ? payload.delta.stop_reason
          : stopReason;
    }
    if (payload.type === "message_stop") sawMessageStop = true;
    const chunk = streamedEventContent(payload);
    if (chunk) await parser.push(chunk);
  };

  try {
    while (!done) {
      const read = await reader.read();
      done = read.done;
      buffer += decoder.decode(read.value, { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/u);
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/u)?.[0];
        buffer = buffer.slice(boundary + (separator?.length ?? 2));
        await consumeEvent(event);
        boundary = buffer.search(/\r?\n\r?\n/u);
      }
    }
    if (buffer.trim()) await consumeEvent(buffer);
  } catch (error) {
    if (error instanceof NTransError && !error.retryable) throw error;
    if (parser.emittedResults() > 0) {
      const emittedResults = parser.emittedResults();
      throw new PartialStreamingResponseError(
        parser.results(),
        error instanceof NTransError && error.details
          ? error.details
          : `The streamed completion became invalid after ${emittedResults} result ${emittedResults === 1 ? "item was" : "items were"} emitted.`,
      );
    }
    throw error;
  }
  if (protocol === "anthropic-messages") {
    let terminalError: NTransError | undefined;
    if (!sawMessageStop) {
      terminalError = invalidResponse(
        "The Anthropic stream ended without a message_stop event.",
      );
    } else if (stopReason === undefined) {
      terminalError = invalidResponse(
        "The Anthropic stream ended without a terminal stop_reason.",
      );
    } else if (stopReason === "refusal") {
      terminalError = new NTransError(
        runtimeErrorToken("request_failed"),
        "request_failed",
        false,
        "The Anthropic response stopped with refusal.",
      );
    } else if (stopReason !== "end_turn" && stopReason !== "stop_sequence") {
      terminalError = invalidResponse(
        `The Anthropic stream stopped with ${diagnosticId(stopReason)}.`,
      );
    }
    if (terminalError) {
      if (parser.emittedResults() > 0) {
        throw new PartialStreamingResponseError(
          parser.results(),
          terminalError.details,
          false,
          terminalError,
        );
      }
      throw terminalError;
    }
  }
  return {
    content: parser.content(),
    emittedResults: parser.results(),
  };
}

function deduplicatedProgress(
  segments: TranslationRequest["segments"],
  onProgress?: TranslationProgressCallback,
): TranslationProgressCallback | undefined {
  if (!onProgress) return undefined;
  const expected = new Set(segments.map((segment) => segment.id));
  const delivered = new Set<string>();
  return async (result) => {
    if (!expected.has(result.id) || delivered.has(result.id)) return;
    delivered.add(result.id);
    await onProgress(result);
  };
}

function parseJsonText(content: string): unknown {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  let parseReason: string;
  try {
    return JSON.parse(unfenced) as unknown;
  } catch (error) {
    parseReason = error instanceof SyntaxError ? error.message : "unknown";
    const objectStart = unfenced.indexOf("{");
    const objectEnd = unfenced.lastIndexOf("}");
    const arrayStart = unfenced.indexOf("[");
    const arrayEnd = unfenced.lastIndexOf("]");
    const candidates = [
      objectStart >= 0 && objectEnd > objectStart
        ? unfenced.slice(objectStart, objectEnd + 1)
        : "",
      arrayStart >= 0 && arrayEnd > arrayStart
        ? unfenced.slice(arrayStart, arrayEnd + 1)
        : "",
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        // Try the next bounded JSON candidate.
      }
    }
  }
  throw invalidResponse(
    `JSON parse failed (${parseReason}). Response length: ${unfenced.length} characters.`,
  );
}

function contentValue(content: unknown): unknown {
  if (typeof content === "string") return parseJsonText(content);
  if (Array.isArray(content)) {
    const text = content
      .flatMap((part) =>
        isRecord(part) && typeof part.text === "string" ? [part.text] : [],
      )
      .join("");
    if (text) return parseJsonText(text);
  }
  return content;
}

function keyedResults(
  value: unknown,
  expectedIds: ReadonlySet<string>,
): TranslationResult[] | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    !entries.some(([id]) => expectedIds.has(id)) ||
    entries.some(
      ([, translatedText]) =>
        typeof translatedText !== "string" || !translatedText.trim(),
    )
  ) {
    return undefined;
  }
  return entries.flatMap(([id, translatedText]) =>
    typeof translatedText === "string" ? [{ id, translatedText }] : [],
  );
}

function parseResults(
  content: unknown,
  expectedSegments: TranslationRequest["segments"],
): TranslationResult[] {
  const value = contentValue(content);
  const expectedIds = new Set(expectedSegments.map((segment) => segment.id));
  const envelope = isRecord(value)
    ? (value.results ??
      value.translations ??
      value.result ??
      value.items ??
      value.data ??
      value.output)
    : undefined;
  const keyed =
    keyedResults(envelope, expectedIds) ?? keyedResults(value, expectedIds);
  if (keyed) return keyed;
  const items: unknown[] | undefined = Array.isArray(value)
    ? value
    : Array.isArray(envelope)
      ? envelope
      : isRecord(value) &&
          (typeof value.id === "string" ||
            typeof value.segmentId === "string" ||
            typeof value.segment_id === "string")
        ? [value]
        : isRecord(envelope) &&
            (typeof envelope.id === "string" ||
              typeof envelope.segmentId === "string" ||
              typeof envelope.segment_id === "string")
          ? [envelope]
          : undefined;
  if (!items) {
    throw invalidResponse(
      `Expected a results array or ID-keyed object. Top-level keys: ${isRecord(value) ? diagnosticKeys(value) : "not an object"}.`,
    );
  }

  return items.map((item: unknown, index) => {
    if (
      Array.isArray(item) &&
      item.length === 2 &&
      typeof item[0] === "string" &&
      typeof item[1] === "string" &&
      item[1].trim()
    ) {
      return { id: item[0], translatedText: item[1] };
    }
    if (!isRecord(item)) {
      throw invalidResponse(
        `Result item ${index + 1} must be an object or a two-string array (received ${Array.isArray(item) ? "array" : typeof item}).`,
      );
    }
    const id = [item.id, item.segmentId, item.segment_id].find(
      (candidate): candidate is string => typeof candidate === "string",
    );
    const translatedText = [
      item.translatedText,
      item.translated_text,
      item.translation,
      item.translation_text,
      item.translated,
      item.targetText,
      item.text,
    ].find((candidate): candidate is string => typeof candidate === "string");
    if (!id || !translatedText?.trim()) {
      throw invalidResponse(
        `Result item ${index + 1} must contain a string id and non-empty translatedText. Item keys: ${diagnosticKeys(item)}.`,
      );
    }
    return { id, translatedText };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const MAX_DIAGNOSTIC_CHARACTERS = 2_400;

function diagnosticId(value: unknown): string {
  const id = String(value).trim();
  return /^[A-Za-z0-9_.:-]{1,120}$/u.test(id)
    ? id
    : `[redacted non-identifier; length ${id.length}]`;
}

function diagnosticIds(values: Iterable<string>): string {
  const ids = [...values];
  const shown = ids.slice(0, 20).map(diagnosticId);
  return `${shown.join(", ")}${ids.length > shown.length ? `, ... (${ids.length} total)` : ""}`;
}

function diagnosticKeys(value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  const shown = keys.slice(0, 12).map(diagnosticId);
  return `${shown.join(", ") || "none"}${keys.length > shown.length ? `, ... (${keys.length} total)` : ""}`;
}

function invalidResponse(details?: string): NTransError {
  return new NTransError(
    runtimeErrorToken("invalid_response"),
    "invalid_response",
    true,
    details?.slice(0, MAX_DIAGNOSTIC_CHARACTERS),
  );
}

class NonSplittableInvalidResponseError extends NTransError {
  constructor(details?: string) {
    super(
      runtimeErrorToken("invalid_response"),
      "invalid_response",
      true,
      (
        details ??
        "The streamed completion ended without a complete JSON results payload."
      ).slice(0, MAX_DIAGNOSTIC_CHARACTERS),
    );
    this.name = "NonSplittableInvalidResponseError";
  }
}

class PartialStreamingResponseError extends NTransError {
  constructor(
    readonly partialResults: TranslationResult[],
    details?: string,
    readonly allowRecovery = true,
    readonly terminalError?: NTransError,
  ) {
    super(
      runtimeErrorToken("invalid_response"),
      "invalid_response",
      true,
      (
        details ??
        `The streamed completion ended after ${partialResults.length} complete result items.`
      ).slice(0, MAX_DIAGNOSTIC_CHARACTERS),
    );
    this.name = "PartialStreamingResponseError";
  }
}

function isEmptyCompletionContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length === 0;
  if (!Array.isArray(content)) return false;
  return !content.some(
    (part) =>
      isRecord(part) &&
      typeof part.text === "string" &&
      part.text.trim().length > 0,
  );
}

function assessResults(
  segments: TranslationRequest["segments"],
  results: TranslationResult[],
): {
  accepted: TranslationResult[];
  missing: TranslationRequest["segments"];
  diagnostics: string[];
  invalidProtectedIds: string[];
} {
  const expected = new Map(segments.map((segment) => [segment.id, segment]));
  const accepted = new Map<string, TranslationResult>();
  const diagnostics: string[] = [];
  const invalidProtectedIds: string[] = [];
  for (const result of results) {
    if (!expected.has(result.id)) {
      diagnostics.push(
        `Unknown result ID: ${diagnosticId(result.id)}. Expected IDs: ${diagnosticIds(expected.keys())}`,
      );
      continue;
    }
    if (accepted.has(result.id)) {
      diagnostics.push(`Duplicate result ID: ${diagnosticId(result.id)}`);
      continue;
    }
    if (
      typeof result.translatedText !== "string" ||
      !result.translatedText.trim()
    )
      throw invalidResponse(
        `Result ID ${diagnosticId(result.id)} has an empty translation.`,
      );
    const segment = expected.get(result.id);
    if (!segment) {
      throw invalidResponse(`Unknown result ID: ${diagnosticId(result.id)}`);
    }
    try {
      assertValidProtectedTranslation(segment, result.translatedText);
    } catch (error) {
      if (
        segment.format === "protected-text-v1" &&
        error instanceof NTransError &&
        error.code === "invalid_response"
      ) {
        invalidProtectedIds.push(segment.id);
        continue;
      }
      throw error;
    }
    accepted.set(result.id, result);
  }
  return {
    accepted: segments.flatMap((segment) => {
      const result = accepted.get(segment.id);
      return result ? [result] : [];
    }),
    missing: segments.filter((segment) => !accepted.has(segment.id)),
    diagnostics,
    invalidProtectedIds,
  };
}

function assessmentDiagnostics(
  assessed: ReturnType<typeof assessResults>,
): string | undefined {
  if (assessed.diagnostics.length === 0) return undefined;
  return `Provider result ID diagnostics: ${assessed.diagnostics.join("; ")}`;
}

export class OpenAICompatibleProvider implements TranslationProvider {
  readonly id: AiProviderId;
  readonly capabilities: ProviderCapabilities = {
    maxBatchCharacters: 12_000,
    maxBatchSegments: 60,
    supportsContext: true,
    runtime: "background",
  };
  constructor(
    readonly mode: TranslationMode,
    private readonly config: OpenAICompatibleConfig,
  ) {
    this.id = configuredProtocol(config);
  }

  async translateBatch(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    if (
      !this.config.apiKey.trim() ||
      !this.config.baseUrl.trim() ||
      !this.config.model.trim()
    ) {
      throw new NTransError(
        runtimeErrorToken("invalid_configuration"),
        "invalid_configuration",
      );
    }

    return this.translateAdaptive(
      request,
      signal,
      deduplicatedProgress(request.segments, onProgress),
      { used: 0 },
    );
  }

  private async translateAdaptive(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
    budget: { used: number } = { used: 0 },
  ): Promise<TranslationResult[]> {
    if (budget.used >= MAX_ADAPTIVE_REQUESTS)
      throw invalidResponse(
        `Provider response recovery limit reached. Remaining IDs: ${diagnosticIds(request.segments.map((segment) => segment.id))}`,
      );
    budget.used += 1;
    let results: TranslationResult[];
    try {
      results = await this.translateOnce(request, signal, onProgress);
    } catch (error) {
      if (error instanceof PartialStreamingResponseError && !signal.aborted) {
        if (!error.allowRecovery) {
          throw error.terminalError ?? invalidResponse(error.details);
        }
        const assessed = assessResults(request.segments, error.partialResults);
        const diagnostics = assessmentDiagnostics(assessed);
        if (assessed.missing.length === 0) {
          if (!diagnostics) return assessed.accepted;
          for (const result of assessed.accepted) await onProgress?.(result);
          throw invalidResponse(diagnostics);
        }
        let recovered: TranslationResult[];
        try {
          recovered = await this.translateAdaptive(
            { ...request, segments: assessed.missing },
            signal,
            onProgress,
            budget,
          );
        } catch (recoveryError) {
          if (signal.aborted) throw recoveryError;
          throw invalidResponse(
            `${error.details ?? "The streamed completion contained invalid result IDs."} Missing-ID recovery failed${recoveryError instanceof NTransError && recoveryError.details ? `: ${recoveryError.details}` : "."}`,
          );
        }
        const resultsById = new Map(
          [...assessed.accepted, ...recovered].map((result) => [
            result.id,
            result,
          ]),
        );
        const combined = request.segments.map((segment) => {
          const result = resultsById.get(segment.id);
          if (!result)
            throw invalidResponse(
              `Missing streamed result ID after recovery: ${diagnosticId(segment.id)}`,
            );
          return result;
        });
        if (diagnostics) {
          for (const result of combined) await onProgress?.(result);
          throw invalidResponse(diagnostics);
        }
        return combined;
      }
      if (
        error instanceof NTransError &&
        !(error instanceof NonSplittableInvalidResponseError) &&
        error.code === "invalid_response" &&
        request.segments.length > 1 &&
        !signal.aborted
      ) {
        const middle = Math.ceil(request.segments.length / 2);
        const left = await this.translateAdaptive(
          { ...request, segments: request.segments.slice(0, middle) },
          signal,
          onProgress,
          budget,
        );
        const right = await this.translateAdaptive(
          { ...request, segments: request.segments.slice(middle) },
          signal,
          onProgress,
          budget,
        );
        return [...left, ...right];
      }
      throw error;
    }

    const assessed = assessResults(request.segments, results);
    const diagnostics = assessmentDiagnostics(assessed);
    if (assessed.missing.length === 0) {
      if (!diagnostics) return assessed.accepted;
      for (const result of assessed.accepted) await onProgress?.(result);
      throw invalidResponse(diagnostics);
    }
    // Do not retry an identical request when the provider returned no usable
    // IDs. Partial responses still recover only their missing subset below.
    if (
      assessed.accepted.length === 0 &&
      assessed.invalidProtectedIds.length === 0
    )
      throw invalidResponse(
        [
          assessmentDiagnostics(assessed),
          `Provider returned no usable IDs. Expected IDs: ${diagnosticIds(request.segments.map((segment) => segment.id))}`,
        ]
          .filter(Boolean)
          .join(" "),
      );
    // A valid partial JSON response is already useful. Publish it before
    // recovering the missing subset so the page can replace those IDs now and
    // an outer retry never resends text that the Provider translated.
    for (const result of assessed.accepted) await onProgress?.(result);
    const recovered: TranslationResult[] = [];
    try {
      const invalidProtectedIds = new Set(assessed.invalidProtectedIds);
      const protectedMissing = assessed.missing.filter((segment) =>
        invalidProtectedIds.has(segment.id),
      );
      const ordinaryMissing = assessed.missing.filter(
        (segment) => !invalidProtectedIds.has(segment.id),
      );
      if (protectedMissing.length > 0) {
        recovered.push(
          ...(await this.translateProtectedParts(
            request,
            protectedMissing,
            signal,
            onProgress,
            budget,
          )),
        );
      }
      if (ordinaryMissing.length > 0) {
        recovered.push(
          ...(await this.translateAdaptive(
            { ...request, segments: ordinaryMissing },
            signal,
            onProgress,
            budget,
          )),
        );
      }
    } catch (error) {
      if (!diagnostics || signal.aborted) throw error;
      throw invalidResponse(
        `${diagnostics} Missing-ID recovery failed${error instanceof NTransError && error.details ? `: ${error.details}` : "."}`,
      );
    }
    const recoveredById = new Map(
      recovered.map((result) => [result.id, result]),
    );
    const acceptedById = new Map(
      assessed.accepted.map((result) => [result.id, result]),
    );
    const combined = request.segments.map((segment) => {
      const result =
        acceptedById.get(segment.id) ?? recoveredById.get(segment.id);
      if (!result)
        throw invalidResponse(
          `Missing result ID after recovery: ${diagnosticId(segment.id)}`,
        );
      return result;
    });
    if (diagnostics) {
      for (const result of combined) await onProgress?.(result);
      throw invalidResponse(diagnostics);
    }
    return combined;
  }

  private async translateProtectedParts(
    request: TranslationRequest,
    segments: TranslationRequest["segments"],
    signal: AbortSignal,
    onProgress: TranslationProgressCallback | undefined,
    budget: { used: number },
  ): Promise<TranslationResult[]> {
    const states = segments.map((segment, segmentIndex) => {
      const sourceParts = protectedTextParts(segment.text);
      return {
        segment,
        segmentIndex,
        sourceParts,
        translatedParts: [...sourceParts],
      };
    });
    const partLocations = new Map<
      string,
      { segmentIndex: number; partIndex: number }
    >();
    const partSegments = states.flatMap((state) =>
      state.sourceParts.flatMap((text, partIndex) => {
        if (!/[\p{L}\p{N}]/u.test(text)) return [];
        const id = `protected-part-${state.segmentIndex.toString(36)}-${partIndex.toString(36)}`;
        partLocations.set(id, {
          segmentIndex: state.segmentIndex,
          partIndex,
        });
        return [
          {
            id,
            text,
            format: "plain-text-v1" as const,
            contextBefore: [
              ...(state.segment.contextBefore ?? []),
              ...state.sourceParts
                .slice(Math.max(0, partIndex - 2), partIndex)
                .filter((value) => value.trim()),
            ],
            contextAfter: [
              ...state.sourceParts
                .slice(partIndex + 1, partIndex + 3)
                .filter((value) => value.trim()),
              ...(state.segment.contextAfter ?? []),
            ],
          },
        ];
      }),
    );
    const batches: (typeof partSegments)[] = [];
    let batch: typeof partSegments = [];
    let characters = 0;
    for (const part of partSegments) {
      const partCharacters =
        part.text.length +
        (part.contextBefore ?? []).reduce(
          (total, value) => total + value.length,
          0,
        ) +
        (part.contextAfter ?? []).reduce(
          (total, value) => total + value.length,
          0,
        );
      if (
        batch.length > 0 &&
        (batch.length >= this.capabilities.maxBatchSegments ||
          characters + partCharacters > this.capabilities.maxBatchCharacters)
      ) {
        batches.push(batch);
        batch = [];
        characters = 0;
      }
      batch.push(part);
      characters += partCharacters;
    }
    if (batch.length > 0) batches.push(batch);

    for (const current of batches) {
      const recovered = await this.translateAdaptive(
        { ...request, responseMode: "batch", segments: current },
        signal,
        undefined,
        budget,
      );
      for (const result of recovered) {
        const location = partLocations.get(result.id);
        const state =
          location === undefined ? undefined : states[location.segmentIndex];
        if (
          !location ||
          !state ||
          location.partIndex >= state.sourceParts.length
        ) {
          throw invalidResponse(
            `Protected-part recovery returned an unknown ID: ${diagnosticId(result.id)}.`,
          );
        }
        state.translatedParts[location.partIndex] = result.translatedText;
      }
    }

    const results = states.map(({ segment, translatedParts }) => ({
      id: segment.id,
      translatedText: rebuildProtectedTranslation(
        segment.text,
        translatedParts,
      ),
    }));
    for (const result of results) await onProgress?.(result);
    return results;
  }

  private async translateOnce(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const capabilityKey = streamingCapabilityKey(this.config);
    let completeStreamingProbe:
      ((outcome: StreamingProbeOutcome) => void) | undefined;
    let attemptedStreaming = false;
    const observeStreamingCapability = (status: StreamingCapability): void => {
      if (completeStreamingProbe) {
        completeStreamingProbe(status);
        completeStreamingProbe = undefined;
      } else {
        rememberStreamingCapability(capabilityKey, status);
      }
    };
    const wireAliases = wireRequestAliases(request, onProgress);
    const wireRequest = wireAliases.request;

    try {
      const input = compactRequestInput(wireRequest);
      const protocol = configuredProtocol(this.config);
      const optionalCapabilities = optionalCapabilitiesFor(capabilityKey);
      const reasoningEffort =
        protocol === "anthropic-messages" ||
        optionalCapabilities.reasoningEffortSupported === false
          ? undefined
          : lowLatencyReasoningEffort(this.config.model);
      const wantsStream =
        request.mode === "ai" && request.responseMode !== "batch";
      const streamChoice = wantsStream
        ? await streamingDecision(capabilityKey, controller.signal)
        : { useStream: false };
      completeStreamingProbe = streamChoice.completeProbe;
      attemptedStreaming = streamChoice.useStream;
      if (controller.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      const systemPrompt = [
        request.prompt?.trim() || this.config.systemPrompt,
        protocol === "anthropic-messages"
          ? ANTHROPIC_JSON_PROTOCOL_PROMPT
          : JSON_PROTOCOL_PROMPT,
        COMPACT_CONTEXT_PROMPT,
        wireRequest.segments.some(
          (segment) => segment.format === "protected-text-v1",
        )
          ? PROTECTED_TEXT_PROMPT
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      const payload: Record<string, unknown> =
        protocol === "anthropic-messages"
          ? {
              model: this.config.model,
              max_tokens: 8_192,
              ...(attemptedStreaming ? { stream: true } : {}),
              ...(optionalCapabilities.anthropicOutputFormatSupported === false
                ? {}
                : { output_config: anthropicOutputFormat() }),
              system: systemPrompt,
              messages: [{ role: "user", content: JSON.stringify(input) }],
            }
          : {
              model: this.config.model,
              temperature: 0,
              ...(attemptedStreaming ? { stream: true } : {}),
              ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: JSON.stringify(input) },
              ],
            };

      let responseFormatMode: ResponseFormatMode =
        protocol === "anthropic-messages"
          ? "none"
          : (optionalCapabilities.responseFormatMode ?? "json-schema");
      const requestPayload: Record<string, unknown> = {
        ...payload,
        ...(responseFormatMode === "json-schema"
          ? {
              response_format: responseFormat(wireRequest.segments.length),
            }
          : responseFormatMode === "json-object"
            ? { response_format: jsonObjectResponseFormat() }
            : {}),
      };
      let response = await this.request(requestPayload, controller.signal);
      let errorBody = response.ok ? "" : await response.text();
      for (let fallback = 0; fallback < 5 && !response.ok; fallback += 1) {
        if (
          "response_format" in requestPayload &&
          rejectsOptionalParameter(
            { status: response.status, body: errorBody },
            "response_format",
          )
        ) {
          if (
            responseFormatMode === "json-schema" &&
            rejectionTargetsJsonSchema(errorBody)
          ) {
            requestPayload.response_format = jsonObjectResponseFormat();
            responseFormatMode = "json-object";
            optionalCapabilities.responseFormatMode = "json-object";
          } else {
            delete requestPayload.response_format;
            responseFormatMode = "none";
            optionalCapabilities.responseFormatMode = "none";
          }
        } else if (
          "output_config" in requestPayload &&
          rejectsOptionalParameter(
            { status: response.status, body: errorBody },
            "output_config",
          )
        ) {
          delete requestPayload.output_config;
          optionalCapabilities.anthropicOutputFormatSupported = false;
        } else if (
          "reasoning_effort" in requestPayload &&
          rejectsOptionalParameter(
            { status: response.status, body: errorBody },
            "reasoning_effort",
          )
        ) {
          delete requestPayload.reasoning_effort;
          optionalCapabilities.reasoningEffortSupported = false;
        } else if (
          "stream" in requestPayload &&
          rejectsOptionalParameter(
            { status: response.status, body: errorBody },
            "stream",
          )
        ) {
          observeStreamingCapability("unsupported");
          delete requestPayload.stream;
        } else {
          break;
        }
        response = await this.request(requestPayload, controller.signal);
        errorBody = response.ok ? "" : await response.text();
      }

      if (!response.ok) {
        throw new NTransError(
          runtimeErrorToken("request_failed"),
          "request_failed",
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
          `HTTP ${response.status}. Provider error body length: ${errorBody.length} characters.`,
        );
      }

      optionalCapabilities.responseFormatMode = responseFormatMode;
      if (
        protocol === "anthropic-messages" &&
        "output_config" in requestPayload
      ) {
        optionalCapabilities.anthropicOutputFormatSupported = true;
      }
      if (reasoningEffort && "reasoning_effort" in requestPayload) {
        optionalCapabilities.reasoningEffortSupported = true;
      }

      const isEventStream =
        requestPayload.stream === true &&
        response.headers
          .get("content-type")
          ?.toLowerCase()
          .includes("text/event-stream");
      if (isEventStream) {
        // The response headers are enough to prove that this endpoint accepts
        // streaming. Release the single-flight waiters now so the remaining
        // page batches can start in parallel instead of waiting for the first
        // completion body to finish.
        observeStreamingCapability("supported");
        let streamed:
          Awaited<ReturnType<typeof readStreamingContent>> | undefined;
        try {
          streamed = await readStreamingContent(
            response,
            wireRequest,
            protocol,
            wireAliases.restoreProgress,
          );
        } catch (error) {
          if (
            error instanceof PartialStreamingResponseError ||
            !(error instanceof NTransError) ||
            error.code !== "invalid_response"
          ) {
            throw error;
          }
          // The progressive parser can reject a malformed item before
          // readStreamingContent returns. It is still safe to retry once when
          // no result ID was emitted; partial responses are wrapped above and
          // never enter this branch.
          observeStreamingCapability("unsupported");
          delete requestPayload.stream;
          response = await this.request(requestPayload, controller.signal);
          if (!response.ok) {
            const fallbackErrorBody = await response.text();
            throw new NTransError(
              runtimeErrorToken("request_failed"),
              "request_failed",
              response.status === 408 ||
                response.status === 429 ||
                response.status >= 500,
              `The streamed completion was malformed before any result was emitted; the non-streaming fallback returned HTTP ${response.status}. Provider error body length: ${fallbackErrorBody.length} characters.`,
            );
          }
        }
        if (streamed && !streamed.content.trim()) {
          // Some OpenAI-compatible gateways accept `stream: true` but return
          // only metadata and [DONE]. No result has been surfaced, so one
          // non-streaming retry is safe and avoids duplicating translated IDs.
          observeStreamingCapability("unsupported");
          delete requestPayload.stream;
          response = await this.request(requestPayload, controller.signal);
          if (!response.ok) {
            const fallbackErrorBody = await response.text();
            throw new NTransError(
              runtimeErrorToken("request_failed"),
              "request_failed",
              response.status === 408 ||
                response.status === 429 ||
                response.status >= 500,
              `The streamed completion was empty; the non-streaming fallback returned HTTP ${response.status}. Provider error body length: ${fallbackErrorBody.length} characters.`,
            );
          }
        } else if (streamed) {
          try {
            const results = parseResults(
              streamed.content,
              wireRequest.segments,
            );
            return wireAliases.restoreResults(results);
          } catch (error) {
            // Once a streamed result has been surfaced and cached, retrying the
            // whole batch would pay for and regenerate already completed IDs.
            // Leave the remaining IDs failed so the caller can retry only them.
            if (streamed.emittedResults.length > 0) {
              throw new PartialStreamingResponseError(
                streamed.emittedResults,
                error instanceof NTransError && error.details
                  ? error.details
                  : `The streamed completion ended with incomplete JSON after ${streamed.emittedResults.length} result ${streamed.emittedResults.length === 1 ? "item was" : "items were"} emitted.`,
              );
            }
            // A non-empty but malformed stream is equivalent to an unsupported
            // streaming response when it has not surfaced any result ID. One
            // non-streaming retry is safe here because no translation has been
            // rendered or cached yet.
            observeStreamingCapability("unsupported");
            delete requestPayload.stream;
            response = await this.request(requestPayload, controller.signal);
            if (!response.ok) {
              const fallbackErrorBody = await response.text();
              throw new NTransError(
                runtimeErrorToken("request_failed"),
                "request_failed",
                response.status === 408 ||
                  response.status === 429 ||
                  response.status >= 500,
                `The streamed completion was malformed before any result was emitted; the non-streaming fallback returned HTTP ${response.status}. Provider error body length: ${fallbackErrorBody.length} characters.`,
              );
            }
          }
        }
      }

      if (attemptedStreaming && requestPayload.stream === true) {
        // A compatible endpoint may silently ignore `stream: true` and return
        // a regular JSON completion. Treat that as a stable non-streaming
        // capability so later batches do not repeat the same probe.
        observeStreamingCapability("unsupported");
      }

      let data: ChatCompletionResponse;
      let responseText = "";
      try {
        responseText = await response.text();
        data = JSON.parse(responseText) as ChatCompletionResponse;
      } catch {
        throw invalidResponse(
          `Provider response is not valid JSON. Response length: ${responseText.length} characters.`,
        );
      }
      const responseMessage = data.choices?.[0]?.message;
      if (protocol === "anthropic-messages") {
        if (data.type !== "message") {
          throw invalidResponse(
            `Anthropic response type must be message. Received: ${diagnosticId(data.type ?? "missing")}.`,
          );
        }
        if (data.stop_reason === "refusal") {
          throw new NTransError(
            runtimeErrorToken("request_failed"),
            "request_failed",
            false,
            "The Anthropic response stopped with refusal.",
          );
        }
        if (
          data.stop_reason !== "end_turn" &&
          data.stop_reason !== "stop_sequence"
        ) {
          throw invalidResponse(
            `The Anthropic response stopped with ${diagnosticId(data.stop_reason ?? "missing")}.`,
          );
        }
      }
      const content =
        protocol === "anthropic-messages"
          ? data.content
          : (responseMessage?.parsed ??
            responseMessage?.content ??
            responseMessage?.tool_calls?.[0]?.function?.arguments);
      if (
        content === undefined ||
        content === null ||
        isEmptyCompletionContent(content)
      ) {
        throw new NonSplittableInvalidResponseError(
          `Completion content is empty. Response keys: ${diagnosticKeys(data as Record<string, unknown>)}`,
        );
      }
      return wireAliases.restoreResults(
        parseResults(content, wireRequest.segments),
      );
    } catch (error) {
      if (error instanceof PartialStreamingResponseError) {
        if (attemptedStreaming) observeStreamingCapability("supported");
        throw new PartialStreamingResponseError(
          wireAliases.restoreResults(error.partialResults),
          error.details,
          error.allowRecovery,
          error.terminalError,
        );
      }
      if (signal.aborted) {
        throw new NTransError(
          runtimeErrorToken("cancelled"),
          "cancelled",
          true,
        );
      }
      if (timedOut) {
        throw new NTransError(
          runtimeErrorToken("request_failed"),
          "request_failed",
          true,
        );
      }
      if (controller.signal.aborted) {
        throw new NTransError(
          runtimeErrorToken("cancelled"),
          "cancelled",
          true,
        );
      }
      if (error instanceof NTransError) throw error;
      throw new NTransError(
        runtimeErrorToken("request_failed"),
        "request_failed",
        true,
      );
    } finally {
      completeStreamingProbe?.("unknown");
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
    }
  }

  private async request(body: object, signal: AbortSignal): Promise<Response> {
    const protocol = configuredProtocol(this.config);
    return fetch(endpoint(this.config.baseUrl, protocol), {
      method: "POST",
      headers:
        protocol === "anthropic-messages"
          ? {
              "x-api-key": this.config.apiKey,
              "anthropic-version": "2023-06-01",
              "anthropic-dangerous-direct-browser-access": "true",
              "Content-Type": "application/json",
            }
          : {
              Authorization: `Bearer ${this.config.apiKey}`,
              "Content-Type": "application/json",
            },
      body: JSON.stringify(body),
      signal,
    });
  }
}
