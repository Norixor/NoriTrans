import { MAX_SUBTITLE_CUES } from "@/src/subtitles/parsers/shared";
import type {
  SubtitleCaptureEvidence,
  SubtitleCue,
  SubtitleTrack,
} from "@/src/subtitles/types";

import type { CapturedSubtitlePayload } from "./captured";

function fnv1a(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cueIdentity(cue: SubtitleCue): string {
  return `${cue.startMs}\u001f${cue.originalText}`;
}

export function capturedResponseEvidence(
  payload: CapturedSubtitlePayload,
): SubtitleCaptureEvidence {
  if (payload.requestRange === true) return "request-range";
  if (payload.responseStatus === 206) return "http-partial";
  if (payload.contentRange?.trim()) return "content-range";
  if (payload.partial === true) return "http-partial";
  if (
    payload.partial === false &&
    payload.requestRange === false &&
    payload.contentRange === undefined &&
    payload.responseStatus !== undefined &&
    payload.responseStatus >= 200 &&
    payload.responseStatus < 300
  ) {
    return "verified-full-response";
  }
  return "unknown";
}

/** A full HTTP response that keeps appending cues for one media track is only a stream snapshot. */
export function capturedTrackShowsContinuousGrowth(
  previous: SubtitleTrack | undefined,
  incoming: SubtitleTrack,
): boolean {
  if (!previous || incoming.cues.length <= previous.cues.length) return false;
  const incomingCueIds = new Set(incoming.cues.map(cueIdentity));
  return previous.cues.every((cue) => incomingCueIds.has(cueIdentity(cue)));
}

function stableCapturedCue(
  source: SubtitleTrack["source"],
  cue: SubtitleCue,
): SubtitleCue {
  return {
    ...cue,
    id: `${source}:captured:${cue.startMs}:${fnv1a(cue.originalText)}`,
  };
}

function laterEnd(
  current: number | null,
  candidate: number | null,
): number | null {
  if (current === null) return candidate;
  if (candidate === null) return current;
  return Math.max(current, candidate);
}

/** Merges overlapping network fragments without relying on fragment-local cue IDs. */
export function mergeCapturedStreamTrack(
  current: SubtitleTrack | null,
  incoming: SubtitleTrack,
): SubtitleTrack {
  const cues = new Map<string, SubtitleCue>();
  for (const cue of [...(current?.cues ?? []), ...incoming.cues]) {
    const identity = cueIdentity(cue);
    const existing = cues.get(identity);
    if (existing) {
      existing.endMs = laterEnd(existing.endMs, cue.endMs);
      continue;
    }
    cues.set(identity, stableCapturedCue(incoming.source, cue));
  }
  const ordered = [...cues.values()].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      (left.endMs ?? Number.MAX_SAFE_INTEGER) -
        (right.endMs ?? Number.MAX_SAFE_INTEGER) ||
      left.originalText.localeCompare(right.originalText) ||
      left.id.localeCompare(right.id),
  );
  return {
    ...incoming,
    completeness: "stream",
    cues: ordered.slice(-MAX_SUBTITLE_CUES),
  };
}
