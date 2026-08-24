import { NorixorTransError } from "@/src/shared/errors";
import { runtimeErrorToken } from "@/src/shared/runtime-errors";
import type { DeepLPlan, FastProviderId } from "@/src/shared/settings";
import {
  protectedTextParts,
  rebuildProtectedTranslation,
} from "@/src/translation/protected-text";
import type {
  ProviderCapabilities,
  TranslationProvider,
  TranslationProgressCallback,
  TranslationRequest,
  TranslationResult,
  TranslationSegment,
} from "@/src/translation/types";

export type CloudMachineProviderId = Exclude<
  FastProviderId,
  "chrome-local" | "openai-compatible"
>;

export interface CloudMachineProviderConfig {
  apiKey: string;
  timeoutMs: number;
  microsoftRegion?: string;
  deeplPlan?: DeepLPlan;
}

interface PreparedPart {
  segmentIndex: number;
  partIndex: number;
  text: string;
}

interface PreparedSegment {
  segment: TranslationSegment;
  parts: string[];
}

function prepareSegments(segments: TranslationSegment[]): {
  segments: PreparedSegment[];
  translatableParts: PreparedPart[];
} {
  const preparedSegments = segments.map((segment) => ({
    segment,
    parts:
      segment.format === "protected-text-v1"
        ? protectedTextParts(segment.text)
        : [segment.text],
  }));
  const translatableParts = preparedSegments.flatMap((prepared, segmentIndex) =>
    prepared.parts.flatMap((text, partIndex) =>
      text.trim() ? [{ segmentIndex, partIndex, text }] : [],
    ),
  );
  return { segments: preparedSegments, translatableParts };
}

function timeoutSignal(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  const timer = globalThis.setTimeout(
    () =>
      controller.abort(new DOMException("Request timed out", "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      globalThis.clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

export function isProviderRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function decodeProviderHtml(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (_, decimal: string) =>
      String.fromCodePoint(Number(decimal)),
    )
    .replace(/&#x([0-9a-f]+);/giu, (_, hexadecimal: string) =>
      String.fromCodePoint(Number.parseInt(hexadecimal, 16)),
    )
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");
}

export abstract class CloudMachineTranslationProvider implements TranslationProvider {
  readonly mode = "fast" as const;
  abstract readonly id: CloudMachineProviderId;
  abstract readonly capabilities: ProviderCapabilities;

  constructor(protected readonly config: CloudMachineProviderConfig) {}

  async translateBatch(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    const apiKey = this.config.apiKey.trim();
    if (!apiKey) {
      throw new NorixorTransError(
        runtimeErrorToken("invalid_configuration"),
        "invalid_configuration",
        false,
        `Provider=${this.id}; missing required API key.`,
      );
    }
    const prepared = prepareSegments(request.segments);
    const inputParts = prepared.translatableParts.map((part) => part.text);
    const translatedParts: string[] = [];
    for (
      let start = 0;
      start < inputParts.length;
      start += this.capabilities.maxBatchSegments
    ) {
      translatedParts.push(
        ...(await this.requestTranslations(
          inputParts.slice(start, start + this.capabilities.maxBatchSegments),
          request.sourceLanguage,
          request.targetLanguage,
          apiKey,
          signal,
        )),
      );
    }
    if (translatedParts.length !== prepared.translatableParts.length) {
      throw this.structuralError(
        prepared.translatableParts.length,
        translatedParts.length,
      );
    }
    for (const [index, translatedText] of translatedParts.entries()) {
      const part = prepared.translatableParts[index];
      if (!part || !translatedText.trim()) {
        throw this.structuralError(
          prepared.translatableParts.length,
          translatedParts.filter((value) => value.trim()).length,
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
    for (const result of results) await onProgress?.(result);
    return results;
  }

  protected async fetchJson(
    input: string | URL,
    init: RequestInit,
    parentSignal: AbortSignal,
  ): Promise<unknown> {
    const requestSignal = timeoutSignal(parentSignal, this.config.timeoutMs);
    try {
      const response = await fetch(input, {
        ...init,
        signal: requestSignal.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const retryable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        throw new NorixorTransError(
          runtimeErrorToken(
            response.status === 401 || response.status === 403
              ? "invalid_configuration"
              : "request_failed",
          ),
          response.status === 401 || response.status === 403
            ? "invalid_configuration"
            : "request_failed",
          retryable,
          `Provider=${this.id}; HTTP status=${response.status}; response characters=${text.length}.`,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw this.structuralError(1, 0);
      }
    } catch (error) {
      if (error instanceof NorixorTransError) throw error;
      if (parentSignal.aborted) throw new DOMException("Aborted", "AbortError");
      throw new NorixorTransError(
        runtimeErrorToken("provider_unavailable"),
        "provider_unavailable",
        true,
        `Provider=${this.id}; failure=${error instanceof Error ? error.name : "unknown"}.`,
      );
    } finally {
      requestSignal.dispose();
    }
  }

  protected structuralError(
    expected: number,
    received: number,
  ): NorixorTransError {
    return new NorixorTransError(
      runtimeErrorToken("invalid_response"),
      "invalid_response",
      true,
      `Provider=${this.id}; expected translations=${expected}; received=${received}.`,
    );
  }

  protected abstract requestTranslations(
    texts: string[],
    sourceLanguage: string,
    targetLanguage: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string[]>;
}
