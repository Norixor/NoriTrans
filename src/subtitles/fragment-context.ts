import { contextualizeSegments } from "@/src/translation/context";
import type { TranslationSegment } from "@/src/translation/types";
import {
  groupSubtitleCues,
  type SubtitleSentenceGroup,
} from "@/src/subtitles/groups";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";

/**
 * TRANSLATE requests accept at most four context entries per side (see the
 * messaging guard), so this is the hard per-side bound for smoothed segments.
 */
export const MAX_FRAGMENT_CONTEXT_ITEMS = 4;
/** Neighboring dialogue keeps the radius used for ordinary AI subtitle cues. */
export const FRAGMENT_NEIGHBOR_RADIUS = 2;
/**
 * Character budget per side for neighboring dialogue. Same-sentence fragments
 * are always included (a sentence group is itself capped at 160 characters).
 */
export const MAX_FRAGMENT_NEIGHBOR_CHARACTERS = 600;

const groupsByTrack = new WeakMap<SubtitleTrack, SubtitleSentenceGroup[]>();

/** Sentence groups of a track, computed once per immutable track object. */
function sentenceGroupsFor(track: SubtitleTrack): SubtitleSentenceGroup[] {
  let groups = groupsByTrack.get(track);
  if (!groups) {
    groups = groupSubtitleCues(track.cues);
    groupsByTrack.set(track, groups);
  }
  return groups;
}

/**
 * Collapses the farthest same-sentence fragments into one entry when a
 * sentence has more fragments on one side than the protocol allows.
 */
function boundedFragments(
  fragments: readonly string[],
  side: "before" | "after",
): string[] {
  if (fragments.length <= MAX_FRAGMENT_CONTEXT_ITEMS) return [...fragments];
  const keep = MAX_FRAGMENT_CONTEXT_ITEMS - 1;
  if (side === "before") {
    const far = fragments.slice(0, fragments.length - keep).join(" ");
    return [far, ...fragments.slice(fragments.length - keep)];
  }
  const far = fragments.slice(keep).join(" ");
  return [...fragments.slice(0, keep), far];
}

/** Nearest-first neighbors within the remaining item and character budget. */
function boundedNeighbors(
  nearestFirst: readonly string[],
  remainingItems: number,
): string[] {
  const selected: string[] = [];
  let characters = 0;
  for (const text of nearestFirst) {
    if (
      selected.length >= Math.min(remainingItems, FRAGMENT_NEIGHBOR_RADIUS) ||
      characters + text.length > MAX_FRAGMENT_NEIGHBOR_CHARACTERS
    ) {
      break;
    }
    selected.push(text);
    characters += text.length;
  }
  return selected;
}

/**
 * Builds AI segments for sentence smoothing. Every cue stays its own segment
 * (stable cue ID, own text). A cue that belongs to a multi-cue sentence group
 * gets every other fragment of that sentence as context, nearest to its text,
 * followed outward by up to two neighboring cues outside the sentence. A cue
 * outside any multi-cue group gets exactly the ordinary AI context.
 */
export function fragmentAwareSegments(
  track: SubtitleTrack,
  selected: readonly SubtitleCue[],
): TranslationSegment[] {
  const groups = sentenceGroupsFor(track);
  const groupByCueId = new Map<string, SubtitleSentenceGroup>();
  for (const group of groups) {
    if (group.sourceCueIds.length < 2) continue;
    for (const cueId of group.sourceCueIds) groupByCueId.set(cueId, group);
  }
  const allSegments = track.cues.map((cue) => ({
    id: cue.id,
    text: cue.originalText,
  }));
  const positions = new Map(track.cues.map((cue, index) => [cue.id, index]));
  const textById = new Map(track.cues.map((cue) => [cue.id, cue.originalText]));

  return selected.map((cue) => {
    const group = groupByCueId.get(cue.id);
    if (!group) {
      const [plain] = contextualizeSegments(allSegments, [
        { id: cue.id, text: cue.originalText },
      ]);
      return plain ?? { id: cue.id, text: cue.originalText };
    }
    const fragmentIndex = group.sourceCueIds.indexOf(cue.id);
    const fragmentText = (id: string): string => textById.get(id) ?? "";
    const siblingsBefore = boundedFragments(
      group.sourceCueIds
        .slice(0, fragmentIndex)
        .map(fragmentText)
        .filter((text) => text.trim()),
      "before",
    );
    const siblingsAfter = boundedFragments(
      group.sourceCueIds
        .slice(fragmentIndex + 1)
        .map(fragmentText)
        .filter((text) => text.trim()),
      "after",
    );

    const memberIds = new Set(group.sourceCueIds);
    const memberPositions = group.sourceCueIds
      .map((id) => positions.get(id))
      .filter((position): position is number => position !== undefined);
    const firstPosition = Math.min(...memberPositions);
    const lastPosition = Math.max(...memberPositions);
    const neighborsBefore = boundedNeighbors(
      allSegments
        .slice(
          Math.max(0, firstPosition - FRAGMENT_NEIGHBOR_RADIUS),
          firstPosition,
        )
        .filter((segment) => !memberIds.has(segment.id))
        .map((segment) => segment.text)
        .reverse(),
      MAX_FRAGMENT_CONTEXT_ITEMS - siblingsBefore.length,
    ).reverse();
    const neighborsAfter = boundedNeighbors(
      allSegments
        .slice(lastPosition + 1, lastPosition + 1 + FRAGMENT_NEIGHBOR_RADIUS)
        .filter((segment) => !memberIds.has(segment.id))
        .map((segment) => segment.text),
      MAX_FRAGMENT_CONTEXT_ITEMS - siblingsAfter.length,
    );
    return {
      id: cue.id,
      text: cue.originalText,
      contextBefore: [...neighborsBefore, ...siblingsBefore],
      contextAfter: [...siblingsAfter, ...neighborsAfter],
    };
  });
}
