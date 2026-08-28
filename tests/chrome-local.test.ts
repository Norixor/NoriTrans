import {
  chromeTranslatorLanguage,
  ChromeLocalProvider,
} from "@/src/translation/providers/chrome-local";
import { NTransError } from "@/src/shared/errors";
import { createProtectedText } from "@/src/translation/protected-text";
import { afterEach, describe, expect, it, vi } from "vitest";

interface TranslatorFactoryStub {
  availability: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
}

function setTranslator(factory: TranslatorFactoryStub): void {
  (globalThis as typeof globalThis & { Translator?: unknown }).Translator =
    factory;
}

function setChromeLanguageDetection(
  detectLanguage: ReturnType<typeof vi.fn>,
): void {
  vi.stubGlobal("chrome", { i18n: { detectLanguage } });
}

const request = {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  mode: "fast" as const,
  segments: [{ id: "one", text: "Hello" }],
};

afterEach(() => {
  delete (globalThis as typeof globalThis & { Translator?: unknown })
    .Translator;
  vi.unstubAllGlobals();
});

describe("ChromeLocalProvider readiness", () => {
  it("maps Chinese UI tags to Chrome Translator language-pack codes", () => {
    expect(chromeTranslatorLanguage("zh-CN")).toBe("zh");
    expect(chromeTranslatorLanguage("zh-Hans-CN")).toBe("zh");
    expect(chromeTranslatorLanguage("zh-Hant")).toBe("zh-Hant");
    expect(chromeTranslatorLanguage("zh-TW")).toBe("zh-Hant");
    expect(chromeTranslatorLanguage("en")).toBe("en");
  });

  it("reuses one task Translator and caps concurrent packed work at six", async () => {
    let active = 0;
    let maximumActive = 0;
    const destroy = vi.fn();
    const create = vi.fn(() =>
      Promise.resolve({
        translate: async (text: string) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 6));
          active -= 1;
          return text.replaceAll("text-", "translated-");
        },
        destroy,
      }),
    );
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create,
    });
    const provider = new ChromeLocalProvider({ keepAliveForTask: true });
    const progress: string[] = [];
    const segments = Array.from({ length: 24 }, (_, index) => ({
      id: `id-${index}`,
      text: `text-${index}`,
    }));

    const batches = await Promise.all(
      Array.from({ length: 12 }, (_, batchIndex) =>
        provider.translateBatch(
          {
            ...request,
            segments: segments.slice(batchIndex * 2, batchIndex * 2 + 2),
          },
          new AbortController().signal,
          (result) => {
            progress.push(result.id);
          },
        ),
      ),
    );
    const results = batches.flat();

    expect(create).toHaveBeenCalledOnce();
    expect(maximumActive).toBe(6);
    expect(results.map((result) => result.id)).toEqual(
      segments.map((segment) => segment.id),
    );
    expect(results.map((result) => result.translatedText)).toEqual(
      segments.map((segment) => segment.text.replace("text-", "translated-")),
    );
    expect(new Set(progress)).toEqual(
      new Set(segments.map((segment) => segment.id)),
    );
    await provider.dispose();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("falls back once to exact per-segment translation when packed markers are not preserved", async () => {
    const destroy = vi.fn();
    const translate = vi.fn((text: string) =>
      Promise.resolve(text.includes("\uE000NT") ? "markers lost" : `T:${text}`),
    );
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create: vi.fn(() => Promise.resolve({ translate, destroy })),
    });
    const provider = new ChromeLocalProvider({ keepAliveForTask: true });
    const firstSegments = [
      { id: "one", text: "First" },
      { id: "two", text: "Second" },
      { id: "three", text: "Third" },
    ];

    await expect(
      provider.translateBatch(
        { ...request, segments: firstSegments },
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      { id: "one", translatedText: "T:First" },
      { id: "two", translatedText: "T:Second" },
      { id: "three", translatedText: "T:Third" },
    ]);
    await expect(
      provider.translateBatch(
        {
          ...request,
          segments: [
            { id: "four", text: "Fourth" },
            { id: "five", text: "Fifth" },
          ],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      { id: "four", translatedText: "T:Fourth" },
      { id: "five", translatedText: "T:Fifth" },
    ]);

    expect(translate).toHaveBeenCalledTimes(6);
    expect(
      translate.mock.calls.filter(([text]) => text.includes("\uE000NT")),
    ).toHaveLength(1);
    await provider.dispose();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("validates protected markers for packed and per-segment local translation", async () => {
    const destroy = vi.fn();
    const translate = vi.fn((text: string) =>
      Promise.resolve(
        text.replaceAll("Hello", "你好").replaceAll("world", "世界"),
      ),
    );
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create: vi.fn(() => Promise.resolve({ translate, destroy })),
    });
    const provider = new ChromeLocalProvider({ keepAliveForTask: true });
    const first = createProtectedText(["Hello ", "world"]);
    const second = createProtectedText(["Hello world"]);

    await expect(
      provider.translateBatch(
        {
          ...request,
          segments: [
            { id: "first", text: first, format: "protected-text-v1" },
            { id: "second", text: second, format: "protected-text-v1" },
          ],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual([
      {
        id: "first",
        translatedText: first.replace("Hello", "你好").replace("world", "世界"),
      },
      {
        id: "second",
        translatedText: second
          .replace("Hello", "你好")
          .replace("world", "世界"),
      },
    ]);
    await expect(
      provider.translateBatch(
        {
          ...request,
          segments: [
            { id: "single", text: first, format: "protected-text-v1" },
          ],
        },
        new AbortController().signal,
      ),
    ).resolves.toHaveLength(1);
    await provider.dispose();
  });

  it("recovers Chrome marker rewrites by translating protected parts", async () => {
    const source = createProtectedText(["Hello", "world"]);
    const translate = vi.fn((text: string) => {
      if (text.includes("\uE000NT1:")) {
        return Promise.resolve(text.replaceAll("\uE000NT1:0:", "\uE000NT1:1:"));
      }
      return Promise.resolve(`译:${text}`);
    });
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create: vi.fn(() => Promise.resolve({ translate, destroy: vi.fn() })),
    });
    const provider = new ChromeLocalProvider({ keepAliveForTask: true });
    const progress = vi.fn();

    await expect(
      provider.translateBatch(
        {
          ...request,
          segments: [
            { id: "first", text: source, format: "protected-text-v1" },
            { id: "second", text: source, format: "protected-text-v1" },
          ],
        },
        new AbortController().signal,
        progress,
      ),
    ).resolves.toEqual([
      {
        id: "first",
        translatedText: createProtectedText(["译:Hello", "译:world"]),
      },
      {
        id: "second",
        translatedText: createProtectedText(["译:Hello", "译:world"]),
      },
    ]);
    expect(progress).toHaveBeenCalledTimes(2);
    expect(
      translate.mock.calls.filter(([text]) => !text.includes("\uE000NT")),
    ).toHaveLength(4);
    await provider.dispose();
  });

  it("rejects an empty Chrome protected-part fallback result", async () => {
    const source = createProtectedText(["Hello"]);
    const translate = vi.fn((text: string) =>
      Promise.resolve(
        text.includes("\uE000NT1:")
          ? text.replaceAll("\uE000NT1:0:", "\uE000NT1:1:")
          : "",
      ),
    );
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create: vi.fn(() => Promise.resolve({ translate, destroy: vi.fn() })),
    });
    const provider = new ChromeLocalProvider({ keepAliveForTask: true });

    await expect(
      provider.translateBatch(
        {
          ...request,
          segments: [
            { id: "single", text: source, format: "protected-text-v1" },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await provider.dispose();
  });

  it("pools automatic selection translators by the detected language pair", async () => {
    const translatorDestroy = vi.fn();
    const create = vi.fn(
      (options: { sourceLanguage: string; targetLanguage: string }) =>
        Promise.resolve({
          translate: (text: string) =>
            Promise.resolve(`${options.sourceLanguage}:${text}`),
          destroy: translatorDestroy,
        }),
    );
    const onSourceLanguageResolved = vi.fn<(sourceLanguage: string) => void>();
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create,
    });
    const detectLanguage = vi.fn((text: string) =>
      Promise.resolve({
        isReliable: true,
        languages: [
          {
            language: text.includes("Bonjour")
              ? "fr"
              : text.includes("Hola")
                ? "es"
                : text.includes("Hallo")
                  ? "de"
                  : "en",
            percentage: 99,
          },
        ],
      }),
    );
    setChromeLanguageDetection(detectLanguage);
    const provider = new ChromeLocalProvider({
      keepAliveForTask: true,
      dynamicSourceLanguage: true,
      onSourceLanguageResolved,
    });
    const translate = (text: string) =>
      provider.translateBatch(
        {
          ...request,
          sourceLanguage: "auto",
          segments: [{ id: "one", text }],
        },
        new AbortController().signal,
      );

    await expect(translate("Hello")).resolves.toEqual([
      { id: "one", translatedText: "en:Hello" },
    ]);
    await expect(translate("Hello again")).resolves.toEqual([
      { id: "one", translatedText: "en:Hello again" },
    ]);
    await expect(translate("Bonjour")).resolves.toEqual([
      { id: "one", translatedText: "fr:Bonjour" },
    ]);
    await expect(translate("Hola")).resolves.toEqual([
      { id: "one", translatedText: "es:Hola" },
    ]);
    await expect(translate("Hallo")).resolves.toEqual([
      { id: "one", translatedText: "de:Hallo" },
    ]);

    expect(create).toHaveBeenCalledTimes(4);
    expect(
      create.mock.calls.map(([options]) => options.sourceLanguage),
    ).toEqual(["en", "fr", "es", "de"]);
    expect(detectLanguage).toHaveBeenCalledTimes(5);
    expect(
      onSourceLanguageResolved.mock.calls.map(([language]) => language),
    ).toEqual(["en", "en", "fr", "es", "de"]);
    await provider.dispose();
    expect(translatorDestroy).toHaveBeenCalledTimes(4);
  });

  it("checks every automatic page batch with Chrome i18n detection", async () => {
    const detectLanguage = vi.fn(() =>
      Promise.resolve({
        isReliable: true,
        languages: [{ language: "en", percentage: 99 }],
      }),
    );
    const translatorCreate = vi.fn(
      (options: { sourceLanguage: string; targetLanguage: string }) =>
        Promise.resolve({
          translate: (text: string) =>
            Promise.resolve(`${options.sourceLanguage}:${text}`),
          destroy: vi.fn(),
        }),
    );
    setChromeLanguageDetection(detectLanguage);
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create: translatorCreate,
    });
    const provider = new ChromeLocalProvider({
      keepAliveForTask: true,
      dynamicSourceLanguage: true,
    });
    const translate = (id: string, text: string) =>
      provider.translateBatch(
        {
          ...request,
          sourceLanguage: "auto",
          segments: [{ id, text }],
        },
        new AbortController().signal,
      );

    await Promise.all([
      translate("one", "First page batch"),
      translate("two", "Second page batch"),
      translate("three", "Third page batch"),
    ]);

    expect(detectLanguage).toHaveBeenCalledTimes(3);
    expect(translatorCreate).toHaveBeenCalledOnce();
    await provider.dispose();
  });

  it("returns a structured reason when automatic language detection is inconclusive", async () => {
    setChromeLanguageDetection(
      vi.fn(() => Promise.resolve({ isReliable: false, languages: [] })),
    );
    const provider = new ChromeLocalProvider();

    await expect(
      provider.translateBatch(
        {
          ...request,
          sourceLanguage: "auto",
          segments: [{ id: "one", text: "AI" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      reason: "chrome_language_detection_failed",
    });
  });

  it("does not create a pooled Translator after an automatic selection is cancelled", async () => {
    let resolveDetection:
      | ((value: {
          isReliable: boolean;
          languages: Array<{ language: string; percentage: number }>;
        }) => void)
      | undefined;
    const create = vi.fn();
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create,
    });
    setChromeLanguageDetection(
      vi.fn(
        () =>
          new Promise<{
            isReliable: boolean;
            languages: Array<{ language: string; percentage: number }>;
          }>((resolve) => {
            resolveDetection = resolve;
          }),
      ),
    );
    const controller = new AbortController();
    const provider = new ChromeLocalProvider({
      keepAliveForTask: true,
      dynamicSourceLanguage: true,
    });
    const translation = provider.translateBatch(
      { ...request, sourceLanguage: "auto" },
      controller.signal,
    );
    await vi.waitFor(() => expect(resolveDetection).toBeTypeOf("function"));

    controller.abort();
    await provider.dispose();
    resolveDetection?.({
      isReliable: true,
      languages: [{ language: "en", percentage: 99 }],
    });

    await expect(translation).rejects.toMatchObject({ name: "AbortError" });
    expect(create).not.toHaveBeenCalled();
  });

  it("evicts a stalled Translator creation after cancellation and retries cleanly", async () => {
    let resolveFirst!: (translator: {
      translate(text: string): Promise<string>;
      destroy(): void;
    }) => void;
    const firstDestroy = vi.fn();
    const secondDestroy = vi.fn();
    const create = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        translate: (text: string) => Promise.resolve(`T:${text}`),
        destroy: secondDestroy,
      });
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create,
    });
    const provider = new ChromeLocalProvider({ keepAliveForTask: true });
    const firstController = new AbortController();
    const first = provider.translateBatch(request, firstController.signal);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());

    firstController.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      provider.translateBatch(request, new AbortController().signal),
    ).resolves.toEqual([{ id: "one", translatedText: "T:Hello" }]);
    expect(create).toHaveBeenCalledTimes(2);

    resolveFirst({
      translate: (text: string) => Promise.resolve(text),
      destroy: firstDestroy,
    });
    await vi.waitFor(() => expect(firstDestroy).toHaveBeenCalledOnce());
    await provider.dispose();
    expect(secondDestroy).toHaveBeenCalledOnce();
  });

  it("does not download a model for opportunistic subtitle fallback", async () => {
    const create = vi.fn();
    setTranslator({
      availability: vi.fn(() => Promise.resolve("downloadable")),
      create,
    });

    await expect(
      new ChromeLocalProvider({ requireAvailable: true }).translateBatch(
        request,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "provider_unavailable",
      reason: "chrome_pair_unavailable",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps model download available for an explicit fast translation", async () => {
    const destroy = vi.fn();
    const create = vi.fn(() =>
      Promise.resolve({
        translate: () => Promise.resolve("你好"),
        destroy,
      }),
    );
    setTranslator({
      availability: vi.fn(() => Promise.resolve("downloadable")),
      create,
    });

    await expect(
      new ChromeLocalProvider().translateBatch(
        request,
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ id: "one", translatedText: "你好" }]);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: "en",
        targetLanguage: "zh",
      }),
    );
    expect(destroy).toHaveBeenCalledOnce();
  });

  it.each(["downloadable", "downloading"] as const)(
    "classifies a failed %s model preparation as an unavailable pair",
    async (availability) => {
      setTranslator({
        availability: vi.fn(() => Promise.resolve(availability)),
        create: vi.fn(() =>
          Promise.reject(new Error("model preparation failed")),
        ),
      });

      const failure = await new ChromeLocalProvider()
        .translateBatch(
          {
            ...request,
            sourceLanguage: "ko",
            targetLanguage: "de",
            segments: [{ id: "one", text: "한국어 검색 결과" }],
          },
          new AbortController().signal,
        )
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "provider_unavailable",
        reason: "chrome_pair_unavailable",
      });
      expect(failure).toBeInstanceOf(NTransError);
      if (failure instanceof NTransError) {
        expect(failure.details).toContain("ko->de=create-Error");
      }
    },
  );

  it("keeps cancellation distinct from an unavailable on-demand pair", async () => {
    const cancellation = new DOMException(
      "Translation cancelled",
      "AbortError",
    );
    setTranslator({
      availability: vi.fn(() => Promise.resolve("downloadable")),
      create: vi.fn(() => Promise.reject(cancellation)),
    });

    await expect(
      new ChromeLocalProvider().translateBatch(
        request,
        new AbortController().signal,
      ),
    ).rejects.toBe(cancellation);
  });

  it("tries the generic Chinese candidate after an on-demand Traditional Chinese preparation fails", async () => {
    const destroy = vi.fn();
    const availability = vi.fn(
      ({ sourceLanguage }: { sourceLanguage: string }) =>
        Promise.resolve(
          sourceLanguage === "zh-Hant" ? "downloadable" : "available",
        ),
    );
    const create = vi.fn(({ sourceLanguage }: { sourceLanguage: string }) =>
      sourceLanguage === "zh-Hant"
        ? Promise.reject(new Error("traditional model preparation failed"))
        : Promise.resolve({
            translate: (text: string) => Promise.resolve(`T:${text}`),
            destroy,
          }),
    );
    setTranslator({ availability, create });

    await expect(
      new ChromeLocalProvider().translateBatch(
        {
          ...request,
          sourceLanguage: "zh-Hant",
          targetLanguage: "en",
          segments: [{ id: "one", text: "繁體中文內容" }],
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual([{ id: "one", translatedText: "T:繁體中文內容" }]);
    expect(
      create.mock.calls.map(([options]) => options.sourceLanguage),
    ).toEqual(["zh-Hant", "zh"]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("preserves runtime failures for a pair Chrome reports as available", async () => {
    setTranslator({
      availability: vi.fn(() => Promise.resolve("available")),
      create: vi.fn(() => Promise.reject(new Error("available model crashed"))),
    });

    await expect(
      new ChromeLocalProvider().translateBatch(
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow("available model crashed");
  });

  it("preserves translation failures after an on-demand model is created", async () => {
    setTranslator({
      availability: vi.fn(() => Promise.resolve("downloadable")),
      create: vi.fn(() =>
        Promise.resolve({
          translate: () => Promise.reject(new Error("translation crashed")),
          destroy: vi.fn(),
        }),
      ),
    });

    await expect(
      new ChromeLocalProvider().translateBatch(
        request,
        new AbortController().signal,
      ),
    ).rejects.toThrow("translation crashed");
  });

  it("reports bounded local model download progress", async () => {
    const progress: number[] = [];
    setTranslator({
      availability: vi.fn(() => Promise.resolve("downloadable")),
      create: vi.fn((options: { monitor?: (monitor: EventTarget) => void }) => {
        const monitor = new EventTarget();
        options.monitor?.(monitor);
        for (const loaded of [-0.2, 0.45, 1.2]) {
          const event = new Event("downloadprogress");
          Object.defineProperty(event, "loaded", { value: loaded });
          monitor.dispatchEvent(event);
        }
        return Promise.resolve({
          translate: () => Promise.resolve("你好"),
          destroy: vi.fn(),
        });
      }),
    });

    await new ChromeLocalProvider({
      onDownloadProgress: (value) => progress.push(value),
    }).translateBatch(request, new AbortController().signal);

    expect(progress).toEqual([0, 0.45, 1]);
  });
});
