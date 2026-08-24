import { browser } from "wxt/browser";
import { BergamotRuntimeError } from "@/src/local-translation/errors";
import { runtimeId } from "@/src/shared/runtime-id";
import {
  BERGAMOT_OFFSCREEN_TARGET,
  isBergamotOffscreenResponse,
  type BergamotLanguage,
  type BergamotOffscreenRequest,
  type BergamotResponseValue,
} from "@/src/local-translation/types";

const TRANSLATION_TIMEOUT_MS = 3 * 60_000;

function timeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => reject(new DOMException("Timed out", "TimeoutError")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        globalThis.clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class BergamotOffscreenClient {
  async reset(): Promise<void> {
    const requestId = runtimeId("bergamot-reset");
    const value = await this.send(
      {
        target: BERGAMOT_OFFSCREEN_TARGET,
        type: "BERGAMOT_OFFSCREEN_RESET",
        requestId,
      },
      new AbortController().signal,
    );
    if (!("reset" in value) || value.reset !== true) {
      throw new BergamotRuntimeError(
        "bergamot_runtime_failed",
        "Bergamot reset returned an invalid response.",
        true,
      );
    }
  }

  async translate(
    sourceLanguage: BergamotLanguage,
    targetLanguage: BergamotLanguage,
    segments: Array<{ id: string; text: string }>,
    signal: AbortSignal,
  ): Promise<Array<{ id: string; translatedText: string }>> {
    const requestId = runtimeId("bergamot-translate");
    const value = await this.send(
      {
        target: BERGAMOT_OFFSCREEN_TARGET,
        type: "BERGAMOT_OFFSCREEN_TRANSLATE",
        requestId,
        sourceLanguage,
        targetLanguage,
        segments,
      },
      signal,
    );
    if (!("translations" in value)) {
      throw new BergamotRuntimeError(
        "bergamot_runtime_failed",
        "Bergamot returned an invalid response.",
        true,
      );
    }
    return value.translations;
  }

  private async send(
    request: BergamotOffscreenRequest,
    signal: AbortSignal,
  ): Promise<BergamotResponseValue> {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const cancel = (): void => {
      void browser.runtime
        .sendMessage({
          target: BERGAMOT_OFFSCREEN_TARGET,
          type: "BERGAMOT_OFFSCREEN_CANCEL",
          requestId: request.requestId,
        })
        .catch(() => undefined);
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const response: unknown = await timeout(
        browser.runtime.sendMessage(request),
        TRANSLATION_TIMEOUT_MS,
      );
      if (!isBergamotOffscreenResponse(response, request.requestId)) {
        throw new BergamotRuntimeError(
          "bergamot_runtime_failed",
          "Bergamot returned an invalid response.",
          true,
        );
      }
      if (!response.ok || !response.value) {
        const failure = response.error;
        throw new BergamotRuntimeError(
          failure?.code ?? "bergamot_runtime_failed",
          failure?.message ?? "Bergamot local translation failed.",
          failure?.retryable ?? true,
          failure?.details,
        );
      }
      return response.value;
    } catch (error) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
}
