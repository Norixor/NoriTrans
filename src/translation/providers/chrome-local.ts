import { NTransError } from "@/src/shared/errors";
import {
  translationDiagnostic,
  translationRuntimeDiagnosticContext,
} from "@/src/shared/diagnostics";
import {
  detectDominantSourceLanguage,
  dominantScriptSourceLanguageHint,
} from "@/src/translation/language-detection";
import {
  assertValidProtectedTranslation,
  protectedTextParts,
  rebuildProtectedTranslation,
} from "@/src/translation/protected-text";
import type {
  ProviderCapabilities,
  TranslationProvider,
  TranslationProgressCallback,
  TranslationRequest,
  TranslationResult,
} from "@/src/translation/types";

interface ChromeTranslatorInstance {
  translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

export type ChromeTranslatorAvailability =
  "unavailable" | "downloadable" | "downloading" | "available";

export interface ChromeTranslatorFactory {
  availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<ChromeTranslatorAvailability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    signal?: AbortSignal;
    monitor?(monitor: EventTarget): void;
  }): Promise<ChromeTranslatorInstance>;
}

export interface ChromeLocalProviderOptions {
  /** Avoids starting a model download for opportunistic low-latency fallback. */
  requireAvailable?: boolean;
  /** Reuses one Translator until dispose() ends the surrounding page task. */
  keepAliveForTask?: boolean;
  /** Re-detects automatic source language per request and pools each language pair. */
  dynamicSourceLanguage?: boolean;
  /** Uses Chrome detection for Han-only text instead of assuming Chinese from script alone. */
  detectAmbiguousHan?: boolean;
  /** Falls back to a trusted page language when Chrome detection is unavailable. */
  fallbackSourceLanguage?: string;
  /** Reports explicit local model preparation without exposing translated text. */
  onDownloadProgress?: (progress: number) => void;
  /** Reports the concrete source language selected for an automatic request. */
  onSourceLanguageResolved?: (
    sourceLanguage: string,
    request: TranslationRequest,
  ) => void;
}

const TRANSLATION_CONCURRENCY = 6;
const PACKED_MAX_SEGMENTS = 10;
const PACKED_MAX_CHARACTERS = 1_600;
const TRANSLATABLE_TEXT_PATTERN = /[\p{L}\p{N}]/u;
let packedRequestSequence = 0;

interface PackedTranslation {
  input: string;
  markers: string[];
}

function createPackedTranslation(
  segments: TranslationRequest["segments"],
): PackedTranslation {
  packedRequestSequence += 1;
  const nonce = packedRequestSequence.toString(36);
  const markers = Array.from(
    { length: segments.length + 1 },
    (_, index) => `\uE000NT${nonce}:${index.toString(36)}\uE001`,
  );
  return {
    markers,
    input: segments
      .map((segment, index) => `${markers[index]}\n${segment.text}\n`)
      .join("")
      .concat(markers.at(-1) ?? ""),
  };
}

function parsePackedTranslation(
  output: string,
  segments: TranslationRequest["segments"],
  markers: string[],
): TranslationResult[] | undefined {
  if (markers.length !== segments.length + 1) return undefined;
  const results: TranslationResult[] = [];
  let cursor = 0;
  for (const [index, segment] of segments.entries()) {
    const startMarker = markers[index];
    const endMarker = markers[index + 1];
    if (!startMarker || !endMarker) return undefined;
    const start = output.indexOf(startMarker, cursor);
    if (start !== cursor) return undefined;
    const translatedStart = start + startMarker.length;
    const end = output.indexOf(endMarker, translatedStart);
    if (end < translatedStart) return undefined;
    const translatedText = output.slice(translatedStart, end).trim();
    if (!translatedText) return undefined;
    results.push({ id: segment.id, translatedText });
    cursor = end;
  }
  const finalMarker = markers.at(-1);
  if (!finalMarker || output.slice(cursor) !== finalMarker) return undefined;
  return results;
}

function createPackedGroups(
  segments: TranslationRequest["segments"],
): Array<TranslationRequest["segments"]> {
  const groups: Array<TranslationRequest["segments"]> = [];
  let group: TranslationRequest["segments"] = [];
  let characters = 0;
  for (const segment of segments) {
    const wouldOverflow =
      group.length > 0 &&
      (group.length >= PACKED_MAX_SEGMENTS ||
        characters + segment.text.length > PACKED_MAX_CHARACTERS);
    if (wouldOverflow) {
      groups.push(group);
      group = [];
      characters = 0;
    }
    group.push(segment);
    characters += segment.text.length;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

export function translatorAvailabilityFactory():
  ChromeTranslatorFactory | undefined {
  return (
    globalThis as typeof globalThis & { Translator?: ChromeTranslatorFactory }
  ).Translator;
}

/** Chrome's Translator language-pack list uses `zh` for Simplified Chinese. */
export function chromeTranslatorLanguage(code: string): string {
  const normalized = code.trim().replace(/_/gu, "-");
  const lower = normalized.toLowerCase();
  if (
    lower === "zh-cn" ||
    lower === "zh-sg" ||
    lower === "zh-hans" ||
    lower.startsWith("zh-hans-")
  ) {
    return "zh";
  }
  if (
    lower === "zh-tw" ||
    lower === "zh-hk" ||
    lower === "zh-mo" ||
    lower === "zh-hant" ||
    lower.startsWith("zh-hant-")
  ) {
    return "zh-Hant";
  }
  return normalized;
}

/**
 * Some Chrome installations expose Traditional Chinese detection while only
 * preparing the generic Chinese source pack for a particular target language.
 */
export function chromeTranslatorSourceLanguageCandidates(
  code: string,
): string[] {
  const primary = chromeTranslatorLanguage(code);
  return primary === "zh-Hant" ? [primary, "zh"] : [primary];
}

function chromeTranslatorCreationErrorName(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name.trim();
  return typeof error === "string" ? "String" : "UnknownError";
}

export class ChromeLocalProvider implements TranslationProvider {
  readonly id = "chrome-local";
  readonly mode = "fast" as const;
  readonly capabilities: ProviderCapabilities = {
    maxBatchCharacters: 4_000,
    maxBatchSegments: 20,
    supportsContext: false,
    runtime: "document",
  };
  private translatorPromise: Promise<ChromeTranslatorInstance> | undefined;
  private readonly dynamicTranslatorPromises = new Map<
    string,
    Promise<ChromeTranslatorInstance>
  >();
  private readonly translatorPromiseWaiters = new Map<
    Promise<ChromeTranslatorInstance>,
    number
  >();
  private readonly settledTranslatorPromises = new WeakSet<
    Promise<ChromeTranslatorInstance>
  >();
  private readonly translatorDestroyScheduled = new WeakSet<
    Promise<ChromeTranslatorInstance>
  >();
  private readonly resolvedTranslatorSourceLanguages = new WeakMap<
    ChromeTranslatorInstance,
    string
  >();
  private readonly translationLanes = Array.from(
    { length: TRANSLATION_CONCURRENCY },
    () => Promise.resolve(),
  );
  private nextTranslationLane = 0;
  private packedTranslationSupported: boolean | undefined;
  private protectedTranslationSupported: boolean | undefined;
  constructor(private readonly options: ChromeLocalProviderOptions = {}) {}

  async translateBatch(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
    translationDiagnostic("ChromeTranslator", "batch-start", {
      ...translationRuntimeDiagnosticContext(),
      requestedSourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      segments: request.segments.length,
      characters: request.segments.reduce(
        (total, segment) => total + segment.text.length,
        0,
      ),
      keepAliveForTask: this.options.keepAliveForTask === true,
      dynamicSourceLanguage: this.options.dynamicSourceLanguage === true,
      requireAvailable: this.options.requireAvailable === true,
    });
    const translator = this.options.keepAliveForTask
      ? await this.taskTranslator(request, signal)
      : await this.createTranslator(request, signal);
    try {
      const groups = createPackedGroups(request.segments);
      const output = new Map<string, TranslationResult>();
      let nextGroup = 0;
      const worker = async (): Promise<void> => {
        while (!signal.aborted) {
          const group = groups[nextGroup++];
          if (!group) return;
          const results = await this.translateGroup(translator, group, signal);
          for (const result of results) {
            output.set(result.id, result);
            await onProgress?.(result);
          }
        }
        throw new DOMException("Translation cancelled", "AbortError");
      };
      const workers = Array.from(
        {
          length: Math.min(TRANSLATION_CONCURRENCY, groups.length),
        },
        () => worker(),
      );
      const settlements = await Promise.allSettled(workers);
      const failure = settlements.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) throw failure.reason;
      return request.segments.map((segment) => {
        const result = output.get(segment.id);
        if (!result) {
          throw new NTransError(
            "Chrome 本地翻译没有返回全部段落。",
            "invalid_response",
          );
        }
        return result;
      });
    } finally {
      if (!this.options.keepAliveForTask) translator.destroy();
    }
  }

  private async translateGroup(
    translator: ChromeTranslatorInstance,
    segments: TranslationRequest["segments"],
    signal: AbortSignal,
  ): Promise<TranslationResult[]> {
    if (segments.length > 1 && this.packedTranslationSupported !== false) {
      const packed = createPackedTranslation(segments);
      const output = await this.withTranslationPermit(signal, () =>
        translator.translate(packed.input, { signal }),
      );
      const parsed = parsePackedTranslation(output, segments, packed.markers);
      if (parsed) {
        try {
          for (const [index, result] of parsed.entries()) {
            const segment = segments[index];
            if (!segment || segment.id !== result.id) {
              throw new NTransError(
                "Chrome 本地翻译返回了未知的段落。",
                "invalid_response",
              );
            }
            assertValidProtectedTranslation(segment, result.translatedText);
          }
          this.packedTranslationSupported = true;
          return parsed;
        } catch (error) {
          if (!(error instanceof NTransError)) throw error;
          // Retry the same protected source one segment at a time. Some local
          // models preserve the outer packed boundary but alter inner markers.
          this.packedTranslationSupported = false;
        }
      }
      this.packedTranslationSupported = false;
    }

    return Promise.all(
      segments.map((segment) =>
        this.translateSegment(translator, segment, signal),
      ),
    );
  }

  private async translateSegment(
    translator: ChromeTranslatorInstance,
    segment: TranslationRequest["segments"][number],
    signal: AbortSignal,
  ): Promise<TranslationResult> {
    if (
      segment.format === "protected-text-v1" &&
      this.protectedTranslationSupported === false
    ) {
      return {
        id: segment.id,
        translatedText: await this.translateProtectedParts(
          translator,
          segment.text,
          signal,
        ),
      };
    }
    const translatedText = await this.withTranslationPermit(signal, () =>
      translator.translate(segment.text, { signal }),
    );
    try {
      assertValidProtectedTranslation(segment, translatedText);
      if (segment.format === "protected-text-v1") {
        this.protectedTranslationSupported = true;
      }
    } catch (error) {
      if (
        segment.format !== "protected-text-v1" ||
        !(error instanceof NTransError)
      ) {
        throw error;
      }
      this.protectedTranslationSupported = false;
      const parts = protectedTextParts(segment.text);
      translationDiagnostic(
        "ChromeTranslator",
        "protected-marker-fallback",
        {
          parts: parts.length,
          characters: parts.reduce((total, part) => total + part.length, 0),
          reason: error.details?.slice(0, 240) ?? error.code,
        },
        "warn",
      );
      return {
        id: segment.id,
        translatedText: await this.translateProtectedParts(
          translator,
          segment.text,
          signal,
        ),
      };
    }
    return { id: segment.id, translatedText };
  }

  private async translateProtectedParts(
    translator: ChromeTranslatorInstance,
    sourceText: string,
    signal: AbortSignal,
  ): Promise<string> {
    const sourceParts = protectedTextParts(sourceText);
    const translatedParts = await Promise.all(
      sourceParts.map(async (part) => {
        if (!TRANSLATABLE_TEXT_PATTERN.test(part.normalize("NFKC"))) {
          return part;
        }
        const translated = await this.withTranslationPermit(signal, () =>
          translator.translate(part, { signal }),
        );
        if (!translated.trim()) {
          throw new NTransError(
            "Chrome 本地翻译返回了空的页面片段。",
            "invalid_response",
            true,
            "Chrome protected-part fallback returned an empty translation.",
          );
        }
        return translated;
      }),
    );
    return rebuildProtectedTranslation(sourceText, translatedParts);
  }

  async dispose(): Promise<void> {
    const translatorPromises = new Set<Promise<ChromeTranslatorInstance>>();
    if (this.translatorPromise) translatorPromises.add(this.translatorPromise);
    for (const promise of this.dynamicTranslatorPromises.values()) {
      translatorPromises.add(promise);
    }
    this.translatorPromise = undefined;
    this.dynamicTranslatorPromises.clear();
    if (translatorPromises.size === 0) return;
    await Promise.all(this.translationLanes);
    for (const promise of translatorPromises) {
      this.destroyTranslatorWhenReady(promise);
    }
  }

  private async taskTranslator(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<ChromeTranslatorInstance> {
    if (this.options.dynamicSourceLanguage) {
      const sourceLanguage = await this.resolveSourceLanguage(request, signal);
      if (signal.aborted) {
        throw new DOMException("Translation cancelled", "AbortError");
      }
      const configuration = `${sourceLanguage}\u001f${request.targetLanguage}`;
      const existing = this.dynamicTranslatorPromises.get(configuration);
      if (existing) {
        const translator = await this.waitForTranslator(
          existing,
          signal,
          () => {
            if (
              this.dynamicTranslatorPromises.get(configuration) === existing
            ) {
              this.dynamicTranslatorPromises.delete(configuration);
            }
          },
        );
        this.options.onSourceLanguageResolved?.(
          this.resolvedTranslatorSourceLanguages.get(translator) ??
            chromeTranslatorLanguage(sourceLanguage),
          request,
        );
        return translator;
      }
      const created = this.createTranslatorForLanguages(
        sourceLanguage,
        request.targetLanguage,
        signal,
      ).then((translator) => {
        this.options.onSourceLanguageResolved?.(
          this.resolvedTranslatorSourceLanguages.get(translator) ??
            chromeTranslatorLanguage(sourceLanguage),
          request,
        );
        return translator;
      });
      this.trackTranslatorPromise(created);
      this.dynamicTranslatorPromises.set(configuration, created);
      void created.catch(() => {
        if (this.dynamicTranslatorPromises.get(configuration) === created) {
          this.dynamicTranslatorPromises.delete(configuration);
        }
      });
      return this.waitForTranslator(created, signal, () => {
        if (this.dynamicTranslatorPromises.get(configuration) === created) {
          this.dynamicTranslatorPromises.delete(configuration);
        }
      });
    }
    if (!this.translatorPromise) {
      const created = this.createTranslator(request, signal);
      this.trackTranslatorPromise(created);
      this.translatorPromise = created;
      void created.catch(() => {
        if (this.translatorPromise === created)
          this.translatorPromise = undefined;
      });
    }
    const current = this.translatorPromise;
    return this.waitForTranslator(current, signal, () => {
      if (this.translatorPromise === current)
        this.translatorPromise = undefined;
    });
  }

  private trackTranslatorPromise(
    promise: Promise<ChromeTranslatorInstance>,
  ): void {
    void promise.then(
      () => this.settledTranslatorPromises.add(promise),
      () => this.settledTranslatorPromises.add(promise),
    );
  }

  private destroyTranslatorWhenReady(
    promise: Promise<ChromeTranslatorInstance>,
  ): void {
    if (this.translatorDestroyScheduled.has(promise)) return;
    this.translatorDestroyScheduled.add(promise);
    void promise.then(
      (translator) => translator.destroy(),
      () => undefined,
    );
  }

  private waitForTranslator(
    promise: Promise<ChromeTranslatorInstance>,
    signal: AbortSignal,
    evict: () => void,
  ): Promise<ChromeTranslatorInstance> {
    if (signal.aborted) {
      return Promise.reject(
        new DOMException("Translation cancelled", "AbortError"),
      );
    }
    this.translatorPromiseWaiters.set(
      promise,
      (this.translatorPromiseWaiters.get(promise) ?? 0) + 1,
    );
    return new Promise((resolve, reject) => {
      let finished = false;
      const release = (aborted: boolean): void => {
        const remaining = Math.max(
          0,
          (this.translatorPromiseWaiters.get(promise) ?? 1) - 1,
        );
        if (remaining === 0) this.translatorPromiseWaiters.delete(promise);
        else this.translatorPromiseWaiters.set(promise, remaining);
        if (
          aborted &&
          remaining === 0 &&
          !this.settledTranslatorPromises.has(promise)
        ) {
          evict();
          this.destroyTranslatorWhenReady(promise);
        }
      };
      const onAbort = (): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener("abort", onAbort);
        release(true);
        reject(new DOMException("Translation cancelled", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(
        (translator) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", onAbort);
          release(false);
          resolve(translator);
        },
        (error: unknown) => {
          if (finished) return;
          finished = true;
          signal.removeEventListener("abort", onAbort);
          release(false);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  private async createTranslator(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<ChromeTranslatorInstance> {
    const sourceLanguage = await this.resolveSourceLanguage(request, signal);
    const translator = await this.createTranslatorForLanguages(
      sourceLanguage,
      request.targetLanguage,
      signal,
    );
    this.options.onSourceLanguageResolved?.(
      this.resolvedTranslatorSourceLanguages.get(translator) ??
        chromeTranslatorLanguage(sourceLanguage),
      request,
    );
    return translator;
  }

  private async resolveSourceLanguage(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<string> {
    if (request.sourceLanguage !== "auto") {
      return request.sourceLanguage;
    }
    const text = request.segments
      .map((segment) => segment.text)
      .join(" ")
      .slice(0, 1000);
    const scriptHint = dominantScriptSourceLanguageHint(
      text,
      this.options.fallbackSourceLanguage,
      !this.options.detectAmbiguousHan,
    );
    if (scriptHint) return scriptHint;
    if (signal.aborted) {
      throw new DOMException("Translation cancelled", "AbortError");
    }
    const detectedLanguage = await detectDominantSourceLanguage(
      text,
      this.options.fallbackSourceLanguage,
    );
    if (signal.aborted) {
      throw new DOMException("Translation cancelled", "AbortError");
    }
    if (detectedLanguage) return detectedLanguage;
    throw new NTransError(
      "无法检测网页语言，请手动选择源语言。",
      "provider_unavailable",
      false,
      undefined,
      "chrome_language_detection_failed",
    );
  }

  private async createTranslatorForLanguages(
    sourceLanguage: string,
    targetLanguage: string,
    signal: AbortSignal,
  ): Promise<ChromeTranslatorInstance> {
    const factory = translatorAvailabilityFactory();
    if (!factory) {
      throw new NTransError(
        "当前 Chrome 不支持本地 Translator API。",
        "provider_unavailable",
      );
    }
    const chromeTargetLanguage = chromeTranslatorLanguage(targetLanguage);
    const attemptedPairs: string[] = [];
    const runtimeContext = translationRuntimeDiagnosticContext();
    for (const chromeSourceLanguage of chromeTranslatorSourceLanguageCandidates(
      sourceLanguage,
    )) {
      const availability = await factory.availability({
        sourceLanguage: chromeSourceLanguage,
        targetLanguage: chromeTargetLanguage,
      });
      attemptedPairs.push(
        `${chromeSourceLanguage}->${chromeTargetLanguage}=${availability}`,
      );
      translationDiagnostic("ChromeTranslator", "pair-availability", {
        ...runtimeContext,
        requestedSourceLanguage: sourceLanguage,
        requestedTargetLanguage: targetLanguage,
        sourceLanguage: chromeSourceLanguage,
        targetLanguage: chromeTargetLanguage,
        availability,
        requireAvailable: this.options.requireAvailable === true,
      });
      if (
        availability === "unavailable" ||
        (this.options.requireAvailable && availability !== "available")
      ) {
        continue;
      }

      try {
        const translator = await factory.create({
          sourceLanguage: chromeSourceLanguage,
          targetLanguage: chromeTargetLanguage,
          signal,
          ...(this.options.onDownloadProgress
            ? {
                monitor: (monitor: EventTarget) => {
                  monitor.addEventListener("downloadprogress", (event) => {
                    const loaded = (event as Event & { loaded?: number })
                      .loaded;
                    if (typeof loaded !== "number" || !Number.isFinite(loaded))
                      return;
                    this.options.onDownloadProgress?.(
                      Math.min(1, Math.max(0, loaded)),
                    );
                  });
                },
              }
            : {}),
        });
        this.resolvedTranslatorSourceLanguages.set(
          translator,
          chromeSourceLanguage,
        );
        return translator;
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          throw error;
        }
        const errorName = chromeTranslatorCreationErrorName(error);
        attemptedPairs.push(
          `${chromeSourceLanguage}->${chromeTargetLanguage}=create-${errorName}`,
        );
        translationDiagnostic(
          "ChromeTranslator",
          "pair-create-failed",
          {
            ...runtimeContext,
            requestedSourceLanguage: sourceLanguage,
            requestedTargetLanguage: targetLanguage,
            sourceLanguage: chromeSourceLanguage,
            targetLanguage: chromeTargetLanguage,
            availability,
            errorName,
          },
          "warn",
        );
        if (
          error instanceof DOMException &&
          error.name === "NotSupportedError"
        ) {
          continue;
        }
        // Chrome may advertise an on-demand pair as downloadable/downloading
        // and still fail while preparing its model. Treat that as a pair
        // capability failure so automatic mixed-language pages can retain the
        // unsupported segment. Runtime failures after an available pair has
        // already been prepared must remain visible to the user.
        if (availability !== "available") continue;
        throw error;
      }
    }

    translationDiagnostic(
      "ChromeTranslator",
      "pair-unavailable",
      {
        ...runtimeContext,
        requestedSourceLanguage: sourceLanguage,
        requestedTargetLanguage: targetLanguage,
        attempts: attemptedPairs,
      },
      "warn",
    );
    const contextDetails = [
      `hostname=${runtimeContext.hostname || "unknown"}`,
      `frame=${runtimeContext.frame}`,
      `sameOriginTop=${String(runtimeContext.sameOriginTop)}`,
      `documentLanguage=${runtimeContext.documentLanguage || "unset"}`,
      `secureContext=${String(runtimeContext.secureContext)}`,
      `translatorPolicy=${String(runtimeContext.translatorPolicy)}`,
    ].join(", ");
    throw new NTransError(
      "Chrome 本地翻译不支持当前语言对。",
      "provider_unavailable",
      false,
      `Chrome Translator pair attempts: ${attemptedPairs.join(", ")}. Context: ${contextDetails}.`,
      "chrome_pair_unavailable",
    );
  }

  private async withTranslationPermit<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const lane = this.nextTranslationLane % TRANSLATION_CONCURRENCY;
    this.nextTranslationLane += 1;
    const previous = this.translationLanes[lane] ?? Promise.resolve();
    const current = previous.then(async () => {
      if (signal.aborted) {
        throw new DOMException("Translation cancelled", "AbortError");
      }
      return operation();
    });
    this.translationLanes[lane] = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  }
}
