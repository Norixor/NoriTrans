import { translateInBackground } from "@/src/translation/service";
import { createProtectedText } from "@/src/translation/protected-text";
import { DEFAULT_SETTINGS } from "@/src/shared/settings";
import type {
  TranslationProgressCallback,
  TranslationRequest,
} from "@/src/translation/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as OpenAICompatibleModule from "@/src/translation/providers/openai-compatible";

const mocks = vi.hoisted(() => ({
  getCachedTranslation: vi.fn<(key: string) => Promise<string | undefined>>(
    () => Promise.resolve(undefined),
  ),
  setCachedTranslation: vi.fn(() => Promise.resolve()),
  translateBatch:
    vi.fn<
      (
        request: unknown,
        signal: AbortSignal,
        onProgress?: TranslationProgressCallback,
      ) => Promise<Array<{ id: string; translatedText: string }>>
    >(),
}));

vi.mock("@/src/cache/database", () => ({
  getCachedTranslation: mocks.getCachedTranslation,
  setCachedTranslation: mocks.setCachedTranslation,
}));

vi.mock("@/src/translation/providers/openai-compatible", () => ({
  OpenAICompatibleProvider: class {
    readonly id = "openai-compatible";
    readonly mode = "ai" as const;
    readonly capabilities = {
      maxBatchCharacters: 12_000,
      maxBatchSegments: 40,
      supportsContext: true,
      runtime: "background" as const,
    };

    translateBatch(
      request: unknown,
      signal: AbortSignal,
      onProgress?: TranslationProgressCallback,
    ): Promise<Array<{ id: string; translatedText: string }>> {
      return mocks.translateBatch(request, signal, onProgress);
    }
  },
}));

describe("background translation cache lifecycle", () => {
  beforeEach(() => {
    mocks.getCachedTranslation.mockReset().mockResolvedValue(undefined);
    mocks.setCachedTranslation.mockReset().mockResolvedValue(undefined);
    mocks.translateBatch.mockReset();
  });

  it("does not repopulate cache when a provider resolves after cancellation", async () => {
    let resolveProvider:
      | ((results: Array<{ id: string; translatedText: string }>) => void)
      | undefined;
    mocks.translateBatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
        }),
    );
    const controller = new AbortController();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";
    const pending = translateInBackground(
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: [{ id: "late", text: "Late result" }],
      },
      settings,
      controller.signal,
    );

    await vi.waitFor(() => expect(resolveProvider).toBeTypeOf("function"));
    controller.abort();
    resolveProvider?.([{ id: "late", translatedText: "迟到结果" }]);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.setCachedTranslation).not.toHaveBeenCalled();
  });

  it("stops waiting for an in-flight cache read as soon as translation is cancelled", async () => {
    mocks.getCachedTranslation.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";
    const pending = translateInBackground(
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: [{ id: "cancel-cache-read", text: "Cancel cache read" }],
      },
      settings,
      controller.signal,
    );

    await vi.waitFor(() =>
      expect(mocks.getCachedTranslation).toHaveBeenCalledOnce(),
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.translateBatch).not.toHaveBeenCalled();
  });

  it("treats a rejected cache read as a miss and still calls the Provider", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.getCachedTranslation.mockRejectedValue(
      new DOMException(
        "The database connection is closing.",
        "InvalidStateError",
      ),
    );
    mocks.translateBatch.mockResolvedValue([
      { id: "cache-read-failure", translatedText: "仍然翻译" },
    ]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";

    await expect(
      translateInBackground(
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [{ id: "cache-read-failure", text: "Still translate" }],
        },
        settings,
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      { id: "cache-read-failure", translatedText: "仍然翻译" },
    ]);
    expect(mocks.translateBatch).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("cache_read_failed"),
    );
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("Still translate");
    warn.mockRestore();
  });

  it("does not turn another request's queued cache reads into misses when one request aborts", async () => {
    const pendingReads = new Map<string, () => void>();
    mocks.getCachedTranslation.mockImplementation(
      (key) =>
        new Promise<string | undefined>((resolve) => {
          pendingReads.set(key, () => resolve("缓存命中"));
        }),
    );
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";
    const abortedController = new AbortController();
    const saturating = translateInBackground(
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: Array.from({ length: 8 }, (_, index) => ({
          id: `saturating-${index}`,
          text: `Saturating read ${index}`,
        })),
      },
      settings,
      abortedController.signal,
    );
    await vi.waitFor(() =>
      expect(mocks.getCachedTranslation).toHaveBeenCalledTimes(8),
    );
    const queued = translateInBackground(
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: [{ id: "other-tab", text: "Other tab" }],
      },
      settings,
      new AbortController().signal,
    );
    await Promise.resolve();
    expect(mocks.getCachedTranslation).toHaveBeenCalledTimes(8);

    abortedController.abort();
    await expect(saturating).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() =>
      expect(mocks.getCachedTranslation).toHaveBeenCalledTimes(9),
    );
    const lastKey = mocks.getCachedTranslation.mock.calls[8]?.[0];
    if (lastKey) pendingReads.get(lastKey)?.();

    await expect(queued).resolves.toEqual([
      { id: "other-tab", translatedText: "缓存命中" },
    ]);
    expect(mocks.translateBatch).not.toHaveBeenCalled();
  });

  it("bypasses translation cache for connection probes", async () => {
    mocks.translateBatch.mockResolvedValue([
      { id: "connection-test", translatedText: "你好" },
    ]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";

    await expect(
      translateInBackground(
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [{ id: "connection-test", text: "Hello" }],
        },
        settings,
        new AbortController().signal,
        { cachePolicy: "bypass" },
      ),
    ).resolves.toEqual([{ id: "connection-test", translatedText: "你好" }]);
    expect(mocks.getCachedTranslation).not.toHaveBeenCalled();
    expect(mocks.setCachedTranslation).not.toHaveBeenCalled();
  });

  it("stops dispatching cache reads after the uncancellable pool times out", async () => {
    const cacheResolvers: Array<() => void> = [];
    mocks.getCachedTranslation.mockImplementation(
      () =>
        new Promise<string | undefined>((resolve) => {
          cacheResolvers.push(() => resolve(undefined));
        }),
    );
    mocks.translateBatch.mockImplementation((request) => {
      const segments = (request as { segments: Array<{ id: string }> })
        .segments;
      return Promise.resolve(
        segments.map((segment) => ({
          id: segment.id,
          translatedText: `缓存超时后翻译 ${segment.id}`,
        })),
      );
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";
    const segments = Array.from({ length: 40 }, (_, index) => ({
      id: `cache-timeout-${index + 1}`,
      text: `Do not wait forever ${index + 1}`,
    }));

    const pending = translateInBackground(
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments,
      },
      settings,
      new AbortController().signal,
    );

    await vi.waitFor(
      () => expect(mocks.translateBatch).toHaveBeenCalledOnce(),
      {
        timeout: 800,
      },
    );
    expect(mocks.getCachedTranslation).toHaveBeenCalledTimes(8);
    for (const resolve of cacheResolvers) resolve();
    await expect(pending).resolves.toEqual(
      segments.map((segment) => ({
        id: segment.id,
        translatedText: `缓存超时后翻译 ${segment.id}`,
      })),
    );
  });

  it("keeps background cache reads globally bounded across one large request", async () => {
    let activeReads = 0;
    let maximumActiveReads = 0;
    mocks.getCachedTranslation.mockImplementation(async () => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 8));
      activeReads -= 1;
      return undefined;
    });
    mocks.translateBatch.mockImplementation((request) => {
      const segments = (
        request as { segments: Array<{ id: string; text: string }> }
      ).segments;
      return Promise.resolve(
        segments.map((segment) => ({
          id: segment.id,
          translatedText: `T:${segment.text}`,
        })),
      );
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";
    const segments = Array.from({ length: 96 }, (_, index) => ({
      id: `bounded-${index + 1}`,
      text: `Bounded cache read ${index + 1}`,
    }));

    await expect(
      translateInBackground(
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments,
        },
        settings,
        new AbortController().signal,
      ),
    ).resolves.toHaveLength(96);
    expect(maximumActiveReads).toBe(8);
  });

  it("uses a cache hit that arrives after 200ms without spending a Provider request", async () => {
    mocks.getCachedTranslation.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("迟到但有效的缓存"), 250);
        }),
    );
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";

    await expect(
      translateInBackground(
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [{ id: "late-cache-hit", text: "Late cache hit" }],
        },
        settings,
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      { id: "late-cache-hit", translatedText: "迟到但有效的缓存" },
    ]);
    expect(mocks.translateBatch).not.toHaveBeenCalled();
  });

  it("reports a valid translation before a slow best-effort cache write finishes", async () => {
    mocks.translateBatch.mockResolvedValue([
      { id: "streamed", translatedText: "已翻译" },
    ]);
    let finishCacheWrite: (() => void) | undefined;
    const cacheWriter = {
      set: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishCacheWrite = resolve;
          }),
      ),
    };
    const onProgress = vi.fn();
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";
    const pending = translateInBackground(
      {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
        segments: [{ id: "streamed", text: "Translated" }],
      },
      settings,
      new AbortController().signal,
      { cacheWriter, onProgress },
    );

    await vi.waitFor(() =>
      expect(onProgress).toHaveBeenCalledWith({
        id: "streamed",
        translatedText: "已翻译",
      }),
    );
    expect(cacheWriter.set).toHaveBeenCalledTimes(1);
    finishCacheWrite?.();
    await expect(pending).resolves.toEqual([
      { id: "streamed", translatedText: "已翻译" },
    ]);
  });

  it("keeps a valid translation when a best-effort cache write fails", async () => {
    mocks.translateBatch.mockResolvedValue([
      { id: "cache-failure", translatedText: "有效译文" },
    ]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";

    await expect(
      translateInBackground(
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [{ id: "cache-failure", text: "Valid translation" }],
        },
        settings,
        new AbortController().signal,
        {
          cacheWriter: {
            set: () => Promise.reject(new Error("IndexedDB unavailable")),
          },
        },
      ),
    ).resolves.toEqual([{ id: "cache-failure", translatedText: "有效译文" }]);
  });

  it("treats an invalid protected cached value as a miss", async () => {
    const source = createProtectedText(["Hello ", "world"]);
    const translated = source
      .replace("Hello ", "你好")
      .replace("world", "世界");
    mocks.getCachedTranslation.mockResolvedValue("marker-free stale value");
    mocks.translateBatch.mockResolvedValue([
      { id: "protected-cache", translatedText: translated },
    ]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";

    await expect(
      translateInBackground(
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [
            {
              id: "protected-cache",
              text: source,
              format: "protected-text-v1",
            },
          ],
        },
        settings,
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ id: "protected-cache", translatedText: translated }]);
    expect(mocks.translateBatch).toHaveBeenCalledOnce();
    expect(mocks.setCachedTranslation).toHaveBeenCalledOnce();
  });

  it("treats a blank plain cached value as a miss", async () => {
    mocks.getCachedTranslation.mockResolvedValue("   ");
    mocks.translateBatch.mockResolvedValue([
      { id: "blank-cache", translatedText: "有效译文" },
    ]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";

    await expect(
      translateInBackground(
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [{ id: "blank-cache", text: "Translate me" }],
        },
        settings,
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ id: "blank-cache", translatedText: "有效译文" }]);
    expect(mocks.translateBatch).toHaveBeenCalledOnce();
  });

  it("rejects a provider label without a translation before caching it", async () => {
    mocks.translateBatch.mockResolvedValue([
      { id: "label-only", translatedText: "译文：" },
    ]);
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.aiProvider = "openai-compatible";

    await expect(
      translateInBackground(
        {
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          segments: [{ id: "label-only", text: "Keep the original" }],
        },
        settings,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(mocks.setCachedTranslation).not.toHaveBeenCalled();
  });

  describe("with the real OpenAI-compatible Provider", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function wireIds(init?: RequestInit): string[] {
      if (typeof init?.body !== "string") {
        throw new Error("missing Provider request body");
      }
      const body = JSON.parse(init.body) as {
        messages: Array<{ role: string; content: string }>;
      };
      const user = body.messages.find((message) => message.role === "user");
      const input = JSON.parse(user?.content ?? "{}") as {
        segments: Array<[string, ...unknown[]]>;
      };
      return input.segments.map((segment) => segment[0]);
    }

    function completion(results: unknown[]): Response {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ results }) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    it("never caches or reports either copy of a duplicated result ID", async () => {
      const actual = await vi.importActual<typeof OpenAICompatibleModule>(
        "@/src/translation/providers/openai-compatible",
      );
      const real = new actual.OpenAICompatibleProvider("ai", {
        baseUrl: "https://provider.example/v1",
        apiKey: "test-only-key",
        model: "test-model",
        systemPrompt: "Translate",
        timeoutMs: 5_000,
      });
      mocks.translateBatch.mockImplementation((request, signal, onProgress) =>
        real.translateBatch(request as TranslationRequest, signal, onProgress),
      );
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce((_input, init) => {
          const [first = "", second = "", third = ""] = wireIds(init);
          return Promise.resolve(
            completion([
              { id: first, translatedText: "错位译文" },
              { id: second, translatedText: "贝塔" },
              { id: first, translatedText: "重复译文" },
              { id: third, translatedText: "伽马" },
            ]),
          );
        })
        // The isolated recovery request for the duplicated ID also fails.
        .mockImplementationOnce(() => Promise.resolve(completion([])));
      vi.stubGlobal("fetch", fetch);
      const onProgress = vi.fn();
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.provider.aiProvider = "openai-compatible";

      await expect(
        translateInBackground(
          {
            sourceLanguage: "en",
            targetLanguage: "zh-CN",
            mode: "ai",
            responseMode: "batch",
            segments: [
              { id: "alpha", text: "Alpha" },
              { id: "beta", text: "Beta" },
              { id: "gamma", text: "Gamma" },
            ],
          },
          settings,
          new AbortController().signal,
          { onProgress },
        ),
      ).rejects.toMatchObject({
        code: "invalid_response",
        details: expect.stringContaining(
          "Duplicate result IDs (all copies discarded): alpha",
        ) as unknown,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(
        onProgress.mock.calls.map(([result]) => result as unknown),
      ).toEqual([
        { id: "beta", translatedText: "贝塔" },
        { id: "gamma", translatedText: "伽马" },
      ]);
      const cachedTexts = mocks.setCachedTranslation.mock.calls.map(
        (call: unknown[]) => call[1],
      );
      expect(cachedTexts).toEqual(["贝塔", "伽马"]);
    });
  });
});
