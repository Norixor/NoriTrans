import { browser } from "wxt/browser";
import { runtimeId } from "@/src/shared/runtime-id";
import {
  isOcrOffscreenProgress,
  isOcrOffscreenResponse,
  OCR_BACKGROUND_TARGET,
  OCR_MAX_IMAGE_HEIGHT,
  OCR_MAX_IMAGE_PIXELS,
  OCR_MAX_IMAGE_WIDTH,
  type OcrOffscreenRequest,
  type OcrOffscreenResponse,
  type OcrTextBox,
} from "@/src/ocr/types";

export interface OcrEngineProgress {
  progress: number;
  status: string;
}

export interface OcrRecognition {
  text: string;
  /** OCR confidence in the inclusive 0-100 range, when available. */
  confidence?: number;
  /** Spatial lines in source-canvas pixels, bounded by the offscreen bridge. */
  boxes?: OcrTextBox[];
}

export type OcrRecognitionResult = string | OcrRecognition;

export function ocrRecognitionText(result: OcrRecognitionResult): string {
  return typeof result === "string" ? result : result.text;
}

export interface LocalOcrEngine {
  availability(): Promise<"available" | "unavailable">;
  prepare?(
    signal: AbortSignal,
    onProgress?: (progress: OcrEngineProgress) => void,
    sourceLanguage?: string,
  ): Promise<void>;
  recognize(
    source: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<OcrRecognitionResult>;
  endSession?(): Promise<void>;
  destroy?(): Promise<void>;
}

interface DetectedText {
  rawValue?: string;
}

interface TextDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedText[]>;
}

type TextDetectorConstructor = new () => TextDetectorLike;

function localTextDetector(): TextDetectorConstructor | undefined {
  const value = (globalThis as typeof globalThis & { TextDetector?: unknown })
    .TextDetector;
  return typeof value === "function"
    ? (value as TextDetectorConstructor)
    : undefined;
}

function abortError(): Error {
  const error = new Error("OCR cancelled.");
  error.name = "AbortError";
  return error;
}

function normalizeOcrText(text: string): string {
  const lines = text
    .split(/\r?\n/gu)
    .map((line) => line.replace(/[ \t]+/gu, " ").trim())
    .filter((line, index, values) => line && line !== values[index - 1]);
  const normalized = lines.join("\n").trim().slice(0, 2_000);
  return /[\p{L}\p{N}]/u.test(normalized) ? normalized : "";
}

export function normalizeRecognizedText(
  results: readonly DetectedText[],
): string {
  return normalizeOcrText(
    results.flatMap((result) => result.rawValue ?? []).join("\n"),
  );
}

export class BrowserLocalOcrEngine implements LocalOcrEngine {
  availability(): Promise<"available" | "unavailable"> {
    return Promise.resolve(localTextDetector() ? "available" : "unavailable");
  }

  async recognize(
    source: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) throw abortError();
    const Constructor = localTextDetector();
    if (!Constructor) throw new Error("local_ocr_unavailable");
    const results = await new Constructor().detect(source);
    if (signal.aborted) throw abortError();
    return normalizeRecognizedText(results);
  }
}

const OCR_PREPARE_TIMEOUT_MS = 90_000;
const OCR_RECOGNIZE_TIMEOUT_MS = 45_000;
const OCR_END_SESSION_TIMEOUT_MS = 5_000;

/**
 * Content-script facade for the extension-origin OCR worker. Only the already
 * cropped canvas is serialized; screenshots and page/video state stay in the
 * content script.
 */
export class OffscreenLocalOcrEngine implements LocalOcrEngine {
  private sessionId = runtimeId("ocr-session");
  private readonly progressListeners = new Map<
    string,
    (progress: OcrEngineProgress) => void
  >();
  private destroyed = false;
  private sessionActive = false;
  private preparedSourceLanguage: string | undefined;
  private readonly pendingEndSessionIds = new Set<string>();

  constructor() {
    browser.runtime.onMessage.addListener(this.handleProgress);
  }

  availability(): Promise<"available" | "unavailable"> {
    return Promise.resolve(
      typeof browser.runtime.sendMessage === "function"
        ? "available"
        : "unavailable",
    );
  }

  async prepare(
    signal: AbortSignal,
    onProgress?: (progress: OcrEngineProgress) => void,
    sourceLanguage?: string,
  ): Promise<void> {
    if (this.pendingEndSessionIds.size > 0) {
      await this.retryPendingEndSessions(signal);
    }
    this.sessionActive = true;
    this.preparedSourceLanguage = sourceLanguage;
    const currentRequestId = runtimeId("ocr-prepare");
    await this.send(
      {
        target: OCR_BACKGROUND_TARGET,
        type: "OCR_OFFSCREEN_PREPARE",
        sessionId: this.sessionId,
        requestId: currentRequestId,
        ...(sourceLanguage ? { sourceLanguage } : {}),
      },
      signal,
      OCR_PREPARE_TIMEOUT_MS,
      onProgress,
    );
  }

  async recognize(
    source: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<OcrRecognition> {
    if (
      !Number.isInteger(source.width) ||
      source.width <= 0 ||
      source.width > OCR_MAX_IMAGE_WIDTH ||
      !Number.isInteger(source.height) ||
      source.height <= 0 ||
      source.height > OCR_MAX_IMAGE_HEIGHT ||
      source.width * source.height > OCR_MAX_IMAGE_PIXELS
    ) {
      throw new Error("ocr_image_dimensions_invalid");
    }
    if (signal.aborted) throw abortError();
    this.sessionActive = true;
    // Original video crops contain high-frequency backgrounds and are much
    // cheaper to transfer as bounded JPEG. Keep the binary fallback lossless
    // because its flat black/white mask is already compact and compression
    // artifacts would be counterproductive for recognition.
    const dataUrl =
      source.dataset.ocrVariant === "binary"
        ? source.toDataURL("image/png")
        : source.toDataURL("image/jpeg", 0.9);
    const recognize = () =>
      this.send(
        {
          target: OCR_BACKGROUND_TARGET,
          type: "OCR_OFFSCREEN_RECOGNIZE",
          sessionId: this.sessionId,
          requestId: runtimeId("ocr-recognize"),
          image: { dataUrl, width: source.width, height: source.height },
        },
        signal,
        OCR_RECOGNIZE_TIMEOUT_MS,
      );
    let response: OcrOffscreenResponse;
    try {
      response = await recognize();
    } catch (error) {
      // Chrome may recycle the offscreen document while a video has a long
      // subtitle-free interval. Recreate only the missing session and retry
      // the current frame once; an empty OCR result remains a normal success.
      if (
        !(error instanceof Error) ||
        error.message !== "ocr_session_not_prepared"
      ) {
        throw error;
      }
      await this.prepare(signal, undefined, this.preparedSourceLanguage);
      response = await recognize();
    }
    return {
      text: response.text ?? "",
      ...(response.confidence === undefined
        ? {}
        : { confidence: response.confidence }),
      ...(response.boxes ? { boxes: response.boxes } : {}),
    };
  }

  async endSession(): Promise<void> {
    if (this.destroyed || !this.sessionActive) return;
    this.sessionActive = false;
    const endingSessionId = this.sessionId;
    this.sessionId = runtimeId("ocr-session");
    this.pendingEndSessionIds.add(endingSessionId);
    const controller = new AbortController();
    const currentRequestId = runtimeId("ocr-end");
    try {
      await this.send(
        {
          target: OCR_BACKGROUND_TARGET,
          type: "OCR_OFFSCREEN_END_SESSION",
          sessionId: endingSessionId,
          requestId: currentRequestId,
        },
        controller.signal,
        OCR_END_SESSION_TIMEOUT_MS,
      );
      this.pendingEndSessionIds.delete(endingSessionId);
    } catch {
      // Retry before the next prepare so a transient runtime failure cannot
      // retain an old worker session indefinitely.
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.endSession();
    await this.retryPendingEndSessions(new AbortController().signal);
    this.destroyed = true;
    browser.runtime.onMessage.removeListener(this.handleProgress);
  }

  private async retryPendingEndSessions(signal: AbortSignal): Promise<void> {
    for (const sessionId of [...this.pendingEndSessionIds]) {
      if (signal.aborted) throw abortError();
      try {
        await this.send(
          {
            target: OCR_BACKGROUND_TARGET,
            type: "OCR_OFFSCREEN_END_SESSION",
            sessionId,
            requestId: runtimeId("ocr-end-retry"),
          },
          signal,
          OCR_END_SESSION_TIMEOUT_MS,
        );
        this.pendingEndSessionIds.delete(sessionId);
      } catch (error) {
        if (signal.aborted) throw error;
      }
    }
  }

  private readonly handleProgress = (
    message: unknown,
    sender: Browser.runtime.MessageSender,
  ): undefined => {
    if (
      sender.id !== browser.runtime.id ||
      sender.url !== browser.runtime.getURL("background.js" as never) ||
      !isOcrOffscreenProgress(message) ||
      message.sessionId !== this.sessionId
    ) {
      return undefined;
    }
    this.progressListeners.get(message.requestId)?.({
      progress: message.progress,
      status: message.status,
    });
    return undefined;
  };

  private send(
    request: OcrOffscreenRequest,
    signal: AbortSignal,
    timeoutMs: number,
    onProgress?: (progress: OcrEngineProgress) => void,
  ): Promise<OcrOffscreenResponse> {
    if (this.destroyed && request.type !== "OCR_OFFSCREEN_END_SESSION") {
      return Promise.reject(new Error("ocr_session_destroyed"));
    }
    if (signal.aborted) return Promise.reject(abortError());
    if (onProgress) this.progressListeners.set(request.requestId, onProgress);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        globalThis.clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        this.progressListeners.delete(request.requestId);
      };
      const settleError = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const cancelRemote = (): void => {
        if (
          request.type === "OCR_OFFSCREEN_CANCEL" ||
          request.type === "OCR_OFFSCREEN_END_SESSION"
        ) {
          return;
        }
        void browser.runtime
          .sendMessage({
            target: OCR_BACKGROUND_TARGET,
            type: "OCR_OFFSCREEN_CANCEL",
            sessionId: request.sessionId,
            requestId: request.requestId,
          } satisfies OcrOffscreenRequest)
          .catch(() => undefined);
      };
      const abort = (): void => {
        cancelRemote();
        settleError(abortError());
      };
      const timeout = globalThis.setTimeout(() => {
        cancelRemote();
        settleError(new Error("ocr_request_timeout"));
      }, timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      void browser.runtime.sendMessage(request).then(
        (response: unknown) => {
          if (settled) return;
          if (
            !isOcrOffscreenResponse(
              response,
              request.sessionId,
              request.requestId,
            )
          ) {
            settleError(new Error("ocr_invalid_response"));
            return;
          }
          if (!response.ok) {
            settleError(new Error(response.error ?? "ocr_request_failed"));
            return;
          }
          settled = true;
          cleanup();
          resolve(response);
        },
        (error: unknown) => {
          settleError(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
    });
  }
}

export function createLocalOcrEngine(): LocalOcrEngine {
  return new OffscreenLocalOcrEngine();
}
