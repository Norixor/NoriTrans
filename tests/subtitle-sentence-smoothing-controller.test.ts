import { DEFAULT_SETTINGS, type SubtitleSettings } from "@/src/shared/settings";
import type { SubtitleAdapter } from "@/src/subtitles/adapters/types";
import { SubtitleController } from "@/src/subtitles/controller";
import { fragmentAwareSegments } from "@/src/subtitles/fragment-context";
import { groupSubtitleCues } from "@/src/subtitles/groups";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";
import { contextualizeSegments } from "@/src/translation/context";
import type { TranslationRequest } from "@/src/translation/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const defaultHandler = (message: unknown): Promise<unknown> => {
    const candidate = message as {
      type?: unknown;
      request?: { segments?: Array<{ id: string; text: string }> };
    };
    if (candidate?.type !== "TRANSLATE") return Promise.resolve({ ok: true });
    return Promise.resolve({
      ok: true,
      results: (candidate.request?.segments ?? []).map((segment) => ({
        id: segment.id,
        translatedText: `[zh] ${segment.text}`,
      })),
    });
  };
  return {
    defaultHandler,
    sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(defaultHandler),
  };
});

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: { getMessage: (key: string) => key },
    runtime: {
      sendMessage: runtime.sendMessage,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  },
}));

vi.mock("@/src/shared/i18n", () => ({
  configureUiLanguage: vi.fn(),
  currentUiLocale: () => "en",
  message: (key: string) => key,
}));

class TestAdapter implements SubtitleAdapter {
  readonly id = "test";
  readonly priority = 1;
  constructor(private readonly track: SubtitleTrack) {}
  matches(): boolean {
    return true;
  }
  collect(): Promise<SubtitleTrack | null> {
    return Promise.resolve(this.track);
  }
}

const BASE: SubtitleSettings = {
  ...DEFAULT_SETTINGS.subtitles,
  mode: "ai",
  aiResponseMode: "batch",
  displayMode: "translated",
};
const ON: SubtitleSettings = { ...BASE, sentenceSmoothing: true };
const OFF: SubtitleSettings = { ...BASE, sentenceSmoothing: false };
const REMOTE_FAST_PROVIDER = {
  ...DEFAULT_SETTINGS.provider,
  fastProvider: "google-translate" as const,
};

// Synthetic, self-written subtitle lines only.
const CUES: SubtitleCue[] = [
  { id: "c1", startMs: 0, endMs: 900, originalText: "Good morning." },
  {
    id: "c2",
    startMs: 1_000,
    endMs: 1_900,
    originalText: "it always makes me so",
  },
  {
    id: "c3",
    startMs: 2_000,
    endMs: 2_900,
    originalText: "sad, but I don't care.",
  },
  { id: "c4", startMs: 3_000, endMs: 3_900, originalText: "- Are you sure" },
  { id: "c5", startMs: 4_000, endMs: 4_900, originalText: "- Very sure." },
  { id: "c6", startMs: 6_000, endMs: 6_900, originalText: "[music]" },
];

function track(
  source: SubtitleTrack["source"],
  completeness: SubtitleTrack["completeness"] = "full",
): SubtitleTrack {
  return { source, completeness, language: "en", cues: CUES };
}

function translateRequests(): TranslationRequest[] {
  return runtime.sendMessage.mock.calls.flatMap(([message]) => {
    const candidate = message as { type?: unknown; request?: unknown };
    return candidate?.type === "TRANSLATE"
      ? [candidate.request as TranslationRequest]
      : [];
  });
}

function plainContext(
  cues: readonly { id: string; originalText: string }[],
): ReturnType<typeof contextualizeSegments> {
  const segments = cues.map((item) => ({
    id: item.id,
    text: item.originalText,
  }));
  return contextualizeSegments(segments, segments);
}

async function run(
  subtitleTrack: SubtitleTrack,
  settings: SubtitleSettings,
  options: {
    cacheKeys?: string[];
    currentTimeMs?: number;
  } = {},
): Promise<{ requests: TranslationRequest[]; controller: SubtitleController }> {
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    writable: true,
    value: (options.currentTimeMs ?? 0) / 1_000,
  });
  document.body.append(video);
  const controller = new SubtitleController({
    settings,
    adapters: [new TestAdapter(subtitleTrack)],
    providerSettings: REMOTE_FAST_PROVIDER,
    ...(options.cacheKeys
      ? {
          cache: {
            get: () => Promise.resolve(undefined),
            set: (key: string) => {
              options.cacheKeys?.push(key);
              return Promise.resolve();
            },
          },
        }
      : {}),
  });
  await controller.start();
  await vi.waitFor(() => expect(translateRequests().length).toBeGreaterThan(0));
  return { requests: translateRequests(), controller };
}

function overlayTranslation(): string | null | undefined {
  return document
    .querySelector<HTMLElement>('[data-noritrans-ui="subtitle-overlay"]')
    ?.shadowRoot?.querySelector<HTMLElement>(".translated")?.textContent;
}

describe("SubtitleController sentence smoothing", () => {
  beforeEach(() => {
    vi.useRealTimers();
    runtime.sendMessage.mockReset();
    runtime.sendMessage.mockImplementation(runtime.defaultHandler);
    document.documentElement.replaceChildren(
      document.createElement("head"),
      document.createElement("body"),
    );
    (globalThis as typeof globalThis & { Translator?: unknown }).Translator =
      undefined;
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

  it("keeps Netflix per-cue requests unchanged when smoothing is off", async () => {
    const { requests, controller } = await run(track("netflix-manifest"), OFF);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.segments).toEqual(plainContext(CUES));
    expect(requests[0]).not.toHaveProperty("fragmentAware");
    controller.stop();
  });

  it("keeps merged sentence-group requests for other full tracks when smoothing is off", async () => {
    const { requests, controller } = await run(track("texttrack"), OFF);
    const groups = groupSubtitleCues(CUES);
    expect(groups.map((group) => group.id)).toContain("sentence:c2+c3");
    expect(requests[0]?.segments).toEqual(plainContext(groups));
    expect(requests[0]).not.toHaveProperty("fragmentAware");
    controller.stop();
  });

  it.each(["netflix-manifest", "texttrack"] as const)(
    "sends every %s cue with its whole sentence as context when smoothing is on",
    async (source) => {
      const subtitleTrack = track(source);
      const { requests, controller } = await run(subtitleTrack, ON);
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(request?.fragmentAware).toBe(true);
      expect(request?.mode).toBe("ai");
      expect(request?.segments.map((segment) => segment.id)).toEqual(
        CUES.map((item) => item.id),
      );
      expect(request?.segments).toEqual(
        fragmentAwareSegments(subtitleTrack, CUES),
      );
      const second = request?.segments.find((segment) => segment.id === "c2");
      expect(second?.contextAfter?.[0]).toBe("sad, but I don't care.");
      const third = request?.segments.find((segment) => segment.id === "c3");
      expect(third?.contextBefore?.at(-1)).toBe("it always makes me so");
      // Cues outside the split sentence keep exactly the ordinary context.
      const ordinary = plainContext(CUES);
      for (const id of ["c1", "c4", "c5", "c6"]) {
        expect(request?.segments.find((segment) => segment.id === id)).toEqual(
          ordinary.find((segment) => segment.id === id),
        );
      }
      for (const segment of request?.segments ?? []) {
        expect(segment.contextBefore?.length ?? 0).toBeLessThanOrEqual(4);
        expect(segment.contextAfter?.length ?? 0).toBeLessThanOrEqual(4);
      }
      controller.stop();
    },
  );

  it("displays each fragment's own translation at its own time on non-Netflix tracks", async () => {
    const { controller } = await run(track("texttrack"), ON, {
      currentTimeMs: 2_200,
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: CUES.length,
        completed: CUES.length,
      }),
    );
    expect(overlayTranslation()).toBe("[zh] sad, but I don't care.");
    controller.stop();
  });

  it("keeps the merged display unit when smoothing is off", async () => {
    const { controller } = await run(track("texttrack"), OFF, {
      currentTimeMs: 2_200,
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({ state: "ready" }),
    );
    expect(overlayTranslation()).toBe(
      "[zh] it always makes me so sad, but I don't care.",
    );
    controller.stop();
  });

  it.each([
    ["stream", track("texttrack", "stream"), BASE],
    ["fast full", track("texttrack"), { ...BASE, mode: "fast" as const }],
    [
      "fast Netflix",
      track("netflix-manifest"),
      { ...BASE, mode: "fast" as const },
    ],
  ])(
    "sends identical %s requests whether smoothing is on or off",
    async (_label, subtitleTrack, settings) => {
      const on = await run(subtitleTrack, {
        ...settings,
        sentenceSmoothing: true,
      });
      on.controller.stop();
      const onRequests = on.requests;
      runtime.sendMessage.mockClear();
      const off = await run(subtitleTrack, {
        ...settings,
        sentenceSmoothing: false,
      });
      off.controller.stop();
      expect(onRequests.length).toBeGreaterThan(0);
      expect(onRequests.every((request) => request.mode === "fast")).toBe(true);
      expect(onRequests).toEqual(off.requests);
      for (const request of onRequests) {
        expect(request).not.toHaveProperty("fragmentAware");
      }
    },
  );

  it("separates smoothed and plain translation cache keys", async () => {
    const onKeys: string[] = [];
    const on = await run(track("netflix-manifest"), ON, { cacheKeys: onKeys });
    await vi.waitFor(() => expect(onKeys.length).toBe(CUES.length));
    on.controller.stop();
    runtime.sendMessage.mockClear();
    const offKeys: string[] = [];
    const off = await run(track("netflix-manifest"), OFF, {
      cacheKeys: offKeys,
    });
    await vi.waitFor(() => expect(offKeys.length).toBe(CUES.length));
    off.controller.stop();
    // Even single cues with identical text and context must not share keys.
    expect(onKeys.filter((key) => offKeys.includes(key))).toEqual([]);
  });

  it("restarts translation with the new unit when the setting changes", async () => {
    const { controller } = await run(track("texttrack"), ON);
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({ state: "ready" }),
    );
    runtime.sendMessage.mockClear();

    controller.updateSettings(OFF);
    await vi.waitFor(() => expect(translateRequests()).toHaveLength(1));
    expect(
      translateRequests()[0]?.segments.map((segment) => segment.id),
    ).toEqual(groupSubtitleCues(CUES).map((group) => group.id));
    expect(translateRequests()[0]).not.toHaveProperty("fragmentAware");
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: groupSubtitleCues(CUES).length,
      }),
    );

    runtime.sendMessage.mockClear();
    controller.updateSettings(ON);
    await vi.waitFor(() => expect(translateRequests()).toHaveLength(1));
    expect(translateRequests()[0]?.fragmentAware).toBe(true);
    expect(
      translateRequests()[0]?.segments.map((segment) => segment.id),
    ).toEqual(CUES.map((item) => item.id));
    controller.stop();
  });

  it("switches the unit when AI mode is turned on or off with smoothing enabled", async () => {
    const { controller } = await run(track("texttrack"), {
      ...ON,
      mode: "fast",
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: groupSubtitleCues(CUES).length,
      }),
    );
    runtime.sendMessage.mockClear();
    controller.updateSettings(ON);
    await vi.waitFor(() => expect(translateRequests()).toHaveLength(1));
    expect(translateRequests()[0]).toMatchObject({
      mode: "ai",
      fragmentAware: true,
    });
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: CUES.length,
      }),
    );
    controller.stop();
  });
});
