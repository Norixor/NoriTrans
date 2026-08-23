import type { TranslationSegment } from "@/src/translation/types";

interface ContextSourceSegment {
  id: string;
  text: string;
}

const DEFAULT_CONTEXT_RADIUS = 2;

function normalizeIdentityText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Deduplicates protected format and normalized source text within one task.
 * Context accompanies the representative segment, and stable IDs map its
 * result back to every duplicate without repeated requests or token usage.
 */
export function translationSegmentReuseIdentity(
  segment: TranslationSegment,
): string {
  return JSON.stringify({
    format: segment.format ?? "plain-text-v1",
    text: normalizeIdentityText(segment.text),
  });
}

export function contextualizeSegments(
  allSegments: readonly ContextSourceSegment[],
  selectedSegments: readonly ContextSourceSegment[] = allSegments,
  radius = DEFAULT_CONTEXT_RADIUS,
): TranslationSegment[] {
  const positions = new Map(
    allSegments.map((segment, index) => [segment.id, index]),
  );

  return selectedSegments.map((segment) => {
    const index = positions.get(segment.id);
    if (index === undefined || radius <= 0) return { ...segment };
    return {
      ...segment,
      contextBefore: allSegments
        .slice(Math.max(0, index - radius), index)
        .map((candidate) => candidate.text),
      contextAfter: allSegments
        .slice(index + 1, index + 1 + radius)
        .map((candidate) => candidate.text),
    };
  });
}

export function translationSegmentCacheText(
  segment: TranslationSegment,
): string {
  if (
    !segment.format &&
    !segment.contextBefore?.length &&
    !segment.contextAfter?.length
  ) {
    return segment.text;
  }
  return JSON.stringify({
    format: segment.format ?? "plain-text-v1",
    text: segment.text,
    contextBefore: segment.contextBefore ?? [],
    contextAfter: segment.contextAfter ?? [],
  });
}
