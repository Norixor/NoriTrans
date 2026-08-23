import { languageTagsMatch } from "@/src/shared/languages";
import { mergeCapturedStreamTrack } from "@/src/subtitles/adapters/captured-track";
import {
  assembleMaxDashFullTrack,
  isMaxDashFullTrackBody,
} from "@/src/subtitles/adapters/max-dash";
import { parseCapturedVtt } from "@/src/subtitles/adapters/captured-vtt";
import {
  assembleHlsVttFullTrack,
  isHlsVttFullTrackBody,
} from "@/src/subtitles/adapters/hls-vtt";
import {
  capturedPayloadMatchesMedia,
  profileAllowsCapturedSubtitlePayload,
  subscribeToCapturedSubtitles,
  type CapturedSubtitlePayload,
  type SubtitleCaptureSite,
} from "@/src/subtitles/adapters/captured";
import type { SubtitleAdapter } from "@/src/subtitles/adapters/types";
import { parseTtml } from "@/src/subtitles/parsers/ttml";
import { profileMatchesLocation } from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import type { SubtitleTrack } from "@/src/subtitles/types";
import {
  DECLARATIVE_CAPTURE_PROFILE_IDS,
  type DeclarativeCaptureProfileId,
} from "@/src/subtitles/profiles/catalog";
import {
  selectActiveVideo,
  stableVideoCaptureScope,
  videoSessionScope,
} from "@/src/subtitles/video-selection";

type CapturedProfileSite = Extract<
  SubtitleCaptureSite,
  DeclarativeCaptureProfileId
>;

const CAPTURED_PROFILE_SITES = new Set<CapturedProfileSite>([
  ...DECLARATIVE_CAPTURE_PROFILE_IDS,
]);

function capturedProfileSite(
  profile: SubtitleSiteProfile,
): CapturedProfileSite {
  if (!CAPTURED_PROFILE_SITES.has(profile.id as CapturedProfileSite)) {
    throw new Error(`Unsupported captured subtitle profile: ${profile.id}`);
  }
  return profile.id as CapturedProfileSite;
}

function pageRouteKey(value = location.href): string {
  try {
    const url = new URL(value);
    if (!/^#(?:!\/|\/)/u.test(url.hash)) url.hash = "";
    return url.href;
  } catch {
    return value.split("#", 1)[0] ?? value;
  }
}

function payloadLanguage(payload: CapturedSubtitlePayload): string | undefined {
  try {
    const url = new URL(payload.url, location.href);
    for (const [key, value] of url.searchParams) {
      if (
        [
          "lang",
          "language",
          "languagecode",
          "language_code",
          "locale",
        ].includes(key.toLowerCase()) &&
        value.trim()
      ) {
        return value.trim();
      }
    }
  } catch {
    // The capture boundary has already rejected invalid URLs.
  }
  return undefined;
}

function isVerifiedCompleteFile(
  profile: SubtitleSiteProfile,
  payload: CapturedSubtitlePayload,
): boolean {
  if (
    payload.partial !== false ||
    payload.requestRange !== false ||
    payload.contentRange ||
    payload.responseStatus === undefined ||
    payload.responseStatus < 200 ||
    payload.responseStatus >= 300
  ) {
    return false;
  }
  const patterns = profile.capture.completeFilePatterns;
  if (!patterns || patterns.length === 0) return false;
  try {
    const url = new URL(payload.url, location.href);
    const resource = `${url.pathname}${url.search}`.toLowerCase();
    return patterns.some((pattern) => resource.includes(pattern.toLowerCase()));
  } catch {
    return false;
  }
}

function parsePayload(
  profile: SubtitleSiteProfile,
  payload: CapturedSubtitlePayload,
  sourceLanguage: string,
): SubtitleTrack | null {
  if (
    profile.id === "max" &&
    payload.manifestCandidate === true &&
    isMaxDashFullTrackBody(payload.body)
  ) {
    if (
      sourceLanguage !== "auto" &&
      !languageTagsMatch(sourceLanguage, payload.body.language)
    ) {
      return null;
    }
    return assembleMaxDashFullTrack(payload.body);
  }
  if (
    (profile.id === "max" ||
      profile.id === "disney-plus" ||
      profile.id === "prime-video") &&
    payload.manifestCandidate === true &&
    isHlsVttFullTrackBody(payload.body)
  ) {
    if (
      sourceLanguage !== "auto" &&
      !languageTagsMatch(sourceLanguage, payload.body.language)
    ) {
      return null;
    }
    return assembleHlsVttFullTrack(payload.body);
  }
  if (typeof payload.body !== "string") return null;
  const body = payload.body.replace(/^\uFEFF/u, "").trim();
  if (!body) return null;

  const capturedLanguage = payloadLanguage(payload);
  if (
    sourceLanguage !== "auto" &&
    capturedLanguage !== undefined &&
    !languageTagsMatch(sourceLanguage, capturedLanguage)
  ) {
    return null;
  }
  const language =
    capturedLanguage ??
    (sourceLanguage === "auto" ? undefined : sourceLanguage);

  try {
    let track: SubtitleTrack;
    if (
      profile.capture.formats.includes("vtt") &&
      /^WEBVTT(?:\s|$)/iu.test(body)
    ) {
      track = parseCapturedVtt(body, language ?? "und");
    } else if (
      profile.capture.formats.includes("ttml") &&
      /^(?:<\?xml\b[\s\S]*?\?>\s*)?<tt(?:\s|>)/iu.test(body)
    ) {
      track = parseTtml(body, language, "network");
    } else {
      return null;
    }
    if (track.cues.length === 0) return null;
    if (
      sourceLanguage !== "auto" &&
      !languageTagsMatch(sourceLanguage, track.language)
    ) {
      return null;
    }
    const verifiedFullResponse = isVerifiedCompleteFile(profile, payload);
    return {
      ...track,
      source: "network",
      completeness: verifiedFullResponse ? "full" : "stream",
      captureEvidence: verifiedFullResponse
        ? "verified-full-response"
        : "live-or-segmented",
    };
  } catch {
    return null;
  }
}

/**
 * Declarative network adapter for built-in streaming profiles. Captured
 * responses remain streaming even when an individual HTTP response is whole.
 */
export class CapturedProfileSubtitleAdapter implements SubtitleAdapter {
  readonly id: string;
  readonly priority: number;
  private readonly site: CapturedProfileSite;
  private latestTrack: SubtitleTrack | null = null;
  private trackIdentity = "";
  private sessionKey = "";
  private sourceLanguage = "auto";
  private preferredVideo: HTMLVideoElement | null = null;
  private readonly invalidationListeners = new Set<() => void>();

  constructor(private readonly profile: SubtitleSiteProfile) {
    this.site = capturedProfileSite(profile);
    this.id = `profile:${profile.id}:network`;
    this.priority = profile.priority;
  }

  matches(locationValue: Location): boolean {
    return profileMatchesLocation(this.profile, locationValue);
  }

  setSourceLanguage(language: string): void {
    if (language === this.sourceLanguage) return;
    this.sourceLanguage = language;
    this.resetTrack();
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
    const stopCapture = subscribeToCapturedSubtitles(this.site, (payload) => {
      const video = this.activeVideo();
      this.refreshSession(video);
      if (!this.matches(location)) return;
      if (!profileAllowsCapturedSubtitlePayload(this.profile, payload)) return;
      if (
        !capturedPayloadMatchesMedia(payload, stableVideoCaptureScope(video))
      ) {
        return;
      }
      const parsedTrack = parsePayload(
        this.profile,
        payload,
        this.sourceLanguage,
      );
      if (!parsedTrack) return;
      if (
        this.latestTrack?.completeness === "full" &&
        parsedTrack.completeness === "stream"
      ) {
        return;
      }
      const nextIdentity = `${parsedTrack.source}|${parsedTrack.language}`;
      if (this.trackIdentity && nextIdentity !== this.trackIdentity) {
        this.resetTrack();
      }
      this.trackIdentity = nextIdentity;
      if (parsedTrack.completeness === "full") {
        this.latestTrack = parsedTrack;
      } else {
        this.latestTrack = mergeCapturedStreamTrack(
          this.latestTrack,
          parsedTrack,
        );
      }
      listener(this.latestTrack);
    });

    const handleMediaContextChange = (event: Event): void => {
      if (event.target instanceof HTMLVideoElement) this.refreshSession();
    };
    const handleRouteChange = (): void => this.refreshSession();
    document.addEventListener("play", handleMediaContextChange, true);
    document.addEventListener("loadedmetadata", handleMediaContextChange, true);
    document.addEventListener("loadstart", handleMediaContextChange, true);
    document.addEventListener("emptied", handleMediaContextChange, true);
    window.addEventListener("popstate", handleRouteChange);
    window.addEventListener("hashchange", handleRouteChange);

    return () => {
      stopCapture();
      document.removeEventListener("play", handleMediaContextChange, true);
      document.removeEventListener(
        "loadedmetadata",
        handleMediaContextChange,
        true,
      );
      document.removeEventListener("loadstart", handleMediaContextChange, true);
      document.removeEventListener("emptied", handleMediaContextChange, true);
      window.removeEventListener("popstate", handleRouteChange);
      window.removeEventListener("hashchange", handleRouteChange);
    };
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  private activeVideo(): HTMLVideoElement | null {
    try {
      return selectActiveVideo(
        this.profile.selectors.video,
        this.preferredVideo,
      );
    } catch {
      return null;
    }
  }

  private refreshSession(video = this.activeVideo()): void {
    const nextSessionKey = [pageRouteKey(), videoSessionScope(video)].join("|");
    if (!this.sessionKey) {
      this.sessionKey = nextSessionKey;
      return;
    }
    if (nextSessionKey === this.sessionKey) return;
    this.sessionKey = nextSessionKey;
    this.resetTrack();
  }

  private resetTrack(): void {
    const invalidated = this.latestTrack !== null;
    this.latestTrack = null;
    this.trackIdentity = "";
    if (invalidated) {
      for (const listener of this.invalidationListeners) listener();
    }
  }
}
