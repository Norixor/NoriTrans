import { languageTagsMatch } from "@/src/shared/languages";
import { parseCapturedVtt } from "@/src/subtitles/adapters/captured-vtt";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";

export const MAX_HLS_VTT_SEGMENTS = 1_200;
export const MAX_HLS_VTT_TOTAL_CHARACTERS = 4_500_000;
export const HLS_VTT_PREFETCH_CONCURRENCY = 4;

export interface HlsSubtitleTrackPlan {
  language: string;
  label?: string;
  forced: boolean;
  default: boolean;
  url: string;
}

export interface HlsVttSegmentPlan {
  url: string;
  offsetMs: number;
  durationMs: number;
  byteRange?: { start: number; end: number };
}

export interface HlsVttMediaPlan {
  language: string;
  segments: HlsVttSegmentPlan[];
}

export interface HlsVttFullTrackBody {
  kind: "hls-vtt-full";
  language: string;
  segments: Array<{ body: string; offsetMs: number }>;
}

export type HlsVttFetch = (
  url: string,
  init: {
    credentials: "same-origin";
    signal: AbortSignal;
    headers?: Headers;
  },
) => Promise<Response>;

function attributeList(value: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gu;
  for (const match of value.matchAll(pattern)) {
    const key = match[1];
    let candidate = match[2];
    if (!key || candidate === undefined) continue;
    candidate = candidate.trim();
    if (candidate.startsWith('"') && candidate.endsWith('"')) {
      candidate = candidate.slice(1, -1);
    }
    attributes.set(key, candidate);
  }
  return attributes;
}

function resolvedAllowedUrl(
  value: string,
  baseUrl: string,
  isAllowedUrl: (url: string) => boolean,
): string | null {
  try {
    const url = new URL(value, baseUrl).href;
    return isAllowedUrl(url) ? url : null;
  } catch {
    return null;
  }
}

export function parseHlsSubtitleTracks(
  input: string,
  manifestUrl: string,
  isAllowedUrl: (url: string) => boolean,
): HlsSubtitleTrackPlan[] {
  if (!/^https:\/\//iu.test(manifestUrl)) return [];
  const lines = input.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines[0]?.trim() !== "#EXTM3U") return [];
  const tracks: HlsSubtitleTrackPlan[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#EXT-X-MEDIA:")) continue;
    const attributes = attributeList(trimmed.slice("#EXT-X-MEDIA:".length));
    if (attributes.get("TYPE")?.toUpperCase() !== "SUBTITLES") continue;
    const uri = attributes.get("URI");
    if (!uri) continue;
    const url = resolvedAllowedUrl(uri, manifestUrl, isAllowedUrl);
    if (!url) return [];
    const language =
      attributes.get("LANGUAGE") || attributes.get("ASSOC-LANGUAGE") || "und";
    const label = attributes.get("NAME")?.trim();
    tracks.push({
      language,
      ...(label ? { label } : {}),
      forced: attributes.get("FORCED")?.toUpperCase() === "YES",
      default: attributes.get("DEFAULT")?.toUpperCase() === "YES",
      url,
    });
  }
  return tracks;
}

export function selectHlsSubtitleTrack(
  tracks: readonly HlsSubtitleTrackPlan[],
  preferredLanguage: string,
): HlsSubtitleTrackPlan | null {
  const candidates =
    preferredLanguage === "auto"
      ? [...tracks]
      : tracks.filter((track) =>
          languageTagsMatch(preferredLanguage, track.language),
        );
  return (
    candidates.find((track) => track.default && !track.forced) ??
    candidates.find((track) => !track.forced) ??
    candidates[0] ??
    null
  );
}

function parseByteRange(
  value: string,
): { length: number; offset?: number } | null {
  const match = /^(\d+)(?:@(\d+))?$/u.exec(value.trim());
  if (!match) return null;
  const length = Number(match[1]);
  const offset = match[2] === undefined ? undefined : Number(match[2]);
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
  ) {
    return null;
  }
  return offset === undefined ? { length } : { length, offset };
}

/** Parses only finite WebVTT media playlists with an explicit ENDLIST. */
export function parseHlsVttMediaPlaylist(
  input: string,
  playlistUrl: string,
  language: string,
  isAllowedUrl: (url: string) => boolean,
): HlsVttMediaPlan | null {
  if (!/^https:\/\//iu.test(playlistUrl)) return null;
  const lines = input.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  if (lines[0]?.trim() !== "#EXTM3U") return null;
  const hasEndList = lines.some(
    (line) => line.trim().toUpperCase() === "#EXT-X-ENDLIST",
  );
  if (!hasEndList) return null;
  if (
    lines.some((line) => {
      const trimmed = line.trim();
      return (
        trimmed.startsWith("#EXT-X-KEY:") &&
        !/(?:^|,)METHOD=NONE(?:,|$)/u.test(trimmed.slice("#EXT-X-KEY:".length))
      );
    })
  ) {
    return null;
  }

  const segments: HlsVttSegmentPlan[] = [];
  let pendingDurationMs: number | undefined;
  let pendingRange: { length: number; offset?: number } | undefined;
  let timelineOffsetMs = 0;
  let previousRangeUrl = "";
  let previousRangeEnd = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#EXTINF:")) {
      const rawDuration = trimmed.slice("#EXTINF:".length).split(",", 1)[0];
      const durationSeconds = Number(rawDuration);
      if (
        !Number.isFinite(durationSeconds) ||
        durationSeconds <= 0 ||
        durationSeconds > 86_400
      ) {
        return null;
      }
      pendingDurationMs = Math.round(durationSeconds * 1_000);
      continue;
    }
    if (trimmed.startsWith("#EXT-X-BYTERANGE:")) {
      const parsed = parseByteRange(trimmed.slice("#EXT-X-BYTERANGE:".length));
      if (!parsed) return null;
      pendingRange = parsed;
      continue;
    }
    if (!trimmed || trimmed.startsWith("#") || pendingDurationMs === undefined)
      continue;
    const url = resolvedAllowedUrl(trimmed, playlistUrl, isAllowedUrl);
    if (!url) return null;
    let byteRange: HlsVttSegmentPlan["byteRange"];
    if (pendingRange) {
      const start =
        pendingRange.offset ??
        (previousRangeUrl === url ? previousRangeEnd : undefined);
      if (start === undefined) return null;
      const end = start + pendingRange.length - 1;
      if (!Number.isSafeInteger(end) || end < start) return null;
      byteRange = { start, end };
      previousRangeUrl = url;
      previousRangeEnd = end + 1;
    } else {
      previousRangeUrl = "";
      previousRangeEnd = 0;
    }
    segments.push({
      url,
      offsetMs: timelineOffsetMs,
      durationMs: pendingDurationMs,
      ...(byteRange ? { byteRange } : {}),
    });
    if (segments.length > MAX_HLS_VTT_SEGMENTS) return null;
    timelineOffsetMs += pendingDurationMs;
    if (!Number.isSafeInteger(timelineOffsetMs)) return null;
    pendingDurationMs = undefined;
    pendingRange = undefined;
  }

  if (
    pendingDurationMs !== undefined ||
    pendingRange !== undefined ||
    segments.length === 0
  ) {
    return null;
  }
  return { language, segments };
}

export function isHlsVttFullTrackBody(
  value: unknown,
): value is HlsVttFullTrackBody {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<HlsVttFullTrackBody>;
  if (
    body.kind !== "hls-vtt-full" ||
    typeof body.language !== "string" ||
    body.language.length === 0 ||
    body.language.length > 64 ||
    !Array.isArray(body.segments) ||
    body.segments.length === 0 ||
    body.segments.length > MAX_HLS_VTT_SEGMENTS
  ) {
    return false;
  }
  let totalCharacters = 0;
  for (const segment of body.segments) {
    if (
      typeof segment !== "object" ||
      segment === null ||
      typeof segment.body !== "string" ||
      segment.body.length === 0 ||
      segment.body.length > MAX_HLS_VTT_TOTAL_CHARACTERS ||
      typeof segment.offsetMs !== "number" ||
      !Number.isSafeInteger(segment.offsetMs) ||
      segment.offsetMs < 0
    ) {
      return false;
    }
    totalCharacters += segment.body.length;
    if (totalCharacters > MAX_HLS_VTT_TOTAL_CHARACTERS) return false;
  }
  return true;
}

function exactContentRange(
  value: string | null,
  range: { start: number; end: number },
): boolean {
  if (!value) return false;
  const match = /^bytes\s+(\d+)-(\d+)\/(?:\d+|\*)$/iu.exec(value.trim());
  return (
    match !== null &&
    Number(match[1]) === range.start &&
    Number(match[2]) === range.end
  );
}

/** Fetches every planned VTT segment or returns null without a partial body. */
export async function fetchHlsVttFullTrack(
  plan: HlsVttMediaPlan,
  fetchValue: HlsVttFetch,
  signal: AbortSignal,
  isAllowedResponseUrl: (url: string) => boolean = () => true,
): Promise<HlsVttFullTrackBody | null> {
  if (
    plan.segments.length === 0 ||
    plan.segments.length > MAX_HLS_VTT_SEGMENTS ||
    signal.aborted
  ) {
    return null;
  }
  const bodies = new Array<{ body: string; offsetMs: number }>(
    plan.segments.length,
  );
  let nextIndex = 0;
  let totalCharacters = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed && !signal.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      const segment = plan.segments[index];
      if (!segment) return;
      const headers = segment.byteRange
        ? new Headers({
            Range: `bytes=${segment.byteRange.start}-${segment.byteRange.end}`,
          })
        : undefined;
      try {
        const response = await fetchValue(segment.url, {
          credentials: "same-origin",
          signal,
          ...(headers ? { headers } : {}),
        });
        const contentRange = response.headers.get("content-range");
        if (
          !response.ok ||
          (response.url.length > 0 && !isAllowedResponseUrl(response.url)) ||
          (segment.byteRange
            ? response.status !== 206 ||
              !exactContentRange(contentRange, segment.byteRange)
            : response.status === 206 || Boolean(contentRange))
        ) {
          failed = true;
          return;
        }
        const contentLength = Number(response.headers.get("content-length"));
        if (
          Number.isFinite(contentLength) &&
          (contentLength < 0 ||
            contentLength > MAX_HLS_VTT_TOTAL_CHARACTERS - totalCharacters)
        ) {
          failed = true;
          return;
        }
        const body = await response.text();
        if (!/^WEBVTT(?:\s|$)/u.test(body.replace(/^\uFEFF/u, ""))) {
          failed = true;
          return;
        }
        totalCharacters += body.length;
        if (totalCharacters > MAX_HLS_VTT_TOTAL_CHARACTERS) {
          failed = true;
          return;
        }
        const parsed = parseCapturedVtt(body, plan.language);
        if (body.includes("-->") && parsed.cues.length === 0) {
          failed = true;
          return;
        }
        bodies[index] = { body, offsetMs: segment.offsetMs };
      } catch {
        failed = true;
        return;
      }
    }
  };

  await Promise.all(
    Array.from(
      {
        length: Math.min(HLS_VTT_PREFETCH_CONCURRENCY, plan.segments.length),
      },
      () => worker(),
    ),
  );
  if (failed || signal.aborted || bodies.some((body) => body === undefined)) {
    return null;
  }
  return { kind: "hls-vtt-full", language: plan.language, segments: bodies };
}

function fnv1a(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function assembleHlsVttFullTrack(
  body: HlsVttFullTrackBody,
): SubtitleTrack | null {
  if (!isHlsVttFullTrackBody(body)) return null;
  const cues = new Map<string, SubtitleCue>();
  for (const segment of body.segments) {
    const parsed = parseCapturedVtt(segment.body, body.language);
    if (segment.body.includes("-->") && parsed.cues.length === 0) return null;
    const hasTimestampMap = /^\s*X-TIMESTAMP-MAP\s*=/imu.test(segment.body);
    for (const parsedCue of parsed.cues) {
      const cue = hasTimestampMap
        ? parsedCue
        : {
            ...parsedCue,
            startMs: parsedCue.startMs + segment.offsetMs,
            endMs:
              parsedCue.endMs === null
                ? null
                : parsedCue.endMs + segment.offsetMs,
          };
      const identity = `${cue.startMs}\u001f${cue.originalText}`;
      const existing = cues.get(identity);
      if (existing) {
        if (existing.endMs === null) existing.endMs = cue.endMs;
        else if (cue.endMs !== null)
          existing.endMs = Math.max(existing.endMs, cue.endMs);
        continue;
      }
      cues.set(identity, {
        ...cue,
        id: `network:hls:${cue.startMs}:${fnv1a(cue.originalText)}`,
      });
    }
  }
  const ordered = [...cues.values()].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      (left.endMs ?? Number.MAX_SAFE_INTEGER) -
        (right.endMs ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  );
  if (ordered.length === 0) return null;
  return {
    source: "network",
    completeness: "full",
    captureEvidence: "verified-full-response",
    language: body.language,
    cues: ordered,
  };
}
