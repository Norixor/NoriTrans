import {
  authorizedNorixorFetch,
  NorixorSessionError,
} from "@/src/norixor/session";
import { NoriTransError } from "@/src/shared/errors";
import {
  PROTECTED_TEXT_FORMAT,
  protectedTextParts,
  rebuildProtectedTranslation,
} from "@/src/translation/protected-text";
import type {
  TranslationProgressCallback,
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
  TranslationSegment,
} from "@/src/translation/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedContextValues(values: string[] | undefined): string[] {
  if (!values) return [];
  const bounded: string[] = [];
  for (const value of values) {
    const normalized = value.trim().slice(0, 2_000);
    if (normalized) bounded.push(normalized);
  }
  return bounded;
}

function wireLanguage(code: string): string {
  const normalized = code.trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "zh-hant") return "zh-tw";
  if (normalized === "zh-hans") return "zh-cn";
  return normalized;
}

function requestCharacters(segment: TranslationSegment): number {
  return (
    segment.text.length +
    boundedContextValues(segment.contextBefore).reduce(
      (total, value) => total + value.length,
      0,
    ) +
    boundedContextValues(segment.contextAfter).reduce(
      (total, value) => total + value.length,
      0,
    )
  );
}

function createWireBatches(
  segments: readonly TranslationSegment[],
  maxSegments: number,
  maxCharacters: number,
): TranslationSegment[][] {
  const batches: TranslationSegment[][] = [];
  let batch: TranslationSegment[] = [];
  let characters = 0;
  for (const segment of segments) {
    const nextCharacters = requestCharacters(segment);
    if (
      batch.length > 0 &&
      (batch.length >= maxSegments ||
        characters + nextCharacters > maxCharacters)
    ) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }
    batch.push(segment);
    characters += nextCharacters;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function parseResults(
  payload: unknown,
  wireToOriginal: ReadonlyMap<string, string>,
): TranslationResult[] {
  const data =
    isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
  const raw = data?.results;
  if (!Array.isArray(raw)) {
    throw new NoriTransError(
      "Norixor translation response is invalid.",
      "invalid_response",
      false,
      "Expected data.results array.",
    );
  }
  const seen = new Set<string>();
  const results: TranslationResult[] = [];
  for (const candidate of raw) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      !wireToOriginal.has(candidate.id) ||
      seen.has(candidate.id) ||
      typeof candidate.translated_text !== "string" ||
      candidate.translated_text.trim().length === 0 ||
      candidate.translated_text.length > 100_000
    ) {
      throw new NoriTransError(
        "Norixor translation response is incomplete.",
        "invalid_response",
        false,
        "Response contains an unknown, duplicate, or invalid result.",
      );
    }
    seen.add(candidate.id);
    results.push({
      id: wireToOriginal.get(candidate.id)!,
      translatedText: candidate.translated_text,
    });
  }
  if (seen.size !== wireToOriginal.size) {
    throw new NoriTransError(
      "Norixor translation response is incomplete.",
      "invalid_response",
      false,
      `Expected ${wireToOriginal.size} results; received ${seen.size}.`,
    );
  }
  return results;
}

async function responseError(response: Response): Promise<NoriTransError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  const envelope =
    isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
  const stableCode =
    typeof envelope?.code === "string" &&
    /^[a-z][a-z0-9_]{2,79}$/u.test(envelope.code)
      ? envelope.code
      : undefined;
  const publicMessage =
    typeof envelope?.message === "string"
      ? envelope.message.replace(/\s+/gu, " ").trim().slice(0, 240)
      : undefined;
  const invalidResult = stableCode === "noritrans_translation_invalid_response";
  const message =
    response.status === 401
      ? "Sign in to Norixor again."
      : invalidResult
        ? "Norixor returned an invalid translation result."
        : stableCode === "noritrans_translation_model_unavailable"
          ? "The selected Norixor translation model is unavailable."
          : stableCode === "noritrans_translation_quota_exceeded"
            ? "Norixor translation balance or quota is unavailable."
            : stableCode === "noritrans_translation_policy_rejected"
              ? "Norixor rejected this translation batch."
              : response.status === 400
                ? "Norixor rejected an invalid translation batch."
                : "Norixor translation request failed.";
  return new NoriTransError(
    message,
    response.status === 401
      ? "invalid_configuration"
      : invalidResult
        ? "invalid_response"
        : "request_failed",
    // A completed upstream generation may already be billable. Keep retries
    // explicit when its result fails validation instead of resending the batch.
    !invalidResult && (response.status === 429 || response.status >= 500),
    [
      `HTTP ${response.status}`,
      stableCode ? `code=${stableCode}` : undefined,
      publicMessage ? `message=${publicMessage}` : undefined,
    ]
      .filter(Boolean)
      .join("; "),
  );
}

export class NorixorTranslationProvider implements TranslationProvider {
  readonly id = "norixor";
  readonly mode = "ai" as const;
  readonly capabilities = {
    maxBatchCharacters: 50_000,
    maxBatchSegments: 50,
    supportsContext: true,
    runtime: "background" as const,
  };

  constructor(private readonly model: string) {}

  async translateBatch(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    if (
      request.segments.some(
        (segment) => segment.format === PROTECTED_TEXT_FORMAT,
      )
    ) {
      return this.translateProtectedBatch(request, signal, onProgress);
    }
    return this.translateWireBatch(request, signal, onProgress);
  }

  private async translateProtectedBatch(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    const states = request.segments.map((segment, segmentIndex) => {
      const sourceParts =
        segment.format === PROTECTED_TEXT_FORMAT
          ? protectedTextParts(segment.text)
          : [segment.text];
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

    for (const batch of createWireBatches(
      partSegments,
      this.capabilities.maxBatchSegments,
      this.capabilities.maxBatchCharacters,
    )) {
      const translated = await this.translateWireBatch(
        { ...request, responseMode: "batch", segments: batch },
        signal,
      );
      for (const result of translated) {
        const location = partLocations.get(result.id);
        const state =
          location === undefined ? undefined : states[location.segmentIndex];
        if (!location || !state) {
          throw new NoriTransError(
            "Norixor translation response is incomplete.",
            "invalid_response",
            false,
            "Protected-part translation returned an unknown result ID.",
          );
        }
        state.translatedParts[location.partIndex] = result.translatedText;
      }
    }

    const results = states.map(({ segment, translatedParts }) => ({
      id: segment.id,
      translatedText:
        segment.format === PROTECTED_TEXT_FORMAT
          ? rebuildProtectedTranslation(segment.text, translatedParts)
          : translatedParts[0]!,
    }));
    for (const result of results) await onProgress?.(result);
    return results;
  }

  private async translateWireBatch(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    if (signal.aborted) {
      throw new NoriTransError("Translation cancelled.", "cancelled");
    }
    const wireToOriginal = new Map<string, string>();
    const textCatalog: Record<string, string> = {};
    const textIdByValue = new Map<string, string>();
    const textId = (value: string): string => {
      let id = textIdByValue.get(value);
      if (!id) {
        id = `t:${textIdByValue.size}`;
        textIdByValue.set(value, id);
        textCatalog[id] = value;
      }
      return id;
    };
    for (const segment of request.segments) textId(segment.text);
    const contextIds = (
      values: string[] | undefined,
      mainTextId: string,
    ): string[] => {
      const ids: string[] = [];
      for (const value of boundedContextValues(values)) {
        const id = textId(value);
        if (id === mainTextId) continue;
        if (!ids.includes(id)) ids.push(id);
        if (ids.length === 2) break;
      }
      return ids;
    };
    const segments = request.segments.map((segment, index) => {
      const id = `s:${index}`;
      wireToOriginal.set(id, segment.id);
      const mainTextId = textId(segment.text);
      const contextBeforeIds = contextIds(segment.contextBefore, mainTextId);
      const contextAfterIds = contextIds(segment.contextAfter, mainTextId);
      return {
        id,
        text_id: mainTextId,
        ...(contextBeforeIds.length > 0
          ? { context_before_ids: contextBeforeIds }
          : {}),
        ...(contextAfterIds.length > 0
          ? { context_after_ids: contextAfterIds }
          : {}),
      };
    });
    let response: Response;
    try {
      response = await authorizedNorixorFetch("/native/translations", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          source_language: wireLanguage(request.sourceLanguage),
          target_language: wireLanguage(request.targetLanguage),
          ...(this.model ? { model: this.model } : {}),
          text_catalog: textCatalog,
          segments,
          ...(request.mediaTitle?.trim()
            ? { media_title: request.mediaTitle.trim().slice(0, 500) }
            : {}),
        }),
        cache: "no-store",
        signal,
      });
    } catch (error) {
      const errorType =
        isRecord(error) && typeof error.name === "string"
          ? error.name.slice(0, 80)
          : typeof error;
      if (signal.aborted || errorType === "AbortError") {
        throw new NoriTransError("Translation cancelled.", "cancelled");
      }
      if (error instanceof NorixorSessionError) {
        throw new NoriTransError(
          error.code === "signed_out"
            ? "Sign in to Norixor first."
            : "Norixor session is unavailable.",
          error.code === "signed_out"
            ? "invalid_configuration"
            : "request_failed",
          error.code === "temporarily_unavailable",
        );
      }
      throw new NoriTransError(
        "Norixor translation service could not be reached.",
        "request_failed",
        true,
        `The request failed before an HTTP response (${errorType}).`,
      );
    }
    if (!response.ok) {
      throw await responseError(response);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new NoriTransError(
        "Norixor translation response is invalid.",
        "invalid_response",
        false,
        "Response was not valid JSON.",
      );
    }
    const results = parseResults(payload, wireToOriginal);
    for (const result of results) await onProgress?.(result);
    return results;
  }
}
