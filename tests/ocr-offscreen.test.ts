import { OffscreenLocalOcrEngine } from "@/src/ocr/engine";
import { createOcrOffscreenDocumentEnsurer } from "@/src/ocr/offscreen-manager";
import {
  isOcrOffscreenRequest,
  OCR_BACKGROUND_TARGET,
  OCR_CLIENT_TARGET,
  OCR_OFFSCREEN_TARGET,
  shouldRejectMalformedOcrBackgroundMessage,
} from "@/src/ocr/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

type RuntimeListener = (
  message: unknown,
  sender: Browser.runtime.MessageSender,
) => unknown;

const mocks = vi.hoisted(() => ({
  runtimeListeners: new Set<RuntimeListener>(),
  sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "test-extension",
      getURL: (path: string) => `chrome-extension://test-extension/${path}`,
      sendMessage: mocks.sendMessage,
      onMessage: {
        addListener: (listener: RuntimeListener) =>
          mocks.runtimeListeners.add(listener),
        removeListener: (listener: RuntimeListener) =>
          mocks.runtimeListeners.delete(listener),
      },
    },
  },
}));

beforeEach(() => {
  mocks.runtimeListeners.clear();
  mocks.sendMessage.mockReset();
});

describe("offscreen OCR boundary", () => {
  it("coalesces concurrent offscreen document creation", async () => {
    const createDocument = vi.fn(() => Promise.resolve());
    const ensure = createOcrOffscreenDocumentEnsurer({
      getContexts: vi.fn(() => Promise.resolve([])),
      createDocument,
    });
    await Promise.all([ensure(), ensure(), ensure()]);
    expect(createDocument).toHaveBeenCalledOnce();
  });

  it("strictly validates the target, IDs, format, and bounded dimensions", () => {
    const valid = {
      target: OCR_BACKGROUND_TARGET,
      type: "OCR_OFFSCREEN_RECOGNIZE",
      sessionId: "ocr-session-12345678",
      requestId: "ocr-request-12345678",
      image: {
        dataUrl: "data:image/png;base64,iVBORw==",
        width: 320,
        height: 120,
      },
    };
    expect(isOcrOffscreenRequest(valid, OCR_BACKGROUND_TARGET)).toBe(true);
    expect(
      isOcrOffscreenRequest(
        { ...valid, target: "norixortrans-ocr-offscreen" },
        OCR_BACKGROUND_TARGET,
      ),
    ).toBe(false);
    const prepare = {
      target: OCR_BACKGROUND_TARGET,
      type: "OCR_OFFSCREEN_PREPARE",
      sessionId: "ocr-session-12345678",
      requestId: "ocr-request-12345678",
    };
    expect(isOcrOffscreenRequest(prepare, OCR_BACKGROUND_TARGET)).toBe(true);
    expect(
      isOcrOffscreenRequest(
        { ...prepare, sourceLanguage: "en" },
        OCR_BACKGROUND_TARGET,
      ),
    ).toBe(true);
    expect(
      isOcrOffscreenRequest(
        { ...prepare, sourceLanguage: "" },
        OCR_BACKGROUND_TARGET,
      ),
    ).toBe(false);
    expect(
      isOcrOffscreenRequest(
        { ...prepare, sourceLanguage: "x".repeat(65) },
        OCR_BACKGROUND_TARGET,
      ),
    ).toBe(false);
    expect(
      isOcrOffscreenRequest(
        {
          ...prepare,
          type: "OCR_OFFSCREEN_RUNTIME_INVALIDATE",
          language: "chi_tra",
        },
        OCR_BACKGROUND_TARGET,
      ),
    ).toBe(true);
    expect(
      isOcrOffscreenRequest(
        {
          ...prepare,
          type: "OCR_OFFSCREEN_RUNTIME_INVALIDATE",
          language: "rus",
        },
        OCR_BACKGROUND_TARGET,
      ),
    ).toBe(false);
    expect(
      isOcrOffscreenRequest(
        { ...valid, image: { ...valid.image, width: 1_281 } },
        OCR_BACKGROUND_TARGET,
      ),
    ).toBe(false);
    expect(
      isOcrOffscreenRequest(
        {
          ...valid,
          image: { ...valid.image, dataUrl: "data:image/webp;base64,AAAA" },
        },
        OCR_BACKGROUND_TARGET,
      ),
    ).toBe(false);
    expect(
      isOcrOffscreenRequest(
        {
          ...valid,
          image: { ...valid.image, dataUrl: "data:image/jpeg;base64,AAAA" },
        },
        OCR_BACKGROUND_TARGET,
      ),
    ).toBe(true);
  });

  it("uses compact JPEG for video crops and lossless PNG for binary fallback", async () => {
    mocks.sendMessage.mockImplementation((message: unknown) => {
      if (!isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET)) {
        throw new Error("unexpected request");
      }
      return Promise.resolve({
        target: OCR_CLIENT_TARGET,
        type: "OCR_OFFSCREEN_RESPONSE",
        sessionId: message.sessionId,
        requestId: message.requestId,
        ok: true,
        text: "subtitle",
      });
    });
    const original = document.createElement("canvas");
    original.width = 960;
    original.height = 180;
    original.dataset.ocrVariant = "original";
    const originalToDataUrl = vi
      .spyOn(original, "toDataURL")
      .mockReturnValue("data:image/jpeg;base64,AAAA");
    const binary = document.createElement("canvas");
    binary.width = 960;
    binary.height = 180;
    binary.dataset.ocrVariant = "binary";
    const binaryToDataUrl = vi
      .spyOn(binary, "toDataURL")
      .mockReturnValue("data:image/png;base64,AAAA");

    const engine = new OffscreenLocalOcrEngine();
    await engine.recognize(original, new AbortController().signal);
    await engine.recognize(binary, new AbortController().signal);

    expect(originalToDataUrl).toHaveBeenCalledWith("image/jpeg", 0.9);
    expect(binaryToDataUrl).toHaveBeenCalledWith("image/png");
    const requests = mocks.sendMessage.mock.calls.flatMap(([message]) =>
      isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET) &&
      message.type === "OCR_OFFSCREEN_RECOGNIZE"
        ? [message]
        : [],
    );
    expect(requests.map((request) => request.image.dataUrl)).toEqual([
      "data:image/jpeg;base64,AAAA",
      "data:image/png;base64,AAAA",
    ]);
    await engine.destroy?.();
  });

  it("lets the offscreen listener provide the only response to forwarded requests", () => {
    const forwarded = {
      target: OCR_OFFSCREEN_TARGET,
      type: "OCR_OFFSCREEN_PREPARE",
      sessionId: "ocr-session-12345678",
      requestId: "ocr-request-12345678",
    };
    const backgroundResponse = shouldRejectMalformedOcrBackgroundMessage(
      forwarded,
    )
      ? { ok: false, error: "ocr_invalid_request" }
      : undefined;
    const offscreenResponse = isOcrOffscreenRequest(
      forwarded,
      OCR_OFFSCREEN_TARGET,
    )
      ? { ok: true }
      : undefined;
    expect(backgroundResponse).toBeUndefined();
    expect(offscreenResponse).toEqual({ ok: true });
    expect(
      shouldRejectMalformedOcrBackgroundMessage({
        ...forwarded,
        target: OCR_BACKGROUND_TARGET,
        sessionId: "bad id",
      }),
    ).toBe(true);
  });

  it("routes progress and results only to the matching session and request", async () => {
    mocks.sendMessage.mockImplementation((message: unknown) => {
      if (!isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET))
        throw new Error("unexpected request");
      for (const listener of mocks.runtimeListeners) {
        listener(
          {
            target: OCR_CLIENT_TARGET,
            type: "OCR_OFFSCREEN_PROGRESS",
            sessionId: message.sessionId,
            requestId: message.requestId,
            progress: 0.5,
            status: "initializing_ppocr",
          },
          {
            id: "test-extension",
            url: "chrome-extension://test-extension/background.js",
          },
        );
      }
      return Promise.resolve({
        target: OCR_CLIENT_TARGET,
        type: "OCR_OFFSCREEN_RESPONSE",
        sessionId: message.sessionId,
        requestId: message.requestId,
        ok: true,
      });
    });
    const progress = vi.fn();
    const engine = new OffscreenLocalOcrEngine();
    await engine.prepare?.(new AbortController().signal, progress, "zh-CN");
    expect(progress).toHaveBeenCalledWith({
      progress: 0.5,
      status: "initializing_ppocr",
    });
    const request = mocks.sendMessage.mock.calls[0]?.[0];
    expect(isOcrOffscreenRequest(request, OCR_BACKGROUND_TARGET)).toBe(true);
    if (!isOcrOffscreenRequest(request, OCR_BACKGROUND_TARGET))
      throw new Error("missing prepare request");
    expect(request.type).toBe("OCR_OFFSCREEN_PREPARE");
    if (request.type !== "OCR_OFFSCREEN_PREPARE") {
      throw new Error("unexpected OCR request type");
    }
    expect(request.sourceLanguage).toBe("zh-CN");
    expect(request.sessionId).toMatch(/^ocr-session-/u);
    expect(request.requestId).toMatch(/^ocr-prepare-/u);
    await engine.destroy?.();
    expect(mocks.runtimeListeners.size).toBe(0);
  });

  it("ends a stopped session and creates a fresh reusable session", async () => {
    mocks.sendMessage.mockImplementation((message: unknown) => {
      if (!isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET)) {
        throw new Error("unexpected request");
      }
      return Promise.resolve({
        target: OCR_CLIENT_TARGET,
        type: "OCR_OFFSCREEN_RESPONSE",
        sessionId: message.sessionId,
        requestId: message.requestId,
        ok: true,
      });
    });
    const engine = new OffscreenLocalOcrEngine();
    await engine.prepare?.(new AbortController().signal);
    await engine.endSession?.();
    await engine.prepare?.(new AbortController().signal);

    const requests = mocks.sendMessage.mock.calls.map(([message]) => message);
    const firstPrepare = requests.find(
      (message) =>
        isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET) &&
        message.type === "OCR_OFFSCREEN_PREPARE",
    );
    const end = requests.find(
      (message) =>
        isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET) &&
        message.type === "OCR_OFFSCREEN_END_SESSION",
    );
    const secondPrepare = requests.filter(
      (message) =>
        isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET) &&
        message.type === "OCR_OFFSCREEN_PREPARE",
    )[1];
    if (
      !isOcrOffscreenRequest(firstPrepare, OCR_BACKGROUND_TARGET) ||
      !isOcrOffscreenRequest(end, OCR_BACKGROUND_TARGET) ||
      !isOcrOffscreenRequest(secondPrepare, OCR_BACKGROUND_TARGET)
    ) {
      throw new Error("missing OCR lifecycle requests");
    }
    expect(end.sessionId).toBe(firstPrepare.sessionId);
    expect(secondPrepare.sessionId).not.toBe(firstPrepare.sessionId);
    await engine.destroy?.();
  });

  it("retries a failed session cleanup before preparing the next session", async () => {
    let failedFirstEnd = false;
    mocks.sendMessage.mockImplementation((message: unknown) => {
      if (!isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET)) {
        throw new Error("unexpected request");
      }
      if (message.type === "OCR_OFFSCREEN_END_SESSION" && !failedFirstEnd) {
        failedFirstEnd = true;
        return Promise.reject(new Error("temporary offscreen failure"));
      }
      return Promise.resolve({
        target: OCR_CLIENT_TARGET,
        type: "OCR_OFFSCREEN_RESPONSE",
        sessionId: message.sessionId,
        requestId: message.requestId,
        ok: true,
      });
    });
    const engine = new OffscreenLocalOcrEngine();
    await engine.prepare?.(new AbortController().signal);
    await engine.endSession?.();
    await engine.prepare?.(new AbortController().signal);

    const requests = mocks.sendMessage.mock.calls.flatMap(([message]) =>
      isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET) ? [message] : [],
    );
    const prepares = requests.filter(
      (request) => request.type === "OCR_OFFSCREEN_PREPARE",
    );
    const ends = requests.filter(
      (request) => request.type === "OCR_OFFSCREEN_END_SESSION",
    );
    expect(prepares).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(ends[1]?.sessionId).toBe(ends[0]?.sessionId);
    expect(requests.indexOf(ends[1]!)).toBeLessThan(
      requests.indexOf(prepares[1]!),
    );
    await engine.destroy?.();
  });

  it("sends an exact cancellation envelope and never leaves the caller pending", async () => {
    mocks.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "OCR_OFFSCREEN_CANCEL"
      ) {
        return Promise.resolve({ ok: true });
      }
      return new Promise(() => undefined);
    });
    const engine = new OffscreenLocalOcrEngine();
    const controller = new AbortController();
    const pending = engine.prepare?.(controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const prepare = mocks.sendMessage.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "OCR_OFFSCREEN_PREPARE",
    )?.[0] as { sessionId: string; requestId: string };
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      target: OCR_BACKGROUND_TARGET,
      type: "OCR_OFFSCREEN_CANCEL",
      sessionId: prepare.sessionId,
      requestId: prepare.requestId,
    });
  });
});
