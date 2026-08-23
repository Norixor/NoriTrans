import type { SubtitleSource, SubtitleTrack } from "@/src/subtitles/types";
import {
  createCue,
  MAX_SUBTITLE_CUES,
  normalizeLineEndings,
  normalizeSubtitleText,
  parseClockTimestamp,
} from "@/src/subtitles/parsers/shared";

const TIMING_LINE_PATTERN = /^\s*(\S+)\s+-->\s+(\S+)/u;

export function parseVtt(
  input: string,
  language = "und",
  source: SubtitleSource = "network",
): SubtitleTrack {
  const lines = normalizeLineEndings(input).split("\n");
  const cues: SubtitleTrack["cues"] = [];
  let lineIndex = lines[0]?.trim().startsWith("WEBVTT") === true ? 1 : 0;

  while (lineIndex < lines.length && cues.length < MAX_SUBTITLE_CUES) {
    const currentLine = lines[lineIndex]?.trim() ?? "";
    if (currentLine.length === 0) {
      lineIndex += 1;
      continue;
    }

    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/u.test(currentLine)) {
      lineIndex = skipBlock(lines, lineIndex + 1);
      continue;
    }

    let timingLine = currentLine;
    if (!timingLine.includes("-->")) {
      lineIndex += 1;
      timingLine = lines[lineIndex]?.trim() ?? "";
    }

    const timingMatch = TIMING_LINE_PATTERN.exec(timingLine);
    if (timingMatch === null) {
      lineIndex = skipBlock(lines, lineIndex + 1);
      continue;
    }

    const startMs = parseClockTimestamp(timingMatch[1] ?? "");
    const endMs = parseClockTimestamp(timingMatch[2] ?? "");
    lineIndex += 1;

    const textLines: string[] = [];
    while (
      lineIndex < lines.length &&
      (lines[lineIndex]?.trim() ?? "") !== ""
    ) {
      textLines.push(lines[lineIndex] ?? "");
      lineIndex += 1;
    }

    const text = normalizeSubtitleText(textLines.join("\n"));
    if (
      startMs !== null &&
      endMs !== null &&
      endMs >= startMs &&
      text.length > 0
    ) {
      cues.push(createCue(source, cues.length, startMs, endMs, text));
    }
  }

  return {
    source,
    completeness: "full",
    language,
    cues,
  };
}

function skipBlock(lines: readonly string[], startIndex: number): number {
  let index = startIndex;
  while (index < lines.length && (lines[index]?.trim() ?? "") !== "") {
    index += 1;
  }
  return index;
}
