import { isFastProviderId } from "@/src/shared/settings";
import type { SiteTranslationProfile } from "@/src/site-profiles/types";
import { SiteProfileValidationError } from "@/src/subtitles/profiles/registry";

const SAFE_HOSTNAME_SUFFIX =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function invalid(
  path: string,
  reason: ConstructorParameters<typeof SiteProfileValidationError>[1],
): never {
  throw new SiteProfileValidationError(path, reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey) invalid(`${path}.${unknownKey}`, "unknown_field");
}

function validateHostnameSuffixes(value: unknown, path: string): void {
  if (!Array.isArray(value)) invalid(path, "type");
  if (value.length === 0 || value.length > 32) invalid(path, "range");
  value.forEach((hostname, index) => {
    if (
      typeof hostname !== "string" ||
      hostname !== hostname.toLowerCase() ||
      !SAFE_HOSTNAME_SUFFIX.test(hostname)
    )
      invalid(`${path}[${index}]`, "unsafe_hostname");
  });
}

function validateMatch(value: unknown): void {
  if (!isRecord(value)) invalid("$.match", "required");
  assertOnlyKeys(value, ["hostnameSuffixes", "urlRules"], "$.match");
  validateHostnameSuffixes(value.hostnameSuffixes, "$.match.hostnameSuffixes");
  if (value.urlRules === undefined) return;
  if (!Array.isArray(value.urlRules) || value.urlRules.length > 32)
    invalid("$.match.urlRules", "range");
  value.urlRules.forEach((candidate, index) => {
    const path = `$.match.urlRules[${index}]`;
    if (!isRecord(candidate)) invalid(path, "type");
    assertOnlyKeys(candidate, ["hostnameSuffixes", "pathnamePrefixes"], path);
    validateHostnameSuffixes(
      candidate.hostnameSuffixes,
      `${path}.hostnameSuffixes`,
    );
    if (
      !Array.isArray(candidate.pathnamePrefixes) ||
      candidate.pathnamePrefixes.length === 0 ||
      candidate.pathnamePrefixes.length > 32
    )
      invalid(`${path}.pathnamePrefixes`, "range");
    candidate.pathnamePrefixes.forEach((prefix, prefixIndex) => {
      if (
        typeof prefix !== "string" ||
        !prefix.startsWith("/") ||
        prefix.length > 500 ||
        /[?#\r\n]/u.test(prefix)
      )
        invalid(`${path}.pathnamePrefixes[${prefixIndex}]`, "format");
    });
  });
}

function validateOptionalBoolean(
  value: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (value[key] !== undefined && typeof value[key] !== "boolean") {
    invalid(`${path}.${key}`, "format");
  }
}

function validateSurface(
  value: unknown,
  path: string,
  surface: "page" | "selection" | "subtitles",
): void {
  if (!isRecord(value)) invalid(path, "type");
  const surfaceKeys =
    surface === "page"
      ? [
          "aiResponseMode",
          "displayMode",
          "autoTranslate",
          "floatingButtonEnabled",
        ]
      : surface === "selection"
        ? ["enabled", "aiResponseMode", "displayMode"]
        : [
            "enabled",
            "floatingButtonEnabled",
            "aiResponseMode",
            "displayMode",
            "hideNativeSubtitles",
            "position",
            "customPosition",
            "fontScale",
            "backgroundOpacity",
          ];
  assertOnlyKeys(
    value,
    [
      "sourceLanguage",
      "targetLanguage",
      "mode",
      "fastProvider",
      "modelOverride",
      ...surfaceKeys,
    ],
    path,
  );
  for (const key of ["sourceLanguage", "targetLanguage"] as const) {
    const language = value[key];
    if (typeof language !== "string" || !language || language.length > 64)
      invalid(`${path}.${key}`, "format");
  }
  if (value.mode !== "fast" && value.mode !== "ai")
    invalid(`${path}.mode`, "format");
  if (!isFastProviderId(value.fastProvider))
    invalid(`${path}.fastProvider`, "format");
  if (
    typeof value.modelOverride !== "string" ||
    value.modelOverride.length > 256
  )
    invalid(`${path}.modelOverride`, "range");
  if (
    value.aiResponseMode !== undefined &&
    value.aiResponseMode !== "stream" &&
    value.aiResponseMode !== "batch"
  ) {
    invalid(`${path}.aiResponseMode`, "format");
  }
  if (
    value.displayMode !== undefined &&
    value.displayMode !== "translated" &&
    value.displayMode !== "bilingual" &&
    !(surface === "subtitles" && value.displayMode === "original")
  ) {
    invalid(`${path}.displayMode`, "format");
  }
  for (const key of [
    "enabled",
    "autoTranslate",
    "floatingButtonEnabled",
    "hideNativeSubtitles",
  ]) {
    validateOptionalBoolean(value, key, path);
  }
  if (surface !== "subtitles") return;
  if (
    value.position !== undefined &&
    value.position !== "top" &&
    value.position !== "center" &&
    value.position !== "bottom" &&
    value.position !== "custom"
  ) {
    invalid(`${path}.position`, "format");
  }
  if (value.customPosition !== undefined) {
    if (!isRecord(value.customPosition)) {
      invalid(`${path}.customPosition`, "type");
    }
    assertOnlyKeys(value.customPosition, ["x", "y"], `${path}.customPosition`);
    for (const axis of ["x", "y"] as const) {
      const coordinate = value.customPosition[axis];
      if (
        typeof coordinate !== "number" ||
        !Number.isFinite(coordinate) ||
        coordinate < 0 ||
        coordinate > 1
      ) {
        invalid(`${path}.customPosition.${axis}`, "range");
      }
    }
  }
  for (const [key, minimum, maximum] of [
    ["fontScale", 0.75, 1.8],
    ["backgroundOpacity", 0.3, 0.95],
  ] as const) {
    const setting = value[key];
    if (
      setting !== undefined &&
      (typeof setting !== "number" ||
        !Number.isFinite(setting) ||
        setting < minimum ||
        setting > maximum)
    ) {
      invalid(`${path}.${key}`, "range");
    }
  }
}

export function parseSiteTranslationProfile(
  value: unknown,
): SiteTranslationProfile {
  if (!isRecord(value)) invalid("$", "type");
  assertOnlyKeys(value, ["id", "version", "name", "match", "overrides"], "$");
  if (
    typeof value.id !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.id)
  )
    invalid("$.id", "format");
  if (value.version !== 1) invalid("$.version", "format");
  if (
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 100
  )
    invalid("$.name", "range");
  validateMatch(value.match);
  if (!isRecord(value.overrides)) invalid("$.overrides", "required");
  assertOnlyKeys(
    value.overrides,
    ["page", "selection", "subtitles"],
    "$.overrides",
  );
  for (const surface of ["page", "selection", "subtitles"] as const) {
    if (value.overrides[surface] !== undefined)
      validateSurface(
        value.overrides[surface],
        `$.overrides.${surface}`,
        surface,
      );
  }
  return value as unknown as SiteTranslationProfile;
}

export function isSiteTranslationProfile(
  value: unknown,
): value is SiteTranslationProfile {
  try {
    parseSiteTranslationProfile(value);
    return true;
  } catch {
    return false;
  }
}
