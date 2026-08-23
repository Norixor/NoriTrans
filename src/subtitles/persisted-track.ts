import type { SubtitleTrack } from "@/src/subtitles/types";

const PERSISTED_SOURCES = new Set<SubtitleTrack["source"]>([
  "texttrack",
  "youtube-timedtext",
  "netflix-manifest",
  "network",
]);

export function isPersistedFullTrack(value: unknown): value is SubtitleTrack {
  if (typeof value !== "object" || value === null) return false;
  if (
    !("source" in value) ||
    typeof value.source !== "string" ||
    !PERSISTED_SOURCES.has(value.source as SubtitleTrack["source"]) ||
    !("completeness" in value) ||
    value.completeness !== "full" ||
    !("language" in value) ||
    typeof value.language !== "string" ||
    value.language.length === 0 ||
    value.language.length > 64 ||
    !("cues" in value) ||
    !Array.isArray(value.cues) ||
    value.cues.length === 0 ||
    value.cues.length > 20_000
  ) {
    return false;
  }
  return value.cues.every((cue: unknown) => {
    if (typeof cue !== "object" || cue === null) return false;
    return (
      "id" in cue &&
      typeof cue.id === "string" &&
      cue.id.length > 0 &&
      cue.id.length <= 512 &&
      "startMs" in cue &&
      typeof cue.startMs === "number" &&
      Number.isFinite(cue.startMs) &&
      cue.startMs >= 0 &&
      "endMs" in cue &&
      (cue.endMs === null ||
        (typeof cue.endMs === "number" &&
          Number.isFinite(cue.endMs) &&
          cue.endMs >= cue.startMs)) &&
      "originalText" in cue &&
      typeof cue.originalText === "string" &&
      cue.originalText.trim().length > 0 &&
      cue.originalText.length <= 20_000
    );
  });
}
