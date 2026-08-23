/** Whether the adapter has the complete timeline or only cues observed so far. */
export type SubtitleCompleteness = "full" | "stream";

export type SubtitleCaptureEvidence =
  | "verified-full-response"
  | "http-partial"
  | "request-range"
  | "content-range"
  | "live-or-segmented"
  | "continuous-growth"
  | "unknown";

export type SubtitleSource =
  | "texttrack"
  | "youtube-timedtext"
  | "netflix-manifest"
  | "network"
  | "dom"
  | "ocr";

export interface SubtitleCue {
  /** Stable within the media identity; never use the array index as persistence identity. */
  id: string;
  /** Inclusive cue start on the media timeline, in milliseconds. */
  startMs: number;
  /** Exclusive cue end in milliseconds, or `null` until the next live cue arrives. */
  endMs: number | null;
  originalText: string;
}

/** Normalized adapter output consumed by one shared translation and cache pipeline. */
export interface SubtitleTrack {
  source: SubtitleSource;
  completeness: SubtitleCompleteness;
  /** Evidence used to classify network completeness; non-network adapters may omit it. */
  captureEvidence?: SubtitleCaptureEvidence;
  /** BCP 47 language tag when known, otherwise `und`. */
  language: string;
  cues: SubtitleCue[];
}
