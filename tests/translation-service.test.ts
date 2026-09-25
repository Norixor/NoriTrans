import { translateInBackground } from "@/src/translation/service";
import { createProtectedText } from "@/src/translation/protected-text";
import { DEFAULT_SETTINGS } from "@/src/shared/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    ): Promise<Array<{ id: string; translatedText: string }>> {
      return mocks.translateBatch(request, signal);
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
});
