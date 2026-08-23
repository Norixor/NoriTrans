import { languageTagsMatch } from "@/src/shared/languages";

interface JsonRecord {
  [key: string]: unknown;
}

export interface YouTubeCaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  vssId?: string;
}

export interface YouTubePlayerResponseCaptions {
  videoId?: string;
  tracks: YouTubeCaptionTrack[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

export function extractYouTubeCaptionTracks(
  playerResponse: unknown,
): YouTubeCaptionTrack[] {
  if (!isRecord(playerResponse)) return [];
  const captions = playerResponse.captions;
  if (!isRecord(captions)) return [];
  const renderer = captions.playerCaptionsTracklistRenderer;
  if (!isRecord(renderer) || !Array.isArray(renderer.captionTracks)) return [];

  return renderer.captionTracks.slice(0, 100).flatMap((candidate: unknown) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.baseUrl !== "string" ||
      candidate.baseUrl.length === 0 ||
      candidate.baseUrl.length > 16_384 ||
      typeof candidate.languageCode !== "string" ||
      candidate.languageCode.length === 0 ||
      candidate.languageCode.length > 64
    ) {
      return [];
    }
    return [
      {
        baseUrl: candidate.baseUrl,
        languageCode: candidate.languageCode,
        ...(typeof candidate.kind === "string" && candidate.kind.length <= 32
          ? { kind: candidate.kind }
          : {}),
        ...(typeof candidate.vssId === "string" && candidate.vssId.length <= 128
          ? { vssId: candidate.vssId }
          : {}),
      },
    ];
  });
}

/** Retains only the media identity and allowlist-ready caption descriptors. */
export function extractYouTubePlayerResponseCaptions(
  playerResponse: unknown,
): YouTubePlayerResponseCaptions {
  const tracks = extractYouTubeCaptionTracks(playerResponse);
  if (!isRecord(playerResponse)) return { tracks };
  const videoDetails = playerResponse.videoDetails;
  if (!isRecord(videoDetails)) return { tracks };
  const videoId = videoDetails.videoId;
  return typeof videoId === "string" && /^[\w-]{6,32}$/u.test(videoId)
    ? { videoId, tracks }
    : { tracks };
}

export function selectYouTubeCaptionTrack(
  tracks: readonly YouTubeCaptionTrack[],
  preferredLanguage = "auto",
): YouTubeCaptionTrack | undefined {
  const preferred = preferredLanguage.trim().toLowerCase().replace(/_/gu, "-");
  if (preferred && preferred !== "auto") {
    const exact = tracks.filter(
      (track) =>
        track.languageCode.trim().toLowerCase().replace(/_/gu, "-") ===
        preferred,
    );
    if (exact.length > 0)
      return exact.find((track) => track.kind !== "asr") ?? exact[0];
    const samePrimary = tracks.filter((track) =>
      languageTagsMatch(preferred, track.languageCode),
    );
    if (samePrimary.length > 0)
      return (
        samePrimary.find((track) => track.kind !== "asr") ?? samePrimary[0]
      );
    return undefined;
  }
  return tracks.find((track) => track.kind !== "asr") ?? tracks[0];
}

export function youtubeJson3Url(
  trackOrBaseUrl: YouTubeCaptionTrack | string,
): string | null {
  try {
    const track =
      typeof trackOrBaseUrl === "string" ? undefined : trackOrBaseUrl;
    const baseUrl =
      typeof trackOrBaseUrl === "string"
        ? trackOrBaseUrl
        : trackOrBaseUrl.baseUrl;
    const url = new URL(baseUrl, location.href);
    if (track && !url.searchParams.has("lang")) {
      url.searchParams.set("lang", track.languageCode);
    }
    if (track?.kind && !url.searchParams.has("kind")) {
      url.searchParams.set("kind", track.kind);
    }
    // Keep a provider-supplied `tlang` intact. It identifies an explicitly
    // translated YouTube caption variant and is part of the track identity.
    url.searchParams.set("fmt", "json3");
    return url.href;
  } catch {
    return null;
  }
}
