import { ProfileDomSubtitleAdapter } from "@/src/subtitles/adapters/profile-dom";
import { MAX_LIVE_STREAM_CUES } from "@/src/subtitles/adapters/types";
import { DYNAMIC_NATIVE_CAPTION_ATTRIBUTE } from "@/src/subtitles/native-visibility";
import { builtInSiteProfile } from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import type { SubtitleTrack } from "@/src/subtitles/types";
import { describe, expect, it, vi } from "vitest";

const PROFILE: SubtitleSiteProfile = {
  id: "user-localhost",
  version: 1,
  name: "localhost",
  parser: "dom",
  priority: 1,
  match: { hostnameSuffixes: ["localhost"] },
  selectors: {
    video: "video",
    captions: ["#captions"],
    nativeCaptions: ["#captions"],
  },
  capture: {
    formats: [],
    allowedHostnameSuffixes: [],
    urlPatterns: [],
  },
};

function setVisibleGeometry(
  video: HTMLVideoElement,
  caption: HTMLElement,
): void {
  video.getBoundingClientRect = () => new DOMRect(100, 50, 800, 450);
  caption.getBoundingClientRect = () => new DOMRect(180, 390, 640, 48);
}

describe("ProfileDomSubtitleAdapter", () => {
  it("marks only the generic caption node actually associated with the active video", async () => {
    document.body.innerHTML = `
      <div class="player"><video></video><div class="subtitle">Actual caption</div></div>
      <aside><div class="subtitle">Article subtitle</div></aside>
    `;
    const video = document.querySelector("video");
    const actual = document.querySelector<HTMLElement>(".player .subtitle");
    const article = document.querySelector<HTMLElement>("aside .subtitle");
    if (!video || !actual || !article)
      throw new Error("missing generic fixture");
    setVisibleGeometry(video, actual);
    const adapter = new ProfileDomSubtitleAdapter(
      builtInSiteProfile("default-dom-heuristic"),
    );
    const stop = adapter.subscribe(() => undefined);

    await adapter.collect();

    expect(actual.hasAttribute(DYNAMIC_NATIVE_CAPTION_ATTRIBUTE)).toBe(true);
    expect(article.hasAttribute(DYNAMIC_NATIVE_CAPTION_ATTRIBUTE)).toBe(false);
    stop();
    expect(actual.hasAttribute(DYNAMIC_NATIVE_CAPTION_ATTRIBUTE)).toBe(false);
  });

  it.each(["zero-size", "css-hidden"] as const)(
    "rejects page text when the only video is %s",
    async (hiddenKind) => {
      document.body.innerHTML = `
        <video></video>
        <main><div class="subtitle">Article section subtitle</div></main>
      `;
      const video = document.querySelector("video");
      const article = document.querySelector<HTMLElement>(".subtitle");
      if (!video || !article) throw new Error("missing hidden video fixture");
      video.getBoundingClientRect = () =>
        hiddenKind === "zero-size"
          ? new DOMRect(0, 0, 0, 0)
          : new DOMRect(100, 50, 800, 450);
      if (hiddenKind === "css-hidden") video.style.display = "none";
      article.getBoundingClientRect = () => new DOMRect(180, 390, 640, 48);
      const adapter = new ProfileDomSubtitleAdapter(
        builtInSiteProfile("default-dom-heuristic"),
        false,
      );

      expect(await adapter.collect()).toBeNull();
      expect(article.hasAttribute(DYNAMIC_NATIVE_CAPTION_ATTRIBUTE)).toBe(
        false,
      );
    },
  );

  it("captures a TVer Video.js cue through the built-in preset", async () => {
    document.body.innerHTML = `
      <video></video>
      <div class="vjs-text-track-display">
        <span class="vjs-text-track-cue-text">TVer spoken subtitle.</span>
      </div>
    `;
    const video = document.querySelector("video");
    const display = document.querySelector<HTMLElement>(
      ".vjs-text-track-display",
    );
    const cue = document.querySelector<HTMLElement>(".vjs-text-track-cue-text");
    if (!video || !display || !cue) throw new Error("missing TVer fixture");
    Object.defineProperty(video, "currentTime", { value: 6, writable: true });
    video.getBoundingClientRect = () => new DOMRect(100, 50, 800, 450);
    display.getBoundingClientRect = () => new DOMRect(180, 390, 640, 48);
    cue.getBoundingClientRect = () => new DOMRect(180, 390, 640, 48);

    const track = await new ProfileDomSubtitleAdapter(
      builtInSiteProfile("tver"),
      false,
    ).collect();

    expect(track?.cues).toEqual([
      expect.objectContaining({
        startMs: 6_000,
        originalText: "TVer spoken subtitle.",
      }),
    ]);
  });

  it("turns a saved selector into a live subtitle track", async () => {
    document.body.innerHTML =
      '<video></video><div id="captions">First profile cue.</div>';
    const video = document.querySelector("video");
    const captions = document.querySelector<HTMLElement>("#captions");
    if (!video || !captions) throw new Error("missing video fixture");
    Object.defineProperty(video, "currentTime", { value: 4, writable: true });
    setVisibleGeometry(video, captions);
    const adapter = new ProfileDomSubtitleAdapter(PROFILE);
    const listener = vi.fn<(track: SubtitleTrack) => void>();

    const stop = adapter.subscribe(listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({
      source: "dom",
      completeness: "stream",
      cues: [
        expect.objectContaining({
          startMs: 4_000,
          originalText: "First profile cue.",
        }),
      ],
    });

    captions.textContent = "Second profile cue.";
    await vi.waitFor(() =>
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({
        cues: [
          expect.objectContaining({ originalText: "First profile cue." }),
          expect.objectContaining({ originalText: "Second profile cue." }),
        ],
      }),
    );
    stop();
  });

  it("keeps an hours-long DOM subtitle stream bounded to recent cues", async () => {
    document.body.innerHTML =
      '<video></video><div id="captions">Initial cue.</div>';
    const video = document.querySelector("video");
    const captions = document.querySelector<HTMLElement>("#captions");
    if (!video || !captions) throw new Error("missing stream fixture");
    Object.defineProperty(video, "currentTime", { value: 0, writable: true });
    setVisibleGeometry(video, captions);
    const adapter = new ProfileDomSubtitleAdapter(PROFILE, false);
    let track: SubtitleTrack | null = null;

    for (let index = 0; index < MAX_LIVE_STREAM_CUES + 5; index += 1) {
      video.currentTime = index;
      captions.textContent = `Cue ${index}`;
      track = await adapter.collect();
    }

    expect(track?.cues).toHaveLength(MAX_LIVE_STREAM_CUES);
    expect(track?.cues[0]?.originalText).toBe("Cue 5");
    expect(track?.cues.at(-1)?.originalText).toBe(
      `Cue ${MAX_LIVE_STREAM_CUES + 4}`,
    );
  });

  it("uses the recently activated smaller video's caption and timeline while a larger video keeps playing", async () => {
    document.body.innerHTML = `
      <section id="recent-player"><video></video><div class="caption">Recent player caption</div></section>
      <section id="large-player"><video></video><div class="caption">Large player caption</div></section>
    `;
    const recentlyActivated = document.querySelector<HTMLVideoElement>(
      "#recent-player video",
    );
    const recentCaption = document.querySelector<HTMLElement>(
      "#recent-player .caption",
    );
    const larger = document.querySelector<HTMLVideoElement>(
      "#large-player video",
    );
    const largeCaption = document.querySelector<HTMLElement>(
      "#large-player .caption",
    );
    if (!recentlyActivated || !recentCaption || !larger || !largeCaption) {
      throw new Error("missing multi-video profile fixture");
    }
    Object.defineProperty(recentlyActivated, "paused", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(larger, "paused", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(recentlyActivated, "currentTime", {
      configurable: true,
      value: 7,
    });
    Object.defineProperty(larger, "currentTime", {
      configurable: true,
      value: 40,
    });
    recentlyActivated.getBoundingClientRect = () =>
      new DOMRect(100, 100, 640, 360);
    recentCaption.getBoundingClientRect = () => new DOMRect(180, 390, 480, 40);
    larger.getBoundingClientRect = () => new DOMRect(0, 0, 1_000, 560);
    largeCaption.getBoundingClientRect = () => new DOMRect(180, 480, 640, 40);
    const adapter = new ProfileDomSubtitleAdapter(
      {
        ...PROFILE,
        selectors: { ...PROFILE.selectors, captions: [".caption"] },
      },
      false,
    );
    adapter.setPreferredVideo(recentlyActivated);

    await expect(adapter.collect()).resolves.toMatchObject({
      source: "dom",
      cues: [
        {
          startMs: 7_000,
          endMs: null,
          originalText: "Recent player caption",
        },
      ],
    });
  });

  it("waits for a fresh caption mutation after switching players", async () => {
    document.body.innerHTML = `
      <video id="first"></video>
      <video id="second"></video>
      <div id="captions">Old player subtitle</div>
    `;
    const first = document.querySelector<HTMLVideoElement>("#first");
    const second = document.querySelector<HTMLVideoElement>("#second");
    const captions = document.querySelector<HTMLElement>("#captions");
    if (!first || !second || !captions)
      throw new Error("missing switch fixture");
    let active = first;
    first.getBoundingClientRect = () =>
      active === first
        ? new DOMRect(0, 0, 800, 450)
        : new DOMRect(900, 0, 320, 180);
    second.getBoundingClientRect = () =>
      active === second
        ? new DOMRect(0, 0, 800, 450)
        : new DOMRect(900, 0, 320, 180);
    captions.getBoundingClientRect = () => new DOMRect(120, 380, 560, 40);
    Object.defineProperty(first, "currentTime", {
      configurable: true,
      value: 5,
    });
    Object.defineProperty(second, "currentTime", {
      configurable: true,
      value: 20,
    });
    const adapter = new ProfileDomSubtitleAdapter(PROFILE);
    const listener = vi.fn<(track: SubtitleTrack) => void>();
    adapter.setPreferredVideo(first);
    const stop = adapter.subscribe(listener);

    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(listener.mock.calls.at(-1)?.[0].cues.at(-1)?.originalText).toBe(
      "Old player subtitle",
    );
    listener.mockClear();
    active = second;
    adapter.setPreferredVideo(second);
    second.dispatchEvent(new Event("play"));
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    expect(listener).not.toHaveBeenCalled();
    await expect(adapter.collect()).resolves.toBeNull();

    captions.textContent = "Fresh second player subtitle";
    await vi.waitFor(() =>
      expect(listener.mock.calls.at(-1)?.[0]).toMatchObject({
        cues: [
          expect.objectContaining({
            startMs: 20_000,
            originalText: "Fresh second player subtitle",
          }),
        ],
      }),
    );
    stop();
  });

  it("keeps cue identities unique after seeking backward", async () => {
    document.body.innerHTML =
      '<video></video><div id="captions">First profile cue.</div>';
    const video = document.querySelector("video");
    const captions = document.querySelector("#captions");
    if (!video || !captions) throw new Error("missing profile fixture");
    Object.defineProperty(video, "currentTime", { value: 2, writable: true });
    setVisibleGeometry(video, captions as HTMLElement);
    const adapter = new ProfileDomSubtitleAdapter(PROFILE);
    const listener = vi.fn<(track: SubtitleTrack) => void>();

    const stop = adapter.subscribe(listener);
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    const firstId = listener.mock.calls.at(-1)?.[0].cues.at(-1)?.id;

    video.currentTime = 10;
    captions.textContent = "Second profile cue.";
    await vi.waitFor(() =>
      expect(listener.mock.calls.at(-1)?.[0].cues.at(-1)?.startMs).toBe(10_000),
    );

    video.currentTime = 2;
    captions.textContent = "First profile cue.";
    await vi.waitFor(() =>
      expect(listener.mock.calls.at(-1)?.[0].cues.at(-1)?.startMs).toBe(2_000),
    );
    const replayedId = listener.mock.calls.at(-1)?.[0].cues.at(-1)?.id;
    expect(replayedId).not.toBe(firstId);
    stop();
  });

  it("ignores zero-size history and keeps a later visible caption", async () => {
    document.body.innerHTML = `<video></video>${Array.from(
      { length: 51 },
      (_, index) => `<div class="caption">Old caption ${index + 1}</div>`,
    ).join("")}<div class="caption" id="current">Current caption.</div>`;
    const video = document.querySelector("video");
    const current = document.querySelector<HTMLElement>("#current");
    if (!video || !current) throw new Error("missing history fixture");
    Object.defineProperty(video, "currentTime", { value: 8, writable: true });
    setVisibleGeometry(video, current);
    const profile: SubtitleSiteProfile = {
      ...PROFILE,
      selectors: { ...PROFILE.selectors, captions: [".caption"] },
    };

    const track = await new ProfileDomSubtitleAdapter(profile, false).collect();

    expect(track?.cues).toEqual([
      expect.objectContaining({
        startMs: 8_000,
        originalText: "Current caption.",
      }),
    ]);
  });

  it("starts a fresh stream when a hash-router episode changes", async () => {
    const originalUrl = location.href;
    history.replaceState({}, "", "/watch#/episode-one");
    document.body.innerHTML =
      '<video></video><div id="captions">Episode one cue.</div>';
    const video = document.querySelector("video");
    const captions = document.querySelector<HTMLElement>("#captions");
    if (!video || !captions) throw new Error("missing hash route fixture");
    Object.defineProperty(video, "currentTime", { value: 4, writable: true });
    setVisibleGeometry(video, captions);
    const adapter = new ProfileDomSubtitleAdapter(PROFILE);
    const listener = vi.fn<(track: SubtitleTrack) => void>();
    const invalidated = vi.fn();
    const stopInvalidation = adapter.subscribeInvalidation(invalidated);
    const stop = adapter.subscribe(listener);

    try {
      await vi.waitFor(() => expect(listener).toHaveBeenCalled());
      video.currentTime = 8;
      history.replaceState({}, "", "/watch#/episode-two");
      captions.textContent = "Episode two cue.";

      await vi.waitFor(() =>
        expect(listener.mock.calls.at(-1)?.[0].cues).toEqual([
          expect.objectContaining({
            startMs: 8_000,
            originalText: "Episode two cue.",
          }),
        ]),
      );
      expect(invalidated).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      stopInvalidation();
      history.replaceState({}, "", originalUrl);
    }
  });

  it("keeps the stream across ordinary anchor changes", async () => {
    const originalUrl = location.href;
    history.replaceState({}, "", "/watch#details");
    document.body.innerHTML =
      '<video></video><div id="captions">First anchor cue.</div>';
    const video = document.querySelector("video");
    const captions = document.querySelector<HTMLElement>("#captions");
    if (!video || !captions) throw new Error("missing anchor fixture");
    Object.defineProperty(video, "currentTime", { value: 4, writable: true });
    setVisibleGeometry(video, captions);
    const adapter = new ProfileDomSubtitleAdapter(PROFILE);
    const listener = vi.fn<(track: SubtitleTrack) => void>();
    const invalidated = vi.fn();
    const stopInvalidation = adapter.subscribeInvalidation(invalidated);
    const stop = adapter.subscribe(listener);

    try {
      await vi.waitFor(() => expect(listener).toHaveBeenCalled());
      video.currentTime = 8;
      history.replaceState({}, "", "/watch#comments");
      captions.textContent = "Second anchor cue.";

      await vi.waitFor(() =>
        expect(listener.mock.calls.at(-1)?.[0].cues).toEqual([
          expect.objectContaining({ originalText: "First anchor cue." }),
          expect.objectContaining({ originalText: "Second anchor cue." }),
        ]),
      );
      expect(invalidated).not.toHaveBeenCalled();
    } finally {
      stop();
      stopInvalidation();
      history.replaceState({}, "", originalUrl);
    }
  });
});
