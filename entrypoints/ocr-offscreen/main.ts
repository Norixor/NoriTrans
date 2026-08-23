import {
  selectInstalledOcrRuntime,
  type OcrRuntimeLanguage,
} from "@/src/ocr/languages";
import { OcrPackEnginePool } from "@/src/ocr/engine-pool";
import { PaddleOcrEngine } from "@/src/ocr/paddle-engine";
import { installedLanguages } from "@/src/ocr/runtime-storage";
import { ocrRecognitionText } from "@/src/ocr/engine";
import {
  isOcrOffscreenRequest,
  OCR_BACKGROUND_TARGET,
  OCR_CLIENT_TARGET,
  OCR_OFFSCREEN_TARGET,
  type OcrOffscreenRequest,
  type OcrOffscreenResponse,
  type OcrTextBox,
} from "@/src/ocr/types";
import { browser } from "wxt/browser";

const enginePool = new OcrPackEnginePool(
  (language) => new PaddleOcrEngine({ language }),
);
const activeRequests = new Map<string, AbortController>();
let operationQueue: Promise<void> = Promise.resolve();

async function invalidateRuntime(language: OcrRuntimeLanguage): Promise<void> {
  await enginePool.invalidate(language);
}

function engineForSession(sessionId: string): PaddleOcrEngine {
  return enginePool.engineForSession(sessionId);
}

async function releaseSessionEngine(sessionId: string): Promise<void> {
  await enginePool.release(sessionId);
}

function requestKey(request: OcrOffscreenRequest): string {
  return `${request.sessionId}:${request.requestId}`;
}

function response(
  request: OcrOffscreenRequest,
  result:
    | {
        ok: true;
        text?: string;
        confidence?: number;
        boxes?: OcrTextBox[];
      }
    | { ok: false; error: string },
): OcrOffscreenResponse {
  return {
    target: OCR_CLIENT_TARGET,
    type: "OCR_OFFSCREEN_RESPONSE",
    sessionId: request.sessionId,
    requestId: request.requestId,
    ...result,
  };
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "ocr_cancelled";
  return error instanceof Error
    ? error.message
        .replace(/chrome-extension:\/\/[^/]+/gu, "extension:")
        .slice(0, 240)
    : "ocr_request_failed";
}

async function decodeImage(
  request: Extract<OcrOffscreenRequest, { type: "OCR_OFFSCREEN_RECOGNIZE" }>,
  signal: AbortSignal,
): Promise<HTMLCanvasElement> {
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      cleanup();
      reject(new DOMException("OCR cancelled.", "AbortError"));
    };
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("ocr_image_decode_failed"));
    };
    signal.addEventListener("abort", abort, { once: true });
    image.src = request.image.dataUrl;
  });
  if (
    image.naturalWidth !== request.image.width ||
    image.naturalHeight !== request.image.height
  ) {
    throw new Error("ocr_image_dimensions_mismatch");
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("ocr_canvas_unavailable");
  context.drawImage(image, 0, 0);
  return canvas;
}

async function execute(
  request: OcrOffscreenRequest,
  controller: AbortController,
): Promise<OcrOffscreenResponse> {
  try {
    if (request.type === "OCR_OFFSCREEN_PREPARE") {
      const language = selectInstalledOcrRuntime(
        request.sourceLanguage,
        await installedLanguages(),
      );
      if (!language) throw new Error("ocr_runtime_missing");
      const selected = await enginePool.assign(request.sessionId, language);
      await selected.engine.prepare?.(
        controller.signal,
        ({ progress, status }) => {
          void browser.runtime
            .sendMessage({
              target: OCR_BACKGROUND_TARGET,
              type: "OCR_OFFSCREEN_PROGRESS",
              sessionId: request.sessionId,
              requestId: request.requestId,
              progress,
              status: status.slice(0, 120),
            })
            .catch(() => undefined);
        },
      );
      return response(request, { ok: true });
    }
    if (request.type === "OCR_OFFSCREEN_RECOGNIZE") {
      const engine = engineForSession(request.sessionId);
      const canvas = await decodeImage(request, controller.signal);
      try {
        const recognition = await engine.recognize(canvas, controller.signal);
        return response(request, {
          ok: true,
          text: ocrRecognitionText(recognition),
          ...(typeof recognition === "string" ||
          recognition.confidence === undefined
            ? {}
            : { confidence: recognition.confidence }),
          ...(typeof recognition === "string" || !recognition.boxes
            ? {}
            : { boxes: recognition.boxes }),
        });
      } finally {
        canvas.width = 1;
        canvas.height = 1;
      }
    }
    if (request.type === "OCR_OFFSCREEN_END_SESSION") {
      await releaseSessionEngine(request.sessionId);
      return response(request, { ok: true });
    }
    if (request.type === "OCR_OFFSCREEN_RUNTIME_INVALIDATE") {
      await invalidateRuntime(request.language);
      return response(request, { ok: true });
    }
    return response(request, { ok: true });
  } catch (error) {
    return response(request, { ok: false, error: safeError(error) });
  }
}

function cancel(request: OcrOffscreenRequest): OcrOffscreenResponse {
  activeRequests.get(requestKey(request))?.abort();
  return response(request, { ok: true });
}

browser.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse) => {
    if (
      sender.id !== browser.runtime.id ||
      sender.tab !== undefined ||
      !isOcrOffscreenRequest(message, OCR_OFFSCREEN_TARGET)
    ) {
      return undefined;
    }
    if (message.type === "OCR_OFFSCREEN_CANCEL") {
      sendResponse(cancel(message));
      return false;
    }
    if (message.type === "OCR_OFFSCREEN_END_SESSION") {
      for (const [key, controller] of activeRequests) {
        if (key.startsWith(`${message.sessionId}:`)) controller.abort();
      }
    }
    const controller = new AbortController();
    const key = requestKey(message);
    activeRequests.set(key, controller);
    const operation = operationQueue.then(() => execute(message, controller));
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation
      .finally(() => {
        if (activeRequests.get(key) === controller) activeRequests.delete(key);
      })
      .then(sendResponse);
    return true;
  },
);
