import { SUBTITLE_CAPTURE_EVENT } from "@/src/subtitles/adapters/captured";
import { NetflixSubtitleAdapter } from "@/src/subtitles/adapters/netflix";
import { Html5TextTrackAdapter } from "@/src/subtitles/adapters/html5";
import { ProfileDomSubtitleAdapter } from "@/src/subtitles/adapters/profile-dom";
import { MAX_LIVE_STREAM_CUES } from "@/src/subtitles/adapters/types";
import { YouTubeTimedTextAdapter } from "@/src/subtitles/adapters/youtube";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import type { SubtitleTrack } from "@/src/subtitles/types";
import { stableVideoCaptureScope } from "@/src/subtitles/video-selection";
import { describe, expect, it, vi } from "vitest";

function captureIdentity(): { mediaScope: string; videoCount: number } {
  const videos = Array.from(
    document.querySelectorAll<HTMLVideoElement>("video"),
  );
  return {
    mediaScope: stableVideoCaptureScope(videos[0] ?? null),
    videoCount: videos.length,
  };
}

const COMPLETE_RESPONSE_EVIDENCE = {
  partial: false,
  requestRange: false,
  responseStatus: 200,
} as const;

describe("video subtitle adapters", () => {
  it("rejects a captured subtitle payload with an invalid partial marker", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            ...captureIdentity(),
            partial: "yes",
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: "Invalid marker" }],
                },
              ],
            },
          },
        }),
      );
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("rejects a network capture without an explicit single-player identity", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: "Unscoped subtitle" }],
                },
              ],
            },
          },
        }),
      );
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("keeps a loading TextTrack streaming and reacts to short cue changes", async () => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    const trackElement = document.createElement("track");
    video.append(trackElement);
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 120,
    });
    video.getBoundingClientRect = () => new DOMRect(0, 0, 800, 450);
    const track = new EventTarget() as EventTarget &
      Pick<TextTrack, "kind" | "language" | "mode" | "cues">;
    Object.assign(track, {
      kind: "subtitles",
      language: "en",
      mode: "showing",
      cues: {
        0: {
          text: "Short live cue",
          startTime: 1,
          endTime: 1.5,
        },
        length: 1,
      },
    });
    const trackList = new EventTarget() as EventTarget & {
      0: TextTrack;
      length: number;
    };
    trackList[0] = track as TextTrack;
    trackList.length = 1;
    Object.defineProperty(video, "textTracks", {
      configurable: true,
      value: trackList,
    });
    Object.defineProperty(trackElement, "track", {
      configurable: true,
      value: track,
    });
    Object.defineProperty(trackElement, "readyState", {
      configurable: true,
      value: 1,
    });
    document.body.append(video);
    const adapter = new Html5TextTrackAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      await vi.advanceTimersByTimeAsync(40);
      expect(await adapter.collect()).toMatchObject({
        source: "texttrack",
        completeness: "stream",
        cues: [{ originalText: "Short live cue" }],
      });
      listener.mockClear();
      track.dispatchEvent(new Event("cuechange"));
      await vi.advanceTimersByTimeAsync(40);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          completeness: "stream",
          cues: [expect.objectContaining({ originalText: "Short live cue" })],
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("rejects an ambiguous network track captured with multiple players", () => {
    const active = document.createElement("video");
    const secondary = document.createElement("video");
    active.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540);
    secondary.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    document.body.append(active, secondary);
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            mediaScope: stableVideoCaptureScope(active),
            videoCount: 2,
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: "Ambiguous subtitle" }],
                },
              ],
            },
          },
        }),
      );
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it.each([
    ["YouTube", ".ytp-caption-segment"],
    ["Netflix", ".player-timedtext"],
  ] as const)(
    "keeps the %s DOM fallback on the recently activated smaller video",
    (site, captionSelector) => {
      const captionClass = captionSelector.slice(1);
      document.body.innerHTML = `
        <section id="recent-player"><video></video><div class="${captionClass}">Recent ${site} caption</div></section>
        <section id="large-player"><video></video><div class="${captionClass}">Large ${site} caption</div></section>
      `;
      const recentlyActivated = document.querySelector<HTMLVideoElement>(
        "#recent-player video",
      );
      const larger = document.querySelector<HTMLVideoElement>(
        "#large-player video",
      );
      if (!recentlyActivated || !larger) {
        throw new Error("invalid multi-video site adapter fixture");
      }
      Object.defineProperty(recentlyActivated, "paused", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(larger, "paused", {
        configurable: true,
        value: false,
      });
      recentlyActivated.currentTime = 7;
      larger.currentTime = 40;
      recentlyActivated.getBoundingClientRect = () =>
        new DOMRect(100, 100, 640, 360);
      larger.getBoundingClientRect = () => new DOMRect(0, 0, 1_000, 560);
      const adapter =
        site === "YouTube"
          ? new YouTubeTimedTextAdapter()
          : new NetflixSubtitleAdapter();
      adapter.setPreferredVideo(recentlyActivated);
      const tracks: SubtitleTrack[] = [];
      const unsubscribe = adapter.subscribe((track) => tracks.push(track));
      try {
        expect(tracks.at(-1)).toMatchObject({
          source: "dom",
          cues: [
            {
              startMs: 7_000,
              originalText: `Recent ${site} caption`,
            },
          ],
        });
      } finally {
        unsubscribe();
        document.body.replaceChildren();
      }
    },
  );

  it("parses captured YouTube json3 without depending on cue array positions", () => {
    const adapter = new YouTubeTimedTextAdapter();
    let received: SubtitleTrack | null = null;
    const unsubscribe = adapter.subscribe((track) => {
      received = track;
    });

    window.dispatchEvent(
      new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
        detail: {
          site: "youtube",
          pageUrl: location.href,
          url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en-US",
          ...captureIdentity(),
          ...COMPLETE_RESPONSE_EVIDENCE,
          contentType: "application/json",
          body: {
            events: [
              { tStartMs: 500, dDurationMs: 1_000, segs: [{ utf8: "Hello" }] },
              { tStartMs: 1_500, dDurationMs: 800, segs: [{ utf8: "world" }] },
            ],
          },
        },
      }),
    );

    expect(received).toMatchObject({
      source: "youtube-timedtext",
      completeness: "full",
      language: "en-US",
      cues: [
        { startMs: 500, endMs: 1_500, originalText: "Hello" },
        { startMs: 1_500, endMs: 2_300, originalText: "world" },
      ],
    });
    unsubscribe();
  });

  it("keeps a partial YouTube response streaming without URL range markers", () => {
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            ...captureIdentity(),
            partial: true,
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: "Partial response" }],
                },
              ],
            },
          },
        }),
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ completeness: "stream" }),
      );
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ["HTTP 206", { partial: false, requestRange: false, responseStatus: 206 }],
    [
      "request Range",
      { partial: false, requestRange: true, responseStatus: 200 },
    ],
    [
      "Content-Range",
      {
        partial: false,
        requestRange: false,
        responseStatus: 200,
        contentRange: "bytes 0-99/400",
      },
    ],
  ])(
    "keeps a YouTube response with %s evidence streaming",
    (_label, evidence) => {
      const adapter = new YouTubeTimedTextAdapter();
      const listener = vi.fn();
      const unsubscribe = adapter.subscribe(listener);
      try {
        window.dispatchEvent(
          new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
            detail: {
              site: "youtube",
              pageUrl: location.href,
              url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
              ...captureIdentity(),
              ...evidence,
              body: {
                events: [
                  {
                    tStartMs: 0,
                    dDurationMs: 1_000,
                    segs: [{ utf8: "Partial by transport evidence" }],
                  },
                ],
              },
            },
          }),
        );
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ completeness: "stream" }),
        );
      } finally {
        unsubscribe();
      }
    },
  );

  it("keeps an unknown YouTube response streaming", () => {
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            ...captureIdentity(),
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: "Unknown completeness" }],
                },
              ],
            },
          },
        }),
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          completeness: "stream",
          captureEvidence: "unknown",
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("keeps repeatedly growing canonical YouTube responses as a full track", async () => {
    const adapter = new YouTubeTimedTextAdapter();
    const tracks: SubtitleTrack[] = [];
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    const dispatchCues = (texts: string[]): void => {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            body: {
              events: texts.map((text, index) => ({
                tStartMs: index * 1_000,
                dDurationMs: 1_000,
                segs: [{ utf8: text }],
              })),
            },
          },
        }),
      );
    };
    try {
      dispatchCues(["First snapshot"]);
      expect(tracks.at(-1)).toMatchObject({ completeness: "full" });
      dispatchCues(["First snapshot", "Later snapshot"]);
      expect(tracks.at(-1)).toMatchObject({
        completeness: "full",
        captureEvidence: "verified-full-response",
        cues: [
          { originalText: "First snapshot" },
          { originalText: "Later snapshot" },
        ],
      });
      expect(await adapter.collect()).toMatchObject({
        completeness: "full",
        cues: [
          { originalText: "First snapshot" },
          { originalText: "Later snapshot" },
        ],
      });
    } finally {
      unsubscribe();
    }
  });

  it("does not merge manual and automatic YouTube stream variants", async () => {
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    const dispatchSegment = (kind: string, text: string): void => {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: `https://www.youtube.com/api/timedtext?fmt=json3&lang=en&kind=${kind}&seq=1`,
            ...captureIdentity(),
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: text }],
                },
              ],
            },
          },
        }),
      );
    };
    try {
      dispatchSegment("standard", "Manual caption");
      dispatchSegment("asr", "Automatic caption");

      expect(await adapter.collect()).toMatchObject({
        completeness: "stream",
        cues: [{ originalText: "Automatic caption" }],
      });
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it("drops a captured YouTube track after SPA video navigation", async () => {
    const originalUrl = location.href;
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe(() => undefined);
    window.dispatchEvent(
      new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
        detail: {
          site: "youtube",
          pageUrl: location.href,
          url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
          ...captureIdentity(),
          ...COMPLETE_RESPONSE_EVIDENCE,
          body: {
            events: [
              {
                tStartMs: 0,
                dDurationMs: 1_000,
                segs: [{ utf8: "Old video" }],
              },
            ],
          },
        },
      }),
    );
    expect(await adapter.collect()).not.toBeNull();

    try {
      history.pushState({}, "", "/watch?v=next-video");
      expect(await adapter.collect()).toBeNull();
    } finally {
      history.replaceState({}, "", originalUrl);
      unsubscribe();
    }
  });

  it("rejects a subtitle response that finishes after page navigation", () => {
    const originalUrl = location.href;
    const oldPageUrl = location.href;
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      history.pushState({}, "", "/watch?v=new-video");
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: oldPageUrl,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: "Stale response" }],
                },
              ],
            },
          },
        }),
      );
      expect(listener).not.toHaveBeenCalled();
    } finally {
      history.replaceState({}, "", originalUrl);
      unsubscribe();
    }
  });

  it("uses YouTube rendered captions as a stream fallback", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<video></video><div class="ytp-caption-segment">First caption</div>';
    const video = document.querySelector("video");
    const caption = document.querySelector<HTMLElement>(".ytp-caption-segment");
    if (!video || !caption) throw new Error("invalid YouTube fixture");
    video.currentTime = 8;
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      expect(tracks.at(-1)).toMatchObject({
        source: "dom",
        completeness: "stream",
        cues: [{ startMs: 8_000, originalText: "First caption" }],
      });

      video.currentTime = 10;
      caption.textContent = "Second caption";
      await vi.advanceTimersByTimeAsync(70);
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 8_000, endMs: 10_000, originalText: "First caption" },
        { startMs: 10_000, originalText: "Second caption" },
      ]);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it.each([
    ["YouTube", ".ytp-caption-segment", () => new YouTubeTimedTextAdapter()],
    ["Netflix", ".player-timedtext", () => new NetflixSubtitleAdapter()],
  ] as const)(
    "keeps an hours-long %s DOM fallback bounded in cue order",
    async (_site, captionSelector, createAdapter) => {
      vi.useFakeTimers();
      const captionClass = captionSelector.slice(1);
      document.body.innerHTML = `<video></video><div class="${captionClass}">Cue 0</div>`;
      const video = document.querySelector("video");
      const caption = document.querySelector<HTMLElement>(captionSelector);
      if (!video || !caption) throw new Error("invalid bounded DOM fixture");
      video.currentTime = 0;
      const tracks: SubtitleTrack[] = [];
      const adapter = createAdapter();
      const unsubscribe = adapter.subscribe?.((track) => tracks.push(track));

      try {
        for (let index = 1; index < MAX_LIVE_STREAM_CUES + 5; index += 1) {
          video.currentTime = index;
          caption.textContent = `Cue ${index}`;
          await vi.advanceTimersByTimeAsync(90);
        }

        const cues = tracks.at(-1)?.cues ?? [];
        expect(cues).toHaveLength(MAX_LIVE_STREAM_CUES);
        expect(cues[0]).toMatchObject({
          startMs: 5_000,
          originalText: "Cue 5",
        });
        expect(cues.at(-1)).toMatchObject({
          startMs: (MAX_LIVE_STREAM_CUES + 4) * 1_000,
          endMs: null,
          originalText: `Cue ${MAX_LIVE_STREAM_CUES + 4}`,
        });
        expect(cues.map(({ startMs }) => startMs)).toEqual(
          [...cues].map(({ startMs }) => startMs).sort((a, b) => a - b),
        );
        expect(new Set(cues.map(({ id }) => id)).size).toBe(cues.length);
      } finally {
        unsubscribe?.();
        document.body.replaceChildren();
        vi.useRealTimers();
      }
    },
  );

  it("only reads YouTube DOM captions owned by the active player", () => {
    document.body.innerHTML = `
      <div class="secondary-player">
        <video></video>
        <div class="ytp-caption-segment">Secondary caption</div>
      </div>
      <div class="main-player">
        <video></video>
        <div class="ytp-caption-segment">Main caption</div>
      </div>
    `;
    const videos = Array.from(document.querySelectorAll("video"));
    const [secondary, main] = videos;
    if (!secondary || !main) throw new Error("invalid multi-player fixture");
    secondary.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 320, height: 180 });
    main.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 100, y: 100, width: 960, height: 540 });
    Object.defineProperty(main, "paused", { configurable: true, value: false });
    main.currentTime = 12;
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 12_000, originalText: "Main caption" },
      ]);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("resets YouTube DOM history when the active video source changes", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<video src="https://media.example/old.mp4"></video><div class="ytp-caption-segment">Same caption</div>';
    const video = document.querySelector("video");
    const caption = document.querySelector<HTMLElement>(".ytp-caption-segment");
    if (!video || !caption) throw new Error("invalid YouTube source fixture");
    video.currentTime = 8;
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      const firstCueId = tracks.at(-1)?.cues[0]?.id;
      video.src = "https://media.example/new.mp4";
      video.currentTime = 1;
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(70);

      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 1_000, originalText: "Same caption" },
      ]);
      expect(tracks.at(-1)?.cues[0]?.id).not.toBe(firstCueId);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("resets YouTube DOM history when another video becomes active", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div class="first-player">
        <video src="https://media.example/shared.mp4"></video>
        <div class="ytp-caption-segment">First player caption</div>
      </div>
      <div class="second-player">
        <video src="https://media.example/shared.mp4"></video>
        <div class="ytp-caption-segment">Second player caption</div>
      </div>
    `;
    const [first, second] = Array.from(document.querySelectorAll("video"));
    if (!first || !second) throw new Error("invalid active-video fixture");
    first.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 450 });
    second.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 450 });
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
    first.currentTime = 6;
    second.currentTime = 2;
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      const firstCueId = tracks.at(-1)?.cues[0]?.id;
      Object.defineProperty(first, "paused", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(second, "paused", {
        configurable: true,
        value: false,
      });
      second.dispatchEvent(new Event("play", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(70);

      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 2_000, originalText: "Second player caption" },
      ]);
      expect(tracks.at(-1)?.cues[0]?.id).not.toBe(firstCueId);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("restarts an unchanged YouTube caption after seeking", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<video></video><div class="ytp-caption-segment">Same caption</div>';
    const video = document.querySelector("video");
    if (!video) throw new Error("invalid YouTube seek fixture");
    video.currentTime = 10;
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      const firstCueId = tracks.at(-1)?.cues[0]?.id;
      video.currentTime = 2;
      video.dispatchEvent(new Event("seeking", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(70);

      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 2_000, originalText: "Same caption" },
      ]);
      expect(tracks.at(-1)?.cues[0]?.id).not.toBe(firstCueId);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("ends a YouTube DOM cue when the site hides it by attribute", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<video></video><div class="ytp-caption-segment">Visible caption</div>';
    const video = document.querySelector("video");
    const caption = document.querySelector<HTMLElement>(".ytp-caption-segment");
    if (!video || !caption) throw new Error("invalid YouTube fixture");
    video.currentTime = 8;
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      video.currentTime = 9;
      caption.setAttribute("aria-hidden", "true");
      await vi.advanceTimersByTimeAsync(70);
      expect(tracks.at(-1)?.cues.at(-1)).toMatchObject({
        originalText: "Visible caption",
        endMs: 9_000,
      });
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("keeps collecting a cue hidden only by NorixorTrans", () => {
    const style = document.createElement("style");
    style.textContent = `
      :root[data-norixortrans-hide-native-subtitles] .ytp-caption-segment {
        visibility: hidden !important;
      }
    `;
    document.head.append(style);
    document.documentElement.setAttribute(
      "data-norixortrans-hide-native-subtitles",
      "",
    );
    document.body.innerHTML =
      '<video></video><div class="ytp-caption-segment">Hidden presentation, readable cue</div>';
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      expect(tracks.at(-1)).toMatchObject({
        source: "dom",
        completeness: "stream",
        cues: [{ originalText: "Hidden presentation, readable cue" }],
      });
      expect(
        getComputedStyle(
          document.querySelector<HTMLElement>(".ytp-caption-segment")!,
        ).visibility,
      ).toBe("hidden");
    } finally {
      unsubscribe();
      document.documentElement.removeAttribute(
        "data-norixortrans-hide-native-subtitles",
      );
      style.remove();
      document.body.replaceChildren();
    }
  });

  it("does not reuse a YouTube DOM cue ID after seeking backward", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<video></video><div class="ytp-caption-segment">First at two</div>';
    const video = document.querySelector("video");
    const caption = document.querySelector<HTMLElement>(".ytp-caption-segment");
    if (!video || !caption) throw new Error("invalid YouTube fixture");
    video.currentTime = 2;
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      const firstCueId = tracks.at(-1)?.cues[0]?.id;
      video.currentTime = 10;
      caption.textContent = "Later at ten";
      await vi.advanceTimersByTimeAsync(70);
      video.currentTime = 2;
      caption.textContent = "Different after seek";
      await vi.advanceTimersByTimeAsync(70);

      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 2_000, originalText: "Different after seek" },
      ]);
      expect(tracks.at(-1)?.cues[0]?.id).not.toBe(firstCueId);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("keeps a full YouTube track ahead of the rendered-caption fallback", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<video></video>";
    const listener = vi.fn();
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: "Complete track" }],
                },
              ],
            },
          },
        }),
      );
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: "youtube-timedtext",
          completeness: "full",
        }),
      );
      listener.mockClear();

      const caption = document.createElement("div");
      caption.className = "ytp-caption-segment";
      caption.textContent = "Rendered fallback";
      document.body.append(caption);
      await vi.advanceTimersByTimeAsync(70);

      expect(listener).not.toHaveBeenCalled();
      expect(await adapter.collect()).toMatchObject({
        source: "youtube-timedtext",
        completeness: "full",
      });
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("keeps YouTube DOM fallback active after an empty full-track response", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<video></video>";
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            ...captureIdentity(),
            body: { events: [] },
          },
        }),
      );
      expect(await adapter.collect()).toBeNull();

      const caption = document.createElement("div");
      caption.className = "ytp-caption-segment";
      caption.textContent = "Rendered after empty response";
      document.body.append(caption);
      await vi.advanceTimersByTimeAsync(70);

      expect(tracks.at(-1)).toMatchObject({
        source: "dom",
        completeness: "stream",
        cues: [{ originalText: "Rendered after empty response" }],
      });
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("keeps segmented YouTube timedtext as a stream instead of a full track", () => {
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    window.dispatchEvent(
      new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
        detail: {
          site: "youtube",
          pageUrl: location.href,
          url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en&seq=12",
          ...captureIdentity(),
          body: {
            events: [
              {
                tStartMs: 12_000,
                dDurationMs: 1_000,
                segs: [{ utf8: "Live segment" }],
              },
            ],
          },
        },
      }),
    );

    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: "youtube-timedtext",
        completeness: "stream",
      }),
    );
    unsubscribe();
  });

  it("accumulates, sorts, and deduplicates segmented YouTube captures", async () => {
    const adapter = new YouTubeTimedTextAdapter();
    const tracks: SubtitleTrack[] = [];
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    const dispatchSegment = (startMs: number, text: string): void => {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: `https://www.youtube.com/api/timedtext?fmt=json3&lang=en&segment=${startMs}`,
            ...captureIdentity(),
            body: {
              events: [
                {
                  tStartMs: startMs,
                  dDurationMs: 1_000,
                  segs: [{ utf8: text }],
                },
              ],
            },
          },
        }),
      );
    };
    try {
      dispatchSegment(10_000, "Second segment");
      dispatchSegment(0, "First segment");
      dispatchSegment(10_000, "Second segment");

      expect(tracks.at(-1)).toMatchObject({
        completeness: "stream",
        cues: [
          { startMs: 0, originalText: "First segment" },
          { startMs: 10_000, originalText: "Second segment" },
        ],
      });
      const latest = await adapter.collect();
      expect(latest?.cues).toHaveLength(2);
      expect(new Set(latest?.cues.map((cue) => cue.id)).size).toBe(2);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    "start",
    "end",
    "offset",
    "chunk",
    "segment",
    "seq",
    "sq",
    "range",
    "continuation",
    "live",
  ])(
    "classifies YouTube timedtext with %s range semantics as streaming",
    (rangeParameter) => {
      const adapter = new YouTubeTimedTextAdapter();
      const listener = vi.fn();
      const unsubscribe = adapter.subscribe(listener);
      try {
        window.dispatchEvent(
          new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
            detail: {
              site: "youtube",
              pageUrl: location.href,
              url: `https://www.youtube.com/api/timedtext?fmt=json3&lang=en&${rangeParameter}=1`,
              ...captureIdentity(),
              body: {
                events: [
                  {
                    tStartMs: 1_000,
                    dDurationMs: 1_000,
                    segs: [{ utf8: `${rangeParameter} segment` }],
                  },
                ],
              },
            },
          }),
        );
        expect(listener).toHaveBeenLastCalledWith(
          expect.objectContaining({ completeness: "stream" }),
        );
      } finally {
        unsubscribe();
      }
    },
  );

  it("resets segmented YouTube captures when the media source changes", async () => {
    const video = document.createElement("video");
    video.src = "https://media.example/first.mp4";
    document.body.append(video);
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe(() => undefined);
    const dispatchSegment = (
      text: string,
      mediaScope = stableVideoCaptureScope(video),
    ): void => {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en&seq=1",
            mediaScope,
            videoCount: 1,
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: text }],
                },
              ],
            },
          },
        }),
      );
    };
    try {
      const firstMediaScope = stableVideoCaptureScope(video);
      dispatchSegment("First media");
      video.src = "https://media.example/second.mp4";
      dispatchSegment("Second media");
      dispatchSegment("Late first media", firstMediaScope);

      expect(await adapter.collect()).toMatchObject({
        completeness: "stream",
        cues: [{ originalText: "Second media" }],
      });
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("resets segmented YouTube captures when the caption track changes", async () => {
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe(() => undefined);
    const dispatchSegment = (language: string, text: string): void => {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: `https://www.youtube.com/api/timedtext?fmt=json3&lang=${language}&seq=1`,
            ...captureIdentity(),
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: text }],
                },
              ],
            },
          },
        }),
      );
    };
    try {
      dispatchSegment("en", "English track");
      dispatchSegment("fr", "Piste française");

      expect(await adapter.collect()).toMatchObject({
        language: "fr",
        cues: [{ originalText: "Piste française" }],
      });
    } finally {
      unsubscribe();
    }
  });

  it("keeps signed Netflix CDN root TTML captures streaming", () => {
    const adapter = new NetflixSubtitleAdapter();
    let received: SubtitleTrack | null = null;
    const unsubscribe = adapter.subscribe((track) => {
      received = track;
    });

    window.dispatchEvent(
      new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
        detail: {
          site: "netflix",
          pageUrl: location.href,
          url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&e=3",
          ...captureIdentity(),
          contentType: "application/ttml+xml",
          body: '<tt xml:lang="zh-CN"><body><div><p begin="1s" end="2.5s">测试字幕</p></div></body></tt>',
        },
      }),
    );

    expect(received).toMatchObject({
      source: "netflix-manifest",
      completeness: "stream",
      language: "zh-CN",
      cues: [{ startMs: 1_000, endMs: 2_500, originalText: "测试字幕" }],
    });
    unsubscribe();
  });

  it("promotes a complete signed Netflix document declared by manifest metadata", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&e=3",
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            manifestCandidate: true,
            contentType: "application/ttml+xml",
            body: '<tt xml:lang="en"><body><div><p begin="1s" end="2.5s">Complete manifest subtitle</p></div></body></tt>',
          },
        }),
      );

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "netflix-manifest",
          completeness: "full",
          captureEvidence: "verified-full-response",
          language: "en",
          cues: [
            expect.objectContaining({
              originalText: "Complete manifest subtitle",
            }),
          ],
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("keeps a manifest-declared full Netflix track when a passive window arrives later", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    const url = "https://ipv4-c001.nflxvideo.net/?o=1&v=2&e=3";
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url,
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            manifestCandidate: true,
            language: "en",
            contentType: "application/ttml+xml",
            body: '<tt xml:lang="en"><body><div><p begin="0s" end="1s">Manifest first</p><p begin="1s" end="2s">Manifest second</p></div></body></tt>',
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url,
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            language: "en",
            contentType: "application/ttml+xml",
            body: '<tt xml:lang="en"><body><div><p begin="1s" end="2s">Passive playback window</p></div></body></tt>',
          },
        }),
      );

      expect(listener).toHaveBeenCalledOnce();
      expect(await adapter.collect()).toMatchObject({
        completeness: "full",
        captureEvidence: "verified-full-response",
        cues: [
          expect.objectContaining({ originalText: "Manifest first" }),
          expect.objectContaining({ originalText: "Manifest second" }),
        ],
      });
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("lets a manifest-declared Netflix document replace an earlier playback window", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    const url = "https://ipv4-c001.nflxvideo.net/?o=1&v=2&e=3";
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url,
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            contentType: "application/ttml+xml",
            body: '<tt xml:lang="en"><body><div><p begin="0s" end="1s">Playback window</p></div></body></tt>',
          },
        }),
      );
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url,
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            manifestCandidate: true,
            language: "en",
            contentType: "application/ttml+xml",
            body: '<tt xml:lang="en"><body><div><p begin="0s" end="1s">Playback window</p><p begin="1s" end="2s">Manifest continuation</p></div></body></tt>',
          },
        }),
      );

      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          completeness: "full",
          captureEvidence: "verified-full-response",
          cues: [
            expect.objectContaining({ originalText: "Playback window" }),
            expect.objectContaining({ originalText: "Manifest continuation" }),
          ],
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("uses Netflix manifest language metadata when the signed URL has no language", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    adapter.setSourceLanguage("en");
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&e=3",
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            manifestCandidate: true,
            language: "en-US",
            contentType: "text/vtt",
            body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nManifest language",
          },
        }),
      );

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          completeness: "full",
          language: "en-US",
          cues: [
            expect.objectContaining({ originalText: "Manifest language" }),
          ],
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("applies Netflix WebVTT X-TIMESTAMP-MAP offsets", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&e=3",
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            manifestCandidate: true,
            language: "en-US",
            contentType: "text/vtt",
            body: [
              "WEBVTT",
              "X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000",
              "",
              "00:00:00.000 --> 00:00:01.000",
              "Mapped Netflix subtitle",
            ].join("\n"),
          },
        }),
      );

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          completeness: "full",
          cues: [
            expect.objectContaining({
              startMs: 10_000,
              endMs: 11_000,
              originalText: "Mapped Netflix subtitle",
            }),
          ],
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("binds a streaming Netflix bootstrap TTML response requested before video mount", () => {
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    const video = document.createElement("video");
    document.body.append(video);

    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&e=3&t=bootstrap",
            mediaScope: "video:none",
            videoCount: 0,
            contentType: "text/xml",
            body: '<tt xml:lang="en"><body><div><p begin="1s" end="2s">Bootstrap subtitle</p></div></body></tt>',
          },
        }),
      );

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "netflix-manifest",
          completeness: "stream",
          language: "en",
          cues: [
            expect.objectContaining({ originalText: "Bootstrap subtitle" }),
          ],
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("uses an explicit Netflix timed-text endpoint as a full track", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://www.netflix.com/timedtexttracks?id=complete",
            mediaScope: stableVideoCaptureScope(video),
            videoCount: 1,
            ...COMPLETE_RESPONSE_EVIDENCE,
            contentType: "application/ttml+xml",
            body: '<tt xml:lang="en"><body><div><p begin="1s" end="2s">Complete subtitle</p></div></body></tt>',
          },
        }),
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "netflix-manifest",
          completeness: "full",
          cues: [
            expect.objectContaining({ originalText: "Complete subtitle" }),
          ],
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("does not upgrade an explicit Netflix endpoint without full-response evidence", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://www.netflix.com/timedtexttracks?id=unknown",
            mediaScope: stableVideoCaptureScope(video),
            videoCount: 1,
            contentType: "application/ttml+xml",
            body: '<tt xml:lang="en"><body><div><p begin="1s" end="2s">Unknown response</p></div></body></tt>',
          },
        }),
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          completeness: "stream",
          captureEvidence: "unknown",
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("keeps a partial explicit Netflix timed-text response streaming", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://www.netflix.com/timedtexttracks?id=partial",
            mediaScope: stableVideoCaptureScope(video),
            videoCount: 1,
            partial: true,
            body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPartial subtitle",
          },
        }),
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "netflix-manifest",
          completeness: "stream",
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("keeps non-bootstrap Netflix captures tied to their exact media scope", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);

    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://www.netflix.com/timedtexttracks?id=late&segment=1",
            mediaScope: "video:none",
            videoCount: 0,
            body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nLate segment",
          },
        }),
      );

      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("keeps segmented Netflix timed-text payloads streaming", () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://www.netflix.com/timedtexttracks?id=e2e&segment=4",
            mediaScope: stableVideoCaptureScope(video),
            videoCount: 1,
            body: "WEBVTT\n\n00:00:04.000 --> 00:00:05.000\nSegmented cue",
          },
        }),
      );
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "netflix-manifest",
          completeness: "stream",
          cues: [expect.objectContaining({ originalText: "Segmented cue" })],
        }),
      );
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("accumulates and deduplicates segmented Netflix captures", async () => {
    const video = document.createElement("video");
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const tracks: SubtitleTrack[] = [];
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    const dispatchSegment = (segment: number, body: string): void => {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: `https://www.netflix.com/timedtexttracks?id=e2e&lang=en&segment=${segment}`,
            mediaScope: stableVideoCaptureScope(video),
            videoCount: 1,
            body,
          },
        }),
      );
    };
    try {
      dispatchSegment(
        2,
        "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nSecond segment",
      );
      dispatchSegment(
        1,
        "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst segment",
      );
      dispatchSegment(
        2,
        "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nSecond segment",
      );

      expect(tracks.at(-1)).toMatchObject({
        completeness: "stream",
        cues: [
          { startMs: 1_000, originalText: "First segment" },
          { startMs: 2_000, originalText: "Second segment" },
        ],
      });
      expect((await adapter.collect())?.cues).toHaveLength(2);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("resets segmented Netflix captures when the media source changes", async () => {
    const video = document.createElement("video");
    video.src = "https://media.example/episode-one.mp4";
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const unsubscribe = adapter.subscribe(() => undefined);
    const dispatchSegment = (
      text: string,
      mediaScope = stableVideoCaptureScope(video),
    ): void => {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://www.netflix.com/timedtexttracks?id=e2e&lang=en&segment=1",
            mediaScope,
            videoCount: 1,
            body: `WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n${text}`,
          },
        }),
      );
    };
    try {
      const firstMediaScope = stableVideoCaptureScope(video);
      dispatchSegment("Episode one");
      video.src = "https://media.example/episode-two.mp4";
      dispatchSegment("Episode two");
      dispatchSegment("Late episode one", firstMediaScope);

      expect(await adapter.collect()).toMatchObject({
        completeness: "stream",
        cues: [{ originalText: "Episode two" }],
      });
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("selects the configured language from a multi-language Netflix payload", () => {
    const adapter = new NetflixSubtitleAdapter();
    adapter.setSourceLanguage?.("en");
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    window.dispatchEvent(
      new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
        detail: {
          site: "netflix",
          pageUrl: location.href,
          url: "https://www.netflix.com/timedtexttracks?id=multi-language",
          ...captureIdentity(),
          body: {
            chinese:
              '<tt xml:lang="zh-CN"><body><div><p begin="0s" end="1s">中文</p></div></body></tt>',
            english:
              '<tt xml:lang="en"><body><div><p begin="0s" end="1s">English</p></div></body></tt>',
          },
        },
      }),
    );

    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({
        language: "en",
        cues: [expect.objectContaining({ originalText: "English" })],
      }),
    );
    unsubscribe();
  });

  it("keeps Netflix DOM fallback active after an empty full-track response", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<video></video>";
    const tracks: SubtitleTrack[] = [];
    const adapter = new NetflixSubtitleAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: "https://ipv4-c001.nflxvideo.net/?o=1&v=2&e=3",
            ...captureIdentity(),
            contentType: "application/ttml+xml",
            body: "<tt><body><div></div></body></tt>",
          },
        }),
      );
      expect(await adapter.collect()).toBeNull();

      const caption = document.createElement("div");
      caption.className = "player-timedtext";
      caption.textContent = "Netflix DOM after empty response";
      document.body.append(caption);
      await vi.advanceTimersByTimeAsync(70);

      expect(tracks.at(-1)).toMatchObject({
        source: "dom",
        completeness: "stream",
        cues: [{ originalText: "Netflix DOM after empty response" }],
      });
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("does not treat Netflix video range chunks as subtitle captures", () => {
    const adapter = new NetflixSubtitleAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    window.dispatchEvent(
      new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
        detail: {
          site: "netflix",
          pageUrl: location.href,
          url: "https://ipv4-c001.nflxvideo.net/range/0-4095?o=1&v=2&e=3",
          body: '<tt><body><p begin="0s" end="1s">Forged range</p></body></tt>',
        },
      }),
    );
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("rejects malformed page events", () => {
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    window.dispatchEvent(
      new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
        detail: {
          site: "youtube",
          pageUrl: location.href,
          url: 123,
          body: { events: [] },
        },
      }),
    );
    expect(listener).not.toHaveBeenCalled();
    window.dispatchEvent(
      new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
        detail: {
          site: "youtube",
          pageUrl: location.href,
          url: "https://attacker.example/api/timedtext?fmt=json3",
          body: {
            events: [
              { tStartMs: 0, dDurationMs: 1_000, segs: [{ utf8: "Forged" }] },
            ],
          },
        },
      }),
    );
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("accepts subtitle segment bursts while bounding page-dispatched events", () => {
    const adapter = new YouTubeTimedTextAdapter();
    const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    for (let index = 0; index < 80; index += 1) {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: `https://www.youtube.com/api/timedtext?fmt=json3&lang=en&seq=${index}`,
            ...captureIdentity(),
            body: {
              events: [
                {
                  tStartMs: index * 1_000,
                  dDurationMs: 1_000,
                  segs: [{ utf8: `Captured cue ${index}` }],
                },
              ],
            },
          },
        }),
      );
    }

    expect(listener).toHaveBeenCalledTimes(60);
    unsubscribe();
  });

  it("debounces Netflix DOM captions and resets the stream after seeking backward", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<video></video><div class="player-timedtext">First caption</div>';
    const video = document.querySelector("video");
    const caption = document.querySelector<HTMLElement>(".player-timedtext");
    if (!video || !caption) throw new Error("invalid Netflix fixture");
    video.currentTime = 2;
    const tracks: SubtitleTrack[] = [];
    const adapter = new NetflixSubtitleAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      const firstCueId = tracks.at(-1)?.cues[0]?.id;
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 2_000, originalText: "First caption" },
      ]);

      video.currentTime = 10;
      caption.textContent = "Later caption";
      await vi.advanceTimersByTimeAsync(70);
      video.currentTime = 2;
      caption.textContent = "Earlier caption";
      await vi.advanceTimersByTimeAsync(70);

      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 2_000, originalText: "Earlier caption" },
      ]);
      expect(tracks.at(-1)?.cues[0]?.id).not.toBe(firstCueId);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it("only reads Netflix DOM captions owned by the active player", () => {
    document.body.innerHTML = `
      <div class="preview-player">
        <video></video>
        <div class="player-timedtext">Preview caption</div>
      </div>
      <div class="watch-player">
        <video></video>
        <div class="player-timedtext">Watch caption</div>
      </div>
    `;
    const videos = Array.from(document.querySelectorAll("video"));
    const [preview, watch] = videos;
    if (!preview || !watch) throw new Error("invalid Netflix player fixture");
    preview.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 320, height: 180 });
    watch.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 80, y: 80, width: 960, height: 540 });
    Object.defineProperty(watch, "paused", {
      configurable: true,
      value: false,
    });
    watch.currentTime = 20;
    const tracks: SubtitleTrack[] = [];
    const adapter = new NetflixSubtitleAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 20_000, originalText: "Watch caption" },
      ]);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
    }
  });

  it("emits an ended Netflix cue when captions become display-none", async () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<video></video><div class="player-timedtext">Visible caption</div>';
    const video = document.querySelector("video");
    const caption = document.querySelector<HTMLElement>(".player-timedtext");
    if (!video || !caption) throw new Error("invalid Netflix fixture");
    video.currentTime = 4;
    const tracks: SubtitleTrack[] = [];
    const adapter = new NetflixSubtitleAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      video.currentTime = 5;
      caption.style.display = "none";
      await vi.advanceTimersByTimeAsync(70);
      expect(tracks.at(-1)?.cues.at(-1)).toMatchObject({
        originalText: "Visible caption",
        endMs: 5_000,
      });
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("resets profile DOM history for a new source and unchanged seek text", async () => {
    vi.useFakeTimers();
    const profile: SubtitleSiteProfile = {
      id: "test-profile",
      version: 1,
      name: "Test profile",
      parser: "dom",
      priority: 1,
      match: { hostnameSuffixes: ["localhost"] },
      selectors: {
        video: "video",
        captions: [".profile-caption"],
        nativeCaptions: [".profile-caption"],
      },
      capture: {
        formats: [],
        allowedHostnameSuffixes: [],
        urlPatterns: [],
      },
    };
    document.body.innerHTML =
      '<video src="https://media.example/old.mp4"></video><div class="profile-caption">Same caption</div>';
    const video = document.querySelector("video");
    const caption = document.querySelector<HTMLElement>(".profile-caption");
    if (!video || !caption) throw new Error("invalid profile source fixture");
    video.getBoundingClientRect = () => new DOMRect(100, 50, 800, 450);
    caption.getBoundingClientRect = () => new DOMRect(180, 390, 640, 48);
    video.currentTime = 10;
    const tracks: SubtitleTrack[] = [];
    const adapter = new ProfileDomSubtitleAdapter(profile);
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      const initialCueId = tracks.at(-1)?.cues[0]?.id;
      video.src = "https://media.example/new.mp4";
      video.currentTime = 4;
      video.dispatchEvent(new Event("loadedmetadata", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(90);
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 10_000, originalText: "Same caption" },
      ]);

      // A reused player can leave the previous video's caption node intact.
      // The adapter must wait for real subtitle DOM activity before treating
      // identical text as a cue from the new source.
      caption.textContent = "";
      caption.textContent = "Same caption";
      await vi.advanceTimersByTimeAsync(90);
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 4_000, originalText: "Same caption" },
      ]);
      expect(tracks.at(-1)?.cues[0]?.id).not.toBe(initialCueId);

      const sourceCueId = tracks.at(-1)?.cues[0]?.id;
      video.currentTime = 1;
      video.dispatchEvent(new Event("seeking", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(90);
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 1_000, originalText: "Same caption" },
      ]);
      expect(tracks.at(-1)?.cues[0]?.id).not.toBe(sourceCueId);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.useRealTimers();
    }
  });

  it("keeps YouTube signed-source refreshes but clears a reused player on loadstart", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", {
      href: "https://www.youtube.com/watch?v=stable-video",
      hostname: "www.youtube.com",
    });
    document.body.innerHTML =
      '<video></video><div class="ytp-caption-segment">First cue</div>';
    const video = document.querySelector("video");
    const caption = document.querySelector<HTMLElement>(".ytp-caption-segment");
    if (!video || !caption) throw new Error("invalid YouTube reset fixture");
    let mediaSource =
      "https://media.example/episode-one.m3u8?quality=1080p&signature=old";
    Object.defineProperty(video, "currentSrc", {
      configurable: true,
      get: () => mediaSource,
    });
    video.currentTime = 1;
    const tracks: SubtitleTrack[] = [];
    const adapter = new YouTubeTimedTextAdapter();
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      mediaSource =
        "https://media.example/episode-one.m3u8?quality=1080p&signature=new";
      video.currentTime = 2;
      caption.textContent = "Second cue";
      await vi.advanceTimersByTimeAsync(70);
      expect(tracks.at(-1)?.cues).toHaveLength(2);

      mediaSource = "";
      video.currentTime = 3;
      caption.textContent = "Third cue";
      await vi.advanceTimersByTimeAsync(70);
      expect(tracks.at(-1)?.cues).toHaveLength(3);

      mediaSource = "https://media.example/episode-two.m3u8?signature=fresh";
      video.dispatchEvent(new Event("loadstart", { bubbles: true }));
      expect(await adapter.collect()).toBeNull();

      video.currentTime = 4;
      caption.textContent = "New media cue";
      await vi.advanceTimersByTimeAsync(70);
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 4_000, originalText: "New media cue" },
      ]);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps a verified YouTube full track across a transient same-video loadstart", async () => {
    vi.stubGlobal("location", {
      href: "https://www.youtube.com/watch?v=stable-video",
      hostname: "www.youtube.com",
    });
    const video = document.createElement("video");
    document.body.append(video);
    let mediaSource =
      "https://media.example/captions.m3u8?quality=1080p&signature=old";
    Object.defineProperty(video, "currentSrc", {
      configurable: true,
      get: () => mediaSource,
    });
    const adapter = new YouTubeTimedTextAdapter();
    const tracks: SubtitleTrack[] = [];
    const listener = vi.fn((track: SubtitleTrack) => tracks.push(track));
    const invalidated = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    const unsubscribeInvalidation = adapter.subscribeInvalidation(invalidated);
    try {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "youtube",
            pageUrl: location.href,
            url: "https://www.youtube.com/api/timedtext?fmt=json3&lang=en",
            ...captureIdentity(),
            ...COMPLETE_RESPONSE_EVIDENCE,
            body: {
              events: [
                {
                  tStartMs: 0,
                  dDurationMs: 1_000,
                  segs: [{ utf8: "Complete first cue" }],
                },
                {
                  tStartMs: 1_000,
                  dDurationMs: 1_000,
                  segs: [{ utf8: "Complete second cue" }],
                },
              ],
            },
          },
        }),
      );
      expect(tracks.at(-1)).toMatchObject({
        source: "youtube-timedtext",
        completeness: "full",
        cues: [
          { originalText: "Complete first cue" },
          { originalText: "Complete second cue" },
        ],
      });

      mediaSource =
        "https://media.example/captions.m3u8?quality=1080p&signature=new";
      video.dispatchEvent(new Event("loadstart", { bubbles: true }));

      await expect(adapter.collect()).resolves.toMatchObject({
        source: "youtube-timedtext",
        completeness: "full",
        cues: [
          { originalText: "Complete first cue" },
          { originalText: "Complete second cue" },
        ],
      });
      expect(invalidated).not.toHaveBeenCalled();
    } finally {
      unsubscribeInvalidation();
      unsubscribe();
      document.body.replaceChildren();
      vi.unstubAllGlobals();
    }
  });

  it("drops Netflix segment history on emptied and accepts the new media capture", async () => {
    vi.stubGlobal("location", {
      href: "https://www.netflix.com/watch/81234567",
      hostname: "www.netflix.com",
    });
    const video = document.createElement("video");
    let mediaSource = "blob:https://www.netflix.com/episode-one";
    Object.defineProperty(video, "currentSrc", {
      configurable: true,
      get: () => mediaSource,
    });
    document.body.append(video);
    const adapter = new NetflixSubtitleAdapter();
    const tracks: SubtitleTrack[] = [];
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    const dispatchSegment = (segment: number, text: string): void => {
      window.dispatchEvent(
        new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
          detail: {
            site: "netflix",
            pageUrl: location.href,
            url: `https://www.netflix.com/timedtexttracks?id=e2e&lang=en&segment=${segment}`,
            mediaScope: stableVideoCaptureScope(video),
            videoCount: 1,
            body: `WEBVTT\n\n00:00:0${segment}.000 --> 00:00:0${segment + 1}.000\n${text}`,
          },
        }),
      );
    };
    try {
      dispatchSegment(1, "Episode one");
      expect((await adapter.collect())?.cues).toHaveLength(1);

      mediaSource = "blob:https://www.netflix.com/episode-two";
      video.dispatchEvent(new Event("emptied", { bubbles: true }));
      expect(await adapter.collect()).toBeNull();

      dispatchSegment(2, "Episode two");
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 2_000, originalText: "Episode two" },
      ]);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.unstubAllGlobals();
    }
  });

  it("does not return a profile DOM cue after a reused player changes source", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("location", {
      href: "https://v.qq.com/x/cover/example/video-one.html",
      hostname: "v.qq.com",
    });
    const profile: SubtitleSiteProfile = {
      id: "test-profile-reset",
      version: 1,
      name: "Test profile reset",
      parser: "dom",
      priority: 1,
      match: { hostnameSuffixes: ["v.qq.com"] },
      selectors: {
        video: "video",
        captions: [".profile-caption"],
        nativeCaptions: [".profile-caption"],
      },
      capture: {
        formats: [],
        allowedHostnameSuffixes: [],
        urlPatterns: [],
      },
    };
    document.body.innerHTML =
      '<video></video><div class="profile-caption">Old media cue</div>';
    const video = document.querySelector("video");
    const caption = document.querySelector<HTMLElement>(".profile-caption");
    if (!video || !caption) throw new Error("invalid profile reset fixture");
    let mediaSource = "https://media.example/video-one.mp4";
    Object.defineProperty(video, "currentSrc", {
      configurable: true,
      get: () => mediaSource,
    });
    video.getBoundingClientRect = () => new DOMRect(100, 50, 800, 450);
    caption.getBoundingClientRect = () => new DOMRect(180, 390, 640, 48);
    video.currentTime = 10;
    const tracks: SubtitleTrack[] = [];
    const adapter = new ProfileDomSubtitleAdapter(profile);
    const unsubscribe = adapter.subscribe((track) => tracks.push(track));
    try {
      expect(tracks.at(-1)?.cues).toHaveLength(1);

      mediaSource = "https://media.example/video-two.mp4";
      video.dispatchEvent(new Event("loadstart", { bubbles: true }));
      expect(await adapter.collect()).toBeNull();

      video.currentTime = 1;
      caption.textContent = "New media cue";
      await vi.advanceTimersByTimeAsync(90);
      expect(tracks.at(-1)?.cues).toMatchObject([
        { startMs: 1_000, originalText: "New media cue" },
      ]);
    } finally {
      unsubscribe();
      document.body.replaceChildren();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
