import { BergamotLocalRuntime } from "@/src/local-translation/runtime";
import { InstalledBergamotBacking } from "@/src/local-translation/backing";
import type { BergamotRuntimeStorage } from "@/src/local-translation/runtime-storage";
import {
  createProtectedText,
  protectedTextParts,
} from "@/src/translation/protected-text";
import { BergamotLocalProvider } from "@/src/translation/providers/bergamot-local";
import { describe, expect, it, vi } from "vitest";

const deleteWorker = vi.fn(() => Promise.resolve());
const removeQueued = vi.fn();

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

      translate(): Promise<never> {
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

describe("BergamotLocalProvider input preparation", () => {
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
