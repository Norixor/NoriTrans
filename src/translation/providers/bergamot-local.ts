import { BergamotOffscreenClient } from "@/src/local-translation/client";
import { BergamotRuntimeError } from "@/src/local-translation/errors";
import {
  normalizeBergamotLanguage,
  type BergamotLanguage,
} from "@/src/local-translation/types";
import { NTransError } from "@/src/shared/errors";
import { runtimeErrorToken } from "@/src/shared/runtime-errors";
import { detectDominantSourceLanguage } from "@/src/translation/language-detection";
import {
  protectedTextParts,
  rebuildProtectedTranslation,
} from "@/src/translation/protected-text";
import type {
  ProviderCapabilities,
  TranslationProgressCallback,
  TranslationProvider,
  TranslationRequest,
  TranslationResult,
  TranslationSegment,
} from "@/src/translation/types";

interface BergamotTranslationClient {
  translate(
    sourceLanguage: BergamotLanguage,
    targetLanguage: BergamotLanguage,
    segments: Array<{ id: string; text: string }>,
    signal: AbortSignal,
  ): Promise<Array<{ id: string; translatedText: string }>>;
}

interface PreparedSegment {
  segment: TranslationSegment;
  parts: string[];
}

interface PreparedPart {
  id: string;
  segmentIndex: number;
  partIndex: number;
  text: string;
}

const MAX_OFFSCREEN_SEGMENTS = 20;
const MAX_OFFSCREEN_CHARACTERS = 16_000;
const TRANSLATABLE_LETTER_PATTERN = /\p{L}/u;

function containsTranslatableText(text: string): boolean {
  return TRANSLATABLE_LETTER_PATTERN.test(text.normalize("NFKC"));
}

function prepareSegments(segments: TranslationSegment[]): {
  segments: PreparedSegment[];
  parts: PreparedPart[];
} {
  const prepared = segments.map((segment) => ({
    segment,
    parts:
      segment.format === "protected-text-v1"
        ? protectedTextParts(segment.text)
        : [segment.text],
  }));
  const parts = prepared.flatMap((item, segmentIndex) =>
    item.parts.flatMap((text, partIndex) =>
      containsTranslatableText(text)
        ? [
            {
              id: `bergamot-part-${segmentIndex.toString(36)}-${partIndex.toString(36)}`,
              segmentIndex,
              partIndex,
              text,
            },
          ]
        : [],
    ),
  );
  return { segments: prepared, parts };
}

function createPartGroups(parts: readonly PreparedPart[]): PreparedPart[][] {
  const groups: PreparedPart[][] = [];
  let group: PreparedPart[] = [];
  let characters = 0;
  for (const part of parts) {
    const overflows =
      group.length > 0 &&
      (group.length >= MAX_OFFSCREEN_SEGMENTS ||
        characters + part.text.length > MAX_OFFSCREEN_CHARACTERS);
    if (overflows) {
      groups.push(group);
      group = [];
      characters = 0;
    }
    group.push(part);
    characters += part.text.length;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function providerError(error: unknown): NTransError {
  if (error instanceof NTransError) return error;
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return new NTransError(runtimeErrorToken("cancelled"), "cancelled", true);
  }
  if (error instanceof BergamotRuntimeError) {
    const missingOrUnsupported =
      error.code === "bergamot_package_missing" ||
      error.code === "bergamot_unsupported_language";
    return new NTransError(
      runtimeErrorToken(
        missingOrUnsupported ? "provider_unavailable" : "request_failed",
      ),
      missingOrUnsupported ? "provider_unavailable" : "request_failed",
      error.retryable,
      `Provider=bergamot-local; ${error.details ?? `failure=${error.code}`}`.slice(
        0,
        1_000,
      ),
      missingOrUnsupported ? error.code : undefined,
    );
  }
  return new NTransError(
    runtimeErrorToken("request_failed"),
    "request_failed",
    true,
    `Provider=bergamot-local; failure=${error instanceof Error ? error.name : "unknown"}.`,
  );
}

export interface BergamotLocalProviderOptions {
  client?: BergamotTranslationClient;
  fallbackSourceLanguage?: string;
  onSourceLanguageResolved?: (
    sourceLanguage: string,
    request: TranslationRequest,
  ) => void;
}

export class BergamotLocalProvider implements TranslationProvider {
  readonly id = "bergamot-local";
  readonly mode = "fast" as const;
  readonly capabilities: ProviderCapabilities = {
    maxBatchCharacters: 12_000,
    maxBatchSegments: 12,
    supportsContext: false,
    runtime: "background",
  };
  private readonly client: BergamotTranslationClient;

  constructor(private readonly options: BergamotLocalProviderOptions = {}) {
    this.client = options.client ?? new BergamotOffscreenClient();
  }

  async translateBatch(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    try {
      const sourceLanguage = await this.resolveSourceLanguage(request, signal);
      const targetLanguage = normalizeBergamotLanguage(request.targetLanguage);
      if (!targetLanguage) {
        throw new BergamotRuntimeError(
          "bergamot_unsupported_language",
          "Bergamot does not support the requested target language.",
          false,
          `Target language=${request.targetLanguage.slice(0, 32)}.`,
        );
      }
      this.options.onSourceLanguageResolved?.(sourceLanguage, request);
      const prepared = prepareSegments(request.segments);
      const translatedById = new Map<string, string>();
      const remainingParts = prepared.segments.map(
        (_, segmentIndex) =>
          prepared.parts.filter((part) => part.segmentIndex === segmentIndex)
            .length,
      );
      const reportedSegments = new Set<number>();
      for (const group of createPartGroups(prepared.parts)) {
        if (signal.aborted) {
          throw new DOMException("Translation cancelled", "AbortError");
        }
        const translated = await this.client.translate(
          sourceLanguage,
          targetLanguage,
          group.map(({ id, text }) => ({ id, text })),
          signal,
        );
        const expectedIds = new Set(group.map((part) => part.id));
        if (
          translated.length !== group.length ||
          translated.some(
            (result) =>
              !expectedIds.has(result.id) ||
              translatedById.has(result.id) ||
              !result.translatedText.trim(),
          )
        ) {
          throw new NTransError(
            runtimeErrorToken("invalid_response"),
            "invalid_response",
            true,
            `Provider=bergamot-local; expected parts=${group.length}; received parts=${translated.length}.`,
          );
        }
        for (const result of translated) {
          translatedById.set(result.id, result.translatedText);
          const part = group.find((candidate) => candidate.id === result.id);
          if (!part) continue;
          const target = prepared.segments[part.segmentIndex];
          if (target) target.parts[part.partIndex] = result.translatedText;
          remainingParts[part.segmentIndex] = Math.max(
            0,
            (remainingParts[part.segmentIndex] ?? 0) - 1,
          );
        }
        for (const segmentIndex of new Set(
          group.map((part) => part.segmentIndex),
        )) {
          if (
            remainingParts[segmentIndex] !== 0 ||
            reportedSegments.has(segmentIndex)
          ) {
            continue;
          }
          const ready = prepared.segments[segmentIndex];
          if (!ready) continue;
          reportedSegments.add(segmentIndex);
          await onProgress?.({
            id: ready.segment.id,
            translatedText:
              ready.segment.format === "protected-text-v1"
                ? rebuildProtectedTranslation(ready.segment.text, ready.parts)
                : (ready.parts[0] ?? ""),
          });
        }
      }
      for (const part of prepared.parts) {
        const translatedText = translatedById.get(part.id);
        if (!translatedText) {
          throw new NTransError(
            runtimeErrorToken("invalid_response"),
            "invalid_response",
            true,
            `Provider=bergamot-local; missing translated part count=1.`,
          );
        }
        const target = prepared.segments[part.segmentIndex];
        if (target) target.parts[part.partIndex] = translatedText;
      }
      const results = prepared.segments.map(({ segment, parts }) => ({
        id: segment.id,
        translatedText:
          segment.format === "protected-text-v1"
            ? rebuildProtectedTranslation(segment.text, parts)
            : (parts[0] ?? ""),
      }));
      for (const [index, result] of results.entries()) {
        if (!reportedSegments.has(index)) await onProgress?.(result);
      }
      return results;
    } catch (error) {
      throw providerError(error);
    }
  }

  private async resolveSourceLanguage(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<BergamotLanguage> {
    if (request.sourceLanguage !== "auto") {
      const normalized = normalizeBergamotLanguage(request.sourceLanguage);
      if (normalized) return normalized;
      throw new BergamotRuntimeError(
        "bergamot_unsupported_language",
        "Bergamot does not support the requested source language.",
        false,
        `Source language=${request.sourceLanguage.slice(0, 32)}.`,
      );
    }
    const sample = request.segments.flatMap((segment) =>
      segment.format === "protected-text-v1"
        ? protectedTextParts(segment.text)
        : [segment.text],
    );
    const detected = await detectDominantSourceLanguage(
      sample,
      this.options.fallbackSourceLanguage,
    );
    if (signal.aborted) {
      throw new DOMException("Translation cancelled", "AbortError");
    }
    const normalized = detected
      ? normalizeBergamotLanguage(detected)
      : undefined;
    if (normalized) return normalized;
    throw new BergamotRuntimeError(
      "bergamot_unsupported_language",
      "Bergamot could not detect a supported source language.",
      false,
      "Source language=auto.",
    );
  }
}
