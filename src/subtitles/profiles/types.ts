export type BuiltInSubtitleParser = "html5" | "youtube" | "netflix" | "dom";

export interface SubtitleSiteProfile {
  id: string;
  version: 1;
  name: string;
  parser: BuiltInSubtitleParser;
  priority: number;
  match: {
    hostnameSuffixes: string[];
    urlRules?: Array<{
      hostnameSuffixes: string[];
      pathnamePrefixes: string[];
    }>;
  };
  selectors: {
    video: string;
    captions: string[];
    nativeCaptions: string[];
  };
  capture: {
    formats: Array<"vtt" | "ttml" | "json3">;
    allowedHostnameSuffixes: string[];
    urlPatterns: string[];
    /** A complete 2xx response matching one of these patterns is a full track. */
    completeFilePatterns?: string[];
  };
}
