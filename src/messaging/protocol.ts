import {
  isAllowedProviderBaseUrl,
  isFastProviderId,
  type AppSettings,
  type ContentSettings,
} from "@/src/shared/settings";
import { normalizeAutoTranslateSitePattern } from "@/src/shared/auto-translate-sites";
import type {
  TranslationFailure,
  TranslationRequest,
  TranslationResult,
} from "@/src/translation/types";
import { isUserSiteProfile } from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import { isPersistedFullTrack } from "@/src/subtitles/persisted-track";
import type { SubtitleTrack } from "@/src/subtitles/types";
import type { OcrCaptureResponse, OcrStatus } from "@/src/ocr/types";
import {
  OCR_RUNTIME_LANGUAGES,
  type OcrRuntimeLanguage,
} from "@/src/ocr/languages";
import {
  BERGAMOT_LANGUAGE_PACK_IDS,
  type BergamotLanguagePackId,
} from "@/src/local-translation/languages";

export type PageCommand =
  | { type: "PAGE_TRANSLATE" }
  | { type: "PAGE_AUTO_TRANSLATE_CURRENT" }
  | { type: "PAGE_RESTORE" }
  | { type: "PAGE_STATUS" };

/** Commands delivered from extension pages or the background to a content frame. */
export type ContentCommand =
  | PageCommand
  | { type: "CONTENT_RUNTIME_INFO" }
  | { type: "TRANSLATION_CAPABILITIES_GET" }
  | TranslationProgressMessage
  | {
      type: "FRAME_STATUS_UPDATED";
      frameId: number;
      frameInstanceId: string;
      pageStatus: PageStatus;
      subtitleStatus: SubtitleStatus;
    }
  | {
      type: "FRAME_STATUS_CLEARED";
      frameId: number;
      frameInstanceId: string;
    }
  | { type: "FLOATING_SESSION_SHOW" }
  | { type: "SUBTITLE_STATUS" }
  | { type: "SUBTITLE_RETRY_FAILED" }
  | { type: "SUBTITLE_START" }
  | { type: "SUBTITLE_CANCEL" }
  | { type: "OCR_STATUS" }
  | { type: "OCR_START" }
  | { type: "OCR_STOP" }
  | { type: "CACHE_CLEARED" }
  | { type: "SETTINGS_UPDATED"; settings: ContentSettings };

/**
 * Validated requests handled by the background service worker. Sender-specific
 * authorization is enforced after structural validation in the background.
 */
export type BackgroundCommand =
  | { type: "ENSURE_PAGE_CONTENT"; tabId: number }
  | {
      type: "CONTENT_COMMAND_BROADCAST";
      command:
        | "PAGE_TRANSLATE"
        | "PAGE_AUTO_TRANSLATE_CURRENT"
        | "PAGE_RESTORE"
        | "SUBTITLE_START"
        | "SUBTITLE_RETRY_FAILED"
        | "SUBTITLE_CANCEL";
    }
  | {
      type: "FRAME_STATUS_UPDATE";
      frameInstanceId: string;
      pageStatus: PageStatus;
      subtitleStatus: SubtitleStatus;
    }
  | { type: "FRAME_STATUS_CLEAR"; frameInstanceId: string }
  | { type: "PAGE_MANUAL_TRANSLATION_SET"; enabled: boolean }
  | { type: "TRANSLATE"; requestId: string; request: TranslationRequest }
  | { type: "TRANSLATE_CANCEL"; requestId: string }
  | { type: "CACHE_EPOCH_GET" }
  | { type: "TRANSLATION_CACHE_GET"; key: string }
  | {
      type: "TRANSLATION_CACHE_SET";
      key: string;
      translatedText: string;
      epoch: number;
    }
  | { type: "SUBTITLE_TRACK_GET"; key: string }
  | { type: "SUBTITLE_TRACK_DELETE"; key: string; epoch: number }
  | {
      type: "SUBTITLE_TRACK_SET";
      key: string;
      track: SubtitleTrack;
      epoch: number;
    }
  | { type: "PAGE_AUTO_TRANSLATE_SET"; enabled: boolean }
  | { type: "PAGE_AUTO_TRANSLATE_SITE_SET"; enabled: boolean }
  | {
      type: "PAGE_QUICK_SETTINGS_SET";
      sourceLanguage: string;
      targetLanguage: string;
      mode: "fast" | "ai";
      fastProvider?: AppSettings["provider"]["fastProvider"];
      responseMode?: "stream" | "batch";
      displayMode: "translated" | "bilingual";
      selectionTranslationEnabled?: boolean;
      selectionTranslationMode?: "fast" | "ai";
    }
  | {
      type: "FLOATING_BUTTON_SET";
      surface: "page" | "video" | "all";
      enabled: boolean;
    }
  | { type: "FLOATING_POSITION_GET" }
  | { type: "FLOATING_POSITION_SET"; x: number; y: number }
  | { type: "FLOATING_SESSION_RESTORE" }
  | {
      type: "SUBTITLE_QUICK_SETTINGS_SET";
      sourceLanguage: string;
      targetLanguage: string;
      mode: "fast" | "ai";
      fastProvider?: AppSettings["provider"]["fastProvider"];
      responseMode?: "stream" | "batch";
      displayMode: "original" | "translated" | "bilingual";
      hideNativeSubtitles: boolean;
      fontScale?: number;
      backgroundOpacity?: number;
    }
  | { type: "SUBTITLE_POSITION_SET"; x: number; y: number }
  | {
      type: "OCR_SETTINGS_SET";
      enabled: boolean;
      sourceLanguage: string;
      targetLanguage: string;
      provider: "chrome-local" | "bergamot-local";
    }
  | { type: "IMAGE_SOURCE_GET"; url: string }
  | {
      type: "IMAGE_TRANSLATION_SETTINGS_SET";
      enabled: boolean;
      sourceLanguage: string;
      targetLanguage: string;
      mode: "fast" | "ai";
      fastProvider?: AppSettings["provider"]["fastProvider"];
      modelOverride: string;
      displayMode: "translated" | "bilingual";
    }
  | { type: "OCR_PERMISSION_REQUEST" }
  | { type: "OCR_PERMISSION_COMPLETE" }
  | { type: "OCR_RUNTIME_LIST" }
  | { type: "OCR_RUNTIME_DOWNLOAD"; language: OcrRuntimeLanguage }
  | { type: "OCR_RUNTIME_DOWNLOAD_ALL" }
  | { type: "OCR_RUNTIME_DELETE"; language: OcrRuntimeLanguage }
  | { type: "LOCAL_TRANSLATION_RUNTIME_LIST" }
  | {
      type: "LOCAL_TRANSLATION_RUNTIME_DOWNLOAD";
      packId: BergamotLanguagePackId;
    }
  | {
      type: "LOCAL_TRANSLATION_RUNTIME_DELETE";
      packId: BergamotLanguagePackId;
    }
  | { type: "SITE_PROFILES_GET" }
  | { type: "SITE_PROFILE_SAVE"; profile: SubtitleSiteProfile }
  | { type: "SITE_PROFILE_DELETE"; id: string }
  | { type: "SITE_PROFILE_EDITOR_SAVE"; profile: unknown }
  | { type: "SITE_PROFILE_EDITOR_DELETE"; id: string }
  | { type: "SITE_PROFILE_OVERRIDE_RESTORE"; id: string }
  | { type: "SITE_TRANSLATION_PROFILE_SAVE"; profile: unknown }
  | { type: "SITE_TRANSLATION_PROFILE_DELETE"; id: string }
  | { type: "SETTINGS_GET" }
  | { type: "CONTENT_SETTINGS_GET" }
  | { type: "UPDATE_STATUS_GET" }
  | { type: "UPDATE_CHECK" }
  | { type: "UPDATE_AUTO_CHECK_SET"; enabled: boolean }
  | { type: "UPDATE_IGNORE"; version: string }
  | { type: "SETTINGS_SET"; settings: AppSettings }
  | { type: "TEST_CONNECTION" }
  | { type: "CREDENTIALS_CLEAR" }
  | { type: "CACHE_CLEAR" }
  | { type: "CACHE_STATS" };

/** Final response for one background-managed translation request. */
export interface TranslationResponse {
  ok: boolean;
  results?: TranslationResult[];
  error?: TranslationFailure;
}

/** Progressive result routed only to the frame that owns `requestId`. */
export interface TranslationProgressMessage {
  type: "TRANSLATION_PROGRESS";
  requestId: string;
  result: TranslationResult;
}

/** Aggregated page-translation state; counts refer to stable segment IDs. */
export interface PageStatus {
  state:
    "idle" | "scanning" | "translating" | "translated" | "partial" | "error";
  total: number;
  completed: number;
  failed: number;
  message?: string;
  details?: string;
}

/**
 * Subtitle task state. `full` permits ahead-of-playback translation, while
 * `stream` represents only cues observed so far and must use the fast path.
 */
export interface SubtitleStatus {
  state:
    | "unavailable"
    | "waiting"
    | "translating"
    | "ready"
    | "partial"
    | "cancelled"
    | "error";
  source?: string;
  completeness?: "full" | "stream";
  total: number;
  completed: number;
  failed: number;
  message?: string;
  details?: string;
}

export type { OcrCaptureResponse, OcrStatus };

export type OcrRuntimeState = "missing" | "downloading" | "installed" | "error";

export interface OcrRuntimeInfo {
  language: OcrRuntimeLanguage;
  labelKey: string;
  state: OcrRuntimeState;
  progress?: number;
  bytes?: number;
  message?: string;
}

export type LocalTranslationRuntimeState =
  "missing" | "downloading" | "installed" | "error";

export interface LocalTranslationRuntimeInfo {
  packId: BergamotLanguagePackId;
  sourceLanguage: string;
  targetLanguage: string;
  state: LocalTranslationRuntimeState;
  version?: string;
  bytes?: number;
  downloadBytes?: number;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBoundedProfileEditorValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  try {
    return JSON.stringify(value).length <= 50_000;
  } catch {
    return false;
  }
}

function isCacheEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOcrRuntimeLanguage(value: unknown): value is OcrRuntimeLanguage {
  return (
    typeof value === "string" &&
    (OCR_RUNTIME_LANGUAGES as readonly string[]).includes(value)
  );
}

function isBergamotLanguagePackId(
  value: unknown,
): value is BergamotLanguagePackId {
  return (
    typeof value === "string" &&
    (BERGAMOT_LANGUAGE_PACK_IDS as readonly string[]).includes(value)
  );
}

function isFrameInstanceId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isTranslationResult(value: unknown): value is TranslationResult {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 500 &&
    typeof value.translatedText === "string" &&
    value.translatedText.trim().length > 0 &&
    value.translatedText.length <= 100_000
  );
}

export function isTranslationProgressMessage(
  value: unknown,
): value is TranslationProgressMessage {
  return (
    isRecord(value) &&
    value.type === "TRANSLATION_PROGRESS" &&
    typeof value.requestId === "string" &&
    value.requestId.length > 0 &&
    value.requestId.length <= 500 &&
    isTranslationResult(value.result)
  );
}

export function isPageStatusValue(value: unknown): value is PageStatus {
  return (
    isRecord(value) &&
    [
      "idle",
      "scanning",
      "translating",
      "translated",
      "partial",
      "error",
    ].includes(String(value.state)) &&
    typeof value.total === "number" &&
    Number.isInteger(value.total) &&
    value.total >= 0 &&
    typeof value.completed === "number" &&
    Number.isInteger(value.completed) &&
    value.completed >= 0 &&
    typeof value.failed === "number" &&
    Number.isInteger(value.failed) &&
    value.failed >= 0 &&
    (value.message === undefined ||
      (typeof value.message === "string" && value.message.length <= 1_000)) &&
    (value.details === undefined ||
      (typeof value.details === "string" && value.details.length <= 4_000))
  );
}

export function isSubtitleStatusValue(value: unknown): value is SubtitleStatus {
  return (
    isRecord(value) &&
    [
      "unavailable",
      "waiting",
      "translating",
      "ready",
      "partial",
      "cancelled",
      "error",
    ].includes(String(value.state)) &&
    typeof value.total === "number" &&
    Number.isInteger(value.total) &&
    value.total >= 0 &&
    typeof value.completed === "number" &&
    Number.isInteger(value.completed) &&
    value.completed >= 0 &&
    typeof value.failed === "number" &&
    Number.isInteger(value.failed) &&
    value.failed >= 0 &&
    (value.source === undefined ||
      (typeof value.source === "string" && value.source.length <= 64)) &&
    (value.completeness === undefined ||
      value.completeness === "full" ||
      value.completeness === "stream") &&
    (value.message === undefined ||
      (typeof value.message === "string" && value.message.length <= 1_000)) &&
    (value.details === undefined ||
      (typeof value.details === "string" && value.details.length <= 4_000))
  );
}

function isAppSettings(value: unknown): value is AppSettings {
  if (!isRecord(value)) return false;
  const provider = value.provider;
  const page = value.page;
  const subtitles = value.subtitles;
  const ocr = value.ocr;
  const imageTranslation = value.imageTranslation;
  if (
    !isRecord(provider) ||
    !isRecord(page) ||
    !isRecord(subtitles) ||
    !isRecord(ocr) ||
    !isRecord(imageTranslation)
  )
    return false;
  return (
    (value.uiLanguage === "auto" ||
      value.uiLanguage === "en" ||
      value.uiLanguage === "zh-CN") &&
    (provider.fastProvider === "chrome-local" ||
      provider.fastProvider === "bergamot-local" ||
      provider.fastProvider === "google-translate" ||
      provider.fastProvider === "microsoft-translator" ||
      provider.fastProvider === "deepl") &&
    (provider.aiProvider === "openai-compatible" ||
      provider.aiProvider === "anthropic-messages") &&
    typeof provider.baseUrl === "string" &&
    isAllowedProviderBaseUrl(provider.baseUrl) &&
    typeof provider.apiKey === "string" &&
    provider.apiKey.length <= 10_000 &&
    typeof provider.googleApiKey === "string" &&
    provider.googleApiKey.length <= 10_000 &&
    typeof provider.microsoftApiKey === "string" &&
    provider.microsoftApiKey.length <= 10_000 &&
    typeof provider.microsoftRegion === "string" &&
    provider.microsoftRegion.length <= 128 &&
    typeof provider.deeplApiKey === "string" &&
    provider.deeplApiKey.length <= 10_000 &&
    (provider.deeplPlan === "free" || provider.deeplPlan === "pro") &&
    typeof provider.model === "string" &&
    provider.model.trim().length > 0 &&
    provider.model.length <= 256 &&
    typeof provider.systemPrompt === "string" &&
    provider.systemPrompt.length <= 20_000 &&
    typeof provider.timeoutMs === "number" &&
    Number.isFinite(provider.timeoutMs) &&
    provider.timeoutMs >= 5_000 &&
    provider.timeoutMs <= 180_000 &&
    typeof page.sourceLanguage === "string" &&
    page.sourceLanguage.length > 0 &&
    page.sourceLanguage.length <= 64 &&
    typeof page.targetLanguage === "string" &&
    page.targetLanguage.length > 0 &&
    page.targetLanguage.length <= 64 &&
    (page.mode === "fast" || page.mode === "ai") &&
    (page.aiResponseMode === "stream" || page.aiResponseMode === "batch") &&
    (page.displayMode === "translated" || page.displayMode === "bilingual") &&
    typeof page.autoTranslate === "boolean" &&
    isAutoTranslateSitePatterns(page.autoTranslateSitePatterns) &&
    isAutoTranslateSitePatterns(page.autoTranslateExcludedSitePatterns) &&
    typeof page.floatingButtonEnabled === "boolean" &&
    typeof page.selectionTranslationEnabled === "boolean" &&
    typeof page.selectionTranslationSourceLanguage === "string" &&
    page.selectionTranslationSourceLanguage.length > 0 &&
    page.selectionTranslationSourceLanguage.length <= 64 &&
    typeof page.selectionTranslationTargetLanguage === "string" &&
    page.selectionTranslationTargetLanguage.length > 0 &&
    page.selectionTranslationTargetLanguage.length <= 64 &&
    (page.selectionTranslationMode === "fast" ||
      page.selectionTranslationMode === "ai") &&
    (page.selectionTranslationAiResponseMode === "stream" ||
      page.selectionTranslationAiResponseMode === "batch") &&
    typeof page.selectionTranslationModelOverride === "string" &&
    page.selectionTranslationModelOverride.length <= 256 &&
    (page.selectionTranslationDisplayMode === "translated" ||
      page.selectionTranslationDisplayMode === "bilingual") &&
    typeof subtitles.enabled === "boolean" &&
    typeof subtitles.floatingButtonEnabled === "boolean" &&
    typeof subtitles.sourceLanguage === "string" &&
    subtitles.sourceLanguage.length > 0 &&
    subtitles.sourceLanguage.length <= 64 &&
    typeof subtitles.targetLanguage === "string" &&
    subtitles.targetLanguage.length > 0 &&
    subtitles.targetLanguage.length <= 64 &&
    (subtitles.mode === "fast" || subtitles.mode === "ai") &&
    (subtitles.aiResponseMode === "stream" ||
      subtitles.aiResponseMode === "batch") &&
    (subtitles.displayMode === "original" ||
      subtitles.displayMode === "translated" ||
      subtitles.displayMode === "bilingual") &&
    typeof subtitles.hideNativeSubtitles === "boolean" &&
    (subtitles.position === "top" ||
      subtitles.position === "center" ||
      subtitles.position === "bottom" ||
      subtitles.position === "custom") &&
    isRecord(subtitles.customPosition) &&
    typeof subtitles.customPosition.x === "number" &&
    Number.isFinite(subtitles.customPosition.x) &&
    subtitles.customPosition.x >= 0 &&
    subtitles.customPosition.x <= 1 &&
    typeof subtitles.customPosition.y === "number" &&
    Number.isFinite(subtitles.customPosition.y) &&
    subtitles.customPosition.y >= 0 &&
    subtitles.customPosition.y <= 1 &&
    typeof subtitles.fontScale === "number" &&
    Number.isFinite(subtitles.fontScale) &&
    subtitles.fontScale >= 0.75 &&
    subtitles.fontScale <= 1.8 &&
    typeof subtitles.backgroundOpacity === "number" &&
    Number.isFinite(subtitles.backgroundOpacity) &&
    subtitles.backgroundOpacity >= 0.3 &&
    subtitles.backgroundOpacity <= 0.95 &&
    typeof ocr.enabled === "boolean" &&
    typeof ocr.sourceLanguage === "string" &&
    ocr.sourceLanguage.length > 0 &&
    ocr.sourceLanguage.length <= 64 &&
    typeof ocr.targetLanguage === "string" &&
    ocr.targetLanguage.length > 0 &&
    ocr.targetLanguage.length <= 64 &&
    (ocr.provider === "chrome-local" || ocr.provider === "bergamot-local") &&
    typeof imageTranslation.enabled === "boolean" &&
    typeof imageTranslation.sourceLanguage === "string" &&
    imageTranslation.sourceLanguage.length > 0 &&
    imageTranslation.sourceLanguage.length <= 64 &&
    typeof imageTranslation.targetLanguage === "string" &&
    imageTranslation.targetLanguage.length > 0 &&
    imageTranslation.targetLanguage.length <= 64 &&
    (imageTranslation.mode === "fast" || imageTranslation.mode === "ai") &&
    typeof imageTranslation.modelOverride === "string" &&
    imageTranslation.modelOverride.length <= 256 &&
    (imageTranslation.displayMode === "translated" ||
      imageTranslation.displayMode === "bilingual")
  );
}

function isAutoTranslateSitePatterns(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 500) return false;
  const patterns = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") return false;
    const normalized = normalizeAutoTranslateSitePattern(candidate);
    if (!normalized || normalized !== candidate || patterns.has(candidate)) {
      return false;
    }
    patterns.add(candidate);
  }
  return true;
}

export function isContentSettings(value: unknown): value is ContentSettings {
  if (!isRecord(value) || !isRecord(value.provider)) return false;
  if (
    "apiKey" in value.provider ||
    "googleApiKey" in value.provider ||
    "microsoftApiKey" in value.provider ||
    "deeplApiKey" in value.provider
  )
    return false;
  return isAppSettings({
    ...value,
    provider: {
      ...value.provider,
      apiKey: "",
      googleApiKey: "",
      microsoftApiKey: "",
      deeplApiKey: "",
    },
  });
}

function isContext(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 4 &&
    value.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 5_000,
    )
  );
}

function isTranslationRequest(value: unknown): value is TranslationRequest {
  if (!isRecord(value) || !Array.isArray(value.segments)) return false;
  if (
    typeof value.sourceLanguage !== "string" ||
    value.sourceLanguage.length === 0 ||
    value.sourceLanguage.length > 64 ||
    typeof value.targetLanguage !== "string" ||
    value.targetLanguage.length === 0 ||
    value.targetLanguage.length > 64 ||
    (value.mode !== "fast" && value.mode !== "ai") ||
    (value.responseMode !== undefined &&
      value.responseMode !== "stream" &&
      value.responseMode !== "batch") ||
    value.segments.length > 100 ||
    (value.mediaTitle !== undefined &&
      (typeof value.mediaTitle !== "string" ||
        value.mediaTitle.length === 0 ||
        value.mediaTitle.length > 300)) ||
    (value.prompt !== undefined &&
      (typeof value.prompt !== "string" || value.prompt.length > 20_000)) ||
    (value.scope !== undefined &&
      (typeof value.scope !== "string" || value.scope.length > 4_096)) ||
    (value.modelOverride !== undefined &&
      (typeof value.modelOverride !== "string" ||
        value.modelOverride.length > 256)) ||
    (value.providerOverride !== undefined &&
      !isFastProviderId(value.providerOverride))
  ) {
    return false;
  }
  const ids = new Set<string>();
  let characters = 0;
  for (const segment of value.segments) {
    if (
      !isRecord(segment) ||
      typeof segment.id !== "string" ||
      segment.id.length === 0 ||
      segment.id.length > 500 ||
      ids.has(segment.id) ||
      typeof segment.text !== "string" ||
      segment.text.trim().length === 0 ||
      segment.text.length > 20_000 ||
      (segment.format !== undefined &&
        segment.format !== "plain-text-v1" &&
        segment.format !== "protected-text-v1") ||
      (segment.contextBefore !== undefined &&
        !isContext(segment.contextBefore)) ||
      (segment.contextAfter !== undefined && !isContext(segment.contextAfter))
    ) {
      return false;
    }
    ids.add(segment.id);
    characters +=
      segment.text.length +
      (segment.contextBefore ?? []).reduce(
        (total, context) => total + context.length,
        0,
      ) +
      (segment.contextAfter ?? []).reduce(
        (total, context) => total + context.length,
        0,
      );
    if (characters > 200_000) return false;
  }
  return true;
}

export function isBackgroundCommand(
  value: unknown,
): value is BackgroundCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "ENSURE_PAGE_CONTENT":
      return (
        typeof value.tabId === "number" &&
        Number.isInteger(value.tabId) &&
        value.tabId >= 0
      );
    case "CONTENT_COMMAND_BROADCAST":
      return (
        value.command === "PAGE_TRANSLATE" ||
        value.command === "PAGE_AUTO_TRANSLATE_CURRENT" ||
        value.command === "PAGE_RESTORE" ||
        value.command === "SUBTITLE_START" ||
        value.command === "SUBTITLE_RETRY_FAILED" ||
        value.command === "SUBTITLE_CANCEL"
      );
    case "FRAME_STATUS_UPDATE":
      return (
        isFrameInstanceId(value.frameInstanceId) &&
        isPageStatusValue(value.pageStatus) &&
        isSubtitleStatusValue(value.subtitleStatus)
      );
    case "FRAME_STATUS_CLEAR":
      return (
        isFrameInstanceId(value.frameInstanceId) &&
        Object.keys(value).length === 2
      );
    case "PAGE_MANUAL_TRANSLATION_SET":
      return (
        typeof value.enabled === "boolean" && Object.keys(value).length === 2
      );
    case "TRANSLATE":
      return (
        typeof value.requestId === "string" &&
        value.requestId.length > 0 &&
        value.requestId.length <= 500 &&
        isTranslationRequest(value.request)
      );
    case "TRANSLATE_CANCEL":
      return (
        typeof value.requestId === "string" &&
        value.requestId.length > 0 &&
        value.requestId.length <= 500
      );
    case "TRANSLATION_CACHE_GET":
    case "SUBTITLE_TRACK_GET":
      return typeof value.key === "string" && /^[a-f0-9]{64}$/u.test(value.key);
    case "SUBTITLE_TRACK_DELETE":
      return (
        typeof value.key === "string" &&
        /^[a-f0-9]{64}$/u.test(value.key) &&
        isCacheEpoch(value.epoch)
      );
    case "TRANSLATION_CACHE_SET":
      return (
        typeof value.key === "string" &&
        /^[a-f0-9]{64}$/u.test(value.key) &&
        typeof value.translatedText === "string" &&
        value.translatedText.trim().length > 0 &&
        value.translatedText.length <= 100_000 &&
        isCacheEpoch(value.epoch)
      );
    case "SUBTITLE_TRACK_SET":
      return (
        typeof value.key === "string" &&
        /^[a-f0-9]{64}$/u.test(value.key) &&
        isPersistedFullTrack(value.track) &&
        isCacheEpoch(value.epoch)
      );
    case "PAGE_AUTO_TRANSLATE_SET":
    case "PAGE_AUTO_TRANSLATE_SITE_SET":
      return typeof value.enabled === "boolean";
    case "PAGE_QUICK_SETTINGS_SET":
      return (
        typeof value.sourceLanguage === "string" &&
        value.sourceLanguage.length > 0 &&
        value.sourceLanguage.length <= 64 &&
        typeof value.targetLanguage === "string" &&
        value.targetLanguage.length > 0 &&
        value.targetLanguage.length <= 64 &&
        (value.mode === "fast" || value.mode === "ai") &&
        (value.fastProvider === undefined ||
          isFastProviderId(value.fastProvider)) &&
        (value.responseMode === undefined ||
          value.responseMode === "stream" ||
          value.responseMode === "batch") &&
        (value.displayMode === "translated" ||
          value.displayMode === "bilingual") &&
        (value.selectionTranslationEnabled === undefined ||
          typeof value.selectionTranslationEnabled === "boolean") &&
        (value.selectionTranslationMode === undefined ||
          value.selectionTranslationMode === "fast" ||
          value.selectionTranslationMode === "ai")
      );
    case "FLOATING_BUTTON_SET":
      return (
        (value.surface === "page" ||
          value.surface === "video" ||
          value.surface === "all") &&
        typeof value.enabled === "boolean"
      );
    case "FLOATING_POSITION_GET":
      return Object.keys(value).length === 1;
    case "FLOATING_POSITION_SET":
      return (
        typeof value.x === "number" &&
        Number.isFinite(value.x) &&
        value.x >= 0 &&
        value.x <= 1 &&
        typeof value.y === "number" &&
        Number.isFinite(value.y) &&
        value.y >= 0 &&
        value.y <= 1
      );
    case "FLOATING_SESSION_RESTORE":
      return Object.keys(value).length === 1;
    case "SUBTITLE_QUICK_SETTINGS_SET":
      return (
        typeof value.sourceLanguage === "string" &&
        value.sourceLanguage.length > 0 &&
        value.sourceLanguage.length <= 64 &&
        typeof value.targetLanguage === "string" &&
        value.targetLanguage.length > 0 &&
        value.targetLanguage.length <= 64 &&
        (value.mode === "fast" || value.mode === "ai") &&
        (value.fastProvider === undefined ||
          isFastProviderId(value.fastProvider)) &&
        (value.responseMode === undefined ||
          value.responseMode === "stream" ||
          value.responseMode === "batch") &&
        (value.displayMode === "original" ||
          value.displayMode === "translated" ||
          value.displayMode === "bilingual") &&
        typeof value.hideNativeSubtitles === "boolean" &&
        (value.fontScale === undefined ||
          (typeof value.fontScale === "number" &&
            Number.isFinite(value.fontScale) &&
            value.fontScale >= 0.75 &&
            value.fontScale <= 1.8)) &&
        (value.backgroundOpacity === undefined ||
          (typeof value.backgroundOpacity === "number" &&
            Number.isFinite(value.backgroundOpacity) &&
            value.backgroundOpacity >= 0.3 &&
            value.backgroundOpacity <= 0.95))
      );
    case "SUBTITLE_POSITION_SET":
      return (
        typeof value.x === "number" &&
        Number.isFinite(value.x) &&
        value.x >= 0 &&
        value.x <= 1 &&
        typeof value.y === "number" &&
        Number.isFinite(value.y) &&
        value.y >= 0 &&
        value.y <= 1
      );
    case "OCR_SETTINGS_SET":
      return (
        typeof value.enabled === "boolean" &&
        typeof value.sourceLanguage === "string" &&
        value.sourceLanguage.length > 0 &&
        value.sourceLanguage.length <= 64 &&
        typeof value.targetLanguage === "string" &&
        value.targetLanguage.length > 0 &&
        value.targetLanguage.length <= 64 &&
        (value.provider === "chrome-local" ||
          value.provider === "bergamot-local")
      );
    case "IMAGE_SOURCE_GET":
      return (
        typeof value.url === "string" &&
        value.url.length > 0 &&
        value.url.length <= 8_192 &&
        (value.url.startsWith("https://") || value.url.startsWith("http://"))
      );
    case "IMAGE_TRANSLATION_SETTINGS_SET":
      return (
        typeof value.enabled === "boolean" &&
        typeof value.sourceLanguage === "string" &&
        value.sourceLanguage.length > 0 &&
        value.sourceLanguage.length <= 64 &&
        typeof value.targetLanguage === "string" &&
        value.targetLanguage.length > 0 &&
        value.targetLanguage.length <= 64 &&
        (value.mode === "fast" || value.mode === "ai") &&
        (value.fastProvider === undefined ||
          isFastProviderId(value.fastProvider)) &&
        typeof value.modelOverride === "string" &&
        value.modelOverride.length <= 256 &&
        (value.displayMode === "translated" ||
          value.displayMode === "bilingual")
      );
    case "OCR_PERMISSION_REQUEST":
    case "OCR_PERMISSION_COMPLETE":
      return true;
    case "OCR_RUNTIME_DOWNLOAD":
    case "OCR_RUNTIME_DELETE":
      return isOcrRuntimeLanguage(value.language);
    case "LOCAL_TRANSLATION_RUNTIME_DOWNLOAD":
    case "LOCAL_TRANSLATION_RUNTIME_DELETE":
      return isBergamotLanguagePackId(value.packId);
    case "SITE_PROFILE_SAVE":
      return isUserSiteProfile(value.profile);
    case "SITE_PROFILE_DELETE":
    case "SITE_PROFILE_EDITOR_DELETE":
      return (
        typeof value.id === "string" && /^user-[a-z0-9-]{1,59}$/u.test(value.id)
      );
    case "SITE_PROFILE_EDITOR_SAVE":
    case "SITE_TRANSLATION_PROFILE_SAVE":
      return isBoundedProfileEditorValue(value.profile);
    case "SITE_PROFILE_OVERRIDE_RESTORE":
    case "SITE_TRANSLATION_PROFILE_DELETE":
      return (
        typeof value.id === "string" &&
        /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.id)
      );
    case "SETTINGS_SET":
      return isAppSettings(value.settings);
    case "UPDATE_AUTO_CHECK_SET":
      return typeof value.enabled === "boolean";
    case "UPDATE_IGNORE":
      return (
        typeof value.version === "string" &&
        /^v?\d{1,5}(?:\.\d{1,5}){1,3}$/u.test(value.version)
      );
    case "SETTINGS_GET":
    case "CONTENT_SETTINGS_GET":
    case "UPDATE_STATUS_GET":
    case "UPDATE_CHECK":
    case "CACHE_EPOCH_GET":
    case "SITE_PROFILES_GET":
    case "TEST_CONNECTION":
    case "CACHE_CLEAR":
    case "CACHE_STATS":
    case "OCR_RUNTIME_LIST":
    case "OCR_RUNTIME_DOWNLOAD_ALL":
    case "LOCAL_TRANSLATION_RUNTIME_LIST":
      return true;
    case "CREDENTIALS_CLEAR":
      return Object.keys(value).length === 1;
    default:
      return false;
  }
}

export function isContentCommand(value: unknown): value is ContentCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "TRANSLATION_PROGRESS":
      return isTranslationProgressMessage(value);
    case "SETTINGS_UPDATED":
      return isContentSettings(value.settings);
    case "PAGE_TRANSLATE":
    case "PAGE_AUTO_TRANSLATE_CURRENT":
    case "PAGE_RESTORE":
    case "PAGE_STATUS":
    case "CACHE_CLEARED":
      return true;
    case "FRAME_STATUS_UPDATED":
      return (
        typeof value.frameId === "number" &&
        Number.isInteger(value.frameId) &&
        value.frameId > 0 &&
        isFrameInstanceId(value.frameInstanceId) &&
        isPageStatusValue(value.pageStatus) &&
        isSubtitleStatusValue(value.subtitleStatus)
      );
    case "FRAME_STATUS_CLEARED":
      return (
        typeof value.frameId === "number" &&
        Number.isInteger(value.frameId) &&
        value.frameId > 0 &&
        isFrameInstanceId(value.frameInstanceId) &&
        Object.keys(value).length === 3
      );
    case "FLOATING_SESSION_SHOW":
      return Object.keys(value).length === 1;
    case "CONTENT_RUNTIME_INFO":
    case "TRANSLATION_CAPABILITIES_GET":
      return Object.keys(value).length === 1;
    case "SUBTITLE_STATUS":
    case "SUBTITLE_RETRY_FAILED":
    case "SUBTITLE_START":
    case "SUBTITLE_CANCEL":
    case "OCR_STATUS":
    case "OCR_START":
    case "OCR_STOP":
      return true;
    default:
      return false;
  }
}
