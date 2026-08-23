import {
  captionsForVideo,
  orderedVideos,
  selectActiveVideo,
  stableVideoCaptureScope,
  stableVideoPersistenceScope,
  stableVideoScope,
} from "@/src/subtitles/video-selection";
import { afterEach, describe, expect, it } from "vitest";

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return DOMRect.fromRect({ x, y, width, height });
}

afterEach(() => {
  document.body.replaceChildren();
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    value: null,
  });
});

describe("active video selection", () => {
  it("prefers the playing video over an earlier paused player", () => {
    const paused = document.createElement("video");
    const playing = document.createElement("video");
    paused.id = "preview";
    playing.id = "main-player";
    paused.getBoundingClientRect = () => rect(0, 0, 800, 450);
    playing.getBoundingClientRect = () => rect(100, 100, 640, 360);
    Object.defineProperty(paused, "paused", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(playing, "paused", {
      configurable: true,
      value: false,
    });
    document.body.append(paused, playing);

    expect(selectActiveVideo()).toBe(playing);
    expect(orderedVideos()).toEqual([playing, paused]);
    expect(stableVideoScope(playing)).toContain("id:main-player");
  });

  it("prefers the most recently activated player when two videos are playing", () => {
    const larger = document.createElement("video");
    const recentlyActivated = document.createElement("video");
    Object.defineProperty(larger, "paused", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(recentlyActivated, "paused", {
      configurable: true,
      value: false,
    });
    larger.getBoundingClientRect = () => rect(0, 0, 900, 500);
    recentlyActivated.getBoundingClientRect = () => rect(100, 100, 640, 360);
    document.body.append(larger, recentlyActivated);

    expect(selectActiveVideo()).toBe(larger);
    expect(selectActiveVideo("video", recentlyActivated)).toBe(
      recentlyActivated,
    );
    expect(orderedVideos("video", recentlyActivated)[0]).toBe(
      recentlyActivated,
    );
  });

  it("prefers the largest visible video when every player is paused", () => {
    const thumbnail = document.createElement("video");
    const main = document.createElement("video");
    thumbnail.getBoundingClientRect = () => rect(0, 0, 160, 90);
    main.getBoundingClientRect = () => rect(20, 20, 900, 500);
    document.body.append(thumbnail, main);

    expect(selectActiveVideo()).toBe(main);
    expect(stableVideoScope(main)).toContain("index:1");
  });

  it("does not let a hidden autoplay video outrank a visible player", () => {
    const hiddenAutoplay = document.createElement("video");
    const visible = document.createElement("video");
    Object.defineProperty(hiddenAutoplay, "paused", {
      configurable: true,
      value: false,
    });
    hiddenAutoplay.style.visibility = "hidden";
    hiddenAutoplay.getBoundingClientRect = () => rect(0, 0, 1_920, 1_080);
    visible.getBoundingClientRect = () => rect(100, 100, 640, 360);
    document.body.append(hiddenAutoplay, visible);

    expect(selectActiveVideo()).toBe(visible);
    expect(orderedVideos()).toEqual([visible, hiddenAutoplay]);
  });

  it("does not let an offscreen autoplay video outrank a visible player", () => {
    const offscreenAutoplay = document.createElement("video");
    const visible = document.createElement("video");
    Object.defineProperty(offscreenAutoplay, "paused", {
      configurable: true,
      value: false,
    });
    offscreenAutoplay.getBoundingClientRect = () =>
      rect(window.innerWidth + 100, 0, 800, 450);
    visible.getBoundingClientRect = () => rect(100, 100, 640, 360);
    document.body.append(offscreenAutoplay, visible);

    expect(selectActiveVideo()).toBe(visible);
  });

  it("does not let a zero-size autoplay video outrank a visible player", () => {
    const zeroSizeAutoplay = document.createElement("video");
    const visible = document.createElement("video");
    Object.defineProperty(zeroSizeAutoplay, "paused", {
      configurable: true,
      value: false,
    });
    zeroSizeAutoplay.getBoundingClientRect = () => rect(0, 0, 0, 0);
    visible.getBoundingClientRect = () => rect(100, 100, 640, 360);
    document.body.append(zeroSizeAutoplay, visible);

    expect(selectActiveVideo()).toBe(visible);
  });

  it("keeps a fullscreen player authoritative", () => {
    const playing = document.createElement("video");
    const fullscreenContainer = document.createElement("div");
    const fullscreenVideo = document.createElement("video");
    Object.defineProperty(playing, "paused", {
      configurable: true,
      value: false,
    });
    playing.getBoundingClientRect = () => rect(0, 0, 800, 450);
    fullscreenVideo.getBoundingClientRect = () => rect(0, 0, 640, 360);
    fullscreenContainer.append(fullscreenVideo);
    document.body.append(playing, fullscreenContainer);
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: fullscreenContainer,
    });

    expect(selectActiveVideo()).toBe(fullscreenVideo);
  });

  it("ignores a zero-size secondary video when assigning DOM captions", () => {
    const active = document.createElement("video");
    const hidden = document.createElement("video");
    const caption = document.createElement("div");
    active.getBoundingClientRect = () => rect(100, 100, 800, 450);
    hidden.getBoundingClientRect = () => rect(0, 0, 0, 0);
    caption.getBoundingClientRect = () => rect(250, 460, 500, 40);
    document.body.append(active, hidden, caption);

    expect(captionsForVideo([caption], active)).toEqual([caption]);
  });

  it("uses stable site media IDs instead of expiring signed video URLs", () => {
    const video = document.createElement("video");
    video.id = "main-player";
    video.src = "https://signed-media.example/first?expires=1";
    document.body.append(video);

    const first = stableVideoScope(
      video,
      "https://www.youtube.com/watch?v=stable-video-id",
    );
    video.src = "https://signed-media.example/second?expires=2";
    const second = stableVideoScope(
      video,
      "https://www.youtube.com/watch?v=stable-video-id",
    );

    expect(first).toBe(second);
    expect(first).toContain("youtube:stable-video-id");
    expect(first).not.toContain("signed-media.example");
    expect(
      stableVideoScope(video, "https://www.netflix.com/watch/81234567"),
    ).toContain("netflix:81234567");
  });

  it("keeps site capture identity stable across signatures but changes it for a new media source", () => {
    const video = document.createElement("video");
    video.id = "main-player";
    document.body.append(video);
    const pageUrl = "https://www.youtube.com/watch?v=stable-video-id";

    video.src =
      "https://cdn.example.com/episode-one.m3u8?quality=1080p&expires=1&signature=old";
    const first = stableVideoCaptureScope(video, pageUrl);
    video.src =
      "https://cdn.example.com/episode-one.m3u8?quality=1080p&expires=2&signature=new";
    const refreshed = stableVideoCaptureScope(video, pageUrl);
    video.src =
      "https://cdn.example.com/episode-two.m3u8?quality=1080p&expires=3&signature=next";
    const nextMedia = stableVideoCaptureScope(video, pageUrl);

    expect(refreshed).toBe(first);
    expect(nextMedia).not.toBe(first);
    expect(nextMedia).toContain("youtube:stable-video-id");
    expect(nextMedia).toContain("episode-two.m3u8");
    expect(nextMedia).not.toMatch(/expires|signature/u);
  });

  it("keeps known-site persistence identity stable across blob recreation", () => {
    const video = document.createElement("video");
    video.id = "main-player";
    video.src = "blob:https://www.netflix.com/first-session";
    document.body.append(video);
    const pageUrl = "https://www.netflix.com/watch/81234567";

    const firstPersistence = stableVideoPersistenceScope(video, pageUrl);
    const firstCapture = stableVideoCaptureScope(video, pageUrl);
    video.src = "blob:https://www.netflix.com/second-session";
    const refreshedPersistence = stableVideoPersistenceScope(video, pageUrl);
    const refreshedCapture = stableVideoCaptureScope(video, pageUrl);

    expect(refreshedPersistence).toBe(firstPersistence);
    expect(firstPersistence).toBe("netflix:81234567|id:main-player");
    expect(refreshedCapture).not.toBe(firstCapture);
  });

  it("isolates generic blob media while ignoring expiring signed URL parameters", () => {
    const video = document.createElement("video");
    video.id = "generic-player";
    video.src = "blob:https://example.com/first-session";
    document.body.append(video);
    const firstBlob = stableVideoScope(
      video,
      "https://example.com/watch/episode-1",
    );
    video.src = "blob:https://example.com/second-session";
    const secondBlob = stableVideoScope(
      video,
      "https://example.com/watch/episode-1",
    );
    expect(firstBlob).not.toBe(secondBlob);
    expect(firstBlob).toContain("blob:https://example.com/first-session");

    video.src =
      "https://cdn.example.com/media/episode-1.m3u8?quality=1080p&expires=1&signature=old";
    const firstSigned = stableVideoScope(video, "https://example.com/watch/1");
    video.src =
      "https://cdn.example.com/media/episode-1.m3u8?quality=1080p&expires=2&signature=new";
    const secondSigned = stableVideoScope(video, "https://example.com/watch/1");
    expect(firstSigned).toBe(secondSigned);
    expect(firstSigned).toContain("quality=1080p");
    expect(firstSigned).not.toMatch(/expires|signature/u);
  });
});
