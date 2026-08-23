import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";

function fnv1a(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeCue(cue: SubtitleCue): SubtitleCue | null {
  const originalText = cue.originalText.trim();
  if (
    !cue.id ||
    !Number.isFinite(cue.startMs) ||
    cue.startMs < 0 ||
    !originalText
  ) {
    return null;
  }
  const endMs =
    cue.endMs !== null && Number.isFinite(cue.endMs) && cue.endMs >= cue.startMs
      ? cue.endMs
      : null;
  return { ...cue, endMs, originalText };
}

export function normalizeSubtitleTrack(track: SubtitleTrack): SubtitleTrack {
  const cues = track.cues
    .map(normalizeCue)
    .filter((cue): cue is SubtitleCue => cue !== null)
    .map((cue, index) => ({ cue, index }))
    .sort(
      (left, right) =>
        left.cue.startMs - right.cue.startMs || left.index - right.index,
    )
    .map(({ cue }) => cue);
  return { ...track, cues };
}

export function subtitleTrackFingerprint(track: SubtitleTrack): string {
  const material = [
    track.source,
    track.completeness,
    track.language,
    ...track.cues.flatMap((cue) => [
      cue.id,
      String(cue.startMs),
      String(cue.endMs ?? ""),
      cue.originalText,
    ]),
  ].join("\u001f");
  return fnv1a(material);
}
