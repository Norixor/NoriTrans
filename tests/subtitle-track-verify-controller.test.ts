import { DEFAULT_SETTINGS, type SubtitleSettings } from "@/src/shared/settings";
import type { SubtitleAdapter } from "@/src/subtitles/adapters/types";
import { SubtitleController } from "@/src/subtitles/controller";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(
    (message: unknown) => {
      const candidate = message as {
        type?: unknown;
        request?: { segments?: Array<{ id: string; text: string }> };
      };
      if (candidate?.type !== "TRANSLATE") {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({
        ok: true,
        results: (candidate.request?.segments ?? []).map((segment) => ({
          id: segment.id,
          translatedText: `[zh] ${segment.text}`,
        })),
      });
    },
  ),
}));

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

const SETTINGS: SubtitleSettings = {
  ...DEFAULT_SETTINGS.subtitles,
  mode: "fast",
  displayMode: "translated",
  sentenceSmoothing: false,
  ignoreSoundCues: false,
};
const REMOTE_FAST_PROVIDER = {
  ...DEFAULT_SETTINGS.provider,
  fastProvider: "google-translate" as const,
};

// Synthetic, self-written lines only: one per 1.5 s slot for two minutes.
// Each document uses its own vocabulary so unrelated lines never look alike.
const VOCABULARY: Record<string, string[]> = {
  right: ["harbor", "lantern", "compass", "ladder", "meadow", "violin"],
  wrong: ["copper", "kettle", "glacier", "pepper", "saddle", "thunder"],
  other: ["marble", "orchard", "falcon", "velvet", "canyon", "biscuit"],
  third: ["rocket", "pillow", "tundra", "walnut", "beacon", "quartz"],
};

function cues(prefix: string): SubtitleCue[] {
  const words = VOCABULARY[prefix] ?? [];
  return Array.from({ length: 80 }, (_, index) => ({
    id: `${prefix}-${index}`,
    startMs: index * 1_500,
    endMs: index * 1_500 + 1_400,
    originalText: Array.from(
      { length: 4 },
      (_, offset) =>
        `${words[(index + offset) % words.length]}${prefix}${index}`,
    ).join(" "),
  }));
}

const RIGHT_CUES = cues("right");
const WRONG_CUES = cues("wrong");

function fullTrack(trackCues: SubtitleCue[]): SubtitleTrack {
  return {
    source: "netflix-manifest",
    completeness: "full",
    language: "en",
    cues: trackCues,
  };
}

class FakeNetflixAdapter implements SubtitleAdapter {
  readonly id = "fake-netflix";
  readonly priority = 1;
  native = "";
  discarded = 0;
  private readonly listeners = new Set<(track: SubtitleTrack) => void>();
  constructor(public track: SubtitleTrack | null) {}
  matches(): boolean {
    return true;
  }
  collect(): Promise<SubtitleTrack | null> {
    return Promise.resolve(this.track);
  }
  subscribe(listener: (track: SubtitleTrack) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  nativeCaptionText(): string {
    return this.native;
  }
  discardCapturedTrack(): void {
    this.discarded += 1;
    this.track = null;
  }
  emit(track: SubtitleTrack): void {
    this.track = track;
    for (const listener of this.listeners) listener(track);
  }
}

/** Same adapter without the optional verification hooks. */
class PlainAdapter implements SubtitleAdapter {
  readonly id = "plain";
  readonly priority = 1;
  constructor(public track: SubtitleTrack) {}
  matches(): boolean {
    return true;
  }
  collect(): Promise<SubtitleTrack | null> {
    return Promise.resolve(this.track);
  }
}

function memoryStore() {
  const tracks = new Map<string, SubtitleTrack>();
  const deleteTrack = vi.fn((key: string) => {
    tracks.delete(key);
    return Promise.resolve();
  });
  const store = {
    tracks,
    deleteTrack,
    getTrack: (key: string): Promise<unknown> =>
      Promise.resolve(tracks.get(key)),
    setTrack: (key: string, track: SubtitleTrack): Promise<void> => {
      tracks.set(key, track);
      return Promise.resolve();
    },
  };
  return store;
}

interface Harness {
  controller: SubtitleController;
  video: HTMLVideoElement;
  store: ReturnType<typeof memoryStore>;
  /** Advance playback by `slots` × 1.5 s, showing `native(slot)` meanwhile. */
  play: (slots: number, native: (timeMs: number) => string) => Promise<void>;
}

async function startHarness(adapter: SubtitleAdapter): Promise<Harness> {
  const video = document.createElement("video");
  let currentTime = 0;
  let paused = false;
  let seeking = false;
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
      },
    },
    paused: { configurable: true, get: () => paused },
    seeking: { configurable: true, get: () => seeking },
  });
  (video as HTMLVideoElement & { setPaused(value: boolean): void }).setPaused =
    (value) => {
      paused = value;
    };
  (
    video as HTMLVideoElement & { setSeeking(value: boolean): void }
  ).setSeeking = (value) => {
    seeking = value;
  };
  document.body.append(video);
  const store = memoryStore();
  const controller = new SubtitleController({
    settings: SETTINGS,
    adapters: [adapter],
    taskStore: store,
    providerSettings: REMOTE_FAST_PROVIDER,
  });
  await controller.start();
  return {
    controller,
    video,
    store,
    play: async (slots, native) => {
      for (let slot = 0; slot < slots; slot += 1) {
        if (!video.paused && !video.seeking) currentTime += 1.5;
        if (adapter instanceof FakeNetflixAdapter) {
          adapter.native = native(currentTime * 1_000);
        }
        await vi.advanceTimersByTimeAsync(1_500);
      }
    },
  };
}

function lineAt(trackCues: SubtitleCue[]) {
  return (timeMs: number): string =>
    trackCues.find(
      (cue) => cue.startMs <= timeMs && timeMs < cue.startMs + 1_500,
    )?.originalText ?? "";
}

describe("SubtitleController full-track self-healing", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    runtime.sendMessage.mockClear();
    document.documentElement.replaceChildren(
      document.createElement("head"),
      document.createElement("body"),
    );
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("discards a full track whose text never matches the native captions", async () => {
    const adapter = new FakeNetflixAdapter(fullTrack(WRONG_CUES));
    const { controller, store, play } = await startHarness(adapter);
    expect(controller.getStatus()).toMatchObject({ completeness: "full" });
    await vi.waitFor(() => expect(store.tracks.size).toBe(1));
    const [key] = [...store.tracks.keys()];

    // Warmup (5 s) plus two mismatches: not yet healed.
    await play(5, lineAt(RIGHT_CUES));
    expect(adapter.discarded).toBe(0);
    await play(1, lineAt(RIGHT_CUES));
    expect(adapter.discarded).toBe(1);
    expect(store.deleteTrack).toHaveBeenCalledWith(key);
    expect(store.tracks.size).toBe(0);
    expect(controller.getStatus()).toMatchObject({ state: "waiting" });

    // The rejected document must not come back, but a correct one is accepted.
    adapter.emit(fullTrack(WRONG_CUES));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getStatus()).toMatchObject({ state: "waiting" });
    adapter.emit(fullTrack(RIGHT_CUES));
    await vi.waitFor(() =>
      expect(controller.getStatus()).toMatchObject({ completeness: "full" }),
    );
    await play(12, lineAt(RIGHT_CUES));
    expect(adapter.discarded).toBe(1);
    controller.stop();
  });

  it("keeps a full track that matches the native captions", async () => {
    const adapter = new FakeNetflixAdapter(fullTrack(RIGHT_CUES));
    const { controller, play } = await startHarness(adapter);
    await play(20, lineAt(RIGHT_CUES));
    expect(adapter.discarded).toBe(0);
    expect(controller.getStatus()).toMatchObject({ completeness: "full" });
    controller.stop();
  });

  it("ignores native captions in another writing system", async () => {
    const adapter = new FakeNetflixAdapter(fullTrack(WRONG_CUES));
    const { controller, play } = await startHarness(adapter);
    const chinese = [
      "我们明天早上在车站门口见面吧",
      "这本书的封面被雨水打湿了了",
      "窗外的雨一直下到了天亮时分",
    ];
    await play(20, (timeMs) => chinese[Math.floor(timeMs / 1_500) % 3] ?? "");
    expect(adapter.discarded).toBe(0);
    controller.stop();
  });

  it("ignores empty and too-short native captions", async () => {
    const adapter = new FakeNetflixAdapter(fullTrack(WRONG_CUES));
    const { controller, play } = await startHarness(adapter);
    const short = ["Okay.", "", "Why not?", "Fine, go."];
    await play(20, (timeMs) => short[Math.floor(timeMs / 1_500) % 4] ?? "");
    expect(adapter.discarded).toBe(0);
    controller.stop();
  });

  it("does not sample while paused or seeking", async () => {
    const adapter = new FakeNetflixAdapter(fullTrack(WRONG_CUES));
    const harness = await startHarness(adapter);
    const video = harness.video as HTMLVideoElement & {
      setPaused(value: boolean): void;
      setSeeking(value: boolean): void;
    };
    video.setPaused(true);
    let distinct = 0;
    await harness.play(
      10,
      () => `Paused frame caption variant ${distinct++} here`,
    );
    video.setPaused(false);
    video.setSeeking(true);
    await harness.play(
      10,
      () => `Seeking frame caption variant ${distinct++} here`,
    );
    expect(adapter.discarded).toBe(0);
    harness.controller.stop();
  });

  it("heals at most twice per media and waits for the cooldown", async () => {
    const adapter = new FakeNetflixAdapter(fullTrack(WRONG_CUES));
    const { controller, play } = await startHarness(adapter);
    const native = lineAt(RIGHT_CUES);
    await play(6, native);
    expect(adapter.discarded).toBe(1);

    // A second wrong document right away: detected, but inside the cooldown.
    adapter.emit(fullTrack(cues("other")));
    await play(8, native);
    expect(adapter.discarded).toBe(1);
    // After the cooldown a fresh streak may heal again.
    await play(14, native);
    expect(adapter.discarded).toBe(2);

    // The per-media budget is spent.
    adapter.emit(fullTrack(cues("third")));
    await play(40, native);
    expect(adapter.discarded).toBe(2);
    expect(controller.getStatus()).toMatchObject({ completeness: "full" });
    controller.stop();
  });

  it("leaves adapters without native caption access untouched", async () => {
    const adapter = new PlainAdapter(fullTrack(WRONG_CUES));
    const { controller, store, play } = await startHarness(adapter);
    await play(20, () => "");
    expect(store.deleteTrack).not.toHaveBeenCalled();
    expect(controller.getStatus()).toMatchObject({ completeness: "full" });
    controller.stop();
  });
});
