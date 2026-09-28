import { BergamotLocalRuntime } from "@/src/local-translation/runtime";
import { InstalledBergamotBacking } from "@/src/local-translation/backing";
import type { BergamotRuntimeStorage } from "@/src/local-translation/runtime-storage";
import {
  createProtectedText,
  protectedTextParts,
} from "@/src/translation/protected-text";
import { BergamotLocalProvider } from "@/src/translation/providers/bergamot-local";
import { BergamotRuntimeError } from "@/src/local-translation/errors";
import { afterEach, describe, expect, it, vi } from "vitest";

const deleteWorker = vi.fn(() => Promise.resolve());
const removeQueued = vi.fn();
const translatorBehavior = vi.hoisted(() => ({
  translate: undefined as
    | ((request: { text: string }) => Promise<{ target: { text: string } }>)
    | undefined,
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
  },
}));

vi.mock(
  "@mkljczk/bergamot-translator",
  async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    BatchTranslator: class {
      private readonly onerror: (error: Error) => void;

      constructor(options: { onerror: (error: Error) => void }) {
        this.onerror = options.onerror;
      }

      translate(request: {
        text: string;
      }): Promise<{ target: { text: string } }> {
        if (translatorBehavior.translate) {
          return translatorBehavior.translate(request);
        }
        queueMicrotask(() =>
          this.onerror(new Error("worker initialization failed")),
        );
        return new Promise(() => undefined);
      }

      remove = removeQueued;
      delete = deleteWorker;
    },
  }),
);

describe("BergamotLocalRuntime worker lifecycle", () => {
  it("sends only structured-cloneable options when initializing the worker", async () => {
    const messageListeners = new Set<(event: MessageEvent) => void>();
    const postMessage = vi.fn((value: unknown) => {
      structuredClone(value);
      const request = value as { id: number; name: string };
      queueMicrotask(() => {
        for (const listener of messageListeners) {
          listener(
            new MessageEvent("message", {
              data: { id: request.id, result: true },
            }),
          );
        }
      });
    });
    const terminate = vi.fn();
    class CloneCheckingWorker {
      postMessage = postMessage;
      terminate = terminate;

      addEventListener(type: string, listener: EventListener): void {
        if (type === "message") {
          messageListeners.add(listener as (event: MessageEvent) => void);
        }
      }
    }
    vi.stubGlobal("Worker", CloneCheckingWorker);
    const storage = {
      installedModels: vi.fn(() => Promise.resolve([])),
    } as unknown as BergamotRuntimeStorage;
    const backing = new InstalledBergamotBacking(
      storage,
      "chrome-extension://test/bergamot/translator-worker.js",
    );

    const worker = await backing.loadWorker();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
      name: "initialize",
    });
    worker.worker.terminate();
    expect(terminate).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("rejects a worker initialization failure instead of leaving the batch pending", async () => {
    const storage = {
      installedModels: vi.fn(() => Promise.resolve([])),
      list: vi.fn(() =>
        Promise.resolve([
          {
            packId: "zh-Hans-en" as const,
            sourceLanguage: "zh-Hans",
            targetLanguage: "en",
            state: "installed" as const,
          },
        ]),
      ),
    } as unknown as BergamotRuntimeStorage;
    const runtime = new BergamotLocalRuntime(storage);

    await expect(
      runtime.translate(
        "zh-Hans",
        "en",
        [{ id: "one", text: "测试" }],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "bergamot_runtime_failed" });
    expect(removeQueued).toHaveBeenCalled();
    expect(deleteWorker).toHaveBeenCalled();
  });
});

function installedStorage(): BergamotRuntimeStorage {
  return {
    installedModels: vi.fn(() => Promise.resolve([])),
    list: vi.fn(() =>
      Promise.resolve([
        {
          packId: "zh-Hans-en" as const,
          sourceLanguage: "zh-Hans",
          targetLanguage: "en",
          state: "installed" as const,
        },
      ]),
    ),
  } as unknown as BergamotRuntimeStorage;
}

describe("BergamotLocalRuntime progress watchdog", () => {
  afterEach(() => {
    translatorBehavior.translate = undefined;
    vi.useRealTimers();
  });

  it("does not time out queued work while the worker keeps making progress", async () => {
    vi.useFakeTimers();
    let queueTail = Promise.resolve();
    translatorBehavior.translate = (request) => {
      // One worker: each request finishes 40s after the previous one.
      const done = queueTail.then(
        () => new Promise<void>((resolve) => setTimeout(resolve, 40_000)),
      );
      queueTail = done;
      return done.then(() => ({ target: { text: `T:${request.text}` } }));
    };
    const runtime = new BergamotLocalRuntime(installedStorage());

    const translation = runtime.translate(
      "zh-Hans",
      "en",
      [
        { id: "one", text: "一" },
        { id: "two", text: "二" },
        { id: "three", text: "三" },
      ],
      new AbortController().signal,
    );
    const settled = expect(translation).resolves.toEqual([
      { id: "one", translatedText: "T:一" },
      { id: "two", translatedText: "T:二" },
      { id: "three", translatedText: "T:三" },
    ]);
    await vi.advanceTimersByTimeAsync(120_000);
    await settled;
  });

  it("tears down a worker that makes no progress and reports a timeout", async () => {
    vi.useFakeTimers();
    deleteWorker.mockClear();
    translatorBehavior.translate = () => new Promise(() => undefined);
    const runtime = new BergamotLocalRuntime(installedStorage());

    const translation = runtime.translate(
      "zh-Hans",
      "en",
      [{ id: "stuck", text: "卡住" }],
      new AbortController().signal,
    );
    const rejected = expect(translation).rejects.toMatchObject({
      code: "bergamot_timeout",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(deleteWorker).toHaveBeenCalled();
  });

  it("removes only the cancelled request's queued work", async () => {
    removeQueued.mockClear();
    deleteWorker.mockClear();
    const submitted = vi.fn();
    translatorBehavior.translate = () => {
      submitted();
      return new Promise(() => undefined);
    };
    const runtime = new BergamotLocalRuntime(installedStorage());
    const controller = new AbortController();

    const translation = runtime.translate(
      "zh-Hans",
      "en",
      [{ id: "cancel", text: "取消" }],
      controller.signal,
    );
    await vi.waitFor(() => expect(submitted).toHaveBeenCalledOnce());
    controller.abort();

    await expect(translation).rejects.toMatchObject({ name: "AbortError" });
    expect(removeQueued).toHaveBeenCalledOnce();
    const filter = removeQueued.mock.calls[0]?.[0] as (
      request: object,
    ) => boolean;
    expect(filter({ text: "unrelated" })).toBe(false);
    // Cancelling one request must not tear down the shared worker.
    expect(deleteWorker).not.toHaveBeenCalled();
  });
});

describe("BergamotLocalProvider timeout classification", () => {
  it("reports a local timeout as a retryable request_timeout, not a cancellation", async () => {
    const provider = new BergamotLocalProvider({
      client: {
        translate: vi.fn(() =>
          Promise.reject(
            new BergamotRuntimeError(
              "bergamot_timeout",
              "Bergamot offscreen request timed out.",
              true,
              "Offscreen request exceeded 180000 ms.",
            ),
          ),
        ),
      },
    });

    await expect(
      provider.translateBatch(
        {
          sourceLanguage: "zh-CN",
          targetLanguage: "en",
          mode: "fast",
          segments: [{ id: "slow", text: "慢" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "request_failed",
      retryable: true,
      reason: "request_timeout",
    });
  });

  it("keeps an explicit abort classified as cancelled", async () => {
    const provider = new BergamotLocalProvider({
      client: {
        translate: vi.fn(() =>
          Promise.reject(new DOMException("Cancelled", "AbortError")),
        ),
      },
    });

    await expect(
      provider.translateBatch(
        {
          sourceLanguage: "zh-CN",
          targetLanguage: "en",
          mode: "fast",
          segments: [{ id: "cancel", text: "取消" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("BergamotLocalProvider input preparation", () => {
  it("preserves a structured missing-package reason for automatic routing", async () => {
    const provider = new BergamotLocalProvider({
      client: {
        translate: vi.fn(() =>
          Promise.reject(
            new BergamotRuntimeError(
              "bergamot_package_missing",
              "missing package",
              false,
              "Missing packs=ko-en.",
            ),
          ),
        ),
      },
    });

    await expect(
      provider.translateBatch(
        {
          sourceLanguage: "ko",
          targetLanguage: "zh-CN",
          mode: "fast",
          segments: [{ id: "one", text: "한국어" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      reason: "bergamot_package_missing",
    });
  });

  it("preserves format and icon-only parts without sending them to the model", async () => {
    const translate = vi.fn(
      (
        _sourceLanguage: string,
        _targetLanguage: string,
        segments: Array<{ id: string; text: string }>,
      ) =>
        Promise.resolve(
          segments.map((segment) => ({
            id: segment.id,
            translatedText:
              segment.text === "中文内容" ? "Chinese content" : "More",
          })),
        ),
    );
    const provider = new BergamotLocalProvider({ client: { translate } });
    const source = createProtectedText([
      "中文内容",
      "\u200C",
      "\uE123",
      "更多",
    ]);

    const results = await provider.translateBatch(
      {
        sourceLanguage: "zh-CN",
        targetLanguage: "en",
        mode: "fast",
        segments: [
          { id: "protected", text: source, format: "protected-text-v1" },
          { id: "icon", text: "\uE456" },
        ],
      },
      new AbortController().signal,
    );

    expect(translate).toHaveBeenCalledOnce();
    expect(translate.mock.calls[0]?.[2].map(({ text }) => text)).toEqual([
      "中文内容",
      "更多",
    ]);
    expect(protectedTextParts(results[0]?.translatedText ?? "")).toEqual([
      "Chinese content",
      "\u200C",
      "\uE123",
      "More",
    ]);
    expect(results[1]).toEqual({ id: "icon", translatedText: "\uE456" });
  });
});
