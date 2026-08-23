import {
  DYNAMIC_NATIVE_CAPTION_ATTRIBUTE,
  NativeSubtitleVisibility,
} from "@/src/subtitles/native-visibility";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("native subtitle visibility", () => {
  beforeEach(() => {
    document.documentElement.replaceChildren(
      document.createElement("head"),
      document.createElement("body"),
    );
  });

  it("includes only explicitly marked generic caption nodes in dynamic hiding", () => {
    document.body.innerHTML = `
      <video></video>
      <div ${DYNAMIC_NATIVE_CAPTION_ATTRIBUTE}>Captured subtitle</div>
      <div class="subtitle-description">Article subtitle</div>
    `;
    const video = document.querySelector("video");
    if (!video) throw new Error("missing video fixture");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    const visibility = new NativeSubtitleVisibility();
    visibility.update(true);

    const captured = document.querySelector<HTMLElement>(
      `[${DYNAMIC_NATIVE_CAPTION_ATTRIBUTE}]`,
    );
    const article = document.querySelector<HTMLElement>(
      ".subtitle-description",
    );
    expect(getComputedStyle(captured!).visibility).toBe("hidden");
    expect(getComputedStyle(article!).visibility).not.toBe("hidden");
    visibility.destroy();
  });

  it("hides website captions without removing their text nodes", () => {
    document.body.innerHTML = `
      <section id="player">
        <video></video>
        <div class="ytp-caption-segment">YouTube caption</div>
        <div class="player-timedtext">Netflix caption</div>
      </section>
    `;
    const video = document.querySelector("video");
    if (!video) throw new Error("missing video fixture");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    const visibility = new NativeSubtitleVisibility([
      ".ytp-caption-segment",
      ".player-timedtext",
    ]);
    visibility.update(true);

    const youtubeCaption = document.querySelector<HTMLElement>(
      ".ytp-caption-segment",
    );
    const netflixCaption =
      document.querySelector<HTMLElement>(".player-timedtext");
    expect(getComputedStyle(youtubeCaption!).visibility).toBe("hidden");
    expect(getComputedStyle(netflixCaption!).visibility).toBe("hidden");
    expect(youtubeCaption?.textContent).toBe("YouTube caption");
    expect(netflixCaption?.textContent).toBe("Netflix caption");

    visibility.update(false);
    expect(getComputedStyle(youtubeCaption!).visibility).not.toBe("hidden");
    expect(getComputedStyle(netflixCaption!).visibility).not.toBe("hidden");
    visibility.destroy();
  });

  it("hides Tencent player captions without hiding generic page copy", () => {
    document.body.innerHTML = `
      <section id="player"><video></video><div class="txp_subtitle_line">腾讯原字幕</div></section>
      <div class="subtitle-description">普通页面说明</div>
    `;
    const video = document.querySelector("video");
    if (!video) throw new Error("missing video fixture");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    const visibility = new NativeSubtitleVisibility([
      "[class*='txp_subtitle' i]",
    ]);
    visibility.update(true);

    expect(
      getComputedStyle(
        document.querySelector<HTMLElement>(".txp_subtitle_line")!,
      ).visibility,
    ).toBe("hidden");
    expect(
      getComputedStyle(
        document.querySelector<HTMLElement>(".subtitle-description")!,
      ).visibility,
    ).not.toBe("hidden");
    visibility.destroy();
  });

  it("does not hide matching page copy far outside the active video", () => {
    document.body.innerHTML = `
      <section id="player"><video></video><div class="caption-cue">Player caption</div></section>
      <article><div class="caption-cue">Article caption</div></article>
    `;
    const video = document.querySelector("video");
    const captions = document.querySelectorAll<HTMLElement>(".caption-cue");
    if (!video || !captions[0] || !captions[1]) {
      throw new Error("missing single-player ownership fixture");
    }
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    captions[0].getBoundingClientRect = () => new DOMRect(80, 300, 480, 40);
    captions[1].getBoundingClientRect = () => new DOMRect(0, 700, 480, 40);

    const visibility = new NativeSubtitleVisibility([".caption-cue"]);
    visibility.setVideo(video);
    visibility.update(true);

    expect(getComputedStyle(captions[0]).visibility).toBe("hidden");
    expect(getComputedStyle(captions[1]).visibility).not.toBe("hidden");
    visibility.destroy();
  });

  it("automatically hides a native caption node replaced while hiding is active", async () => {
    document.body.innerHTML = `
      <section id="player"><video></video><div class="caption-cue">First caption</div></section>
    `;
    const player = document.querySelector<HTMLElement>("#player");
    const video = document.querySelector("video");
    if (!player || !video) throw new Error("missing replacement fixture");
    video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);

    const visibility = new NativeSubtitleVisibility([".caption-cue"]);
    visibility.setVideo(video);
    visibility.update(true);
    const replacement = document.createElement("div");
    replacement.className = "caption-cue";
    replacement.textContent = "Replacement caption";
    player.querySelector(".caption-cue")?.replaceWith(replacement);

    await vi.waitFor(() =>
      expect(getComputedStyle(replacement).visibility).toBe("hidden"),
    );
    visibility.update(false);
    expect(getComputedStyle(replacement).visibility).not.toBe("hidden");
    visibility.destroy();
  });

  it("temporarily hides and restores native HTML5 caption tracks", () => {
    const video = document.createElement("video");
    const captionTrack = {
      kind: "captions",
      mode: "showing",
    } as unknown as TextTrack;
    Object.defineProperty(video, "textTracks", {
      configurable: true,
      value: [captionTrack],
    });
    document.body.append(video);

    const visibility = new NativeSubtitleVisibility();
    visibility.update(true);
    expect(captionTrack.mode).toBe("hidden");

    visibility.destroy();
    expect(captionTrack.mode).toBe("showing");
  });

  it("re-hides a selected HTML5 track after the player makes it showing again", async () => {
    const video = document.createElement("video");
    const trackList = new EventTarget() as TextTrackList;
    let mode: TextTrackMode = "showing";
    const captionTrack = {
      kind: "captions",
      get mode() {
        return mode;
      },
      set mode(value: TextTrackMode) {
        mode = value;
        trackList.dispatchEvent(new Event("change"));
      },
    } as unknown as TextTrack;
    Object.defineProperties(trackList, {
      length: { configurable: true, value: 1 },
      0: { configurable: true, value: captionTrack },
    });
    Object.defineProperty(video, "textTracks", {
      configurable: true,
      value: trackList,
    });
    document.body.append(video);

    const visibility = new NativeSubtitleVisibility();
    visibility.setVideo(video);
    visibility.update(true);
    expect(captionTrack.mode).toBe("hidden");

    captionTrack.mode = "showing";
    await vi.waitFor(() => expect(captionTrack.mode).toBe("hidden"));
    visibility.destroy();
    expect(captionTrack.mode).toBe("showing");
  });

  it("keeps native captions visible while the selected video is in Picture-in-Picture", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      document,
      "pictureInPictureElement",
    );
    const video = document.createElement("video");
    const captionTrack = {
      kind: "captions",
      mode: "showing",
    } as unknown as TextTrack;
    Object.defineProperty(video, "textTracks", {
      configurable: true,
      value: [captionTrack],
    });
    document.body.append(video);
    const visibility = new NativeSubtitleVisibility();
    visibility.setVideo(video);
    visibility.update(true);
    expect(captionTrack.mode).toBe("hidden");

    Object.defineProperty(document, "pictureInPictureElement", {
      configurable: true,
      value: video,
    });
    video.dispatchEvent(new Event("enterpictureinpicture"));
    expect(captionTrack.mode).toBe("showing");

    Object.defineProperty(document, "pictureInPictureElement", {
      configurable: true,
      value: null,
    });
    video.dispatchEvent(new Event("leavepictureinpicture"));
    expect(captionTrack.mode).toBe("hidden");
    visibility.destroy();
    if (descriptor) {
      Object.defineProperty(document, "pictureInPictureElement", descriptor);
    } else {
      Reflect.deleteProperty(document, "pictureInPictureElement");
    }
  });

  it("hides HTML5 tracks only on the active video and restores them when the target changes", () => {
    const firstVideo = document.createElement("video");
    const secondVideo = document.createElement("video");
    const firstTrack = {
      kind: "captions",
      mode: "showing",
    } as unknown as TextTrack;
    const secondTrack = {
      kind: "subtitles",
      mode: "showing",
    } as unknown as TextTrack;
    Object.defineProperty(firstVideo, "textTracks", {
      configurable: true,
      value: [firstTrack],
    });
    Object.defineProperty(secondVideo, "textTracks", {
      configurable: true,
      value: [secondTrack],
    });
    document.body.append(firstVideo, secondVideo);

    const visibility = new NativeSubtitleVisibility();
    visibility.setVideo(firstVideo);
    visibility.update(true);
    visibility.refresh();
    expect(firstTrack.mode).toBe("hidden");
    expect(secondTrack.mode).toBe("showing");

    visibility.setVideo(null);
    visibility.refresh();
    expect(firstTrack.mode).toBe("showing");
    expect(secondTrack.mode).toBe("showing");

    visibility.setVideo(secondVideo);
    expect(firstTrack.mode).toBe("showing");
    expect(secondTrack.mode).toBe("hidden");

    visibility.update(false);
    expect(firstTrack.mode).toBe("showing");
    expect(secondTrack.mode).toBe("showing");
    visibility.destroy();
  });

  it("hides captions only for the selected video on a multi-player page", () => {
    document.body.innerHTML = `
      <section id="first-player"><video></video><div class="ytp-caption-segment">First caption</div></section>
      <section id="second-player"><video></video><div class="ytp-caption-segment">Second caption</div></section>
    `;
    const videos = document.querySelectorAll("video");
    const captions = document.querySelectorAll<HTMLElement>(
      ".ytp-caption-segment",
    );
    const firstVideo = videos[0];
    const secondVideo = videos[1];
    if (!firstVideo || !secondVideo || !captions[0] || !captions[1]) {
      throw new Error("missing multi-player fixture");
    }
    firstVideo.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
    secondVideo.getBoundingClientRect = () => new DOMRect(700, 0, 320, 180);
    captions[0].getBoundingClientRect = () => new DOMRect(80, 300, 480, 40);
    captions[1].getBoundingClientRect = () => new DOMRect(740, 140, 240, 30);

    const visibility = new NativeSubtitleVisibility([".ytp-caption-segment"]);
    visibility.setVideo(firstVideo);
    visibility.update(true);
    expect(getComputedStyle(captions[0]).visibility).toBe("hidden");
    expect(getComputedStyle(captions[1]).visibility).not.toBe("hidden");

    visibility.setVideo(secondVideo);
    expect(getComputedStyle(captions[0]).visibility).not.toBe("hidden");
    expect(getComputedStyle(captions[1]).visibility).toBe("hidden");
    visibility.destroy();
  });

  it("does not override a website track change made while captions are hidden", () => {
    const video = document.createElement("video");
    const captionTrack = {
      kind: "subtitles",
      mode: "showing",
    } as unknown as TextTrack;
    Object.defineProperty(video, "textTracks", {
      configurable: true,
      value: [captionTrack],
    });
    document.body.append(video);

    const visibility = new NativeSubtitleVisibility();
    visibility.update(true);
    expect(captionTrack.mode).toBe("hidden");

    captionTrack.mode = "disabled";
    visibility.update(false);
    expect(captionTrack.mode).toBe("disabled");
    visibility.destroy();
  });
});
