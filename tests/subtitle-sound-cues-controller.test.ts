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
  sentenceSmoothing: false,
  ignoreSoundCues: false,
};
const SKIP: SubtitleSettings = { ...BASE, ignoreSoundCues: true };
const REMOTE_FAST_PROVIDER = {
  ...DEFAULT_SETTINGS.provider,
  fastProvider: "google-translate" as const,
};

// Synthetic, self-written subtitle lines only.
const CUES: SubtitleCue[] = [
  { id: "c1", startMs: 0, endMs: 900, originalText: "Good morning." },
  { id: "c2", startMs: 1_000, endMs: 1_900, originalText: "(🎵 siren)" },
  {
    id: "c3",
    startMs: 2_000,
    endMs: 2_900,
    originalText: "it always makes me so",
  },
  { id: "c4", startMs: 3_000, endMs: 3_100, originalText: "[Music]" },
  {
    id: "c5",
    startMs: 3_200,
    endMs: 4_000,
    originalText: "sad, but I don't care.",
  },
  { id: "c6", startMs: 5_000, endMs: 5_900, originalText: "♪ la la la ♪" },
  {
    id: "c7",
    startMs: 7_000,
    endMs: 7_900,
    originalText: "(applause)\n♪",
  },
];
const SOUND_IDS = ["c2", "c4", "c7"];
const DIALOGUE = CUES.filter((item) => !SOUND_IDS.includes(item.id));
const SOUND_TEXT = /siren|\[Music\]|applause/u;

function track(
  source: SubtitleTrack["source"],
  completeness: SubtitleTrack["completeness"] = "full",
  cues: SubtitleCue[] = CUES,
): SubtitleTrack {
  return { source, completeness, language: "en", cues };
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

function mentionsSoundCue(request: TranslationRequest): boolean {
  return request.segments.some((segment) =>
    [
      segment.text,
      ...(segment.contextBefore ?? []),
      ...(segment.contextAfter ?? []),
    ].some((text) => SOUND_TEXT.test(text)),
  );
}

async function start(
  subtitleTrack: SubtitleTrack,
  settings: SubtitleSettings,
  currentTimeMs = 0,
): Promise<SubtitleController> {
  const video = document.createElement("video");
  Object.defineProperty(video, "currentTime", {
    configurable: true,
    writable: true,
    value: currentTimeMs / 1_000,
  });
  document.body.append(video);
  const controller = new SubtitleController({
    settings,
    adapters: [new TestAdapter(subtitleTrack)],
    providerSettings: REMOTE_FAST_PROVIDER,
  });
  await controller.start();
  return controller;
}

async function run(
  subtitleTrack: SubtitleTrack,
  settings: SubtitleSettings,
  currentTimeMs = 0,
): Promise<{ requests: TranslationRequest[]; controller: SubtitleController }> {
  const controller = await start(subtitleTrack, settings, currentTimeMs);
  await vi.waitFor(() => expect(translateRequests().length).toBeGreaterThan(0));
  await vi.waitFor(() =>
    expect(controller.getStatus()).toMatchObject({ state: "ready" }),
  );
  return { requests: translateRequests(), controller };
}

function overlayLines(): {
  original: string;
  originalHidden: boolean;
  translated: string;
  translatedHidden: boolean;
} {
  const root = document.querySelector<HTMLElement>(
    '[data-noritrans-ui="subtitle-overlay"]',
  )?.shadowRoot;
  const original = root?.querySelector<HTMLElement>(".original");
  const translated = root?.querySelector<HTMLElement>(".translated");
  return {
    original: original?.textContent ?? "",
    originalHidden: Boolean(original?.hidden ?? true),
    translated: translated?.textContent ?? "",
    translatedHidden: Boolean(translated?.hidden ?? true),
  };
}

describe("SubtitleController ignoreSoundCues", () => {
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

  it.each(["netflix-manifest", "texttrack"] as const)(
    "sends no sound cue or sound-cue context on a smoothed %s track",
    async (source) => {
      const filtered = track(source, "full", DIALOGUE);
      const { requests, controller } = await run(track(source), {
        ...SKIP,
        sentenceSmoothing: true,
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.segments.map((segment) => segment.id)).toEqual([
        "c1",
        "c3",
        "c5",
        "c6",
      ]);
      expect(requests[0]?.segments).toEqual(
        fragmentAwareSegments(filtered, DIALOGUE),
      );
      expect(requests.some(mentionsSoundCue)).toBe(false);
      // Lyrics are real content and are still translated.
      expect(requests[0]?.segments.at(-1)?.text).toBe("♪ la la la ♪");
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: DIALOGUE.length,
        completed: DIALOGUE.length,
        failed: 0,
      });
      controller.stop();
    },
  );

  it("sends no sound cue or sound-cue context when smoothing is off", async () => {
    const netflix = await run(track("netflix-manifest"), SKIP);
    expect(netflix.requests).toHaveLength(1);
    expect(netflix.requests[0]?.segments).toEqual(plainContext(DIALOGUE));
    expect(netflix.requests.some(mentionsSoundCue)).toBe(false);
    expect(netflix.controller.getStatus()).toMatchObject({
      state: "ready",
      total: DIALOGUE.length,
      failed: 0,
    });
    netflix.controller.stop();
    runtime.sendMessage.mockClear();

    const other = await run(track("texttrack"), SKIP);
    const groups = groupSubtitleCues(DIALOGUE);
    // Without the sound cues the two halves of the sentence merge again.
    expect(groups.map((group) => group.id)).toContain("sentence:c3+c5");
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]?.segments).toEqual(plainContext(groups));
    expect(other.requests.some(mentionsSoundCue)).toBe(false);
    expect(other.controller.getStatus()).toMatchObject({
      state: "ready",
      total: groups.length,
      completed: groups.length,
      failed: 0,
    });
    other.controller.stop();
  });

  it("keeps sending every cue when the setting is off", async () => {
    const netflix = await run(track("netflix-manifest"), BASE);
    expect(netflix.requests).toHaveLength(1);
    expect(netflix.requests[0]?.segments).toEqual(plainContext(CUES));
    netflix.controller.stop();
    runtime.sendMessage.mockClear();

    const other = await run(track("texttrack"), BASE);
    expect(other.requests).toHaveLength(1);
    expect(other.requests[0]?.segments).toEqual(
      plainContext(groupSubtitleCues(CUES)),
    );
    other.controller.stop();
    runtime.sendMessage.mockClear();

    const smoothed = await run(track("texttrack"), {
      ...BASE,
      sentenceSmoothing: true,
    });
    expect(smoothed.requests[0]?.segments).toEqual(
      fragmentAwareSegments(track("texttrack"), CUES),
    );
    smoothed.controller.stop();
  });

  it.each<[string, boolean]>([
    ["smoothing on", true],
    ["smoothing off", false],
  ])(
    "shows the original text alone for a skipped cue in every display mode (%s)",
    async (_label, sentenceSmoothing) => {
      const controller = await start(
        track("texttrack"),
        { ...SKIP, sentenceSmoothing },
        1_500,
      );
      await vi.waitFor(() =>
        expect(controller.getStatus()).toMatchObject({ state: "ready" }),
      );
      for (const displayMode of [
        "translated",
        "bilingual",
        "original",
      ] as const) {
        controller.updateSettings({ ...SKIP, sentenceSmoothing, displayMode });
        await vi.waitFor(() =>
          expect(controller.getStatus()).toMatchObject({ state: "ready" }),
        );
        const lines = overlayLines();
        expect(lines.original).toBe("(🎵 siren)");
        expect(lines.originalHidden).toBe(false);
        expect(lines.translated).toBe("");
        expect(lines.translatedHidden).toBe(true);
      }
      controller.stop();
    },
  );

  it("sends no request and reports ready when every cue is a sound cue", async () => {
    const onlySounds = CUES.filter((item) => SOUND_IDS.includes(item.id));
    const controller = await start(
      track("texttrack", "full", onlySounds),
      SKIP,
    );
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({
        state: "ready",
        total: 0,
        failed: 0,
      }),
    );
    expect(translateRequests()).toHaveLength(0);
    controller.stop();
  });

  it("skips sound cues on live tracks and keeps translating dialogue", async () => {
    const live = track("dom", "stream", CUES);
    const { requests, controller } = await run(live, SKIP);
    const sentIds = requests.flatMap((request) =>
      request.segments.map((segment) => segment.id),
    );
    expect(requests.every((request) => request.mode === "fast")).toBe(true);
    expect(new Set(sentIds)).toEqual(new Set(["c1", "c3", "c5", "c6"]));
    expect(requests.some(mentionsSoundCue)).toBe(false);
    expect(controller.getStatus()).toMatchObject({
      completeness: "stream",
      failed: 0,
    });
    controller.stop();
    runtime.sendMessage.mockClear();

    const plain = await run(live, BASE);
    expect(
      new Set(
        plain.requests.flatMap((request) =>
          request.segments.map((segment) => segment.id),
        ),
      ),
    ).toEqual(new Set(CUES.map((item) => item.id)));
    plain.controller.stop();
  });

  it("restarts translation when the setting flips", async () => {
    const { controller } = await run(track("texttrack"), BASE);
    runtime.sendMessage.mockClear();

    controller.updateSettings(SKIP);
    await vi.waitFor(() => expect(translateRequests()).toHaveLength(1));
    expect(translateRequests()[0]?.segments).toEqual(
      plainContext(groupSubtitleCues(DIALOGUE)),
    );
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({ state: "ready" }),
    );

    runtime.sendMessage.mockClear();
    controller.updateSettings(BASE);
    await vi.waitFor(() => expect(translateRequests()).toHaveLength(1));
    expect(translateRequests()[0]?.segments).toEqual(
      plainContext(groupSubtitleCues(CUES)),
    );
    controller.stop();
  });
});
