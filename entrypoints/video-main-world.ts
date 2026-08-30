import {
  isAllowedSubtitleCaptureUrl,
  SUBTITLE_CAPTURE_EVENT,
  SUBTITLE_DISCOVERY_CONTROL_EVENT,
  type SubtitleCaptureSite,
} from "@/src/subtitles/adapters/captured";
import {
  extractYouTubePlayerResponseCaptions,
  selectYouTubeCaptionTrack,
  type YouTubeCaptionTrack,
  youtubeJson3Url,
} from "@/src/subtitles/adapters/youtube-discovery";
import { parseYouTubeJson3 } from "@/src/subtitles/parsers/youtube";
import {
  selectActiveVideo,
  stableVideoCaptureScope,
} from "@/src/subtitles/video-selection";
import {
  extractNetflixTimedTextCandidates,
  selectNetflixTimedTextCandidates,
  type NetflixTimedTextCandidate,
} from "@/src/subtitles/adapters/netflix-manifest";
import { readNetflixPlayerTextTracks } from "@/src/subtitles/adapters/netflix-player";
import {
  fetchMaxDashFullTrack,
  parseMaxDashTextTracks,
  selectMaxDashTextTrack,
  type MaxDashFullTrackBody,
} from "@/src/subtitles/adapters/max-dash";
import {
  fetchHlsVttFullTrack,
  parseHlsSubtitleTracks,
  parseHlsVttMediaPlaylist,
  selectHlsSubtitleTrack,
  type HlsVttFullTrackBody,
} from "@/src/subtitles/adapters/hls-vtt";
import { languageTagsMatch } from "@/src/shared/languages";
import { siteDiagnostic } from "@/src/shared/diagnostics";
import {
  builtInSiteProfile,
  profileMatchesLocation,
} from "@/src/subtitles/profiles/registry";
import { MAIN_WORLD_CAPTURE_PROFILE_IDS } from "@/src/subtitles/profiles/catalog";
import { defineUnlistedScript } from "wxt/utils/define-unlisted-script";

const INSTALLATION_FLAG = "__noritransSubtitleHookV1__";
const MAX_CAPTURE_CHARACTERS = 5_000_000;
const MAX_NETFLIX_RESOURCE_RECOVERY_URLS = 12;
const MAX_NETFLIX_RESOURCE_RECOVERY_CONCURRENCY = 2;
let youtubePreferredSourceLanguage = "auto";
let youtubePlayerResponseListener:
  ((playerResponse: unknown) => void) | undefined;

function youtubeDiagnostic(
  event: string,
  detail: Record<string, unknown>,
): void {
  siteDiagnostic("YouTube", event, detail);
}

function netflixDiagnosticUrl(value: string): string {
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

function normalizedLanguage(value: string): string {
  return value.trim().toLowerCase().replace(/_/gu, "-");
}

function youtubeCaptureMatchesPreferredLanguage(url: string): boolean {
  const preferred = normalizedLanguage(youtubePreferredSourceLanguage);
  if (!preferred || preferred === "auto") return true;
  try {
    const params = new URL(url, location.href).searchParams;
    const captured = normalizedLanguage(
      params.get("tlang") ?? params.get("lang") ?? "",
    );
    return languageTagsMatch(preferred, captured);
  } catch {
    return false;
  }
}

interface HookedWindow extends Window {
  [INSTALLATION_FLAG]?: boolean;
  ytInitialPlayerResponse?: unknown;
  ytplayer?: {
    config?: {
      args?: {
        player_response?: unknown;
        raw_player_response?: unknown;
      };
    };
  };
}

interface YouTubePlayerElement extends Element {
  getPlayerResponse?: () => unknown;
  getVideoData?: () => unknown;
}

type CaptureSite = SubtitleCaptureSite;

interface CaptureContext {
  pageUrl: string;
  url: string;
  mediaScope: string;
  videoCount: number;
  requestRange: boolean;
  manifestCandidate: boolean;
  language?: string;
}

type MaxDashManifestHandler = (
  capture: CaptureContext,
  text: string,
  contentType: string,
  responseStatus: number,
  contentRange: string | null,
) => void;

let maxDashManifestHandler: MaxDashManifestHandler | undefined;
type HlsManifestHandler = MaxDashManifestHandler;
let hlsManifestHandler: HlsManifestHandler | undefined;

function currentSite(): CaptureSite | null {
  for (const site of MAIN_WORLD_CAPTURE_PROFILE_IDS) {
    if (profileMatchesLocation(builtInSiteProfile(site), location)) {
      return site;
    }
  }
  return null;
}

function parseBody(
  text: string,
  contentType: string,
): string | Record<string, unknown> | unknown[] {
  const trimmed = text.trim();
  if (
    contentType.includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return [...(parsed as unknown[])];
      if (typeof parsed === "object" && parsed !== null)
        return parsed as Record<string, unknown>;
    } catch {
      // Non-JSON subtitle formats are forwarded as text.
    }
  }
  return text;
}

function captureContext(
  url: string,
  requestRange = false,
  manifestCandidate = false,
  language?: string,
): CaptureContext {
  return {
    pageUrl: location.href.split("#", 1)[0] ?? location.href,
    url,
    mediaScope: stableVideoCaptureScope(selectActiveVideo()),
    videoCount: document.querySelectorAll("video").length,
    requestRange,
    manifestCandidate,
    ...(language ? { language } : {}),
  };
}

function isMaxDashManifestUrl(value: string): boolean {
  if (!isAllowedSubtitleCaptureUrl("max", value)) return false;
  try {
    const url = new URL(value, location.href);
    return /(?:\.mpd(?:[/?#]|$)|manifest)/iu.test(
      `${url.pathname}${url.search}`,
    );
  } catch {
    return false;
  }
}

function isHlsManifestUrl(
  site: Extract<CaptureSite, "max" | "disney-plus" | "prime-video">,
  value: string,
): boolean {
  if (!isAllowedSubtitleCaptureUrl(site, value)) return false;
  try {
    const url = new URL(value, location.href);
    return /(?:\.m3u8(?:[/?#]|$)|manifest)/iu.test(
      `${url.pathname}${url.search}`,
    );
  } catch {
    return false;
  }
}

function handleCapturedText(
  site: CaptureSite,
  capture: CaptureContext,
  text: string,
  contentType: string,
  responseStatus: number,
  contentRange: string | null,
): void {
  if (site === "max" && capture.manifestCandidate) {
    maxDashManifestHandler?.(
      capture,
      text,
      contentType,
      responseStatus,
      contentRange,
    );
  }
  if (
    (site === "max" || site === "disney-plus" || site === "prime-video") &&
    capture.manifestCandidate
  ) {
    hlsManifestHandler?.(
      capture,
      text,
      contentType,
      responseStatus,
      contentRange,
    );
  }
  dispatch(site, capture, text, contentType, responseStatus, contentRange);
}

function dispatch(
  site: CaptureSite,
  capture: CaptureContext,
  text: string,
  contentType: string,
  responseStatus: number,
  contentRange: string | null,
): void {
  const { pageUrl, url, mediaScope, videoCount } = capture;
  if (text.length === 0 || text.length > MAX_CAPTURE_CHARACTERS) {
    if (site === "netflix") {
      netflixDiagnostic("capture-body-size-rejected", {
        resource: netflixDiagnosticUrl(url),
        characters: text.length,
        manifestCandidate: capture.manifestCandidate,
      });
    }
    return;
  }
  if (site === "youtube" && !youtubeCaptureMatchesPreferredLanguage(url))
    return;
  if (
    site === "netflix" &&
    /(^|\.)nflxvideo\.net$/iu.test(new URL(url, location.href).hostname) &&
    !/^\s*(?:WEBVTT|<\?xml|<tt[\s>])/iu.test(text)
  ) {
    netflixDiagnostic("capture-body-format-rejected", {
      resource: netflixDiagnosticUrl(url),
      characters: text.length,
      manifestCandidate: capture.manifestCandidate,
      contentType: contentType || "unknown",
    });
    return;
  }
  if (
    site !== "youtube" &&
    site !== "netflix" &&
    !/^\s*(?:WEBVTT|<\?xml|<tt[\s>])/iu.test(text)
  ) {
    return;
  }
  if (site === "netflix") {
    netflixDiagnostic("capture-dispatch", {
      resource: netflixDiagnosticUrl(url),
      characters: text.length,
      format: /^\s*WEBVTT/iu.test(text) ? "vtt" : "ttml-or-manifest",
      manifestCandidate: capture.manifestCandidate,
      responseStatus,
      partial:
        capture.requestRange || responseStatus === 206 || Boolean(contentRange),
    });
  }
  window.dispatchEvent(
    new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
      detail: {
        site,
        pageUrl,
        url,
        body: parseBody(text, contentType),
        contentType,
        mediaScope,
        videoCount,
        partial:
          capture.requestRange ||
          responseStatus === 206 ||
          Boolean(contentRange),
        requestRange: capture.requestRange,
        manifestCandidate: capture.manifestCandidate,
        ...(capture.language ? { language: capture.language } : {}),
        responseStatus,
        ...(contentRange ? { contentRange } : {}),
      },
    }),
  );
}

async function captureResponse(
  site: CaptureSite,
  capture: CaptureContext,
  response: Response,
): Promise<void> {
  const { url } = capture;
  if (!isAllowedSubtitleCaptureUrl(site, url)) return;
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_CHARACTERS)
    return;
  try {
    const clone = response.clone();
    const text = await clone.text();
    handleCapturedText(
      site,
      capture,
      text,
      clone.headers.get("content-type") ?? "",
      clone.status,
      clone.headers.get("content-range"),
    );
  } catch {
    // Opaque, streaming, or already-consumed responses are allowed to pass unchanged.
  }
}

function installFetchHook(site: CaptureSite): typeof window.fetch {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function hookedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      input instanceof Request
        ? input.url
        : new URL(String(input), location.href).href;
    const initHeaders = new Headers(init?.headers);
    const capture = captureContext(
      url,
      initHeaders.has("range") ||
        (input instanceof Request && input.headers.has("range")),
      (site === "max" &&
        (isMaxDashManifestUrl(url) || isHlsManifestUrl("max", url))) ||
        ((site === "disney-plus" || site === "prime-video") &&
          isHlsManifestUrl(site, url)),
    );
    const response = await nativeFetch(input, init);
    if (site === "youtube") {
      void inspectYouTubePlayerResponse(url, response);
    }
    void captureResponse(site, capture, response);
    return response;
  };
  return nativeFetch;
}

function isYouTubePlayerResponseUrl(value: string): boolean {
  try {
    const url = new URL(value, location.href);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      /(^|\.)(?:youtube\.com|youtube-nocookie\.com)$/iu.test(url.hostname) &&
      url.pathname === "/youtubei/v1/player"
    );
  } catch {
    return false;
  }
}

async function inspectYouTubePlayerResponse(
  url: string,
  response: Response,
): Promise<void> {
  if (
    !youtubePlayerResponseListener ||
    !isYouTubePlayerResponseUrl(url) ||
    !response.ok
  ) {
    return;
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_CAPTURE_CHARACTERS)
    return;
  try {
    const parsed: unknown = await response.clone().json();
    const captions = extractYouTubePlayerResponseCaptions(parsed);
    if (captions.tracks.length > 0) youtubePlayerResponseListener(parsed);
  } catch {
    // Player discovery is optional and must not affect the page's response.
  }
}

function isRecoverableNetflixSubtitleUrl(value: string): boolean {
  if (!isAllowedSubtitleCaptureUrl("netflix", value)) return false;
  try {
    const url = new URL(value, location.href);
    if (
      /(^|\.)nflxvideo\.net$/iu.test(url.hostname) &&
      url.pathname === "/" &&
      url.searchParams.has("o") &&
      url.searchParams.has("v")
    ) {
      return true;
    }
    return /timedtexttracks|timedtext|subtitle|\.vtt(?:[?#]|$)|\.ttml(?:[?#]|$)|\.dfxp(?:[?#]|$)/iu.test(
      `${url.pathname}${url.search}`,
    );
  } catch {
    return false;
  }
}

/**
 * A reload on an already-open Netflix player happens after its full subtitle
 * document was requested, so fetch/XHR interception alone cannot recover it.
 * Resource Timing retains the URL without exposing response data. Re-fetch only
 * the provider's narrowly allowlisted subtitle endpoints and run the captured
 * response through the same size, format, page and media-identity gates.
 */
function installNetflixResourceRecovery(
  nativeFetch: typeof window.fetch,
  windowValue: HookedWindow,
): void {
  // A URL first observed through Resource Timing is only a heuristic stream
  // candidate. If the manifest later proves it is a complete timed-text
  // document, allow exactly one upgraded recovery request carrying that
  // stronger provenance instead of permanently keeping the first weak mark.
  const seen = new Map<string, boolean>();
  const queue: Array<{
    url: string;
    manifestCandidate: boolean;
    language?: string;
  }> = [];
  const manifestCandidates = new Map<string, NetflixTimedTextCandidate>();
  let enabled = false;
  let active = 0;
  let observer: PerformanceObserver | undefined;
  let playerTimer: number | undefined;
  let preferredSourceLanguage = "auto";
  let lastWatchPath = location.pathname;
  let lastManifestDiagnostic = "";
  let lastPlayerTrackCount = -1;

  const drain = (): void => {
    while (
      enabled &&
      active < MAX_NETFLIX_RESOURCE_RECOVERY_CONCURRENCY &&
      queue.length > 0
    ) {
      const next = queue.shift();
      if (!next) continue;
      const { url, manifestCandidate, language } = next;
      active += 1;
      const capture = captureContext(url, false, manifestCandidate, language);
      netflixDiagnostic("subtitle-fetch-start", {
        resource: netflixDiagnosticUrl(url),
        manifestCandidate,
        language: language || "unknown",
      });
      // Signed nflxvideo.net subtitle URLs normally need no cookie and commonly
      // allow anonymous CORS. Same-origin Netflix endpoints still receive their
      // cookies, while cross-origin CDN recovery avoids an invalid `*` + include
      // credentials combination.
      void nativeFetch(url, { credentials: "same-origin" })
        .then((response) => {
          netflixDiagnostic("subtitle-fetch-response", {
            resource: netflixDiagnosticUrl(url),
            manifestCandidate,
            status: response.status,
            contentLength: response.headers.get("content-length") || "unknown",
            contentType: response.headers.get("content-type") || "unknown",
            partial:
              response.status === 206 ||
              Boolean(response.headers.get("content-range")),
          });
          return captureResponse("netflix", capture, response);
        })
        .catch((error: unknown) => {
          netflixDiagnostic("subtitle-fetch-error", {
            resource: netflixDiagnosticUrl(url),
            manifestCandidate,
            error:
              error instanceof Error
                ? `${error.name}: ${error.message}`.slice(0, 180)
                : "unknown",
          });
        })
        .finally(() => {
          active = Math.max(0, active - 1);
          drain();
        });
    }
  };

  const enqueue = (
    url: string,
    manifestCandidate = false,
    language?: string,
  ): void => {
    const previousManifestCandidate = seen.get(url);
    const upgradesPreviousCandidate =
      previousManifestCandidate === false && manifestCandidate;
    if (
      !enabled ||
      (previousManifestCandidate !== undefined && !upgradesPreviousCandidate) ||
      (previousManifestCandidate === undefined &&
        seen.size >= MAX_NETFLIX_RESOURCE_RECOVERY_URLS) ||
      !isRecoverableNetflixSubtitleUrl(url)
    ) {
      return;
    }
    seen.set(url, manifestCandidate);
    queue.push({ url, manifestCandidate, ...(language ? { language } : {}) });
    drain();
  };

  const enqueueManifestCandidates = (): void => {
    const selected = selectNetflixTimedTextCandidates(
      [...manifestCandidates.values()],
      preferredSourceLanguage,
      8,
    );
    const detail = {
      discovered: manifestCandidates.size,
      selected: selected.length,
      preferredSourceLanguage,
      selectedTracks: selected.map((candidate) => ({
        language: candidate.language || "unknown",
        profile: candidate.profile || "unknown",
        resource: netflixDiagnosticUrl(candidate.url),
      })),
    };
    const diagnostic = JSON.stringify(detail);
    if (diagnostic !== lastManifestDiagnostic) {
      lastManifestDiagnostic = diagnostic;
      netflixDiagnostic("manifest-candidates", detail);
    }
    for (const candidate of selected) {
      enqueue(candidate.url, true, candidate.language);
    }
  };

  const rememberManifestCandidates = (value: unknown): void => {
    for (const candidate of extractNetflixTimedTextCandidates(value)) {
      if (!isAllowedSubtitleCaptureUrl("netflix", candidate.url)) continue;
      manifestCandidates.set(candidate.url, candidate);
    }
    if (enabled) enqueueManifestCandidates();
  };

  const discoverPlayerTracks = (): void => {
    if (!enabled) return;
    if (location.pathname !== lastWatchPath) {
      lastWatchPath = location.pathname;
      seen.clear();
      queue.length = 0;
      manifestCandidates.clear();
    }
    const tracks = readNetflixPlayerTextTracks(windowValue);
    if (tracks.length !== lastPlayerTrackCount) {
      lastPlayerTrackCount = tracks.length;
      netflixDiagnostic("player-track-list", {
        tracks: tracks.length,
        preferredSourceLanguage,
      });
    }
    if (tracks.length > 0)
      rememberManifestCandidates({ timedtexttracks: tracks });
  };

  // Response.json() may bypass the page's JSON.parse function, but our fetch
  // clone is parsed through it. Patching here also covers manifest objects
  // parsed from other Netflix transport layers while preserving native output.
  const nativeJsonParse = JSON.parse;
  JSON.parse = function hookedJsonParse(
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown,
  ): unknown {
    const parsed = Reflect.apply(nativeJsonParse, this, [
      text,
      reviver,
    ]) as unknown;
    try {
      rememberManifestCandidates(parsed);
    } catch {
      // Manifest discovery must never change Netflix JSON.parse behavior.
    }
    return parsed;
  };

  // The Fetch standard parses Response.json() internally, so replacing
  // window.JSON.parse alone cannot observe manifests consumed through that
  // path. Inspect the already-parsed value while returning the exact same
  // promise result and leaving rejected responses untouched.
  try {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const nativeResponseJson = Response.prototype.json;
    Response.prototype.json =
      async function hookedResponseJson(): Promise<unknown> {
        const parsed = (await Reflect.apply(
          nativeResponseJson,
          this,
          [],
        )) as unknown;
        try {
          rememberManifestCandidates(parsed);
        } catch {
          // Manifest discovery must never change Response.json() behavior.
        }
        return parsed;
      };
  } catch {
    // Hardened pages may freeze built-in prototypes. JSON.parse and resource
    // recovery remain available without disturbing playback.
  }

  const scanBuffered = (): void => {
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        enqueue(entry.name, false);
      }
    } catch {
      // A page may replace the Performance API; fetch/XHR interception remains.
    }
  };

  const setEnabled = (nextEnabled: boolean): void => {
    enabled = nextEnabled;
    if (!enabled) {
      queue.length = 0;
      observer?.disconnect();
      observer = undefined;
      if (playerTimer !== undefined) window.clearInterval(playerTimer);
      playerTimer = undefined;
      return;
    }
    discoverPlayerTracks();
    if (playerTimer === undefined) {
      playerTimer = window.setInterval(discoverPlayerTracks, 3_000);
    }
    enqueueManifestCandidates();
    if (!observer && typeof PerformanceObserver !== "undefined") {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) enqueue(entry.name, false);
        });
        observer.observe({ type: "resource", buffered: true });
      } catch {
        observer?.disconnect();
        observer = undefined;
      }
    }
    scanBuffered();
  };

  window.addEventListener(SUBTITLE_DISCOVERY_CONTROL_EVENT, (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (typeof detail === "boolean") {
      setEnabled(detail);
      return;
    }
    if (
      typeof detail === "object" &&
      detail !== null &&
      "enabled" in detail &&
      typeof detail.enabled === "boolean"
    ) {
      if (
        "sourceLanguage" in detail &&
        typeof detail.sourceLanguage === "string" &&
        detail.sourceLanguage !== preferredSourceLanguage
      ) {
        preferredSourceLanguage = detail.sourceLanguage;
        queue.length = 0;
      }
      setEnabled(detail.enabled);
    }
  });
}

function dispatchMaxDashFullTrack(
  capture: CaptureContext,
  body: MaxDashFullTrackBody,
): void {
  window.dispatchEvent(
    new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
      detail: {
        site: "max",
        pageUrl: capture.pageUrl,
        url: capture.url,
        body,
        contentType: "application/dash+xml",
        mediaScope: capture.mediaScope,
        videoCount: capture.videoCount,
        partial: false,
        requestRange: false,
        manifestCandidate: true,
        responseStatus: 200,
      },
    }),
  );
}

/**
 * Upgrades Max to a full track only after one finite static MPD track has been
 * selected and every allowlisted VTT segment has been fetched and parsed.
 */
function installMaxDashDiscovery(nativeFetch: typeof window.fetch): void {
  let enabled = false;
  let preferredSourceLanguage = "auto";
  let activeController: AbortController | undefined;
  let activeKey = "";
  let completedKey = "";
  let lastManifest:
    { capture: CaptureContext; contentType: string; text: string } | undefined;

  const stopActive = (): void => {
    activeController?.abort();
    activeController = undefined;
    activeKey = "";
  };

  const start = (
    capture: CaptureContext,
    text: string,
    contentType: string,
  ): void => {
    if (
      !enabled ||
      capture.videoCount !== 1 ||
      !/^\s*(?:<\?xml\b[\s\S]*?\?>\s*)?<MPD(?:\s|>)/u.test(text) ||
      (!contentType.toLowerCase().includes("dash") &&
        !contentType.toLowerCase().includes("xml") &&
        !isMaxDashManifestUrl(capture.url))
    ) {
      return;
    }
    const tracks = parseMaxDashTextTracks(text, capture.url, (url) =>
      isAllowedSubtitleCaptureUrl("max", url),
    );
    const selected = selectMaxDashTextTrack(tracks, preferredSourceLanguage);
    if (!selected) return;
    const jobKey = [
      capture.pageUrl,
      capture.mediaScope,
      capture.url,
      selected.language,
      preferredSourceLanguage,
    ].join("|");
    if (jobKey === activeKey || jobKey === completedKey) return;

    stopActive();
    const controller = new AbortController();
    activeController = controller;
    activeKey = jobKey;
    const initialPageUrl = capture.pageUrl;
    const routeTimer = window.setInterval(() => {
      const currentPageUrl = location.href.split("#", 1)[0] ?? location.href;
      if (currentPageUrl !== initialPageUrl) controller.abort();
    }, 250);

    void fetchMaxDashFullTrack(
      selected,
      (url, init) => nativeFetch(url, init),
      controller.signal,
      (url) => isAllowedSubtitleCaptureUrl("max", url),
    )
      .then((body) => {
        if (!body || controller.signal.aborted || activeKey !== jobKey) return;
        const currentPageUrl = location.href.split("#", 1)[0] ?? location.href;
        const activeVideo = selectActiveVideo();
        if (
          currentPageUrl !== capture.pageUrl ||
          document.querySelectorAll("video").length !== 1 ||
          stableVideoCaptureScope(activeVideo) !== capture.mediaScope
        ) {
          return;
        }
        completedKey = jobKey;
        dispatchMaxDashFullTrack(capture, body);
      })
      .catch(() => undefined)
      .finally(() => {
        window.clearInterval(routeTimer);
        if (activeController === controller) activeController = undefined;
        if (activeKey === jobKey) activeKey = "";
      });
  };

  maxDashManifestHandler = (
    capture,
    text,
    contentType,
    responseStatus,
    contentRange,
  ) => {
    if (
      capture.requestRange ||
      responseStatus < 200 ||
      responseStatus >= 300 ||
      responseStatus === 206 ||
      Boolean(contentRange)
    ) {
      return;
    }
    lastManifest = { capture, contentType, text };
    start(capture, text, contentType);
  };

  window.addEventListener(SUBTITLE_DISCOVERY_CONTROL_EVENT, (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    const nextEnabled =
      typeof detail === "boolean"
        ? detail
        : typeof detail === "object" &&
            detail !== null &&
            "enabled" in detail &&
            typeof detail.enabled === "boolean"
          ? detail.enabled
          : null;
    if (nextEnabled === null) return;
    if (
      typeof detail === "object" &&
      detail !== null &&
      "sourceLanguage" in detail &&
      typeof detail.sourceLanguage === "string" &&
      detail.sourceLanguage !== preferredSourceLanguage
    ) {
      preferredSourceLanguage = detail.sourceLanguage;
      completedKey = "";
      stopActive();
    }
    enabled = nextEnabled;
    if (!enabled) {
      stopActive();
      return;
    }
    if (lastManifest) {
      start(lastManifest.capture, lastManifest.text, lastManifest.contentType);
    }
  });
}

function dispatchHlsVttFullTrack(
  site: Extract<CaptureSite, "max" | "disney-plus" | "prime-video">,
  capture: CaptureContext,
  body: HlsVttFullTrackBody,
): void {
  window.dispatchEvent(
    new CustomEvent(SUBTITLE_CAPTURE_EVENT, {
      detail: {
        site,
        pageUrl: capture.pageUrl,
        url: capture.url,
        body,
        contentType: "application/vnd.apple.mpegurl",
        mediaScope: capture.mediaScope,
        videoCount: capture.videoCount,
        partial: false,
        requestRange: false,
        manifestCandidate: true,
        responseStatus: 200,
      },
    }),
  );
}

function manifestLanguage(value: string): string {
  try {
    const url = new URL(value, location.href);
    for (const [key, language] of url.searchParams) {
      if (
        ["lang", "language", "languagecode", "locale"].includes(
          key.toLowerCase(),
        ) &&
        language.trim()
      ) {
        return language.trim();
      }
    }
  } catch {
    // The site allowlist validates URLs again before use.
  }
  return "und";
}

/** Promotes only finite, fully fetched HLS WebVTT playlists to full tracks. */
function installHlsVttDiscovery(
  site: Extract<CaptureSite, "max" | "disney-plus" | "prime-video">,
  nativeFetch: typeof window.fetch,
): void {
  let enabled = false;
  let preferredSourceLanguage = "auto";
  let activeController: AbortController | undefined;
  let activeKey = "";
  let completedKey = "";
  let lastManifest:
    { capture: CaptureContext; contentType: string; text: string } | undefined;

  const stopActive = (): void => {
    activeController?.abort();
    activeController = undefined;
    activeKey = "";
  };

  const start = async (
    capture: CaptureContext,
    text: string,
    contentType: string,
  ): Promise<void> => {
    if (
      !enabled ||
      capture.videoCount !== 1 ||
      !/^\s*#EXTM3U(?:\s|$)/u.test(text) ||
      (!contentType.toLowerCase().includes("mpegurl") &&
        !isHlsManifestUrl(site, capture.url))
    ) {
      return;
    }
    const keyBase = [
      capture.pageUrl,
      capture.mediaScope,
      capture.url,
      preferredSourceLanguage,
    ].join("|");
    if (keyBase === activeKey || keyBase === completedKey) return;
    stopActive();
    const controller = new AbortController();
    activeController = controller;
    activeKey = keyBase;
    try {
      const allowed = (url: string) => isAllowedSubtitleCaptureUrl(site, url);
      let playlistUrl = capture.url;
      let playlistText = text;
      let language = manifestLanguage(capture.url);
      const tracks = parseHlsSubtitleTracks(text, capture.url, allowed);
      if (tracks.length > 0) {
        const selected = selectHlsSubtitleTrack(
          tracks,
          preferredSourceLanguage,
        );
        if (!selected) return;
        playlistUrl = selected.url;
        language = selected.language;
        const response = await nativeFetch(playlistUrl, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (
          !response.ok ||
          response.status === 206 ||
          Boolean(response.headers.get("content-range")) ||
          (response.url && !allowed(response.url))
        ) {
          return;
        }
        playlistText = await response.text();
      } else if (
        preferredSourceLanguage !== "auto" &&
        language !== "und" &&
        !languageTagsMatch(preferredSourceLanguage, language)
      ) {
        return;
      }
      const plan = parseHlsVttMediaPlaylist(
        playlistText,
        playlistUrl,
        language,
        allowed,
      );
      if (!plan || controller.signal.aborted || activeKey !== keyBase) return;
      const body = await fetchHlsVttFullTrack(
        plan,
        (url, init) => nativeFetch(url, init),
        controller.signal,
        allowed,
      );
      if (!body || controller.signal.aborted || activeKey !== keyBase) return;
      const currentPageUrl = location.href.split("#", 1)[0] ?? location.href;
      if (
        currentPageUrl !== capture.pageUrl ||
        document.querySelectorAll("video").length !== 1 ||
        stableVideoCaptureScope(selectActiveVideo()) !== capture.mediaScope
      ) {
        return;
      }
      completedKey = keyBase;
      dispatchHlsVttFullTrack(site, capture, body);
    } catch {
      // Network, route, or parse failures leave the existing stream fallback.
    } finally {
      if (activeController === controller) activeController = undefined;
      if (activeKey === keyBase) activeKey = "";
    }
  };

  hlsManifestHandler = (
    capture,
    text,
    contentType,
    responseStatus,
    contentRange,
  ) => {
    if (
      capture.requestRange ||
      responseStatus < 200 ||
      responseStatus >= 300 ||
      responseStatus === 206 ||
      Boolean(contentRange)
    ) {
      return;
    }
    lastManifest = { capture, contentType, text };
    void start(capture, text, contentType).catch(() => undefined);
  };

  window.addEventListener(SUBTITLE_DISCOVERY_CONTROL_EVENT, (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    const nextEnabled =
      typeof detail === "boolean"
        ? detail
        : typeof detail === "object" &&
            detail !== null &&
            "enabled" in detail &&
            typeof detail.enabled === "boolean"
          ? detail.enabled
          : null;
    if (nextEnabled === null) return;
    if (
      typeof detail === "object" &&
      detail !== null &&
      "sourceLanguage" in detail &&
      typeof detail.sourceLanguage === "string" &&
      detail.sourceLanguage !== preferredSourceLanguage
    ) {
      preferredSourceLanguage = detail.sourceLanguage;
      completedKey = "";
      stopActive();
    }
    enabled = nextEnabled;
    if (!enabled) {
      stopActive();
      return;
    }
    if (lastManifest) {
      void start(
        lastManifest.capture,
        lastManifest.text,
        lastManifest.contentType,
      ).catch(() => undefined);
    }
  });
}

function installXhrHook(site: CaptureSite): void {
  const requests = new WeakMap<XMLHttpRequest, CaptureContext>();
  const rangedRequests = new WeakSet<XMLHttpRequest>();
  // The originals intentionally remain unbound because each call must retain its XHR receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const nativeOpen = XMLHttpRequest.prototype.open;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const nativeSend = XMLHttpRequest.prototype.send;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function hookedOpen(
    method: string,
    url: string | URL,
    async = true,
    username?: string | null,
    password?: string | null,
  ): void {
    requests.set(
      this,
      captureContext(
        new URL(String(url), location.href).href,
        false,
        (site === "max" &&
          (isMaxDashManifestUrl(String(url)) ||
            isHlsManifestUrl("max", String(url)))) ||
          ((site === "disney-plus" || site === "prime-video") &&
            isHlsManifestUrl(site, String(url))),
      ),
    );
    Reflect.apply(nativeOpen, this, [method, url, async, username, password]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function hookedSetRequestHeader(
    name: string,
    value: string,
  ): void {
    if (name.trim().toLowerCase() === "range") rangedRequests.add(this);
    Reflect.apply(nativeSetRequestHeader, this, [name, value]);
  };

  XMLHttpRequest.prototype.send = function hookedSend(
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const initialRequest = requests.get(this);
    if (
      !initialRequest ||
      !isAllowedSubtitleCaptureUrl(site, initialRequest.url)
    ) {
      Reflect.apply(nativeSend, this, [body]);
      return;
    }
    this.addEventListener(
      "load",
      () => {
        const request = requests.get(this);
        const url = request?.url ?? this.responseURL;
        const capture = request ?? captureContext(url);
        if (!isAllowedSubtitleCaptureUrl(site, url)) return;
        void (async () => {
          try {
            const contentType = this.getResponseHeader("content-type") ?? "";
            const request = requests.get(this);
            const responseStatus = this.status;
            // `getResponseHeader("content-range")` writes a browser Console
            // error when a cross-origin response did not expose that header.
            // Enumerating the already-exposed response headers avoids the
            // warning while status 206 and the request Range header still
            // provide decisive partial-response evidence.
            const exposedHeaders = this.getAllResponseHeaders();
            const contentRange =
              /(?:^|\r?\n)content-range\s*:\s*([^\r\n]+)/iu
                .exec(exposedHeaders)?.[1]
                ?.trim() ?? null;
            const responseCapture = request
              ? { ...request, requestRange: rangedRequests.has(this) }
              : { ...capture, requestRange: rangedRequests.has(this) };
            if (this.responseType === "json") {
              const serialized = JSON.stringify(this.response);
              if (serialized)
                handleCapturedText(
                  site,
                  responseCapture,
                  serialized,
                  "application/json",
                  responseStatus,
                  contentRange,
                );
            } else if (
              this.responseType === "" ||
              this.responseType === "text"
            ) {
              handleCapturedText(
                site,
                responseCapture,
                this.responseText,
                contentType,
                responseStatus,
                contentRange,
              );
            } else if (
              this.responseType === "arraybuffer" &&
              this.response instanceof ArrayBuffer &&
              this.response.byteLength <= MAX_CAPTURE_CHARACTERS
            ) {
              handleCapturedText(
                site,
                responseCapture,
                new TextDecoder().decode(this.response),
                contentType,
                responseStatus,
                contentRange,
              );
            } else if (
              this.responseType === "blob" &&
              this.response instanceof Blob &&
              this.response.size <= MAX_CAPTURE_CHARACTERS
            ) {
              handleCapturedText(
                site,
                responseCapture,
                await this.response.text(),
                contentType,
                responseStatus,
                contentRange,
              );
            } else if (this.responseType === "document" && this.responseXML) {
              handleCapturedText(
                site,
                responseCapture,
                new XMLSerializer().serializeToString(this.responseXML),
                contentType,
                responseStatus,
                contentRange,
              );
            }
          } catch {
            // Access to a cross-origin response may be restricted; preserve the XHR result.
          }
        })();
      },
      { once: true },
    );
    Reflect.apply(nativeSend, this, [body]);
  };
}

function parsePlayerResponse(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function currentYouTubeVideoId(): string | undefined {
  try {
    const url = new URL(location.href);
    const videoId =
      url.searchParams.get("v") ??
      /^\/(?:shorts|embed)\/([\w-]{6,32})(?:[/?#]|$)/u.exec(url.pathname)?.[1];
    return videoId && /^[\w-]{6,32}$/u.test(videoId) ? videoId : undefined;
  } catch {
    return undefined;
  }
}

function youtubePlayerVideoId(
  player: YouTubePlayerElement,
): string | undefined {
  try {
    const data: unknown = player.getVideoData?.();
    if (typeof data !== "object" || data === null) return undefined;
    const videoId =
      "video_id" in data
        ? data.video_id
        : "videoId" in data
          ? data.videoId
          : undefined;
    return typeof videoId === "string" && /^[\w-]{6,32}$/u.test(videoId)
      ? videoId
      : undefined;
  } catch {
    return undefined;
  }
}

function youtubePlayerResponseCaptions(
  windowValue: HookedWindow,
): Array<{ videoId?: string; tracks: YouTubeCaptionTrack[] }> {
  const snapshots = [
    extractYouTubePlayerResponseCaptions(
      parsePlayerResponse(windowValue.ytInitialPlayerResponse),
    ),
    extractYouTubePlayerResponseCaptions(
      parsePlayerResponse(
        windowValue.ytplayer?.config?.args?.raw_player_response,
      ),
    ),
    extractYouTubePlayerResponseCaptions(
      parsePlayerResponse(windowValue.ytplayer?.config?.args?.player_response),
    ),
  ];
  const players = new Set<YouTubePlayerElement>();
  for (const selector of ["#movie_player", "ytd-player"] as const) {
    for (const element of document.querySelectorAll(selector)) {
      players.add(element);
    }
  }
  for (const player of players) {
    try {
      const response = player.getPlayerResponse?.();
      const captions = extractYouTubePlayerResponseCaptions(response);
      const fallbackVideoId = youtubePlayerVideoId(player);
      snapshots.push({
        ...captions,
        ...(captions.videoId || !fallbackVideoId
          ? {}
          : { videoId: fallbackVideoId }),
      });
    } catch {
      // A player can be replaced during SPA navigation; the next poll retries.
    }
  }
  return snapshots.filter(({ tracks }) => tracks.length > 0);
}

function youtubeCaptionTracks(
  windowValue: HookedWindow,
  remembered: ReadonlyMap<string, readonly YouTubeCaptionTrack[]>,
  allowUnscoped: boolean,
): YouTubeCaptionTrack[] {
  const currentVideoId = currentYouTubeVideoId();
  const snapshots = youtubePlayerResponseCaptions(windowValue);
  if (currentVideoId) {
    const rememberedTracks = remembered.get(currentVideoId);
    if (rememberedTracks) {
      snapshots.unshift({
        videoId: currentVideoId,
        tracks: [...rememberedTracks],
      });
    }
  }
  const exact = currentVideoId
    ? snapshots.filter(({ videoId }) => videoId === currentVideoId)
    : [];
  const eligible =
    exact.length > 0
      ? exact
      : snapshots.filter(({ videoId }) => !videoId && allowUnscoped);
  const deduplicated = new Map<string, YouTubeCaptionTrack>();
  for (const track of eligible.flatMap(({ tracks }) => tracks)) {
    deduplicated.set(track.baseUrl, track);
  }
  return [...deduplicated.values()];
}

function installYouTubeDiscovery(
  nativeFetch: typeof window.fetch,
  windowValue: HookedWindow,
): void {
  let timer: number | undefined;
  let lastFetchedKey = "";
  let inFlightKey = "";
  let preferredSourceLanguage = "auto";
  let enabled = false;
  let failedAttempts = 0;
  let retryAfter = 0;
  let lastDiagnostic = "";
  let missingTrackKey = "";
  let missingTrackSince = 0;
  const initialVideoId = currentYouTubeVideoId();
  const rememberedTracks = new Map<string, readonly YouTubeCaptionTrack[]>();

  const reportOnce = (event: string, detail: Record<string, unknown>): void => {
    const diagnostic = `${event}|${JSON.stringify(detail)}`;
    if (diagnostic === lastDiagnostic) return;
    lastDiagnostic = diagnostic;
    youtubeDiagnostic(event, detail);
  };

  const scheduleRetry = (
    reason:
      | "network"
      | "http"
      | "partial-response"
      | "empty-or-invalid"
      | "media-changed",
    status?: number,
  ): void => {
    failedAttempts += 1;
    retryAfter =
      Date.now() + Math.min(15_000, 1_500 * 2 ** (failedAttempts - 1));
    reportOnce("full-track-retry", {
      reason,
      ...(status === undefined ? {} : { status }),
      preferredSourceLanguage,
      videoId: currentYouTubeVideoId() ?? "unknown",
    });
  };

  const discover = async (): Promise<void> => {
    if (!enabled || Date.now() < retryAfter) return;
    const currentVideoId = currentYouTubeVideoId();
    const video = selectActiveVideo();
    if (!video) return;
    const availableTracks = youtubeCaptionTracks(
      windowValue,
      rememberedTracks,
      currentVideoId === initialVideoId,
    );
    const track = selectYouTubeCaptionTrack(
      availableTracks,
      preferredSourceLanguage,
    );
    if (!track) {
      const key = `${currentVideoId ?? "unknown"}|${preferredSourceLanguage}|${availableTracks.length}`;
      if (key !== missingTrackKey) {
        missingTrackKey = key;
        missingTrackSince = Date.now();
      } else if (Date.now() - missingTrackSince >= 8_000) {
        reportOnce("full-track-unavailable", {
          reason:
            availableTracks.length === 0
              ? "caption-track-url-not-discovered"
              : "configured-language-unavailable",
          preferredSourceLanguage,
          videoId: currentVideoId ?? "unknown",
          availableTracks: availableTracks.length,
        });
      }
      return;
    }
    missingTrackKey = "";
    missingTrackSince = 0;
    const url = youtubeJson3Url(track);
    if (!url || !isAllowedSubtitleCaptureUrl("youtube", url)) {
      reportOnce("full-track-unavailable", {
        reason: "caption-track-url-rejected",
        preferredSourceLanguage,
        videoId: currentVideoId ?? "unknown",
      });
      return;
    }
    const key = `${location.href.split("#", 1)[0]}|${url}`;
    if (key === lastFetchedKey || key === inFlightKey) return;
    inFlightKey = key;
    const capture = captureContext(url);
    try {
      const response = await nativeFetch(url, { credentials: "include" });
      if (!response.ok) {
        scheduleRetry("http", response.status);
        return;
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_CAPTURE_CHARACTERS
      ) {
        scheduleRetry("empty-or-invalid");
        return;
      }
      const text = await response.clone().text();
      let cueCount = 0;
      try {
        cueCount = parseYouTubeJson3(text, track.languageCode).cues.length;
      } catch {
        // A 200 response can still be an empty/expired timedtext document.
      }
      if (cueCount === 0) {
        scheduleRetry("empty-or-invalid");
        return;
      }
      const currentPageUrl = location.href.split("#", 1)[0] ?? location.href;
      if (
        capture.pageUrl !== currentPageUrl ||
        capture.mediaScope !== stableVideoCaptureScope(selectActiveVideo())
      ) {
        scheduleRetry("media-changed");
        return;
      }
      handleCapturedText(
        "youtube",
        capture,
        text,
        response.headers.get("content-type") ?? "application/json",
        response.status,
        response.headers.get("content-range"),
      );
      if (
        response.status === 206 ||
        Boolean(response.headers.get("content-range"))
      ) {
        scheduleRetry("partial-response", response.status);
        return;
      }
      failedAttempts = 0;
      retryAfter = 0;
      lastFetchedKey = key;
      reportOnce("full-track-captured", {
        videoId: currentVideoId ?? "unknown",
        language: track.languageCode,
        kind: track.kind === "asr" ? "asr" : "manual",
        cues: cueCount,
      });
    } catch {
      scheduleRetry("network");
    } finally {
      if (inFlightKey === key) inFlightKey = "";
    }
  };

  youtubePlayerResponseListener = (playerResponse) => {
    const captions = extractYouTubePlayerResponseCaptions(playerResponse);
    if (!captions.videoId || captions.tracks.length === 0) return;
    rememberedTracks.delete(captions.videoId);
    rememberedTracks.set(captions.videoId, captions.tracks);
    while (rememberedTracks.size > 8) {
      const oldest = rememberedTracks.keys().next().value;
      if (!oldest) break;
      rememberedTracks.delete(oldest);
    }
    if (captions.videoId === currentYouTubeVideoId()) {
      retryAfter = 0;
      void discover();
    }
  };

  const setEnabled = (nextEnabled: boolean): void => {
    enabled = nextEnabled;
    if (enabled) {
      if (timer !== undefined) return;
      void discover();
      timer = window.setInterval(() => void discover(), 1_500);
      return;
    }
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    inFlightKey = "";
  };

  const rediscover = (): void => {
    if (!enabled) return;
    retryAfter = 0;
    void discover();
  };
  for (const eventName of [
    "yt-navigate-finish",
    "yt-page-data-updated",
    "yt-player-updated",
  ] as const) {
    window.addEventListener(eventName, rediscover);
  }
  document.addEventListener("loadedmetadata", rediscover, true);

  window.addEventListener(SUBTITLE_DISCOVERY_CONTROL_EVENT, (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (typeof detail === "boolean") {
      setEnabled(detail);
      return;
    }
    if (
      typeof detail !== "object" ||
      detail === null ||
      !("enabled" in detail) ||
      typeof detail.enabled !== "boolean"
    )
      return;
    if (
      "sourceLanguage" in detail &&
      typeof detail.sourceLanguage === "string" &&
      detail.sourceLanguage !== preferredSourceLanguage
    ) {
      preferredSourceLanguage = detail.sourceLanguage;
      youtubePreferredSourceLanguage = detail.sourceLanguage;
      lastFetchedKey = "";
      failedAttempts = 0;
      retryAfter = 0;
    }
    setEnabled(detail.enabled);
    if (detail.enabled) void discover();
  });
}

export default defineUnlistedScript(() => {
  const site = currentSite();
  if (!site) return;
  const hookedWindow = window as HookedWindow;
  if (hookedWindow[INSTALLATION_FLAG]) return;
  Object.defineProperty(hookedWindow, INSTALLATION_FLAG, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  const nativeFetch = installFetchHook(site);
  installXhrHook(site);
  if (site === "youtube") installYouTubeDiscovery(nativeFetch, hookedWindow);
  if (site === "netflix")
    installNetflixResourceRecovery(nativeFetch, hookedWindow);
  if (site === "max") installMaxDashDiscovery(nativeFetch);
  if (site === "max" || site === "disney-plus" || site === "prime-video") {
    installHlsVttDiscovery(site, nativeFetch);
  }
});
