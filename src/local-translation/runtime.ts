import { BatchTranslator } from "@mkljczk/bergamot-translator";
import { browser } from "wxt/browser";
import { InstalledBergamotBacking } from "@/src/local-translation/backing";
import { BergamotRuntimeError } from "@/src/local-translation/errors";
import { requiredBergamotLanguagePacks } from "@/src/local-translation/languages";
import {
  BergamotRuntimeStorage,
  type BergamotInstallOptions,
  type LocalTranslationRuntimeInfo,
} from "@/src/local-translation/runtime-storage";
import type { BergamotLanguage } from "@/src/local-translation/types";
import type { BergamotLanguagePackId } from "@/src/local-translation/languages";

interface RuntimeTranslationSegment {
  id: string;
  text: string;
}

interface RuntimeTranslationResult {
  id: string;
  translatedText: string;
}

function abortError(): DOMException {
  return new DOMException("Translation cancelled", "AbortError");
}

function boundedFailureReason(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const reason = error.message
    .replace(/chrome-extension:\/\/[^/\s]+/gu, "extension:")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
  return reason ? `${error.name}: ${reason}` : error.name;
}

/**
 * Maximum time the shared worker may hold submitted work without completing
 * any of it. Queue wait behind other requests counts as progress as long as
 * the worker keeps finishing batches, so only a genuinely stuck worker trips.
 */
const WORKER_NO_PROGRESS_TIMEOUT_MS = 60_000;

interface TranslatorState {
  translator: BatchTranslator;
  /** Submitted worker requests that have not settled yet. */
  pending: number;
  watchdog: ReturnType<typeof globalThis.setTimeout> | undefined;
  /** Requests waiting on this translator; a failure rejects only these. */
  failureListeners: Set<(error: Error) => void>;
}

export class BergamotLocalRuntime {
  private state: TranslatorState | undefined;

  constructor(private readonly storage = new BergamotRuntimeStorage()) {}

  list(): Promise<LocalTranslationRuntimeInfo[]> {
    return this.storage.list();
  }

  async install(
    packId: BergamotLanguagePackId,
    options?: BergamotInstallOptions,
  ): Promise<LocalTranslationRuntimeInfo> {
    const result = await this.storage.install(packId, options);
    await this.resetTranslator();
    return result;
  }

  async deleteRuntime(packId: BergamotLanguagePackId): Promise<boolean> {
    await this.resetTranslator();
    return this.storage.deleteRuntime(packId);
  }

  async translate(
    sourceLanguage: BergamotLanguage,
    targetLanguage: BergamotLanguage,
    segments: readonly RuntimeTranslationSegment[],
    signal: AbortSignal,
  ): Promise<RuntimeTranslationResult[]> {
    if (signal.aborted) throw abortError();
    if (sourceLanguage === targetLanguage) {
      return segments.map(({ id, text }) => ({ id, translatedText: text }));
    }
    await this.assertRequiredPacks(sourceLanguage, targetLanguage);
    const state = this.getTranslatorState();
    const { translator } = state;
    const submittedRequests = new Set<object>();
    let removeFailureListener = (): void => undefined;
    const workerFailed = new Promise<never>((_, reject) => {
      const listener = (error: Error): void => reject(error);
      state.failureListeners.add(listener);
      removeFailureListener = () => state.failureListeners.delete(listener);
    });
    const translation = Promise.all(
      segments.map(async (segment) => {
        const workerRequest = {
          from: sourceLanguage,
          to: targetLanguage,
          text: segment.text,
          html: false,
          qualityScores: false,
        };
        submittedRequests.add(workerRequest);
        this.trackSubmitted(state);
        let response: Awaited<ReturnType<BatchTranslator["translate"]>>;
        try {
          response = await translator.translate(workerRequest);
        } catch (error) {
          this.trackSettled(state, false);
          throw error;
        }
        this.trackSettled(state, true);
        const translatedText = response.target.text.trim();
        if (!translatedText) {
          const inputLetters =
            segment.text.normalize("NFKC").match(/\p{L}/gu)?.length ?? 0;
          throw new BergamotRuntimeError(
            "bergamot_runtime_failed",
            "Bergamot returned an empty translation.",
            true,
            `Direction=${sourceLanguage}->${targetLanguage}; empty output; input characters=${segment.text.length}; input letters=${inputLetters}.`,
          );
        }
        return { id: segment.id, translatedText };
      }),
    );
    let removeAbort = (): void => undefined;
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(abortError());
      removeAbort = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([translation, aborted, workerFailed]);
    } catch (error) {
      // Drop this request's still-queued work so a cancelled or failed
      // request does not occupy the shared worker. Work already dispatched to
      // the worker cannot be withdrawn by the library and simply completes.
      translator.remove((request) => submittedRequests.has(request));
      if (signal.aborted) throw abortError();
      if (error instanceof BergamotRuntimeError) throw error;
      const timedOut =
        error instanceof DOMException && error.name === "TimeoutError";
      throw new BergamotRuntimeError(
        timedOut ? "bergamot_timeout" : "bergamot_runtime_failed",
        timedOut
          ? "Bergamot worker stopped making progress."
          : "Bergamot local translation failed.",
        true,
        `Direction=${sourceLanguage}->${targetLanguage}; failure=${boundedFailureReason(error)}.`,
      );
    } finally {
      removeAbort();
      removeFailureListener();
    }
  }

  async resetTranslator(): Promise<void> {
    const state = this.state;
    this.state = undefined;
    if (state) this.clearWatchdog(state);
    await state?.translator.delete().catch(() => undefined);
  }

  private getTranslatorState(): TranslatorState {
    if (this.state) return this.state;
    const workerUrl = browser.runtime.getURL(
      "bergamot/translator-worker.js" as never,
    );
    const backing = new InstalledBergamotBacking(this.storage, workerUrl);
    const state: TranslatorState = {
      translator: new BatchTranslator(
        {
          workerUrl,
          pivotLanguage: "en",
          downloadTimeout: 0,
          cacheSize: 256,
          useNativeIntGemm: false,
          workers: 1,
          batchSize: 8,
          onerror: (error) => this.failTranslator(state, error),
        },
        backing,
      ),
      pending: 0,
      watchdog: undefined,
      failureListeners: new Set(),
    };
    this.state = state;
    return state;
  }

  private trackSubmitted(state: TranslatorState): void {
    state.pending += 1;
    if (state.pending === 1) this.armWatchdog(state);
  }

  private trackSettled(state: TranslatorState, progressed: boolean): void {
    state.pending = Math.max(0, state.pending - 1);
    if (state.pending === 0) this.clearWatchdog(state);
    else if (progressed) this.armWatchdog(state);
  }

  private armWatchdog(state: TranslatorState): void {
    this.clearWatchdog(state);
    state.watchdog = globalThis.setTimeout(() => {
      state.watchdog = undefined;
      // The single WASM worker is stuck on a dispatched batch. The library
      // cannot cancel dispatched work, so the worker must be torn down and
      // every request waiting on it fails (retryable) with a timeout.
      this.failTranslator(
        state,
        new DOMException("Bergamot worker made no progress", "TimeoutError"),
      );
    }, WORKER_NO_PROGRESS_TIMEOUT_MS);
  }

  private clearWatchdog(state: TranslatorState): void {
    if (state.watchdog === undefined) return;
    globalThis.clearTimeout(state.watchdog);
    state.watchdog = undefined;
  }

  private failTranslator(state: TranslatorState, error: Error): void {
    this.clearWatchdog(state);
    state.translator.remove(() => true);
    if (this.state === state) this.state = undefined;
    for (const listener of state.failureListeners) listener(error);
    state.failureListeners.clear();
    void state.translator.delete().catch(() => undefined);
  }

  private async assertRequiredPacks(
    sourceLanguage: BergamotLanguage,
    targetLanguage: BergamotLanguage,
  ): Promise<void> {
    const required = new Set(
      requiredBergamotLanguagePacks(sourceLanguage, targetLanguage),
    );
    const installed = new Set(
      (await this.storage.list())
        .filter((runtime) => runtime.state === "installed")
        .map((runtime) => runtime.packId),
    );
    const missing = [...required].filter((packId) => !installed.has(packId));
    if (missing.length > 0) {
      throw new BergamotRuntimeError(
        "bergamot_package_missing",
        "Required Bergamot language package is not installed.",
        false,
        `Missing packs=${missing.join(",")}.`,
      );
    }
  }
}
