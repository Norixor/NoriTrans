import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";

/** Retains recent live captions without allowing an hours-long stream to grow forever. */
export const MAX_LIVE_STREAM_CUES = 600;

export function appendLiveStreamCue(
  cues: SubtitleCue[],
  cue: SubtitleCue,
): void {
  cues.push(cue);
  if (cues.length > MAX_LIVE_STREAM_CUES) {
    cues.splice(0, cues.length - MAX_LIVE_STREAM_CUES);
  }
}

export interface SubtitleAdapter {
  readonly id: string;
  /** Higher-priority matching adapters are considered before generic fallbacks. */
  readonly priority: number;
  /**
   * `immediate` is reserved for adapters whose invalidation starts a new
   * timeline. Their outstanding translations must not survive the reset.
   */
  readonly invalidationMode?: "grace" | "immediate";
  /** Returns whether this adapter is eligible for the current page location. */
  matches(location: Location): boolean;
  /** Collects the best current track snapshot without changing page playback. */
  collect(): Promise<SubtitleTrack | null>;
  /** Subscribes to validated track updates and returns an idempotent disposer. */
  subscribe?(listener: (track: SubtitleTrack) => void): () => void;
  /** Signals that the current media timeline must no longer be reused. */
  subscribeInvalidation?(listener: () => void): () => void;
  setSourceLanguage?(language: string): void;
  /**
   * Language tag of a usable track the adapter skipped for the current media
   * only because it did not match the configured source language. Used to
   * explain an empty discovery; it never carries subtitle text.
   */
  skippedSourceLanguage?(): string | undefined;
  setPreferredVideo?(video: HTMLVideoElement | null): void;
  /**
   * Text of the caption the website itself currently shows for the active
   * video, or an empty string. Must ignore the extension's own hiding of
   * native captions. Lets the controller verify that a selected full track
   * really belongs to the playing media.
   */
  nativeCaptionText?(): string;
  /**
   * Drops the captured track the controller proved wrong for the current
   * media and allows rediscovery; the same document must not be accepted
   * again for this media session. Must not broadcast an invalidation.
   */
  discardCapturedTrack?(): void;
}
