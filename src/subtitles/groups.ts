import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";

export interface SubtitleSentenceGroup extends SubtitleCue {
  sourceCueIds: string[];
}

const MAX_GROUP_CUES = 6;
const MAX_GROUP_CHARACTERS = 160;
const MAX_GROUP_DURATION_MS = 8_000;
const MAX_GAP_MS = 700;
const MAX_OVERLAP_MS = 1_500;

const TERMINAL_PUNCTUATION = /[.!?。！？…]["'”’」』）)\]]*$/u;
const SPEAKER_OR_SOUND_PREFIX =
  /^(?:[-–—]\s+|>>\s*|♪|\[[^\]]+\]|\([^)]{1,40}\))\s*/u;
const CJK_BOUNDARY =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function normalizedCue(cue: SubtitleCue): SubtitleCue | null {
  const originalText = cue.originalText.replace(/\s+/gu, " ").trim();
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

function joinFragments(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  const leftBoundary = left.at(-1) ?? "";
  const rightBoundary = right.at(0) ?? "";
  const noSpace =
    /\s$/u.test(left) ||
    /^\s/u.test(right) ||
    CJK_BOUNDARY.test(leftBoundary) ||
    CJK_BOUNDARY.test(rightBoundary) ||
    /^[,.;:!?，。！？；：、）)\]”’]/u.test(rightBoundary);
  return `${left}${noSpace ? "" : " "}${right}`;
}

function stableGroupId(cues: readonly SubtitleCue[]): string {
  return `sentence:${cues.map((cue) => encodeURIComponent(cue.id)).join("+")}`;
}

function canMerge(group: readonly SubtitleCue[], next: SubtitleCue): boolean {
  const last = group.at(-1);
  const first = group[0];
  if (!last || !first || group.length >= MAX_GROUP_CUES) return false;
  if (TERMINAL_PUNCTUATION.test(last.originalText)) return false;
  if (SPEAKER_OR_SOUND_PREFIX.test(next.originalText)) return false;

  const previousEnd = last.endMs ?? next.startMs;
  const gap = next.startMs - previousEnd;
  if (gap > MAX_GAP_MS || gap < -MAX_OVERLAP_MS) return false;

  const endMs = next.endMs ?? next.startMs;
  if (endMs - first.startMs > MAX_GROUP_DURATION_MS) return false;

  const combinedText = group.reduce(
    (text, cue) => joinFragments(text, cue.originalText),
    "",
  );
  return (
    joinFragments(combinedText, next.originalText).length <=
    MAX_GROUP_CHARACTERS
  );
}

function createGroup(cues: readonly SubtitleCue[]): SubtitleSentenceGroup {
  const first = cues[0];
  const last = cues.at(-1);
  if (!first || !last)
    throw new Error("Cannot create an empty subtitle sentence group");
  return {
    id: stableGroupId(cues),
    startMs: first.startMs,
    endMs: last.endMs,
    originalText: cues.reduce(
      (text, cue) => joinFragments(text, cue.originalText),
      "",
    ),
    sourceCueIds: cues.map((cue) => cue.id),
  };
}

export function groupSubtitleCues(
  cues: readonly SubtitleCue[],
): SubtitleSentenceGroup[] {
  const ordered = cues
    .map(normalizedCue)
    .filter((cue): cue is SubtitleCue => cue !== null)
    .sort((left, right) => left.startMs - right.startMs);

  const groups: SubtitleSentenceGroup[] = [];
  let pending: SubtitleCue[] = [];

  for (const cue of ordered) {
    if (pending.length > 0 && !canMerge(pending, cue)) {
      groups.push(createGroup(pending));
      pending = [];
    }
    pending.push(cue);
  }

  if (pending.length > 0) groups.push(createGroup(pending));
  return groups;
}

export function groupFullSubtitleTrack(track: SubtitleTrack): SubtitleTrack {
  if (track.completeness !== "full") return track;
  return { ...track, cues: groupSubtitleCues(track.cues) };
}

export function groupForCue(
  groups: readonly SubtitleSentenceGroup[],
  cueId: string,
): SubtitleSentenceGroup | undefined {
  return groups.find((group) => group.sourceCueIds.includes(cueId));
}
