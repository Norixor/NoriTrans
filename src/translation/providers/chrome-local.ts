import { NorixorTransError } from "@/src/shared/errors";
import { strongScriptSourceLanguageHint } from "@/src/translation/language-detection";
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

interface ChromeTranslatorFactory {
  availability(options: {
    sourceLanguage: string;
    targetLanguage: string;
  }): Promise<"unavailable" | "downloadable" | "downloading" | "available">;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    signal?: AbortSignal;
    monitor?(monitor: EventTarget): void;
  }): Promise<ChromeTranslatorInstance>;
}

interface ChromeLanguageDetectorInstance {
  detect(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<Array<{ detectedLanguage: string; confidence: number }>>;
  destroy(): void;
}

interface ChromeLanguageDetectorFactory {
  availability(): Promise<
    "unavailable" | "downloadable" | "downloading" | "available"
  >;
  create(options?: {
    signal?: AbortSignal;
  }): Promise<ChromeLanguageDetectorInstance>;
}

export interface ChromeLocalProviderOptions {
  /** Avoids starting a model download for opportunistic low-latency fallback. */
  requireAvailable?: boolean;
  /** Reuses one Translator until dispose() ends the surrounding page task. */
  keepAliveForTask?: boolean;
  /** Re-detects automatic source language per request and pools each language pair. */
  dynamicSourceLanguage?: boolean;
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

function translatorFactory(): ChromeTranslatorFactory | undefined {
  return (
    globalThis as typeof globalThis & { Translator?: ChromeTranslatorFactory }
  ).Translator;
}

function languageDetectorFactory(): ChromeLanguageDetectorFactory | undefined {
  return (
    globalThis as typeof globalThis & {
      LanguageDetector?: ChromeLanguageDetectorFactory;
    }
  ).LanguageDetector;
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

async function detectLanguage(
  text: string,
  signal: AbortSignal,
): Promise<string> {
  const detector = await createLanguageDetector(signal);
  try {
    return await detectLanguageWith(detector, text, signal);
  } finally {
    detector.destroy();
  }
}

async function createLanguageDetector(
  signal: AbortSignal,
): Promise<ChromeLanguageDetectorInstance> {
  const factory = languageDetectorFactory();
  if (!factory || (await factory.availability()) === "unavailable") {
    throw new NorixorTransError(
      "Chrome 本地语言检测不可用，请手动选择源语言。",
      "provider_unavailable",
    );
  }
  return factory.create({ signal });
}

async function detectLanguageWith(
  detector: ChromeLanguageDetectorInstance,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  const results = await detector.detect(text, { signal });
  const language = results[0]?.detectedLanguage;
  if (!language) {
    throw new NorixorTransError(
      "无法检测网页语言，请手动选择源语言。",
      "provider_unavailable",
    );
  }
  return language;
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
  private readonly translationLanes = Array.from(
    { length: TRANSLATION_CONCURRENCY },
    () => Promise.resolve(),
  );
  private nextTranslationLane = 0;
  private packedTranslationSupported: boolean | undefined;
  private languageDetectorPromise:
    Promise<ChromeLanguageDetectorInstance> | undefined;

  constructor(private readonly options: ChromeLocalProviderOptions = {}) {}

  async translateBatch(
    request: TranslationRequest,
    signal: AbortSignal,
    onProgress?: TranslationProgressCallback,
  ): Promise<TranslationResult[]> {
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
          throw new NorixorTransError(
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
              throw new NorixorTransError(
                "Chrome 本地翻译返回了未知的段落。",
                "invalid_response",
              );
            }
            assertValidProtectedTranslation(segment, result.translatedText);
          }
          this.packedTranslationSupported = true;
          return parsed;
        } catch (error) {
          if (!(error instanceof NorixorTransError)) throw error;
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
    const translatedText = await this.withTranslationPermit(signal, () =>
      translator.translate(segment.text, { signal }),
    );
    try {
      assertValidProtectedTranslation(segment, translatedText);
      return { id: segment.id, translatedText };
    } catch (error) {
      if (
        !(error instanceof NorixorTransError) ||
        error.code !== "invalid_response" ||
        segment.format !== "protected-text-v1"
      ) {
        throw error;
      }
    }

    // Chrome's local model may legitimately reorder private-use markers while
    // translating an inline-heavy sentence. Retry only that sentence's text
    // parts, then rebuild the exact source-node contract locally.
    const translatedParts = await Promise.all(
      protectedTextParts(segment.text).map((part) => {
        if (!/[\p{L}\p{N}]/u.test(part)) return Promise.resolve(part);
        return this.withTranslationPermit(signal, () =>
          translator.translate(part, { signal }),
        );
      }),
    );
    return {
      id: segment.id,
      translatedText: rebuildProtectedTranslation(
        segment.text,
        translatedParts,
      ),
    };
  }

  async dispose(): Promise<void> {
    const translatorPromises = new Set<Promise<ChromeTranslatorInstance>>();
    if (this.translatorPromise) translatorPromises.add(this.translatorPromise);
    for (const promise of this.dynamicTranslatorPromises.values()) {
      translatorPromises.add(promise);
    }
    this.translatorPromise = undefined;
    this.dynamicTranslatorPromises.clear();
    const languageDetectorPromise = this.languageDetectorPromise;
    this.languageDetectorPromise = undefined;
    if (languageDetectorPromise) {
      void languageDetectorPromise.then(
        (detector) => detector.destroy(),
        () => undefined,
      );
    }
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
        this.options.onSourceLanguageResolved?.(sourceLanguage, request);
        return translator;
      }
      const created = this.createTranslatorForLanguages(
        sourceLanguage,
        request.targetLanguage,
        signal,
      ).then((translator) => {
        this.options.onSourceLanguageResolved?.(sourceLanguage, request);
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
    this.options.onSourceLanguageResolved?.(sourceLanguage, request);
    return translator;
  }

  private resolveSourceLanguage(
    request: TranslationRequest,
    signal: AbortSignal,
  ): Promise<string> {
    if (request.sourceLanguage !== "auto") {
      return Promise.resolve(request.sourceLanguage);
    }
    const text = request.segments
      .map((segment) => segment.text)
      .join(" ")
      .slice(0, 1000);
    const scriptHint = strongScriptSourceLanguageHint(
      text,
      this.options.fallbackSourceLanguage,
    );
    if (scriptHint) return Promise.resolve(scriptHint);
    if (!this.options.keepAliveForTask || !this.options.dynamicSourceLanguage) {
      return this.withSourceLanguageFallback(
        detectLanguage(text, signal),
        text,
      );
    }
    if (!this.languageDetectorPromise) {
      const created = createLanguageDetector(signal);
      this.languageDetectorPromise = created;
      void created.catch(() => {
        if (this.languageDetectorPromise === created) {
          this.languageDetectorPromise = undefined;
        }
      });
    }
    return this.withSourceLanguageFallback(
      this.languageDetectorPromise.then((detector) =>
        detectLanguageWith(detector, text, signal),
      ),
      text,
    );
  }

  private async withSourceLanguageFallback(
    detected: Promise<string>,
    text: string,
  ): Promise<string> {
    try {
      return await detected;
    } catch (error) {
      if (
        error instanceof NorixorTransError &&
        error.code === "provider_unavailable"
      ) {
        const fallback =
          strongScriptSourceLanguageHint(
            text,
            this.options.fallbackSourceLanguage,
          ) ?? this.options.fallbackSourceLanguage;
        if (fallback) return fallback;
      }
      throw error;
    }
  }

  private async createTranslatorForLanguages(
    sourceLanguage: string,
    targetLanguage: string,
    signal: AbortSignal,
  ): Promise<ChromeTranslatorInstance> {
    const factory = translatorFactory();
    if (!factory) {
      throw new NorixorTransError(
        "当前 Chrome 不支持本地 Translator API。",
        "provider_unavailable",
      );
    }
    const chromeSourceLanguage = chromeTranslatorLanguage(sourceLanguage);
    const chromeTargetLanguage = chromeTranslatorLanguage(targetLanguage);
    const availability = await factory.availability({
      sourceLanguage: chromeSourceLanguage,
      targetLanguage: chromeTargetLanguage,
    });
    if (
      availability === "unavailable" ||
      (this.options.requireAvailable && availability !== "available")
    ) {
      throw new NorixorTransError(
        "Chrome 本地翻译不支持当前语言对。",
        "provider_unavailable",
      );
    }

    return factory.create({
      sourceLanguage: chromeSourceLanguage,
      targetLanguage: chromeTargetLanguage,
      signal,
      ...(this.options.onDownloadProgress
        ? {
            monitor: (monitor: EventTarget) => {
              monitor.addEventListener("downloadprogress", (event) => {
                const loaded = (event as Event & { loaded?: number }).loaded;
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
