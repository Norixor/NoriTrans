import {
  getCachedTranslation,
  setCachedTranslation,
} from "@/src/cache/database";
import { promptVersion, translationCacheKey } from "@/src/cache/keys";
import { NorixorTransError } from "@/src/shared/errors";
import type { AppSettings } from "@/src/shared/settings";
import { OpenAICompatibleProvider } from "@/src/translation/providers/openai-compatible";
import { translationSegmentCacheText } from "@/src/translation/context";
import { cleanTranslatedText } from "@/src/translation/output";
import { assertValidProtectedTranslation } from "@/src/translation/protected-text";
import { scheduleTranslation } from "@/src/translation/scheduler";
import type {
  TranslationProgressCallback,
  TranslationRequest,
  TranslationResult,
} from "@/src/translation/types";

export interface TranslationCacheWriter {
  set(key: string, translatedText: string): Promise<void>;
}

export interface BackgroundTranslationOptions {
  cacheWriter?: TranslationCacheWriter;
  onProgress?: TranslationProgressCallback;
  cachePolicy?: "use" | "bypass";
}

// IndexedDB reads can briefly exceed one animation-sized scheduling window
// while the extension service worker is waking. Give an in-flight hit enough
// time to settle before spending Provider tokens, but still fail open when the
// cache backend is genuinely unavailable.
const CACHE_READ_TIMEOUT_MS = 500;
const CACHE_READ_CONCURRENCY = 8;

function validCachedTranslation(
  segment: TranslationRequest["segments"][number],
  value: string | undefined,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const cleaned = cleanTranslatedText(value).trim();
    if (!cleaned) return undefined;
    assertValidProtectedTranslation(segment, cleaned);
    return cleaned;
  } catch (error) {
    if (error instanceof NorixorTransError) return undefined;
    throw error;
  }
}

interface CacheReadWaiter {
  signal: AbortSignal;
  resolve: (acquired: boolean) => void;
  abort: () => void;
}

class BackgroundCacheReadPool {
  private active = 0;
  private stopped = false;
  private readonly waiters: CacheReadWaiter[] = [];

  async read(
    key: string,
    signal: AbortSignal,
  ): Promise<{ cached: string | undefined; timedOut: boolean }> {
    if (!(await this.acquire(signal))) {
      return { cached: undefined, timedOut: false };
    }
    const underlying = getCachedTranslation(key);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.release();
    };
    void underlying.then(release, release);
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    try {
      const result = await Promise.race([
        underlying.then((cached) => ({ cached, timedOut: false })),
        new Promise<{ cached: undefined; timedOut: true }>((resolve) => {
          timer = globalThis.setTimeout(
            () => resolve({ cached: undefined, timedOut: true }),
            CACHE_READ_TIMEOUT_MS,
          );
        }),
        new Promise<{ cached: undefined; timedOut: false }>((resolve) => {
          const abort = (): void =>
            resolve({ cached: undefined, timedOut: false });
          signal.addEventListener("abort", abort, { once: true });
          removeAbortListener = () =>
            signal.removeEventListener("abort", abort);
          if (signal.aborted) abort();
        }),
      ]);
      if (result.timedOut || signal.aborted) {
        this.stopQueuedReads();
        release();
      }
      return result;
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      removeAbortListener?.();
    }
  }

  private acquire(signal: AbortSignal): Promise<boolean> {
    if (this.stopped || signal.aborted) return Promise.resolve(false);
    if (this.active < CACHE_READ_CONCURRENCY) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: CacheReadWaiter = {
        signal,
        resolve,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          signal.removeEventListener("abort", waiter.abort);
          resolve(false);
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private stopQueuedReads(): void {
    this.stopped = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(false);
    }
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.stopped) {
      if (this.active === 0) this.stopped = false;
      return;
    }
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.resolve(false);
        continue;
      }
      this.active += 1;
      waiter.resolve(true);
      return;
    }
  }
}

const backgroundCacheReads = new BackgroundCacheReadPool();

export async function translateInBackground(
  request: TranslationRequest,
  settings: AppSettings,
  signal: AbortSignal,
  options: BackgroundTranslationOptions = {},
): Promise<TranslationResult[]> {
  const { cacheWriter, onProgress, cachePolicy = "use" } = options;
  const providerId =
    request.mode === "ai"
      ? settings.provider.aiProvider
      : settings.provider.fastProvider;

  if (providerId !== "openai-compatible") {
    throw new Error("Chrome 本地翻译必须在页面上下文中运行。");
  }

  const providerModel =
    request.modelOverride?.trim() || settings.provider.model;

  const provider = new OpenAICompatibleProvider(request.mode, {
    baseUrl: settings.provider.baseUrl,
    apiKey: settings.provider.apiKey,
    model: providerModel,
    systemPrompt: settings.provider.systemPrompt,
    timeoutMs: settings.provider.timeoutMs,
  });
  const version = promptVersion(
    request.prompt ?? settings.provider.systemPrompt,
  );
  const results: TranslationResult[] = [];
  const cacheEntries: Array<{
    segment: TranslationRequest["segments"][number];
    key: string;
    cached: string | undefined;
  }> =
    cachePolicy === "bypass"
      ? request.segments.map((segment) => ({
          segment,
          key: "",
          cached: undefined,
        }))
      : await Promise.all(
          request.segments.map(async (segment) => ({
            segment,
            key: await translationCacheKey({
              providerId,
              model: providerModel,
              promptVersion: version,
              sourceLanguage: request.sourceLanguage,
              targetLanguage: request.targetLanguage,
              mode: request.mode,
              text: translationSegmentCacheText(segment),
              scope: [
                settings.provider.baseUrl.trim().replace(/\/+$/, ""),
                request.scope ?? "",
                request.mediaTitle ?? "",
              ].join("\u001f"),
            }),
            cached: undefined,
          })),
        );
  if (cachePolicy === "use") {
    const entriesByKey = new Map<string, typeof cacheEntries>();
    for (const entry of cacheEntries) {
      const matches = entriesByKey.get(entry.key) ?? [];
      matches.push(entry);
      entriesByKey.set(entry.key, matches);
    }
    await Promise.all(
      [...entriesByKey.values()].map(async (entries) => {
        const first = entries[0];
        if (!first) return;
        const read = await backgroundCacheReads.read(first.key, signal);
        for (const entry of entries) {
          entry.cached = validCachedTranslation(entry.segment, read.cached);
        }
      }),
    );
  }
  const missing = cacheEntries.filter((entry) => entry.cached === undefined);
  for (const entry of cacheEntries) {
    if (entry.cached !== undefined) {
      const result = {
        id: entry.segment.id,
        translatedText: entry.cached,
      };
      results.push(result);
      await onProgress?.(result);
    }
  }

  if (missing.length > 0) {
    const keyById = new Map(missing.map((item) => [item.segment.id, item.key]));
    const segmentById = new Map(
      missing.map((item) => [item.segment.id, item.segment]),
    );
    const progressed = new Set<string>();
    const cacheWrites: Promise<void>[] = [];
    const persistAndReport = async (
      result: TranslationResult,
    ): Promise<void> => {
      if (signal.aborted || progressed.has(result.id)) return;
      const segment = segmentById.get(result.id);
      if (!segment) return;
      const translatedText = cleanTranslatedText(result.translatedText).trim();
      if (!translatedText) {
        throw new NorixorTransError(
          "翻译服务返回了空译文。",
          "invalid_response",
          false,
          `Result ID ${result.id.slice(0, 120)} became empty after removing a provider-added label.`,
        );
      }
      assertValidProtectedTranslation(segment, translatedText);
      const normalizedResult = { id: result.id, translatedText };
      const key = keyById.get(result.id);
      if (cachePolicy === "use" && key) {
        const write = (
          cacheWriter?.set(key, translatedText) ??
          setCachedTranslation(key, translatedText)
        ).catch(() => undefined);
        cacheWrites.push(write);
      }
      if (signal.aborted) return;
      progressed.add(result.id);
      await onProgress?.(normalizedResult);
    };
    const translated = await scheduleTranslation(
      provider,
      { ...request, segments: missing.map((item) => item.segment) },
      signal,
      persistAndReport,
    );
    if (signal.aborted) {
      throw new DOMException("Translation cancelled", "AbortError");
    }
    await Promise.all(
      translated.map(async (result) => {
        if (!progressed.has(result.id)) await persistAndReport(result);
      }),
    );
    await Promise.all(cacheWrites);
    results.push(
      ...translated.map((result) => ({
        id: result.id,
        translatedText: cleanTranslatedText(result.translatedText).trim(),
      })),
    );
  }

  const index = new Map(
    request.segments.map((segment, position) => [segment.id, position]),
  );
  return results.sort(
    (left, right) => (index.get(left.id) ?? 0) - (index.get(right.id) ?? 0),
  );
}
