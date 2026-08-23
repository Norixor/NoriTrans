import type { SubtitleAdapter } from "@/src/subtitles/adapters/types";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";

const MAX_SESSION_CUES = 120;
const OCR_SIMILAR_SAMPLE_WINDOW_MS = 2_500;

interface PendingSimilarCue {
  text: string;
  firstSeenMs: number;
  lastSeenMs: number;
}

function comparisonText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu, "");
}

function differsByAtMostOneCharacter(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex += 1;
    else if (right.length > left.length) rightIndex += 1;
    else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return (
    edits + Number(leftIndex < left.length || rightIndex < right.length) <= 1
  );
}

function ocrVariationKind(
  left: string,
  right: string,
): "equivalent" | "single-edit" | null {
  const normalizedLeft = comparisonText(left);
  const normalizedRight = comparisonText(right);
  if (!normalizedLeft || !normalizedRight) return null;
  if (normalizedLeft === normalizedRight) return "equivalent";
  const minimumLength = /\p{Script=Han}/u.test(
    `${normalizedLeft}${normalizedRight}`,
  )
    ? 5
    : 8;
  return Math.max(normalizedLeft.length, normalizedRight.length) >=
    minimumLength &&
    differsByAtMostOneCharacter(normalizedLeft, normalizedRight)
    ? "single-edit"
    : null;
}

export class OcrSubtitleAdapter implements SubtitleAdapter {
  readonly id = "local-image-ocr";
  readonly priority = 100;
  readonly invalidationMode = "immediate" as const;
  private readonly listeners = new Set<(track: SubtitleTrack) => void>();
  private readonly invalidationListeners = new Set<() => void>();
  private cues: SubtitleCue[] = [];
  private active = false;
  private sequence = 0;
  private sessionId = "";
  private language = "und";
  private lastObservedAtMs = Number.NEGATIVE_INFINITY;
  private pendingSimilarCue: PendingSimilarCue | null = null;

  matches(): boolean {
    return true;
  }

  collect(): Promise<SubtitleTrack | null> {
    return Promise.resolve(
      this.active && this.cues.length > 0 ? this.track() : null,
    );
  }

  subscribe(listener: (track: SubtitleTrack) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => this.invalidationListeners.delete(listener);
  }

  begin(language = "und"): void {
    const invalidated = this.active && this.cues.length > 0;
    this.active = true;
    this.language = language || "und";
    this.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.sequence = 0;
    this.cues = [];
    this.lastObservedAtMs = Number.NEGATIVE_INFINITY;
    this.pendingSimilarCue = null;
    if (invalidated) this.publishInvalidation();
  }

  push(text: string, startMs: number): boolean {
    if (!this.active) return false;
    const normalized = text
      .replace(/[ \t]+/gu, " ")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    const safeStartMs = Math.max(0, Math.round(startMs));
    const latest = this.cues.at(-1);
    if (!normalized) return false;
    if (latest?.endMs === null) {
      const withinContinuousWindow =
        safeStartMs - this.lastObservedAtMs <= OCR_SIMILAR_SAMPLE_WINDOW_MS;
      const variation = ocrVariationKind(latest.originalText, normalized);
      if (withinContinuousWindow && variation) {
        this.lastObservedAtMs = safeStartMs;
        if (normalized === latest.originalText || variation === "equivalent") {
          this.pendingSimilarCue = null;
          return false;
        }
        const pending = this.pendingSimilarCue;
        if (
          pending &&
          pending.text === normalized &&
          safeStartMs - pending.lastSeenMs <= OCR_SIMILAR_SAMPLE_WINDOW_MS
        ) {
          pending.lastSeenMs = safeStartMs;
          if (
            safeStartMs - pending.firstSeenMs <
            OCR_SIMILAR_SAMPLE_WINDOW_MS
          ) {
            return false;
          }
          this.pendingSimilarCue = null;
          return this.appendCue(normalized, pending.firstSeenMs);
        }
        this.pendingSimilarCue = {
          text: normalized,
          firstSeenMs: safeStartMs,
          lastSeenMs: safeStartMs,
        };
        return false;
      }
    }
    this.pendingSimilarCue = null;
    this.lastObservedAtMs = safeStartMs;
    return this.appendCue(normalized, safeStartMs);
  }

  private appendCue(normalized: string, safeStartMs: number): boolean {
    const previous = this.cues.at(-1);
    if (previous && previous.endMs === null) {
      previous.endMs = Math.max(previous.startMs + 250, safeStartMs);
    }
    this.sequence += 1;
    this.cues.push({
      id: `ocr-${this.sessionId}-${this.sequence}`,
      startMs: safeStartMs,
      endMs: null,
      originalText: normalized,
    });
    if (this.cues.length > MAX_SESSION_CUES)
      this.cues.splice(0, this.cues.length - MAX_SESSION_CUES);
    this.publishTrack();
    return true;
  }

  end(endMs: number): boolean {
    if (!this.active) return false;
    const latest = this.cues.at(-1);
    if (!latest || latest.endMs !== null) return false;
    latest.endMs = Math.max(latest.startMs, Math.round(endMs));
    this.publishTrack();
    return true;
  }

  stop(): void {
    const invalidated = this.active && this.cues.length > 0;
    this.active = false;
    this.cues = [];
    this.pendingSimilarCue = null;
    if (invalidated) this.publishInvalidation();
  }

  private publishInvalidation(): void {
    for (const listener of this.invalidationListeners) listener();
  }

  private track(): SubtitleTrack {
    return {
      source: "ocr",
      completeness: "stream",
      language: this.language,
      cues: this.cues.map((cue) => ({ ...cue })),
    };
  }

  private publishTrack(): void {
    for (const listener of this.listeners) listener(this.track());
  }
}
