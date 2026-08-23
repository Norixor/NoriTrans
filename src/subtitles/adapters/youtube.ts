import { parseVtt } from "@/src/subtitles/parsers/vtt";
import { parseYouTubeJson3 } from "@/src/subtitles/parsers/youtube";
import {
  builtInSiteProfile,
  profileCaptionSelector,
  profileMatchesLocation,
} from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import type {
  SubtitleCaptureEvidence,
  SubtitleCue,
  SubtitleTrack,
} from "@/src/subtitles/types";
import {
  captionsForVideo,
  selectActiveVideo,
  stableVideoCaptureScope,
  videoSessionScope,
} from "@/src/subtitles/video-selection";

import {
  capturedPayloadMatchesMedia,
  profileAllowsCapturedSubtitlePayload,
  subscribeToCapturedSubtitles,
  type CapturedSubtitlePayload,
} from "./captured";
import {
  capturedResponseEvidence,
  mergeCapturedStreamTrack,
} from "./captured-track";
import { appendLiveStreamCue, type SubtitleAdapter } from "./types";
import {
  mutationTouchesCaptionSelector,
  visibleCaptionText,
} from "./dom-visibility";

const DEFAULT_PROFILE = builtInSiteProfile("youtube");

function captureEvidence(
  url: string,
  payload: CapturedSubtitlePayload,
): SubtitleCaptureEvidence {
  try {
    const parsedUrl = new URL(url, location.href);
    const hasRangeParameter = [...parsedUrl.searchParams.keys()].some((key) =>
      /^(?:start|end|offset|chunk|segment|seq|sq|range|continuation(?:[_-].*)?|live(?:[_-].*)?)$/iu.test(
        key,
      ),
    );
    if (
      hasRangeParameter ||
      /(?:^|[/_.-])(?:live|chunk|segment|range)(?:[/_.-]|$)/iu.test(
        parsedUrl.pathname,
      )
    ) {
      return "live-or-segmented";
    }
    return capturedResponseEvidence(payload);
  } catch {
    return "unknown";
  }
}

function completenessFromEvidence(
  evidence: SubtitleCaptureEvidence,
): SubtitleTrack["completeness"] {
  return evidence === "verified-full-response" ? "full" : "stream";
}

function parseTimedTextXml(input: string): SubtitleTrack | null {
  const documentNode = new DOMParser().parseFromString(input, "text/xml");
  if (documentNode.querySelector("parsererror")) return null;
  const cues: SubtitleCue[] = Array.from(
    documentNode.querySelectorAll("text"),
  ).flatMap((node, index) => {
    const start = Number(node.getAttribute("start"));
    const duration = Number(node.getAttribute("dur"));
    if (!Number.isFinite(start)) return [];
    const startMs = Math.max(0, Math.round(start * 1_000));
    const endMs = Number.isFinite(duration)
      ? Math.max(startMs, Math.round((start + duration) * 1_000))
      : null;
    const originalText = (node.textContent ?? "").trim();
    if (!originalText) return [];
    return [
      { id: `youtube-${index}-${startMs}`, startMs, endMs, originalText },
    ];
  });
  if (cues.length === 0) return null;
  return {
    source: "youtube-timedtext",
    completeness: "full",
    language: "und",
    cues,
  };
}

function parsePayload(payload: CapturedSubtitlePayload): SubtitleTrack | null {
  if (!/\/api\/timedtext(?:[/?]|$)/i.test(payload.url)) return null;
  let language = "und";
  try {
    const params = new URL(payload.url, location.href).searchParams;
    language = params.get("tlang") || params.get("lang") || "und";
  } catch {
    // A valid capture URL is checked again in the isolated world.
  }
  try {
    const evidence = captureEvidence(payload.url, payload);
    let track: SubtitleTrack | null;
    if (typeof payload.body !== "string") {
      track = parseYouTubeJson3(payload.body, language);
      return track.cues.length > 0
        ? {
            ...track,
            completeness: completenessFromEvidence(evidence),
            captureEvidence: evidence,
          }
        : null;
    }
    const body = payload.body.trim();
    if (!body) return null;
    if (body.startsWith("WEBVTT")) {
      track = parseVtt(body, language, "youtube-timedtext");
      return track.cues.length > 0
        ? {
            ...track,
            completeness: completenessFromEvidence(evidence),
            captureEvidence: evidence,
          }
        : null;
    }
    if (body.startsWith("<")) {
      track = parseTimedTextXml(body);
      return track
        ? {
            ...track,
            language,
            completeness: completenessFromEvidence(evidence),
            captureEvidence: evidence,
          }
        : null;
    }
    track = parseYouTubeJson3(body, language);
    return track.cues.length > 0
      ? {
          ...track,
          completeness: completenessFromEvidence(evidence),
          captureEvidence: evidence,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Keep distinct YouTube caption variants from sharing a rolling stream cache.
 * Signed/auth parameters are intentionally excluded because they can change
 * without changing the selected caption track.
 */
function capturedTrackIdentity(
  payload: CapturedSubtitlePayload,
  track: SubtitleTrack,
): string {
  const identity = [track.source, track.language];
  try {
    const url = new URL(payload.url, location.href);
    for (const key of ["v", "lang", "kind", "name", "tlang"] as const) {
      identity.push(`${key}:${url.searchParams.get(key) ?? ""}`);
    }
  } catch {
    // The capture boundary already validates the URL. Source and language are
    // still a safe fallback if an isolated test supplies an unusual base URL.
  }
  return identity.join("|");
}

export class YouTubeTimedTextAdapter implements SubtitleAdapter {
  readonly id = "youtube-timedtext";
  readonly priority = 2;
  private latestTrack: SubtitleTrack | null = null;
  private sessionKey = "";
  private capturedTrackIdentity = "";
  private capturedStreamTrack: SubtitleTrack | null = null;
  private streamCues: SubtitleCue[] = [];
  private streamSequence = 0;
  private previousStreamCue: SubtitleCue | null = null;
  private lastVisibleText = "";
  private pendingSeekReset = false;
  private preferredVideo: HTMLVideoElement | null = null;
  private readonly invalidationListeners = new Set<() => void>();

  constructor(
    private readonly profile: SubtitleSiteProfile = DEFAULT_PROFILE,
  ) {}

  private refreshSession(
    video = selectActiveVideo(
      this.profile.selectors.video,
      this.preferredVideo,
    ),
  ): void {
    const pageKey = location.href.split("#", 1)[0] ?? location.href;
    const nextKey = `${pageKey}|${videoSessionScope(video)}`;
    if (!this.sessionKey) {
      this.sessionKey = nextKey;
      return;
    }
    if (nextKey === this.sessionKey) return;
    this.sessionKey = nextKey;
    this.resetStream();
  }

  private resetStream(): void {
    const invalidated = this.latestTrack !== null || this.streamCues.length > 0;
    this.latestTrack = null;
    this.capturedTrackIdentity = "";
    this.capturedStreamTrack = null;
    this.streamCues = [];
    this.previousStreamCue = null;
    this.lastVisibleText = "";
    this.pendingSeekReset = false;
    if (invalidated) {
      for (const listener of this.invalidationListeners) listener();
    }
  }

  matches(location: Location): boolean {
    return profileMatchesLocation(this.profile, location);
  }

  setPreferredVideo(video: HTMLVideoElement | null): void {
    if (video === this.preferredVideo) return;
    this.preferredVideo = video;
    if (this.sessionKey) this.refreshSession(video);
  }

  collect(): Promise<SubtitleTrack | null> {
    this.refreshSession();
    return Promise.resolve(this.latestTrack);
  }

  subscribe(listener: (track: SubtitleTrack) => void): () => void {
    const captionSelector = profileCaptionSelector(this.profile);
    const stopCapture = subscribeToCapturedSubtitles("youtube", (payload) => {
      this.refreshSession();
      if (!profileAllowsCapturedSubtitlePayload(this.profile, payload)) return;
      if (
        !capturedPayloadMatchesMedia(
          payload,
          stableVideoCaptureScope(
            selectActiveVideo(
              this.profile.selectors.video,
              this.preferredVideo,
            ),
          ),
        )
      )
        return;
      const parsedTrack = parsePayload(payload);
      if (!parsedTrack) return;
      const track = parsedTrack;
      const trackIdentity = capturedTrackIdentity(payload, track);
      if (trackIdentity !== this.capturedTrackIdentity) {
        this.capturedTrackIdentity = trackIdentity;
        this.capturedStreamTrack = null;
        if (this.latestTrack?.source === "youtube-timedtext") {
          this.latestTrack = null;
        }
      }
      if (track.completeness === "full") {
        this.capturedStreamTrack = null;
        this.latestTrack = track;
      } else {
        if (
          this.latestTrack?.source === track.source &&
          this.latestTrack.language === track.language &&
          this.latestTrack.completeness === "full" &&
          track.captureEvidence === "unknown"
        ) {
          return;
        }
        this.capturedStreamTrack = mergeCapturedStreamTrack(
          this.capturedStreamTrack,
          track,
        );
        this.latestTrack = this.capturedStreamTrack;
      }
      listener(this.latestTrack);
    });

    const emitDomCue = (): void => {
      const video = selectActiveVideo(
        this.profile.selectors.video,
        this.preferredVideo,
      );
      this.refreshSession(video);
      if (this.latestTrack?.completeness === "full") return;
      const originalText = captionsForVideo(
        Array.from(document.querySelectorAll<HTMLElement>(captionSelector)),
        video,
        this.profile.selectors.video,
      )
        .map(visibleCaptionText)
        .filter(Boolean)
        .join("\n")
        .trim();
      const startMs = Math.max(
        0,
        Math.round((video?.currentTime ?? 0) * 1_000),
      );
      if (
        this.pendingSeekReset ||
        (this.previousStreamCue &&
          startMs + 1_000 < this.previousStreamCue.startMs)
      ) {
        this.resetStream();
      }
      if (!originalText) {
        if (this.previousStreamCue && this.lastVisibleText) {
          this.previousStreamCue.endMs = Math.max(
            this.previousStreamCue.startMs,
            startMs,
          );
          this.latestTrack = {
            source: "dom",
            completeness: "stream",
            language: "und",
            cues: [...this.streamCues],
          };
          listener(this.latestTrack);
        }
        this.lastVisibleText = "";
        return;
      }
      if (originalText === this.lastVisibleText) return;
      if (this.previousStreamCue) {
        this.previousStreamCue.endMs = Math.max(
          this.previousStreamCue.startMs,
          startMs,
        );
      }
      const cue: SubtitleCue = {
        id: `youtube-dom-${startMs}-${++this.streamSequence}`,
        startMs,
        endMs: null,
        originalText,
      };
      this.previousStreamCue = cue;
      this.lastVisibleText = originalText;
      appendLiveStreamCue(this.streamCues, cue);
      this.latestTrack = {
        source: "dom",
        completeness: "stream",
        language: "und",
        cues: [...this.streamCues],
      };
      listener(this.latestTrack);
    };

    let emitTimer: number | undefined;
    let stopped = false;
    const scheduleDomCue = (): void => {
      if (stopped) return;
      if (emitTimer !== undefined) window.clearTimeout(emitTimer);
      emitTimer = window.setTimeout(() => {
        emitTimer = undefined;
        emitDomCue();
      }, 60);
    };
    const observer = new MutationObserver((records) => {
      if (mutationTouchesCaptionSelector(records, captionSelector)) {
        scheduleDomCue();
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
      )
        return;
      this.pendingSeekReset = true;
      scheduleDomCue();
    };
    const handleMediaContextChange = (event: Event): void => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      scheduleDomCue();
    };
    const handleMediaSourceReset = (event: Event): void => {
      if (
        !(event.target instanceof HTMLVideoElement) ||
        event.target !==
          selectActiveVideo(this.profile.selectors.video, this.preferredVideo)
      ) {
        return;
      }
      if (emitTimer !== undefined) {
        window.clearTimeout(emitTimer);
        emitTimer = undefined;
      }
      observer.takeRecords();
      const previousSessionKey = this.sessionKey;
      const retainedFullTrack = this.latestTrack?.completeness === "full";
      this.refreshSession(event.target);
      // YouTube can emit a transient loadstart while keeping the same watch
      // item and caption timeline. Discarding a verified full timedtext body at
      // that point makes the DOM fallback overwrite AI pre-translation. A real
      // player/source change already changes the capture session in
      // refreshSession(), which clears the old track before this guard.
      if (
        retainedFullTrack &&
        this.sessionKey === previousSessionKey &&
        this.latestTrack?.completeness === "full"
      ) {
        return;
      }
      this.resetStream();
    };
    document.addEventListener("seeking", handleSeeking, true);
    document.addEventListener("play", handleMediaContextChange, true);
    document.addEventListener("loadedmetadata", handleMediaContextChange, true);
    document.addEventListener("loadstart", handleMediaSourceReset, true);
    document.addEventListener("emptied", handleMediaSourceReset, true);
    emitDomCue();

    return () => {
      stopped = true;
      stopCapture();
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
      if (emitTimer !== undefined) window.clearTimeout(emitTimer);
    };
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }
}
