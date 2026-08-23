export const SUBTITLE_CAPTURE_EVENT = "norixortrans:subtitle-response";
export const SUBTITLE_DISCOVERY_CONTROL_EVENT =
  "norixortrans:subtitle-discovery-control";

import { builtInSiteProfile } from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import {
  MAIN_WORLD_CAPTURE_PROFILE_IDS,
  type DeclarativeCaptureProfileId,
} from "@/src/subtitles/profiles/catalog";
import { isMaxDashFullTrackBody } from "@/src/subtitles/adapters/max-dash";
import { isHlsVttFullTrackBody } from "@/src/subtitles/adapters/hls-vtt";

export type SubtitleCaptureSite =
  "youtube" | "netflix" | DeclarativeCaptureProfileId;

const SUBTITLE_CAPTURE_SITES = new Set<string>(MAIN_WORLD_CAPTURE_PROFILE_IDS);

function isSubtitleCaptureSite(value: unknown): value is SubtitleCaptureSite {
  return typeof value === "string" && SUBTITLE_CAPTURE_SITES.has(value);
}

export interface CapturedSubtitlePayload {
  site: SubtitleCaptureSite;
  pageUrl: string;
  url: string;
  body: string | Record<string, unknown> | unknown[];
  contentType?: string;
  mediaScope?: string;
  videoCount?: number;
  partial?: boolean;
  requestRange?: boolean;
  manifestCandidate?: boolean;
  language?: string;
  responseStatus?: number;
  contentRange?: string;
}

const MAX_CAPTURE_CHARACTERS = 5_000_000;
const CAPTURE_EVENT_WINDOW_MS = 10_000;
const MAX_CAPTURE_EVENTS_PER_WINDOW = 60;
const MAX_CAPTURE_CHARACTERS_PER_WINDOW = 12_000_000;

function matchesDomain(hostname: string, domains: readonly string[]): boolean {
  return domains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}

function isProfileCaptureUrl(
  site: DeclarativeCaptureProfileId,
  url: URL,
): boolean {
  const profile = builtInSiteProfile(site);
  if (!matchesDomain(url.hostname, profile.capture.allowedHostnameSuffixes)) {
    return false;
  }
  const resource = `${url.pathname}${url.search}`.toLowerCase();
  return profile.capture.urlPatterns.some((pattern) =>
    resource.includes(pattern.toLowerCase()),
  );
}

export function isAllowedSubtitleCaptureUrl(
  site: SubtitleCaptureSite,
  value: string,
  baseUrl = location.href,
): boolean {
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (site === "youtube") {
    return (
      matchesDomain(url.hostname, ["youtube.com", "youtube-nocookie.com"]) &&
      /\/api\/timedtext(?:[/?]|$)/iu.test(url.pathname)
    );
  }
  if (site !== "netflix") return isProfileCaptureUrl(site, url);
  if (
    matchesDomain(url.hostname, ["nflxvideo.net"]) &&
    url.pathname === "/" &&
    url.searchParams.has("o") &&
    url.searchParams.has("v")
  ) {
    return true;
  }
  return (
    matchesDomain(url.hostname, ["netflix.com", "nflxso.net"]) &&
    /manifest|timedtexttracks|timedtext|subtitle|\.vtt$|\.ttml$|\.dfxp$/iu.test(
      `${url.pathname}${url.search}`,
    )
  );
}

/** Apply a validated effective Profile as an additional narrowing filter. */
export function profileAllowsCapturedSubtitlePayload(
  profile: SubtitleSiteProfile,
  payload: Pick<CapturedSubtitlePayload, "site" | "url">,
  baseUrl = location.href,
): boolean {
  if (profile.id !== payload.site) return false;
  if (!isAllowedSubtitleCaptureUrl(payload.site, payload.url, baseUrl))
    return false;
  let url: URL;
  try {
    url = new URL(payload.url, baseUrl);
  } catch {
    return false;
  }
  if (!matchesDomain(url.hostname, profile.capture.allowedHostnameSuffixes)) {
    return false;
  }
  if (profile.capture.formats.length === 0) return false;
  if (
    payload.site === "netflix" &&
    matchesDomain(url.hostname, ["nflxvideo.net"]) &&
    url.pathname === "/" &&
    url.searchParams.has("o") &&
    url.searchParams.has("v")
  ) {
    const retainedNetflixDocumentPatterns = new Set([
      "timedtext",
      "subtitle",
      ".vtt",
      ".ttml",
      ".dfxp",
    ]);
    return (
      profile.capture.formats.length > 0 &&
      profile.capture.urlPatterns.some((pattern) =>
        retainedNetflixDocumentPatterns.has(pattern.toLowerCase()),
      )
    );
  }
  const resource = `${url.pathname}${url.search}`.toLowerCase();
  return profile.capture.urlPatterns.some((pattern) =>
    resource.includes(pattern.toLowerCase()),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isCapturedSubtitlePayload(
  value: unknown,
): value is CapturedSubtitlePayload {
  if (!isRecord(value)) return false;
  if (!isSubtitleCaptureSite(value.site)) return false;
  if (
    typeof value.pageUrl !== "string" ||
    value.pageUrl.length === 0 ||
    value.pageUrl.length > 4_096
  )
    return false;
  try {
    const capturedPage = new URL(value.pageUrl);
    const currentPage = new URL(location.href);
    capturedPage.hash = "";
    currentPage.hash = "";
    if (
      capturedPage.origin !== currentPage.origin ||
      capturedPage.href !== currentPage.href
    )
      return false;
  } catch {
    return false;
  }
  if (typeof value.url !== "string" || value.url.length > 16_384) return false;
  if (!isAllowedSubtitleCaptureUrl(value.site, value.url)) return false;
  if (
    typeof value.body !== "string" &&
    !isRecord(value.body) &&
    !Array.isArray(value.body)
  ) {
    return false;
  }
  if (typeof value.body === "string") {
    if (value.body.length > MAX_CAPTURE_CHARACTERS) return false;
  } else {
    try {
      if (JSON.stringify(value.body).length > MAX_CAPTURE_CHARACTERS)
        return false;
    } catch {
      return false;
    }
  }
  if (
    isMaxDashFullTrackBody(value.body) &&
    (value.site !== "max" || value.manifestCandidate !== true)
  ) {
    return false;
  }
  if (
    isHlsVttFullTrackBody(value.body) &&
    value.site !== "max" &&
    value.site !== "disney-plus" &&
    value.site !== "prime-video"
  ) {
    return false;
  }
  if (isHlsVttFullTrackBody(value.body) && value.manifestCandidate !== true) {
    return false;
  }
  return (
    (value.contentType === undefined ||
      (typeof value.contentType === "string" &&
        value.contentType.length <= 256)) &&
    (value.partial === undefined || typeof value.partial === "boolean") &&
    (value.requestRange === undefined ||
      typeof value.requestRange === "boolean") &&
    (value.manifestCandidate === undefined ||
      typeof value.manifestCandidate === "boolean") &&
    (value.language === undefined ||
      (typeof value.language === "string" && value.language.length <= 64)) &&
    (value.responseStatus === undefined ||
      (typeof value.responseStatus === "number" &&
        Number.isInteger(value.responseStatus) &&
        value.responseStatus >= 0 &&
        value.responseStatus <= 599)) &&
    (value.contentRange === undefined ||
      (typeof value.contentRange === "string" &&
        value.contentRange.length <= 512)) &&
    (value.mediaScope === undefined ||
      (typeof value.mediaScope === "string" &&
        value.mediaScope.length <= 4096)) &&
    (value.videoCount === undefined ||
      (typeof value.videoCount === "number" &&
        Number.isInteger(value.videoCount) &&
        value.videoCount >= 0 &&
        value.videoCount <= 1000))
  );
}

/** Rejects real network captures that cannot be tied to one active player. */
export function capturedPayloadMatchesMedia(
  payload: CapturedSubtitlePayload,
  activeMediaScope: string,
): boolean {
  if (payload.mediaScope === activeMediaScope) {
    // A YouTube watch route supplies a stable video id in addition to the
    // selected element and media source. The page commonly retains extra ad,
    // preview, or Shorts video elements, so total video count alone does not
    // make this exact route-and-element match ambiguous.
    if (
      payload.site === "youtube" &&
      /^youtube:[\w-]{6,32}\|/u.test(activeMediaScope)
    ) {
      return true;
    }
    return (
      payload.videoCount === 1 ||
      (payload.videoCount === 0 && activeMediaScope === "video:none")
    );
  }

  // Netflix requests its complete TTML document during player bootstrap, often
  // before the single <video> element or its blob source exists. The exact page
  // URL is already validated above, and this exception is limited to the
  // provider's root subtitle endpoint; segmented/media range captures keep the
  // strict element-source identity check.
  if (
    payload.site === "netflix" &&
    payload.videoCount === 0 &&
    payload.mediaScope === "video:none" &&
    document.querySelectorAll("video").length === 1
  ) {
    try {
      const url = new URL(payload.url, location.href);
      return (
        matchesDomain(url.hostname, ["nflxvideo.net"]) &&
        url.pathname === "/" &&
        url.searchParams.has("o") &&
        url.searchParams.has("v")
      );
    } catch {
      return false;
    }
  }

  return false;
}

export function subscribeToCapturedSubtitles(
  site: SubtitleCaptureSite,
  listener: (payload: CapturedSubtitlePayload) => void,
): () => void {
  const recentCaptures: Array<{ time: number; characters: number }> = [];
  const handleEvent = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    if (!isCapturedSubtitlePayload(event.detail) || event.detail.site !== site)
      return;
    const now = Date.now();
    while (
      recentCaptures[0] !== undefined &&
      now - recentCaptures[0].time >= CAPTURE_EVENT_WINDOW_MS
    ) {
      recentCaptures.shift();
    }
    let characters: number;
    try {
      characters =
        typeof event.detail.body === "string"
          ? event.detail.body.length
          : JSON.stringify(event.detail.body).length;
    } catch {
      return;
    }
    const recentCharacters = recentCaptures.reduce(
      (total, capture) => total + capture.characters,
      0,
    );
    if (
      recentCaptures.length >= MAX_CAPTURE_EVENTS_PER_WINDOW ||
      recentCharacters + characters > MAX_CAPTURE_CHARACTERS_PER_WINDOW
    ) {
      return;
    }
    recentCaptures.push({ time: now, characters });
    listener(event.detail);
  };

  window.addEventListener(SUBTITLE_CAPTURE_EVENT, handleEvent);
  return () => window.removeEventListener(SUBTITLE_CAPTURE_EVENT, handleEvent);
}
