import {
  SUBTITLE_CAPTURE_EVENT,
  type SubtitleCaptureSite,
} from "@/src/subtitles/adapters/captured";
import { CapturedProfileSubtitleAdapter } from "@/src/subtitles/adapters/captured-profile";
import { builtInSiteProfile } from "@/src/subtitles/profiles/registry";
import type { SubtitleTrack } from "@/src/subtitles/types";
import { stableVideoCaptureScope } from "@/src/subtitles/video-selection";
import { afterEach, describe, expect, it, vi } from "vitest";

interface MutableTestLocation {
  href: string;
  hostname: string;
}

function stubLocation(href: string): MutableTestLocation {
  const url = new URL(href);
  const locationValue = { href: url.href, hostname: url.hostname };
  vi.stubGlobal("location", locationValue);
  return locationValue;
}

function appendVideo(source = "https://media.example/episode-one.m3u8"): {
  video: HTMLVideoElement;
  setSource: (value: string) => void;
} {
  let currentSource = source;
  const video = document.createElement("video");
  Object.defineProperty(video, "currentSrc", {
    configurable: true,
    get: () => currentSource,
  });
  document.body.append(video);
  return {
    video,
    setSource: (value) => {
      currentSource = value;
    },
  };
}

function dispatchCapture(options: {
  site: SubtitleCaptureSite;
  url: string;
  body:
    | string
    | {
        kind: "max-dash-vtt-full";
        language: string;
        segments: Array<{ body: string; offsetMs: number }>;
      }
    | {
        kind: "hls-vtt-full";
        language: string;
        segments: Array<{ body: string; offsetMs: number }>;
      };
  video: HTMLVideoElement;
  mediaScope?: string;
  manifestCandidate?: boolean;
  partial?: boolean;
  requestRange?: boolean;
  responseStatus?: number;
  contentRange?: string;
}): void {
  window.dispatchEvent(
    new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
      detail: {
        site: options.site,
        pageUrl: location.href,
        url: options.url,
        body: options.body,
        mediaScope:
          options.mediaScope ?? stableVideoCaptureScope(options.video),
        videoCount: 1,
        partial: options.partial ?? false,
        requestRange: options.requestRange ?? false,
        manifestCandidate: options.manifestCandidate ?? false,
        responseStatus: options.responseStatus ?? 200,
        ...(options.contentRange ? { contentRange: options.contentRange } : {}),
      },
    }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("CapturedProfileSubtitleAdapter", () => {
  it("merges and deduplicates Max VTT fragments without upgrading them to full", async () => {
    stubLocation("https://play.max.com/video/episode-one");
    const { video } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("max"),
    );
    adapter.setSourceLanguage("en");
    const tracks: SubtitleTrack[] = [];
    const stop = adapter.subscribe((track) => tracks.push(track));

    try {
      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/segment-2.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nSecond segment",
      });
      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/segment-1.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst segment",
      });
      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/segment-2.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nSecond segment",
      });

      expect(tracks.at(-1)).toMatchObject({
        source: "network",
        completeness: "stream",
        captureEvidence: "live-or-segmented",
        language: "en",
        cues: [
          { startMs: 1_000, originalText: "First segment" },
          { startMs: 2_000, originalText: "Second segment" },
        ],
      });
      await expect(adapter.collect()).resolves.toMatchObject({
        completeness: "stream",
        cues: [{ startMs: 1_000 }, { startMs: 2_000 }],
      });
    } finally {
      stop();
    }
  });

  it("upgrades Max to full only for an explicitly completed DASH track", async () => {
    stubLocation("https://play.max.com/video/episode-one");
    const { video } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("max"),
    );
    adapter.setSourceLanguage("en");
    const tracks: SubtitleTrack[] = [];
    const stop = adapter.subscribe((track) => tracks.push(track));

    try {
      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/segment-1.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nPassive",
      });
      expect(tracks.at(-1)?.completeness).toBe("stream");

      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/title/manifest/main.mpd",
        video,
        manifestCandidate: true,
        body: {
          kind: "max-dash-vtt-full",
          language: "en-US",
          segments: [
            {
              body: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFirst",
              offsetMs: 0,
            },
            {
              body: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nSecond",
              offsetMs: 1_000,
            },
          ],
        },
      });
      expect(tracks.at(-1)).toMatchObject({
        completeness: "full",
        captureEvidence: "verified-full-response",
        language: "en-US",
        cues: [
          { startMs: 0, originalText: "First" },
          { startMs: 1_000, originalText: "Second" },
        ],
      });

      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/late.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nLate passive",
      });
      await expect(adapter.collect()).resolves.toMatchObject({
        completeness: "full",
        cues: [{ originalText: "First" }, { originalText: "Second" }],
      });
    } finally {
      stop();
    }
  });

  it("accepts a verified finite Max HLS WebVTT track as full", () => {
    stubLocation("https://play.max.com/video/episode-hls");
    const { video } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("max"),
    );
    const tracks: SubtitleTrack[] = [];
    const stop = adapter.subscribe((track) => tracks.push(track));

    try {
      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/title/subtitle/en/full.m3u8",
        video,
        manifestCandidate: true,
        body: {
          kind: "hls-vtt-full",
          language: "en",
          segments: [
            {
              body: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nMax HLS first",
              offsetMs: 0,
            },
            {
              body: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nMax HLS second",
              offsetMs: 2_000,
            },
          ],
        },
      });

      expect(tracks.at(-1)).toMatchObject({
        completeness: "full",
        captureEvidence: "verified-full-response",
        cues: [
          { startMs: 0, originalText: "Max HLS first" },
          { startMs: 2_000, originalText: "Max HLS second" },
        ],
      });
    } finally {
      stop();
    }
  });

  it("applies Disney X-TIMESTAMP-MAP offsets before merging VTT fragments", () => {
    stubLocation("https://www.disneyplus.com/video/episode-one");
    const { video } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("disney-plus"),
    );
    const tracks: SubtitleTrack[] = [];
    const stop = adapter.subscribe((track) => tracks.push(track));

    try {
      dispatchCapture({
        site: "disney-plus",
        url: "https://cdn.bamgrid.com/subtitles/segment-10.vtt?lang=en",
        video,
        body: [
          "WEBVTT",
          "X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000",
          "",
          "00:00:00.000 --> 00:00:01.000",
          "Mapped first",
        ].join("\n"),
      });
      dispatchCapture({
        site: "disney-plus",
        url: "https://cdn.bamgrid.com/subtitles/segment-11.vtt?lang=en",
        video,
        body: [
          "WEBVTT",
          "X-TIMESTAMP-MAP=MPEGTS:990000,LOCAL:00:00:00.000",
          "",
          "00:00:00.000 --> 00:00:01.000",
          "Mapped second",
        ].join("\n"),
      });

      expect(tracks.at(-1)).toMatchObject({
        source: "network",
        completeness: "stream",
        cues: [
          {
            startMs: 10_000,
            endMs: 11_000,
            originalText: "Mapped first",
          },
          {
            startMs: 11_000,
            endMs: 12_000,
            originalText: "Mapped second",
          },
        ],
      });
    } finally {
      stop();
    }
  });

  it("accepts Disney HLS as full only after the completed manifest payload", async () => {
    stubLocation("https://www.disneyplus.com/video/episode-full");
    const { video } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("disney-plus"),
    );
    const tracks: SubtitleTrack[] = [];
    const stop = adapter.subscribe((track) => tracks.push(track));

    try {
      dispatchCapture({
        site: "disney-plus",
        url: "https://cdn.bamgrid.com/subtitles/full.m3u8?lang=en",
        video,
        manifestCandidate: true,
        body: {
          kind: "hls-vtt-full",
          language: "en",
          segments: [
            {
              body: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFirst",
              offsetMs: 0,
            },
            {
              body: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nSecond",
              offsetMs: 2_000,
            },
          ],
        },
      });

      expect(tracks.at(-1)).toMatchObject({
        completeness: "full",
        captureEvidence: "verified-full-response",
        cues: [
          { startMs: 0, originalText: "First" },
          { startMs: 2_000, originalText: "Second" },
        ],
      });
      await expect(adapter.collect()).resolves.toMatchObject({
        completeness: "full",
      });
    } finally {
      stop();
    }
  });

  it("rejects a capture from the wrong active media scope", async () => {
    stubLocation("https://play.max.com/video/episode-one");
    const { video } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("max"),
    );
    const listener = vi.fn<(track: SubtitleTrack) => void>();
    const stop = adapter.subscribe(listener);

    try {
      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/late.vtt?lang=en",
        video,
        mediaScope: "video:none",
        body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nWrong media",
      });

      expect(listener).not.toHaveBeenCalled();
      await expect(adapter.collect()).resolves.toBeNull();
    } finally {
      stop();
    }
  });

  it("invalidates fragments after route and video source changes", async () => {
    const locationValue = stubLocation(
      "https://play.max.com/video/episode-one",
    );
    const { video, setSource } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("max"),
    );
    const invalidated = vi.fn();
    const stopInvalidation = adapter.subscribeInvalidation(invalidated);
    const stop = adapter.subscribe(() => undefined);

    try {
      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/one.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEpisode one",
      });
      expect(await adapter.collect()).not.toBeNull();

      locationValue.href = "https://play.max.com/video/episode-two";
      await expect(adapter.collect()).resolves.toBeNull();
      expect(invalidated).toHaveBeenCalledTimes(1);

      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/two.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nEpisode two",
      });
      setSource("https://media.example/episode-two.m3u8");
      video.dispatchEvent(new Event("emptied", { bubbles: true }));
      await expect(adapter.collect()).resolves.toBeNull();
      expect(invalidated).toHaveBeenCalledTimes(2);

      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/three.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nNew video",
      });
      await expect(adapter.collect()).resolves.toMatchObject({
        cues: [{ originalText: "New video" }],
      });
    } finally {
      stop();
      stopInvalidation();
    }
  });

  it("filters captured languages and resets when the preferred language changes", async () => {
    stubLocation("https://play.max.com/video/episode-one");
    const { video } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("max"),
    );
    adapter.setSourceLanguage("en");
    const tracks: SubtitleTrack[] = [];
    const invalidated = vi.fn();
    const stopInvalidation = adapter.subscribeInvalidation(invalidated);
    const stop = adapter.subscribe((track) => tracks.push(track));

    try {
      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/fr.vtt?lang=fr",
        video,
        body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFrançais",
      });
      expect(tracks).toHaveLength(0);

      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/en.vtt?lang=en-US",
        video,
        body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nEnglish",
      });
      expect(tracks.at(-1)?.language).toBe("en-US");

      adapter.setSourceLanguage("fr");
      expect(invalidated).toHaveBeenCalledTimes(1);
      await expect(adapter.collect()).resolves.toBeNull();
      dispatchCapture({
        site: "max",
        url: "https://cdn.hbomaxcdn.com/subtitle/fr.vtt?lang=fr",
        video,
        body: "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nFrançais",
      });
      await expect(adapter.collect()).resolves.toMatchObject({
        language: "fr",
        cues: [{ originalText: "Français" }],
      });
    } finally {
      stop();
      stopInvalidation();
    }
  });

  it("parses an allowed Prime Video TTML string as a network stream", () => {
    stubLocation("https://www.primevideo.com/detail/episode-one");
    const { video } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("prime-video"),
    );
    const listener = vi.fn<(track: SubtitleTrack) => void>();
    const stop = adapter.subscribe(listener);

    try {
      dispatchCapture({
        site: "prime-video",
        url: "https://cdn.media-amazon.com/subtitle/episode.ttml?language=en",
        video,
        body: '<tt xml:lang="en"><body><div><p begin="1s" end="2.5s">Prime subtitle</p></div></body></tt>',
      });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "network",
          completeness: "stream",
          language: "en",
          cues: [
            expect.objectContaining({
              startMs: 1_000,
              endMs: 2_500,
              originalText: "Prime subtitle",
            }),
          ],
        }),
      );
    } finally {
      stop();
    }
  });

  it("promotes only a complete allowlisted Udemy VTT file to a full track", () => {
    stubLocation("https://www.udemy.com/course/example/learn");
    const { video } = appendVideo();
    const adapter = new CapturedProfileSubtitleAdapter(
      builtInSiteProfile("udemy"),
    );
    const listener = vi.fn<(track: SubtitleTrack) => void>();
    const stop = adapter.subscribe(listener);

    try {
      dispatchCapture({
        site: "udemy",
        url: "https://cdn.udemycdn.com/captions/next-en.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nPartial subtitle",
        partial: true,
        requestRange: true,
        responseStatus: 206,
        contentRange: "bytes 0-99/200",
      });
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          completeness: "stream",
          captureEvidence: "live-or-segmented",
        }),
      );

      dispatchCapture({
        site: "udemy",
        url: "https://cdn.udemycdn.com/captions/lesson-en.vtt?lang=en",
        video,
        body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nComplete lesson subtitle",
      });
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          completeness: "full",
          captureEvidence: "verified-full-response",
        }),
      );
    } finally {
      stop();
    }
  });
});
