import { Html5TextTrackAdapter } from "@/src/subtitles/adapters/html5";
import { afterEach, describe, expect, it, vi } from "vitest";

function textTrack(text: string): TextTrack {
  return {
    kind: "subtitles",
    language: "en",
    mode: "showing",
    cues: {
      length: 1,
      0: { text, startTime: 0, endTime: 1 },
    },
  } as unknown as TextTrack;
}

function setTracks(video: HTMLVideoElement, tracks: TextTrack[]): void {
  Object.defineProperty(video, "textTracks", {
    configurable: true,
    value: tracks,
  });
}

function subscribableFullTrack(
  video: HTMLVideoElement,
  text: string,
): {
  track: TextTrack;
  clearCues(): void;
  removeTrack(): void;
} {
  const cues = {
    length: 1,
    0: { text, startTime: 0, endTime: 1 },
  };
  const trackTarget = new EventTarget();
  Object.assign(trackTarget, {
    kind: "subtitles",
    language: "en",
    mode: "showing",
    cues,
  });
  const track = trackTarget as unknown as TextTrack;
  let tracks = [track];
  const trackListTarget = new EventTarget();
  Object.defineProperties(trackListTarget, {
    length: { configurable: true, get: () => tracks.length },
    0: { configurable: true, get: () => tracks[0] },
  });
  Object.defineProperty(video, "textTracks", {
    configurable: true,
    value: trackListTarget,
  });
  const trackElement = document.createElement("track");
  Object.defineProperties(trackElement, {
    track: { configurable: true, value: track },
    readyState: { configurable: true, value: 2 },
  });
  video.append(trackElement);
  return {
    track,
    clearCues: () => {
      cues.length = 0;
      trackTarget.dispatchEvent(new Event("cuechange"));
    },
    removeTrack: () => {
      tracks = [];
      trackElement.remove();
      trackListTarget.dispatchEvent(new Event("removetrack"));
    },
  };
}

afterEach(() => document.body.replaceChildren());

describe("Html5TextTrackAdapter", () => {
  it("does not borrow a TextTrack from an inactive secondary player", async () => {
    const active = document.createElement("video");
    const secondary = document.createElement("video");
    active.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540);
    secondary.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    Object.defineProperty(active, "paused", {
      configurable: true,
      value: false,
    });
    setTracks(active, []);
    setTracks(secondary, [textTrack("Wrong player subtitle")]);
    document.body.append(active, secondary);

    await expect(new Html5TextTrackAdapter().collect()).resolves.toBeNull();
  });

  it("reads the selected active player's TextTrack", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540);
    setTracks(video, [textTrack("Active subtitle")]);
    document.body.append(video);

    await expect(new Html5TextTrackAdapter().collect()).resolves.toMatchObject({
      source: "texttrack",
      cues: [{ originalText: "Active subtitle" }],
    });
  });

  it("keeps the recently activated smaller player's TextTrack when another larger video is also playing", async () => {
    const recentlyActivated = document.createElement("video");
    const larger = document.createElement("video");
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
    setTracks(recentlyActivated, [textTrack("Recently activated subtitle")]);
    setTracks(larger, [textTrack("Larger player subtitle")]);
    document.body.append(recentlyActivated, larger);
    const adapter = new Html5TextTrackAdapter();
    adapter.setPreferredVideo(recentlyActivated);

    await expect(adapter.collect()).resolves.toMatchObject({
      source: "texttrack",
      cues: [{ originalText: "Recently activated subtitle" }],
    });
  });

  it("selects the configured language on the active player", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540);
    const english = textTrack("English subtitle");
    const french = textTrack("Sous-titre français");
    Object.defineProperty(french, "language", { value: "fr" });
    setTracks(video, [english, french]);
    document.body.append(video);
    const adapter = new Html5TextTrackAdapter();
    adapter.setSourceLanguage("fr");

    await expect(adapter.collect()).resolves.toMatchObject({
      language: "fr",
      cues: [{ originalText: "Sous-titre français" }],
    });
  });

  it("treats a live HTML5 TextTrack as a stream instead of a full file", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540);
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: Number.POSITIVE_INFINITY,
    });
    setTracks(video, [textTrack("Live subtitle")]);
    document.body.append(video);

    await expect(new Html5TextTrackAdapter().collect()).resolves.toMatchObject({
      source: "texttrack",
      completeness: "stream",
    });
  });

  it("treats a populated addTextTrack timeline on finite media as full", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540);
    Object.defineProperties(video, {
      duration: { configurable: true, value: 100 },
      currentTime: { configurable: true, value: 10 },
    });
    const track = textTrack("Opening subtitle");
    Object.defineProperty(track, "cues", {
      configurable: true,
      value: {
        length: 2,
        0: { text: "Opening subtitle", startTime: 2, endTime: 5 },
        1: { text: "Closing subtitle", startTime: 94, endTime: 99 },
      },
    });
    setTracks(video, [track]);
    document.body.append(video);

    await expect(new Html5TextTrackAdapter().collect()).resolves.toMatchObject({
      source: "texttrack",
      completeness: "full",
      cues: [
        { originalText: "Opening subtitle" },
        { originalText: "Closing subtitle" },
      ],
    });
  });

  it("keeps a finite but playback-growing addTextTrack timeline as stream", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540);
    Object.defineProperties(video, {
      duration: { configurable: true, value: 600 },
      currentTime: { configurable: true, value: 120 },
    });
    const track = textTrack("Current dynamic subtitle");
    Object.defineProperty(track, "cues", {
      configurable: true,
      value: {
        length: 2,
        0: { text: "Earlier subtitle", startTime: 116, endTime: 118 },
        1: { text: "Current dynamic subtitle", startTime: 119, endTime: 122 },
      },
    });
    setTracks(video, [track]);
    document.body.append(video);

    await expect(new Html5TextTrackAdapter().collect()).resolves.toMatchObject({
      source: "texttrack",
      completeness: "stream",
    });
  });

  it.each([
    ["its cues are cleared", "clearCues"],
    ["the track is removed", "removeTrack"],
  ] as const)(
    "notifies when a previously available full TextTrack is invalidated because %s",
    async (_description, invalidate) => {
      const video = document.createElement("video");
      video.getBoundingClientRect = () => new DOMRect(0, 0, 960, 540);
      const fullTrack = subscribableFullTrack(video, "Complete subtitle");
      document.body.append(video);
      const adapter = new Html5TextTrackAdapter();
      const selected = vi.fn();
      const invalidated = vi.fn();
      const unsubscribeInvalidation =
        adapter.subscribeInvalidation(invalidated);
      const unsubscribe = adapter.subscribe(selected);
      await vi.waitFor(() =>
        expect(selected).toHaveBeenCalledWith(
          expect.objectContaining({
            source: "texttrack",
            completeness: "full",
          }),
        ),
      );

      fullTrack[invalidate]();

      await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1));
      unsubscribe();
      unsubscribeInvalidation();
    },
  );
});
