import { normalizeAutoTranslateSitePattern } from "@/src/shared/auto-translate-sites";
import {
  isFastProviderId,
  mergeSettings,
  toContentSettings,
  type AppSettings,
  type ContentSettings,
  type FloatingSettings,
  type ImageTranslationSettings,
  type OcrSettings,
  type PageSettings,
  type ProviderSettings,
  type SubtitleSettings,
  type UiLanguage,
} from "@/src/shared/settings";
import type { ContentMessageSender } from "@/src/shared/content-sender";

/**
 * Field-level settings update sent by extension pages (`SETTINGS_PATCH`).
 *
 * Only persisted, non-secret fields can be patched. Credentials (API keys),
 * the AI endpoint and the model stay on the explicit "save and test" path so
 * a patch can never read or overwrite them, and runtime-only per-site
 * overrides are not part of the stored shape at all.
 */
export const PATCHABLE_PROVIDER_KEYS = ["fastProvider"] as const;
export const PATCHABLE_PAGE_KEYS = [
  "sourceLanguage",
  "targetLanguage",
  "mode",
  "aiResponseMode",
  "displayMode",
  "autoTranslate",
  "autoTranslateSitePatterns",
  "autoTranslateExcludedSitePatterns",
  "floatingButtonEnabled",
  "showSkippedMarks",
  "selectionTranslationEnabled",
  "selectionTranslationSourceLanguage",
  "selectionTranslationTargetLanguage",
  "selectionTranslationMode",
  "selectionTranslationAiResponseMode",
  "selectionTranslationModelOverride",
  "selectionTranslationDisplayMode",
] as const;
export const PATCHABLE_SUBTITLE_KEYS = [
  "enabled",
  "floatingButtonEnabled",
  "sourceLanguage",
  "targetLanguage",
  "mode",
  "aiResponseMode",
  "displayMode",
  "hideNativeSubtitles",
  "sentenceSmoothing",
  "position",
  "customPosition",
  "fontScale",
  "backgroundOpacity",
] as const;
export const PATCHABLE_OCR_KEYS = [
  "enabled",
  "sourceLanguage",
  "targetLanguage",
  "provider",
] as const;
export const PATCHABLE_IMAGE_KEYS = [
  "enabled",
  "sourceLanguage",
  "targetLanguage",
  "mode",
  "modelOverride",
  "displayMode",
] as const;
export const PATCHABLE_FLOATING_KEYS = ["announcements"] as const;

export interface SettingsPatch {
  uiLanguage?: UiLanguage;
  provider?: Partial<
    Pick<ProviderSettings, (typeof PATCHABLE_PROVIDER_KEYS)[number]>
  >;
  page?: Partial<Pick<PageSettings, (typeof PATCHABLE_PAGE_KEYS)[number]>>;
  subtitles?: Partial<
    Pick<SubtitleSettings, (typeof PATCHABLE_SUBTITLE_KEYS)[number]>
  >;
  ocr?: Partial<Pick<OcrSettings, (typeof PATCHABLE_OCR_KEYS)[number]>>;
  imageTranslation?: Partial<
    Pick<ImageTranslationSettings, (typeof PATCHABLE_IMAGE_KEYS)[number]>
  >;
  floating?: Partial<
    Pick<FloatingSettings, (typeof PATCHABLE_FLOATING_KEYS)[number]>
  >;
}

export type SettingsPatchSection = Exclude<keyof SettingsPatch, "uiLanguage">;

export interface SettingsPatchMessage {
  type: "SETTINGS_PATCH";
  patch: SettingsPatch;
}

export type SettingsPatchResponse =
  | {
      ok: true;
      code: "settings_patch_applied";
      /** The stored result without credentials, after normalization. */
      settings: ContentSettings;
    }
  | { ok: false; code: "settings_patch_invalid"; path: string }
  | { ok: false; code: "settings_patch_sender_rejected" }
  | { ok: false; code: "settings_patch_save_failed" };

export type SettingsPatchParseResult =
  { ok: true; patch: SettingsPatch } | { ok: false; path: string };

type Validator = (value: unknown) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

const oneOf =
  (...values: readonly unknown[]): Validator =>
  (value) =>
    values.includes(value);
const isBoolean: Validator = (value) => typeof value === "boolean";
const isLanguage: Validator = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 64;
const isShortText: Validator = (value) =>
  typeof value === "string" && value.length <= 256;
const numberIn =
  (min: number, max: number): Validator =>
  (value) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max;
const isUnitPosition: Validator = (value) =>
  isPlainRecord(value) &&
  Object.keys(value).length === 2 &&
  numberIn(0, 1)(value.x) &&
  numberIn(0, 1)(value.y);
const isSitePatterns: Validator = (value) => {
  if (!Array.isArray(value) || value.length > 500) return false;
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") return false;
    if (normalizeAutoTranslateSitePattern(candidate) !== candidate) {
      return false;
    }
    if (seen.has(candidate)) return false;
    seen.add(candidate);
  }
  return true;
};
const isMode = oneOf("fast", "ai");
const isResponseMode = oneOf("stream", "batch");
const isDisplayMode = oneOf("translated", "bilingual");

const SECTION_VALIDATORS: Record<
  SettingsPatchSection,
  Readonly<Record<string, Validator>>
> = {
  provider: { fastProvider: isFastProviderId },
  page: {
    sourceLanguage: isLanguage,
    targetLanguage: isLanguage,
    mode: isMode,
    aiResponseMode: isResponseMode,
    displayMode: isDisplayMode,
    autoTranslate: isBoolean,
    autoTranslateSitePatterns: isSitePatterns,
    autoTranslateExcludedSitePatterns: isSitePatterns,
    floatingButtonEnabled: isBoolean,
    showSkippedMarks: isBoolean,
    selectionTranslationEnabled: isBoolean,
    selectionTranslationSourceLanguage: isLanguage,
    selectionTranslationTargetLanguage: isLanguage,
    selectionTranslationMode: isMode,
    selectionTranslationAiResponseMode: isResponseMode,
    selectionTranslationModelOverride: isShortText,
    selectionTranslationDisplayMode: isDisplayMode,
  },
  subtitles: {
    enabled: isBoolean,
    floatingButtonEnabled: isBoolean,
    sourceLanguage: isLanguage,
    targetLanguage: isLanguage,
    mode: isMode,
    aiResponseMode: isResponseMode,
    displayMode: oneOf("translated", "bilingual", "original"),
    hideNativeSubtitles: isBoolean,
    sentenceSmoothing: isBoolean,
    position: oneOf("top", "center", "bottom", "custom"),
    customPosition: isUnitPosition,
    fontScale: numberIn(0.75, 1.8),
    backgroundOpacity: numberIn(0.3, 0.95),
  },
  ocr: {
    enabled: isBoolean,
    sourceLanguage: isLanguage,
    targetLanguage: isLanguage,
    provider: oneOf("chrome-local", "bergamot-local"),
  },
  imageTranslation: {
    enabled: isBoolean,
    sourceLanguage: isLanguage,
    targetLanguage: isLanguage,
    mode: isMode,
    modelOverride: isShortText,
    displayMode: isDisplayMode,
  },
  floating: { announcements: isBoolean },
};

export const SETTINGS_PATCH_SECTIONS = Object.keys(
  SECTION_VALIDATORS,
) as SettingsPatchSection[];

/**
 * Strictly validates an untrusted patch. Unknown sections or keys, wrong
 * types, out-of-range numbers, credential fields and empty patches are all
 * rejected with the dotted path of the first offending field; nothing is
 * coerced here (normalization happens when the patch is merged).
 */
export function parseSettingsPatch(value: unknown): SettingsPatchParseResult {
  if (!isPlainRecord(value)) return { ok: false, path: "patch" };
  const entries = Object.entries(value);
  if (entries.length === 0) return { ok: false, path: "patch" };
  const patch: SettingsPatch = {};
  const target = patch as Record<string, unknown>;
  for (const [sectionKey, sectionValue] of entries) {
    if (sectionKey === "uiLanguage") {
      if (!oneOf("auto", "en", "zh-CN")(sectionValue)) {
        return { ok: false, path: "uiLanguage" };
      }
      target.uiLanguage = sectionValue;
      continue;
    }
    if (!Object.hasOwn(SECTION_VALIDATORS, sectionKey)) {
      return { ok: false, path: sectionKey };
    }
    const validators = SECTION_VALIDATORS[sectionKey as SettingsPatchSection];
    if (!isPlainRecord(sectionValue)) return { ok: false, path: sectionKey };
    const fields = Object.entries(sectionValue);
    if (fields.length === 0) return { ok: false, path: sectionKey };
    const section: Record<string, unknown> = {};
    for (const [fieldKey, fieldValue] of fields) {
      const validate = Object.hasOwn(validators, fieldKey)
        ? validators[fieldKey]
        : undefined;
      if (!validate?.(fieldValue)) {
        return { ok: false, path: `${sectionKey}.${fieldKey}` };
      }
      section[fieldKey] = structuredClone(fieldValue);
    }
    target[sectionKey] = section;
  }
  return { ok: true, patch };
}

/**
 * Applies a validated patch to stored settings and re-runs the regular
 * normalization, so a patched store is indistinguishable from one written by
 * any other path. Untouched fields, including credentials, keep their values.
 */
export function applySettingsPatch(
  current: AppSettings,
  patch: SettingsPatch,
): AppSettings {
  const next = structuredClone(current) as unknown as Record<string, unknown>;
  if (patch.uiLanguage !== undefined) next.uiLanguage = patch.uiLanguage;
  for (const section of SETTINGS_PATCH_SECTIONS) {
    const fields = patch[section];
    if (!fields) continue;
    next[section] = {
      ...(next[section] as Record<string, unknown>),
      ...structuredClone(fields),
    };
  }
  return mergeSettings(next);
}

/** Merges `later` over `earlier`; later fields win. */
export function mergeSettingsPatches(
  earlier: SettingsPatch,
  later: SettingsPatch,
): SettingsPatch {
  const merged: SettingsPatch = { ...earlier };
  if (later.uiLanguage !== undefined) merged.uiLanguage = later.uiLanguage;
  for (const section of SETTINGS_PATCH_SECTIONS) {
    const fields = later[section];
    if (!fields) continue;
    (merged as Record<string, unknown>)[section] = {
      ...(earlier[section] ?? {}),
      ...fields,
    };
  }
  return merged;
}

/** Dotted paths (`page.mode`, `uiLanguage`) touched by a patch. */
export function settingsPatchPaths(patch: SettingsPatch): string[] {
  const paths: string[] = [];
  if (patch.uiLanguage !== undefined) paths.push("uiLanguage");
  for (const section of SETTINGS_PATCH_SECTIONS) {
    for (const key of Object.keys(patch[section] ?? {})) {
      paths.push(`${section}.${key}`);
    }
  }
  return paths;
}

export interface SettingsPatchDeps {
  extension: { id: string; baseUrl: string };
  /** Extension documents that must never write settings (e.g. offscreen). */
  rejectedPageUrls?: readonly string[];
  mutateSettings(
    update: (current: AppSettings) => AppSettings,
  ): Promise<AppSettings>;
}

/**
 * True only for this extension's own visible pages (options, popup). Content
 * scripts share the extension ID but report the web page URL, so they fail
 * the base-URL check.
 */
export function isSettingsPageSender(
  sender: ContentMessageSender,
  deps: Pick<SettingsPatchDeps, "extension" | "rejectedPageUrls">,
): boolean {
  if (sender.id !== deps.extension.id) return false;
  const url = sender.url;
  if (!url?.startsWith(deps.extension.baseUrl)) return false;
  const withoutQuery = url.split(/[?#]/u, 1)[0] ?? url;
  return !(deps.rejectedPageUrls ?? []).includes(withoutQuery);
}

export function isSettingsPatchMessage(
  value: unknown,
): value is { type: "SETTINGS_PATCH" } {
  return isRecord(value) && value.type === "SETTINGS_PATCH";
}

/**
 * Handles `SETTINGS_PATCH`: sender check, strict payload validation, then a
 * serialized read-modify-write through `mutateSettings` (which also persists
 * and broadcasts `SETTINGS_UPDATED`). Each outcome has its own stable code.
 */
export async function handleSettingsPatch(
  message: unknown,
  sender: ContentMessageSender,
  deps: SettingsPatchDeps,
): Promise<SettingsPatchResponse> {
  if (!isSettingsPageSender(sender, deps)) {
    return { ok: false, code: "settings_patch_sender_rejected" };
  }
  if (!isRecord(message) || message.type !== "SETTINGS_PATCH") {
    return { ok: false, code: "settings_patch_invalid", path: "type" };
  }
  const extraKey = Object.keys(message).find(
    (key) => key !== "type" && key !== "patch",
  );
  if (extraKey) {
    return { ok: false, code: "settings_patch_invalid", path: extraKey };
  }
  const parsed = parseSettingsPatch(message.patch);
  if (!parsed.ok) {
    return { ok: false, code: "settings_patch_invalid", path: parsed.path };
  }
  try {
    const updated = await deps.mutateSettings((current) =>
      applySettingsPatch(current, parsed.patch),
    );
    return {
      ok: true,
      code: "settings_patch_applied",
      settings: toContentSettings(updated),
    };
  } catch {
    return { ok: false, code: "settings_patch_save_failed" };
  }
}

export function isSettingsPatchResponse(
  value: unknown,
): value is SettingsPatchResponse {
  if (!isRecord(value)) return false;
  if (value.ok === true) {
    return value.code === "settings_patch_applied" && isRecord(value.settings);
  }
  if (value.ok !== false) return false;
  if (value.code === "settings_patch_invalid") {
    return typeof value.path === "string" && value.path.length <= 128;
  }
  return (
    value.code === "settings_patch_sender_rejected" ||
    value.code === "settings_patch_save_failed"
  );
}
