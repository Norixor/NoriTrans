import { PageTranslationSession } from "@/src/page/session";
import { NoriTransError } from "@/src/shared/errors";
import { DEFAULT_SETTINGS } from "@/src/shared/settings";
import {
  createProtectedText,
  parseProtectedText,
} from "@/src/translation/protected-text";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FixtureTranslationSegment {
  id: string;
  text: string;
  format?: "plain-text-v1" | "protected-text-v1";
}

interface FixtureLocalProviderOptions {
  keepAliveForTask?: boolean;
  dynamicSourceLanguage?: boolean;
}

interface FixtureLocalTranslationRequest {
  sourceLanguage: string;
  targetLanguage: string;
  segments: FixtureTranslationSegment[];
}

function fixtureTranslation(segment: FixtureTranslationSegment): string {
  if (segment.format !== "protected-text-v1") return `T:${segment.text}`;
  const parts = parseProtectedText(segment.text, segment.text);
  if (!parts) throw new Error("invalid protected page test segment");
  return createProtectedText(
    parts.map((part, index) => `${index === 0 ? "T:" : ""}${part}`),
  );
}

const localRuntime = vi.hoisted(() => ({
  providerCreated: vi.fn<(options?: FixtureLocalProviderOptions) => void>(),
  providerDisposed: vi.fn(),
  translateBatch: vi.fn<
    (
      request: FixtureLocalTranslationRequest,
      signal?: AbortSignal,
      onProgress?: (result: {
        id: string;
        translatedText: string;
      }) => void | Promise<void>,
    ) => Promise<Array<{ id: string; translatedText: string }>>
  >((request) =>
    Promise.resolve(
      request.segments.map((segment) => ({
        id: segment.id,
        translatedText: `T:${segment.text}`,
      })),
    ),
  ),
}));

const aiRuntime = vi.hoisted(() => ({
  sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(),
  listeners: new Set<(message: unknown) => void>(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      sendMessage: aiRuntime.sendMessage,
      onMessage: {
        addListener: (listener: (message: unknown) => void) =>
          aiRuntime.listeners.add(listener),
        removeListener: (listener: (message: unknown) => void) =>
          aiRuntime.listeners.delete(listener),
      },
    },
  },
}));

vi.mock("@/src/translation/providers/chrome-local", () => ({
  ChromeLocalProvider: class {
    readonly id = "chrome-local";
    readonly mode = "fast" as const;
    readonly capabilities = {
      maxBatchCharacters: 4_000,
      maxBatchSegments: 20,
      supportsContext: false,
      runtime: "document" as const,
    };

    constructor(options?: FixtureLocalProviderOptions) {
      localRuntime.providerCreated(options);
    }

    translateBatch(
      request: FixtureLocalTranslationRequest,
      signal?: AbortSignal,
      onProgress?: (result: {
        id: string;
        translatedText: string;
      }) => void | Promise<void>,
    ): Promise<Array<{ id: string; translatedText: string }>> {
      return localRuntime.translateBatch(request, signal, onProgress);
    }

    dispose(): Promise<void> {
      localRuntime.providerDisposed();
      return Promise.resolve();
    }
  },
}));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

describe("PageTranslationSession", () => {
  beforeEach(() => {
    document.documentElement.lang = "";
    aiRuntime.listeners.clear();
    localRuntime.translateBatch.mockReset().mockImplementation((request) =>
      Promise.resolve(
        request.segments.map((segment) => ({
          id: segment.id,
          translatedText: fixtureTranslation(segment),
        })),
      ),
    );
    localRuntime.providerCreated.mockReset();
    localRuntime.providerDisposed.mockReset();
    aiRuntime.sendMessage.mockReset().mockImplementation((message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({
        ok: true,
        results: message.request.segments.map((segment: unknown) => {
          if (
            typeof segment !== "object" ||
            segment === null ||
            !("id" in segment) ||
            typeof segment.id !== "string" ||
            !("text" in segment) ||
            typeof segment.text !== "string"
          ) {
            throw new Error("invalid AI test segment");
          }
          return {
            id: segment.id,
            translatedText: fixtureTranslation(
              segment as FixtureTranslationSegment,
            ),
          };
        }),
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies an AI segment progress event before the batch finishes", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 4 },
      (_, index) => `<p>Streaming page ${index + 1}</p>`,
    ).join("")}</main>`;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";
    let pending:
      | {
          requestId: string;
          segments: FixtureTranslationSegment[];
          resolve(value: unknown): void;
        }
      | undefined;
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      expect(message.request.responseMode).toBe("stream");
      if (segments.length === 1) {
        return Promise.resolve({
          ok: true,
          results: segments.map((segment) => ({
            id: segment.id,
            translatedText: `T:${segment.text}`,
          })),
        });
      }
      return new Promise((resolve) => {
        pending = {
          requestId: String(message.requestId),
          segments,
          resolve,
        };
      });
    });
    const session = new PageTranslationSession(vi.fn());
    const run = session.translate(settings);
    await vi.waitFor(() => expect(pending?.segments).toHaveLength(4));
    const first = pending?.segments[0];
    if (!first || !pending) throw new Error("missing streaming page request");

    for (const listener of aiRuntime.listeners) {
      listener({
        type: "TRANSLATION_PROGRESS",
        requestId: pending.requestId,
        result: { id: first.id, translatedText: `T:${first.text}` },
      });
    }

    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll("p")].some(
          (paragraph) => paragraph.textContent === `T:${first.text}`,
        ),
      ).toBe(true),
    );
    expect(session.getStatus()).toMatchObject({
      state: "translating",
      completed: 1,
    });
    pending.resolve({
      ok: true,
      results: pending.segments.map((segment) => ({
        id: segment.id,
        translatedText: `T:${segment.text}`,
      })),
    });
    await expect(run).resolves.toMatchObject({
      state: "translated",
      completed: 4,
    });
    session.restore();
  });

  it("retries an AI progress result that arrives while its source is temporarily hidden", async () => {
    document.body.innerHTML = "<main><p>Transient progress source</p></main>";
    const paragraph = document.querySelector("p");
    if (!paragraph) throw new Error("missing transient progress fixture");
    let visible = true;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== paragraph) return style;
        return {
          ...style,
          display: visible ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    let pending:
      | {
          requestId: string;
          segment: FixtureTranslationSegment;
          resolve(value: unknown): void;
        }
      | undefined;
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segment = message.request.segments[0] as
        FixtureTranslationSegment | undefined;
      if (!segment) throw new Error("missing transient progress segment");
      return new Promise((resolve) => {
        pending = { requestId: String(message.requestId), segment, resolve };
      });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    try {
      const run = session.translate(settings);
      await vi.waitFor(() => expect(pending).toBeDefined());
      if (!pending) throw new Error("missing transient progress request");
      const translatedText = fixtureTranslation(pending.segment);
      visible = false;
      for (const listener of aiRuntime.listeners) {
        listener({
          type: "TRANSLATION_PROGRESS",
          requestId: pending.requestId,
          result: { id: pending.segment.id, translatedText },
        });
      }
      await Promise.resolve();
      expect(paragraph.textContent).toBe("Transient progress source");
      expect(session.getStatus()).toMatchObject({ completed: 0, failed: 0 });

      visible = true;
      await vi.waitFor(() =>
        expect(paragraph.textContent).toBe(translatedText),
      );
      pending.resolve({
        ok: true,
        results: [{ id: pending.segment.id, translatedText }],
      });
      await expect(run).resolves.toMatchObject({
        state: "translated",
        completed: 1,
        failed: 0,
      });
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("stops retrying a result whose source stays hidden", async () => {
    document.body.innerHTML = "<main><p>Persistently hidden result</p></main>";
    const paragraph = document.querySelector("p");
    if (!paragraph) throw new Error("missing hidden result fixture");
    let visible = true;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== paragraph) return style;
        return {
          ...style,
          display: visible ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      visible = false;
      return Promise.resolve({
        ok: true,
        results: message.request.segments.map((segment: unknown) => {
          if (!isRecord(segment) || typeof segment.id !== "string") {
            throw new Error("invalid hidden result segment");
          }
          return { id: segment.id, translatedText: "Hidden translation" };
        }),
      });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    try {
      await expect(session.translate(settings)).resolves.toMatchObject({
        state: "error",
        completed: 0,
        failed: 1,
      });
      expect(aiRuntime.sendMessage).toHaveBeenCalledTimes(1);
      expect(paragraph.textContent).toBe("Persistently hidden result");
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("applies an already received translation when a failed hidden source becomes visible", async () => {
    document.body.innerHTML =
      "<main><p>Hidden during Provider response</p></main>";
    const paragraph = document.querySelector("p");
    if (!paragraph) throw new Error("missing recovered reveal fixture");
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      paragraph.hidden = true;
      return Promise.resolve({
        ok: true,
        results: message.request.segments.map((segment: unknown) => {
          if (!isRecord(segment) || typeof segment.id !== "string") {
            throw new Error("invalid recovered reveal segment");
          }
          return { id: segment.id, translatedText: "Recovered translation" };
        }),
      });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    try {
      await expect(session.translate(settings)).resolves.toMatchObject({
        state: "error",
        completed: 0,
        failed: 1,
      });
      expect(paragraph.textContent).toBe("Hidden during Provider response");

      paragraph.hidden = false;
      await vi.waitFor(
        () => expect(paragraph.textContent).toBe("Recovered translation"),
        { timeout: 1_200 },
      );
      expect(session.getStatus()).toMatchObject({
        state: "translated",
        total: 1,
        completed: 1,
        failed: 0,
      });
      expect(
        aiRuntime.sendMessage.mock.calls.filter(
          ([message]) => isRecord(message) && message.type === "TRANSLATE",
        ),
      ).toHaveLength(1);
    } finally {
      session.restore();
    }
  });

  it("translates a sentence across an inline link with one protected request", async () => {
    document.body.innerHTML =
      '<main><p>Read <a href="/docs">documentation</a> now.</p></main>';
    const originalLink = document.querySelector<HTMLAnchorElement>("a");
    if (!originalLink) throw new Error("missing inline link fixture");
    const clicked = vi.fn((event: Event) => event.preventDefault());
    originalLink.addEventListener("click", clicked);
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const requestSegments = message.request.segments as unknown[];
      expect(requestSegments).toHaveLength(1);
      const candidate: unknown = requestSegments[0];
      if (
        !isRecord(candidate) ||
        typeof candidate.id !== "string" ||
        typeof candidate.text !== "string"
      ) {
        throw new Error("invalid protected inline request");
      }
      expect(candidate.format).toBe("protected-text-v1");
      expect(parseProtectedText(candidate.text, candidate.text)).toEqual([
        "Read ",
        "documentation",
        " now.",
      ]);
      return Promise.resolve({
        ok: true,
        results: [
          {
            id: candidate.id,
            translatedText: createProtectedText(["阅读", "文档", "。"]),
          },
        ],
      });
    });
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";
    const session = new PageTranslationSession(vi.fn());

    await expect(session.translate(settings)).resolves.toMatchObject({
      state: "translated",
      completed: 1,
      failed: 0,
    });

    const paragraph = document.querySelector("p");
    expect(document.querySelector("a")).toBe(originalLink);
    expect(paragraph?.textContent).toBe("阅读文档。");
    originalLink.click();
    expect(clicked).toHaveBeenCalledOnce();

    session.restore();
    expect(paragraph?.innerHTML).toBe(
      'Read <a href="/docs">documentation</a> now.',
    );
  });

  it("replaces an earlier fast translation when an AI batch response arrives", async () => {
    document.body.innerHTML = "<main><p>Replace the fast result</p></main>";
    localRuntime.translateBatch.mockImplementation((request) =>
      Promise.resolve(
        request.segments.map((segment) => ({
          id: segment.id,
          translatedText: `FAST:${segment.text}`,
        })),
      ),
    );
    const session = new PageTranslationSession(vi.fn());
    const fastSettings = structuredClone(DEFAULT_SETTINGS);
    fastSettings.page.displayMode = "translated";
    await session.translate(fastSettings);
    expect(document.querySelector("p")?.textContent).toBe(
      "FAST:Replace the fast result",
    );

    const batchSettings = structuredClone(fastSettings);
    batchSettings.page.mode = "ai";
    batchSettings.page.aiResponseMode = "batch";
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      expect(message.request.responseMode).toBe("batch");
      return Promise.resolve({
        ok: true,
        results: message.request.segments.map((segment: unknown) => {
          if (!isRecord(segment) || typeof segment.id !== "string") {
            throw new Error("invalid batch replacement segment");
          }
          return { id: segment.id, translatedText: "AI batch result" };
        }),
      });
    });

    await session.translate(batchSettings);

    expect(document.querySelector("p")?.textContent).toBe("AI batch result");
    expect(session.getStatus()).toMatchObject({
      state: "translated",
      completed: 1,
      failed: 0,
    });
    session.restore();
  });

  it("keeps an empty page idle instead of reporting a zero-item success", async () => {
    document.body.innerHTML = "<main><pre>Excluded code</pre></main>";
    const session = new PageTranslationSession(vi.fn());

    await expect(
      session.translate(structuredClone(DEFAULT_SETTINGS)),
    ).resolves.toMatchObject({
      state: "idle",
      total: 0,
      completed: 0,
      failed: 0,
    });
    expect(localRuntime.translateBatch).not.toHaveBeenCalled();
    session.restore();
  });

  it("can restore and translate the same text nodes again", async () => {
    document.body.innerHTML = "<main><p>Hello world</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(document.querySelector("p")?.textContent).toBe("T:Hello world");

    session.restore();
    expect(document.querySelector("p")?.textContent).toBe("Hello world");

    await session.translate(settings);
    expect(document.querySelector("p")?.textContent).toBe("T:Hello world");
    session.restore();
  });

  it("translates text added after the initial page scan", async () => {
    document.body.innerHTML = "<main><p>Initial dynamic fixture</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    const paragraph = document.createElement("p");
    paragraph.textContent = "Later dynamic fixture";
    document.querySelector("main")?.append(paragraph);
    await new Promise((resolve) => window.setTimeout(resolve, 600));

    expect(paragraph.textContent).toBe("T:Later dynamic fixture");
    session.restore();
  });

  it("does not let continuous interactive DOM churn starve a dynamic translation", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<main><p>Initial stable text</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      const main = document.querySelector("main");
      if (!main) throw new Error("missing dynamic fixture root");
      const dynamic = document.createElement("p");
      dynamic.textContent = "Hover menu item";
      main.append(dynamic);
      await Promise.resolve();

      for (let index = 0; index < 6; index += 1) {
        main.className = `animated-state-${index}`;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(70);
      }

      expect(dynamic.textContent).toBe("T:Hover menu item");
      expect(localRuntime.translateBatch).toHaveBeenCalledTimes(2);
    } finally {
      session.restore();
      vi.useRealTimers();
    }
  });

  it("pauses and resumes dynamic translation without restoring existing text", async () => {
    document.body.innerHTML = "<main><p>Initial automatic fixture</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    session.stopFollowingDynamicContent();
    const later = document.createElement("p");
    later.textContent = "Paused automatic fixture";
    document.querySelector("main")?.append(later);
    await new Promise((resolve) => window.setTimeout(resolve, 500));

    expect(document.querySelector("p")?.textContent).toBe(
      "T:Initial automatic fixture",
    );
    expect(later.textContent).toBe("Paused automatic fixture");

    session.resumeFollowingDynamicContent();
    await vi.waitFor(
      () => expect(later.textContent).toBe("T:Paused automatic fixture"),
      { timeout: 1_000 },
    );
    session.restore();
  });

  it("reuses one local Translator across dynamic runs and replaces it for a new language pair", async () => {
    document.body.innerHTML = "<main><p>Initial local translation</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(localRuntime.providerCreated).toHaveBeenCalledOnce();

    const firstDynamic = document.createElement("p");
    firstDynamic.textContent = "First hover item";
    document.querySelector("main")?.append(firstDynamic);
    await vi.waitFor(
      () => expect(firstDynamic.textContent).toBe("T:First hover item"),
      { timeout: 1_000 },
    );
    expect(localRuntime.providerCreated).toHaveBeenCalledOnce();
    expect(localRuntime.providerDisposed).not.toHaveBeenCalled();

    const changed = structuredClone(settings);
    changed.page.targetLanguage = "en";
    session.updateSettings(changed);
    expect(localRuntime.providerCreated).toHaveBeenCalledTimes(2);
    expect(localRuntime.providerDisposed).toHaveBeenCalledOnce();

    const secondDynamic = document.createElement("p");
    secondDynamic.textContent = "Second hover item";
    document.querySelector("main")?.append(secondDynamic);
    await vi.waitFor(
      () => expect(secondDynamic.textContent).toBe("Second hover item"),
      { timeout: 1_000 },
    );
    expect(localRuntime.providerCreated).toHaveBeenCalledTimes(2);

    session.restore();
    expect(localRuntime.providerDisposed).toHaveBeenCalledTimes(2);
  });

  it("enables per-batch source detection only for automatic page language", async () => {
    document.body.innerHTML = "<main><p>Automatic source page</p></main>";
    const automaticSession = new PageTranslationSession(vi.fn());
    const automatic = structuredClone(DEFAULT_SETTINGS);
    automatic.page.sourceLanguage = "auto";
    automatic.page.displayMode = "translated";

    await automaticSession.translate(automatic);
    expect(localRuntime.providerCreated).toHaveBeenLastCalledWith({
      keepAliveForTask: true,
      dynamicSourceLanguage: true,
    });
    automaticSession.restore();

    document.body.innerHTML =
      "<main><p>Explicit English source page</p></main>";
    const explicitSession = new PageTranslationSession(vi.fn());
    const explicit = structuredClone(automatic);
    explicit.page.sourceLanguage = "en";

    await explicitSession.translate(explicit);
    expect(localRuntime.providerCreated).toHaveBeenLastCalledWith({
      keepAliveForTask: true,
      dynamicSourceLanguage: false,
    });
    expect(localRuntime.translateBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    explicitSession.restore();
  });

  it("partitions automatic local translation by detected segment language", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn((text: string) =>
          Promise.resolve({
            isReliable: true,
            languages: [
              {
                language: /日本語/u.test(text) ? "ja" : "en",
                percentage: 100,
              },
            ],
          }),
        ),
      },
    });
    const english = `English batch ${"sentence ".repeat(230)}`;
    const japanese = `日本語のバッチ ${"文章".repeat(1_200)}`;
    document.body.innerHTML = `<main><p>${english}</p><p>${japanese}</p></main>`;
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.sourceLanguage = "auto";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(localRuntime.translateBatch).toHaveBeenCalledTimes(2);
    const requests = localRuntime.translateBatch.mock.calls.map(
      ([request]) => request,
    );
    expect(new Set(requests.map((request) => request.sourceLanguage))).toEqual(
      new Set(["en", "ja"]),
    );
    expect(
      requests.every((request) => request.targetLanguage === "zh-CN"),
    ).toBe(true);
    expect(
      requests.some((request) =>
        request.segments.some((segment) => segment.text.includes("English")),
      ),
    ).toBe(true);
    expect(
      requests.some((request) =>
        request.segments.some((segment) => segment.text.includes("日本語")),
      ),
    ).toBe(true);
    session.restore();
  });

  it("uses the resolved Latin majority for short automatic page segments", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn((text: string) =>
          Promise.resolve(
            text.length > 10
              ? {
                  isReliable: true,
                  languages: [{ language: "en", percentage: 100 }],
                }
              : { isReliable: false, languages: [] },
          ),
        ),
      },
    });
    document.documentElement.lang = "zh-HK";
    document.body.innerHTML =
      "<main><p>Artificial intelligence search result</p><p>AI</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "zh-CN";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    const requests = localRuntime.translateBatch.mock.calls.map(
      ([request]) => request,
    );
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.sourceLanguage === "en")).toBe(
      true,
    );
    expect(document.body.textContent).toContain("T:AI");
    session.restore();
  });

  it("uses the retained English majority for a later dynamic short segment", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn((text: string) =>
          Promise.resolve(
            text.length > 10
              ? {
                  isReliable: true,
                  languages: [{ language: "en", percentage: 100 }],
                }
              : { isReliable: false, languages: [] },
          ),
        ),
      },
    });
    document.documentElement.lang = "zh-HK";
    document.body.innerHTML =
      "<main><p>English artificial intelligence result</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "zh-CN";
    settings.page.displayMode = "translated";

    await session.translate(settings);
    const dynamic = document.createElement("p");
    dynamic.textContent = "AI";
    document.querySelector("main")?.append(dynamic);

    await vi.waitFor(() => expect(dynamic.textContent).toBe("T:AI"), {
      timeout: 1_500,
    });
    expect(
      localRuntime.translateBatch.mock.calls.every(
        ([request]) => request.sourceLanguage === "en",
      ),
    ).toBe(true);
    session.restore();
  });

  it("does not force a long unresolved Latin segment into the English majority", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn((text: string) =>
          Promise.resolve(
            text.includes("English")
              ? {
                  isReliable: true,
                  languages: [{ language: "en", percentage: 100 }],
                }
              : { isReliable: false, languages: [] },
          ),
        ),
      },
    });
    document.documentElement.lang = "zh-HK";
    document.body.innerHTML =
      "<main><p>English artificial intelligence result</p><p>Este contenido permanece sin resolver porque la detección estadística no fue fiable para este párrafo largo.</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "zh-CN";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(
      new Set(
        localRuntime.translateBatch.mock.calls.map(
          ([request]) => request.sourceLanguage,
        ),
      ),
    ).toEqual(new Set(["en", "auto"]));
    session.restore();
  });

  it("skips an unresolved automatic Chrome source without reporting an error", async () => {
    document.body.innerHTML = "<main><p>AI</p></main>";
    localRuntime.translateBatch.mockRejectedValueOnce(
      new NoriTransError(
        "无法检测网页语言，请手动选择源语言。",
        "provider_unavailable",
        false,
        undefined,
        "chrome_language_detection_failed",
      ),
    );
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "zh-CN";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 1,
      completed: 1,
      failed: 0,
    });
    expect(document.body.textContent).toContain("AI");
    session.restore();
  });

  it("skips an unavailable automatic Chrome pair without reporting a partial failure", async () => {
    document.body.innerHTML = "<main><p>한국어 검색 결과</p></main>";
    localRuntime.translateBatch.mockRejectedValueOnce(
      new NoriTransError(
        "Chrome 本地翻译不支持当前语言对。",
        "provider_unavailable",
        false,
        "Chrome Translator pair attempts: ko->de=downloadable, ko->de=create-Error.",
        "chrome_pair_unavailable",
      ),
    );
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "de";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 1,
      completed: 1,
      failed: 0,
    });
    expect(document.body.textContent).toContain("한국어 검색 결과");
    session.restore();
  });

  it("still reports an unavailable Chrome pair for an explicit source language", async () => {
    document.body.innerHTML = "<main><p>한국어 검색 결과</p></main>";
    localRuntime.translateBatch.mockRejectedValueOnce(
      new NoriTransError(
        "Chrome 本地翻译不支持当前语言对。",
        "provider_unavailable",
        false,
        "Chrome Translator pair attempts: ko->de=downloadable, ko->de=create-Error.",
        "chrome_pair_unavailable",
      ),
    );
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.sourceLanguage = "ko";
    settings.page.targetLanguage = "de";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(session.getStatus()).toMatchObject({
      state: "error",
      total: 1,
      completed: 0,
      failed: 1,
    });
    expect(session.getStatus().details).toContain("ko->de=create-Error");
    session.restore();
  });

  it("skips Latin target text during automatic Bergamot translation", async () => {
    document.body.innerHTML =
      '<main><p id="source">中文页面内容</p><p id="target">Already in English</p><p id="icon">\uE123</p></main>';
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.fastProvider = "bergamot-local";
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "en";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(document.querySelector("#source")?.textContent).toBe(
      "T:中文页面内容",
    );
    expect(document.querySelector("#target")?.textContent).toBe(
      "Already in English",
    );
    expect(document.querySelector("#icon")?.textContent).toBe("\uE123");
    const translationRequests = aiRuntime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(
        (message): message is Record<string, unknown> =>
          isRecord(message) && message.type === "TRANSLATE",
      );
    expect(translationRequests).toHaveLength(1);
    expect(translationRequests[0]?.request).toMatchObject({
      sourceLanguage: "zh-CN",
      targetLanguage: "en",
    });
    session.restore();
  });

  it("routes a Google-like mixed page by segment instead of its zh-HK declaration", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn((text: string) =>
          Promise.resolve({
            isReliable: true,
            languages: [
              {
                language: /\p{Script=Hangul}/u.test(text)
                  ? "ko"
                  : /\p{Script=Latin}/u.test(text)
                    ? "en"
                    : "zh-TW",
                percentage: 100,
              },
            ],
          }),
        ),
      },
    });
    document.documentElement.lang = "zh-HK";
    document.body.innerHTML = `<main>${Array.from(
      { length: 79 },
      (_, index) => `<p>搜尋結果 ${index + 1}</p>`,
    ).join("")}${Array.from(
      { length: 21 },
      (_, index) => `<p>English search result ${index + 1}</p>`,
    ).join("")}<p>한국어 검색 결과</p></main>`;
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        isRecord(message) &&
        message.type === "LOCAL_TRANSLATION_RUNTIME_LIST"
      ) {
        return Promise.resolve({
          ok: true,
          runtimes: [
            {
              packId: "en-zh-Hans",
              sourceLanguage: "en",
              targetLanguage: "zh-Hans",
              state: "installed",
            },
          ],
        });
      }
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({
        ok: true,
        results: message.request.segments.map((segment: unknown) => {
          if (!isRecord(segment) || typeof segment.id !== "string") {
            throw new Error("invalid test segment");
          }
          const text = typeof segment.text === "string" ? segment.text : "";
          return { id: segment.id, translatedText: `T:${text}` };
        }),
      });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.fastProvider = "bergamot-local";
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "zh-CN";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    const translationRequests = aiRuntime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(
        (message): message is Record<string, unknown> =>
          isRecord(message) && message.type === "TRANSLATE",
      );
    expect(translationRequests.length).toBeGreaterThan(0);
    expect(
      translationRequests.every(
        (message) =>
          isRecord(message.request) &&
          message.request.sourceLanguage === "en" &&
          message.request.targetLanguage === "zh-CN",
      ),
    ).toBe(true);
    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 101,
      completed: 101,
      failed: 0,
    });
    expect(document.body.textContent).not.toContain("T:搜尋結果");
    expect(document.body.textContent).toContain("T:English search result 1");
    expect(document.body.textContent).toContain("한국어 검색 결과");
    expect(document.body.textContent).not.toContain("T:한국어 검색 결과");
    session.restore();
  });

  it("skips an unsupported language in automatic Bergamot mode without reporting an error", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn(() =>
          Promise.resolve({
            isReliable: true,
            languages: [{ language: "ko", percentage: 100 }],
          }),
        ),
      },
    });
    document.body.innerHTML = "<main><p>한국어 검색 결과</p></main>";
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        isRecord(message) &&
        message.type === "LOCAL_TRANSLATION_RUNTIME_LIST"
      ) {
        return Promise.resolve({
          ok: true,
          runtimes: [
            {
              packId: "en-zh-Hans",
              sourceLanguage: "en",
              targetLanguage: "zh-Hans",
              state: "installed",
            },
          ],
        });
      }
      return Promise.resolve({ ok: true });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.fastProvider = "bergamot-local";
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "zh-CN";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 1,
      completed: 1,
      failed: 0,
    });
    expect(document.body.textContent).toContain("한국어 검색 결과");
    expect(
      aiRuntime.sendMessage.mock.calls.some(
        ([message]) => isRecord(message) && message.type === "TRANSLATE",
      ),
    ).toBe(false);
    session.restore();
  });

  it("treats a missing source pack discovered by Bergamot as an automatic skip", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn(() =>
          Promise.resolve({
            isReliable: true,
            languages: [{ language: "ko", percentage: 100 }],
          }),
        ),
      },
    });
    document.body.innerHTML = "<main><p>한국어 검색 결과</p></main>";
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (isRecord(message) && message.type === "TRANSLATE") {
        return Promise.resolve({
          ok: false,
          error: {
            code: "provider_unavailable",
            message: "当前翻译 Provider 不可用。",
            retryable: false,
            details: "Provider=bergamot-local; Missing packs=ko-en.",
            reason: "bergamot_package_missing",
          },
        });
      }
      return Promise.resolve({ ok: true });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.fastProvider = "bergamot-local";
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "zh-CN";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 1,
      completed: 1,
      failed: 0,
    });
    expect(document.body.textContent).toContain("한국어 검색 결과");
    session.restore();
  });

  it("shares an in-flight automatic Bergamot skip with matching dynamic text", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: vi.fn(() =>
          Promise.resolve({
            isReliable: true,
            languages: [{ language: "ko", percentage: 100 }],
          }),
        ),
      },
    });
    document.body.innerHTML = "<main><p>한국어 중복 문장</p></main>";
    let resolveTranslation: ((value: unknown) => void) | undefined;
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (isRecord(message) && message.type === "TRANSLATE") {
        return new Promise((resolve) => {
          resolveTranslation = resolve;
        });
      }
      return Promise.resolve({ ok: true });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.fastProvider = "bergamot-local";
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "zh-CN";
    settings.page.displayMode = "translated";

    const initial = session.translate(settings);
    await vi.waitFor(() => expect(resolveTranslation).toBeTypeOf("function"));
    const dynamic = document.createElement("p");
    dynamic.textContent = "한국어 중복 문장";
    document.querySelector("main")?.append(dynamic);
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    expect(
      aiRuntime.sendMessage.mock.calls.filter(
        ([message]) => isRecord(message) && message.type === "TRANSLATE",
      ),
    ).toHaveLength(1);

    resolveTranslation?.({
      ok: false,
      error: {
        code: "provider_unavailable",
        message: "当前翻译 Provider 不可用。",
        retryable: false,
        details: "Provider=bergamot-local; Missing packs=ko-en.",
        reason: "bergamot_package_missing",
      },
    });
    await initial;
    await vi.waitFor(() =>
      expect(session.getStatus()).toMatchObject({
        state: "translated",
        total: 2,
        completed: 2,
        failed: 0,
      }),
    );
    expect(
      [...document.querySelectorAll("p")].map((node) => node.textContent),
    ).toEqual(["한국어 중복 문장", "한국어 중복 문장"]);
    session.restore();
  });

  it("still reports a missing Bergamot pack for an explicit source language", async () => {
    document.body.innerHTML = "<main><p>한국어 검색 결과</p></main>";
    aiRuntime.sendMessage.mockImplementation((message) =>
      isRecord(message) && message.type === "TRANSLATE"
        ? Promise.resolve({
            ok: false,
            error: {
              code: "provider_unavailable",
              message: "当前翻译 Provider 不可用。",
              retryable: false,
              details: "Provider=bergamot-local; Missing packs=ko-en.",
              reason: "bergamot_package_missing",
            },
          })
        : Promise.resolve({ ok: true }),
    );
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.provider.fastProvider = "bergamot-local";
    settings.page.sourceLanguage = "ko";
    settings.page.targetLanguage = "zh-CN";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(session.getStatus()).toMatchObject({
      state: "error",
      total: 1,
      completed: 0,
      failed: 1,
      details: "Provider=bergamot-local; Missing packs=ko-en.",
    });
    session.restore();
  });

  it("does not detect or translate a standalone interface symbol after skipping English target text", async () => {
    document.documentElement.lang = "en";
    document.body.innerHTML =
      '<main><p>Already in English</p><button><span id="shortcut">⌥<span hidden>Option</span></span></button></main>';
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.sourceLanguage = "auto";
    settings.page.targetLanguage = "en";
    settings.page.displayMode = "translated";

    await expect(session.translate(settings)).resolves.toMatchObject({
      state: "translated",
      completed: 2,
      failed: 0,
    });

    expect(localRuntime.translateBatch).not.toHaveBeenCalled();
    expect(document.querySelector("p")?.textContent).toBe("Already in English");
    expect(document.querySelector("#shortcut")?.firstChild?.textContent).toBe(
      "⌥",
    );
    session.restore();
  });

  it("starts Chrome local translation after a bounded content-cache read", async () => {
    document.body.innerHTML = "<main><p>Local cache timeout</p></main>";
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (isRecord(message) && message.type === "TRANSLATION_CACHE_GET") {
        return new Promise<unknown>(() => undefined);
      }
      return Promise.resolve({ ok: true });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    const pending = session.translate(settings);
    await vi.waitFor(
      () => expect(localRuntime.translateBatch).toHaveBeenCalledOnce(),
      { timeout: 800 },
    );
    await expect(pending).resolves.toMatchObject({
      state: "translated",
      completed: 1,
    });
    expect(document.querySelector("p")?.textContent).toBe(
      "T:Local cache timeout",
    );
    session.restore();
  });

  it("does not delay a local translation while its best-effort cache write is pending", async () => {
    document.body.innerHTML = "<main><p>Pending cache write</p></main>";
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (isRecord(message) && message.type === "TRANSLATION_CACHE_GET") {
        return Promise.resolve({ ok: true, hit: false, epoch: 11 });
      }
      if (isRecord(message) && message.type === "TRANSLATION_CACHE_SET") {
        return new Promise<unknown>(() => undefined);
      }
      return Promise.resolve({ ok: true });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await expect(session.translate(settings)).resolves.toMatchObject({
      state: "translated",
      completed: 1,
    });
    expect(document.querySelector("p")?.textContent).toBe(
      "T:Pending cache write",
    );
    session.restore();
  });

  it("reuses a normalized fast translation when equivalent text is inserted later", async () => {
    document.body.innerHTML =
      "<main><p>Reusable dynamic translation</p></main>";
    const sharedCache = new Map<string, string>();
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (!isRecord(message) || typeof message.type !== "string") {
        return Promise.resolve({ ok: true });
      }
      if (message.type === "TRANSLATION_CACHE_GET") {
        const key = typeof message.key === "string" ? message.key : "";
        const translatedText = sharedCache.get(key);
        return Promise.resolve({
          ok: true,
          epoch: 1,
          hit: translatedText !== undefined,
          ...(translatedText !== undefined ? { translatedText } : {}),
        });
      }
      if (message.type === "TRANSLATION_CACHE_SET") {
        if (
          typeof message.key === "string" &&
          typeof message.translatedText === "string"
        ) {
          sharedCache.set(message.key, message.translatedText);
        }
        return Promise.resolve({ ok: true, epoch: 1 });
      }
      return Promise.resolve({ ok: true });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(localRuntime.translateBatch).toHaveBeenCalledTimes(1);
    const dynamic = document.createElement("p");
    dynamic.textContent = "  Reusable\u00a0dynamic   translation  ";
    document.querySelector("main")?.append(dynamic);

    await vi.waitFor(
      () => expect(dynamic.textContent).toBe("T:Reusable dynamic translation"),
      { timeout: 1_200 },
    );
    expect(localRuntime.translateBatch).toHaveBeenCalledTimes(1);
    session.restore();
  });

  it("does not reuse a plain fast result for an equivalent protected inline segment", async () => {
    document.body.innerHTML =
      "<main><p>Repeat</p><p>Re<strong>peat</strong></p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.displayMode = "translated";

    await expect(session.translate(settings)).resolves.toMatchObject({
      state: "translated",
      completed: 2,
      failed: 0,
    });

    const segments = localRuntime.translateBatch.mock.calls.flatMap(
      ([request]) => request.segments,
    );
    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.format ?? "plain").sort()).toEqual(
      ["plain", "protected-text-v1"],
    );
    expect(
      [...document.querySelectorAll("p")].map((paragraph) =>
        paragraph.textContent?.replace(/\s+/gu, " "),
      ),
    ).toEqual(["T:Repeat", "T:Repeat"]);
    session.restore();
  });

  it("shares an in-flight normalized translation with matching dynamic text", async () => {
    document.body.innerHTML = "<main><p>Pending duplicate text</p></main>";
    let resolveTranslation:
      | ((results: Array<{ id: string; translatedText: string }>) => void)
      | undefined;
    localRuntime.translateBatch.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          resolveTranslation = resolve;
          expect(request.segments).toHaveLength(1);
        }),
    );
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    const initial = session.translate(settings);
    await vi.waitFor(() => expect(resolveTranslation).toBeTypeOf("function"));
    const dynamic = document.createElement("p");
    dynamic.textContent = "  Pending\u00a0duplicate   text  ";
    document.querySelector("main")?.append(dynamic);
    await new Promise((resolve) => window.setTimeout(resolve, 450));
    expect(localRuntime.translateBatch).toHaveBeenCalledOnce();

    const request = localRuntime.translateBatch.mock.calls[0]?.[0];
    resolveTranslation?.(
      request?.segments.map((segment) => ({
        id: segment.id,
        translatedText: "T:Pending duplicate text",
      })) ?? [],
    );
    await initial;
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll("p")].map((node) => node.textContent),
      ).toEqual(["T:Pending duplicate text", "T:Pending duplicate text"]),
    );
    expect(localRuntime.translateBatch).toHaveBeenCalledOnce();
    session.restore();
  });

  it("reuses a normalized AI translation across dynamic scans without another Provider request", async () => {
    document.body.innerHTML = "<main><p>Reusable AI translation</p></main>";
    let providerRequests = 0;
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      providerRequests += 1;
      return Promise.resolve({
        ok: true,
        results: message.request.segments.flatMap((segment: unknown) =>
          isRecord(segment) &&
          typeof segment.id === "string" &&
          typeof segment.text === "string"
            ? [{ id: segment.id, translatedText: `T:${segment.text}` }]
            : [],
        ),
      });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    await expect(session.translate(settings)).resolves.toMatchObject({
      state: "translated",
      completed: 1,
      failed: 0,
    });
    expect(document.querySelector("p")?.textContent).toBe(
      "T:Reusable AI translation",
    );
    expect(providerRequests).toBe(1);
    const dynamic = document.createElement("p");
    dynamic.textContent = "  Reusable\u00a0AI   translation  ";
    document.querySelector("main")?.append(dynamic);

    await vi.waitFor(
      () => expect(dynamic.textContent).toBe("T:Reusable AI translation"),
      { timeout: 1_200 },
    );
    expect(providerRequests).toBe(1);

    const changedTarget = structuredClone(settings);
    changedTarget.page.targetLanguage = "en";
    session.updateSettings(changedTarget);
    const otherLanguage = document.createElement("p");
    otherLanguage.textContent = "Reusable AI translation";
    document.querySelector("main")?.append(otherLanguage);
    await vi.waitFor(
      () => expect(otherLanguage.textContent).toBe("T:Reusable AI translation"),
      { timeout: 1_200 },
    );
    expect(providerRequests).toBe(2);

    session.restore();
    expect(document.querySelector("p")?.textContent).toBe(
      "Reusable AI translation",
    );
    expect(dynamic.textContent).toBe("  Reusable\u00a0AI   translation  ");
    expect(otherLanguage.textContent).toBe("Reusable AI translation");
    await session.translate(settings);
    expect(providerRequests).toBe(3);
    session.restore();
  });

  it("reuses normalized same text while translating new surrounding context", async () => {
    document.body.innerHTML =
      "<main><p>Software command</p><p>Run</p><p>Terminal output</p></main>";
    let providerRequests = 0;
    const requestedTexts: string[] = [];
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      providerRequests += 1;
      requestedTexts.push(
        ...message.request.segments.flatMap((segment: unknown) =>
          isRecord(segment) && typeof segment.text === "string"
            ? [segment.text]
            : [],
        ),
      );
      return Promise.resolve({
        ok: true,
        results: message.request.segments.flatMap((segment: unknown) => {
          if (
            !isRecord(segment) ||
            typeof segment.id !== "string" ||
            typeof segment.text !== "string"
          ) {
            return [];
          }
          const contextBefore = Array.isArray(segment.contextBefore)
            ? segment.contextBefore.join(" > ")
            : "none";
          return [
            {
              id: segment.id,
              translatedText: `CTX:${contextBefore}:${segment.text}`,
            },
          ];
        }),
      });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(providerRequests).toBe(1);
    const initialRunTranslation =
      document.querySelectorAll("p")[1]?.textContent;
    const section = document.createElement("section");
    section.innerHTML =
      "<p>Athlete introduction</p><p id=dynamic-run>Run</p><p>Finish line</p>";
    document.querySelector("main")?.append(section);

    await vi.waitFor(
      () =>
        expect(document.querySelector("#dynamic-run")?.textContent).toBe(
          initialRunTranslation,
        ),
      { timeout: 1_200 },
    );
    expect(providerRequests).toBe(2);
    expect(requestedTexts.filter((text) => text === "Run")).toHaveLength(1);
    session.restore();
  });

  it("sends same-text AI segments with different contexts only once", async () => {
    document.body.innerHTML =
      '<main><p>Software command</p><p id="command-run">Run</p><p>Terminal output</p><p>Athlete introduction</p><p id="athlete-run">Run</p><p>Finish line</p></main>';
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    const requests = aiRuntime.sendMessage.mock.calls.flatMap(([message]) =>
      isRecord(message) &&
      message.type === "TRANSLATE" &&
      isRecord(message.request) &&
      Array.isArray(message.request.segments)
        ? [message.request.segments]
        : [],
    );
    expect(requests).toHaveLength(1);
    expect(
      requests.map(
        (segments) =>
          segments.filter(
            (segment) => isRecord(segment) && segment.text === "Run",
          ).length,
      ),
    ).toEqual([1]);
    expect(document.querySelector("#command-run")?.textContent).toBe("T:Run");
    expect(document.querySelector("#athlete-run")?.textContent).toBe("T:Run");
    session.restore();
  });

  it("translates assigned text when a previously hidden slot becomes visible", async () => {
    document.body.innerHTML =
      "<x-dynamic-slot><p>Revealed assigned text</p></x-dynamic-slot>";
    const host = document.querySelector("x-dynamic-slot");
    if (!host) throw new Error("missing dynamic slot host");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<slot hidden></slot>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(session.getStatus()).toMatchObject({ state: "idle", total: 0 });

    shadow.querySelector("slot")?.removeAttribute("hidden");
    await vi.waitFor(
      () =>
        expect(document.querySelector("p")?.textContent).toBe(
          "T:Revealed assigned text",
        ),
      { timeout: 1_500 },
    );
    session.restore();
  });

  it("clears completed in-memory reuse while keeping dynamic translation active", async () => {
    document.body.innerHTML = "<main><p>Completed page fixture</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(localRuntime.translateBatch).toHaveBeenCalledTimes(1);
    expect(session.handleCacheCleared()).toMatchObject({
      state: "translated",
      total: 1,
      completed: 1,
      failed: 0,
    });

    const paragraph = document.createElement("p");
    paragraph.textContent = "Completed page fixture";
    document.querySelector("main")?.append(paragraph);
    await vi.waitFor(
      () => expect(paragraph.textContent).toBe("T:Completed page fixture"),
      { timeout: 1_200 },
    );
    expect(localRuntime.translateBatch).toHaveBeenCalledTimes(2);
    session.restore();
  });

  it("keeps dynamic translation active when cancellation is requested after partial completion", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 21 },
      (_, index) => `<p>Partial page fixture ${index + 1}</p>`,
    ).join("")}</main>`;
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    localRuntime.translateBatch
      .mockImplementationOnce((request) =>
        Promise.resolve(
          request.segments.map((segment) => ({
            id: segment.id,
            translatedText: `T:${segment.text}`,
          })),
        ),
      )
      .mockRejectedValueOnce(new Error("last batch failed"));

    await expect(session.translate(settings)).resolves.toMatchObject({
      state: "partial",
      total: 21,
      completed: 20,
      failed: 1,
    });
    expect(session.cancelPendingTranslations().state).toBe("partial");

    const paragraph = document.createElement("p");
    paragraph.textContent = "Added after partial cache clear";
    document.querySelector("main")?.append(paragraph);
    await vi.waitFor(
      () =>
        expect(paragraph.textContent).toBe("T:Added after partial cache clear"),
      { timeout: 1_200 },
    );
    session.restore();
  });

  it("continues translating after the page replaces its entire body", async () => {
    document.body.innerHTML = "<main><p>Initial body fixture</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    await session.translate(settings);

    const nextBody = document.createElement("body");
    nextBody.innerHTML = "<main><p>Replacement body fixture</p></main>";
    document.body.replaceWith(nextBody);

    await vi.waitFor(
      () =>
        expect(nextBody.querySelector("p")?.textContent).toBe(
          "T:Replacement body fixture",
        ),
      { timeout: 1_500 },
    );
    session.restore();
  });

  it("translates existing text when an attribute change makes it visible", async () => {
    document.body.innerHTML =
      '<main><p id="revealed" style="display:none">Revealed later</p></main>';
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    const paragraph = document.querySelector<HTMLElement>("#revealed");
    expect(paragraph?.textContent).toBe("Revealed later");
    paragraph?.removeAttribute("style");

    await vi.waitFor(
      () => expect(paragraph?.textContent).toBe("T:Revealed later"),
      { timeout: 1_200 },
    );
    session.restore();
  });

  it("translates existing text when a class change reveals it", async () => {
    document.body.innerHTML =
      '<style>.collapsed-copy{display:none}</style><main><p id="class-revealed" class="collapsed-copy">Class revealed later</p></main>';
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    const paragraph = document.querySelector<HTMLElement>("#class-revealed");
    expect(paragraph?.textContent).toBe("Class revealed later");
    paragraph?.classList.remove("collapsed-copy");

    await vi.waitFor(
      () => expect(paragraph?.textContent).toBe("T:Class revealed later"),
      { timeout: 1_200 },
    );
    session.restore();
  });

  it("translates text revealed only by pointer hover without a DOM mutation", async () => {
    document.body.innerHTML =
      '<main><div id="hover-zone">Hover trigger<p id="hover-copy">Hover-only copy</p></div></main>';
    const hoverCopy = document.querySelector<HTMLElement>("#hover-copy");
    const hoverZone = document.querySelector<HTMLElement>("#hover-zone");
    if (!hoverCopy || !hoverZone) throw new Error("missing hover fixture");
    let revealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== hoverCopy) return style;
        return {
          ...style,
          display: revealed ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      expect(hoverCopy.textContent).toBe("Hover-only copy");
      expect(localRuntime.translateBatch).toHaveBeenCalledTimes(1);

      revealed = true;
      hoverZone.dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true, composed: true }),
      );

      await vi.waitFor(
        () => expect(hoverCopy.textContent).toBe("T:Hover-only copy"),
        { timeout: 1_000 },
      );
      expect(localRuntime.translateBatch).toHaveBeenCalledTimes(2);
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("rebuilds one bilingual semantic block when hover reveals an inline child without a mutation", async () => {
    document.body.innerHTML =
      '<main><p id="hover-inline-zone">Visible <span id="hover-inline-copy">conditional</span> text</p></main>';
    const paragraph = document.querySelector<HTMLElement>("#hover-inline-zone");
    const conditional =
      document.querySelector<HTMLElement>("#hover-inline-copy");
    if (!paragraph || !conditional)
      throw new Error("missing hover inline fixture");
    let revealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== conditional) return style;
        return {
          ...style,
          display: revealed ? "inline" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "bilingual";

    try {
      await session.translate(settings);
      expect(document.querySelectorAll("noritrans-translation")).toHaveLength(
        1,
      );

      revealed = true;
      paragraph.dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true, composed: true }),
      );

      await vi.waitFor(
        () => {
          const companions = document.querySelectorAll("noritrans-translation");
          expect(companions).toHaveLength(1);
          expect(
            companions[0]?.shadowRoot?.querySelector("span")?.textContent,
          ).toBe("T:Visible conditional text");
        },
        { timeout: 1_200 },
      );
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("does not drop the ninth independent hover reveal in one debounce window", async () => {
    document.body.innerHTML = Array.from(
      { length: 9 },
      (_, index) =>
        `<div class="hover-burst-zone" data-index="${index}"><p class="hover-burst-copy" data-index="${index}">Hover burst ${index + 1}</p></div>`,
    ).join("");
    const zones = [
      ...document.querySelectorAll<HTMLElement>(".hover-burst-zone"),
    ];
    const copies = [
      ...document.querySelectorAll<HTMLElement>(".hover-burst-copy"),
    ];
    let revealedIndex = -1;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (!element.classList.contains("hover-burst-copy")) return style;
        return {
          ...style,
          display:
            Number(element.getAttribute("data-index")) === revealedIndex
              ? "block"
              : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      revealedIndex = 8;
      for (const zone of zones) {
        zone.dispatchEvent(
          new MouseEvent("pointerover", { bubbles: true, composed: true }),
        );
      }

      await vi.waitFor(
        () => expect(copies[8]?.textContent).toBe("T:Hover burst 9"),
        { timeout: 1_000 },
      );
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("scans a deep hover host when CSS reveals a sibling without mutations", async () => {
    document.body.innerHTML = `
      <main>
        <section id="deep-hover-host">
          <div><div><div><div><span id="deep-hover-target">Hover target</span></div></div></div></div>
          <p id="deep-hover-copy">Deep hover copy</p>
        </section>
      </main>`;
    const target = document.querySelector<HTMLElement>("#deep-hover-target");
    const copy = document.querySelector<HTMLElement>("#deep-hover-copy");
    if (!target || !copy) throw new Error("missing deep hover fixture");
    let revealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== copy) return style;
        return {
          ...style,
          display: revealed ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      expect(copy.textContent).toBe("Deep hover copy");

      revealed = true;
      target.dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true, composed: true }),
      );

      await vi.waitFor(
        () => expect(copy.textContent).toBe("T:Deep hover copy"),
        { timeout: 1_000 },
      );
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("translates text revealed by click without requiring a DOM mutation", async () => {
    document.body.innerHTML =
      '<main><button id="click-trigger" aria-controls="click-copy">Open</button><p id="click-copy">Click-only copy</p></main>';
    const trigger = document.querySelector<HTMLElement>("#click-trigger");
    const copy = document.querySelector<HTMLElement>("#click-copy");
    if (!trigger || !copy) throw new Error("missing click fixture");
    let revealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== copy) return style;
        return {
          ...style,
          display: revealed ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      expect(copy.textContent).toBe("Click-only copy");

      revealed = true;
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      await vi.waitFor(
        () => expect(copy.textContent).toBe("T:Click-only copy"),
        { timeout: 1_000 },
      );
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("scans an aria-controlled popup after keyboard focus reveals it", async () => {
    document.body.innerHTML =
      '<main><button id="trigger" aria-controls="focus-popup">Open menu</button><div id="focus-popup"><p id="focus-copy">Keyboard-only copy</p></div></main>';
    const trigger = document.querySelector<HTMLElement>("#trigger");
    const focusPopup = document.querySelector<HTMLElement>("#focus-popup");
    const focusCopy = document.querySelector<HTMLElement>("#focus-copy");
    if (!trigger || !focusPopup || !focusCopy)
      throw new Error("missing focus fixture");
    let revealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== focusPopup) return style;
        return {
          ...style,
          display: revealed ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      expect(focusCopy.textContent).toBe("Keyboard-only copy");

      revealed = true;
      trigger.dispatchEvent(
        new FocusEvent("focusin", { bubbles: true, composed: true }),
      );

      await vi.waitFor(
        () => expect(focusCopy.textContent).toBe("T:Keyboard-only copy"),
        { timeout: 1_000 },
      );
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("scans an aria-controlled popup inside the trigger's open shadow root", async () => {
    const host = document.createElement("x-shadow-menu");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<button id="trigger" aria-controls="shadow-popup">Open menu</button><div id="shadow-popup"><p id="shadow-copy">Shadow popup copy</p></div>';
    document.body.append(host);
    const trigger = shadow.querySelector<HTMLElement>("#trigger");
    const popup = shadow.querySelector<HTMLElement>("#shadow-popup");
    const copy = shadow.querySelector<HTMLElement>("#shadow-copy");
    if (!trigger || !popup || !copy)
      throw new Error("missing shadow popup fixture");
    let revealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== popup) return style;
        return {
          ...style,
          display: revealed ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      expect(copy.textContent).toBe("Shadow popup copy");

      revealed = true;
      trigger.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      );

      await vi.waitFor(
        () => expect(copy.textContent).toBe("T:Shadow popup copy"),
        { timeout: 1_000 },
      );
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("resolves a native popovertarget portal on click", async () => {
    document.body.innerHTML =
      '<main><button id="popover-trigger" popovertarget="native-popover">Open native menu</button></main><div id="native-popover" popover><p id="popover-copy">Native portal copy</p></div>';
    const trigger = document.querySelector<HTMLElement>("#popover-trigger");
    const popover = document.querySelector<HTMLElement>("#native-popover");
    const copy = document.querySelector<HTMLElement>("#popover-copy");
    if (!trigger || !popover || !copy)
      throw new Error("missing native popover fixture");
    let revealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== popover) return style;
        return {
          ...style,
          display: revealed ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      expect(copy.textContent).toBe("Native portal copy");

      revealed = true;
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      await vi.waitFor(
        () => expect(copy.textContent).toBe("T:Native portal copy"),
        { timeout: 1_000 },
      );
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("captures a non-bubbling native toggle event after keyboard activation", async () => {
    document.body.innerHTML =
      '<main><button id="keyboard-popover-trigger" popovertarget="keyboard-popover">Open</button><div id="keyboard-popover" popover><p id="keyboard-popover-copy">Keyboard popover copy</p></div></main>';
    const trigger = document.querySelector<HTMLElement>(
      "#keyboard-popover-trigger",
    );
    const popover = document.querySelector<HTMLElement>("#keyboard-popover");
    const copy = document.querySelector<HTMLElement>("#keyboard-popover-copy");
    if (!trigger || !popover || !copy)
      throw new Error("missing keyboard popover fixture");
    let revealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== popover) return style;
        return {
          ...style,
          display: revealed ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      expect(copy.textContent).toBe("Keyboard popover copy");

      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      revealed = true;
      popover.dispatchEvent(new Event("toggle"));

      await vi.waitFor(
        () => expect(copy.textContent).toBe("T:Keyboard popover copy"),
        { timeout: 1_000 },
      );
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it.each(["aria-expanded", "data-state", "data-open"])(
    "scans a controlled portal after %s changes",
    async (attribute) => {
      document.body.innerHTML =
        '<main><button id="state-trigger" aria-controls="state-portal">Open state portal</button></main><div id="state-portal"><p id="state-copy">Controlled state copy</p></div>';
      const trigger = document.querySelector<HTMLElement>("#state-trigger");
      const portal = document.querySelector<HTMLElement>("#state-portal");
      const copy = document.querySelector<HTMLElement>("#state-copy");
      if (!trigger || !portal || !copy)
        throw new Error("missing controlled state fixture");
      let revealed = false;
      const nativeGetComputedStyle = window.getComputedStyle.bind(window);
      const styleSpy = vi
        .spyOn(window, "getComputedStyle")
        .mockImplementation((element, pseudoElement) => {
          const style = nativeGetComputedStyle(element, pseudoElement);
          if (element !== portal) return style;
          return {
            ...style,
            display: revealed ? "block" : "none",
            visibility: style.visibility,
            opacity: style.opacity,
          };
        });
      const session = new PageTranslationSession(vi.fn());
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.page.displayMode = "translated";

      try {
        await session.translate(settings);
        expect(copy.textContent).toBe("Controlled state copy");

        revealed = true;
        const target = attribute === "aria-expanded" ? trigger : portal;
        target.setAttribute(attribute, "open");

        await vi.waitFor(
          () => expect(copy.textContent).toBe("T:Controlled state copy"),
          { timeout: 1_000 },
        );
      } finally {
        session.restore();
        styleSpy.mockRestore();
      }
    },
  );

  it("debounces layout and visual viewport resize scans without retranslating seen text", async () => {
    const originalVisualViewport = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const visualViewport = new EventTarget() as VisualViewport;
    Object.defineProperties(visualViewport, {
      width: { configurable: true, value: 900 },
      height: { configurable: true, value: 700 },
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });
    document.body.innerHTML =
      '<main><p>Resize baseline</p><section id="layout-copy">Layout resize copy</section><aside id="visual-copy">Visual viewport copy</aside></main>';
    const layoutCopy = document.querySelector<HTMLElement>("#layout-copy");
    const visualCopy = document.querySelector<HTMLElement>("#visual-copy");
    if (!layoutCopy || !visualCopy)
      throw new Error("missing responsive resize fixture");
    let layoutRevealed = false;
    let visualRevealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== layoutCopy && element !== visualCopy) return style;
        const revealed =
          element === layoutCopy ? layoutRevealed : visualRevealed;
        return {
          ...style,
          display: revealed ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      expect(localRuntime.translateBatch).toHaveBeenCalledTimes(1);

      layoutRevealed = true;
      for (let index = 0; index < 5; index += 1) {
        window.dispatchEvent(new Event("resize"));
      }
      await vi.waitFor(
        () => expect(layoutCopy.textContent).toBe("T:Layout resize copy"),
        { timeout: 1_000 },
      );
      expect(localRuntime.translateBatch).toHaveBeenCalledTimes(2);

      window.dispatchEvent(new Event("resize"));
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      expect(localRuntime.translateBatch).toHaveBeenCalledTimes(2);

      visualRevealed = true;
      for (let index = 0; index < 4; index += 1) {
        visualViewport.dispatchEvent(new Event("resize"));
      }
      await vi.waitFor(
        () => expect(visualCopy.textContent).toBe("T:Visual viewport copy"),
        { timeout: 1_000 },
      );
      expect(localRuntime.translateBatch).toHaveBeenCalledTimes(3);
    } finally {
      session.restore();
      styleSpy.mockRestore();
      if (originalVisualViewport) {
        Object.defineProperty(window, "visualViewport", originalVisualViewport);
      } else {
        Reflect.deleteProperty(window, "visualViewport");
      }
    }
  });

  it("updates a bilingual companion without leaving the previous translation", async () => {
    document.body.innerHTML = "<main><p>Initial bilingual source</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "bilingual";

    await session.translate(settings);
    const paragraph = document.querySelector("p");
    const source = paragraph?.firstChild;
    if (!(source instanceof Text)) throw new Error("invalid source fixture");
    expect(document.querySelectorAll("noritrans-translation")).toHaveLength(1);

    source.textContent = "Updated bilingual source";
    await vi.waitFor(
      () => {
        const translations = document.querySelectorAll("noritrans-translation");
        expect(translations).toHaveLength(1);
        expect(
          translations[0]?.shadowRoot?.querySelector("span")?.textContent,
        ).toBe("T:Updated bilingual source");
      },
      { timeout: 1_200 },
    );
    session.restore();
  });

  it("retranslates a complete bilingual semantic block after inline text is appended", async () => {
    document.body.innerHTML = "<main><p>Original sentence</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "bilingual";

    await session.translate(settings);
    const paragraph = document.querySelector("p");
    const strong = document.createElement("strong");
    strong.textContent = " with emphasis";
    paragraph?.append(strong);

    await vi.waitFor(
      () => {
        const translations = document.querySelectorAll("noritrans-translation");
        expect(translations).toHaveLength(1);
        expect(
          translations[0]?.shadowRoot?.querySelector("span")?.textContent,
        ).toBe("T:Original sentence with emphasis");
      },
      { timeout: 1_200 },
    );
    expect(paragraph?.textContent).toBe("Original sentence with emphasis");
    session.restore();
  });

  it("replaces one bilingual semantic block when a hidden inline child is revealed and hidden again", async () => {
    document.body.innerHTML =
      '<main><p id="semantic-copy">Visible <span id="conditional-copy" hidden>conditional</span> text</p></main>';
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "bilingual";

    await session.translate(settings);
    const conditional =
      document.querySelector<HTMLElement>("#conditional-copy");
    if (!conditional) throw new Error("missing conditional inline fixture");
    expect(document.querySelectorAll("noritrans-translation")).toHaveLength(1);

    conditional.hidden = false;
    await vi.waitFor(
      () => {
        const companions = document.querySelectorAll("noritrans-translation");
        expect(companions).toHaveLength(1);
        expect(
          companions[0]?.shadowRoot?.querySelector("span")?.textContent,
        ).toBe("T:Visible conditional text");
      },
      { timeout: 1_500 },
    );

    conditional.hidden = true;
    await vi.waitFor(
      () => {
        const companions = document.querySelectorAll("noritrans-translation");
        expect(companions).toHaveLength(1);
        expect(
          companions[0]?.shadowRoot?.querySelector("span")?.textContent,
        ).toBe("T:Visible  text");
      },
      { timeout: 1_500 },
    );
    session.restore();
  });

  it("requeues a failed hover reveal when it becomes visible again without a mutation", async () => {
    document.body.innerHTML =
      '<main><div id="hover-retry-zone"><p id="hover-retry-copy">Hover retry copy</p></div></main>';
    const zone = document.querySelector<HTMLElement>("#hover-retry-zone");
    const copy = document.querySelector<HTMLElement>("#hover-retry-copy");
    if (!zone || !copy) throw new Error("missing hover retry fixture");
    let revealed = false;
    const nativeGetComputedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element, pseudoElement) => {
        const style = nativeGetComputedStyle(element, pseudoElement);
        if (element !== copy) return style;
        return {
          ...style,
          display: revealed ? "block" : "none",
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
    let resolveTranslation:
      | ((results: Array<{ id: string; translatedText: string }>) => void)
      | undefined;
    localRuntime.translateBatch.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          resolveTranslation = () =>
            resolve(
              request.segments.map((segment) => ({
                id: segment.id,
                translatedText: `T:${segment.text}`,
              })),
            );
        }),
    );
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    try {
      await session.translate(settings);
      revealed = true;
      zone.dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true, composed: true }),
      );
      await vi.waitFor(
        () => expect(resolveTranslation).toBeTypeOf("function"),
        { timeout: 1_000 },
      );

      revealed = false;
      resolveTranslation?.([]);
      await vi.waitFor(() => expect(session.getStatus().failed).toBe(1), {
        timeout: 1_000,
      });
      expect(copy.textContent).toBe("Hover retry copy");
      expect(localRuntime.translateBatch).toHaveBeenCalledTimes(1);

      revealed = true;
      zone.dispatchEvent(
        new MouseEvent("pointerover", { bubbles: true, composed: true }),
      );
      await vi.waitFor(
        () => expect(copy.textContent).toBe("T:Hover retry copy"),
        { timeout: 1_000 },
      );
      expect(localRuntime.translateBatch).toHaveBeenCalledTimes(1);
      expect(session.getStatus().failed).toBe(0);
    } finally {
      session.restore();
      styleSpy.mockRestore();
    }
  });

  it("restores and retranslates a complete replaced block after text is appended", async () => {
    document.body.innerHTML = "<main><p>Original replacement</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    const paragraph = document.querySelector("p");
    paragraph?.append(document.createTextNode(" plus more"));

    await vi.waitFor(
      () =>
        expect(paragraph?.textContent).toBe("T:Original replacement plus more"),
      { timeout: 1_200 },
    );
    session.restore();
    expect(paragraph?.textContent).toBe("Original replacement plus more");
  });

  it("uses existing document source text as context for dynamic AI batches", async () => {
    document.body.innerHTML =
      "<main><p>First source paragraph</p><p>Second source paragraph</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(
      [...document.querySelectorAll("p")].map((node) => node.textContent),
    ).toEqual(["T:First source paragraph", "T:Second source paragraph"]);
    aiRuntime.sendMessage.mockClear();
    const dynamic = document.createElement("p");
    dynamic.textContent = "Dynamic AI paragraph";
    document.querySelector("main")?.append(dynamic);

    await vi.waitFor(
      () => {
        const message = aiRuntime.sendMessage.mock.calls.find(([candidate]) => {
          if (!isRecord(candidate) || !isRecord(candidate.request))
            return false;
          if (!Array.isArray(candidate.request.segments)) return false;
          return candidate.request.segments.some(
            (segment) =>
              isRecord(segment) && segment.text === "Dynamic AI paragraph",
          );
        })?.[0];
        if (!isRecord(message) || !isRecord(message.request)) {
          throw new Error("missing dynamic AI request");
        }
        const requestSegments: unknown[] = Array.isArray(
          message.request.segments,
        )
          ? message.request.segments
          : [];
        const segment = requestSegments.find(
          (candidate) =>
            isRecord(candidate) && candidate.text === "Dynamic AI paragraph",
        );
        expect(isRecord(segment) ? segment.contextBefore : undefined).toEqual([
          "First source paragraph",
          "Second source paragraph",
        ]);
      },
      { timeout: 1_200 },
    );
    session.restore();
  });

  it("renders dynamic AI progress immediately and blocks its final response after restore", async () => {
    document.body.innerHTML = "<main><p>Initial AI source</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    await session.translate(settings);
    let pending:
      | {
          requestId: string;
          segment: { id: string; text: string };
          resolve(value: unknown): void;
        }
      | undefined;
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segment = (message.request.segments as unknown[])[0];
      if (
        !isRecord(segment) ||
        typeof segment.id !== "string" ||
        typeof segment.text !== "string"
      ) {
        throw new Error("missing dynamic progress segment");
      }
      const segmentId = segment.id;
      const segmentText = segment.text;
      return new Promise((resolve) => {
        pending = {
          requestId: String(message.requestId),
          segment: { id: segmentId, text: segmentText },
          resolve,
        };
      });
    });
    const dynamic = document.createElement("p");
    dynamic.textContent = "Dynamic progressive source";
    document.querySelector("main")?.append(dynamic);
    await vi.waitFor(() => expect(pending).toBeDefined(), { timeout: 1_200 });
    if (!pending) throw new Error("missing pending dynamic AI request");

    for (const listener of aiRuntime.listeners) {
      listener({
        type: "TRANSLATION_PROGRESS",
        requestId: pending.requestId,
        result: {
          id: pending.segment.id,
          translatedText: "Dynamic progress result",
        },
      });
    }
    await vi.waitFor(() =>
      expect(dynamic.textContent).toBe("Dynamic progress result"),
    );

    session.restore();
    expect(dynamic.textContent).toBe("Dynamic progressive source");
    pending.resolve({
      ok: true,
      results: [
        {
          id: pending.segment.id,
          translatedText: "Obsolete final result",
        },
      ],
    });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(dynamic.textContent).toBe("Dynamic progressive source");
    expect(session.getStatus()).toMatchObject({ state: "idle", total: 0 });
  });

  it("does not miss text inserted while the initial provider request is pending", async () => {
    document.body.innerHTML = "<main><p>Initial pending fixture</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    let resolveInitial:
      | ((results: Array<{ id: string; translatedText: string }>) => void)
      | undefined;
    localRuntime.translateBatch.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          resolveInitial = () =>
            resolve(
              request.segments.map((segment) => ({
                id: segment.id,
                translatedText: `T:${segment.text}`,
              })),
            );
        }),
    );

    const run = session.translate(settings);
    await vi.waitFor(() => expect(resolveInitial).toBeTypeOf("function"));
    const paragraph = document.createElement("p");
    paragraph.textContent = "Inserted during request";
    document.querySelector("main")?.append(paragraph);
    resolveInitial?.([]);
    await run;
    await vi.waitFor(
      () => expect(paragraph.textContent).toBe("T:Inserted during request"),
      { timeout: 1_200 },
    );
    session.restore();
  });

  it("ignores a pending partial-block result and retranslates the complete changed anchor", async () => {
    document.body.innerHTML = "<main><p>Pending anchor</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    let resolveInitial:
      | ((results: Array<{ id: string; translatedText: string }>) => void)
      | undefined;
    localRuntime.translateBatch.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          resolveInitial = () =>
            resolve(
              request.segments.map((segment) => ({
                id: segment.id,
                translatedText: `STALE:${segment.text}`,
              })),
            );
        }),
    );

    const run = session.translate(settings);
    await vi.waitFor(() => expect(resolveInitial).toBeTypeOf("function"));
    const paragraph = document.querySelector("p");
    const strong = document.createElement("strong");
    strong.textContent = " plus appended text";
    paragraph?.append(strong);
    resolveInitial?.([]);
    await run;

    await vi.waitFor(
      () =>
        expect(paragraph?.textContent).toBe(
          "T:Pending anchor plus appended text",
        ),
      { timeout: 1_200 },
    );
    expect(paragraph?.textContent).not.toContain("STALE:");
    session.restore();
  });

  it("does not report completion while a dynamic translation run is still pending", async () => {
    document.body.innerHTML = "<main><p>Initial status fixture</p></main>";
    const statuses: Array<{ state: string; total: number; completed: number }> =
      [];
    const session = new PageTranslationSession((status) =>
      statuses.push({
        state: status.state,
        total: status.total,
        completed: status.completed,
      }),
    );
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    const resolvers: Array<() => void> = [];
    localRuntime.translateBatch.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          resolvers.push(() =>
            resolve(
              request.segments.map((segment) => ({
                id: segment.id,
                translatedText: `T:${segment.text}`,
              })),
            ),
          );
        }),
    );

    const initialRun = session.translate(settings);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const dynamic = document.createElement("p");
    dynamic.textContent = "Dynamic status fixture";
    document.querySelector("main")?.append(dynamic);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2), {
      timeout: 1_200,
    });

    resolvers[0]?.();
    await initialRun;
    expect(session.getStatus()).toMatchObject({
      state: "translating",
      total: 2,
      completed: 1,
    });
    expect(statuses.at(-1)?.state).toBe("translating");

    resolvers[1]?.();
    await vi.waitFor(() =>
      expect(session.getStatus()).toMatchObject({
        state: "translated",
        total: 2,
        completed: 2,
      }),
    );
    session.restore();
  });

  it("translates large AI pages with a bounded eight-request worker pool", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 421 },
      (_, index) => `<p>Concurrent AI paragraph ${index + 1}</p>`,
    ).join("")}</main>`;
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";
    let active = 0;
    let maximumActive = 0;
    aiRuntime.sendMessage.mockImplementation(async (message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return { ok: true };
      }
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => window.setTimeout(resolve, 35));
      active -= 1;
      return {
        ok: true,
        results: segments.map((segment) => ({
          id: segment.id,
          translatedText: `T:${segment.text}`,
        })),
      };
    });

    try {
      await session.translate(settings);

      expect(maximumActive).toBe(8);
      expect(session.getStatus()).toMatchObject({
        state: "translated",
        total: 421,
        completed: 421,
        failed: 0,
      });
    } finally {
      session.restore();
    }
  }, 30_000);

  it("keeps initial and dynamic AI runs within one global eight-request pool", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 348 },
      (_, index) => `<p>Initial concurrent paragraph ${index + 1}</p>`,
    ).join("")}</main>`;
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.aiResponseMode = "batch";
    settings.page.displayMode = "translated";
    let active = 0;
    let maximumActive = 0;
    let releaseInitialRequests: (() => void) | undefined;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitialRequests = resolve;
    });
    aiRuntime.sendMessage.mockImplementation(async (message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return { ok: true };
      }
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await initialGate;
      active -= 1;
      return {
        ok: true,
        results: segments.map((segment) => ({
          id: segment.id,
          translatedText: `T:${segment.text}`,
        })),
      };
    });

    const initial = session.translate(settings);
    try {
      await vi.waitFor(() => expect(active).toBe(8));
      const dynamic = document.createElement("section");
      dynamic.innerHTML = Array.from(
        { length: 348 },
        (_, index) => `<p>Dynamic concurrent paragraph ${index + 1}</p>`,
      ).join("");
      document.querySelector("main")?.append(dynamic);
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      expect(active).toBe(8);
      expect(maximumActive).toBe(8);
    } finally {
      releaseInitialRequests?.();
      await initial;
      session.restore();
    }
  }, 20_000);

  it("translates fast page batches with a bounded eight-request worker pool", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 141 },
      (_, index) => `<p>Concurrent fast paragraph ${index + 1}</p>`,
    ).join("")}</main>`;
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.displayMode = "translated";
    let active = 0;
    let maximumActive = 0;
    localRuntime.translateBatch.mockImplementation(async (request) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => window.setTimeout(resolve, 25));
      active -= 1;
      return request.segments.map((segment) => ({
        id: segment.id,
        translatedText: `T:${segment.text}`,
      }));
    });

    await session.translate(settings);

    expect(maximumActive).toBe(8);
    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 141,
      completed: 141,
      failed: 0,
    });
    session.restore();
  });

  it("splits an oversized request without splitting the website Text node", async () => {
    const original = `Beginning ${"long text ".repeat(760)}ending`;
    document.body.innerHTML = "<main><p></p></main>";
    const paragraph = document.querySelector("p");
    const source = document.createTextNode(original);
    paragraph?.append(source);
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    const requests: Array<{ id: string; text: string }> = [];
    for (const [message] of aiRuntime.sendMessage.mock.calls) {
      const request = isRecord(message) ? message.request : undefined;
      if (!isRecord(request) || !Array.isArray(request.segments)) continue;
      for (const segment of request.segments) {
        if (
          isRecord(segment) &&
          typeof segment.id === "string" &&
          typeof segment.text === "string"
        ) {
          requests.push({ id: segment.id, text: segment.text });
        }
      }
    }
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((segment) => segment.text.length <= 3_000)).toBe(
      true,
    );
    expect(paragraph?.childNodes).toHaveLength(1);
    expect(paragraph?.firstChild).toBe(source);
    expect(paragraph?.textContent?.startsWith("T:")).toBe(true);
    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 1,
      completed: 1,
      failed: 0,
    });

    session.restore();
    expect(paragraph?.firstChild).toBe(source);
    expect(paragraph?.textContent).toBe(original);
  });

  it("reassembles hard-split Japanese Provider results without inserting ASCII spaces", async () => {
    const original = "日".repeat(6_200);
    document.body.innerHTML = "<main><p></p></main>";
    document.querySelector("p")?.append(document.createTextNode(original));
    localRuntime.translateBatch.mockImplementation((request) =>
      Promise.resolve(
        request.segments.map((segment) => ({
          id: segment.id,
          translatedText: "訳",
        })),
      ),
    );
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.sourceLanguage = "ja";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    const requested = localRuntime.translateBatch.mock.calls.flatMap(
      ([request]) => request.segments,
    );
    expect(requested).toHaveLength(2);
    expect(document.querySelector("p")?.textContent).toBe("訳訳訳");
    session.restore();
  });

  it("reassembles whitespace-split Provider results with a natural interval", async () => {
    const original = "word ".repeat(900);
    document.body.innerHTML = "<main><p></p></main>";
    document.querySelector("p")?.append(document.createTextNode(original));
    localRuntime.translateBatch.mockImplementation((request) =>
      Promise.resolve(
        request.segments.map((segment) => ({
          id: segment.id,
          translatedText: "piece",
        })),
      ),
    );
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    const requested = localRuntime.translateBatch.mock.calls.flatMap(
      ([request]) => request.segments,
    );
    expect(requested).toHaveLength(2);
    expect(document.querySelector("p")?.textContent).toBe("piece piece");
    session.restore();
  });

  it("reassembles hard-split Japanese cache hits without inserting ASCII spaces", async () => {
    const original = "日".repeat(6_200);
    document.body.innerHTML = "<main><p></p></main>";
    document.querySelector("p")?.append(document.createTextNode(original));
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (isRecord(message) && message.type === "TRANSLATION_CACHE_GET") {
        return Promise.resolve({
          ok: true,
          epoch: 7,
          hit: true,
          translatedText: "存",
        });
      }
      return Promise.resolve({ ok: true });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.sourceLanguage = "ja";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    const cacheReads = aiRuntime.sendMessage.mock.calls.filter(
      ([message]) =>
        isRecord(message) && message.type === "TRANSLATION_CACHE_GET",
    );
    expect(cacheReads).toHaveLength(2);
    expect(localRuntime.translateBatch).not.toHaveBeenCalled();
    expect(document.querySelector("p")?.textContent).toBe("存存存");
    session.restore();
  });

  it("keeps local page cache reads globally bounded across concurrent batches", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 161 },
      (_, index) => `<p>Bounded cache paragraph ${index + 1}</p>`,
    ).join("")}</main>`;
    let activeReads = 0;
    let maximumActiveReads = 0;
    aiRuntime.sendMessage.mockImplementation(async (message) => {
      if (isRecord(message) && message.type === "TRANSLATION_CACHE_GET") {
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        await new Promise((resolve) => window.setTimeout(resolve, 8));
        activeReads -= 1;
        return { ok: true, epoch: 9, hit: false };
      }
      return { ok: true };
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    expect(maximumActiveReads).toBe(8);
    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 161,
      completed: 161,
    });
    session.restore();
  });

  it("stops dispatching local cache reads after the uncancellable pool times out", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 80 },
      (_, index) => `<p>Timed out cache paragraph ${index + 1}</p>`,
    ).join("")}</main>`;
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (isRecord(message) && message.type === "TRANSLATION_CACHE_GET") {
        return new Promise<unknown>(() => undefined);
      }
      return Promise.resolve({ ok: true });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    const cacheReads = aiRuntime.sendMessage.mock.calls.filter(
      ([message]) =>
        isRecord(message) && message.type === "TRANSLATION_CACHE_GET",
    );
    expect(cacheReads).toHaveLength(8);
    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 80,
      completed: 80,
    });
    session.restore();
  });

  it("uses updated settings for text added after an initially empty scan", async () => {
    document.body.innerHTML = "<main></main>";
    const session = new PageTranslationSession(vi.fn());
    const initial = structuredClone(DEFAULT_SETTINGS);
    initial.page.mode = "ai";
    initial.page.targetLanguage = "zh-CN";
    initial.page.displayMode = "translated";
    await session.translate(initial);

    const updated = structuredClone(initial);
    updated.page.targetLanguage = "ja";
    session.updateSettings(updated);
    const paragraph = document.createElement("p");
    paragraph.textContent = "Added after empty scan";
    document.querySelector("main")?.append(paragraph);

    await vi.waitFor(
      () => expect(paragraph.textContent).toBe("T:Added after empty scan"),
      { timeout: 1_200 },
    );
    const translationMessage = aiRuntime.sendMessage.mock.calls.find(
      ([message]) => isRecord(message) && isRecord(message.request),
    )?.[0];
    const request = isRecord(translationMessage)
      ? translationMessage.request
      : undefined;
    expect(isRecord(request) ? request.targetLanguage : undefined).toBe("ja");
    session.restore();
  });

  it('translates content after translate="no" is removed', async () => {
    document.body.innerHTML =
      '<main><p id="deferred" translate="no">Translate after opt-in</p></main>';
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    await session.translate(settings);
    const paragraph = document.querySelector("#deferred");
    expect(paragraph?.textContent).toBe("Translate after opt-in");

    paragraph?.removeAttribute("translate");
    await vi.waitFor(
      () => expect(paragraph?.textContent).toBe("T:Translate after opt-in"),
      { timeout: 1_200 },
    );
    session.restore();
  });

  it("restores translated content while a dynamic notranslate exclusion is active", async () => {
    document.body.innerHTML =
      '<main><p id="dynamic-exclusion">Dynamic exclusion copy</p></main>';
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    await session.translate(settings);
    const paragraph = document.querySelector("#dynamic-exclusion");
    expect(paragraph?.textContent).toBe("T:Dynamic exclusion copy");

    paragraph?.classList.add("notranslate");
    await vi.waitFor(() =>
      expect(paragraph?.textContent).toBe("Dynamic exclusion copy"),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(paragraph?.textContent).toBe("Dynamic exclusion copy");

    paragraph?.classList.remove("notranslate");
    await vi.waitFor(
      () => expect(paragraph?.textContent).toBe("T:Dynamic exclusion copy"),
      { timeout: 1_200 },
    );
    session.restore();
  });

  it("restores a translated subtree when it becomes editable or translate=no", async () => {
    document.body.innerHTML =
      '<main><section id="editable"><p>Editable exclusion copy</p></section></main>';
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    await session.translate(settings);
    const section = document.querySelector<HTMLElement>("#editable");
    const paragraph = section?.querySelector("p");
    expect(paragraph?.textContent).toBe("T:Editable exclusion copy");

    section?.setAttribute("contenteditable", "true");
    await vi.waitFor(() =>
      expect(paragraph?.textContent).toBe("Editable exclusion copy"),
    );
    section?.removeAttribute("contenteditable");
    await vi.waitFor(
      () => expect(paragraph?.textContent).toBe("T:Editable exclusion copy"),
      { timeout: 1_200 },
    );

    section?.setAttribute("translate", "no");
    await vi.waitFor(() =>
      expect(paragraph?.textContent).toBe("Editable exclusion copy"),
    );
    session.restore();
  });

  it("does not miss revealed text beyond the bounded attribute probe", async () => {
    document.body.innerHTML = `
      <style>
        .tail-reveal { display: none; }
        .show-tail .tail-reveal { display: block; }
      </style>
      <main id="large-reveal-root">
        ${Array.from(
          { length: 400 },
          (_, index) => `<p>Visible item ${index + 1}</p>`,
        ).join("")}
        <p class="tail-reveal">Revealed item after probe limit</p>
      </main>
    `;
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    await session.translate(settings);
    const root = document.querySelector("#large-reveal-root");
    const tail = document.querySelector(".tail-reveal");
    expect(tail?.textContent).toBe("Revealed item after probe limit");

    root?.classList.add("show-tail");
    await vi.waitFor(
      () => expect(tail?.textContent).toBe("T:Revealed item after probe limit"),
      { timeout: 1_500 },
    );
    session.restore();
  });

  it("bounds AI concurrency while later batches remain pending after a non-retryable failure", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 348 },
      (_, index) => `<p>Mixed AI result ${index + 1}</p>`,
    ).join("")}</main>`;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.aiResponseMode = "batch";
    settings.page.displayMode = "translated";
    const pending: Array<() => void> = [];
    let translationRequest = 0;
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("request" in message) ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      translationRequest += 1;
      if (translationRequest === 1) {
        return Promise.resolve({
          ok: false,
          error: {
            code: "invalid_response",
            message: "first batch failed",
            retryable: false,
            details: "Missing result IDs: page-1, page-2.",
          },
        });
      }
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      return new Promise((resolve) => {
        pending.push(() =>
          resolve({
            ok: true,
            results: segments.map((segment) => ({
              id: segment.id,
              translatedText: `T:${segment.text}`,
            })),
          }),
        );
      });
    });
    const session = new PageTranslationSession(vi.fn());

    const run = session.translate(settings);
    await vi.waitFor(() => {
      expect(translationRequest).toBe(8);
      expect(session.getStatus()).toMatchObject({
        state: "translating",
        total: 348,
        completed: 0,
        failed: 12,
      });
    });

    for (const resolve of pending) resolve();
    await expect(run).resolves.toMatchObject({
      state: "partial",
      total: 348,
      completed: 336,
      failed: 12,
      message: "first batch failed",
      details: "Missing result IDs: page-1, page-2.",
    });
    session.restore();
  });

  it("adds safe diagnostics when a Provider failure omits details", async () => {
    document.body.innerHTML = "<main><p>Missing diagnostic fixture</p></main>";
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";
    aiRuntime.sendMessage.mockResolvedValue({
      ok: false,
      error: {
        code: "invalid_response",
        message: "provider response invalid",
        retryable: true,
      },
    });
    const session = new PageTranslationSession(vi.fn());

    const status = await session.translate(settings);
    expect(status).toMatchObject({
      state: "error",
      completed: 0,
      failed: 1,
    });
    expect(status.details).toMatch(
      /Provider error code: invalid_response.*received 0 of 1 requested result IDs/u,
    );
    session.restore();
  });

  it("cancels a pending dynamic rescan when the session is restored", async () => {
    document.body.innerHTML = "<main><p>Initial cancel fixture</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    let resolveInitial:
      | ((results: Array<{ id: string; translatedText: string }>) => void)
      | undefined;
    localRuntime.translateBatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitial = resolve;
        }),
    );

    const run = session.translate(settings);
    await vi.waitFor(() => expect(resolveInitial).toBeTypeOf("function"));
    const paragraph = document.createElement("p");
    paragraph.textContent = "Cancelled dynamic fixture";
    document.querySelector("main")?.append(paragraph);
    session.restore();
    resolveInitial?.([]);
    await run;
    await new Promise((resolve) => window.setTimeout(resolve, 550));

    expect(paragraph.textContent).toBe("Cancelled dynamic fixture");
    expect(session.getStatus()).toMatchObject({ state: "idle", total: 0 });
  });

  it("cancels all remaining AI workers when cache clearing interrupts a page task", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 348 },
      (_, index) => `<p>Cache clear fixture ${index + 1}</p>`,
    ).join("")}</main>`;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.aiResponseMode = "batch";
    settings.page.displayMode = "translated";
    const pending: Array<() => void> = [];
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      return new Promise((resolve) => {
        pending.push(() =>
          resolve({
            ok: true,
            results: segments.map((segment) => ({
              id: segment.id,
              translatedText: `T:${segment.text}`,
            })),
          }),
        );
      });
    });
    const session = new PageTranslationSession(vi.fn());
    const run = session.translate(settings);
    await vi.waitFor(() => expect(pending).toHaveLength(8));

    const callsBeforeCancel = aiRuntime.sendMessage.mock.calls.length;
    const cancelled = session.handleCacheCleared();
    expect(cancelled).toMatchObject({
      state: "error",
      total: 348,
      completed: 0,
      failed: 348,
    });
    pending.splice(0).forEach((resolve) => resolve());
    await run;
    await new Promise((resolve) => window.setTimeout(resolve, 30));

    expect(aiRuntime.sendMessage).toHaveBeenCalledTimes(callsBeforeCancel + 8);
    expect(
      aiRuntime.sendMessage.mock.calls
        .slice(callsBeforeCancel)
        .every(
          ([message]) =>
            isRecord(message) && message.type === "TRANSLATE_CANCEL",
        ),
    ).toBe(true);
    expect(document.querySelector("p")?.textContent).toBe(
      "Cache clear fixture 1",
    );

    const future = document.createElement("p");
    future.textContent = "Fresh content after active cache clear";
    document.querySelector("main")?.append(future);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(
      () =>
        expect(future.textContent).toBe(
          "T:Fresh content after active cache clear",
        ),
      { timeout: 1_200 },
    );
    session.restore();
  });

  it("translates existing and dynamically added open shadow DOM text", async () => {
    const host = document.createElement("article");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>Initial shadow fixture</p>";
    document.body.replaceChildren(host);
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(shadow.querySelector("p")?.textContent).toBe(
      "T:Initial shadow fixture",
    );

    const button = document.createElement("button");
    button.textContent = "Later shadow action";
    shadow.append(button);
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    expect(button.textContent).toBe("T:Later shadow action");
    session.restore();
  });

  it("retranslates named slots in their new composed order after slot attributes change", async () => {
    const host = document.createElement("x-dynamic-slots");
    host.innerHTML = `
      <p id="first" slot="right">First assigned</p>
      <p id="second" slot="left">Second assigned</p>
    `;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = '<slot name="left"></slot><slot name="right"></slot>';
    document.body.replaceChildren(host);
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    localRuntime.translateBatch.mockClear();
    host.querySelector("#first")?.setAttribute("slot", "left");
    host.querySelector("#second")?.setAttribute("slot", "right");

    await vi.waitFor(
      () => {
        expect(host.querySelector("#first")?.textContent).toBe(
          "T:First assigned",
        );
        expect(host.querySelector("#second")?.textContent).toBe(
          "T:Second assigned",
        );
      },
      { timeout: 1_500 },
    );
    expect(localRuntime.translateBatch).not.toHaveBeenCalled();
    session.restore();
  });

  it("switches safely between assigned and fallback slot text when the slot name changes", async () => {
    const host = document.createElement("x-renamed-slot");
    host.innerHTML = '<p slot="article">Assigned article copy</p>';
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<section><slot name="article"><p>Fallback article copy</p></slot></section>';
    document.body.replaceChildren(host);
    const slot = shadow.querySelector("slot");
    const assigned = host.querySelector("p");
    const fallback = shadow.querySelector("p");
    if (!slot || !assigned || !fallback)
      throw new Error("invalid slot fixture");
    const removeListener = vi.spyOn(slot, "removeEventListener");
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(assigned.textContent).toBe("T:Assigned article copy");
    expect(fallback.textContent).toBe("Fallback article copy");

    slot.name = "missing";
    await vi.waitFor(
      () => {
        expect(assigned.textContent).toBe("Assigned article copy");
        expect(fallback.textContent).toBe("T:Fallback article copy");
      },
      { timeout: 1_500 },
    );

    slot.name = "article";
    await vi.waitFor(
      () => {
        expect(assigned.textContent).toBe("T:Assigned article copy");
        expect(fallback.textContent).toBe("Fallback article copy");
      },
      { timeout: 1_500 },
    );
    session.restore();
    expect(removeListener).toHaveBeenCalledWith(
      "slotchange",
      expect.any(Function),
    );
  });

  it("keeps bilingual assigned and fallback translations in the active slot", async () => {
    const host = document.createElement("x-bilingual-slot");
    host.innerHTML = '<p slot="article">Assigned bilingual copy</p>';
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<section><slot name="article"><p>Fallback bilingual copy</p></slot></section>';
    document.body.replaceChildren(host);
    const slot = shadow.querySelector("slot");
    const assigned = host.querySelector("p");
    const fallback = shadow.querySelector("p");
    if (!slot || !assigned || !fallback)
      throw new Error("invalid slot fixture");
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "bilingual";

    await session.translate(settings);
    let companion = host.querySelector("noritrans-translation");
    expect(slot.assignedElements()).toEqual([assigned, companion]);
    expect(companion?.slot).toBe("article");
    expect(shadow.querySelectorAll("noritrans-translation")).toHaveLength(0);

    slot.name = "missing";
    await vi.waitFor(
      () => {
        expect(host.querySelector("noritrans-translation")).toBeNull();
        const fallbackCompanion = shadow.querySelector(
          "slot > noritrans-translation",
        );
        expect(fallbackCompanion).not.toBeNull();
        expect(
          fallbackCompanion?.shadowRoot?.querySelector("span")?.textContent,
        ).toBe("T:Fallback bilingual copy");
      },
      { timeout: 1_500 },
    );

    slot.name = "article";
    await vi.waitFor(
      () => {
        companion = host.querySelector("noritrans-translation");
        expect(slot.assignedElements()).toEqual([assigned, companion]);
        expect(shadow.querySelector("slot > noritrans-translation")).toBeNull();
      },
      { timeout: 1_500 },
    );
    session.restore();
    expect(host.querySelector("noritrans-translation")).toBeNull();
    expect(shadow.querySelector("noritrans-translation")).toBeNull();
  });

  it("removes detached replacements from progress before translating new content", async () => {
    document.body.innerHTML = "<main><p>Removed progress source</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    const removed = document.querySelector("p");
    removed?.remove();
    await vi.waitFor(() =>
      expect(session.getStatus()).toMatchObject({
        state: "idle",
        total: 0,
        completed: 0,
        failed: 0,
      }),
    );

    const added = document.createElement("p");
    added.textContent = "Replacement progress source";
    document.querySelector("main")?.append(added);
    await vi.waitFor(
      () => {
        expect(added.textContent).toBe("T:Replacement progress source");
        expect(session.getStatus()).toMatchObject({
          state: "translated",
          total: 1,
          completed: 1,
          failed: 0,
        });
      },
      { timeout: 1_500 },
    );

    session.restore();
    expect(removed?.textContent).toBe("T:Removed progress source");
    expect(added.textContent).toBe("Replacement progress source");
  });

  it("restores and rescans a translated text node moved into a new anchor", async () => {
    document.body.innerHTML =
      "<main><p id='source'>Moved session source</p><aside id='destination'></aside></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    const source = document.querySelector("#source");
    const destination = document.querySelector("#destination");
    const node = source?.firstChild;
    if (!source || !destination || !(node instanceof Text)) {
      throw new Error("invalid moved session fixture");
    }
    expect(node.textContent).toBe("T:Moved session source");

    destination.append(node);
    await vi.waitFor(() =>
      expect(node.textContent).toBe("Moved session source"),
    );
    await vi.waitFor(
      () => expect(node.textContent).toBe("T:Moved session source"),
      { timeout: 1_500 },
    );
    expect(localRuntime.translateBatch).toHaveBeenCalledTimes(1);

    session.restore();
    expect(node.textContent).toBe("Moved session source");
  });

  it("discovers an open shadow root attached after the session starts", async () => {
    document.body.innerHTML =
      "<main><p>Initial light DOM</p><x-late-shadow></x-late-shadow></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    const host = document.querySelector("x-late-shadow");
    const shadow = host?.attachShadow({ mode: "open" });
    if (!shadow) throw new Error("missing delayed shadow fixture");
    shadow.innerHTML = "<p>Delayed shadow copy</p>";

    await vi.waitFor(
      () =>
        expect(shadow.querySelector("p")?.textContent).toBe(
          "T:Delayed shadow copy",
        ),
      { timeout: 2_000 },
    );
    session.restore();
  });

  it("translates shadow text when its existing host becomes visible", async () => {
    const host = document.createElement("x-hidden-shadow");
    host.hidden = true;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<p>Initially hidden shadow copy</p>";
    document.body.replaceChildren(host);
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    expect(shadow.querySelector("p")?.textContent).toBe(
      "Initially hidden shadow copy",
    );
    host.hidden = false;

    await vi.waitFor(
      () =>
        expect(shadow.querySelector("p")?.textContent).toBe(
          "T:Initially hidden shadow copy",
        ),
      { timeout: 1_500 },
    );
    session.restore();
  });

  it("keeps a bilingual companion synchronized with source visibility and removal", async () => {
    document.body.innerHTML = "<main><p>Transient bilingual source</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "bilingual";

    await session.translate(settings);
    const paragraph = document.querySelector<HTMLParagraphElement>("p");
    const companion = document.querySelector<HTMLElement>(
      "noritrans-translation",
    );
    if (!paragraph || !companion) throw new Error("invalid bilingual fixture");

    paragraph.hidden = true;
    await vi.waitFor(() => expect(companion.hidden).toBe(true));
    paragraph.hidden = false;
    await vi.waitFor(() => expect(companion.hidden).toBe(false));
    paragraph.firstChild?.remove();
    await vi.waitFor(() => expect(companion.isConnected).toBe(false));
    session.restore();
  });

  it("applies an earlier batch without waiting for the whole page", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 21 },
      (_, index) => `<p>Progressive fixture ${index + 1}</p>`,
    ).join("")}</main>`;
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    let resolveSecond:
      | ((value: Array<{ id: string; translatedText: string }>) => void)
      | undefined;

    localRuntime.translateBatch
      .mockImplementationOnce((request) =>
        Promise.resolve(
          request.segments.map((segment) => ({
            id: segment.id,
            translatedText: `T:${segment.text}`,
          })),
        ),
      )
      .mockImplementationOnce(
        (request) =>
          new Promise((resolve) => {
            resolveSecond = () =>
              resolve(
                request.segments.map((segment) => ({
                  id: segment.id,
                  translatedText: `T:${segment.text}`,
                })),
              );
          }),
      );

    const run = session.translate(settings);
    const paragraphs = [...document.querySelectorAll("p")];
    try {
      await vi.waitFor(
        () => {
          expect(paragraphs[0]?.textContent).toBe("T:Progressive fixture 1");
          expect(resolveSecond).toBeTypeOf("function");
        },
        { timeout: 10_000 },
      );
      expect(paragraphs[20]?.textContent).toBe("Progressive fixture 21");

      resolveSecond?.([]);
      await run;
      expect(paragraphs[20]?.textContent).toBe("T:Progressive fixture 21");
    } finally {
      resolveSecond?.([]);
      session.restore();
    }
  });

  it("applies each local fast segment before its batch promise settles", async () => {
    document.body.innerHTML =
      "<main><p>Fast first</p><p>Fast second</p><p>Fast third</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.displayMode = "translated";
    let resolveBatch:
      | ((results: Array<{ id: string; translatedText: string }>) => void)
      | undefined;
    localRuntime.translateBatch.mockImplementation(
      (request, signal, onProgress) =>
        new Promise((resolve) => {
          expect(signal?.aborted).toBe(false);
          resolveBatch = resolve;
          const first = request.segments[0];
          if (first) {
            void onProgress?.({
              id: first.id,
              translatedText: `T:${first.text}`,
            });
          }
        }),
    );

    const run = session.translate(settings);
    await vi.waitFor(() =>
      expect(document.querySelector("p")?.textContent).toBe("T:Fast first"),
    );
    expect(session.getStatus()).toMatchObject({
      state: "translating",
      completed: 1,
    });
    const request = localRuntime.translateBatch.mock.calls[0]?.[0];
    if (!request || !resolveBatch) throw new Error("missing local fast batch");
    resolveBatch(
      request.segments.map((segment) => ({
        id: segment.id,
        translatedText: `T:${segment.text}`,
      })),
    );
    await expect(run).resolves.toMatchObject({
      state: "translated",
      completed: 3,
    });
    session.restore();
  });

  it("uses a small first AI batch and packs the remaining page efficiently", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 121 },
      (_, index) => `<p>AI progressive fixture ${index + 1}</p>`,
    ).join("")}</main>`;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.aiResponseMode = "batch";
    settings.page.displayMode = "translated";
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: vi.fn(() => `page-ai-${Math.random()}`),
    });
    const pending: Array<{
      texts: string[];
      resolve: () => void;
    }> = [];
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const results = message.request.segments.map((segment: unknown) => {
        if (
          typeof segment !== "object" ||
          segment === null ||
          !("id" in segment) ||
          typeof segment.id !== "string" ||
          !("text" in segment) ||
          typeof segment.text !== "string"
        ) {
          throw new Error("invalid AI test segment");
        }
        return {
          id: segment.id,
          translatedText: fixtureTranslation(
            segment as FixtureTranslationSegment,
          ),
        };
      });
      if (aiRuntime.sendMessage.mock.calls.length <= 3) {
        return new Promise((resolve) => {
          pending.push({
            texts: results.map((result) => result.translatedText),
            resolve: () => resolve({ ok: true, results }),
          });
        });
      }
      return Promise.resolve({ ok: true, results });
    });

    const session = new PageTranslationSession(vi.fn());
    const run = session.translate(settings);
    const paragraphs = [...document.querySelectorAll("p")];
    expect(session.getStatus().total).toBe(121);
    await vi.waitFor(() => {
      expect(aiRuntime.sendMessage).toHaveBeenCalledTimes(4);
    });
    const batchSizes = aiRuntime.sendMessage.mock.calls.map((call) => {
      const message: unknown = call[0];
      const request = isRecord(message) ? message.request : undefined;
      return isRecord(request) && Array.isArray(request.segments)
        ? request.segments.length
        : 0;
    });
    expect(batchSizes).toEqual([12, 48, 48, 13]);

    const firstRequest: unknown = aiRuntime.sendMessage.mock.calls[0]?.[0];
    const request = isRecord(firstRequest) ? firstRequest.request : undefined;
    const segments =
      isRecord(request) && Array.isArray(request.segments)
        ? (request.segments as unknown[])
        : [];
    const firstSegment = segments[0];
    const firstText =
      isRecord(firstSegment) && typeof firstSegment.text === "string"
        ? firstSegment.text
        : undefined;
    expect(firstText).toBeTypeOf("string");
    expect(
      paragraphs.some((paragraph) => paragraph.textContent === firstText),
    ).toBe(true);

    const thirdBatch = pending[2];
    expect(thirdBatch).toBeDefined();
    thirdBatch?.resolve();
    await vi.waitFor(() => {
      expect(
        paragraphs.some((paragraph) =>
          thirdBatch?.texts.includes(paragraph.textContent ?? ""),
        ),
      ).toBe(true);
    });
    expect(
      paragraphs.some((paragraph) =>
        paragraph.textContent?.startsWith("AI progressive fixture"),
      ),
    ).toBe(true);

    pending[0]?.resolve();
    pending[1]?.resolve();
    await run;
    expect(paragraphs.at(-1)?.textContent).toBe("T:AI progressive fixture 121");
    session.restore();
  });

  it("packs streaming AI page text into balanced concurrent requests", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 121 },
      (_, index) => `<p>Streaming packed fixture ${index + 1}</p>`,
    ).join("")}</main>`;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.aiResponseMode = "stream";
    settings.page.displayMode = "translated";
    const session = new PageTranslationSession(vi.fn());

    await expect(session.translate(settings)).resolves.toMatchObject({
      state: "translated",
      total: 121,
      completed: 121,
      failed: 0,
    });

    const requests = aiRuntime.sendMessage.mock.calls.flatMap(([message]) =>
      isRecord(message) &&
      message.type === "TRANSLATE" &&
      isRecord(message.request) &&
      Array.isArray(message.request.segments)
        ? [message.request]
        : [],
    );
    expect(requests).toHaveLength(4);
    expect(
      requests.map((request) =>
        Array.isArray(request.segments) ? request.segments.length : 0,
      ),
    ).toEqual([12, 48, 48, 13]);
    expect(requests.every((request) => request.responseMode === "stream")).toBe(
      true,
    );
    session.restore();
  });

  it("keeps streamed AI results and retries only IDs missing after a request failure", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 5 },
      (_, index) => `<p>Partial recovery ${index + 1}</p>`,
    ).join("")}</main>`;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";
    const requestedIds: string[][] = [];
    aiRuntime.sendMessage.mockImplementation((message) => {
      if (
        !isRecord(message) ||
        message.type !== "TRANSLATE" ||
        !isRecord(message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segments = message.request.segments as FixtureTranslationSegment[];
      requestedIds.push(segments.map((segment) => segment.id));
      if (requestedIds.length === 1) {
        for (const segment of segments.slice(0, 3)) {
          for (const listener of aiRuntime.listeners) {
            listener({
              type: "TRANSLATION_PROGRESS",
              requestId: String(message.requestId),
              result: {
                id: segment.id,
                translatedText: fixtureTranslation(segment),
              },
            });
          }
        }
        return Promise.resolve({
          ok: false,
          error: {
            code: "request_failed",
            message: "transient stream failure",
            retryable: true,
          },
        });
      }
      return Promise.resolve({
        ok: true,
        results: segments.map((segment) => ({
          id: segment.id,
          translatedText: fixtureTranslation(segment),
        })),
      });
    });
    const session = new PageTranslationSession(vi.fn());

    await expect(session.translate(settings)).resolves.toMatchObject({
      state: "translated",
      total: 5,
      completed: 5,
      failed: 0,
    });
    expect(requestedIds).toHaveLength(2);
    expect(requestedIds[0]).toHaveLength(5);
    expect(requestedIds[1]).toEqual(requestedIds[0]?.slice(3));
    session.restore();
  });

  it("translates normalized duplicate page text once across all AI batches", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 121 },
      (_, index) =>
        `<p>${index % 2 === 0 ? "Repeated   navigation" : " Repeated\n navigation "}</p>`,
    ).join("")}</main>`;
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";

    const session = new PageTranslationSession(vi.fn());
    await session.translate(settings);

    const translationRequests = aiRuntime.sendMessage.mock.calls.flatMap(
      ([message]) =>
        isRecord(message) &&
        isRecord(message.request) &&
        Array.isArray(message.request.segments)
          ? [message.request.segments]
          : [],
    );
    expect(translationRequests).toHaveLength(1);
    expect(translationRequests[0]).toHaveLength(1);
    expect(translationRequests[0]?.[0]).toMatchObject({
      text: "Repeated navigation",
    });
    expect(
      [...document.querySelectorAll("p")].every(
        (paragraph) => paragraph.textContent === "T:Repeated navigation",
      ),
    ).toBe(true);
    expect(session.getStatus()).toMatchObject({
      state: "translated",
      total: 121,
      completed: 121,
      failed: 0,
    });
    session.restore();
  });

  it("puts the currently visible semantic block in the first batch on a scrolled page", async () => {
    document.body.innerHTML = `<main>${Array.from(
      { length: 25 },
      (_, index) => `<p>Viewport priority fixture ${index + 1}</p>`,
    ).join("")}</main>`;
    const paragraphs = [...document.querySelectorAll("p")];
    paragraphs.forEach((paragraph, index) => {
      const top =
        index === 14
          ? 120
          : index < 14
            ? -1_500 + index * 20
            : 1_200 + index * 20;
      vi.spyOn(paragraph, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: top,
        top,
        bottom: top + 40,
        left: 0,
        right: 640,
        width: 640,
        height: 40,
        toJSON: () => ({}),
      });
    });
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "fast";
    settings.page.displayMode = "translated";

    await session.translate(settings);

    const firstRequest = localRuntime.translateBatch.mock.calls[0]?.[0];
    expect(firstRequest?.segments[0]?.text).toBe(
      "Viewport priority fixture 15",
    );
    expect(paragraphs[14]?.textContent).toBe("T:Viewport priority fixture 15");
    session.restore();
  });

  it("does not let an obsolete session overwrite a newer translation", async () => {
    document.body.innerHTML =
      "<main><p>Unique stale response fixture</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const firstSettings = structuredClone(DEFAULT_SETTINGS);
    firstSettings.page.displayMode = "translated";
    let resolveFirst:
      | ((value: Array<{ id: string; translatedText: string }>) => void)
      | undefined;
    localRuntime.translateBatch.mockImplementationOnce(
      (request) =>
        new Promise((resolve) => {
          resolveFirst = (value) =>
            resolve(
              value.map((item) => ({
                ...item,
                id: request.segments[0]?.id ?? item.id,
              })),
            );
        }),
    );

    const firstRun = session.translate(firstSettings);
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
    session.restore();

    const secondSettings = structuredClone(firstSettings);
    secondSettings.page.targetLanguage = "ja";
    await session.translate(secondSettings);
    resolveFirst?.([{ id: "obsolete", translatedText: "OLD" }]);
    await firstRun;

    expect(document.querySelector("p")?.textContent).toBe(
      "T:Unique stale response fixture",
    );
    expect(session.getStatus().state).toBe("translated");
    session.restore();
  });

  it("does not apply a delayed result after an unannounced pushState route change", async () => {
    const originalUrl = location.href;
    document.body.innerHTML = "<main><p>Old route pending copy</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.mode = "ai";
    settings.page.displayMode = "translated";
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    aiRuntime.sendMessage.mockImplementation(async (message) => {
      if (!isRecord(message) || !isRecord(message.request)) {
        return { ok: true };
      }
      await gate;
      const segments = Array.isArray(message.request.segments)
        ? message.request.segments
        : [];
      return {
        ok: true,
        results: segments.flatMap((candidate) =>
          isRecord(candidate) &&
          typeof candidate.id === "string" &&
          typeof candidate.text === "string"
            ? [
                {
                  id: candidate.id,
                  translatedText: `T:${candidate.text}`,
                },
              ]
            : [],
        ),
      };
    });

    try {
      const pending = session.translate(settings);
      await vi.waitFor(() =>
        expect(aiRuntime.sendMessage).toHaveBeenCalledOnce(),
      );
      history.pushState({}, "", "/next-route-with-same-dom");
      release?.();
      await pending;

      expect(document.querySelector("p")?.textContent).toBe(
        "Old route pending copy",
      );
      expect(aiRuntime.sendMessage).toHaveBeenCalledOnce();
    } finally {
      session.restore();
      history.replaceState({}, "", originalUrl);
    }
  });

  it("retranslates a text node changed in place by the page", async () => {
    document.body.innerHTML =
      "<main><p>Initial character data fixture</p></main>";
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";

    await session.translate(settings);
    const paragraph = document.querySelector("p");
    if (!paragraph?.firstChild) throw new Error("missing fixture text node");
    paragraph.firstChild.textContent = "Changed character data fixture";
    await new Promise((resolve) => window.setTimeout(resolve, 600));

    expect(paragraph.textContent).toBe("T:Changed character data fixture");
    session.restore();
  });

  it("reports an error when every page segment fails to translate", async () => {
    document.body.innerHTML = "<main><p>Provider failure fixture</p></main>";
    localRuntime.translateBatch.mockRejectedValueOnce(
      new Error("provider failed"),
    );
    const session = new PageTranslationSession(vi.fn());

    const status = await session.translate(structuredClone(DEFAULT_SETTINGS));

    expect(status).toMatchObject({
      state: "error",
      total: 1,
      completed: 0,
      failed: 1,
      message: "provider failed",
    });
    expect(document.querySelector("p")?.textContent).toBe(
      "Provider failure fixture",
    );
    session.restore();
  });

  it.each([
    {
      name: "missing IDs",
      results: () => [],
      message: "翻译服务没有返回全部段落。",
      detail: "Missing expanded result IDs:",
    },
    {
      name: "duplicate IDs",
      results: (id: string) => [
        { id, translatedText: "first" },
        { id, translatedText: "second" },
      ],
      message: "翻译服务返回了未知或重复的段落 ID。",
      detail: "Duplicate expanded result ID:",
    },
    {
      name: "unknown IDs",
      results: (id: string) => [
        { id, translatedText: "would otherwise be applied" },
        { id: "unknown-page-segment", translatedText: "unknown" },
      ],
      message: "翻译服务返回了未知或重复的段落 ID。",
      detail: "Unknown expanded result ID: unknown-page-segment",
    },
  ])(
    "rejects a whole AI batch with $name",
    async ({ results, message, detail }) => {
      document.body.innerHTML = "<main><p>Strict result fixture</p></main>";
      const settings = structuredClone(DEFAULT_SETTINGS);
      settings.page.mode = "ai";
      settings.page.displayMode = "translated";
      Object.defineProperty(globalThis.crypto, "randomUUID", {
        configurable: true,
        value: vi.fn(() => "strict-page-result"),
      });
      aiRuntime.sendMessage.mockImplementation((requestMessage) => {
        const request = (
          requestMessage as {
            request: { segments: Array<{ id: string }> };
          }
        ).request;
        return Promise.resolve({
          ok: true,
          results: results(request.segments[0]?.id ?? ""),
        });
      });
      const session = new PageTranslationSession(vi.fn());

      const status = await session.translate(settings);

      expect(document.querySelector("p")?.textContent).toBe(
        "Strict result fixture",
      );
      expect(status).toMatchObject({
        state: "error",
        total: 1,
        completed: 0,
        failed: 1,
        message,
      });
      expect(status.details).toContain(detail);
      session.restore();
    },
  );

  it("waits for an early document body before scanning and translating", async () => {
    const body = document.body;
    body.remove();
    const session = new PageTranslationSession(vi.fn());
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.displayMode = "translated";
    const translation = session.translate(settings);
    body.innerHTML = "<main><p>Late body fixture</p></main>";
    document.documentElement.append(body);

    try {
      const status = await translation;

      expect(status).toMatchObject({
        state: "translated",
        total: 1,
        completed: 1,
        failed: 0,
      });
      expect(document.querySelector("p")?.textContent).toBe(
        "T:Late body fixture",
      );
    } finally {
      session.restore();
    }
  });
});
