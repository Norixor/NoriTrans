import type { SiteTranslationProfile } from "@/src/site-profiles/types";
import { parseSiteTranslationProfile } from "@/src/site-profiles/validation";
import { parseSiteProfile } from "@/src/subtitles/profiles/registry";
import type {
  BuiltInSubtitleParser,
  SubtitleSiteProfile,
} from "@/src/subtitles/profiles/types";

export interface SiteProfileDocument {
  id: string;
  version: 1;
  name: string;
  match: SiteTranslationProfile["match"];
  overrides: SiteTranslationProfile["overrides"];
  subtitleCapture: {
    /** False keeps the bundled capture rules and follows future updates. */
    customized: boolean;
    parser: BuiltInSubtitleParser;
    priority: number;
    selectors: SubtitleSiteProfile["selectors"];
    capture: SubtitleSiteProfile["capture"];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createSiteProfileDocument(
  translation: SiteTranslationProfile,
  capture: SubtitleSiteProfile,
  captureCustomized: boolean,
): SiteProfileDocument {
  return {
    ...translation,
    subtitleCapture: {
      customized: captureCustomized,
      parser: capture.parser,
      priority: capture.priority,
      selectors: structuredClone(capture.selectors),
      capture: structuredClone(capture.capture),
    },
  };
}

export function parseSiteProfileDocument(value: unknown): {
  document: SiteProfileDocument;
  translation: SiteTranslationProfile;
  capture: SubtitleSiteProfile;
} {
  if (!isRecord(value)) throw new Error("invalid_site_profile_document");
  const allowedKeys = new Set([
    "id",
    "version",
    "name",
    "match",
    "overrides",
    "subtitleCapture",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new Error("invalid_site_profile_document");
  }
  if (!isRecord(value.subtitleCapture)) {
    throw new Error("invalid_site_profile_document");
  }
  const subtitleCapture = value.subtitleCapture;
  const captureKeys = new Set([
    "customized",
    "parser",
    "priority",
    "selectors",
    "capture",
  ]);
  if (
    typeof subtitleCapture.customized !== "boolean" ||
    Object.keys(subtitleCapture).some((key) => !captureKeys.has(key))
  ) {
    throw new Error("invalid_site_profile_document");
  }

  const translation = parseSiteTranslationProfile({
    id: value.id,
    version: value.version,
    name: value.name,
    match: value.match,
    overrides: value.overrides,
  });
  const capture = parseSiteProfile({
    id: translation.id,
    version: translation.version,
    name: translation.name,
    match: translation.match,
    parser: subtitleCapture.parser,
    priority: subtitleCapture.priority,
    selectors: subtitleCapture.selectors,
    capture: subtitleCapture.capture,
  });
  return {
    document: value as unknown as SiteProfileDocument,
    translation,
    capture,
  };
}
