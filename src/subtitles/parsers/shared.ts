import type { SubtitleCue, SubtitleSource } from "@/src/subtitles/types";

const CLOCK_TIME_PATTERN = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/;
export const MAX_SUBTITLE_CUES = 20_000;
export const MAX_SUBTITLE_CUE_CHARACTERS = 2_000;

export function parseClockTimestamp(value: string): number | null {
  const match = CLOCK_TIME_PATTERN.exec(value.trim());
  if (match === null) {
    return null;
  }

  const hours = Number(match[1] ?? "0");
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number((match[4] ?? "").padEnd(3, "0"));

  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    minutes >= 60 ||
    seconds >= 60
  ) {
    return null;
  }

  return ((hours * 60 + minutes) * 60 + seconds) * 1_000 + milliseconds;
}

export function createCue(
  source: SubtitleSource,
  index: number,
  startMs: number,
  endMs: number | null,
  originalText: string,
): SubtitleCue {
  return {
    id: `${source}:${index}:${Math.round(startMs)}`,
    startMs,
    endMs,
    originalText: originalText.slice(0, MAX_SUBTITLE_CUE_CHARACTERS),
  };
}

export function normalizeLineEndings(input: string): string {
  return input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function normalizeSubtitleText(input: string): string {
  return input
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/giu, "\u00a0")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&amp;/giu, "&")
    .replace(/&#39;/giu, "'")
    .replace(/&quot;/giu, '"')
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
