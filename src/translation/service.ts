import {
  getCachedTranslation,
  setCachedTranslation,
} from "@/src/cache/database";
import { promptVersion, translationCacheKey } from "@/src/cache/keys";
import { NoriTransError } from "@/src/shared/errors";
import type { AppSettings } from "@/src/shared/settings";
import { list as listLocalTranslationRuntimes } from "@/src/local-translation/runtime-storage";
import { createBackgroundTranslationProvider } from "@/src/translation/providers/factory";
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
let localTranslationModelIdentity: Promise<string> | undefined;

export function invalidateLocalTranslationModelIdentity(): void {
  localTranslationModelIdentity = undefined;
}

function currentLocalTranslationModelIdentity(): Promise<string> {
  if (!localTranslationModelIdentity) {
    const loading = listLocalTranslationRuntimes().then(
      (runtimes) =>
        runtimes
          .filter((runtime) => runtime.state === "installed")
          .map((runtime) => `${runtime.packId}@${runtime.version ?? "unknown"}`)
          .sort()
          .join(",") || "none",
    );
    const cached = loading.catch((error: unknown) => {
      if (localTranslationModelIdentity === cached) {
        localTranslationModelIdentity = undefined;
      }
      throw error;
    });
    localTranslationModelIdentity = cached;
  }
  return localTranslationModelIdentity;
}

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
    if (error instanceof NoriTransError) return undefined;
    throw error;
  }
}

interface CacheReadWaiter {
  scope: CacheReadScope;
  signal: AbortSignal;
  resolve: (acquired: boolean) => void;
  abort: () => void;
}

/**
 * Per-request state for cache reads. Stopping one request's queued reads must
 * not turn other requests' (other tabs') queued reads into misses, because
 * every spurious miss spends Provider tokens.
 */
interface CacheReadScope {
  stopped: boolean;
}

interface CacheReadOutcome {
  cached: string | undefined;
  timedOut: boolean;
  /** True when the IndexedDB read rejected and the key was treated as a miss. */
  failed: boolean;
}

const CACHE_READ_MISS: CacheReadOutcome = {
  cached: undefined,
  timedOut: false,
  failed: false,
};

class BackgroundCacheReadPool {
  private active = 0;
  private readonly waiters: CacheReadWaiter[] = [];

  async read(
    key: string,
    signal: AbortSignal,
    scope: CacheReadScope,
  ): Promise<CacheReadOutcome> {
    if (!(await this.acquire(signal, scope))) return CACHE_READ_MISS;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.release();
    };
    // The cache is an optimization: a rejected read (closed connection, quota
    // or backend failure) fails open as a miss instead of failing the request
    // before the Provider is called.
    const underlying: Promise<CacheReadOutcome> = Promise.resolve()
      .then(() => getCachedTranslation(key))
      .then(
        (cached) => ({ cached, timedOut: false, failed: false }),
        () => ({ cached: undefined, timedOut: false, failed: true }),
      );
    void underlying.then(release);
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    try {
      const result = await Promise.race([
        underlying,
        new Promise<CacheReadOutcome>((resolve) => {
          timer = globalThis.setTimeout(
            () => resolve({ cached: undefined, timedOut: true, failed: false }),
            CACHE_READ_TIMEOUT_MS,
          );
        }),
        new Promise<CacheReadOutcome>((resolve) => {
          const abort = (): void => resolve(CACHE_READ_MISS);
          signal.addEventListener("abort", abort, { once: true });
          removeAbortListener = () =>
            signal.removeEventListener("abort", abort);
          if (signal.aborted) abort();
        }),
      ]);
      if (result.timedOut || signal.aborted) {
        this.stopQueuedReads(scope);
        release();
      }
      return result;
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
      removeAbortListener?.();
    }
  }

  private acquire(
    signal: AbortSignal,
    scope: CacheReadScope,
  ): Promise<boolean> {
    if (scope.stopped || signal.aborted) return Promise.resolve(false);
    if (this.active < CACHE_READ_CONCURRENCY) {
      this.active += 1;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const waiter: CacheReadWaiter = {
        scope,
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

  /** Resolves only this request's queued reads as misses. */
  private stopQueuedReads(scope: CacheReadScope): void {
    scope.stopped = true;
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter?.scope !== scope) continue;
      this.waiters.splice(index, 1);
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.resolve(false);
    }
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted || waiter.scope.stopped) {
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
      : (request.providerOverride ?? settings.provider.fastProvider);

  const localModelIdentity =
    providerId === "bergamot-local"
      ? await currentLocalTranslationModelIdentity()
      : "";

  const configuredAiProvider =
    providerId === "openai-compatible" || providerId === "anthropic-messages";
  const providerModel = configuredAiProvider
    ? request.modelOverride?.trim() || settings.provider.model
    : providerId === "bergamot-local"
      ? `mozilla-translations-models-v2:${localModelIdentity}`
      : "official-v2";
  const provider = createBackgroundTranslationProvider(
    providerId,
    request.mode,
    settings,
    providerModel,
  );
  const version = configuredAiProvider
    ? promptVersion(request.prompt ?? settings.provider.systemPrompt)
    : "machine-translation-v1";
  const providerScope = configuredAiProvider
    ? settings.provider.baseUrl.trim().replace(/\/+$/, "")
    : providerId === "microsoft-translator"
      ? settings.provider.microsoftRegion.trim().toLowerCase()
      : providerId === "deepl"
        ? settings.provider.deeplPlan
        : providerId === "bergamot-local"
          ? "local-wasm"
          : "google-v2";
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
                providerScope,
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
    const readScope: CacheReadScope = { stopped: false };
    let failedReads = 0;
    await Promise.all(
      [...entriesByKey.values()].map(async (entries) => {
        const first = entries[0];
        if (!first) return;
        const read = await backgroundCacheReads.read(
          first.key,
          signal,
          readScope,
        );
        if (read.failed) failedReads += 1;
        for (const entry of entries) {
          entry.cached = validCachedTranslation(entry.segment, read.cached);
        }
      }),
    );
    if (failedReads > 0) {
      // Bounded metadata only: no keys, source text or backend error text.
      console.warn(
        `[NoriTrans][TranslationCache] cache_read_failed ${JSON.stringify({
          failedReads,
          totalReads: entriesByKey.size,
        })}`,
      );
    }
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
        throw new NoriTransError(
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
