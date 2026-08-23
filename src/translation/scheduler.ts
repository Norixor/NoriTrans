import { NorixorTransError } from "@/src/shared/errors";
import { assertValidProtectedTranslation } from "@/src/translation/protected-text";
import type {
  TranslationProvider,
  TranslationProgressCallback,
  TranslationRequest,
  TranslationResult,
  TranslationSegment,
} from "@/src/translation/types";

interface NormalizedSegmentGroup {
  providerSegment: TranslationSegment;
  originalSegments: TranslationSegment[];
}

function diagnosticIds(values: Iterable<string>): string {
  const ids = [...values];
  const shown = ids.slice(0, 20).map((id) => id.slice(0, 120));
  return `${shown.join(", ")}${ids.length > shown.length ? `, ... (${ids.length} total)` : ""}`;
}

/** Normalizes only Unicode composition and insignificant whitespace. */
export function normalizeTranslationText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function normalizeContext(values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const normalized = values
    .map(normalizeTranslationText)
    .filter((value, index, all) => value && all.indexOf(value) === index);
  return normalized.length > 0 ? normalized : undefined;
}

function validateRequestSegments(segments: TranslationSegment[]): void {
  const ids = new Set<string>();
  for (const segment of segments) {
    if (
      !segment.id ||
      ids.has(segment.id) ||
      !normalizeTranslationText(segment.text) ||
      (segment.format !== undefined &&
        segment.format !== "plain-text-v1" &&
        segment.format !== "protected-text-v1")
    ) {
      throw new NorixorTransError(
        "翻译请求包含空白文本、空白 ID 或重复 ID。",
        "invalid_response",
      );
    }
    assertValidProtectedTranslation(segment, segment.text);
    ids.add(segment.id);
  }
}

function groupNormalizedSegments(
  segments: TranslationSegment[],
): NormalizedSegmentGroup[] {
  const groups: NormalizedSegmentGroup[] = [];
  const byText = new Map<string, NormalizedSegmentGroup>();
  for (const segment of segments) {
    const normalizedText = normalizeTranslationText(segment.text);
    const format = segment.format ?? "plain-text-v1";
    const identity = JSON.stringify({ format, text: normalizedText });
    const existing = byText.get(identity);
    if (existing) {
      existing.originalSegments.push(segment);
      continue;
    }
    const contextBefore = normalizeContext(segment.contextBefore);
    const contextAfter = normalizeContext(segment.contextAfter);
    const providerSegment: TranslationSegment = {
      id: segment.id,
      text: normalizedText,
      ...(segment.format ? { format: segment.format } : {}),
      ...(contextBefore ? { contextBefore } : {}),
      ...(contextAfter ? { contextAfter } : {}),
    };
    const group = { providerSegment, originalSegments: [segment] };
    groups.push(group);
    byText.set(identity, group);
  }
  return groups;
}

function validateResults(
  segments: TranslationSegment[],
  results: TranslationResult[],
): void {
  const expected = new Set(segments.map((segment) => segment.id));
  if (
    expected.size !== segments.length ||
    segments.some((segment) => !segment.id)
  ) {
    throw new NorixorTransError(
      "翻译请求包含空白或重复的段落 ID。",
      "invalid_response",
      false,
      "The translation request contains a blank or duplicate segment ID.",
    );
  }
  const received = new Set<string>();

  for (const result of results) {
    if (!expected.has(result.id) || received.has(result.id)) {
      throw new NorixorTransError(
        "翻译服务返回了未知或重复的段落 ID。",
        "invalid_response",
        false,
        `${expected.has(result.id) ? "Duplicate" : "Unknown"} result ID: ${result.id.slice(0, 120)}. Expected IDs: ${diagnosticIds(expected)}.`,
      );
    }
    if (
      typeof result.translatedText !== "string" ||
      !result.translatedText.trim()
    ) {
      throw new NorixorTransError(
        "翻译服务返回了无效译文。",
        "invalid_response",
        false,
        `Result ID ${result.id.slice(0, 120)} has an empty translation.`,
      );
    }
    const segment = segments.find((candidate) => candidate.id === result.id);
    if (!segment) {
      throw new NorixorTransError(
        "翻译服务返回了未知的段落 ID。",
        "invalid_response",
      );
    }
    assertValidProtectedTranslation(segment, result.translatedText);
    received.add(result.id);
  }

  if (received.size !== expected.size) {
    const missing = [...expected].filter((id) => !received.has(id));
    throw new NorixorTransError(
      "翻译服务没有返回全部段落。",
      "invalid_response",
      true,
      `Missing result IDs: ${diagnosticIds(missing)}. Received ${received.size} of ${expected.size}.`,
    );
  }
}

function createBatches(
  request: TranslationRequest,
  maxSegments: number,
  maxCharacters: number,
): TranslationSegment[][] {
  const batches: TranslationSegment[][] = [];
  let batch: TranslationSegment[] = [];
  let characters = 0;

  const characterCount = (segment: TranslationSegment): number =>
    segment.text.length +
    (segment.contextBefore ?? []).reduce(
      (total, context) => total + context.length,
      0,
    ) +
    (segment.contextAfter ?? []).reduce(
      (total, context) => total + context.length,
      0,
    );

  for (const segment of request.segments) {
    const segmentCharacters = characterCount(segment);
    if (segmentCharacters > maxCharacters) {
      throw new NorixorTransError(
        "待翻译段落超过当前翻译服务的单批字符限制。",
        "request_failed",
      );
    }
    const wouldOverflow =
      batch.length > 0 &&
      (batch.length >= maxSegments ||
        characters + segmentCharacters > maxCharacters);

    if (wouldOverflow) {
      batches.push(batch);
      batch = [];
      characters = 0;
    }

    batch.push(segment);
    characters += segmentCharacters;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

export async function scheduleTranslation(
  provider: TranslationProvider,
  request: TranslationRequest,
  signal: AbortSignal,
  onProgress?: TranslationProgressCallback,
): Promise<TranslationResult[]> {
  if (request.segments.length === 0) return [];
  validateRequestSegments(request.segments);

  const groups = groupNormalizedSegments(request.segments);
  const groupByProviderId = new Map(
    groups.map((group) => [group.providerSegment.id, group]),
  );

  const batches = createBatches(
    { ...request, segments: groups.map((group) => group.providerSegment) },
    provider.capabilities.maxBatchSegments,
    provider.capabilities.maxBatchCharacters,
  );
  const outputById = new Map<string, TranslationResult>();

  for (const segments of batches) {
    if (signal.aborted) {
      throw new DOMException("Translation cancelled", "AbortError");
    }
    const expectedIds = new Set(segments.map((segment) => segment.id));
    const receivedProgress = new Set<string>();
    const receiveProgress = async (
      result: TranslationResult,
    ): Promise<void> => {
      if (
        !expectedIds.has(result.id) ||
        receivedProgress.has(result.id) ||
        typeof result.translatedText !== "string" ||
        !result.translatedText.trim()
      ) {
        throw new NorixorTransError(
          "翻译服务返回了未知、重复或无效的增量结果。",
          "invalid_response",
          false,
          `${expectedIds.has(result.id) ? (receivedProgress.has(result.id) ? "Duplicate progress ID" : "Empty progress translation for ID") : "Unknown progress ID"}: ${result.id.slice(0, 120)}.`,
        );
      }
      const segment = segments.find((candidate) => candidate.id === result.id);
      if (!segment) {
        throw new NorixorTransError(
          "翻译服务返回了未知的增量段落 ID。",
          "invalid_response",
        );
      }
      // Validate protected markers before the result can reach UI progress or
      // the translation cache.
      assertValidProtectedTranslation(segment, result.translatedText);
      receivedProgress.add(result.id);
      const group = groupByProviderId.get(result.id);
      if (!group) {
        throw new NorixorTransError(
          "翻译服务返回了未知的归一化段落 ID。",
          "invalid_response",
        );
      }
      for (const original of group.originalSegments) {
        const expanded = {
          id: original.id,
          translatedText: result.translatedText,
        };
        outputById.set(original.id, expanded);
        await onProgress?.(expanded);
      }
    };
    const results = await provider.translateBatch(
      { ...request, segments },
      signal,
      onProgress ? receiveProgress : undefined,
    );
    validateResults(segments, results);
    if (onProgress) {
      for (const result of results) {
        if (!receivedProgress.has(result.id)) await receiveProgress(result);
      }
    } else {
      for (const result of results) {
        const group = groupByProviderId.get(result.id);
        if (!group) continue;
        for (const original of group.originalSegments) {
          outputById.set(original.id, {
            id: original.id,
            translatedText: result.translatedText,
          });
        }
      }
    }
  }

  return request.segments.map((segment) => {
    const result = outputById.get(segment.id);
    if (!result) {
      throw new NorixorTransError(
        "翻译服务没有返回全部归一化段落。",
        "invalid_response",
        true,
        `Missing normalized result ID: ${segment.id.slice(0, 120)}.`,
      );
    }
    return result;
  });
}
