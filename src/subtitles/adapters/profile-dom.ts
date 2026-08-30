import {
  appendLiveStreamCue,
  type SubtitleAdapter,
} from "@/src/subtitles/adapters/types";
import { profileMatchesLocation } from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";
import {
  isExcludedDomCaptionElement,
  isWithinVideoCaptionArea,
  normalizedDomCaptionText,
} from "@/src/subtitles/dom-candidate";
import {
  mutationTouchesCaptionSelector,
  visibleCaptionText,
} from "@/src/subtitles/adapters/dom-visibility";
import {
  captionsForVideo,
  selectActiveVideo,
  videoSessionScope,
} from "@/src/subtitles/video-selection";
import { DYNAMIC_NATIVE_CAPTION_ATTRIBUTE } from "@/src/subtitles/native-visibility";

const GENERIC_HEURISTIC_PROFILE_ID = "default-dom-heuristic";

function pageRouteKey(value = location.href): string {
  const url = new URL(value);
  if (!/^#(?:!\/|\/)/u.test(url.hash)) url.hash = "";
  return url.href;
}

function visibleText(element: HTMLElement): string {
  if (
    isExcludedDomCaptionElement(element) ||
    element.closest("[data-noritrans-ui]") ||
    element.closest("noritrans-translation") ||
    element.hidden ||
    element.getAttribute("aria-hidden") === "true" ||
    element.getAttribute("translate") === "no" ||
    element.classList.contains("notranslate") ||
    element.matches(
      'script,style,noscript,code,pre,form,input,textarea,select,option,[contenteditable="true"],[role="status"],[role="alert"],[role="log"]',
    )
  ) {
    return "";
  }
  return normalizedDomCaptionText(visibleCaptionText(element));
}

export class ProfileDomSubtitleAdapter implements SubtitleAdapter {
  readonly id: string;
  readonly priority: number;
  private latestTrack: SubtitleTrack | null = null;
  private streamCues: SubtitleCue[] = [];
  private streamSequence = 0;
  private previousStreamCue: SubtitleCue | null = null;
  private lastVisibleText = "";
  private sessionKey = "";
  private pendingSeekReset = false;
  private awaitingFreshDomCapture = false;
  private preferredVideo: HTMLVideoElement | null = null;
  private readonly markedNativeCaptionElements = new Set<HTMLElement>();
  private readonly invalidationListeners = new Set<() => void>();

  constructor(
    private readonly profile: SubtitleSiteProfile,
    private readonly observeChanges = true,
    priority = profile.priority,
  ) {
    this.id = `profile:${profile.id}`;
    this.priority = priority;
  }

  matches(location: Location): boolean {
    return profileMatchesLocation(this.profile, location);
  }

  setPreferredVideo(video: HTMLVideoElement | null): void {
    if (video === this.preferredVideo) return;
    this.preferredVideo = video;
    if (this.sessionKey) {
      this.refreshPage(video);
    }
  }

  collect(): Promise<SubtitleTrack | null> {
    this.refreshPage();
    this.captureVisibleCue();
    return Promise.resolve(this.latestTrack);
  }

  subscribe(listener: (track: SubtitleTrack) => void): () => void {
    if (!this.observeChanges) return () => undefined;
    let timer: number | undefined;
    let stopped = false;
    let pendingFreshDomMutation = false;
    const emit = (): void => {
      if (stopped) return;
      const track = this.captureVisibleCue(pendingFreshDomMutation);
      pendingFreshDomMutation = false;
      if (track) listener(track);
    };
    const schedule = (freshDomMutation = false): void => {
      pendingFreshDomMutation ||= freshDomMutation;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        emit();
      }, 80);
    };
    const selector = this.profile.selectors.captions.join(",");
    const observer = new MutationObserver((records) => {
      if (!selector || mutationTouchesCaptionSelector(records, selector)) {
        schedule(true);
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden"],
    });
    const handleSeeking = (event: Event): void => {
      if (
        event.target !==
        selectActiveVideo(this.profile.selectors.video, this.preferredVideo)
      ) {
        return;
      }
      this.pendingSeekReset = true;
      schedule();
    };
    const handleMediaContextChange = (event: Event): void => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      schedule();
    };
    const handleMediaSourceReset = (event: Event): void => {
      if (
        !(event.target instanceof HTMLVideoElement) ||
        event.target !==
          selectActiveVideo(this.profile.selectors.video, this.preferredVideo)
      ) {
        return;
      }
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timer = undefined;
      }
      observer.takeRecords();
      this.refreshPage(event.target);
      this.resetStream();
      this.awaitingFreshDomCapture = true;
    };
    document.addEventListener("seeking", handleSeeking, true);
    document.addEventListener("play", handleMediaContextChange, true);
    document.addEventListener("loadedmetadata", handleMediaContextChange, true);
    document.addEventListener("loadstart", handleMediaSourceReset, true);
    document.addEventListener("emptied", handleMediaSourceReset, true);
    emit();
    return () => {
      stopped = true;
      observer.disconnect();
      document.removeEventListener("seeking", handleSeeking, true);
      document.removeEventListener("play", handleMediaContextChange, true);
      document.removeEventListener(
        "loadedmetadata",
        handleMediaContextChange,
        true,
      );
      document.removeEventListener("loadstart", handleMediaSourceReset, true);
      document.removeEventListener("emptied", handleMediaSourceReset, true);
      if (timer !== undefined) window.clearTimeout(timer);
      this.clearMarkedNativeCaptions();
    };
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  private refreshPage(
    video = selectActiveVideo(
      this.profile.selectors.video,
      this.preferredVideo,
    ),
  ): void {
    const pageKey = pageRouteKey();
    const nextSessionKey = `${pageKey}|${videoSessionScope(video)}`;
    if (!this.sessionKey) {
      this.sessionKey = nextSessionKey;
      return;
    }
    if (nextSessionKey === this.sessionKey) return;
    this.sessionKey = nextSessionKey;
    this.resetStream();
    this.awaitingFreshDomCapture = true;
  }

  private resetStream(): void {
    const invalidated = this.latestTrack !== null || this.streamCues.length > 0;
    this.latestTrack = null;
    this.streamCues = [];
    this.previousStreamCue = null;
    this.lastVisibleText = "";
    this.pendingSeekReset = false;
    this.clearMarkedNativeCaptions();
    if (invalidated) {
      for (const listener of this.invalidationListeners) listener();
    }
  }

  private captureVisibleCue(hasFreshDomMutation = false): SubtitleTrack | null {
    const video = selectActiveVideo(
      this.profile.selectors.video,
      this.preferredVideo,
    );
    this.refreshPage(video);
    if (this.awaitingFreshDomCapture) {
      if (!hasFreshDomMutation) return this.latestTrack;
      this.awaitingFreshDomCapture = false;
    }
    const selector = this.profile.selectors.captions.join(",");
    if (!selector) return this.latestTrack;
    let elements: HTMLElement[];
    try {
      elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
    } catch {
      return this.latestTrack;
    }
    const visibleCaptions = captionsForVideo(
      elements,
      video,
      this.profile.selectors.video,
    )
      .filter((element) => video && isWithinVideoCaptionArea(element, video))
      .flatMap((element) => {
        const text = visibleText(element);
        return text ? [{ element, text }] : [];
      });
    const originalText = visibleCaptions
      .map(({ text }) => text)
      .filter((text, index, values) => values.indexOf(text) === index)
      .slice(-8)
      .join("\n")
      .trim()
      .slice(0, 1_000);
    const startMs = Math.max(0, Math.round((video?.currentTime ?? 0) * 1_000));
    if (
      this.pendingSeekReset ||
      (this.previousStreamCue &&
        startMs + 1_000 < this.previousStreamCue.startMs)
    ) {
      this.resetStream();
    }
    this.updateMarkedNativeCaptions(
      visibleCaptions.map(({ element }) => element),
    );
    if (!originalText) {
      if (this.previousStreamCue && this.lastVisibleText) {
        this.previousStreamCue.endMs = Math.max(
          this.previousStreamCue.startMs,
          startMs,
        );
        this.latestTrack = this.track();
      }
      this.lastVisibleText = "";
      return this.latestTrack;
    }
    if (originalText === this.lastVisibleText) return null;
    if (this.previousStreamCue) {
      this.previousStreamCue.endMs = Math.max(
        this.previousStreamCue.startMs,
        startMs,
      );
    }
    const cue: SubtitleCue = {
      id: `${this.profile.id}-${startMs}-${++this.streamSequence}`,
      startMs,
      endMs: null,
      originalText,
    };
    this.previousStreamCue = cue;
    this.lastVisibleText = originalText;
    appendLiveStreamCue(this.streamCues, cue);
    this.latestTrack = this.track();
    return this.latestTrack;
  }

  private updateMarkedNativeCaptions(elements: readonly HTMLElement[]): void {
    if (this.profile.id !== GENERIC_HEURISTIC_PROFILE_ID) return;
    const current = new Set(elements);
    for (const element of this.markedNativeCaptionElements) {
      if (!current.has(element)) {
        element.removeAttribute(DYNAMIC_NATIVE_CAPTION_ATTRIBUTE);
        this.markedNativeCaptionElements.delete(element);
      }
    }
    for (const element of current) {
      element.setAttribute(DYNAMIC_NATIVE_CAPTION_ATTRIBUTE, "");
      this.markedNativeCaptionElements.add(element);
    }
  }

  private clearMarkedNativeCaptions(): void {
    for (const element of this.markedNativeCaptionElements) {
      element.removeAttribute(DYNAMIC_NATIVE_CAPTION_ATTRIBUTE);
    }
    this.markedNativeCaptionElements.clear();
  }

  private track(): SubtitleTrack {
    return {
      source: "dom",
      completeness: "stream",
      language: "und",
      cues: [...this.streamCues],
    };
  }
}
