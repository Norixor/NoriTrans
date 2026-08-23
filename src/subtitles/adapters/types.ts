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
  setPreferredVideo?(video: HTMLVideoElement | null): void;
}
