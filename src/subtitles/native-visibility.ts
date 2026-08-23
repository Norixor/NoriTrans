import {
  captionsForVideo,
  selectActiveVideo,
} from "@/src/subtitles/video-selection";

const HIDDEN_ATTRIBUTE = "data-norixortrans-hide-native-subtitles";
const ACTIVE_CAPTION_ATTRIBUTE = "data-norixortrans-active-native-subtitle";
export const DYNAMIC_NATIVE_CAPTION_ATTRIBUTE =
  "data-norixortrans-native-caption";

/**
 * Writes only trusted built-in selectors directly into the stylesheet. User
 * profile selectors are marked only after active-player ownership checks.
 */
function visibilityStyle(preemptiveSelectors: readonly string[]): string {
  const selectors = [
    `:root[${HIDDEN_ATTRIBUTE}] [${ACTIVE_CAPTION_ATTRIBUTE}]`,
    `:root[${HIDDEN_ATTRIBUTE}] [${DYNAMIC_NATIVE_CAPTION_ATTRIBUTE}]`,
    ...preemptiveSelectors
      .filter(
        (selector) =>
          selector.trim().length > 0 && !/[{};\r\n]/u.test(selector),
      )
      .map((selector) => `:root[${HIDDEN_ATTRIBUTE}] ${selector}`),
  ];
  return `
  ${selectors.join(",\n  ")} {
    visibility: hidden !important;
  }
`;
}

function captionPresentationBelongsToVideo(
  caption: HTMLElement,
  video: HTMLVideoElement,
): boolean {
  if (caption.hasAttribute(DYNAMIC_NATIVE_CAPTION_ATTRIBUTE)) return true;
  let scope = caption.parentElement;
  while (
    scope &&
    scope !== document.body &&
    scope !== document.documentElement
  ) {
    if (scope.contains(video)) return true;
    scope = scope.parentElement;
  }

  const captionRect = caption.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();
  if (
    captionRect.width <= 0 ||
    captionRect.height <= 0 ||
    videoRect.width <= 0 ||
    videoRect.height <= 0
  ) {
    return false;
  }
  const horizontalGap = Math.max(
    0,
    captionRect.left - videoRect.right,
    videoRect.left - captionRect.right,
  );
  const verticalGap = Math.max(
    0,
    captionRect.top - videoRect.bottom,
    videoRect.top - captionRect.bottom,
  );
  const maximumGap = Math.max(
    32,
    Math.min(videoRect.width, videoRect.height) * 0.15,
  );
  return horizontalGap ** 2 + verticalGap ** 2 <= maximumGap ** 2;
}

/** Hides only the website/UA caption presentation while preserving cue data. */
export class NativeSubtitleVisibility {
  private readonly style = document.createElement("style");
  private readonly originalTrackModes = new Map<TextTrack, TextTrackMode>();
  private readonly markedCaptions = new Set<HTMLElement>();
  private additionalSelectors: readonly string[];
  private preferredVideo: HTMLVideoElement | null = null;
  private hasPreferredVideo = false;
  private hidden = false;
  private refreshQueued = false;
  private observedTrackList: TextTrackList | null = null;
  private readonly observer: MutationObserver;

  constructor(
    additionalSelectors: readonly string[] = [],
    preemptiveSelectors: readonly string[] = [],
  ) {
    this.additionalSelectors = [...additionalSelectors];
    this.style.dataset.norixortransUi = "native-subtitle-visibility";
    this.style.textContent = visibilityStyle(preemptiveSelectors);
    this.ensureStyleMounted();
    this.observer = new MutationObserver(() => this.queueRefresh());
    this.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "class",
        "id",
        "data-testid",
        DYNAMIC_NATIVE_CAPTION_ATTRIBUTE,
      ],
    });
  }

  updateAdditionalSelectors(
    selectors: readonly string[],
    preemptiveSelectors: readonly string[] = [],
  ): void {
    this.additionalSelectors = [...selectors];
    this.style.textContent = visibilityStyle(preemptiveSelectors);
    this.ensureStyleMounted();
    this.refresh();
  }

  setVideo(video: HTMLVideoElement | null): void {
    if (this.hasPreferredVideo && video === this.preferredVideo) return;
    this.preferredVideo?.removeEventListener(
      "enterpictureinpicture",
      this.handlePictureInPictureChange,
    );
    this.preferredVideo?.removeEventListener(
      "leavepictureinpicture",
      this.handlePictureInPictureChange,
    );
    this.restoreHtml5Tracks();
    this.bindTrackList(null);
    this.clearMarkedCaptions();
    this.hasPreferredVideo = true;
    this.preferredVideo = video;
    this.bindTrackList(video?.textTracks ?? null);
    video?.addEventListener(
      "enterpictureinpicture",
      this.handlePictureInPictureChange,
    );
    video?.addEventListener(
      "leavepictureinpicture",
      this.handlePictureInPictureChange,
    );
    this.refresh();
  }

  update(hidden: boolean): void {
    this.hidden = hidden;
    this.ensureStyleMounted();
    document.documentElement.toggleAttribute(HIDDEN_ATTRIBUTE, hidden);
    if (hidden) {
      this.hideHtml5Tracks();
      this.markActiveCaptions();
    } else {
      this.restoreHtml5Tracks();
      this.clearMarkedCaptions();
    }
  }

  refresh(): void {
    if (!this.hidden) return;
    this.ensureStyleMounted();
    this.bindTrackList(this.activeVideo()?.textTracks ?? null);
    this.hideHtml5Tracks();
    this.markActiveCaptions();
  }

  destroy(): void {
    this.hidden = false;
    this.observer.disconnect();
    this.bindTrackList(null);
    document.documentElement.removeAttribute(HIDDEN_ATTRIBUTE);
    this.restoreHtml5Tracks();
    this.clearMarkedCaptions();
    this.preferredVideo?.removeEventListener(
      "enterpictureinpicture",
      this.handlePictureInPictureChange,
    );
    this.preferredVideo?.removeEventListener(
      "leavepictureinpicture",
      this.handlePictureInPictureChange,
    );
    this.style.remove();
  }

  private readonly handlePictureInPictureChange = (): void => {
    this.restoreHtml5Tracks();
    this.clearMarkedCaptions();
    if (!this.isNativePictureInPictureActive()) this.refresh();
  };

  private hideHtml5Tracks(): void {
    const video = this.activeVideo();
    if (!video || this.isNativePictureInPictureActive(video)) return;
    this.bindTrackList(video.textTracks);
    for (const track of Array.from(video.textTracks)) {
      if (
        (track.kind === "subtitles" || track.kind === "captions") &&
        track.mode === "showing"
      ) {
        this.originalTrackModes.set(track, track.mode);
        track.mode = "hidden";
      }
    }
  }

  private markActiveCaptions(): void {
    this.clearMarkedCaptions();
    const video = this.activeVideo();
    if (!video || this.isNativePictureInPictureActive(video)) return;
    const selectors = [
      ...this.additionalSelectors,
      `[${DYNAMIC_NATIVE_CAPTION_ATTRIBUTE}]`,
    ];
    const candidates = new Set<HTMLElement>();
    for (const selector of selectors) {
      try {
        for (const element of document.querySelectorAll<HTMLElement>(
          selector,
        )) {
          candidates.add(element);
        }
      } catch {
        // Invalid user selectors are ignored without weakening other profiles.
      }
    }
    for (const caption of captionsForVideo([...candidates], video).filter(
      (candidate) => captionPresentationBelongsToVideo(candidate, video),
    )) {
      caption.setAttribute(ACTIVE_CAPTION_ATTRIBUTE, "");
      this.markedCaptions.add(caption);
    }
  }

  private readonly queueRefresh = (): void => {
    if (!this.hidden || this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      if (this.hidden) this.refresh();
    });
  };

  private ensureStyleMounted(): void {
    const target = document.head ?? document.documentElement;
    if (this.style.parentElement !== target) target.append(this.style);
  }

  private bindTrackList(trackList: TextTrackList | null): void {
    if (trackList === this.observedTrackList) return;
    const previous = this.observedTrackList;
    if (typeof previous?.removeEventListener === "function") {
      previous.removeEventListener("change", this.queueRefresh);
      previous.removeEventListener("addtrack", this.queueRefresh);
      previous.removeEventListener("removetrack", this.queueRefresh);
    }
    const next = trackList;
    this.observedTrackList =
      typeof next?.addEventListener === "function" ? trackList : null;
    if (typeof next?.addEventListener === "function") {
      next.addEventListener("change", this.queueRefresh);
      next.addEventListener("addtrack", this.queueRefresh);
      next.addEventListener("removetrack", this.queueRefresh);
    }
  }

  private clearMarkedCaptions(): void {
    for (const caption of this.markedCaptions) {
      caption.removeAttribute(ACTIVE_CAPTION_ATTRIBUTE);
    }
    this.markedCaptions.clear();
  }

  private activeVideo(): HTMLVideoElement | null {
    if (this.hasPreferredVideo) {
      return this.preferredVideo?.isConnected ? this.preferredVideo : null;
    }
    return selectActiveVideo("video");
  }

  private isNativePictureInPictureActive(video = this.activeVideo()): boolean {
    return (
      video !== null &&
      (
        document as Document & {
          pictureInPictureElement?: Element | null;
        }
      ).pictureInPictureElement === video
    );
  }

  private restoreHtml5Tracks(): void {
    for (const [track, mode] of this.originalTrackModes) {
      if (track.mode === "hidden") track.mode = mode;
    }
    this.originalTrackModes.clear();
  }
}
