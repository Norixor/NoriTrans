import { parseClockTimestamp } from "@/src/subtitles/parsers/shared";
import { parseVtt } from "@/src/subtitles/parsers/vtt";
import type { SubtitleTrack } from "@/src/subtitles/types";

function vttTimestampOffset(input: string): number | null {
  const line = input
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .find((candidate) => /^\s*X-TIMESTAMP-MAP\s*=/iu.test(candidate));
  if (!line) return null;
  const attributes = line.slice(line.indexOf("=") + 1).split(",");
  const local = attributes
    .find((attribute) => /^\s*LOCAL\s*:/iu.test(attribute))
    ?.replace(/^\s*LOCAL\s*:\s*/iu, "");
  const mpegTimestamp = attributes
    .find((attribute) => /^\s*MPEGTS\s*:/iu.test(attribute))
    ?.replace(/^\s*MPEGTS\s*:\s*/iu, "");
  const localMs = local === undefined ? null : parseClockTimestamp(local);
  if (
    localMs === null ||
    mpegTimestamp === undefined ||
    !/^\d+$/u.test(mpegTimestamp)
  ) {
    return null;
  }
  const mpegTicks = Number(mpegTimestamp);
  return Number.isSafeInteger(mpegTicks) ? mpegTicks / 90 - localMs : null;
}

export function parseCapturedVtt(
  input: string,
  language: string,
): SubtitleTrack {
  const parserInput = input
    .split(/\r?\n/u)
    .filter((line) => !/^\s*X-TIMESTAMP-MAP\s*=/iu.test(line))
    .join("\n");
  const track = parseVtt(parserInput, language, "network");
  const offsetMs = vttTimestampOffset(input);
  if (offsetMs === null || offsetMs === 0) return track;
  return {
    ...track,
    cues: track.cues.map((cue) => ({
      ...cue,
      startMs: Math.round(cue.startMs + offsetMs),
      endMs: cue.endMs === null ? null : Math.round(cue.endMs + offsetMs),
    })),
  };
}
