import { DEFAULT_SETTINGS, type SubtitleSettings } from "@/src/shared/settings";
import {
  cacheStats,
  clearCache,
  getCachedTranslation,
  setCachedTranslation,
} from "@/src/cache/database";
import { sha256 } from "@/src/cache/keys";
import type { SubtitleStatus } from "@/src/messaging/protocol";
import { OcrSubtitleAdapter } from "@/src/ocr/subtitle-adapter";
import type { SubtitleAdapter } from "@/src/subtitles/adapters/types";
import { SUBTITLE_DISCOVERY_CONTROL_EVENT } from "@/src/subtitles/adapters/captured";
import {
  SubtitleController,
  type SubtitleTaskStore,
  type SubtitleTranslationCache,
} from "@/src/subtitles/controller";
import type { SubtitleTrack } from "@/src/subtitles/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const defaultHandler = (message: unknown): Promise<unknown> => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message)
    ) {
      return Promise.resolve(undefined);
    }
    if (message.type !== "TRANSLATE" || !("request" in message)) {
      return Promise.resolve({ ok: true });
    }
    const request = message.request;
    if (
      typeof request !== "object" ||
      request === null ||
      !("segments" in request)
    ) {
      return Promise.resolve({ ok: false });
    }
    if (!Array.isArray(request.segments)) return Promise.resolve({ ok: false });
    const segments: unknown[] = [...(request.segments as unknown[])];
    return Promise.resolve({
      ok: true,
      results: segments.flatMap((segment) => {
        if (
          typeof segment !== "object" ||
          segment === null ||
          !("id" in segment) ||
          typeof segment.id !== "string" ||
          !("text" in segment) ||
          typeof segment.text !== "string"
        ) {
          return [];
        }
        return [{ id: segment.id, translatedText: `译:${segment.text}` }];
      }),
    });
  };

  return {
    defaultHandler,
    sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(defaultHandler),
    listeners: new Set<(message: unknown) => void>(),
  };
});

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: { getMessage: (key: string) => key },
    runtime: {
      sendMessage: runtime.sendMessage,
      onMessage: {
        addListener: (listener: (message: unknown) => void) =>
          runtime.listeners.add(listener),
        removeListener: (listener: (message: unknown) => void) =>
          runtime.listeners.delete(listener),
      },
    },
  },
}));

vi.mock("@/src/shared/i18n", () => ({
  configureUiLanguage: vi.fn(),
  currentUiLocale: () => "en",
  message: (key: string) => key,
}));

function translationRequestFromMessage(
  message: unknown,
): { mode: unknown; segments: unknown[] } | null {
  if (
    typeof message !== "object" ||
    message === null ||
    !("request" in message) ||
    typeof message.request !== "object" ||
    message.request === null ||
    !("mode" in message.request) ||
    !("segments" in message.request) ||
    !Array.isArray(message.request.segments)
  ) {
    return null;
  }
  return {
    mode: message.request.mode,
    segments: message.request.segments as unknown[],
  };
}

function segmentIds(segments: readonly unknown[]): string[] {
  return segments.flatMap((segment) =>
    typeof segment === "object" &&
    segment !== null &&
    "id" in segment &&
    typeof segment.id === "string"
      ? [segment.id]
      : [],
  );
}

const SETTINGS: SubtitleSettings = {
  enabled: true,
  floatingButtonEnabled: true,
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  mode: "ai",
  aiResponseMode: "stream",
  displayMode: "bilingual",
  hideNativeSubtitles: false,
  position: "bottom",
  customPosition: { x: 0.5, y: 0.82 },
  fontScale: 1,
  backgroundOpacity: 0.78,
};
const FAST_STREAM_SETTINGS: SubtitleSettings = {
  ...SETTINGS,
  mode: "fast",
};
const FAST_REMOTE_PROVIDER_SETTINGS = {
  ...DEFAULT_SETTINGS.provider,
  fastProvider: "google-translate" as const,
};

class TestAdapter implements SubtitleAdapter {
  readonly id = "test";
  readonly priority = 1;

  constructor(private track: SubtitleTrack | null) {}

  matches(): boolean {
    return true;
  }

  collect(): Promise<SubtitleTrack | null> {
    return Promise.resolve(this.track);
  }

  setTrack(track: SubtitleTrack | null): void {
    this.track = track;
  }
}

class PreferredVideoAdapter implements SubtitleAdapter {
  readonly id = "preferred-video-test";
  readonly priority = 1;
  private preferredVideo: HTMLVideoElement | null = null;

  matches(): boolean {
    return true;
  }

  setPreferredVideo(video: HTMLVideoElement | null): void {
    this.preferredVideo = video;
  }

  collect(): Promise<SubtitleTrack | null> {
    if (!this.preferredVideo) return Promise.resolve(null);
    return Promise.resolve({
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: `cue-${this.preferredVideo.id}`,
          startMs: 0,
          endMs: 1_000,
          originalText: `Subtitle for ${this.preferredVideo.id}`,
        },
      ],
    });
  }
}

class PriorityAdapter implements SubtitleAdapter {
  readonly id: string;

  constructor(
    readonly priority: number,
    private readonly track: SubtitleTrack | null,
  ) {
    this.id = `priority-${priority}`;
  }

  matches(): boolean {
    return true;
  }

  collect(): Promise<SubtitleTrack | null> {
    return Promise.resolve(this.track);
  }
}

class StreamAdapter implements SubtitleAdapter {
  readonly priority = 1;
  private listener: ((track: SubtitleTrack) => void) | undefined;
  private invalidationListener: (() => void) | undefined;

  constructor(readonly id = "stream-test") {}

  matches(): boolean {
    return true;
  }

  collect(): Promise<SubtitleTrack | null> {
    return Promise.resolve(null);
  }

  subscribe(listener: (track: SubtitleTrack) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListener = listener;
    return () => {
      this.invalidationListener = undefined;
    };
  }

  emit(track: SubtitleTrack): void {
    this.listener?.(track);
  }

  invalidate(): void {
    this.invalidationListener?.();
  }
}

class RouteStreamAdapter extends StreamAdapter {
  constructor(
    id: string,
    private readonly pathnamePrefix: string,
  ) {
    super(id);
  }

  override matches(locationValue: Location = location): boolean {
    return locationValue.pathname.startsWith(this.pathnamePrefix);
  }
}

class InvalidatingAdapter implements SubtitleAdapter {
  private listener: ((track: SubtitleTrack) => void) | undefined;
  private invalidationListener: (() => void) | undefined;

  constructor(
    readonly id: string,
    readonly priority: number,
    private track: SubtitleTrack | null,
  ) {}

  matches(): boolean {
    return true;
  }

  collect(): Promise<SubtitleTrack | null> {
    return Promise.resolve(this.track);
  }

  subscribe(listener: (track: SubtitleTrack) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListener = listener;
    return () => {
      this.invalidationListener = undefined;
    };
  }

  emit(track: SubtitleTrack): void {
    this.track = track;
    this.listener?.(track);
  }

  invalidate(): void {
    this.track = null;
    this.invalidationListener?.();
  }
}

describe("SubtitleController", () => {
  beforeEach(() => {
    vi.useRealTimers();
    runtime.listeners.clear();
    runtime.sendMessage.mockReset();
    runtime.sendMessage.mockImplementation(runtime.defaultHandler);
    document.documentElement.replaceChildren(
      document.createElement("head"),
      document.createElement("body"),
    );
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("available"),
      create: () =>
        Promise.resolve({
          translate: (text: string) => Promise.resolve(`T:${text}`),
          destroy: vi.fn(),
        }),
    };
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: () =>
          Promise.resolve({
            isReliable: true,
            languages: [{ language: "en", percentage: 99 }],
          }),
      },
    });
  });

  it("stores and renders an AI subtitle progress event before the batch finishes", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "stream-first",
          startMs: 0,
          endMs: 1_000,
          originalText: "Hello.",
        },
        {
          id: "stream-second",
          startMs: 1_000,
          endMs: 2_000,
          originalText: "World.",
        },
      ],
    };
    let pending:
      | {
          requestId: string;
          segments: Array<{ id: string; text: string }>;
          resolve(value: unknown): void;
        }
      | undefined;
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const request = message.request;
      expect("responseMode" in request ? request.responseMode : undefined).toBe(
        "stream",
      );
      return new Promise((resolve) => {
        pending = {
          requestId:
            "requestId" in message ? String(message.requestId) : "missing",
          segments: request.segments as Array<{
            id: string;
            text: string;
          }>,
          resolve,
        };
      });
    });
    const cacheSet = vi.fn<
      (key: string, translatedText: string) => Promise<void>
    >(() => Promise.resolve());
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
      cache: { get: () => Promise.resolve(undefined), set: cacheSet },
    });
    const start = controller.start();
    await vi.waitFor(() => expect(pending?.segments).toHaveLength(2));
    const first = pending?.segments[0];
    if (!first || !pending) throw new Error("missing subtitle stream request");

    for (const listener of runtime.listeners) {
      listener({
        type: "TRANSLATION_PROGRESS",
        requestId: pending.requestId,
        result: { id: first.id, translatedText: "第一条" },
      });
    }

    await vi.waitFor(() => {
      expect(controller.getStatus()).toMatchObject({
        state: "translating",
        completed: 1,
      });
      expect(
        cacheSet.mock.calls.filter(([key]) => key.includes("\u001fai\u001f")),
      ).toHaveLength(1);
      expect(
        document.querySelector<HTMLElement>(
          '[data-norixortrans-ui="subtitle-overlay"]',
        )?.shadowRoot?.textContent,
      ).toContain("第一条");
    });
    pending.resolve({
      ok: true,
      results: pending.segments.map((segment, index) => ({
        id: segment.id,
        translatedText: index === 0 ? "第一条" : "第二条",
      })),
    });
    await start;
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      completed: 2,
    });
    expect(
      cacheSet.mock.calls.filter(([key]) => key.includes("\u001fai\u001f")),
    ).toHaveLength(2);
    controller.stop();
  });

  it("uses up to eight concurrent full-response batches for a complete track", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: Array.from({ length: 211 }, (_, index) => ({
        id: `full-concurrency-${index + 1}`,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        originalText: `Complete subtitle ${index + 1}.`,
      })),
    };
    let active = 0;
    let maximumActive = 0;
    runtime.sendMessage.mockImplementation(async (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return { ok: true };
      }
      expect(
        "responseMode" in message.request
          ? message.request.responseMode
          : undefined,
      ).toBe("batch");
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => window.setTimeout(resolve, 25));
      active -= 1;
      return {
        ok: true,
        results: segments.map((segment) => ({
          id: segment.id,
          translatedText: `AI:${segment.text}`,
        })),
      };
    });
    const controller = new SubtitleController({
      settings: { ...SETTINGS, aiResponseMode: "batch" },
      adapters: [new TestAdapter(track)],
    });

    await controller.start();

    expect(maximumActive).toBe(8);
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 211,
      completed: 211,
      failed: 0,
    });
    controller.stop();
  });

  it("reports a translated-only cue as visible only after replacement text exists", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "visibility-current",
          startMs: 0,
          endMs: 10_000,
          originalText: "Current native subtitle",
        },
      ],
    };
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("unavailable"),
    };
    let resolveTranslation: ((value: unknown) => void) | undefined;
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE"
      ) {
        return new Promise((resolve) => {
          resolveTranslation = resolve;
        });
      }
      return Promise.resolve({ ok: true });
    });
    const visibility: boolean[] = [];
    const controller = new SubtitleController({
      settings: {
        ...SETTINGS,
        displayMode: "translated",
        aiResponseMode: "batch",
      },
      adapters: [new TestAdapter(track)],
      onCueVisibilityChange: (visible) => visibility.push(visible),
    });

    const start = controller.start();
    await vi.waitFor(() => expect(resolveTranslation).toBeTypeOf("function"));
    expect(visibility).not.toContain(true);

    resolveTranslation?.({
      ok: true,
      results: [{ id: "sentence:visibility-current", translatedText: "译文" }],
    });
    await start;
    expect(visibility.at(-1)).toBe(true);
    controller.stop();
    expect(visibility.at(-1)).toBe(false);
  });

  it("promotes the new playback window between full-track batches after a seek", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: Array.from({ length: 303 }, (_, index) => ({
        id: `seek-priority-${index}`,
        startMs: index * 60_000,
        endMs: index * 60_000 + 1_000,
        originalText: `Seek priority subtitle ${index}.`,
      })),
    };
    const pending: Array<{
      ids: string[];
      settled: boolean;
      resolve(): void;
    }> = [];
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      return new Promise((resolve) => {
        const request = {
          ids: segments.map((segment) => segment.id),
          settled: false,
          resolve: () => {
            request.settled = true;
            resolve({
              ok: true,
              results: segments.map((segment) => ({
                id: segment.id,
                translatedText: `AI:${segment.text}`,
              })),
            });
          },
        };
        pending.push(request);
      });
    });
    const controller = new SubtitleController({
      settings: { ...SETTINGS, aiResponseMode: "batch" },
      adapters: [new TestAdapter(track)],
    });

    const start = controller.start();
    await vi.waitFor(() => expect(pending).toHaveLength(8));
    video.currentTime = 280 * 60;
    pending.slice(0, 8).forEach((request) => request.resolve());

    await vi.waitFor(() => expect(pending.length).toBeGreaterThan(8));
    expect(
      pending
        .slice(8)
        .some((request) =>
          request.ids.some((id) => id.includes("seek-priority-280")),
        ),
    ).toBe(true);

    runtime.sendMessage.mockImplementation(runtime.defaultHandler);
    pending
      .filter((request) => !request.settled)
      .forEach((request) => {
        request.resolve();
      });
    await start;
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      completed: 303,
    });
    controller.stop();
  });

  it("keeps streamed successes completed when the final subtitle response fails", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "partial-first",
          startMs: 0,
          endMs: 1_000,
          originalText: "First.",
        },
        {
          id: "partial-second",
          startMs: 1_000,
          endMs: 2_000,
          originalText: "Second.",
        },
      ],
    };
    let pending:
      | {
          requestId: string;
          segmentIds: string[];
          resolve(value: unknown): void;
        }
      | undefined;
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("requestId" in message) ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segments = message.request.segments as unknown[];
      return new Promise((resolve) => {
        pending = {
          requestId: String(message.requestId),
          segmentIds: segments.flatMap((segment) =>
            typeof segment === "object" &&
            segment !== null &&
            "id" in segment &&
            typeof segment.id === "string"
              ? [segment.id]
              : [],
          ),
          resolve,
        };
      });
    });
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
    });
    const start = controller.start();
    await vi.waitFor(() => expect(pending).toBeDefined());
    if (!pending) throw new Error("missing partial subtitle request");
    for (const listener of runtime.listeners) {
      listener({
        type: "TRANSLATION_PROGRESS",
        requestId: pending.requestId,
        result: {
          id: pending.segmentIds[0],
          translatedText: "第一条",
        },
      });
    }
    pending.resolve({
      ok: false,
      error: {
        code: "invalid_response",
        message: "invalid_response",
        retryable: true,
        details: "Missing result IDs: sentence:partial-second.",
      },
    });
    await start;

    expect(controller.getStatus()).toMatchObject({
      state: "partial",
      total: 2,
      completed: 1,
      failed: 1,
      details: "Missing result IDs: sentence:partial-second.",
    });
    runtime.sendMessage.mockImplementation(runtime.defaultHandler);
    await controller.retryFailed();
    const retry = runtime.sendMessage.mock.calls.at(-1)?.[0];
    expect(JSON.stringify(retry)).toContain("partial-second");
    expect(JSON.stringify(retry)).not.toContain("partial-first");
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 2,
      completed: 2,
      failed: 0,
    });
    controller.stop();
  });

  it("adds safe diagnostics when a subtitle Provider failure omits details", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "missing-detail",
          startMs: 0,
          endMs: 1_000,
          originalText: "Missing diagnostic.",
        },
      ],
    };
    runtime.sendMessage.mockImplementation((message: unknown) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "TRANSLATE"
        ? Promise.resolve({
            ok: false,
            error: {
              code: "invalid_response",
              message: "invalid_response",
              retryable: true,
            },
          })
        : runtime.defaultHandler(message),
    );
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
    });

    await controller.start();

    expect(controller.getStatus()).toMatchObject({
      state: "error",
      total: 1,
      completed: 0,
      failed: 1,
    });
    expect(controller.getStatus().details).toMatch(
      /Provider error code: invalid_response.*received 0 of 1 requested result IDs/u,
    );
    controller.stop();
  });

  it("diagnoses a malformed subtitle translation response envelope", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "malformed-envelope",
          startMs: 0,
          endMs: 1_000,
          originalText: "Malformed response.",
        },
      ],
    };
    runtime.sendMessage.mockImplementation((message: unknown) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "TRANSLATE"
        ? Promise.resolve({ unexpected: true })
        : runtime.defaultHandler(message),
    );
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
    });

    await controller.start();

    expect(controller.getStatus()).toMatchObject({
      state: "error",
      failed: 1,
    });
    expect(controller.getStatus().details).toBe(
      "The translation response envelope was invalid or incomplete. Response type: object.",
    );
    controller.stop();
  });

  it("routes complete tracks through background AI translation and persists cache entries", async () => {
    const video = document.createElement("video");
    video.id = "primary-video";
    video.src = "https://media.example/movie.mp4";
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        { id: "first", startMs: 0, endMs: 1_000, originalText: "Hello." },
        { id: "second", startMs: 1_000, endMs: 2_000, originalText: "World." },
      ],
    };
    const cacheValues = new Map<string, string>();
    const cache: SubtitleTranslationCache = {
      get: (key) => Promise.resolve(cacheValues.get(key)),
      set: (key, value) => {
        cacheValues.set(key, value);
        return Promise.resolve();
      },
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
      cache,
    });

    await controller.start();

    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 2,
      completed: 2,
    });
    expect(
      [...cacheValues.keys()].filter((key) => key.includes("\u001fai\u001f")),
    ).toHaveLength(2);
    expect([...cacheValues.keys()][0]).toContain("id:primary-video");
    const translateCall = runtime.sendMessage.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    );
    expect(translateCall?.[0]).toMatchObject({
      request: {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "ai",
      },
    });
    expect(JSON.stringify(translateCall?.[0])).toContain("id:primary-video");
    controller.stop();
  });

  it("bounds full-track cache reads before starting missing translations", async () => {
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: Array.from({ length: 40 }, (_, index) => ({
        id: `cache-bound-${index}`,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        originalText: `Cache bound subtitle ${index}.`,
      })),
    };
    let activeReads = 0;
    let maximumActiveReads = 0;
    const cache: SubtitleTranslationCache = {
      get: async () => {
        activeReads += 1;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        await new Promise((resolve) => window.setTimeout(resolve, 5));
        activeReads -= 1;
        return undefined;
      },
      set: () => Promise.resolve(),
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
      cache,
    });

    await controller.start();

    expect(maximumActiveReads).toBeLessThanOrEqual(8);
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 40,
      completed: 40,
    });
    controller.stop();
  });

  it("skips a higher-priority track in the wrong source language", async () => {
    const settings = {
      ...FAST_STREAM_SETTINGS,
      sourceLanguage: "en",
    };
    const wrongLanguage: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "zh-CN",
      cues: [
        {
          id: "wrong-language",
          startMs: 0,
          endMs: 1_000,
          originalText: "错误语言字幕",
        },
      ],
    };
    const matchingLanguage: SubtitleTrack = {
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "matching-language",
          startMs: 0,
          endMs: 1_000,
          originalText: "Matching English caption",
        },
      ],
    };
    const controller = new SubtitleController({
      settings,
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
      adapters: [
        new PriorityAdapter(1, wrongLanguage),
        new PriorityAdapter(2, matchingLanguage),
      ],
    });

    await controller.start();

    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      source: "dom",
      completed: 1,
    });
    const translatedRequest = runtime.sendMessage.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    )?.[0];
    expect(JSON.stringify(translatedRequest)).toContain(
      "Matching English caption",
    );
    expect(JSON.stringify(translatedRequest)).not.toContain("错误语言字幕");
    controller.stop();
  });

  it("prefers a delayed complete track over an active OCR stream", async () => {
    const selected: SubtitleTrack[] = [];
    const ocrTrack: SubtitleTrack = {
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        {
          id: "ocr-current",
          startMs: 0,
          endMs: null,
          originalText: "OCR current",
        },
      ],
    };
    const fullTrack: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "full-current",
          startMs: 0,
          endMs: 1_000,
          originalText: "Complete track",
        },
      ],
    };
    const ocrAdapter = new TestAdapter(ocrTrack);
    const fullAdapter = new TestAdapter(null);
    Object.defineProperty(ocrAdapter, "priority", { value: 0 });
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [ocrAdapter, fullAdapter],
      onTrackSelected: (track) => selected.push(track),
    });
    await controller.start();
    expect(controller.getStatus()).toMatchObject({
      source: "ocr",
      completeness: "stream",
    });

    fullAdapter.setTrack(fullTrack);
    controller.refreshMedia();

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        source: "texttrack",
        completeness: "full",
        total: 1,
        completed: 1,
      }),
    );
    expect(selected.at(-1)).toMatchObject({
      source: "texttrack",
      completeness: "full",
    });

    controller.invalidateOcrMedia();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      source: "texttrack",
      completeness: "full",
      completed: 1,
    });
    expect(
      selected.filter((track) => track.source === "texttrack"),
    ).toHaveLength(1);
    controller.stop();
  });

  it("accepts decisive continuous-growth evidence that downgrades the same network track", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    adapter.emit({
      source: "youtube-timedtext",
      completeness: "full",
      captureEvidence: "verified-full-response",
      language: "en",
      cues: [
        {
          id: "growing-1",
          startMs: 0,
          endMs: 1_000,
          originalText: "First snapshot",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        completeness: "full",
        completed: 1,
      }),
    );

    adapter.emit({
      source: "youtube-timedtext",
      completeness: "stream",
      captureEvidence: "continuous-growth",
      language: "en",
      cues: [
        {
          id: "growing-1",
          startMs: 0,
          endMs: 1_000,
          originalText: "First snapshot",
        },
        {
          id: "growing-2",
          startMs: 1_000,
          endMs: 2_000,
          originalText: "Later snapshot",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        completeness: "stream",
        total: 2,
        completed: 2,
      }),
    );
    controller.stop();
  });

  it("replaces route-sensitive adapters when an SPA enters a playback route", async () => {
    history.replaceState({}, "", "/");
    const rootAdapter = new RouteStreamAdapter("root-route", "/");
    const playbackAdapter = new RouteStreamAdapter(
      "prime-playback-route",
      "/gp/video/detail/",
    );
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [rootAdapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();

    history.pushState({}, "", "/gp/video/detail/episode-one");
    controller.replaceAdapters([playbackAdapter]);
    rootAdapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "stale-root",
          startMs: 0,
          endMs: 1_000,
          originalText: "Stale root adapter",
        },
      ],
    });
    playbackAdapter.emit({
      source: "network",
      completeness: "stream",
      captureEvidence: "live-or-segmented",
      language: "en",
      cues: [
        {
          id: "playback",
          startMs: 0,
          endMs: 1_000,
          originalText: "Playback subtitle",
        },
      ],
    });

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        source: "network",
        completeness: "stream",
        total: 1,
      }),
    );
    expect(
      runtime.sendMessage.mock.calls.some(([message]) =>
        segmentIds(
          translationRequestFromMessage(message)?.segments ?? [],
        ).includes("stale-root"),
      ),
    ).toBe(false);
    history.replaceState({}, "", "/");
    controller.stop();
  });

  it("hands a stale network stream to fresh DOM captions without oscillating", async () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 60,
    });
    document.body.append(video);
    const adapter = new StreamAdapter();
    const selected: SubtitleTrack[] = [];
    const controller = new SubtitleController({
      settings: { ...FAST_STREAM_SETTINGS, displayMode: "original" },
      adapters: [adapter],
      onTrackSelected: (track) => selected.push(track),
    });
    await controller.start();

    adapter.emit({
      source: "network",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "stale-network",
          startMs: 0,
          endMs: 1_000,
          originalText: "Stale network cue",
        },
      ],
    });
    await vi.waitFor(() => expect(selected.at(-1)?.source).toBe("network"));

    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "fresh-dom",
          startMs: 60_000,
          endMs: 62_000,
          originalText: "Fresh DOM cue",
        },
      ],
    });
    await vi.waitFor(() => expect(selected.at(-1)?.source).toBe("dom"));
    const selectionsAfterHandover = selected.length;

    adapter.emit({
      source: "network",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "late-stale-network",
          startMs: 1_000,
          endMs: 2_000,
          originalText: "Late stale network cue",
        },
      ],
    });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(selected).toHaveLength(selectionsAfterHandover);
    expect(selected.at(-1)?.source).toBe("dom");

    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "fresh-dom-next",
          startMs: 62_000,
          endMs: 64_000,
          originalText: "Next DOM cue",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(selected.at(-1)?.cues[0]?.id).toBe("fresh-dom-next"),
    );
    controller.stop();
  });

  it("prefers an available site DOM stream over experimental OCR", async () => {
    const ocrTrack: SubtitleTrack = {
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        {
          id: "ocr-current",
          startMs: 0,
          endMs: null,
          originalText: "OCR current",
        },
      ],
    };
    const domTrack: SubtitleTrack = {
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "dom-current",
          startMs: 0,
          endMs: null,
          originalText: "Site caption",
        },
      ],
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [
        new PriorityAdapter(100, ocrTrack),
        new PriorityAdapter(10, domTrack),
      ],
    });

    await controller.start();

    expect(controller.getStatus()).toMatchObject({
      source: "dom",
      completeness: "stream",
      total: 1,
    });
    controller.stop();
  });

  it("replaces a saved user Profile adapter without requiring a page reload", async () => {
    const previous = new StreamAdapter("profile:user-example-com");
    const replacement = new StreamAdapter("profile:user-example-com");
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [previous],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    controller.addAdapter(replacement);
    runtime.sendMessage.mockClear();

    previous.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "stale-profile-cue",
          startMs: 0,
          endMs: null,
          originalText: "Stale selector result",
        },
      ],
    });
    await Promise.resolve();
    expect(runtime.sendMessage).not.toHaveBeenCalled();

    replacement.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "fresh-profile-cue",
          startMs: 0,
          endMs: null,
          originalText: "Fresh selector result",
        },
      ],
    });
    await vi.waitFor(() => expect(runtime.sendMessage).toHaveBeenCalled());
    expect(controller.getStatus()).toMatchObject({
      source: "dom",
      completeness: "stream",
      total: 1,
    });
    controller.stop();
  });

  it("sends one full-track AI batch without a tiny urgent request", async () => {
    const video = document.createElement("video");
    video.currentTime = 5.2;
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: Array.from({ length: 12 }, (_, index) => ({
        id: `parallel-${index}`,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        originalText: `Parallel subtitle ${index}.`,
      })),
    };
    const pending: Array<{
      ids: string[];
      resolve: () => void;
    }> = [];
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      const response = {
        ok: true,
        results: segments.map((segment) => ({
          id: segment.id,
          translatedText: `T:${segment.text}`,
        })),
      };
      return new Promise((resolve) => {
        pending.push({
          ids: segments.map((segment) => segment.id),
          resolve: () => resolve(response),
        });
      });
    });
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
    });

    const start = controller.start();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]?.ids).toHaveLength(12);
    expect(pending[0]?.ids[0]).toBe("sentence:parallel-5");
    pending[0]?.resolve();
    await start;
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 12,
      completed: 12,
      failed: 0,
    });
    controller.stop();
  });

  it("uses the recently activated smaller video's time for urgent full-track ordering", async () => {
    const recentlyActivated = document.createElement("video");
    const larger = document.createElement("video");
    recentlyActivated.currentTime = 5.2;
    larger.currentTime = 29.2;
    recentlyActivated.getBoundingClientRect = () =>
      new DOMRect(100, 100, 640, 360);
    larger.getBoundingClientRect = () => new DOMRect(0, 0, 1_000, 560);
    Object.defineProperty(recentlyActivated, "paused", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(larger, "paused", {
      configurable: true,
      value: false,
    });
    document.body.append(recentlyActivated, larger);
    const adapter = new TestAdapter(null);
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    await controller.start();

    recentlyActivated.dispatchEvent(new Event("play"));
    adapter.setTrack({
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: Array.from({ length: 40 }, (_, index) => ({
        id: `urgent-${index}`,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        originalText: `Urgent subtitle ${index}.`,
      })),
    });
    controller.refreshMedia();

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        completed: 40,
      }),
    );
    const firstRequest = runtime.sendMessage.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    )?.[0];
    const firstSegments =
      firstRequest &&
      typeof firstRequest === "object" &&
      "request" in firstRequest &&
      firstRequest.request &&
      typeof firstRequest.request === "object" &&
      "segments" in firstRequest.request &&
      Array.isArray(firstRequest.request.segments)
        ? firstRequest.request.segments
        : [];
    expect(firstSegments[0]).toMatchObject({ id: "sentence:urgent-5" });
    controller.stop();
  });

  it("routes AI-configured streams through immediate fast requests without an AI batch", async () => {
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    const firstCue = {
      id: "live-1",
      startMs: 0,
      endMs: 1_000,
      originalText: "First live cue.",
    };
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [firstCue],
    });
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        firstCue,
        {
          id: "live-2",
          startMs: 1_000,
          endMs: 2_000,
          originalText: "Second live cue.",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        completeness: "stream",
        total: 2,
        completed: 2,
        failed: 0,
        message: "subtitleFastFallbackNoFullTrack",
      }),
    );
    const translateCalls = runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      );
    expect(translateCalls).toHaveLength(2);
    const fastCueIds = translateCalls.flatMap((message) => {
      const request = translationRequestFromMessage(message);
      return request?.mode === "fast" ? segmentIds(request.segments) : [];
    });
    expect(fastCueIds).toContain("live-1");
    expect(fastCueIds).toContain("live-2");
    expect(
      translateCalls.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "request" in message &&
          typeof message.request === "object" &&
          message.request !== null &&
          "mode" in message.request &&
          message.request.mode === "ai",
      ),
    ).toBe(false);
    controller.stop();
  });

  it("retranslates a stream cue when its stable ID receives new source text", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    adapter.emit({
      source: "texttrack",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "mutable-live-cue",
          startMs: 0,
          endMs: null,
          originalText: "First live text",
        },
      ],
    });
    const translated = () =>
      document
        .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
        ?.shadowRoot?.querySelector<HTMLElement>(".translated")?.textContent;
    await vi.waitFor(() => expect(translated()).toBe("First live text"));

    adapter.emit({
      source: "texttrack",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "mutable-live-cue",
          startMs: 0,
          endMs: null,
          originalText: "Updated live text",
        },
      ],
    });
    await vi.waitFor(() => expect(translated()).toBe("Updated live text"));
    const requests = runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    );
    expect(requests).toHaveLength(2);
    controller.stop();
  });

  it("uses the recently activated smaller video's time for fast stream ordering under an AI setting", async () => {
    const recentlyActivated = document.createElement("video");
    const larger = document.createElement("video");
    recentlyActivated.currentTime = 5.5;
    larger.currentTime = 29.5;
    recentlyActivated.getBoundingClientRect = () =>
      new DOMRect(100, 100, 640, 360);
    larger.getBoundingClientRect = () => new DOMRect(0, 0, 1_000, 560);
    Object.defineProperty(recentlyActivated, "paused", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(larger, "paused", {
      configurable: true,
      value: false,
    });
    document.body.append(recentlyActivated, larger);
    const requestedIds: string[] = [];
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segment = message.request.segments[0] as { id: string };
      requestedIds.push(segment.id);
      return Promise.resolve({
        ok: true,
        results: [{ id: segment.id, translatedText: `FAST:${segment.id}` }],
      });
    });
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    recentlyActivated.dispatchEvent(new Event("play"));
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: Array.from({ length: 31 }, (_, index) => ({
        id: `live-priority-${index}`,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        originalText: `Live priority cue ${index}`,
      })),
    });

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 31,
        completed: 31,
      }),
    );
    expect(requestedIds[0]).toBe("live-priority-5");
    const firstRequest = runtime.sendMessage.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    )?.[0];
    expect(firstRequest).toMatchObject({
      request: { mode: "fast", segments: [{ id: "live-priority-5" }] },
    });
    controller.stop();
  });

  it("renders the latest OCR cue against a canvas player without an HTML video", async () => {
    const player = document.createElement("iframe");
    player.getBoundingClientRect = () => new DOMRect(50, 40, 800, 450);
    document.body.append(player);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    controller.setOcrMediaTarget(player);
    await controller.start();

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        {
          id: "canvas-ocr-1",
          startMs: 1_000,
          endMs: null,
          originalText: "Canvas player subtitle",
        },
      ],
    });

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        source: "ocr",
        completed: 1,
      }),
    );
    const overlay = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    expect(overlay?.shadowRoot?.textContent).toContain(
      "Canvas player subtitle",
    );
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(0);
    expect(overlay?.style.getPropertyValue("--norixortrans-anchor-x")).toBe(
      "450px",
    );
    controller.stop();
  });

  it("prepares a downloadable Chrome local model for OCR without a remote request", async () => {
    const statuses: Array<{ message?: string }> = [];
    const create = vi.fn(
      (options: { monitor?: (monitor: EventTarget) => void }) => {
        const monitor = new EventTarget();
        options.monitor?.(monitor);
        const progress = new Event("downloadprogress");
        Object.defineProperty(progress, "loaded", { value: 0.42 });
        monitor.dispatchEvent(progress);
        return Promise.resolve({
          translate: (text: string) => Promise.resolve(`LOCAL:${text}`),
          destroy: vi.fn(),
        });
      },
    );
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("downloadable"),
      create,
    };
    const player = document.createElement("iframe");
    document.body.append(player);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      onStatus: (status) => statuses.push(status),
    });
    controller.setOcrMediaTarget(player);
    await controller.start();

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        {
          id: "ocr-local-downloadable",
          startMs: 0,
          endMs: null,
          originalText: "Recognized locally",
        },
      ],
    });

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        source: "ocr",
        completed: 1,
        failed: 0,
      }),
    );
    const overlayRoot = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )?.shadowRoot;
    expect(overlayRoot?.querySelector(".original")?.textContent).toBe(
      "Recognized locally",
    );
    expect(overlayRoot?.querySelector(".translated")?.textContent).toBe(
      "LOCAL:Recognized locally",
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: "en",
        targetLanguage: "zh",
      }),
    );
    expect(statuses).toContainEqual(
      expect.objectContaining({
        state: "translating",
        message: "ocrPreparingTranslationModel",
      }),
    );
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(0);
    controller.stop();
  });

  it("reuses the Chrome local Translator across OCR cues until the controller stops", async () => {
    const translate = vi.fn((text: string) => Promise.resolve(`LOCAL:${text}`));
    const destroy = vi.fn();
    const create = vi.fn(() =>
      Promise.resolve({
        translate,
        destroy,
      }),
    );
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("available"),
      create,
    };
    const player = document.createElement("iframe");
    document.body.append(player);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    controller.setOcrMediaTarget(player);
    await controller.start();

    const firstCue = {
      id: "ocr-reuse-first",
      startMs: 0,
      endMs: 1_000,
      originalText: "First recognized subtitle",
    };
    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [firstCue],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({ completed: 1 }),
    );

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        firstCue,
        {
          id: "ocr-reuse-second",
          startMs: 1_000,
          endMs: null,
          originalText: "Second recognized subtitle",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({ completed: 2 }),
    );

    expect(create).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledTimes(2);
    controller.stop();
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledOnce());
  });

  it("rejects a delayed local OCR translation after an immediate timeline reset", async () => {
    const pending = new Map<string, (translatedText: string) => void>();
    const translate = vi.fn(
      (text: string) =>
        new Promise<string>((resolve) => {
          pending.set(text, resolve);
        }),
    );
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("available"),
      create: () =>
        Promise.resolve({
          translate,
          destroy: vi.fn(),
        }),
    };
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      value: 0,
    });
    document.body.append(video);
    const adapter = new OcrSubtitleAdapter();
    const controller = new SubtitleController({
      settings: {
        ...SETTINGS,
        sourceLanguage: "en",
        displayMode: "translated",
      },
      adapters: [adapter],
    });
    await controller.start();

    adapter.begin("en");
    adapter.push("Old timeline subtitle", 0);
    await vi.waitFor(() =>
      expect(pending.has("Old timeline subtitle")).toBe(true),
    );

    adapter.begin("en");
    pending.get("Old timeline subtitle")?.("OLD TRANSLATION");
    // Let the ignored-AbortSignal promise settle inside the controller's
    // ordinary 250 ms invalidation grace window.
    await new Promise((resolve) => window.setTimeout(resolve, 50));

    const translated = () =>
      document
        .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
        ?.shadowRoot?.querySelector<HTMLElement>(".translated")?.textContent;
    expect(translated()).not.toBe("OLD TRANSLATION");
    expect(controller.getStatus()).toMatchObject({
      state: "waiting",
      total: 0,
      completed: 0,
    });

    adapter.push("New timeline subtitle", 0);
    await vi.waitFor(() =>
      expect(pending.has("New timeline subtitle")).toBe(true),
    );
    pending.get("New timeline subtitle")?.("NEW TRANSLATION");
    await vi.waitFor(() => expect(translated()).toBe("NEW TRANSLATION"));
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      source: "ocr",
      completed: 1,
    });
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(0);
    controller.stop();
  });

  it("keeps OCR text local and explains when Chrome local translation is unavailable", async () => {
    const create = vi.fn();
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("unavailable"),
      create,
    };
    const player = document.createElement("iframe");
    document.body.append(player);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: { ...SETTINGS, displayMode: "translated" },
      adapters: [adapter],
    });
    controller.setOcrMediaTarget(player);
    await controller.start();

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        {
          id: "ocr-local-unavailable",
          startMs: 0,
          endMs: null,
          originalText: "Recognized locally",
        },
      ],
    });

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "error",
        source: "ocr",
        completed: 0,
        failed: 1,
      }),
    );
    const overlayRoot = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )?.shadowRoot;
    const original = overlayRoot?.querySelector<HTMLElement>(".original");
    expect(original?.textContent).toBe("Recognized locally");
    expect(original?.hidden).toBe(false);
    expect(overlayRoot?.querySelector(".notice")?.textContent).toBe(
      "ocrLocalTranslationUnavailable",
    );
    expect(create).not.toHaveBeenCalled();
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(0);
    controller.stop();
  });

  it("ends a stalled OCR local translation at the configured timeout", async () => {
    vi.useFakeTimers();
    const statuses: Array<{ message?: string }> = [];
    const create = vi.fn(
      () =>
        new Promise<never>(() => {
          // Simulates a browser model preparation that never settles.
        }),
    );
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("downloadable"),
      create,
    };
    const player = document.createElement("iframe");
    document.body.append(player);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      providerSettings: {
        ...DEFAULT_SETTINGS.provider,
        timeoutMs: 5_000,
      },
      onStatus: (status) => statuses.push(status),
    });
    controller.setOcrMediaTarget(player);
    await controller.start();

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        {
          id: "ocr-local-timeout",
          startMs: 0,
          endMs: null,
          originalText: "Recognized before timeout",
        },
      ],
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(statuses).toContainEqual(
      expect.objectContaining({
        state: "translating",
        message: "ocrPreparingTranslationModel",
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(controller.getStatus()).toMatchObject({
      state: "error",
      source: "ocr",
      completed: 0,
      failed: 1,
    });
    const overlayRoot = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )?.shadowRoot;
    expect(overlayRoot?.querySelector(".original")?.textContent).toBe(
      "Recognized before timeout",
    );
    expect(overlayRoot?.querySelector(".notice")?.textContent).toBe(
      "ocrLocalTranslationUnavailable",
    );
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(0);
    controller.stop();
  });

  it("separates automatic OCR cache entries by the detected source language", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: (text: string) =>
          Promise.resolve({
            isReliable: true,
            languages: [
              {
                language: text.includes("subtítulo")
                  ? "es"
                  : text.includes("日本字幕")
                    ? "ja"
                    : /\p{Script=Han}/u.test(text)
                      ? "zh"
                      : "en",
                percentage: 99,
              },
            ],
          }),
      },
    });
    const player = document.createElement("iframe");
    document.body.append(player);
    const adapter = new StreamAdapter();
    const cacheSet = vi.fn<(key: string, value: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const controller = new SubtitleController({
      settings: { ...SETTINGS, sourceLanguage: "auto", targetLanguage: "en" },
      ocrSettings: {
        ...DEFAULT_SETTINGS.ocr,
        sourceLanguage: "auto",
        targetLanguage: "en",
      },
      adapters: [adapter],
      cache: { get: () => Promise.resolve(undefined), set: cacheSet },
    });
    controller.setOcrMediaTarget(player);
    await controller.start();

    const englishCue = {
      id: "ocr-cache-en",
      startMs: 0,
      endMs: 1_000,
      originalText: "English subtitle",
    };
    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [englishCue],
    });
    await vi.waitFor(() => expect(cacheSet).toHaveBeenCalledTimes(2));

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        englishCue,
        {
          id: "ocr-cache-zh",
          startMs: 1_000,
          endMs: null,
          originalText: "中文字幕",
        },
      ],
    });
    await vi.waitFor(() => expect(cacheSet).toHaveBeenCalledTimes(3));

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        englishCue,
        {
          id: "ocr-cache-zh",
          startMs: 1_000,
          endMs: 2_000,
          originalText: "中文字幕",
        },
        {
          id: "ocr-cache-ja",
          startMs: 2_000,
          endMs: 3_000,
          originalText: "日本字幕",
        },
        {
          id: "ocr-cache-ko",
          startMs: 3_000,
          endMs: 4_000,
          originalText: "한국어 자막입니다",
        },
        {
          id: "ocr-cache-es",
          startMs: 4_000,
          endMs: null,
          originalText: "Este es un subtítulo español",
        },
      ],
    });
    await vi.waitFor(() => expect(cacheSet).toHaveBeenCalledTimes(7));

    const keys = cacheSet.mock.calls.map(([key]) => key);
    expect(
      keys.some((key) => key.includes("\u001fen\u001fen\u001ffast\u001f")),
    ).toBe(true);
    expect(
      keys.some((key) => key.includes("\u001fauto\u001fen\u001ffast\u001f")),
    ).toBe(true);
    expect(
      keys.some((key) => key.includes("\u001fzh\u001fen\u001ffast\u001f")),
    ).toBe(true);
    expect(
      keys.some((key) => key.includes("\u001fja\u001fen\u001ffast\u001f")),
    ).toBe(true);
    expect(
      keys.some((key) => key.includes("\u001fko\u001fen\u001ffast\u001f")),
    ).toBe(true);
    expect(
      keys.some((key) => key.includes("\u001fes\u001fen\u001ffast\u001f")),
    ).toBe(true);
    controller.stop();
  });

  it("retries mixed-language OCR cues with matching Translator and cache languages", async () => {
    vi.stubGlobal("chrome", {
      i18n: {
        detectLanguage: (text: string) =>
          Promise.resolve({
            isReliable: true,
            languages: [
              {
                language: /\p{Script=Han}/u.test(text) ? "zh" : "en",
                percentage: 99,
              },
            ],
          }),
      },
    });
    const unavailableCreate = vi.fn();
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("unavailable"),
      create: unavailableCreate,
    };
    const player = document.createElement("iframe");
    document.body.append(player);
    const adapter = new StreamAdapter();
    const cacheSet = vi.fn<(key: string, value: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const controller = new SubtitleController({
      settings: { ...SETTINGS, sourceLanguage: "auto", targetLanguage: "de" },
      ocrSettings: {
        ...DEFAULT_SETTINGS.ocr,
        sourceLanguage: "auto",
        targetLanguage: "de",
      },
      adapters: [adapter],
      cache: { get: () => Promise.resolve(undefined), set: cacheSet },
    });
    controller.setOcrMediaTarget(player);
    await controller.start();

    const englishCue = {
      id: "ocr-retry-en",
      startMs: 0,
      endMs: 1_000,
      originalText: "English retry subtitle",
    };
    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [englishCue],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({ failed: 1 }),
    );
    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        englishCue,
        {
          id: "ocr-retry-zh",
          startMs: 1_000,
          endMs: null,
          originalText: "中文字幕重试",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({ failed: 2 }),
    );

    const createdSourceLanguages: string[] = [];
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("available"),
      create: (options: { sourceLanguage: string }) => {
        createdSourceLanguages.push(options.sourceLanguage);
        return Promise.resolve({
          translate: (text: string) =>
            Promise.resolve(`${options.sourceLanguage}:${text}`),
          destroy: vi.fn(),
        });
      },
    };

    await expect(controller.retryFailed()).resolves.toMatchObject({
      state: "ready",
      completed: 2,
      failed: 0,
    });
    expect(createdSourceLanguages).toEqual(["en", "zh"]);
    const writes = cacheSet.mock.calls.map(([key, value]) => ({ key, value }));
    expect(
      writes.some(
        ({ key, value }) =>
          key.includes("\u001fen\u001fde\u001ffast\u001f") &&
          value.includes("en:"),
      ),
    ).toBe(true);
    expect(
      writes.some(
        ({ key, value }) =>
          key.includes("\u001fzh\u001fde\u001ffast\u001f") &&
          value.includes("zh:"),
      ),
    ).toBe(true);
    expect(unavailableCreate).not.toHaveBeenCalled();
    controller.stop();
  });

  it("uses the OCR target timeline when a hidden playing video also exists", async () => {
    const hiddenVideo = document.createElement("video");
    Object.defineProperty(hiddenVideo, "paused", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(hiddenVideo, "currentTime", {
      configurable: true,
      value: 120,
    });
    hiddenVideo.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    const player = document.createElement("iframe");
    player.getBoundingClientRect = () => new DOMRect(50, 40, 800, 450);
    document.body.append(hiddenVideo, player);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    controller.setOcrMediaTarget(player);
    await controller.start();

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        {
          id: "iframe-timeline-cue",
          startMs: 1_000,
          endMs: null,
          originalText: "Iframe timeline subtitle",
        },
      ],
    });

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>(
          '[data-norixortrans-ui="subtitle-overlay"]',
        )?.shadowRoot?.textContent,
      ).toContain("Iframe timeline subtitle"),
    );
    controller.stop();
  });

  it("uses a second HTML video's timeline when that video is the OCR target", async () => {
    const larger = document.createElement("video");
    const ocrTarget = document.createElement("video");
    larger.currentTime = 100.5;
    ocrTarget.currentTime = 5.5;
    larger.getBoundingClientRect = () => new DOMRect(0, 0, 1_000, 560);
    ocrTarget.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(larger, ocrTarget);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    controller.setOcrMediaTarget(ocrTarget);
    await controller.start();

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "und",
      cues: [
        {
          id: "second-video-ocr",
          startMs: 5_000,
          endMs: 6_000,
          originalText: "Second video OCR subtitle",
        },
        {
          id: "large-video-time",
          startMs: 100_000,
          endMs: 101_000,
          originalText: "Wrong main video subtitle",
        },
      ],
    });

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>(
          '[data-norixortrans-ui="subtitle-overlay"]',
        )?.shadowRoot?.textContent,
      ).toContain("Second video OCR subtitle"),
    );
    expect(
      document.querySelector<HTMLElement>(
        '[data-norixortrans-ui="subtitle-overlay"]',
      )?.shadowRoot?.textContent,
    ).not.toContain("Wrong main video subtitle");
    controller.stop();
  });

  it("uses Chrome local as the primary stream fallback without starting an AI request", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    document.body.append(video);
    const destroy = vi.fn();
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("available"),
      create: () =>
        Promise.resolve({
          translate: (text: string) => Promise.resolve(`FAST:${text}`),
          destroy,
        }),
    };
    const adapter = new StreamAdapter();
    const cacheSet = vi.fn<(key: string, value: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const controller = new SubtitleController({
      settings: {
        ...SETTINGS,
        sourceLanguage: "en",
        aiResponseMode: "batch",
      },
      adapters: [adapter],
      cache: {
        get: () =>
          new Promise<never>(() => {
            // Simulates a Background cache read that never replies.
          }),
        set: cacheSet,
      },
      providerCacheContext: {
        fastProviderId: "chrome-local",
        aiProviderId: "openai-compatible",
        baseUrl: "https://provider.example/v1",
        model: "test-model",
        promptVersion: "prompt-v1",
      },
    });
    await controller.start();

    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "fallback-cue",
          startMs: 0,
          endMs: null,
          originalText: "Fallback subtitle",
        },
      ],
    });

    const translated = document
      .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
      ?.shadowRoot?.querySelector<HTMLElement>(".translated");
    await vi.advanceTimersByTimeAsync(199);
    expect(translated?.textContent).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(translated?.textContent).toBe("FAST:Fallback subtitle");
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      completeness: "stream",
      completed: 1,
      message: "subtitleFastFallbackNoFullTrack",
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(
      cacheSet.mock.calls.some(
        ([key]) =>
          key.includes("\u001fchrome-local\u001f") &&
          key.includes("\u001ffast\u001f"),
      ),
    ).toBe(true);
    expect(
      cacheSet.mock.calls.some(([key]) =>
        key.includes("\u001fopenai-compatible\u001f"),
      ),
    ).toBe(false);
    expect(
      cacheSet.mock.calls.some(([key]) => key.includes("\u001fai\u001f")),
    ).toBe(false);
    expect(
      runtime.sendMessage.mock.calls.some(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toBe(false);
    controller.stop();
  });

  it("shows a local fast fallback when the current AI subtitle failed after the batch finished", async () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      writable: true,
      value: 0,
    });
    document.body.append(video);
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const requestSegments = message.request.segments as unknown[];
      const first: unknown = requestSegments[0];
      if (
        typeof first !== "object" ||
        first === null ||
        !("id" in first) ||
        typeof first.id !== "string"
      ) {
        return Promise.resolve({ ok: false });
      }
      const requestId =
        "requestId" in message ? String(message.requestId) : "missing";
      for (const listener of runtime.listeners) {
        listener({
          type: "TRANSLATION_PROGRESS",
          requestId,
          result: { id: first.id, translatedText: "AI first subtitle" },
        });
      }
      return Promise.resolve({
        ok: false,
        error: {
          code: "invalid_response",
          message: "runtime_error:invalid_response",
          retryable: true,
        },
      });
    });
    const translate = vi.fn((text: string) => Promise.resolve(`FAST:${text}`));
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator = {
      availability: () => Promise.resolve("available"),
      create: () =>
        Promise.resolve({
          translate,
          destroy: vi.fn(),
        }),
    };
    const controller = new SubtitleController({
      settings: {
        ...SETTINGS,
        sourceLanguage: "en",
        displayMode: "translated",
      },
      adapters: [
        new TestAdapter({
          source: "texttrack",
          completeness: "full",
          language: "en",
          cues: [
            {
              id: "ai-success",
              startMs: 0,
              endMs: 1_000,
              originalText: "First subtitle.",
            },
            {
              id: "ai-failed",
              startMs: 2_000,
              endMs: 3_000,
              originalText: "Second failed subtitle.",
            },
          ],
        }),
      ],
    });

    await controller.start();
    expect(controller.getStatus()).toMatchObject({
      state: "partial",
      total: 2,
      completed: 1,
      failed: 1,
    });

    video.currentTime = 2.2;
    video.dispatchEvent(new Event("timeupdate"));
    const translated = document
      .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
      ?.shadowRoot?.querySelector<HTMLElement>(".translated");
    await vi.waitFor(() =>
      expect(translated?.textContent).toBe("FAST:Second failed subtitle."),
    );
    expect(translate.mock.calls.map(([text]) => text)).toContain(
      "Second failed subtitle.",
    );
    expect(controller.getStatus().state).toBe("partial");
    controller.stop();
  });

  it("keeps a failed fast-fallback stream cue stable until the user explicitly retries", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    runtime.sendMessage.mockImplementation((message: unknown) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "TRANSLATE"
        ? Promise.resolve({ ok: false, error: "request_failed" })
        : Promise.resolve({ ok: true }),
    );
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    const track: SubtitleTrack = {
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "failed-stream-cue",
          startMs: 0,
          endMs: null,
          originalText: "Failed live subtitle",
        },
      ],
    };

    adapter.emit(track);
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "error",
        completeness: "stream",
        total: 1,
        completed: 0,
        failed: 1,
        message: "runtimeErrorRequestFailed",
      }),
    );
    adapter.emit(track);
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    const translateCalls = runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    );
    expect(translateCalls).toHaveLength(1);
    expect(translateCalls[0]?.[0]).toMatchObject({
      request: { mode: "fast", segments: [{ id: "failed-stream-cue" }] },
    });
    expect(controller.getStatus().state).toBe("error");
    controller.stop();
  });

  it("backfills every stream cue that arrived while two newer requests were in flight", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const pending: Array<() => void> = [];
    let deferredRequests = 0;
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      const response = {
        ok: true,
        results: segments.map((segment) => ({
          id: segment.id,
          translatedText: `译:${segment.text}`,
        })),
      };
      if (deferredRequests >= 2) return Promise.resolve(response);
      deferredRequests += 1;
      return new Promise((resolve) => {
        pending.push(() => resolve(response));
      });
    });
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    const cues = Array.from({ length: 4 }, (_, index) => ({
      id: `stream-${index + 1}`,
      startMs: index * 1_000,
      endMs: index < 3 ? (index + 1) * 1_000 : null,
      originalText: `Stream cue ${index + 1}`,
    }));

    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: cues.slice(0, 1),
    });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: cues.slice(0, 2),
    });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: cues.slice(0, 3),
    });
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues,
    });
    pending.splice(0).forEach((resolve) => resolve());

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 4,
        completed: 4,
        failed: 0,
      }),
    );
    const translatedIds = new Set(
      runtime.sendMessage.mock.calls.flatMap(([message]) => {
        if (
          typeof message !== "object" ||
          message === null ||
          !("type" in message) ||
          message.type !== "TRANSLATE" ||
          !("request" in message) ||
          typeof message.request !== "object" ||
          message.request === null ||
          !("segments" in message.request) ||
          !Array.isArray(message.request.segments)
        ) {
          return [];
        }
        return message.request.segments.flatMap((segment: unknown) =>
          typeof segment === "object" &&
          segment !== null &&
          "id" in segment &&
          typeof segment.id === "string"
            ? [segment.id]
            : [],
        );
      }),
    );
    expect(translatedIds).toEqual(
      new Set(["stream-1", "stream-2", "stream-3", "stream-4"]),
    );
    controller.stop();
  });

  it("starts up to eight captured stream cues with the current cue first", async () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      value: 1.2,
    });
    document.body.append(video);
    const pending: Array<{
      id: string;
      resolve(): void;
    }> = [];
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segment = message.request.segments[0] as {
        id: string;
        text: string;
      };
      return new Promise((resolve) => {
        pending.push({
          id: segment.id,
          resolve: () =>
            resolve({
              ok: true,
              results: [
                { id: segment.id, translatedText: `译:${segment.text}` },
              ],
            }),
        });
      });
    });
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    adapter.emit({
      source: "youtube-timedtext",
      completeness: "stream",
      language: "en",
      cues: Array.from({ length: 4 }, (_, index) => ({
        id: `captured-${index + 1}`,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        originalText: `Captured ${index + 1}`,
      })),
    });

    await vi.waitFor(() => expect(pending).toHaveLength(4));
    expect(pending.map(({ id }) => id)).toEqual([
      "captured-2",
      "captured-3",
      "captured-4",
      "captured-1",
    ]);
    for (const item of pending.splice(0)) item.resolve();
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 4,
        completed: 4,
      }),
    );
    controller.stop();
  });

  it("keeps stream translation cancelled until the user explicitly retries", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    let resolveFirst: (() => void) | undefined;
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segments = message.request.segments as Array<{
        id: string;
        text: string;
      }>;
      const response = {
        ok: true,
        results: segments.map((segment) => ({
          id: segment.id,
          translatedText: `译:${segment.text}`,
        })),
      };
      if (!resolveFirst) {
        return new Promise((resolve) => {
          resolveFirst = () => resolve(response);
        });
      }
      return Promise.resolve(response);
    });
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    const first = {
      id: "cancel-stream-1",
      startMs: 0,
      endMs: 1_000,
      originalText: "First live cue",
    };
    const second = {
      id: "cancel-stream-2",
      startMs: 1_000,
      endMs: null,
      originalText: "Second live cue",
    };
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [first],
    });
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf("function"));

    controller.cancelTranslationTask();
    const overlayRoot = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )?.shadowRoot;
    expect(overlayRoot?.querySelector<HTMLElement>(".cue-card")?.hidden).toBe(
      true,
    );
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [first, second],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "cancelled",
        total: 2,
        completed: 0,
        failed: 2,
      }),
    );
    expect(overlayRoot?.querySelector<HTMLElement>(".cue-card")?.hidden).toBe(
      true,
    );
    video.dispatchEvent(new Event("loadstart"));
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [first, second],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "cancelled",
        total: 2,
        completed: 0,
        failed: 2,
      }),
    );
    const callsWhileCancelled = runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    ).length;
    resolveFirst?.();
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(callsWhileCancelled);

    await expect(controller.startTranslationTask()).resolves.toMatchObject({
      state: "ready",
      total: 2,
      completed: 2,
      failed: 0,
    });
    controller.stop();
  });

  it("manually starts translation after a track becomes available", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new TestAdapter(null);
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    await controller.start();
    expect(controller.getStatus()).toMatchObject({
      state: "waiting",
      total: 0,
    });

    adapter.setTrack({
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "manual-start",
          startMs: 0,
          endMs: 1_000,
          originalText: "Manual start subtitle",
        },
      ],
    });

    await expect(controller.startTranslationTask()).resolves.toMatchObject({
      state: "ready",
      total: 1,
      completed: 1,
      failed: 0,
    });
    controller.stop();
  });

  it("ends empty subtitle discovery and lets the floating action scan again", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    document.body.append(video);
    const discoveryStates: boolean[] = [];
    const handleDiscoveryControl = (event: Event): void => {
      const detail: unknown =
        event instanceof CustomEvent ? event.detail : undefined;
      if (
        typeof detail === "object" &&
        detail !== null &&
        "enabled" in detail &&
        typeof detail.enabled === "boolean"
      ) {
        discoveryStates.push(detail.enabled);
      }
    };
    window.addEventListener(
      SUBTITLE_DISCOVERY_CONTROL_EVENT,
      handleDiscoveryControl,
    );
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(null)],
    });
    try {
      await controller.start();
      expect(controller.getStatus()).toMatchObject({
        state: "waiting",
        total: 0,
      });
      await vi.advanceTimersByTimeAsync(7_999);
      expect(controller.getStatus().state).toBe("waiting");
      await vi.advanceTimersByTimeAsync(1);
      expect(controller.getStatus()).toMatchObject({
        state: "unavailable",
        total: 0,
        completed: 0,
        failed: 0,
      });
      expect(discoveryStates.at(-1)).toBe(false);

      await controller.startTranslationTask();
      expect(controller.getStatus()).toMatchObject({
        state: "waiting",
        total: 0,
      });
      expect(discoveryStates.at(-1)).toBe(true);
    } finally {
      controller.stop();
      window.removeEventListener(
        SUBTITLE_DISCOVERY_CONTROL_EVENT,
        handleDiscoveryControl,
      );
    }
  });

  it("does not inherit a cancelled task when a new video instance becomes active", async () => {
    const firstVideo = document.createElement("video");
    firstVideo.src = "https://media.example/shared.mp4";
    document.body.append(firstVideo);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "first-video-cue",
          startMs: 0,
          endMs: null,
          originalText: "First video subtitle",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        completed: 1,
      }),
    );
    controller.cancelTranslationTask();
    const callsAfterCancel = runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    ).length;

    const secondVideo = document.createElement("video");
    secondVideo.src = "https://media.example/shared.mp4";
    firstVideo.replaceWith(secondVideo);
    controller.refreshMedia();
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "second-video-cue",
          startMs: 0,
          endMs: null,
          originalText: "Second video subtitle",
        },
      ],
    });

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 1,
        completed: 1,
        failed: 0,
      }),
    );
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(callsAfterCancel + 1);
    controller.stop();
  });

  it("clears stale stream state when the adapter no longer has a track", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    await controller.start();
    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "stale-stream",
          startMs: 0,
          endMs: null,
          originalText: "Stale OCR caption",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        completed: 1,
      }),
    );

    adapter.invalidate();

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "waiting",
        total: 0,
        completed: 0,
        failed: 0,
      }),
    );
    const root = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )?.shadowRoot;
    expect(root?.querySelector<HTMLElement>(".cue-card")?.hidden).toBe(true);
    controller.stop();
  });

  it("does not clear stream state during a brief adapter gap", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    await controller.start();
    const firstTrack: SubtitleTrack = {
      source: "ocr",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "brief-gap-first",
          startMs: 0,
          endMs: null,
          originalText: "First live caption",
        },
      ],
    };
    adapter.emit(firstTrack);
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        completed: 1,
      }),
    );

    adapter.invalidate();
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      completed: 1,
    });
    adapter.emit({
      ...firstTrack,
      cues: [
        {
          id: "brief-gap-second",
          startMs: 0,
          endMs: null,
          originalText: "Replacement live caption",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 1,
        completed: 1,
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 1,
      completed: 1,
    });
    controller.stop();
  });

  it("releases an invalidated full track so an OCR stream can take over", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const fullAdapter = new InvalidatingAdapter("full-test", 1, {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "removed-full-track",
          startMs: 0,
          endMs: 1_000,
          originalText: "Full subtitle",
        },
      ],
    });
    const ocrTrack: SubtitleTrack = {
      source: "ocr",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "ocr-takeover",
          startMs: 0,
          endMs: null,
          originalText: "OCR subtitle",
        },
      ],
    };
    const selected: SubtitleTrack[] = [];
    const statuses: SubtitleStatus[] = [];
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [fullAdapter, new TestAdapter(ocrTrack)],
      onTrackSelected: (track) => selected.push(track),
      onStatus: (status) => statuses.push(status),
    });
    await controller.start();
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      source: "texttrack",
      completeness: "full",
    });
    const statusCountBeforeInvalidation = statuses.length;

    fullAdapter.invalidate();

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        source: "ocr",
        completeness: "stream",
        total: 1,
        completed: 1,
      }),
    );
    expect(selected.at(-1)).toMatchObject({
      source: "ocr",
      completeness: "stream",
    });
    expect(statuses.slice(statusCountBeforeInvalidation)).toContainEqual(
      expect.objectContaining({ state: "waiting", total: 0 }),
    );
    controller.stop();
  });

  it("keeps a full-track task cancellable while another batch is pending", async () => {
    let resolvePending: ((value: unknown) => void) | undefined;
    runtime.sendMessage.mockImplementationOnce(
      (message: unknown) =>
        new Promise((resolve) => {
          resolvePending = () => resolve(runtime.defaultHandler(message));
        }),
    );
    const track: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: Array.from({ length: 12 }, (_, index) => ({
        id: `pending-${index}`,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        originalText: `Pending subtitle ${index}.`,
      })),
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
    });

    const start = controller.start();
    await vi.waitFor(() => expect(resolvePending).toBeTypeOf("function"));
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "translating",
        total: 12,
        failed: 0,
      }),
    );

    const cancelled = controller.cancelTranslationTask();
    expect(cancelled).toMatchObject({
      state: "cancelled",
      total: 12,
    });
    expect(cancelled.completed + cancelled.failed).toBe(12);
    expect(cancelled.failed).toBeGreaterThan(0);
    const overlayStatus = document
      .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
      ?.shadowRoot?.querySelector<HTMLElement>(".status");
    expect(overlayStatus?.dataset.state).toBe("cancelled");
    expect(overlayStatus?.textContent).toBe("subtitleStatusCancelled 0/12");
    resolvePending?.({});
    await start;
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TRANSLATE_CANCEL" }),
    );
    controller.stop();
  });

  it("keeps translated-only fallback visible without adding a video overlay action", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    let resolvePending: (() => void) | undefined;
    runtime.sendMessage.mockImplementationOnce(
      (message: unknown) =>
        new Promise((resolve) => {
          resolvePending = () => resolve(runtime.defaultHandler(message));
        }),
    );
    const controller = new SubtitleController({
      settings: { ...SETTINGS, displayMode: "translated" },
      adapters: [
        new TestAdapter({
          source: "texttrack",
          completeness: "full",
          language: "en",
          cues: [
            {
              id: "pending-translated-only",
              startMs: 0,
              endMs: 1_000,
              originalText: "Awaiting translated output",
            },
          ],
        }),
      ],
    });

    const startPromise = controller.start();
    await vi.waitFor(() => expect(resolvePending).toBeTypeOf("function"));
    const root = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )?.shadowRoot;
    const cueCard = root?.querySelector<HTMLElement>(".cue-card");
    if (!cueCard) throw new Error("missing subtitle cue card");

    expect(cueCard.hidden).toBe(false);
    expect(cueCard.textContent).toContain("T:Awaiting translated output");
    expect(root?.querySelector(".stop-button")).toBeNull();

    resolvePending?.();
    await startPromise;
    controller.cancelTranslationTask();
    expect(cueCard.hidden).toBe(true);
    controller.stop();
  });

  it("stops collection through the task controller without an overlay button", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    await controller.start();
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "bad-large-cue",
          startMs: 0,
          endMs: null,
          originalText: "Wrong menu text",
        },
      ],
    });
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const root = host?.shadowRoot;
    await vi.waitFor(() =>
      expect(root?.querySelector<HTMLElement>(".cue-card")?.hidden).toBe(false),
    );
    expect(root?.querySelector(".stop-button")).toBeNull();

    controller.cancelTranslationTask();

    expect(controller.getStatus().state).toBe("cancelled");
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "later-cue",
          startMs: 0,
          endMs: null,
          originalText: "Should stay stopped",
        },
      ],
    });
    await Promise.resolve();
    expect(controller.getStatus().state).toBe("cancelled");
    expect(root?.querySelector<HTMLElement>(".cue-card")?.hidden).toBe(true);
    controller.stop();
  });

  it("reanchors immediately when another HTML5 player starts playing", async () => {
    const first = document.createElement("video");
    const second = document.createElement("video");
    first.getBoundingClientRect = () => new DOMRect(0, 0, 400, 225);
    second.getBoundingClientRect = () => new DOMRect(400, 0, 400, 225);
    Object.defineProperty(first, "paused", {
      configurable: true,
      value: false,
      writable: true,
    });
    Object.defineProperty(second, "paused", {
      configurable: true,
      value: true,
      writable: true,
    });
    document.body.append(first, second);
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [],
    });
    await controller.start();
    const overlay = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    expect(overlay?.style.getPropertyValue("--norixortrans-anchor-x")).toBe(
      "200px",
    );

    Object.defineProperty(first, "paused", { configurable: true, value: true });
    Object.defineProperty(second, "paused", {
      configurable: true,
      value: false,
    });
    second.dispatchEvent(new Event("play"));

    await vi.waitFor(() =>
      expect(overlay?.style.getPropertyValue("--norixortrans-anchor-x")).toBe(
        "600px",
      ),
    );
    controller.stop();
  });

  it("passes the recently activated player to adapters and replaces the old player's track", async () => {
    const recentlyActivated = document.createElement("video");
    recentlyActivated.id = "recent-player";
    const larger = document.createElement("video");
    larger.id = "large-player";
    recentlyActivated.getBoundingClientRect = () =>
      new DOMRect(100, 100, 640, 360);
    larger.getBoundingClientRect = () => new DOMRect(0, 0, 1_000, 560);
    Object.defineProperty(recentlyActivated, "paused", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(larger, "paused", {
      configurable: true,
      value: false,
    });
    document.body.append(recentlyActivated, larger);
    const selected: SubtitleTrack[] = [];
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [new PreferredVideoAdapter()],
      onTrackSelected: (track) => selected.push(track),
    });

    await controller.start();
    expect(selected.at(-1)?.cues[0]?.originalText).toBe(
      "Subtitle for large-player",
    );

    recentlyActivated.dispatchEvent(new Event("play"));

    await vi.waitFor(() =>
      expect(selected.at(-1)?.cues[0]?.originalText).toBe(
        "Subtitle for recent-player",
      ),
    );
    expect(controller.getStatus()).toMatchObject({
      source: "texttrack",
      total: 1,
    });
    controller.stop();
  });

  it("switches media scope before translating an adapter's new-player cue", async () => {
    const first = document.createElement("video");
    first.id = "first-player";
    const second = document.createElement("video");
    second.id = "second-player";
    first.getBoundingClientRect = second.getBoundingClientRect = () =>
      new DOMRect(0, 0, 800, 450);
    Object.defineProperty(first, "paused", {
      configurable: true,
      value: false,
      writable: true,
    });
    Object.defineProperty(second, "paused", {
      configurable: true,
      value: true,
      writable: true,
    });
    document.body.append(first, second);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: FAST_STREAM_SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        { id: "first-cue", startMs: 0, endMs: 1_000, originalText: "First" },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({ completed: 1 }),
    );

    Object.defineProperty(first, "paused", { configurable: true, value: true });
    Object.defineProperty(second, "paused", {
      configurable: true,
      value: false,
    });
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "second-cue",
          startMs: 0,
          endMs: 1_000,
          originalText: "Second",
        },
      ],
    });
    await vi.waitFor(() => {
      const calls = runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      );
      expect(calls).toHaveLength(2);
      expect(JSON.stringify(calls[1]?.[0])).toContain("id:second-player");
      expect(JSON.stringify(calls[1]?.[0])).not.toContain("id:first-player");
    });
    controller.stop();
  });

  it("prunes translated stream progress when an adapter drops old cues", async () => {
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    await controller.start();
    const cue = (id: string, startMs: number) => ({
      id,
      startMs,
      endMs: startMs + 1_000,
      originalText: `Cue ${id}`,
    });
    const first = cue("one", 0);
    const second = cue("two", 1_000);
    const third = cue("three", 2_000);

    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "en",
      cues: [first],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        total: 1,
        completed: 1,
      }),
    );
    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "en",
      cues: [first, second],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        total: 2,
        completed: 2,
      }),
    );
    adapter.emit({
      source: "ocr",
      completeness: "stream",
      language: "en",
      cues: [second, third],
    });

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 2,
        completed: 2,
        failed: 0,
      }),
    );
    controller.stop();
  });

  it("keeps retained fast stream requests valid when an old cue is evicted", async () => {
    const pending = new Map<
      string,
      { text: string; resolve(value: unknown): void }
    >();
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segment = message.request.segments[0] as {
        id: string;
        text: string;
      };
      return new Promise((resolve) => {
        pending.set(segment.id, { text: segment.text, resolve });
      });
    });
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    const oldCue = {
      id: "evicted-old",
      startMs: 0,
      endMs: 1_000,
      originalText: "Old live cue",
    };
    const retainedCue = {
      id: "retained-current",
      startMs: 1_000,
      endMs: 2_000,
      originalText: "Retained live cue",
    };
    const nextCue = {
      id: "new-current",
      startMs: 2_000,
      endMs: 3_000,
      originalText: "New live cue",
    };

    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [oldCue, retainedCue],
    });
    await vi.waitFor(() => {
      expect(pending.has("evicted-old")).toBe(true);
      expect(pending.has("retained-current")).toBe(true);
    });
    const retainedRequest = pending.get("retained-current");
    if (!retainedRequest) throw new Error("missing retained fast request");

    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [retainedCue, nextCue],
    });
    expect(runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "TRANSLATE_CANCEL" }),
    );
    await vi.waitFor(() => expect(pending.has("new-current")).toBe(true));
    retainedRequest.resolve({
      ok: true,
      results: [
        {
          id: "retained-current",
          translatedText: `FAST:${retainedRequest.text}`,
        },
      ],
    });
    const nextRequest = pending.get("new-current");
    if (!nextRequest) throw new Error("missing new fast request");
    nextRequest.resolve({
      ok: true,
      results: [
        { id: "new-current", translatedText: `FAST:${nextRequest.text}` },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 2,
        completed: 2,
        failed: 0,
        message: "subtitleFastFallbackNoFullTrack",
      }),
    );
    expect(
      runtime.sendMessage.mock.calls.some(
        ([message]) => translationRequestFromMessage(message)?.mode === "fast",
      ),
    ).toBe(true);
    controller.stop();
    pending.get("evicted-old")?.resolve({
      ok: true,
      results: [{ id: "evicted-old", translatedText: "FAST:Old live cue" }],
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });

  it("cancels an old fast stream request before translating with changed settings", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message)
      ) {
        return Promise.resolve(undefined);
      }
      if (message.type === "TRANSLATE_CANCEL")
        return Promise.resolve({ ok: true });
      if (message.type !== "TRANSLATE" || !("request" in message))
        return Promise.resolve({ ok: true });
      const request = message.request as {
        targetLanguage: string;
        segments: Array<{ id: string; text: string }>;
      };
      if (request.targetLanguage === "zh-CN") {
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        results: request.segments.map((segment) => ({
          id: segment.id,
          translatedText: `JA:${segment.text}`,
        })),
      });
    });
    const cacheSet = vi.fn<(key: string, value: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      cache: { get: () => Promise.resolve(undefined), set: cacheSet },
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "live-settings-cue",
          startMs: 0,
          endMs: null,
          originalText: "Live settings cue",
        },
      ],
    });
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf("function"));

    controller.updateSettings({ ...SETTINGS, targetLanguage: "ja" });
    await vi.waitFor(() =>
      expect(runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "TRANSLATE_CANCEL" }),
      ),
    );
    await vi.waitFor(() => {
      const japaneseRequest = runtime.sendMessage.mock.calls
        .map(([message]) => message)
        .find(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "TRANSLATE" &&
            "request" in message &&
            typeof message.request === "object" &&
            message.request !== null &&
            "targetLanguage" in message.request &&
            message.request.targetLanguage === "ja",
        );
      expect(japaneseRequest).toBeDefined();
    });
    resolveOld?.({
      ok: true,
      results: [
        { id: "live-settings-cue", translatedText: "STALE TRANSLATION" },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        completed: 1,
        failed: 0,
      }),
    );
    const fastCacheWrites = cacheSet.mock.calls.filter(([key]) =>
      key.includes("\u001ffast\u001f"),
    );
    expect(fastCacheWrites).toHaveLength(1);
    expect(fastCacheWrites[0]?.[0]).toContain("\u001fja\u001f");
    expect(
      cacheSet.mock.calls.some(([key]) => key.includes("\u001fai\u001f")),
    ).toBe(false);
    const translationRequests = runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      );
    expect(
      translationRequests.some(
        (message) => translationRequestFromMessage(message)?.mode === "fast",
      ),
    ).toBe(true);
    controller.stop();
  });

  it("translates fragmented full-track cues as one sentence group", async () => {
    const track: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        { id: "fragment-a", startMs: 0, endMs: 700, originalText: "Hello" },
        {
          id: "fragment-b",
          startMs: 750,
          endMs: 1_500,
          originalText: "world.",
        },
      ],
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
    });

    await controller.start();

    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 1,
      completed: 1,
    });
    const translateCall = runtime.sendMessage.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    );
    expect(translateCall?.[0]).toMatchObject({
      request: {
        segments: [
          {
            id: "sentence:fragment-a+fragment-b",
            text: "Hello world.",
          },
        ],
      },
    });
    controller.stop();
  });

  it("marks an entirely incomplete ID response as an error instead of presenting originals as translations", async () => {
    runtime.sendMessage.mockResolvedValueOnce({ ok: true, results: [] });
    const track: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [{ id: "only", startMs: 0, endMs: 1_000, originalText: "Hello" }],
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
    });

    await controller.start();

    expect(controller.getStatus()).toMatchObject({
      state: "error",
      total: 1,
      completed: 0,
    });
    controller.stop();
  });

  it("starts subtitle collection when settings are enabled after initialization", async () => {
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [{ id: "only", startMs: 0, endMs: 1_000, originalText: "Hello" }],
    };
    const disabled = { ...SETTINGS, enabled: false };
    const controller = new SubtitleController({
      settings: disabled,
      adapters: [new TestAdapter(track)],
    });

    await controller.start();
    expect(controller.getStatus().state).toBe("unavailable");

    controller.updateSettings(SETTINGS);
    await vi.waitFor(() => {
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 1,
        completed: 1,
      });
    });
    controller.stop();
  });

  it("resumes a full-track job from cue cache after a controller refresh", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        { id: "first", startMs: 0, endMs: 1_000, originalText: "Hello." },
        { id: "second", startMs: 1_000, endMs: 2_000, originalText: "World." },
      ],
    };
    const cacheValues = new Map<string, string>();
    let delayCacheReads = false;
    const cache: SubtitleTranslationCache = {
      get: (key) =>
        delayCacheReads
          ? new Promise((resolve) => {
              setTimeout(() => resolve(cacheValues.get(key)), 250);
            })
          : Promise.resolve(cacheValues.get(key)),
      set: (key, value) => {
        cacheValues.set(key, value);
        return Promise.resolve();
      },
    };
    runtime.sendMessage.mockImplementation((message: unknown) => {
      const request = translationRequestFromMessage(message);
      if (!request) return Promise.resolve({ ok: true });
      return Promise.resolve({
        ok: true,
        results: request.segments.flatMap((segment) =>
          typeof segment === "object" &&
          segment !== null &&
          "id" in segment &&
          typeof segment.id === "string" &&
          "text" in segment &&
          typeof segment.text === "string"
            ? [
                {
                  id: segment.id,
                  translatedText: `AI cached ${segment.text}`,
                },
              ]
            : [],
        ),
      });
    });
    const firstController = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
      cache,
    });
    await firstController.start();
    firstController.stop();
    expect(
      [...cacheValues.keys()].filter((key) => key.includes("\u001fai\u001f")),
    ).toHaveLength(2);

    delayCacheReads = true;
    runtime.sendMessage.mockClear();
    const resumedController = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
      cache,
    });
    await resumedController.start();

    expect(resumedController.getStatus()).toMatchObject({
      state: "ready",
      total: 2,
      completed: 2,
      failed: 0,
    });
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(0);
    expect(
      document
        .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
        ?.shadowRoot?.querySelector(".translated")?.textContent,
    ).toBe("AI cached Hello.");
    resumedController.stop();
  });

  it("restores a fast-fallback stream cue from cache without creating an AI cache entry", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "cached-stream-cue",
          startMs: 0,
          endMs: null,
          originalText: "Reusable live subtitle",
        },
      ],
    };
    const cacheValues = new Map<string, string>();
    const cache: SubtitleTranslationCache = {
      get: (key) => Promise.resolve(cacheValues.get(key)),
      set: (key, value) => {
        cacheValues.set(key, value);
        return Promise.resolve();
      },
    };
    const firstAdapter = new StreamAdapter();
    const firstController = new SubtitleController({
      settings: SETTINGS,
      adapters: [firstAdapter],
      cache,
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await firstController.start();
    firstAdapter.emit(track);
    await vi.waitFor(() =>
      expect(firstController.getStatus()).toMatchObject({
        state: "ready",
        completed: 1,
      }),
    );
    firstController.stop();
    expect(
      [...cacheValues.keys()].some((key) => key.includes("\u001ffast\u001f")),
    ).toBe(true);
    expect(
      [...cacheValues.keys()].some((key) => key.includes("\u001fai\u001f")),
    ).toBe(false);

    runtime.sendMessage.mockClear();
    const secondAdapter = new StreamAdapter();
    const secondController = new SubtitleController({
      settings: SETTINGS,
      adapters: [secondAdapter],
      cache,
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await secondController.start();
    secondAdapter.emit(track);
    await vi.waitFor(() =>
      expect(secondController.getStatus()).toMatchObject({
        state: "ready",
        completed: 1,
        failed: 0,
        message: "subtitleFastFallbackNoFullTrack",
      }),
    );
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(0);
    secondController.stop();
  });

  it("keeps normalized stream cues on independent fast requests instead of an AI batch", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    const providerCalls = (): unknown[][] =>
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      );
    await controller.start();

    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "repeat-a",
          startMs: 0,
          endMs: 1_000,
          originalText: "  Reusable\u00a0live subtitle  ",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 1,
        completed: 1,
      }),
    );
    expect(providerCalls()).toHaveLength(1);

    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues: [
        {
          id: "repeat-a",
          startMs: 0,
          endMs: 1_000,
          originalText: "  Reusable\u00a0live subtitle  ",
        },
        {
          id: "repeat-b",
          startMs: 1_000,
          endMs: null,
          originalText: "Reusable live subtitle",
        },
      ],
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 2,
        completed: 2,
        failed: 0,
      }),
    );
    expect(providerCalls()).toHaveLength(2);
    expect(
      providerCalls().some(
        ([message]) => translationRequestFromMessage(message)?.mode === "fast",
      ),
    ).toBe(true);
    expect(
      providerCalls().some(([message]) => {
        if (
          typeof message !== "object" ||
          message === null ||
          !("request" in message) ||
          typeof message.request !== "object" ||
          message.request === null
        ) {
          return false;
        }
        return (
          ("mode" in message.request && message.request.mode === "ai") ||
          ("segments" in message.request &&
            Array.isArray(message.request.segments) &&
            message.request.segments.length > 1)
        );
      }),
    ).toBe(false);
    controller.stop();
  });

  it("limits fast stream concurrency to eight under an AI setting without creating AI batches", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const pending: Array<{
      segment: { id: string; text: string };
      resolve(value: unknown): void;
    }> = [];
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "TRANSLATE" ||
        !("request" in message) ||
        typeof message.request !== "object" ||
        message.request === null ||
        !("segments" in message.request) ||
        !Array.isArray(message.request.segments)
      ) {
        return Promise.resolve({ ok: true });
      }
      const segment = message.request.segments[0] as {
        id: string;
        text: string;
      };
      return new Promise((resolve) => {
        pending.push({ segment, resolve });
      });
    });
    const adapter = new StreamAdapter();
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      providerSettings: FAST_REMOTE_PROVIDER_SETTINGS,
    });
    await controller.start();
    const cues = Array.from({ length: 31 }, (_, index) => ({
      id: `concurrent-${index}`,
      startMs: index * 1_000,
      endMs: (index + 1) * 1_000,
      originalText:
        index === 0 || index === 30
          ? "Same concurrent subtitle"
          : `Unique concurrent subtitle ${index}`,
    }));

    adapter.emit({
      source: "dom",
      completeness: "stream",
      language: "en",
      cues,
    });
    await vi.waitFor(() => expect(pending).toHaveLength(8));
    const providerCalls = runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    );
    expect(providerCalls).toHaveLength(8);
    expect(
      providerCalls.some(
        ([message]) => translationRequestFromMessage(message)?.mode === "fast",
      ),
    ).toBe(true);
    let resolved = 0;
    while (resolved < cues.length) {
      const current = pending.slice(resolved);
      for (const request of current) {
        request.resolve({
          ok: true,
          results: [
            {
              id: request.segment.id,
              translatedText: `FAST:${request.segment.text}`,
            },
          ],
        });
      }
      resolved += current.length;
      if (resolved < cues.length) {
        await vi.waitFor(() =>
          expect(pending.length).toBeGreaterThan(resolved),
        );
      }
    }
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 31,
        completed: 31,
        failed: 0,
        message: "subtitleFastFallbackNoFullTrack",
      }),
    );
    expect(
      runtime.sendMessage.mock.calls.some(([message]) => {
        if (
          typeof message !== "object" ||
          message === null ||
          !("type" in message) ||
          message.type !== "TRANSLATE" ||
          !("request" in message) ||
          typeof message.request !== "object" ||
          message.request === null
        ) {
          return false;
        }
        return (
          ("mode" in message.request && message.request.mode === "ai") ||
          ("segments" in message.request &&
            Array.isArray(message.request.segments) &&
            message.request.segments.length > 1)
        );
      }),
    ).toBe(false);
    controller.stop();
  });

  it("restores a persisted full track when the refreshed page cannot recapture it", async () => {
    const track: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        { id: "first", startMs: 0, endMs: 1_000, originalText: "Hello." },
        { id: "second", startMs: 1_000, endMs: 2_000, originalText: "World." },
      ],
    };
    const cacheValues = new Map<string, string>();
    const cache: SubtitleTranslationCache = {
      get: (key) => Promise.resolve(cacheValues.get(key)),
      set: (key, value) => {
        cacheValues.set(key, value);
        return Promise.resolve();
      },
    };
    const tracks = new Map<string, SubtitleTrack>();
    const taskStore: SubtitleTaskStore = {
      getTrack: (key) => Promise.resolve(tracks.get(key)),
      setTrack: (key, value) => {
        tracks.set(key, structuredClone(value));
        return Promise.resolve();
      },
      deleteTrack: (key) => {
        tracks.delete(key);
        return Promise.resolve();
      },
    };
    const firstController = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
      cache,
      taskStore,
    });
    await firstController.start();
    firstController.stop();
    expect(tracks.size).toBe(1);
    expect([...tracks.keys()][0]).toContain("subtitle-track-v2");

    runtime.sendMessage.mockClear();
    const resumedController = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(null)],
      cache,
      taskStore,
    });
    await resumedController.start();

    expect(resumedController.getStatus()).toMatchObject({
      state: "ready",
      source: "youtube-timedtext",
      completeness: "full",
      total: 2,
      completed: 2,
      failed: 0,
    });
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(0);
    resumedController.stop();
  });

  it("does not resurrect a persisted full track after decisive stream evidence", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const stored = new Map<string, SubtitleTrack>();
    const deleteTrack = vi.fn((key: string) => {
      stored.delete(key);
      return Promise.resolve();
    });
    const taskStore: SubtitleTaskStore = {
      getTrack: (key) => Promise.resolve(stored.get(key)),
      setTrack: (key, track) => {
        stored.set(key, structuredClone(track));
        return Promise.resolve();
      },
      deleteTrack,
    };
    const adapter = new StreamAdapter();
    const firstController = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      taskStore,
    });
    await firstController.start();
    adapter.emit({
      source: "network",
      completeness: "full",
      captureEvidence: "verified-full-response",
      language: "en",
      cues: [
        {
          id: "stale-full",
          startMs: 0,
          endMs: 1_000,
          originalText: "Stale full subtitle",
        },
      ],
    });
    await vi.waitFor(() => expect(stored.size).toBe(1));

    adapter.emit({
      source: "network",
      completeness: "stream",
      captureEvidence: "continuous-growth",
      language: "en",
      cues: [
        {
          id: "live-stream",
          startMs: 0,
          endMs: 1_000,
          originalText: "Authoritative live subtitle",
        },
      ],
    });
    await vi.waitFor(() => expect(deleteTrack).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(stored.size).toBe(0));
    firstController.stop();

    runtime.sendMessage.mockClear();
    const resumedController = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(null)],
      taskStore,
    });
    await resumedController.start();

    expect(resumedController.getStatus()).not.toMatchObject({
      completeness: "full",
    });
    expect(
      runtime.sendMessage.mock.calls.some(
        ([message]) => translationRequestFromMessage(message)?.mode === "ai",
      ),
    ).toBe(false);
    resumedController.stop();
  });

  it("rejects an old persisted track and does not restore again after a same-document source change", async () => {
    const video = document.createElement("video");
    video.src = "https://media.example/episode-one.mp4";
    document.body.append(video);
    let resolveOldTrack: ((track: SubtitleTrack) => void) | undefined;
    const oldTrack: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "stale-persisted",
          startMs: 0,
          endMs: 1_000,
          originalText: "Stale persisted subtitle",
        },
      ],
    };
    const requestedKeys: string[] = [];
    const setTrack = vi.fn<SubtitleTaskStore["setTrack"]>(() =>
      Promise.resolve(),
    );
    const taskStore: SubtitleTaskStore = {
      getTrack: (key) => {
        requestedKeys.push(key);
        if (requestedKeys.length > 1) return Promise.resolve(undefined);
        return new Promise<SubtitleTrack>((resolve) => {
          resolveOldTrack = resolve;
        });
      },
      setTrack,
      deleteTrack: vi.fn(() => Promise.resolve()),
    };
    const selected: SubtitleTrack[] = [];
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(null)],
      taskStore,
      onTrackSelected: (track) => selected.push(track),
    });

    const startPromise = controller.start();
    await vi.waitFor(() => expect(resolveOldTrack).toBeTypeOf("function"));
    video.src = "https://media.example/episode-two.mp4";
    video.dispatchEvent(new Event("loadstart"));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    resolveOldTrack?.(oldTrack);
    await startPromise;

    expect(requestedKeys).toHaveLength(1);
    expect(selected).toHaveLength(0);
    expect(setTrack).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "TRANSLATE" }),
    );
    expect(controller.getStatus()).toMatchObject({
      state: "waiting",
      total: 0,
      completed: 0,
    });
    controller.stop();
  });

  it("rejects an old persisted track and does not restore again after the active video changes", async () => {
    const firstVideo = document.createElement("video");
    firstVideo.id = "first-video";
    document.body.append(firstVideo);
    let resolveOldTrack: ((track: SubtitleTrack) => void) | undefined;
    const requestedKeys: string[] = [];
    const taskStore: SubtitleTaskStore = {
      getTrack: (key) => {
        requestedKeys.push(key);
        if (requestedKeys.length > 1) return Promise.resolve(undefined);
        return new Promise<SubtitleTrack>((resolve) => {
          resolveOldTrack = resolve;
        });
      },
      setTrack: vi.fn(() => Promise.resolve()),
      deleteTrack: vi.fn(() => Promise.resolve()),
    };
    const selected: SubtitleTrack[] = [];
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(null)],
      taskStore,
      onTrackSelected: (track) => selected.push(track),
    });

    const startPromise = controller.start();
    await vi.waitFor(() => expect(resolveOldTrack).toBeTypeOf("function"));
    const secondVideo = document.createElement("video");
    secondVideo.id = "second-video";
    firstVideo.replaceWith(secondVideo);
    controller.refreshMedia();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    resolveOldTrack?.({
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "old-video-persisted",
          startMs: 0,
          endMs: 1_000,
          originalText: "Old video persisted subtitle",
        },
      ],
    });
    await startPromise;

    expect(requestedKeys).toHaveLength(1);
    expect(selected).toHaveLength(0);
    expect(runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "TRANSLATE" }),
    );
    expect(controller.getStatus()).toMatchObject({ state: "waiting" });
    controller.stop();
  });

  it("ignores malformed persisted subtitle tracks", async () => {
    const taskStore: SubtitleTaskStore = {
      getTrack: () =>
        Promise.resolve({
          source: "youtube-timedtext",
          completeness: "full",
          language: "en",
          cues: [
            {
              id: "unsafe",
              startMs: 0,
              endMs: 1_000,
              originalText: "",
            },
          ],
        }),
      setTrack: () => Promise.resolve(),
      deleteTrack: () => Promise.resolve(),
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(null)],
      taskStore,
    });

    await controller.start();

    expect(controller.getStatus()).toMatchObject({
      state: "unavailable",
      total: 0,
      completed: 0,
      failed: 0,
    });
    expect(runtime.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "TRANSLATE" }),
    );
    controller.stop();
  });

  it("isolates persisted tracks when currentSrc changes without a loadstart event", async () => {
    const video = document.createElement("video");
    video.id = "reused-player";
    video.src = "blob:https://example.com/episode-one";
    document.body.append(video);
    const firstTrack: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "episode-one",
          startMs: 0,
          endMs: 1_000,
          originalText: "Episode one",
        },
      ],
    };
    const secondTrack: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "episode-two",
          startMs: 0,
          endMs: 1_000,
          originalText: "Episode two",
        },
      ],
    };
    const adapter = new TestAdapter(firstTrack);
    const stored = new Map<string, SubtitleTrack>();
    const taskStore: SubtitleTaskStore = {
      getTrack: (key) => Promise.resolve(stored.get(key)),
      setTrack: (key, track) => {
        stored.set(key, structuredClone(track));
        return Promise.resolve();
      },
      deleteTrack: (key) => {
        stored.delete(key);
        return Promise.resolve();
      },
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
      taskStore,
    });
    await controller.start();
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 1,
      completed: 1,
    });

    adapter.setTrack(secondTrack);
    video.src = "blob:https://example.com/episode-two";
    controller.refreshMedia();

    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 1,
        completed: 1,
      }),
    );
    await vi.waitFor(() => expect(stored.size).toBe(2));
    expect([...stored.values()].map((track) => track.cues[0]?.id)).toEqual([
      "episode-one",
      "episode-two",
    ]);
    expect([...stored.keys()][0]).not.toBe([...stored.keys()][1]);
    const overlayText = document
      .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
      ?.shadowRoot?.querySelector<HTMLElement>(".translated")?.textContent;
    expect(overlayText).toBe("Episode two");
    controller.stop();
  });

  it("shows a machine translation while distant AI cache reads are pending", async () => {
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      value: 0,
    });
    document.body.append(video);
    const track: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "current",
          startMs: 0,
          endMs: 1_000,
          originalText: "Current cue.",
        },
        {
          id: "next",
          startMs: 60_000,
          endMs: 61_000,
          originalText: "Next cue.",
        },
        {
          id: "distant",
          startMs: 300_000,
          endMs: 301_000,
          originalText: "Distant cue.",
        },
      ],
    };
    let resolveDistantCache: (() => void) | undefined;
    const cache: SubtitleTranslationCache = {
      get: (key) =>
        key.includes('"text":"Distant cue."')
          ? new Promise((resolve) => {
              resolveDistantCache = () => resolve(undefined);
            })
          : Promise.resolve(undefined),
      set: () => Promise.resolve(),
    };
    const providerRequests: Array<{ ids: string[]; resolve(): void }> = [];
    runtime.sendMessage.mockImplementation((message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE"
      ) {
        const request =
          "request" in message &&
          typeof message.request === "object" &&
          message.request !== null &&
          "segments" in message.request &&
          Array.isArray(message.request.segments)
            ? message.request.segments
            : [];
        return new Promise((resolve) => {
          const segments = request as Array<{ id: string; text: string }>;
          providerRequests.push({
            ids: segments.map((segment) => segment.id),
            resolve: () =>
              resolve({
                ok: true,
                results: segments.flatMap((segment: unknown) =>
                  typeof segment === "object" &&
                  segment !== null &&
                  "id" in segment &&
                  typeof segment.id === "string" &&
                  "text" in segment &&
                  typeof segment.text === "string"
                    ? [
                        {
                          id: segment.id,
                          translatedText: `AI:${segment.text}`,
                        },
                      ]
                    : [],
                ),
              }),
          });
        });
      }
      return runtime.defaultHandler(message);
    });
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
      cache,
    });

    const start = controller.start();
    await vi.waitFor(() => {
      expect(resolveDistantCache).toBeTypeOf("function");
      expect(
        document
          .querySelector<HTMLElement>(
            '[data-norixortrans-ui="subtitle-overlay"]',
          )
          ?.shadowRoot?.querySelector<HTMLElement>(".translated")?.textContent,
      ).toBe("T:Current cue.");
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]?.ids).toEqual([
        "sentence:current",
        "sentence:next",
      ]);
    });
    providerRequests[0]?.resolve();
    resolveDistantCache?.();
    await vi.waitFor(() => expect(providerRequests).toHaveLength(2));
    expect(providerRequests[1]?.ids).toEqual(["sentence:distant"]);
    providerRequests[1]?.resolve();
    await start;
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 3,
      completed: 3,
      failed: 0,
    });
    controller.stop();
  });

  it("resumes a refreshed controller from the real IndexedDB cache", async () => {
    await clearCache();
    const track: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        { id: "first", startMs: 0, endMs: 1_000, originalText: "Hello." },
        { id: "second", startMs: 1_000, endMs: 2_000, originalText: "World." },
      ],
    };
    const indexedCache: SubtitleTranslationCache = {
      get: async (key) => getCachedTranslation(await sha256(key)),
      set: async (key, value) => setCachedTranslation(await sha256(key), value),
    };
    try {
      const firstController = new SubtitleController({
        settings: SETTINGS,
        adapters: [new TestAdapter(track)],
        cache: indexedCache,
      });
      await firstController.start();
      firstController.stop();
      expect(await cacheStats()).toMatchObject({ translations: 3 });

      runtime.sendMessage.mockClear();
      const refreshedController = new SubtitleController({
        settings: SETTINGS,
        adapters: [new TestAdapter(track)],
        cache: indexedCache,
      });
      await refreshedController.start();

      expect(refreshedController.getStatus()).toMatchObject({
        state: "ready",
        total: 2,
        completed: 2,
        failed: 0,
      });
      expect(
        runtime.sendMessage.mock.calls.filter(
          ([message]) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "TRANSLATE",
        ),
      ).toHaveLength(0);
      refreshedController.stop();
    } finally {
      await clearCache();
    }
  });

  it("does not reuse an AI subtitle cache entry when neighboring context changes", async () => {
    const cacheValues = new Map<string, string>();
    const cache: SubtitleTranslationCache = {
      get: (key) => Promise.resolve(cacheValues.get(key)),
      set: (key, value) => {
        cacheValues.set(key, value);
        return Promise.resolve();
      },
    };
    const firstTrack: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        { id: "ambiguous", startMs: 0, endMs: 1_000, originalText: "Run." },
        {
          id: "context",
          startMs: 1_000,
          endMs: 2_000,
          originalText: "A software command.",
        },
      ],
    };
    const firstController = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(firstTrack)],
      cache,
    });
    await firstController.start();
    firstController.stop();
    expect(
      [...cacheValues.keys()].filter((key) => key.includes("\u001fai\u001f")),
    ).toHaveLength(2);

    runtime.sendMessage.mockClear();
    const secondController = new SubtitleController({
      settings: SETTINGS,
      adapters: [
        new TestAdapter({
          ...firstTrack,
          cues: firstTrack.cues.map((cue) =>
            cue.id === "context"
              ? { ...cue, originalText: "An athlete starts moving." }
              : cue,
          ),
        }),
      ],
      cache,
    });
    await secondController.start();

    const request = runtime.sendMessage.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    )?.[0];
    expect(JSON.stringify(request)).toContain('"id":"sentence:ambiguous"');
    expect(
      [...cacheValues.keys()].filter((key) => key.includes("\u001fai\u001f")),
    ).toHaveLength(4);
    secondController.stop();
  });

  it("retries only failed cues and keeps successful progress", async () => {
    runtime.sendMessage.mockResolvedValueOnce({ ok: false });
    const track: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: Array.from({ length: 31 }, (_, index) => ({
        id: `cue-${index}`,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        originalText: `text-${index}.`,
      })),
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
    });
    await controller.start();

    expect(controller.getStatus()).toMatchObject({
      state: "partial",
      total: 31,
      completed: 1,
      failed: 30,
    });
    const retryStatus = await controller.retryFailed();

    expect(retryStatus).toMatchObject({
      state: "ready",
      completed: 31,
      failed: 0,
    });
    const translateCalls = runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    );
    expect(translateCalls).toHaveLength(3);
    expect(JSON.stringify(translateCalls.at(-1)?.[0])).toContain("video:none");
    expect(JSON.stringify(translateCalls.at(-1)?.[0])).toContain(
      '"id":"sentence:cue-0","text":"text-0."',
    );
    controller.stop();
  });

  it("cancels the active request and ignores its late response", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    runtime.sendMessage.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const cacheSet = vi.fn<
      (key: string, translatedText: string) => Promise<void>
    >(() => Promise.resolve());
    const track: SubtitleTrack = {
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [{ id: "late", startMs: 0, endMs: 1_000, originalText: "Late" }],
    };
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [new TestAdapter(track)],
      cache: { get: () => Promise.resolve(undefined), set: cacheSet },
    });
    const startPromise = controller.start();
    await vi.waitFor(() => {
      expect(resolveResponse).toBeTypeOf("function");
    });

    expect(controller.cancelTranslationTask()).toMatchObject({
      state: "cancelled",
      total: 1,
      completed: 0,
      failed: 1,
    });
    resolveResponse?.({
      ok: true,
      results: [{ id: "late", translatedText: "迟到响应" }],
    });
    await startPromise;

    expect(controller.getStatus()).toMatchObject({
      state: "cancelled",
      completed: 0,
    });
    expect(
      cacheSet.mock.calls.filter(([key]) => key.includes("\u001fai\u001f")),
    ).toHaveLength(0);
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "TRANSLATE_CANCEL" }),
    );
    runtime.sendMessage.mockImplementation(runtime.defaultHandler);
    await expect(controller.retryFailed()).resolves.toMatchObject({
      state: "ready",
      total: 1,
      completed: 1,
      failed: 0,
    });
    controller.stop();
  });

  it("keeps request and cache scope bound to the media that started the batch", async () => {
    const firstVideo = document.createElement("video");
    firstVideo.id = "media-a";
    firstVideo.src = "https://media.example/a.mp4";
    document.body.append(firstVideo);
    let resolveResponse: ((value: unknown) => void) | undefined;
    runtime.sendMessage.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const cacheSet = vi.fn<
      (key: string, translatedText: string) => Promise<void>
    >(() => Promise.resolve());
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [
        new TestAdapter({
          source: "texttrack",
          completeness: "full",
          language: "en",
          cues: [
            {
              id: "scoped",
              startMs: 0,
              endMs: 1_000,
              originalText: "Scoped media",
            },
          ],
        }),
      ],
      cache: { get: () => Promise.resolve(undefined), set: cacheSet },
    });

    const start = controller.start();
    await vi.waitFor(() => expect(resolveResponse).toBeTypeOf("function"));
    const secondVideo = document.createElement("video");
    secondVideo.id = "media-b";
    secondVideo.src = "https://media.example/b.mp4";
    firstVideo.replaceWith(secondVideo);
    resolveResponse?.({
      ok: true,
      results: [{ id: "sentence:scoped", translatedText: "媒体隔离" }],
    });
    await start;

    const translateCall = runtime.sendMessage.mock.calls.find(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    );
    expect(JSON.stringify(translateCall?.[0])).toContain("id:media-a");
    expect(JSON.stringify(translateCall?.[0])).not.toContain("id:media-b");
    const aiCacheWrites = cacheSet.mock.calls.filter(([key]) =>
      key.includes("\u001fai\u001f"),
    );
    expect(aiCacheWrites).toHaveLength(1);
    expect(aiCacheWrites[0]?.[0]).toContain("id:media-a");
    expect(aiCacheWrites[0]?.[0]).not.toContain("id:media-b");
    controller.stop();
  });

  it("clears a full track when the configured source language no longer matches", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 800, 450);
    document.body.append(video);
    const adapter = new TestAdapter({
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "english",
          startMs: 0,
          endMs: 1_000,
          originalText: "English subtitle",
        },
      ],
    });
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    await controller.start();
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      completed: 1,
    });
    const translationCallsBefore = runtime.sendMessage.mock.calls.filter(
      ([message]) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "TRANSLATE",
    ).length;

    controller.updateSettings({ ...SETTINGS, sourceLanguage: "de" });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "waiting",
        total: 0,
        completed: 0,
      }),
    );
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "TRANSLATE",
      ),
    ).toHaveLength(translationCallsBefore);

    adapter.setTrack({
      source: "youtube-timedtext",
      completeness: "full",
      language: "de",
      cues: [
        {
          id: "german",
          startMs: 0,
          endMs: 1_000,
          originalText: "Deutsche Untertitel",
        },
      ],
    });
    controller.refreshMedia();
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 1,
        completed: 1,
      }),
    );
    controller.stop();
  });

  it("invalidates an old response immediately when the video element changes", async () => {
    const firstVideo = document.createElement("video");
    document.body.append(firstVideo);
    let resolveFirst: ((value: unknown) => void) | undefined;
    runtime.sendMessage.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const adapter = new TestAdapter({
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        { id: "old-video", startMs: 0, endMs: 1_000, originalText: "Old." },
      ],
    });
    const controller = new SubtitleController({
      settings: SETTINGS,
      adapters: [adapter],
    });
    const startPromise = controller.start();
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf("function"));

    adapter.setTrack({
      source: "texttrack",
      completeness: "full",
      language: "en",
      cues: [
        { id: "new-video", startMs: 0, endMs: 1_000, originalText: "New." },
      ],
    });
    firstVideo.remove();
    document.body.append(document.createElement("video"));
    controller.refreshMedia();

    await vi.waitFor(() => {
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 1,
        completed: 1,
      });
    });
    expect(JSON.stringify(runtime.sendMessage.mock.calls)).toContain("New.");

    resolveFirst?.({
      ok: true,
      results: [{ id: "old-video", translatedText: "旧视频迟到响应" }],
    });
    await startPromise;
    expect(controller.getStatus()).toMatchObject({
      state: "ready",
      total: 1,
      completed: 1,
    });
    controller.stop();
  });
});
