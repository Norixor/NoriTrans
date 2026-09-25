import type {
  TranslationMode,
  TranslationResponseMode,
} from "@/src/translation/types";
import { normalizeAutoTranslateSitePatterns } from "@/src/shared/auto-translate-sites";

export type DisplayMode = "translated" | "bilingual";
export type SubtitleDisplayMode = "translated" | "bilingual" | "original";
export type SubtitlePosition = "top" | "center" | "bottom" | "custom";
export type UiLanguage = "auto" | "en" | "zh-CN";
export const AI_PROVIDER_IDS = [
  "openai-compatible",
  "anthropic-messages",
] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return (AI_PROVIDER_IDS as readonly unknown[]).includes(value);
}

export const FAST_PROVIDER_IDS = [
  "chrome-local",
  "bergamot-local",
  "google-translate",
  "microsoft-translator",
  "deepl",
] as const;
export type FastProviderId = (typeof FAST_PROVIDER_IDS)[number];

export function isFastProviderId(value: unknown): value is FastProviderId {
  return (FAST_PROVIDER_IDS as readonly unknown[]).includes(value);
}
export type DeepLPlan = "free" | "pro";

export function normalizeUiLanguage(value: unknown): UiLanguage {
  return value === "en" || value === "zh-CN" ? value : "auto";
}

export interface SubtitleCustomPosition {
  x: number;
  y: number;
}

export interface ProviderSettings {
  fastProvider: FastProviderId;
  aiProvider: AiProviderId;
  baseUrl: string;
  apiKey: string;
  googleApiKey: string;
  microsoftApiKey: string;
  microsoftRegion: string;
  deeplApiKey: string;
  deeplPlan: DeepLPlan;
  model: string;
  systemPrompt: string;
  timeoutMs: number;
}

export interface PageSettings {
  sourceLanguage: string;
  targetLanguage: string;
  mode: TranslationMode;
  aiResponseMode: TranslationResponseMode;
  displayMode: DisplayMode;
  /** Runtime-only per-site fast Provider; omitted inherits provider.fastProvider. */
  fastProviderOverride?: FastProviderId;
  /** Runtime-only per-site AI model; blank or omitted inherits provider.model. */
  modelOverride?: string;
  autoTranslate: boolean;
  autoTranslateSitePatterns: string[];
  autoTranslateExcludedSitePatterns: string[];
  floatingButtonEnabled: boolean;
  selectionTranslationEnabled: boolean;
  selectionTranslationSourceLanguage: string;
  selectionTranslationTargetLanguage: string;
  selectionTranslationMode: TranslationMode;
  selectionTranslationAiResponseMode: TranslationResponseMode;
  /** Empty inherits provider.model. */
  selectionTranslationModelOverride: string;
  selectionTranslationDisplayMode: DisplayMode;
  /** Runtime-only per-site selection fast Provider. */
  selectionTranslationFastProviderOverride?: FastProviderId;
}

export interface SubtitleSettings {
  enabled: boolean;
  floatingButtonEnabled: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  mode: TranslationMode;
  aiResponseMode: TranslationResponseMode;
  displayMode: SubtitleDisplayMode;
  hideNativeSubtitles: boolean;
  position: SubtitlePosition;
  customPosition: SubtitleCustomPosition;
  fontScale: number;
  backgroundOpacity: number;
  /** Runtime-only per-site fast Provider; omitted inherits provider.fastProvider. */
  fastProviderOverride?: FastProviderId;
  /** Runtime-only per-site AI model; blank or omitted inherits provider.model. */
  modelOverride?: string;
}

export interface OcrSettings {
  enabled: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  provider: "chrome-local" | "bergamot-local";
}

export interface ImageTranslationSettings {
  enabled: boolean;
  sourceLanguage: string;
  targetLanguage: string;
  mode: TranslationMode;
  /** Empty inherits provider.model. */
  modelOverride: string;
  displayMode: DisplayMode;
}

export interface AppSettings {
  uiLanguage: UiLanguage;
  provider: ProviderSettings;
  page: PageSettings;
  subtitles: SubtitleSettings;
  ocr: OcrSettings;
  imageTranslation: ImageTranslationSettings;
}

export type ContentProviderSettings = Omit<
  ProviderSettings,
  "apiKey" | "googleApiKey" | "microsoftApiKey" | "deeplApiKey"
>;

export interface ContentSettings {
  uiLanguage: UiLanguage;
  provider: ContentProviderSettings;
  page: PageSettings;
  subtitles: SubtitleSettings;
  ocr: OcrSettings;
  imageTranslation: ImageTranslationSettings;
  activeSiteProfile?: { id: string; name: string };
}

export const LEGACY_DEFAULT_SYSTEM_PROMPT = [
  "You are a professional translator.",
  "Preserve meaning, tone, names, terminology, punctuation, and formatting.",
  "Use contextBefore and contextAfter only for consistency; translate only the segment text.",
  "Do not add explanations.",
  "Return exactly one result for every input ID.",
].join(" ");

export const PREVIOUS_DEFAULT_SYSTEM_PROMPT =
  "Translate accurately. Preserve meaning, tone, names, terminology, punctuation, and formatting. Use context only for consistency.";

export const DEFAULT_SYSTEM_PROMPT =
  "Translate every segment faithfully into the target language. Preserve meaning, tone, names, terminology, punctuation, and formatting. Keep code, URLs, and non-language tokens unchanged. Use context only for consistency. Never omit, merge, summarize, explain, or add content. Do not leave translatable source text unchanged. Follow the required output format exactly. If uncertain, return the best faithful translation.";

const PREVIOUS_DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_AI_MODEL = "gpt-4.1-mini";
const REMOVED_DEFAULT_BASE_URL = "https://api.norixor.org/v1";
const REMOVED_DEFAULT_MODEL = "gpt-5.6-luna";

export const DEFAULT_SETTINGS: AppSettings = {
  uiLanguage: "auto",
  provider: {
    fastProvider: "chrome-local",
    aiProvider: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    googleApiKey: "",
    microsoftApiKey: "",
    microsoftRegion: "",
    deeplApiKey: "",
    deeplPlan: "free",
    model: DEFAULT_AI_MODEL,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    timeoutMs: 60_000,
  },
  page: {
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    mode: "fast",
    aiResponseMode: "stream",
    displayMode: "translated",
    autoTranslate: false,
    autoTranslateSitePatterns: [],
    autoTranslateExcludedSitePatterns: [],
    floatingButtonEnabled: true,
    selectionTranslationEnabled: true,
    selectionTranslationSourceLanguage: "auto",
    selectionTranslationTargetLanguage: "zh-CN",
    selectionTranslationMode: "fast",
    selectionTranslationAiResponseMode: "stream",
    selectionTranslationModelOverride: "",
    selectionTranslationDisplayMode: "bilingual",
  },
  subtitles: {
    enabled: true,
    floatingButtonEnabled: true,
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    mode: "ai",
    aiResponseMode: "stream",
    displayMode: "bilingual",
    hideNativeSubtitles: false,
    position: "bottom",
    customPosition: { x: 0.5, y: 0.82 },
    fontScale: 1.2,
    backgroundOpacity: 0.5,
  },
  ocr: {
    enabled: false,
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    provider: "chrome-local",
  },
  imageTranslation: {
    enabled: false,
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    mode: "fast",
    modelOverride: "",
    displayMode: "translated",
  },
};

export function isAllowedProviderBaseUrl(value: string): boolean {
  if (value.length > 2_048) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

export function toContentSettings(settings: AppSettings): ContentSettings {
  return {
    uiLanguage: settings.uiLanguage,
    provider: {
      fastProvider: settings.provider.fastProvider,
      aiProvider: settings.provider.aiProvider,
      baseUrl: settings.provider.baseUrl,
      microsoftRegion: settings.provider.microsoftRegion,
      deeplPlan: settings.provider.deeplPlan,
      model: settings.provider.model,
      systemPrompt: settings.provider.systemPrompt,
      timeoutMs: settings.provider.timeoutMs,
    },
    page: { ...settings.page },
    subtitles: { ...settings.subtitles },
    ocr: { ...settings.ocr },
    imageTranslation: { ...settings.imageTranslation },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function mergeSettings(value: unknown): AppSettings {
  if (!isRecord(value)) return structuredClone(DEFAULT_SETTINGS);

  const provider = isRecord(value.provider) ? value.provider : {};
  const page = isRecord(value.page) ? value.page : {};
  const subtitles = isRecord(value.subtitles) ? value.subtitles : {};
  const ocr = isRecord(value.ocr) ? value.ocr : {};
  const imageTranslation = isRecord(value.imageTranslation)
    ? value.imageTranslation
    : {};

  const legacyAiFastProvider = provider.fastProvider === "openai-compatible";
  const fastProvider: FastProviderId =
    provider.fastProvider === "bergamot-local" ||
    provider.fastProvider === "google-translate" ||
    provider.fastProvider === "microsoft-translator" ||
    provider.fastProvider === "deepl"
      ? provider.fastProvider
      : "chrome-local";
  const pageMode = legacyAiFastProvider || page.mode === "ai" ? "ai" : "fast";
  const removedPageRoute = pageMode === "ai" && page.aiRoute === "norixor";
  const pageDisplayMode =
    page.displayMode === "bilingual" ? "bilingual" : "translated";
  const subtitleMode =
    legacyAiFastProvider || subtitles.mode !== "fast" ? "ai" : "fast";
  const selectionMode = legacyAiFastProvider
    ? "ai"
    : page.selectionTranslationMode === "fast" ||
        page.selectionTranslationMode === "ai"
      ? page.selectionTranslationMode
      : pageMode;
  const removedSubtitleRoute =
    subtitleMode === "ai" && subtitles.aiRoute === "norixor";
  const removedSelectionRoute =
    selectionMode === "ai" && page.selectionTranslationAiRoute === "norixor";
  const subtitleDisplayMode =
    subtitles.displayMode === "translated" ||
    subtitles.displayMode === "original"
      ? subtitles.displayMode
      : "bilingual";
  const subtitlePosition =
    subtitles.position === "top" ||
    subtitles.position === "center" ||
    subtitles.position === "custom"
      ? subtitles.position
      : "bottom";
  const customPosition = isRecord(subtitles.customPosition)
    ? subtitles.customPosition
    : {};
  const removedDefaultProvider =
    provider.baseUrl === REMOVED_DEFAULT_BASE_URL && !provider.apiKey;

  return {
    uiLanguage: normalizeUiLanguage(value.uiLanguage),
    provider: {
      fastProvider,
      aiProvider:
        provider.aiProvider === "anthropic-messages"
          ? "anthropic-messages"
          : "openai-compatible",
      baseUrl:
        !removedDefaultProvider &&
        typeof provider.baseUrl === "string" &&
        isAllowedProviderBaseUrl(provider.baseUrl)
          ? provider.baseUrl
          : DEFAULT_SETTINGS.provider.baseUrl,
      apiKey:
        typeof provider.apiKey === "string"
          ? provider.apiKey
          : DEFAULT_SETTINGS.provider.apiKey,
      googleApiKey:
        typeof provider.googleApiKey === "string"
          ? provider.googleApiKey
          : DEFAULT_SETTINGS.provider.googleApiKey,
      microsoftApiKey:
        typeof provider.microsoftApiKey === "string"
          ? provider.microsoftApiKey
          : DEFAULT_SETTINGS.provider.microsoftApiKey,
      microsoftRegion:
        typeof provider.microsoftRegion === "string"
          ? provider.microsoftRegion.trim().slice(0, 128)
          : DEFAULT_SETTINGS.provider.microsoftRegion,
      deeplApiKey:
        typeof provider.deeplApiKey === "string"
          ? provider.deeplApiKey
          : DEFAULT_SETTINGS.provider.deeplApiKey,
      deeplPlan: provider.deeplPlan === "pro" ? "pro" : "free",
      model:
        typeof provider.model === "string"
          ? provider.model === PREVIOUS_DEFAULT_MODEL ||
            (removedDefaultProvider && provider.model === REMOVED_DEFAULT_MODEL)
            ? DEFAULT_AI_MODEL
            : provider.model
          : DEFAULT_SETTINGS.provider.model,
      systemPrompt:
        typeof provider.systemPrompt === "string"
          ? provider.systemPrompt === LEGACY_DEFAULT_SYSTEM_PROMPT ||
            provider.systemPrompt === PREVIOUS_DEFAULT_SYSTEM_PROMPT
            ? DEFAULT_SYSTEM_PROMPT
            : provider.systemPrompt
          : DEFAULT_SETTINGS.provider.systemPrompt,
      timeoutMs:
        typeof provider.timeoutMs === "number" &&
        Number.isFinite(provider.timeoutMs)
          ? Math.min(180_000, Math.max(5_000, provider.timeoutMs))
          : DEFAULT_SETTINGS.provider.timeoutMs,
    },
    page: {
      sourceLanguage:
        typeof page.sourceLanguage === "string"
          ? page.sourceLanguage
          : DEFAULT_SETTINGS.page.sourceLanguage,
      targetLanguage:
        typeof page.targetLanguage === "string"
          ? page.targetLanguage
          : DEFAULT_SETTINGS.page.targetLanguage,
      mode: removedPageRoute ? "fast" : pageMode,
      aiResponseMode: page.aiResponseMode === "batch" ? "batch" : "stream",
      displayMode: pageDisplayMode,
      autoTranslate:
        removedPageRoute || typeof page.autoTranslate !== "boolean"
          ? false
          : page.autoTranslate,
      autoTranslateSitePatterns: normalizeAutoTranslateSitePatterns(
        page.autoTranslateSitePatterns,
      ),
      autoTranslateExcludedSitePatterns: normalizeAutoTranslateSitePatterns(
        page.autoTranslateExcludedSitePatterns,
      ),
      floatingButtonEnabled:
        typeof page.floatingButtonEnabled === "boolean"
          ? page.floatingButtonEnabled
          : DEFAULT_SETTINGS.page.floatingButtonEnabled,
      selectionTranslationEnabled: removedSelectionRoute
        ? false
        : typeof page.selectionTranslationEnabled === "boolean"
          ? page.selectionTranslationEnabled
          : DEFAULT_SETTINGS.page.selectionTranslationEnabled,
      selectionTranslationSourceLanguage:
        typeof page.selectionTranslationSourceLanguage === "string"
          ? page.selectionTranslationSourceLanguage
          : typeof page.sourceLanguage === "string"
            ? page.sourceLanguage
            : DEFAULT_SETTINGS.page.selectionTranslationSourceLanguage,
      selectionTranslationTargetLanguage:
        typeof page.selectionTranslationTargetLanguage === "string"
          ? page.selectionTranslationTargetLanguage
          : typeof page.targetLanguage === "string"
            ? page.targetLanguage
            : DEFAULT_SETTINGS.page.selectionTranslationTargetLanguage,
      selectionTranslationMode: removedSelectionRoute ? "fast" : selectionMode,
      selectionTranslationAiResponseMode:
        page.selectionTranslationAiResponseMode === "batch"
          ? "batch"
          : page.selectionTranslationAiResponseMode === "stream"
            ? "stream"
            : page.aiResponseMode === "batch"
              ? "batch"
              : "stream",
      selectionTranslationModelOverride: removedSelectionRoute
        ? ""
        : typeof page.selectionTranslationModelOverride === "string"
          ? page.selectionTranslationModelOverride.trim().slice(0, 256)
          : DEFAULT_SETTINGS.page.selectionTranslationModelOverride,
      selectionTranslationDisplayMode:
        page.selectionTranslationDisplayMode === "translated"
          ? "translated"
          : "bilingual",
    },
    subtitles: {
      enabled: removedSubtitleRoute
        ? false
        : typeof subtitles.enabled === "boolean"
          ? subtitles.enabled
          : DEFAULT_SETTINGS.subtitles.enabled,
      floatingButtonEnabled:
        typeof subtitles.floatingButtonEnabled === "boolean"
          ? subtitles.floatingButtonEnabled
          : DEFAULT_SETTINGS.subtitles.floatingButtonEnabled,
      sourceLanguage:
        typeof subtitles.sourceLanguage === "string"
          ? subtitles.sourceLanguage
          : DEFAULT_SETTINGS.subtitles.sourceLanguage,
      targetLanguage:
        typeof subtitles.targetLanguage === "string"
          ? subtitles.targetLanguage
          : DEFAULT_SETTINGS.subtitles.targetLanguage,
      mode: removedSubtitleRoute ? "fast" : subtitleMode,
      aiResponseMode: subtitles.aiResponseMode === "batch" ? "batch" : "stream",
      displayMode: subtitleDisplayMode,
      hideNativeSubtitles:
        typeof subtitles.hideNativeSubtitles === "boolean"
          ? subtitles.hideNativeSubtitles
          : DEFAULT_SETTINGS.subtitles.hideNativeSubtitles,
      position: subtitlePosition,
      customPosition: {
        x:
          typeof customPosition.x === "number" &&
          Number.isFinite(customPosition.x)
            ? Math.min(1, Math.max(0, customPosition.x))
            : DEFAULT_SETTINGS.subtitles.customPosition.x,
        y:
          typeof customPosition.y === "number" &&
          Number.isFinite(customPosition.y)
            ? Math.min(1, Math.max(0, customPosition.y))
            : DEFAULT_SETTINGS.subtitles.customPosition.y,
      },
      fontScale:
        typeof subtitles.fontScale === "number" &&
        Number.isFinite(subtitles.fontScale)
          ? Math.min(1.8, Math.max(0.75, subtitles.fontScale))
          : DEFAULT_SETTINGS.subtitles.fontScale,
      backgroundOpacity:
        typeof subtitles.backgroundOpacity === "number" &&
        Number.isFinite(subtitles.backgroundOpacity)
          ? Math.min(0.95, Math.max(0.3, subtitles.backgroundOpacity))
          : DEFAULT_SETTINGS.subtitles.backgroundOpacity,
    },
    ocr: {
      enabled:
        typeof ocr.enabled === "boolean"
          ? ocr.enabled
          : DEFAULT_SETTINGS.ocr.enabled,
      sourceLanguage:
        typeof ocr.sourceLanguage === "string"
          ? ocr.sourceLanguage
          : typeof subtitles.sourceLanguage === "string"
            ? subtitles.sourceLanguage
            : DEFAULT_SETTINGS.ocr.sourceLanguage,
      targetLanguage:
        typeof ocr.targetLanguage === "string"
          ? ocr.targetLanguage
          : typeof subtitles.targetLanguage === "string"
            ? subtitles.targetLanguage
            : DEFAULT_SETTINGS.ocr.targetLanguage,
      provider:
        ocr.provider === "bergamot-local" ? "bergamot-local" : "chrome-local",
    },
    imageTranslation: {
      enabled:
        typeof imageTranslation.enabled === "boolean"
          ? imageTranslation.enabled
          : DEFAULT_SETTINGS.imageTranslation.enabled,
      sourceLanguage:
        typeof imageTranslation.sourceLanguage === "string"
          ? imageTranslation.sourceLanguage
          : DEFAULT_SETTINGS.imageTranslation.sourceLanguage,
      targetLanguage:
        typeof imageTranslation.targetLanguage === "string"
          ? imageTranslation.targetLanguage
          : DEFAULT_SETTINGS.imageTranslation.targetLanguage,
      mode:
        legacyAiFastProvider || imageTranslation.mode === "ai" ? "ai" : "fast",
      modelOverride:
        typeof imageTranslation.modelOverride === "string"
          ? imageTranslation.modelOverride.trim().slice(0, 256)
          : DEFAULT_SETTINGS.imageTranslation.modelOverride,
      displayMode:
        imageTranslation.displayMode === "bilingual"
          ? "bilingual"
          : "translated",
    },
  };
}

export async function loadSettings(): Promise<AppSettings> {
  const stored = await browser.storage.local.get("settings");
  return mergeSettings(stored.settings);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await browser.storage.local.set({ settings });
}
