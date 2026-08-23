export const DECLARATIVE_CAPTURE_PROFILE_IDS = [
  "max",
  "disney-plus",
  "prime-video",
  "apple-tv",
  "hulu",
  "paramount-plus",
  "discovery-plus",
  "peacock",
  "fubo-tv",
  "ted",
  "bbc-iplayer",
  "zdf",
  "deutsche-welle",
  "udemy",
  "kanopy",
] as const;

export type DeclarativeCaptureProfileId =
  (typeof DECLARATIVE_CAPTURE_PROFILE_IDS)[number];

export const MAIN_WORLD_CAPTURE_PROFILE_IDS = [
  "youtube",
  "netflix",
  ...DECLARATIVE_CAPTURE_PROFILE_IDS,
] as const;

export const DOM_PROFILE_IDS = [
  ...DECLARATIVE_CAPTURE_PROFILE_IDS,
  "tver",
] as const;
