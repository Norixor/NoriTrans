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

export class BergamotLocalRuntime {
  private translator: BatchTranslator | undefined;
  private readonly translatorFailureListeners = new Set<
    (error: Error) => void
  >();

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
    const translator = this.getTranslator();
    const submittedRequests = new Set<object>();
    let removeFailureListener = (): void => undefined;
    const workerFailed = new Promise<never>((_, reject) => {
      const listener = (error: Error): void => reject(error);
      this.translatorFailureListeners.add(listener);
      removeFailureListener = () =>
        this.translatorFailureListeners.delete(listener);
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
        const response = await translator.translate(workerRequest);
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
      const onAbort = (): void => {
        translator.remove((request) => submittedRequests.has(request));
        reject(abortError());
      };
      removeAbort = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeoutId = globalThis.setTimeout(() => {
        const error = new DOMException(
          "Bergamot worker timed out",
          "TimeoutError",
        );
        this.failTranslator(translator, error);
        reject(error);
      }, 60_000);
    });
    try {
      return await Promise.race([translation, aborted, workerFailed, timedOut]);
    } catch (error) {
      if (signal.aborted) throw abortError();
      if (error instanceof BergamotRuntimeError) throw error;
      throw new BergamotRuntimeError(
        "bergamot_runtime_failed",
        "Bergamot local translation failed.",
        true,
        `Direction=${sourceLanguage}->${targetLanguage}; failure=${boundedFailureReason(error)}.`,
      );
    } finally {
      removeAbort();
      removeFailureListener();
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
    }
  }

  async resetTranslator(): Promise<void> {
    const translator = this.translator;
    this.translator = undefined;
    await translator?.delete().catch(() => undefined);
  }

  private getTranslator(): BatchTranslator {
    if (this.translator) return this.translator;
    const workerUrl = browser.runtime.getURL(
      "bergamot/translator-worker.js" as never,
    );
    const backing = new InstalledBergamotBacking(this.storage, workerUrl);
    const translator = new BatchTranslator(
      {
        workerUrl,
        pivotLanguage: "en",
        downloadTimeout: 0,
        cacheSize: 256,
        useNativeIntGemm: false,
        workers: 1,
        batchSize: 8,
        onerror: (error) => this.failTranslator(translator, error),
      },
      backing,
    );
    this.translator = translator;
    return translator;
  }

  private failTranslator(translator: BatchTranslator, error: Error): void {
    translator.remove(() => true);
    if (this.translator === translator) this.translator = undefined;
    for (const listener of this.translatorFailureListeners) listener(error);
    this.translatorFailureListeners.clear();
    void translator.delete().catch(() => undefined);
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
