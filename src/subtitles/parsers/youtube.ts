import type { SubtitleTrack } from "@/src/subtitles/types";
import { createCue, MAX_SUBTITLE_CUES } from "@/src/subtitles/parsers/shared";

interface JsonRecord {
  [key: string]: unknown;
}

export function parseYouTubeJson3(
  input: unknown,
  language = "und",
): SubtitleTrack {
  const data: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (!isRecord(data) || !Array.isArray(data.events)) {
    throw new Error("Invalid YouTube json3 subtitle payload");
  }

  const cues: SubtitleTrack["cues"] = [];
  for (const event of data.events) {
    if (cues.length >= MAX_SUBTITLE_CUES) break;
    if (!isRecord(event)) {
      continue;
    }

    const startMs = finiteNonNegativeNumber(event.tStartMs);
    if (startMs === null || !Array.isArray(event.segs)) {
      continue;
    }

    const text = event.segs
      .map((segment) =>
        isRecord(segment) && typeof segment.utf8 === "string"
          ? segment.utf8
          : "",
      )
      .join("")
      .replace(/\u00a0/gu, " ")
      .trim();

    if (text.length === 0) {
      continue;
    }

    const durationMs = finiteNonNegativeNumber(event.dDurationMs);
    cues.push(
      createCue(
        "youtube-timedtext",
        cues.length,
        startMs,
        durationMs === null ? null : startMs + durationMs,
        text,
      ),
    );
  }

  return {
    source: "youtube-timedtext",
    completeness: "full",
    language,
    cues,
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
