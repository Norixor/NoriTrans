import { parseTtml } from "@/src/subtitles/parsers/ttml";
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
import { languageTagsMatch } from "@/src/shared/languages";
import { siteDiagnostic } from "@/src/shared/diagnostics";
import {
  captionsForVideo,
  selectActiveVideo,
  stableVideoCaptureScope,
  videoSessionScope,
} from "@/src/subtitles/video-selection";

import {
  capturedPayloadMatchesMedia,
  isAllowedSubtitleCaptureUrl,
  profileAllowsCapturedSubtitlePayload,
  subscribeToCapturedSubtitles,
  type CapturedSubtitlePayload,
} from "./captured";
import {
  capturedResponseEvidence,
  capturedTrackShowsContinuousGrowth,
  mergeCapturedStreamTrack,
} from "./captured-track";
import { appendLiveStreamCue, type SubtitleAdapter } from "./types";
import {
  mutationTouchesCaptionSelector,
  visibleCaptionText,
} from "./dom-visibility";
import { parseCapturedVtt } from "./captured-vtt";

const DEFAULT_PROFILE = builtInSiteProfile("netflix");

function diagnosticUrl(value: string): string {
  try {
    const url = new URL(value, location.href);
    return `${url.hostname}${url.pathname}`.slice(0, 240);
  } catch {
    return "invalid-url";
  }
}

function netflixDiagnostic(
  event: string,
  detail: Record<string, unknown>,
): void {
  siteDiagnostic("Netflix", event, detail);
}

function stringsIn(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.flatMap((item) => stringsIn(item, depth + 1));
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap((item) => stringsIn(item, depth + 1));
}

function payloadLanguage(payload: CapturedSubtitlePayload): string | undefined {
  if (payload.language?.trim()) return payload.language.trim();
  try {
    const url = new URL(payload.url, location.href);
    return (
      url.searchParams.get("lang") ||
      url.searchParams.get("language") ||
      url.searchParams.get("languageCode") ||
      undefined
    );
  } catch {
    return undefined;
  }
}

function isSignedNetflixCdnRoot(value: string): boolean {
  try {
    const url = new URL(value, location.href);
    return (
      (url.hostname === "nflxvideo.net" ||
        url.hostname.endsWith(".nflxvideo.net")) &&
      url.pathname === "/" &&
      url.searchParams.has("o") &&
      url.searchParams.has("v")
    );
  } catch {
    return false;
  }
}

function payloadEvidence(
  payload: CapturedSubtitlePayload,
): SubtitleCaptureEvidence {
  try {
    const url = new URL(payload.url, location.href);
    // Netflix uses signed root CDN URLs for subtitle windows as playback
    // advances. The URL contains no range marker, but a later response can
    // still add more cues, so it is not proof of a complete movie track.
    if (isSignedNetflixCdnRoot(payload.url)) {
      // `ttDownloadables` / `downloadUrls` entries in the playback manifest
      // are explicit downloadable subtitle documents. Open-source Netflix
      // subtitle clients consume those URLs as one complete track. Preserve
      // the conservative stream classification for passively observed CDN
      // requests, and promote only a manifest-declared, verified non-range
      // 2xx response.
      if (payload.manifestCandidate === true) {
        return capturedResponseEvidence(payload);
      }
      return "live-or-segmented";
    }
    if (
      [...url.searchParams.keys()].some((key) =>
        /^(?:chunk|end|offset|range|segment|seq|start)$/iu.test(key),
      ) ||
      /(?:^|[/_.-])(?:chunk|segment)[/_.-]?\d+/iu.test(url.pathname)
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

function fnv1a(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function capturedTrackSignature(track: SubtitleTrack): string {
  const serialized = track.cues
    .map(
      (cue) =>
        `${cue.startMs}\u001f${cue.endMs ?? ""}\u001f${cue.originalText}`,
    )
    .join("\u001e");
  return `${track.language}:${track.cues.length}:${fnv1a(serialized)}`;
}

interface TimelineCoverage {
  coversVideo: boolean;
  durationMs: number | null;
  firstCueMs: number | null;
  lastCueMs: number | null;
}

/**
 * A repeated static response is still not enough by itself: Netflix can keep a
 * playback window stable while paused. Require that the parsed cue timeline
 * starts reasonably near the beginning and reaches the final part of a finite
 * video before allowing AI pretranslation of the track.
 */
function timelineCoverage(
  track: SubtitleTrack,
  video: HTMLVideoElement | null,
): TimelineCoverage {
  const firstCueMs = track.cues.reduce(
    (first, cue) => Math.min(first, cue.startMs),
    Number.POSITIVE_INFINITY,
  );
  const lastCueMs = track.cues.reduce(
    (last, cue) => Math.max(last, cue.endMs ?? cue.startMs),
    Number.NEGATIVE_INFINITY,
  );
  const durationMs = video?.duration;
  if (
    !Number.isFinite(durationMs) ||
    durationMs === undefined ||
    durationMs <= 0 ||
    track.cues.length < 20
  ) {
    return {
      coversVideo: false,
      durationMs: null,
      firstCueMs: Number.isFinite(firstCueMs) ? firstCueMs : null,
      lastCueMs: Number.isFinite(lastCueMs) ? lastCueMs : null,
    };
  }
  const finiteDurationMs = Math.round(durationMs * 1_000);
  if (!Number.isFinite(firstCueMs) || !Number.isFinite(lastCueMs)) {
    return {
      coversVideo: false,
      durationMs: finiteDurationMs,
      firstCueMs: null,
      lastCueMs: null,
    };
  }
  const endToleranceMs = Math.max(
    60_000,
    Math.min(300_000, finiteDurationMs * 0.15),
  );
  const latestAllowedStartMs = Math.max(
    120_000,
    Math.min(600_000, finiteDurationMs * 0.25),
  );
  return {
    coversVideo:
      firstCueMs <= latestAllowedStartMs &&
      lastCueMs >= finiteDurationMs - endToleranceMs &&
      lastCueMs - firstCueMs >= finiteDurationMs * 0.6,
    durationMs: finiteDurationMs,
    firstCueMs,
    lastCueMs,
  };
}

interface StableCapturedDocument {
  signature: string;
  matches: number;
}

function parsePayload(
  payload: CapturedSubtitlePayload,
  sourceLanguage: string,
): SubtitleTrack | null {
  if (!isAllowedSubtitleCaptureUrl("netflix", payload.url)) return null;
  const candidates =
    typeof payload.body === "string" ? [payload.body] : stringsIn(payload.body);
  const language = payloadLanguage(payload);
  const tracks: SubtitleTrack[] = [];
  for (const candidate of candidates) {
    const body = candidate.trim();
    if (body.length < 8) continue;
    try {
      if (body.startsWith("WEBVTT")) {
        const track = parseCapturedVtt(body, language ?? "und");
        if (track.cues.length > 0) tracks.push(track);
        continue;
      }
      if (/^<\?xml|^<tt[\s>]/i.test(body)) {
        const track = parseTtml(body, language, "netflix-manifest");
        if (track.cues.length > 0) tracks.push(track);
      }
    } catch {
      // A manifest may contain non-subtitle strings; continue searching safely.
    }
  }
  if (sourceLanguage === "auto") return tracks[0] ?? null;
  return (
    tracks.find((track) => languageTagsMatch(sourceLanguage, track.language)) ??
    null
  );
}

export class NetflixSubtitleAdapter implements SubtitleAdapter {
  readonly id = "netflix";
  readonly priority = 3;
  private latestTrack: SubtitleTrack | null = null;
  private capturedTrackIdentity = "";
  private capturedStreamTrack: SubtitleTrack | null = null;
  /** A verified complete document outranks later passive windows and DOM cues. */
  private capturedManifestFull = false;
  /** Keep one verified variant stable for the lifetime of the player session. */
  private capturedFullTrackSignature = "";
  private readonly previousCapturedTracks = new Map<string, SubtitleTrack>();
  private readonly growingCapturedTrackIdentities = new Set<string>();
  private readonly stableCapturedDocuments = new Map<
    string,
    StableCapturedDocument
  >();
  private streamCues: SubtitleCue[] = [];
  private streamSequence = 0;
  private previousStreamCue: SubtitleCue | null = null;
  private lastVisibleText = "";
  private sessionKey = "";
  private pendingSeekReset = false;
  private lastDomDiagnosticCount = 0;
  private sourceLanguage = "auto";
  private preferredVideo: HTMLVideoElement | null = null;
  private readonly invalidationListeners = new Set<() => void>();

  constructor(
    private readonly profile: SubtitleSiteProfile = DEFAULT_PROFILE,
  ) {}

  setSourceLanguage(language: string): void {
    this.sourceLanguage = language;
  }

  setPreferredVideo(video: HTMLVideoElement | null): void {
    if (video === this.preferredVideo) return;
    this.preferredVideo = video;
    if (this.sessionKey) this.refreshSession();
  }

  private mediaSessionKey(): string {
    const video = selectActiveVideo(
      this.profile.selectors.video,
      this.preferredVideo,
    );
    return [
      location.href.split("#", 1)[0] ?? location.href,
      videoSessionScope(video),
    ].join("|");
  }

  private refreshSession(): void {
    const nextKey = this.mediaSessionKey();
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
    this.capturedManifestFull = false;
    this.capturedFullTrackSignature = "";
    this.previousCapturedTracks.clear();
    this.growingCapturedTrackIdentities.clear();
    this.stableCapturedDocuments.clear();
    this.streamCues = [];
    this.previousStreamCue = null;
    this.lastVisibleText = "";
    this.pendingSeekReset = false;
    this.lastDomDiagnosticCount = 0;
    if (invalidated) {
      for (const listener of this.invalidationListeners) listener();
    }
  }

  matches(location: Location): boolean {
    return profileMatchesLocation(this.profile, location);
  }

  collect(): Promise<SubtitleTrack | null> {
    this.refreshSession();
    return Promise.resolve(this.latestTrack);
  }

  subscribe(listener: (track: SubtitleTrack) => void): () => void {
    const captionSelector = profileCaptionSelector(this.profile);
    let pendingStableDocument:
      | {
          track: SubtitleTrack;
          resource: string;
          pageKey: string;
          stableMatches: number;
          deadline: number;
        }
      | undefined;
    let pendingStableTimer: number | undefined;
    const clearPendingStableDocument = (): void => {
      pendingStableDocument = undefined;
      if (pendingStableTimer !== undefined) {
        window.clearTimeout(pendingStableTimer);
        pendingStableTimer = undefined;
      }
    };
    const tryPromotePendingStableDocument = (): void => {
      if (!pendingStableDocument) return;
      if (pendingStableTimer !== undefined) {
        window.clearTimeout(pendingStableTimer);
        pendingStableTimer = undefined;
      }
      const candidate = pendingStableDocument;
      const currentPageKey = location.href.split("#", 1)[0] ?? location.href;
      if (candidate.pageKey !== currentPageKey) {
        clearPendingStableDocument();
        return;
      }
      // The first subtitle response can arrive before Netflix creates the
      // video element. Refreshing the media session must not discard that
      // already verified response; the candidate is bound to the watch URL.
      this.refreshSession();
      const coverage = timelineCoverage(
        candidate.track,
        selectActiveVideo(this.profile.selectors.video, this.preferredVideo),
      );
      if (coverage.coversVideo) {
        const fullTrack: SubtitleTrack = {
          ...candidate.track,
          source: "netflix-manifest",
          completeness: "full",
          captureEvidence: "verified-full-response",
        };
        const trackIdentity = `${fullTrack.source}|${fullTrack.language}`;
        this.capturedTrackIdentity = trackIdentity;
        this.capturedStreamTrack = null;
        this.capturedManifestFull = true;
        this.capturedFullTrackSignature = capturedTrackSignature(fullTrack);
        this.previousCapturedTracks.set(trackIdentity, fullTrack);
        this.latestTrack = fullTrack;
        clearPendingStableDocument();
        netflixDiagnostic("track-classified", {
          resource: candidate.resource,
          language: fullTrack.language,
          cues: fullTrack.cues.length,
          completeness: "full",
          evidence: "verified-full-response",
          manifestCandidate: false,
          responseStatus: 200,
          partial: false,
          stableMatches: candidate.stableMatches,
          verifiedStableDocument: true,
          promotion: "video-metadata-ready",
          durationMs: coverage.durationMs ?? "unknown",
          firstCueMs: coverage.firstCueMs ?? "unknown",
          lastCueMs: coverage.lastCueMs ?? "unknown",
        });
        listener(fullTrack);
        return;
      }
      if (coverage.durationMs !== null || Date.now() >= candidate.deadline) {
        netflixDiagnostic("stable-document-not-full", {
          resource: candidate.resource,
          cues: candidate.track.cues.length,
          stableMatches: candidate.stableMatches,
          durationMs: coverage.durationMs ?? "unknown",
          firstCueMs: coverage.firstCueMs ?? "unknown",
          lastCueMs: coverage.lastCueMs ?? "unknown",
        });
        clearPendingStableDocument();
        return;
      }
      pendingStableTimer = window.setTimeout(
        tryPromotePendingStableDocument,
        250,
      );
    };
    const schedulePendingStableDocument = (): void => {
      if (pendingStableTimer !== undefined) return;
      pendingStableTimer = window.setTimeout(
        tryPromotePendingStableDocument,
        250,
      );
    };
    const stopCapture = subscribeToCapturedSubtitles("netflix", (payload) => {
      this.refreshSession();
      if (!profileAllowsCapturedSubtitlePayload(this.profile, payload)) return;
      const activeScope = stableVideoCaptureScope(
        selectActiveVideo(this.profile.selectors.video, this.preferredVideo),
      );
      if (!capturedPayloadMatchesMedia(payload, activeScope)) {
        netflixDiagnostic("capture-rejected-media-scope", {
          resource: diagnosticUrl(payload.url),
          manifestCandidate: payload.manifestCandidate === true,
          capturedVideoCount: payload.videoCount ?? "unknown",
          currentVideoCount: document.querySelectorAll("video").length,
          scopeMatches: payload.mediaScope === activeScope,
        });
        return;
      }
      const parsedTrack = parsePayload(payload, this.sourceLanguage);
      if (!parsedTrack) {
        netflixDiagnostic("capture-parse-empty", {
          resource: diagnosticUrl(payload.url),
          manifestCandidate: payload.manifestCandidate === true,
          responseStatus: payload.responseStatus ?? "unknown",
          contentType: payload.contentType || "unknown",
        });
        return;
      }
      const responseEvidence = capturedResponseEvidence(payload);
      const stableDocumentKey = `${payload.url}|${parsedTrack.language}`;
      const signature = capturedTrackSignature(parsedTrack);
      const previousStableDocument =
        this.stableCapturedDocuments.get(stableDocumentKey);
      const stableMatches =
        previousStableDocument?.signature === signature
          ? Math.min(previousStableDocument.matches + 1, 3)
          : 1;
      if (
        isSignedNetflixCdnRoot(payload.url) &&
        responseEvidence === "verified-full-response"
      ) {
        this.stableCapturedDocuments.set(stableDocumentKey, {
          signature,
          matches: stableMatches,
        });
      } else {
        this.stableCapturedDocuments.delete(stableDocumentKey);
      }
      const coverage = timelineCoverage(
        parsedTrack,
        selectActiveVideo(this.profile.selectors.video, this.preferredVideo),
      );
      const verifiedStableDocument =
        payload.manifestCandidate !== true &&
        isSignedNetflixCdnRoot(payload.url) &&
        responseEvidence === "verified-full-response" &&
        stableMatches >= 2 &&
        coverage.coversVideo;
      const stableDocumentAwaitingMetadata =
        payload.manifestCandidate !== true &&
        isSignedNetflixCdnRoot(payload.url) &&
        responseEvidence === "verified-full-response" &&
        stableMatches >= 2 &&
        coverage.durationMs === null;
      if (verifiedStableDocument) {
        clearPendingStableDocument();
      } else if (stableDocumentAwaitingMetadata) {
        pendingStableDocument = {
          track: parsedTrack,
          resource: diagnosticUrl(payload.url),
          pageKey: location.href.split("#", 1)[0] ?? location.href,
          stableMatches,
          deadline: Date.now() + 15_000,
        };
        schedulePendingStableDocument();
      }
      const evidence = verifiedStableDocument
        ? "verified-full-response"
        : payloadEvidence(payload);
      let capturedTrack: SubtitleTrack = {
        ...parsedTrack,
        source: "netflix-manifest",
        completeness: completenessFromEvidence(evidence),
        captureEvidence: evidence,
      };
      const trackIdentity = `${capturedTrack.source}|${capturedTrack.language}`;
      const previousCapturedTrack =
        this.previousCapturedTracks.get(trackIdentity);
      if (
        payload.manifestCandidate !== true &&
        capturedTrack.captureEvidence === "verified-full-response" &&
        capturedTrackShowsContinuousGrowth(previousCapturedTrack, capturedTrack)
      ) {
        this.growingCapturedTrackIdentities.add(trackIdentity);
      }
      if (
        payload.manifestCandidate === true &&
        capturedTrack.captureEvidence === "verified-full-response"
      ) {
        this.growingCapturedTrackIdentities.delete(trackIdentity);
      }
      this.previousCapturedTracks.set(trackIdentity, capturedTrack);
      if (this.growingCapturedTrackIdentities.has(trackIdentity)) {
        capturedTrack = {
          ...capturedTrack,
          completeness: "stream",
          captureEvidence: "continuous-growth",
        };
      }
      if (trackIdentity !== this.capturedTrackIdentity) {
        this.capturedTrackIdentity = trackIdentity;
        this.capturedStreamTrack = null;
        this.capturedManifestFull = false;
        this.capturedFullTrackSignature = "";
        if (this.latestTrack?.source === "netflix-manifest") {
          this.latestTrack = null;
        }
      }
      if (capturedTrack.completeness === "full") {
        if (
          this.capturedManifestFull &&
          this.latestTrack?.source === "netflix-manifest" &&
          this.latestTrack.completeness === "full" &&
          this.capturedFullTrackSignature &&
          this.capturedFullTrackSignature !== signature
        ) {
          netflixDiagnostic("alternate-full-track-ignored", {
            resource: diagnosticUrl(payload.url),
            language: capturedTrack.language,
            cues: capturedTrack.cues.length,
            activeCues: this.latestTrack.cues.length,
            reason: "keep-verified-session-track-stable",
          });
          return;
        }
        this.capturedStreamTrack = null;
        this.capturedManifestFull = true;
        this.capturedFullTrackSignature = signature;
        this.latestTrack = capturedTrack;
      } else {
        // Resource Timing/fetch interception can observe a rolling subtitle
        // window after the manifest recovery has already supplied the complete
        // document. Downgrading here would cancel an in-flight AI pretranslation
        // and discard its paid results. Only a non-manifest response previously
        // mistaken for full may be corrected by continuous-growth evidence.
        if (
          this.capturedManifestFull &&
          this.latestTrack?.source === capturedTrack.source &&
          this.latestTrack.language === capturedTrack.language &&
          this.latestTrack.completeness === "full"
        ) {
          return;
        }
        if (
          this.latestTrack?.source === capturedTrack.source &&
          this.latestTrack.language === capturedTrack.language &&
          this.latestTrack.completeness === "full" &&
          capturedTrack.captureEvidence === "unknown"
        ) {
          return;
        }
        this.capturedStreamTrack = mergeCapturedStreamTrack(
          this.capturedStreamTrack,
          capturedTrack,
        );
        this.capturedManifestFull = false;
        this.capturedFullTrackSignature = "";
        this.latestTrack = this.capturedStreamTrack;
      }
      netflixDiagnostic("track-classified", {
        resource: diagnosticUrl(payload.url),
        language: this.latestTrack.language,
        cues: this.latestTrack.cues.length,
        completeness: this.latestTrack.completeness,
        evidence: this.latestTrack.captureEvidence ?? "none",
        manifestCandidate: payload.manifestCandidate === true,
        responseStatus: payload.responseStatus ?? "unknown",
        partial: payload.partial === true,
        stableMatches,
        verifiedStableDocument,
        durationMs: coverage.durationMs ?? "unknown",
        firstCueMs: coverage.firstCueMs ?? "unknown",
        lastCueMs: coverage.lastCueMs ?? "unknown",
      });
      listener(this.latestTrack);
    });

    const emitDomCue = (): void => {
      const video = selectActiveVideo(
        this.profile.selectors.video,
        this.preferredVideo,
      );
      this.refreshSession();
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
        id: `netflix-dom-${startMs}-${++this.streamSequence}`,
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
      if (
        this.streamCues.length === 1 ||
        this.streamCues.length - this.lastDomDiagnosticCount >= 25
      ) {
        this.lastDomDiagnosticCount = this.streamCues.length;
        netflixDiagnostic("dom-stream-progress", {
          cues: this.streamCues.length,
          completeness: "stream",
          source: "dom",
        });
      }
      listener(this.latestTrack);
    };

    let emitTimer: number | undefined;
    const scheduleDomCue = (): void => {
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
      tryPromotePendingStableDocument();
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
      this.refreshSession();
      this.resetStream();
    };
    document.addEventListener("seeking", handleSeeking, true);
    document.addEventListener("play", handleMediaContextChange, true);
    document.addEventListener("loadedmetadata", handleMediaContextChange, true);
    document.addEventListener("loadstart", handleMediaSourceReset, true);
    document.addEventListener("emptied", handleMediaSourceReset, true);
    emitDomCue();

    return () => {
      stopCapture();
      clearPendingStableDocument();
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
