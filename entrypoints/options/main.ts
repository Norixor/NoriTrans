import {
  isAllowedProviderBaseUrl,
  loadSettings,
  mergeSettings,
  type AiProviderId,
  type AppSettings,
  type FastProviderId,
} from "@/src/shared/settings";
import {
  displayLanguageName,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
} from "@/src/shared/languages";
import {
  currentUiLocale,
  initializeUiLanguage,
  localizeDocument,
  message,
} from "@/src/shared/i18n";
import {
  parseTranslationMethod,
  TRANSLATION_METHODS,
  translationMethodValue,
} from "@/src/shared/translation-methods";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import type {
  SitePageTranslationOverride,
  SiteSelectionTranslationOverride,
  SiteSubtitleTranslationOverride,
  SiteSurfaceTranslationOverride,
  SiteTranslationProfile,
} from "@/src/site-profiles/types";
import {
  createSiteProfileDocument,
  parseSiteProfileDocument,
  type SiteProfileDocument,
} from "@/src/site-profiles/document";
import { isSiteTranslationProfile } from "@/src/site-profiles/validation";
import {
  isBuiltInProfileOverride,
  isUserSiteProfile,
  MINIMAL_USER_SITE_PROFILE_TEMPLATE,
  parseEditableSiteProfile,
  parseSiteProfile,
  SITE_PROFILE_PARSER_ALLOWLIST,
  SiteProfileValidationError,
  type SiteProfileValidationReason,
} from "@/src/subtitles/profiles/registry";
import { createLocalOcrEngine, ocrRecognitionText } from "@/src/ocr/engine";
import {
  isOcrSourceLanguageSupported,
  type OcrRuntimeLanguage,
} from "@/src/ocr/languages";
import {
  getOcrRuntimeLanguage,
  getOcrRuntimePack,
  isOcrRuntimeLanguageCode,
} from "@/src/ocr/runtime-catalog";
import type {
  LocalTranslationRuntimeInfo,
  OcrRuntimeInfo,
} from "@/src/messaging/protocol";
import type { ExtensionUpdateStatus } from "@/src/update/checker";
import {
  installedBergamotPackIds,
  providerSourceLanguageAvailable,
  providerTargetLanguageAvailable,
  queryChromeTranslationPairs,
  type TranslationCapabilities,
} from "@/src/translation/provider-capabilities";
import { browser } from "wxt/browser";
import { DirtyControlTracker } from "./dirty-control-tracker";

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>(`#${id}`);
  if (!value) throw new Error(`Missing options element: ${id}`);
  return value;
}

function isSuccessfulResponse(value: unknown): value is { ok: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

function localTranslationRuntimeFailureMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return "localTranslationRuntimeDownloadFailed";
  }
  switch (value.error) {
    case "bergamot_catalog_unavailable":
      return "localTranslationRuntimeCatalogUnavailable";
    case "bergamot_catalog_invalid":
      return "localTranslationRuntimeCatalogInvalid";
    case "bergamot_unsupported_language":
      return "localTranslationRuntimeUnsupported";
    case "bergamot_integrity_failed":
      return "localTranslationRuntimeIntegrityFailed";
    case "bergamot_cancelled":
      return "localTranslationRuntimeCancelled";
    default:
      return "localTranslationRuntimeStorageFailed";
  }
}

function isUpdateStatus(value: unknown): value is ExtensionUpdateStatus {
  return (
    isSuccessfulResponse(value) &&
    "state" in value &&
    typeof value.state === "string" &&
    ["never", "current", "available", "ignored", "error"].includes(
      value.state,
    ) &&
    "currentVersion" in value &&
    typeof value.currentVersion === "string" &&
    "autoCheckEnabled" in value &&
    typeof value.autoCheckEnabled === "boolean"
  );
}

function isConnectionTestResponse(
  value: unknown,
): value is { ok: boolean; message?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean" &&
    (!("message" in value) ||
      (typeof value.message === "string" && value.message.length <= 2_000))
  );
}

function isSiteProfilesResponse(value: unknown): value is {
  ok: true;
  builtIns: SubtitleSiteProfile[];
  profiles: SubtitleSiteProfile[];
  overrides: SubtitleSiteProfile[];
  translationProfiles: SiteTranslationProfile[];
} {
  return (
    isSuccessfulResponse(value) &&
    "builtIns" in value &&
    Array.isArray(value.builtIns) &&
    value.builtIns.every((profile) => {
      try {
        parseSiteProfile(profile);
        return true;
      } catch {
        return false;
      }
    }) &&
    "profiles" in value &&
    Array.isArray(value.profiles) &&
    value.profiles.every((profile) => isUserSiteProfile(profile)) &&
    "overrides" in value &&
    Array.isArray(value.overrides) &&
    value.overrides.every((profile) => isBuiltInProfileOverride(profile)) &&
    "translationProfiles" in value &&
    Array.isArray(value.translationProfiles) &&
    value.translationProfiles.every(isSiteTranslationProfile)
  );
}

function isSiteTranslationProfileSaveResponse(
  value: unknown,
): value is { ok: true; profile: SiteTranslationProfile } {
  return (
    isSuccessfulResponse(value) &&
    "profile" in value &&
    isSiteTranslationProfile(value.profile)
  );
}

function isProfileEditorSaveResponse(value: unknown): value is {
  ok: true;
  kind: "user" | "override";
  profile: SubtitleSiteProfile;
} {
  return (
    isSuccessfulResponse(value) &&
    "kind" in value &&
    (value.kind === "user" || value.kind === "override") &&
    "profile" in value &&
    (value.kind === "user"
      ? isUserSiteProfile(value.profile)
      : isBuiltInProfileOverride(value.profile))
  );
}

function profileValidationFailure(
  value: unknown,
): { path: string; reason: SiteProfileValidationReason } | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    value.ok !== false ||
    !("error" in value) ||
    value.error !== "site_profile_invalid" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    value.path.length > 160 ||
    !("reason" in value) ||
    typeof value.reason !== "string"
  ) {
    return null;
  }
  const reasons: readonly SiteProfileValidationReason[] = [
    "type",
    "unknown_field",
    "required",
    "format",
    "range",
    "unsafe_selector",
    "unsafe_hostname",
    "unsafe_url_pattern",
    "parser_not_allowed",
    "tencent_ocr_only",
    "override_not_supported",
  ];
  return reasons.includes(value.reason as SiteProfileValidationReason)
    ? { path: value.path, reason: value.reason as SiteProfileValidationReason }
    : null;
}

function isFloatingRestoreResponse(
  value: unknown,
): value is { ok: true; restored: number } {
  return (
    isSuccessfulResponse(value) &&
    "restored" in value &&
    typeof value.restored === "number" &&
    Number.isInteger(value.restored) &&
    value.restored >= 0
  );
}

type OcrRuntimeStatus = OcrRuntimeInfo;

function isOcrRuntimeStatus(value: unknown): value is OcrRuntimeStatus {
  if (typeof value !== "object" || value === null) return false;
  const runtime = value as Record<string, unknown>;
  return (
    (runtime.pack === "zh" ||
      runtime.pack === "latin" ||
      runtime.pack === "korean") &&
    typeof runtime.labelKey === "string" &&
    Array.isArray(runtime.languages) &&
    runtime.languages.every(isOcrRuntimeLanguageCode) &&
    (runtime.state === "missing" ||
      runtime.state === "downloading" ||
      runtime.state === "installed" ||
      runtime.state === "error") &&
    (runtime.progress === undefined || typeof runtime.progress === "number") &&
    (runtime.bytes === undefined || typeof runtime.bytes === "number") &&
    (runtime.message === undefined || typeof runtime.message === "string")
  );
}

function isOcrRuntimeListResponse(
  value: unknown,
): value is { ok: true; runtimes: OcrRuntimeStatus[] } {
  return (
    isSuccessfulResponse(value) &&
    "runtimes" in value &&
    Array.isArray(value.runtimes) &&
    value.runtimes.every(isOcrRuntimeStatus)
  );
}

function isLocalTranslationRuntimeStatus(
  value: unknown,
): value is LocalTranslationRuntimeInfo {
  if (typeof value !== "object" || value === null) return false;
  const runtime = value as Record<string, unknown>;
  return (
    typeof runtime.packId === "string" &&
    typeof runtime.sourceLanguage === "string" &&
    typeof runtime.targetLanguage === "string" &&
    (runtime.state === "missing" ||
      runtime.state === "downloading" ||
      runtime.state === "installed" ||
      runtime.state === "error") &&
    (runtime.version === undefined || typeof runtime.version === "string") &&
    (runtime.bytes === undefined || typeof runtime.bytes === "number") &&
    (runtime.downloadBytes === undefined ||
      (typeof runtime.downloadBytes === "number" &&
        Number.isSafeInteger(runtime.downloadBytes) &&
        runtime.downloadBytes > 0)) &&
    (runtime.message === undefined || typeof runtime.message === "string")
  );
}

function isLocalTranslationRuntimeListResponse(
  value: unknown,
): value is { ok: true; runtimes: LocalTranslationRuntimeInfo[] } {
  return (
    isSuccessfulResponse(value) &&
    "runtimes" in value &&
    Array.isArray(value.runtimes) &&
    value.runtimes.every(isLocalTranslationRuntimeStatus)
  );
}

const OCR_RUNTIME_ORIGINS = [
  "https://media.githubusercontent.com/*",
  "https://raw.githubusercontent.com/*",
];
const LOCAL_TRANSLATION_RUNTIME_ORIGINS = ["https://storage.googleapis.com/*"];

async function requestOcrRuntimeDownloadPermission(): Promise<boolean> {
  try {
    return await browser.permissions.request({ origins: OCR_RUNTIME_ORIGINS });
  } catch {
    return false;
  }
}

async function requestLocalTranslationRuntimePermission(): Promise<boolean> {
  try {
    return await browser.permissions.request({
      origins: LOCAL_TRANSLATION_RUNTIME_ORIGINS,
    });
  } catch {
    return false;
  }
}

function failureMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  if (error.message === "provider-permission-denied")
    return "providerPermissionDenied";
  if (error.message === "provider-url-invalid") return "providerUrlInvalid";
  if (error.message === "ocr-capture-permission-denied")
    return "ocrCapturePermissionRequired";
  return fallback;
}

async function requestOcrCapturePermission(): Promise<void> {
  const permissions = { origins: ["<all_urls>"] };
  if (!(await browser.permissions.request(permissions))) {
    throw new Error("ocr-capture-permission-denied");
  }
}

async function requestProviderPermission(settings: AppSettings): Promise<void> {
  if (!isAllowedProviderBaseUrl(settings.provider.baseUrl)) {
    throw new Error("provider-url-invalid");
  }
  const providerId = settings.provider.fastProvider;
  const origins = new Set([`${new URL(settings.provider.baseUrl).origin}/*`]);
  if (providerId === "google-translate")
    origins.add("https://translation.googleapis.com/*");
  if (providerId === "microsoft-translator")
    origins.add("https://api.cognitive.microsofttranslator.com/*");
  if (providerId === "deepl")
    origins.add(
      settings.provider.deeplPlan === "pro"
        ? "https://api.deepl.com/*"
        : "https://api-free.deepl.com/*",
    );
  const permissions = { origins: [...origins] };
  if (!(await browser.permissions.request(permissions))) {
    throw new Error("provider-permission-denied");
  }
}

async function initialize(): Promise<void> {
  const form = element<HTMLFormElement>("settings-form");
  const pageSettingsTab = element<HTMLButtonElement>("page-settings-tab");
  const selectionSettingsTab = element<HTMLButtonElement>(
    "selection-settings-tab",
  );
  const videoSettingsTab = element<HTMLButtonElement>("video-settings-tab");
  const profilesSettingsTab = element<HTMLButtonElement>(
    "profiles-settings-tab",
  );
  const imageSettingsTab = element<HTMLButtonElement>("image-settings-tab");
  const providerSettingsTab = element<HTMLButtonElement>(
    "provider-settings-tab",
  );
  const localTranslationSettingsTab = element<HTMLButtonElement>(
    "local-translation-settings-tab",
  );
  const ocrRuntimesTab = element<HTMLButtonElement>("ocr-runtimes-tab");
  const visibilitySettingsTab = element<HTMLButtonElement>(
    "visibility-settings-tab",
  );
  const pageSettingsPanel = element<HTMLElement>("page-settings-panel");
  const selectionSettingsPanel = element<HTMLElement>(
    "selection-settings-panel",
  );
  const videoSettingsPanel = element<HTMLElement>("video-settings-panel");
  const profilesSettingsPanel = element<HTMLElement>("profiles-settings-panel");
  const imageSettingsPanel = element<HTMLElement>("image-settings-panel");
  const providerSettingsPanel = element<HTMLElement>("provider-settings-panel");
  const localTranslationSettingsPanel = element<HTMLElement>(
    "local-translation-settings-panel",
  );
  const ocrRuntimesPanel = element<HTMLElement>("ocr-runtimes-panel");
  const visibilitySettingsPanel = element<HTMLElement>(
    "visibility-settings-panel",
  );
  const uiLanguage = element<HTMLSelectElement>("ui-language");
  const fastProvider = element<HTMLSelectElement>("fast-provider");
  const aiProvider = element<HTMLSelectElement>("ai-provider");
  const googleProviderFields = element<HTMLElement>("google-provider-fields");
  const microsoftProviderFields = element<HTMLElement>(
    "microsoft-provider-fields",
  );
  const deeplProviderFields = element<HTMLElement>("deepl-provider-fields");
  const baseUrl = element<HTMLInputElement>("base-url");
  const apiKey = element<HTMLInputElement>("api-key");
  const googleApiKey = element<HTMLInputElement>("google-api-key");
  const microsoftApiKey = element<HTMLInputElement>("microsoft-api-key");
  const microsoftRegion = element<HTMLInputElement>("microsoft-region");
  const deeplApiKey = element<HTMLInputElement>("deepl-api-key");
  const deeplPlan = element<HTMLSelectElement>("deepl-plan");
  const model = element<HTMLInputElement>("model");
  const timeout = element<HTMLInputElement>("timeout");
  const systemPrompt = element<HTMLTextAreaElement>("system-prompt");
  const pageSourceLanguage = element<HTMLSelectElement>("page-source-language");
  const pageTargetLanguage = element<HTMLSelectElement>("page-target-language");
  const pageMode = element<HTMLSelectElement>("page-mode");
  const pageResponseMode = element<HTMLSelectElement>("page-response-mode");
  const pageDisplayMode = element<HTMLSelectElement>("page-display-mode");
  const pageAutoTranslate = element<HTMLInputElement>("page-auto-translate");
  const autoTranslateSiteList = element<HTMLUListElement>(
    "auto-translate-site-list",
  );
  const autoTranslateSiteEmpty = element<HTMLParagraphElement>(
    "auto-translate-site-empty",
  );
  const autoTranslateSiteCount = element<HTMLSpanElement>(
    "auto-translate-site-count",
  );
  const selectionTranslationEnabled = element<HTMLInputElement>(
    "selection-translation-enabled",
  );
  const selectionTranslationSourceLanguage = element<HTMLSelectElement>(
    "selection-translation-source-language",
  );
  const selectionTranslationTargetLanguage = element<HTMLSelectElement>(
    "selection-translation-target-language",
  );
  const selectionTranslationMode = element<HTMLSelectElement>(
    "selection-translation-mode",
  );
  const selectionTranslationResponseMode = element<HTMLSelectElement>(
    "selection-translation-response-mode",
  );
  const selectionTranslationDisplayMode = element<HTMLSelectElement>(
    "selection-translation-display-mode",
  );
  const selectionTranslationModelOverride = element<HTMLInputElement>(
    "selection-translation-model-override",
  );
  const floatingControlEnabled = element<HTMLInputElement>(
    "floating-control-enabled",
  );
  const restoreSessionFloating = element<HTMLButtonElement>(
    "restore-session-floating",
  );
  const restoreSessionFloatingMessage = element<HTMLOutputElement>(
    "restore-session-floating-message",
  );
  const updateAutoCheck = element<HTMLInputElement>("update-auto-check");
  const updateStatusOutput = element<HTMLOutputElement>("update-status");
  const checkUpdatesButton = element<HTMLButtonElement>("check-updates");
  const viewUpdateButton = element<HTMLButtonElement>("view-update");
  const ignoreUpdateButton = element<HTMLButtonElement>("ignore-update");
  const subtitleEnabled = element<HTMLInputElement>("subtitle-enabled");
  const subtitleSourceLanguage = element<HTMLSelectElement>(
    "subtitle-source-language",
  );
  const subtitleTargetLanguage = element<HTMLSelectElement>(
    "subtitle-target-language",
  );
  const subtitleMode = element<HTMLSelectElement>("subtitle-mode");
  const subtitleResponseMode = element<HTMLSelectElement>(
    "subtitle-response-mode",
  );
  const subtitleDisplayMode = element<HTMLSelectElement>(
    "subtitle-display-mode",
  );
  const subtitlePosition = element<HTMLSelectElement>("subtitle-position");
  const subtitleHideNative = element<HTMLInputElement>("subtitle-hide-native");
  const subtitleFontScale = element<HTMLInputElement>("subtitle-font-scale");
  const subtitleBackgroundOpacity = element<HTMLInputElement>(
    "subtitle-background-opacity",
  );
  const ocrEnabled = element<HTMLInputElement>("ocr-enabled");
  const ocrSourceLanguage = element<HTMLSelectElement>("ocr-source-language");
  const ocrTargetLanguage = element<HTMLSelectElement>("ocr-target-language");
  const ocrProvider = element<HTMLSelectElement>("ocr-provider");
  const imageTranslationEnabled = element<HTMLInputElement>(
    "image-translation-enabled",
  );
  const imageSourceLanguage = element<HTMLSelectElement>(
    "image-source-language",
  );
  const imageTargetLanguage = element<HTMLSelectElement>(
    "image-target-language",
  );
  const imageMode = element<HTMLSelectElement>("image-mode");
  const imageDisplayMode = element<HTMLSelectElement>("image-display-mode");
  const imageModelOverride = element<HTMLInputElement>("image-model-override");
  const imageRuntimeWarning = element<HTMLElement>("image-runtime-warning");
  const imageRuntimeOpenSettings = element<HTMLButtonElement>(
    "image-runtime-open-settings",
  );
  const ocrSelfTest = element<HTMLButtonElement>("ocr-self-test");
  const ocrTestMessage = element<HTMLOutputElement>("ocr-test-message");
  const ocrRuntimeDownloadAll = element<HTMLButtonElement>(
    "ocr-runtime-download-all",
  );
  const ocrRuntimeList = element<HTMLUListElement>("ocr-runtime-list");
  const ocrRuntimeLoading = element<HTMLParagraphElement>(
    "ocr-runtime-loading",
  );
  const ocrRuntimeEmpty = element<HTMLParagraphElement>("ocr-runtime-empty");
  const ocrRuntimeMessage = element<HTMLParagraphElement>(
    "ocr-runtime-message",
  );
  const localTranslationRuntimeList = element<HTMLUListElement>(
    "local-translation-runtime-list",
  );
  const localTranslationRuntimeLoading = element<HTMLParagraphElement>(
    "local-translation-runtime-loading",
  );
  const localTranslationRuntimeEmpty = element<HTMLParagraphElement>(
    "local-translation-runtime-empty",
  );
  const localTranslationRuntimeMessage = element<HTMLParagraphElement>(
    "local-translation-runtime-message",
  );
  const fontScaleValue = element<HTMLOutputElement>("font-scale-value");
  const backgroundOpacityValue = element<HTMLOutputElement>(
    "background-opacity-value",
  );
  const saveButton = element<HTMLButtonElement>("save-settings");
  const saveMessage = element<HTMLParagraphElement>("save-message");
  const testButton = element<HTMLButtonElement>("test-connection");
  const testMessage = element<HTMLElement>("test-message");
  const connectionDiagnostic = element<HTMLDetailsElement>(
    "connection-diagnostic",
  );
  const connectionDiagnosticText = element<HTMLElement>(
    "connection-diagnostic-text",
  );
  const clearCacheButton = element<HTMLButtonElement>("clear-cache");
  const clearCredentialsButton =
    element<HTMLButtonElement>("clear-credentials");
  const profileNew = element<HTMLButtonElement>("profile-new");
  const profileName = element<HTMLInputElement>("profile-name");
  const profileHostname = element<HTMLInputElement>("profile-hostname");
  const profilePageOverride = element<HTMLInputElement>(
    "profile-page-override",
  );
  const profileSelectionOverride = element<HTMLInputElement>(
    "profile-selection-override",
  );
  const profileSubtitleOverride = element<HTMLInputElement>(
    "profile-subtitle-override",
  );
  const profilePageSourceLanguage = element<HTMLSelectElement>(
    "profile-page-source-language",
  );
  const profilePageTargetLanguage = element<HTMLSelectElement>(
    "profile-page-target-language",
  );
  const profilePageMethod = element<HTMLSelectElement>("profile-page-method");
  const profilePageModel = element<HTMLInputElement>("profile-page-model");
  const profilePageResponseMode = element<HTMLSelectElement>(
    "profile-page-response-mode",
  );
  const profilePageDisplayMode = element<HTMLSelectElement>(
    "profile-page-display-mode",
  );
  const profilePageAutoTranslate = element<HTMLInputElement>(
    "profile-page-auto-translate",
  );
  const profilePageFloatingButton = element<HTMLInputElement>(
    "profile-page-floating-button",
  );
  const profileSelectionSourceLanguage = element<HTMLSelectElement>(
    "profile-selection-source-language",
  );
  const profileSelectionTargetLanguage = element<HTMLSelectElement>(
    "profile-selection-target-language",
  );
  const profileSelectionMethod = element<HTMLSelectElement>(
    "profile-selection-method",
  );
  const profileSelectionModel = element<HTMLInputElement>(
    "profile-selection-model",
  );
  const profileSelectionResponseMode = element<HTMLSelectElement>(
    "profile-selection-response-mode",
  );
  const profileSelectionDisplayMode = element<HTMLSelectElement>(
    "profile-selection-display-mode",
  );
  const profileSelectionEnabled = element<HTMLInputElement>(
    "profile-selection-enabled",
  );
  const profileSubtitleSourceLanguage = element<HTMLSelectElement>(
    "profile-subtitle-source-language",
  );
  const profileSubtitleTargetLanguage = element<HTMLSelectElement>(
    "profile-subtitle-target-language",
  );
  const profileSubtitleMethod = element<HTMLSelectElement>(
    "profile-subtitle-method",
  );
  const profileSubtitleModel = element<HTMLInputElement>(
    "profile-subtitle-model",
  );
  const profileSubtitleResponseMode = element<HTMLSelectElement>(
    "profile-subtitle-response-mode",
  );
  const profileSubtitleDisplayMode = element<HTMLSelectElement>(
    "profile-subtitle-display-mode",
  );
  const profileSubtitlePosition = element<HTMLSelectElement>(
    "profile-subtitle-position",
  );
  const profileSubtitleFontScale = element<HTMLInputElement>(
    "profile-subtitle-font-scale",
  );
  const profileSubtitleBackgroundOpacity = element<HTMLInputElement>(
    "profile-subtitle-background-opacity",
  );
  const profileSubtitleCustomX = element<HTMLInputElement>(
    "profile-subtitle-custom-x",
  );
  const profileSubtitleCustomY = element<HTMLInputElement>(
    "profile-subtitle-custom-y",
  );
  const profileSubtitleEnabled = element<HTMLInputElement>(
    "profile-subtitle-enabled",
  );
  const profileSubtitleFloatingButton = element<HTMLInputElement>(
    "profile-subtitle-floating-button",
  );
  const profileSubtitleHideNative = element<HTMLInputElement>(
    "profile-subtitle-hide-native",
  );
  const profileCaptureOverride = element<HTMLInputElement>(
    "profile-capture-override",
  );
  const profileCaptureDetails = element<HTMLDetailsElement>(
    "profile-capture-details",
  );
  const profileCaptureParser = element<HTMLSelectElement>(
    "profile-capture-parser",
  );
  const profileCapturePriority = element<HTMLInputElement>(
    "profile-capture-priority",
  );
  const profileCaptureFormats = element<HTMLSelectElement>(
    "profile-capture-formats",
  );
  const profileCaptureVideoSelector = element<HTMLInputElement>(
    "profile-capture-video-selector",
  );
  const profileCaptureCaptionSelectors = element<HTMLTextAreaElement>(
    "profile-capture-caption-selectors",
  );
  const profileCaptureNativeSelectors = element<HTMLTextAreaElement>(
    "profile-capture-native-selectors",
  );
  const profileCaptureHostnames = element<HTMLTextAreaElement>(
    "profile-capture-hostnames",
  );
  const profileCaptureUrlPatterns = element<HTMLTextAreaElement>(
    "profile-capture-url-patterns",
  );
  const profileCaptureCompletePatterns = element<HTMLTextAreaElement>(
    "profile-capture-complete-patterns",
  );
  const profileCatalogList = element<HTMLUListElement>("profile-catalog-list");
  const profileTotalCount = element<HTMLSpanElement>("profile-total-count");
  const profileLoading = element<HTMLParagraphElement>("profile-loading");
  const profileJson = element<HTMLTextAreaElement>("profile-json");
  const profileEditorKind = element<HTMLSpanElement>("profile-editor-kind");
  const profileEditorNote = element<HTMLParagraphElement>(
    "profile-editor-note",
  );
  const profileCopyCurrent = element<HTMLButtonElement>("profile-copy-current");
  const profileFormat = element<HTMLButtonElement>("profile-format");
  const profileFileDialog = element<HTMLDialogElement>("profile-file-dialog");
  const profileFileOpen = element<HTMLButtonElement>("profile-file-open");
  const profileFileClose = element<HTMLButtonElement>("profile-file-close");
  const profileFileImport = element<HTMLButtonElement>("profile-file-import");
  const profileFileExport = element<HTMLButtonElement>("profile-file-export");
  const profileFileInput = element<HTMLInputElement>("profile-file-input");
  const profileCancel = element<HTMLButtonElement>("profile-cancel");
  const profileDelete = element<HTMLButtonElement>("profile-delete");
  const profileRestore = element<HTMLButtonElement>("profile-restore");
  const profileSave = element<HTMLButtonElement>("profile-save");
  const profileCopyTemplate = element<HTMLButtonElement>(
    "profile-copy-template",
  );
  const profileTemplate = element<HTMLElement>("profile-template");
  const profileParserGuide = element<HTMLElement>("profile-parser-guide");
  const profileMessage = element<HTMLParagraphElement>("profile-message");
  let settings = await loadSettings();
  let builtInProfiles: SubtitleSiteProfile[] = [];
  let customProfiles: SubtitleSiteProfile[] = [];
  let profileOverrides: SubtitleSiteProfile[] = [];
  let translationProfiles: SiteTranslationProfile[] = [];
  let updateStatus: ExtensionUpdateStatus | undefined;
  let ocrRuntimes: OcrRuntimeStatus[] = [];
  let ocrRuntimeCommandPending = false;
  let ocrRuntimeListLoaded = false;
  let ocrRuntimePollTimer: number | undefined;
  let ocrRuntimeListRequest: Promise<void> | undefined;
  let ocrRuntimeFocus:
    { pack: string | undefined; action: string | undefined } | undefined;
  let localTranslationRuntimes: LocalTranslationRuntimeInfo[] = [];
  let localTranslationRuntimeCommandPending = false;
  let localTranslationRuntimeLoaded = false;
  let localTranslationRuntimePollTimer: number | undefined;
  let localTranslationDownloadProgress:
    | {
        packIds: Set<LocalTranslationRuntimeInfo["packId"]>;
        completedPackIds: Set<LocalTranslationRuntimeInfo["packId"]>;
      }
    | undefined;
  let chromeTranslationPairs: string[] = [];
  let chromeTranslationPairsLoaded = false;
  const dirtyControls = new DirtyControlTracker();

  const profileLanguageLabel = (code: string): string =>
    code === "auto"
      ? message("languageAuto")
      : displayLanguageName(code, currentUiLocale());
  for (const select of [
    profilePageSourceLanguage,
    profileSelectionSourceLanguage,
    profileSubtitleSourceLanguage,
  ]) {
    select.replaceChildren(
      ...SOURCE_LANGUAGES.map(
        ({ code }) => new Option(profileLanguageLabel(code), code),
      ),
    );
  }
  for (const select of [
    profilePageTargetLanguage,
    profileSelectionTargetLanguage,
    profileSubtitleTargetLanguage,
  ]) {
    select.replaceChildren(
      ...TARGET_LANGUAGES.map(
        ({ code }) => new Option(profileLanguageLabel(code), code),
      ),
    );
  }

  const translationMethodSelects = [
    pageMode,
    selectionTranslationMode,
    subtitleMode,
    imageMode,
    profilePageMethod,
    profileSelectionMethod,
    profileSubtitleMethod,
  ] as const;
  for (const select of translationMethodSelects) {
    select.replaceChildren(
      ...TRANSLATION_METHODS.map(
        (method) => new Option(message(method.labelKey), method.value),
      ),
    );
  }

  const selectedProviderValue = (): FastProviderId => {
    const value = fastProvider.value;
    return value === "bergamot-local" ||
      value === "google-translate" ||
      value === "microsoft-translator" ||
      value === "deepl"
      ? value
      : "chrome-local";
  };

  const translationMethodProvider = (
    select: HTMLSelectElement,
  ): FastProviderId | AiProviderId => {
    const method = parseTranslationMethod(select.value);
    return method?.mode === "ai"
      ? settings.provider.aiProvider
      : (method?.fastProvider ?? selectedProviderValue());
  };

  const translationMethodCapabilitiesReady = (
    provider: FastProviderId | AiProviderId,
  ): boolean =>
    provider === "chrome-local"
      ? chromeTranslationPairsLoaded
      : provider === "bergamot-local"
        ? localTranslationRuntimeLoaded
        : true;

  const syncLanguageRestrictions = (): void => {
    const capabilities: TranslationCapabilities = {
      chromePairs: chromeTranslationPairs,
      installedBergamotPackIds: installedBergamotPackIds(
        localTranslationRuntimes,
      ),
    };
    const languageLabel = (code: string): string =>
      code === "auto"
        ? message("languageAuto")
        : displayLanguageName(code, currentUiLocale());
    const syncPair = (
      sourceSelect: HTMLSelectElement,
      targetSelect: HTMLSelectElement,
      provider: FastProviderId | AiProviderId,
      ready: boolean,
    ): void => {
      const sourceLanguage = sourceSelect.value;
      const targetLanguage = targetSelect.value;
      const sourceAvailable = (source: string): boolean =>
        !ready ||
        providerSourceLanguageAvailable(provider, source, capabilities);
      const targetAvailable = (target: string): boolean =>
        !ready ||
        providerTargetLanguageAvailable(provider, target, capabilities);
      const replace = (
        select: HTMLSelectElement,
        languages: typeof SOURCE_LANGUAGES,
        selected: string,
        filter: (code: string) => boolean,
      ): void => {
        select.replaceChildren(
          ...languages
            .filter(({ code }) => filter(code))
            .map(({ code }) => new Option(languageLabel(code), code)),
        );
        if (![...select.options].some((option) => option.value === selected)) {
          const unavailable = new Option(
            `${languageLabel(selected)} · ${message("languageUnavailable")}`,
            selected,
          );
          unavailable.disabled = true;
          select.prepend(unavailable);
        }
        select.value = selected;
      };
      replace(sourceSelect, SOURCE_LANGUAGES, sourceLanguage, sourceAvailable);
      replace(targetSelect, TARGET_LANGUAGES, targetLanguage, targetAvailable);
    };
    const pageProvider = translationMethodProvider(pageMode);
    syncPair(
      pageSourceLanguage,
      pageTargetLanguage,
      pageProvider,
      translationMethodCapabilitiesReady(pageProvider),
    );
    const selectionProvider = translationMethodProvider(
      selectionTranslationMode,
    );
    syncPair(
      selectionTranslationSourceLanguage,
      selectionTranslationTargetLanguage,
      selectionProvider,
      translationMethodCapabilitiesReady(selectionProvider),
    );
    const subtitleProvider = translationMethodProvider(subtitleMode);
    syncPair(
      subtitleSourceLanguage,
      subtitleTargetLanguage,
      subtitleProvider,
      translationMethodCapabilitiesReady(subtitleProvider),
    );
    for (const [source, target, method] of [
      [profilePageSourceLanguage, profilePageTargetLanguage, profilePageMethod],
      [
        profileSelectionSourceLanguage,
        profileSelectionTargetLanguage,
        profileSelectionMethod,
      ],
      [
        profileSubtitleSourceLanguage,
        profileSubtitleTargetLanguage,
        profileSubtitleMethod,
      ],
    ] as const) {
      const provider = translationMethodProvider(method);
      syncPair(
        source,
        target,
        provider,
        translationMethodCapabilitiesReady(provider),
      );
    }
    const imageProvider = translationMethodProvider(imageMode);
    syncPair(
      imageSourceLanguage,
      imageTargetLanguage,
      imageProvider,
      translationMethodCapabilitiesReady(imageProvider),
    );
    const ocrReady =
      ocrProvider.value === "chrome-local"
        ? chromeTranslationPairsLoaded
        : localTranslationRuntimeLoaded;
    syncPair(
      ocrSourceLanguage,
      ocrTargetLanguage,
      ocrProvider.value === "bergamot-local"
        ? "bergamot-local"
        : "chrome-local",
      ocrReady,
    );
  };

  const renderUpdateStatus = (status: ExtensionUpdateStatus): void => {
    updateStatus = status;
    updateAutoCheck.checked = status.autoCheckEnabled;
    const version = status.latestVersion ?? status.currentVersion;
    updateStatusOutput.dataset.tone =
      status.state === "error"
        ? "error"
        : status.state === "available"
          ? "success"
          : "";
    updateStatusOutput.textContent =
      status.state === "available"
        ? message("updateAvailableTitle", version)
        : status.state === "ignored"
          ? message("updateIgnored", version)
          : status.state === "error"
            ? message("updateCheckFailed")
            : status.state === "never"
              ? message("updateNeverChecked")
              : message("updateCurrent", status.currentVersion);
    const available =
      status.state === "available" && Boolean(status.releaseUrl);
    viewUpdateButton.hidden = !available;
    ignoreUpdateButton.hidden = !available;
  };

  const refreshUpdateStatus = async (force: boolean): Promise<void> => {
    checkUpdatesButton.disabled = true;
    if (force) {
      updateStatusOutput.dataset.tone = "";
      updateStatusOutput.textContent = message("updateChecking");
    }
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: force ? "UPDATE_CHECK" : "UPDATE_STATUS_GET",
      });
      if (!isUpdateStatus(response)) throw new Error("invalid-update-status");
      renderUpdateStatus(response);
    } catch {
      updateStatusOutput.dataset.tone = "error";
      updateStatusOutput.textContent = message("updateCheckFailed");
    } finally {
      checkUpdatesButton.disabled = false;
    }
  };

  const languageLabel = (code: string): string =>
    code === "auto"
      ? message("languageAuto")
      : displayLanguageName(code, currentUiLocale());
  for (const language of SOURCE_LANGUAGES) {
    pageSourceLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    selectionTranslationSourceLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    subtitleSourceLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    ocrSourceLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    imageSourceLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
  }
  for (const language of TARGET_LANGUAGES) {
    pageTargetLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    selectionTranslationTargetLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    subtitleTargetLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    ocrTargetLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    imageTargetLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
  }

  const tabItems = [
    { tab: providerSettingsTab, panel: providerSettingsPanel },
    {
      tab: localTranslationSettingsTab,
      panel: localTranslationSettingsPanel,
    },
    { tab: pageSettingsTab, panel: pageSettingsPanel },
    { tab: selectionSettingsTab, panel: selectionSettingsPanel },
    { tab: videoSettingsTab, panel: videoSettingsPanel },
    { tab: profilesSettingsTab, panel: profilesSettingsPanel },
    { tab: imageSettingsTab, panel: imageSettingsPanel },
    { tab: ocrRuntimesTab, panel: ocrRuntimesPanel },
    { tab: visibilitySettingsTab, panel: visibilitySettingsPanel },
  ];
  const activateTab = (nextIndex: number, moveFocus = false): void => {
    tabItems.forEach(({ tab, panel }, index) => {
      const active = index === nextIndex;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      panel.hidden = !active;
    });
    const activeTab = tabItems[nextIndex]?.tab;
    activeTab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (moveFocus) activeTab?.focus();
  };
  if (location.hash === "#visibility") {
    activateTab(tabItems.length - 1);
  }

  tabItems.forEach(({ tab }, index) => {
    tab.addEventListener("click", () => {
      activateTab(index);
      if (tab === localTranslationSettingsTab) {
        void loadLocalTranslationRuntimes(!localTranslationRuntimeLoaded);
      }
    });
    tab.addEventListener("keydown", (event) => {
      let nextIndex: number | undefined;
      if (event.key === "ArrowRight" || event.key === "ArrowDown")
        nextIndex = (index + 1) % tabItems.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp")
        nextIndex = (index - 1 + tabItems.length) % tabItems.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabItems.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      activateTab(nextIndex, true);
    });
  });
  imageRuntimeOpenSettings.addEventListener("click", () => {
    const runtimeTabIndex = tabItems.findIndex(
      ({ tab }) => tab === ocrRuntimesTab,
    );
    if (runtimeTabIndex >= 0) activateTab(runtimeTabIndex, true);
  });

  const syncRangeOutputs = (): void => {
    fontScaleValue.textContent = message(
      "percentageValue",
      String(Math.round(Number(subtitleFontScale.value) * 100)),
    );
    backgroundOpacityValue.textContent = message(
      "percentageValue",
      String(Math.round(Number(subtitleBackgroundOpacity.value) * 100)),
    );
  };

  const renderAutoTranslateSites = (): void => {
    const entries = [
      ...settings.page.autoTranslateSitePatterns.map((pattern) => ({
        pattern,
        kind: "included" as const,
      })),
      ...settings.page.autoTranslateExcludedSitePatterns.map((pattern) => ({
        pattern,
        kind: "excluded" as const,
      })),
    ];
    autoTranslateSiteList.replaceChildren();
    autoTranslateSiteCount.textContent = String(entries.length);
    autoTranslateSiteEmpty.hidden = entries.length > 0;
    for (const entry of entries) {
      const item = document.createElement("li");
      item.className = "auto-translate-site-item";
      const copy = document.createElement("div");
      copy.className = "auto-translate-site-copy";
      const pattern = document.createElement("code");
      pattern.textContent = entry.pattern;
      const kind = document.createElement("span");
      kind.className = "auto-translate-site-kind";
      kind.dataset.kind = entry.kind;
      kind.textContent = message(
        entry.kind === "included"
          ? "autoTranslateRuleEnabled"
          : "autoTranslateRuleExcluded",
      );
      copy.append(pattern, kind);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button-secondary auto-translate-site-delete";
      remove.textContent = message("removeAutoTranslateRule");
      remove.setAttribute(
        "aria-label",
        `${message("removeAutoTranslateRule")}: ${entry.pattern}`,
      );
      remove.addEventListener("click", () => {
        settings = {
          ...settings,
          page: {
            ...settings.page,
            autoTranslateSitePatterns:
              entry.kind === "included"
                ? settings.page.autoTranslateSitePatterns.filter(
                    (candidate) => candidate !== entry.pattern,
                  )
                : settings.page.autoTranslateSitePatterns,
            autoTranslateExcludedSitePatterns:
              entry.kind === "excluded"
                ? settings.page.autoTranslateExcludedSitePatterns.filter(
                    (candidate) => candidate !== entry.pattern,
                  )
                : settings.page.autoTranslateExcludedSitePatterns,
          },
        };
        dirtyControls.mark("auto-translate-site-patterns");
        renderAutoTranslateSites();
      });
      item.append(copy, remove);
      autoTranslateSiteList.append(item);
    }
  };

  const syncForm = (): void => {
    uiLanguage.value = settings.uiLanguage;
    fastProvider.value = settings.provider.fastProvider;
    aiProvider.value = settings.provider.aiProvider;
    baseUrl.value = settings.provider.baseUrl;
    apiKey.value = settings.provider.apiKey;
    googleApiKey.value = settings.provider.googleApiKey;
    microsoftApiKey.value = settings.provider.microsoftApiKey;
    microsoftRegion.value = settings.provider.microsoftRegion;
    deeplApiKey.value = settings.provider.deeplApiKey;
    deeplPlan.value = settings.provider.deeplPlan;
    model.value = settings.provider.model;
    timeout.value = String(Math.round(settings.provider.timeoutMs / 1000));
    systemPrompt.value = settings.provider.systemPrompt;
    pageSourceLanguage.value = settings.page.sourceLanguage;
    pageTargetLanguage.value = settings.page.targetLanguage;
    pageMode.value = translationMethodValue(
      settings.page.mode,
      settings.provider.fastProvider,
    );
    pageResponseMode.value = settings.page.aiResponseMode;
    pageResponseMode.disabled = settings.page.mode !== "ai";
    pageDisplayMode.value = settings.page.displayMode;
    pageAutoTranslate.checked = settings.page.autoTranslate;
    selectionTranslationEnabled.checked =
      settings.page.selectionTranslationEnabled;
    selectionTranslationSourceLanguage.value =
      settings.page.selectionTranslationSourceLanguage;
    selectionTranslationTargetLanguage.value =
      settings.page.selectionTranslationTargetLanguage;
    selectionTranslationMode.value = translationMethodValue(
      settings.page.selectionTranslationMode,
      settings.provider.fastProvider,
    );
    selectionTranslationResponseMode.value =
      settings.page.selectionTranslationAiResponseMode;
    selectionTranslationResponseMode.disabled =
      settings.page.selectionTranslationMode !== "ai";
    selectionTranslationModelOverride.value =
      settings.page.selectionTranslationModelOverride;
    selectionTranslationModelOverride.disabled =
      settings.page.selectionTranslationMode !== "ai";
    selectionTranslationDisplayMode.value =
      settings.page.selectionTranslationDisplayMode;
    floatingControlEnabled.checked =
      settings.page.floatingButtonEnabled ||
      settings.subtitles.floatingButtonEnabled;
    floatingControlEnabled.indeterminate =
      settings.page.floatingButtonEnabled !==
      settings.subtitles.floatingButtonEnabled;
    subtitleEnabled.checked = settings.subtitles.enabled;
    subtitleSourceLanguage.value = settings.subtitles.sourceLanguage;
    subtitleTargetLanguage.value = settings.subtitles.targetLanguage;
    subtitleMode.value = translationMethodValue(
      settings.subtitles.mode,
      settings.provider.fastProvider,
    );
    subtitleResponseMode.value = settings.subtitles.aiResponseMode;
    subtitleResponseMode.disabled = settings.subtitles.mode !== "ai";
    subtitleDisplayMode.value = settings.subtitles.displayMode;
    subtitlePosition.value = settings.subtitles.position;
    subtitleHideNative.checked = settings.subtitles.hideNativeSubtitles;
    subtitleFontScale.value = String(settings.subtitles.fontScale);
    subtitleBackgroundOpacity.value = String(
      settings.subtitles.backgroundOpacity,
    );
    ocrEnabled.checked = settings.ocr.enabled;
    ocrSourceLanguage.value = settings.ocr.sourceLanguage;
    ocrTargetLanguage.value = settings.ocr.targetLanguage;
    ocrProvider.value = settings.ocr.provider;
    imageTranslationEnabled.checked = settings.imageTranslation.enabled;
    imageSourceLanguage.value = settings.imageTranslation.sourceLanguage;
    imageTargetLanguage.value = settings.imageTranslation.targetLanguage;
    imageMode.value = translationMethodValue(
      settings.imageTranslation.mode,
      settings.provider.fastProvider,
    );
    imageDisplayMode.value = settings.imageTranslation.displayMode;
    imageModelOverride.value = settings.imageTranslation.modelOverride;
    imageModelOverride.disabled = settings.imageTranslation.mode !== "ai";
    syncRangeOutputs();
    renderAutoTranslateSites();
    googleProviderFields.hidden =
      settings.provider.fastProvider !== "google-translate";
    microsoftProviderFields.hidden =
      settings.provider.fastProvider !== "microsoft-translator";
    deeplProviderFields.hidden = settings.provider.fastProvider !== "deepl";
    syncLanguageRestrictions();
  };

  const selectedFastProvider = selectedProviderValue;

  const syncFastTranslationMethods = (provider: FastProviderId): void => {
    for (const select of translationMethodSelects) {
      if (parseTranslationMethod(select.value)?.mode === "fast") {
        select.value = translationMethodValue("fast", provider);
      }
    }
  };

  const syncFastProviderFields = (): void => {
    const value = selectedFastProvider();
    syncFastTranslationMethods(value);
    googleProviderFields.hidden = value !== "google-translate";
    microsoftProviderFields.hidden = value !== "microsoft-translator";
    deeplProviderFields.hidden = value !== "deepl";
    syncLanguageRestrictions();
  };

  const syncTranslationMethodDependentControls = (): void => {
    const pageAi = parseTranslationMethod(pageMode.value)?.mode === "ai";
    const selectionAi =
      parseTranslationMethod(selectionTranslationMode.value)?.mode === "ai";
    const subtitleAi =
      parseTranslationMethod(subtitleMode.value)?.mode === "ai";
    const imageAi = parseTranslationMethod(imageMode.value)?.mode === "ai";
    pageResponseMode.disabled = !pageAi;
    selectionTranslationResponseMode.disabled = !selectionAi;
    selectionTranslationModelOverride.disabled = !selectionAi;
    subtitleResponseMode.disabled = !subtitleAi;
    imageModelOverride.disabled = !imageAi;
  };

  const selectedTranslationMode = (
    select: HTMLSelectElement,
    fallback: AppSettings["page"]["mode"],
  ): AppSettings["page"]["mode"] =>
    parseTranslationMethod(select.value)?.mode ?? fallback;

  const readForm = (): AppSettings => ({
    ...settings,
    uiLanguage:
      uiLanguage.value === "en" || uiLanguage.value === "zh-CN"
        ? uiLanguage.value
        : "auto",
    provider: {
      fastProvider: selectedFastProvider(),
      aiProvider:
        aiProvider.value === "anthropic-messages"
          ? "anthropic-messages"
          : "openai-compatible",
      baseUrl: baseUrl.value.trim().replace(/\/$/, ""),
      apiKey: apiKey.value.trim(),
      googleApiKey: googleApiKey.value.trim(),
      microsoftApiKey: microsoftApiKey.value.trim(),
      microsoftRegion: microsoftRegion.value.trim(),
      deeplApiKey: deeplApiKey.value.trim(),
      deeplPlan: deeplPlan.value === "pro" ? "pro" : "free",
      model: model.value.trim(),
      systemPrompt: systemPrompt.value.trim(),
      timeoutMs: Math.round(Number(timeout.value) * 1000),
    },
    page: {
      sourceLanguage: pageSourceLanguage.value,
      targetLanguage: pageTargetLanguage.value,
      mode: selectedTranslationMode(pageMode, settings.page.mode),
      aiResponseMode: pageResponseMode.value === "batch" ? "batch" : "stream",
      displayMode:
        pageDisplayMode.value === "translated" ? "translated" : "bilingual",
      autoTranslate: pageAutoTranslate.checked,
      autoTranslateSitePatterns: settings.page.autoTranslateSitePatterns,
      autoTranslateExcludedSitePatterns:
        settings.page.autoTranslateExcludedSitePatterns,
      floatingButtonEnabled: dirtyControls.has("floating-control-enabled")
        ? floatingControlEnabled.checked
        : settings.page.floatingButtonEnabled,
      selectionTranslationEnabled: selectionTranslationEnabled.checked,
      selectionTranslationSourceLanguage:
        selectionTranslationSourceLanguage.value,
      selectionTranslationTargetLanguage:
        selectionTranslationTargetLanguage.value,
      selectionTranslationMode: selectedTranslationMode(
        selectionTranslationMode,
        settings.page.selectionTranslationMode,
      ),
      selectionTranslationAiResponseMode:
        selectionTranslationResponseMode.value === "batch" ? "batch" : "stream",
      selectionTranslationModelOverride:
        selectionTranslationModelOverride.value.trim(),
      selectionTranslationDisplayMode:
        selectionTranslationDisplayMode.value === "translated"
          ? "translated"
          : "bilingual",
    },
    subtitles: {
      ...settings.subtitles,
      enabled: subtitleEnabled.checked,
      sourceLanguage: subtitleSourceLanguage.value,
      targetLanguage: subtitleTargetLanguage.value,
      mode: selectedTranslationMode(subtitleMode, settings.subtitles.mode),
      aiResponseMode:
        subtitleResponseMode.value === "batch" ? "batch" : "stream",
      displayMode:
        subtitleDisplayMode.value === "original"
          ? "original"
          : subtitleDisplayMode.value === "translated"
            ? "translated"
            : "bilingual",
      position:
        subtitlePosition.value === "top"
          ? "top"
          : subtitlePosition.value === "center"
            ? "center"
            : subtitlePosition.value === "custom"
              ? "custom"
              : "bottom",
      hideNativeSubtitles: subtitleHideNative.checked,
      floatingButtonEnabled: dirtyControls.has("floating-control-enabled")
        ? floatingControlEnabled.checked
        : settings.subtitles.floatingButtonEnabled,
      fontScale: Number(subtitleFontScale.value),
      backgroundOpacity: Number(subtitleBackgroundOpacity.value),
    },
    ocr: {
      enabled: ocrEnabled.checked,
      sourceLanguage: ocrSourceLanguage.value,
      targetLanguage: ocrTargetLanguage.value,
      provider:
        ocrProvider.value === "bergamot-local"
          ? "bergamot-local"
          : "chrome-local",
    },
    imageTranslation: {
      enabled: imageTranslationEnabled.checked,
      sourceLanguage: imageSourceLanguage.value,
      targetLanguage: imageTargetLanguage.value,
      mode: selectedTranslationMode(imageMode, settings.imageTranslation.mode),
      modelOverride: imageModelOverride.value.trim(),
      displayMode:
        imageDisplayMode.value === "bilingual" ? "bilingual" : "translated",
    },
  });

  const persist = async (requestPermission = false): Promise<boolean> => {
    const submittedSettings = readForm();
    const submittedDirtyVersions = dirtyControls.snapshot();
    const languageChanged =
      submittedSettings.uiLanguage !== settings.uiLanguage;
    settings = submittedSettings;
    if (!isAllowedProviderBaseUrl(submittedSettings.provider.baseUrl)) {
      throw new Error("provider-url-invalid");
    }
    if (requestPermission) await requestProviderPermission(submittedSettings);
    const response: unknown = await browser.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: submittedSettings,
    });
    if (!isSuccessfulResponse(response) || !response.ok) {
      throw new Error("settings-save-failed");
    }
    dirtyControls.confirm(submittedDirtyVersions);
    return languageChanged;
  };

  const showFeedback = (
    target: HTMLElement,
    key: string,
    tone: "success" | "error" | "" = "",
  ): void => {
    target.dataset.tone = tone;
    target.textContent = message(key);
  };

  const runtimePackageLabel = (runtime: OcrRuntimeStatus): string => {
    const localizedLabel = message(runtime.labelKey);
    return localizedLabel || runtime.pack;
  };

  const runtimeLanguageLabel = (language: OcrRuntimeLanguage): string => {
    const languageCodes: Record<string, string> = {
      eng: "en",
      chi_sim: "zh-CN",
      chi_tra: "zh-TW",
      jpn: "ja",
      kor: "ko",
      spa: "es",
      fra: "fr",
      deu: "de",
    };
    const runtimeLanguage = getOcrRuntimeLanguage(language);
    const localizedLabel = message(runtimeLanguage.labelKey);
    if (localizedLabel) return localizedLabel;
    const languageCode = languageCodes[language];
    return languageCode
      ? displayLanguageName(languageCode, currentUiLocale())
      : language;
  };

  const runtimeLanguagesLabel = (runtime: OcrRuntimeStatus): string => {
    const languages = runtime.languages.map(runtimeLanguageLabel);
    return new Intl.ListFormat(currentUiLocale(), {
      style: "long",
      type: "conjunction",
    }).format(languages);
  };

  const runtimeProgress = (runtime: OcrRuntimeStatus): number => {
    const progress = runtime.progress ?? 0;
    return Math.round(
      Math.min(100, Math.max(0, progress <= 1 ? progress * 100 : progress)),
    );
  };

  const formatRuntimeSize = (bytes: number): string => {
    const locale = currentUiLocale();
    if (bytes < 1024) {
      return new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "byte",
        unitDisplay: "short",
        maximumFractionDigits: 0,
      }).format(bytes);
    }
    if (bytes < 1024 * 1024) {
      return new Intl.NumberFormat(locale, {
        style: "unit",
        unit: "kilobyte",
        unitDisplay: "short",
        maximumFractionDigits: 1,
      }).format(bytes / 1024);
    }
    return new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "megabyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    }).format(bytes / (1024 * 1024));
  };

  const stopOcrRuntimePolling = (): void => {
    if (ocrRuntimePollTimer !== undefined) {
      window.clearTimeout(ocrRuntimePollTimer);
      ocrRuntimePollTimer = undefined;
    }
  };

  const scheduleOcrRuntimePolling = (): void => {
    stopOcrRuntimePolling();
    if (!ocrRuntimes.some((runtime) => runtime.state === "downloading")) return;
    ocrRuntimePollTimer = window.setTimeout(() => {
      ocrRuntimePollTimer = undefined;
      void loadOcrRuntimes(false).finally(scheduleOcrRuntimePolling);
    }, 750);
  };

  const syncImageRuntimeWarning = (): void => {
    imageRuntimeWarning.hidden =
      !ocrRuntimeListLoaded ||
      ocrRuntimes.some((runtime) => runtime.state === "installed");
  };

  const renderOcrRuntimes = (): void => {
    syncImageRuntimeWarning();
    const focusedRuntimeControl =
      document.activeElement instanceof HTMLElement &&
      ocrRuntimeList.contains(document.activeElement) &&
      (document.activeElement.matches("button[data-runtime-pack]") ||
        document.activeElement.matches(".runtime-action[data-runtime-pack]"))
        ? document.activeElement
        : undefined;
    if (focusedRuntimeControl) {
      ocrRuntimeFocus = {
        pack: focusedRuntimeControl.dataset.runtimePack,
        action: focusedRuntimeControl.dataset.runtimeAction,
      };
    } else if (
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      !ocrRuntimeList.contains(document.activeElement)
    ) {
      ocrRuntimeFocus = undefined;
    }
    const activeRuntimeAction = ocrRuntimeFocus;
    ocrRuntimeLoading.hidden = true;
    ocrRuntimeList.replaceChildren();
    ocrRuntimeList.setAttribute("aria-busy", "false");
    ocrRuntimeList.hidden = ocrRuntimes.length === 0;
    ocrRuntimeEmpty.hidden = ocrRuntimes.length > 0;
    ocrRuntimeDownloadAll.disabled =
      ocrRuntimeCommandPending ||
      !ocrRuntimes.some(
        (runtime) => runtime.state === "missing" || runtime.state === "error",
      );

    for (const runtime of ocrRuntimes) {
      const packBytes = getOcrRuntimePack(runtime.pack).reduce(
        (sum, artifact) => sum + artifact.bytes,
        0,
      );
      const groupItem = document.createElement("li");
      groupItem.className = "runtime-group";
      const groupHeading = document.createElement("div");
      groupHeading.className = "runtime-group-heading";
      const groupName = document.createElement("strong");
      groupName.textContent = runtimePackageLabel(runtime);
      const groupSummary = document.createElement("span");
      groupSummary.textContent = message("ocrRuntimeGroupSummary", [
        String(runtime.languages.length),
        formatRuntimeSize(packBytes),
      ]);
      groupHeading.append(groupName, groupSummary);

      const groupList = document.createElement("ul");
      groupList.className = "runtime-group-list";
      const item = document.createElement("li");
      item.className = "runtime-item";

      const identity = document.createElement("div");
      identity.className = "runtime-identity";
      const name = document.createElement("strong");
      name.textContent = message(
        "ocrRuntimeSupportedLanguages",
        runtimeLanguagesLabel(runtime),
      );
      identity.append(name);

      const status = document.createElement("div");
      status.className = "runtime-status";
      const badge = document.createElement("span");
      badge.className = "runtime-status-badge";
      badge.dataset.state = runtime.state;
      if (runtime.state === "downloading") {
        const percent = runtimeProgress(runtime);
        badge.textContent = message(
          "ocrRuntimeStateDownloading",
          String(percent),
        );
        const progress = document.createElement("progress");
        progress.max = 100;
        progress.value = percent;
        progress.setAttribute(
          "aria-label",
          message("ocrRuntimeProgressLabel", [
            runtimePackageLabel(runtime),
            String(percent),
          ]),
        );
        status.append(badge, progress);
      } else if (runtime.state === "installed") {
        badge.textContent = message("ocrRuntimeStateEnabled");
        status.append(badge);
      } else if (runtime.state === "error") {
        badge.textContent = message("ocrRuntimeStateError");
        const detailText = runtime.message
          ? message(
              runtime.message === "OCR runtime download timed out."
                ? "ocrRuntimeDownloadTimedOut"
                : "ocrRuntimeDownloadFailed",
            )
          : "";
        if (detailText) {
          const detail = document.createElement("small");
          detail.textContent = detailText;
          status.append(badge, detail);
        } else {
          status.append(badge);
        }
      } else {
        badge.textContent = message("ocrRuntimeStateMissing");
        status.append(badge);
      }

      const action = document.createElement("div");
      action.className = "runtime-action";
      action.tabIndex = -1;
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.runtimePack = runtime.pack;
      button.disabled =
        ocrRuntimeCommandPending || runtime.state === "downloading";
      if (runtime.state === "installed") {
        button.dataset.runtimeAction = "delete";
        button.className = "button button-danger-quiet";
        button.textContent = message("ocrRuntimeDelete");
        button.setAttribute(
          "aria-label",
          message("ocrRuntimeDeleteLabel", runtimePackageLabel(runtime)),
        );
        button.addEventListener("click", () => deleteOcrRuntime(runtime));
      } else {
        button.dataset.runtimeAction = "download";
        button.className = "button button-secondary";
        button.textContent =
          runtime.state === "downloading"
            ? message("ocrRuntimeDownloading")
            : message("ocrRuntimeDownload");
        button.setAttribute(
          "aria-label",
          message("ocrRuntimeDownloadLabel", runtimePackageLabel(runtime)),
        );
        button.addEventListener("click", () => {
          void downloadOcrRuntime(runtime);
        });
      }
      action.dataset.runtimePack = runtime.pack;
      action.dataset.runtimeAction = button.dataset.runtimeAction;
      action.setAttribute("role", "group");
      action.setAttribute(
        "aria-label",
        button.getAttribute("aria-label") ?? button.textContent ?? "",
      );
      action.append(button);
      item.append(identity, status, action);
      groupList.append(item);
      groupItem.append(groupHeading, groupList);
      ocrRuntimeList.append(groupItem);
    }
    if (activeRuntimeAction?.pack) {
      const runtimeButtons = Array.from(
        ocrRuntimeList.querySelectorAll<HTMLButtonElement>(
          "button[data-runtime-pack]",
        ),
      );
      const runtimeActions = Array.from(
        ocrRuntimeList.querySelectorAll<HTMLElement>(
          ".runtime-action[data-runtime-pack]",
        ),
      );
      const focusTarget =
        runtimeButtons.find(
          (button) =>
            !button.disabled &&
            button.dataset.runtimePack === activeRuntimeAction.pack &&
            button.dataset.runtimeAction === activeRuntimeAction.action,
        ) ??
        runtimeActions.find(
          (action) =>
            action.dataset.runtimePack === activeRuntimeAction.pack &&
            action.dataset.runtimeAction === activeRuntimeAction.action,
        ) ??
        runtimeButtons.find(
          (button) =>
            !button.disabled &&
            button.dataset.runtimePack === activeRuntimeAction.pack,
        ) ??
        runtimeActions.find(
          (action) => action.dataset.runtimePack === activeRuntimeAction.pack,
        );
      focusTarget?.focus({ preventScroll: true });
    }
  };

  async function loadOcrRuntimes(showLoading: boolean): Promise<void> {
    if (ocrRuntimeListRequest) return ocrRuntimeListRequest;
    ocrRuntimeListRequest = (async () => {
      if (showLoading) {
        ocrRuntimeLoading.hidden = false;
        ocrRuntimeEmpty.hidden = true;
        ocrRuntimeList.hidden = true;
        ocrRuntimeList.setAttribute("aria-busy", "true");
      }
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: "OCR_RUNTIME_LIST",
        });
        if (!isOcrRuntimeListResponse(response)) {
          throw new Error("ocr-runtime-list-failed");
        }
        ocrRuntimes = response.runtimes;
        ocrRuntimeListLoaded = true;
        renderOcrRuntimes();
        if (ocrRuntimeMessage.dataset.tone === "error") {
          ocrRuntimeMessage.textContent = "";
          ocrRuntimeMessage.dataset.tone = "";
        }
      } catch {
        if (ocrRuntimes.length === 0) {
          renderOcrRuntimes();
          ocrRuntimeEmpty.hidden = true;
        }
        showFeedback(ocrRuntimeMessage, "ocrRuntimesLoadFailed", "error");
      }
    })().finally(() => {
      ocrRuntimeListRequest = undefined;
    });
    return ocrRuntimeListRequest;
  }

  async function downloadOcrRuntime(runtime: OcrRuntimeStatus): Promise<void> {
    if (ocrRuntimeCommandPending) return;
    ocrRuntimeCommandPending = true;
    renderOcrRuntimes();
    const granted = await requestOcrRuntimeDownloadPermission();
    if (!granted) {
      ocrRuntimeCommandPending = false;
      renderOcrRuntimes();
      showFeedback(ocrRuntimeMessage, "ocrRuntimePermissionDenied", "error");
      return;
    }
    ocrRuntimes = ocrRuntimes.map((candidate) =>
      candidate.pack === runtime.pack
        ? { ...candidate, state: "downloading", progress: 0 }
        : candidate,
    );
    renderOcrRuntimes();
    scheduleOcrRuntimePolling();
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "OCR_RUNTIME_DOWNLOAD",
        pack: runtime.pack,
      });
      if (!isSuccessfulResponse(response)) {
        throw new Error("ocr-runtime-download-failed");
      }
      await loadOcrRuntimes(false);
    } catch {
      showFeedback(ocrRuntimeMessage, "ocrRuntimeDownloadFailed", "error");
    } finally {
      ocrRuntimeCommandPending = false;
      renderOcrRuntimes();
      scheduleOcrRuntimePolling();
    }
  }

  async function downloadAllOcrRuntimes(): Promise<void> {
    if (ocrRuntimeCommandPending) return;
    ocrRuntimeCommandPending = true;
    renderOcrRuntimes();
    const granted = await requestOcrRuntimeDownloadPermission();
    if (!granted) {
      ocrRuntimeCommandPending = false;
      renderOcrRuntimes();
      showFeedback(ocrRuntimeMessage, "ocrRuntimePermissionDenied", "error");
      return;
    }
    ocrRuntimes = ocrRuntimes.map((runtime) =>
      runtime.state === "missing" || runtime.state === "error"
        ? { ...runtime, state: "downloading", progress: 0 }
        : runtime,
    );
    renderOcrRuntimes();
    scheduleOcrRuntimePolling();
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "OCR_RUNTIME_DOWNLOAD_ALL",
      });
      if (!isSuccessfulResponse(response)) {
        throw new Error("ocr-runtime-download-all-failed");
      }
      await loadOcrRuntimes(false);
    } catch {
      showFeedback(ocrRuntimeMessage, "ocrRuntimeDownloadAllFailed", "error");
    } finally {
      ocrRuntimeCommandPending = false;
      renderOcrRuntimes();
      scheduleOcrRuntimePolling();
    }
  }

  function deleteOcrRuntime(runtime: OcrRuntimeStatus): void {
    if (
      ocrRuntimeCommandPending ||
      !confirm(message("ocrRuntimeDeleteConfirm", runtimePackageLabel(runtime)))
    ) {
      return;
    }
    void (async () => {
      ocrRuntimeCommandPending = true;
      renderOcrRuntimes();
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: "OCR_RUNTIME_DELETE",
          pack: runtime.pack,
        });
        if (!isSuccessfulResponse(response)) {
          throw new Error("ocr-runtime-delete-failed");
        }
        await loadOcrRuntimes(false);
        showFeedback(ocrRuntimeMessage, "ocrRuntimeDeleted", "success");
      } catch {
        showFeedback(ocrRuntimeMessage, "ocrRuntimeDeleteFailed", "error");
      } finally {
        ocrRuntimeCommandPending = false;
        renderOcrRuntimes();
      }
    })();
  }

  ocrRuntimeDownloadAll.addEventListener("click", () => {
    void downloadAllOcrRuntimes();
  });

  const localTranslationLanguageLabel = (language: string): string => {
    if (language === "zh-Hant") {
      return message("localTranslationLanguageTaiwan");
    }
    const displayCode = language === "zh-Hans" ? "zh-CN" : language;
    return displayLanguageName(displayCode, currentUiLocale());
  };

  interface LocalTranslationRuntimePair {
    language: string;
    runtimes: LocalTranslationRuntimeInfo[];
    state: LocalTranslationRuntimeInfo["state"];
    bytes: number;
    version?: string;
  }

  const localTranslationRuntimePairs = (): LocalTranslationRuntimePair[] => {
    const grouped = new Map<string, LocalTranslationRuntimeInfo[]>();
    for (const runtime of localTranslationRuntimes) {
      const language =
        runtime.sourceLanguage === "en"
          ? runtime.targetLanguage
          : runtime.sourceLanguage;
      const runtimes = grouped.get(language) ?? [];
      runtimes.push(runtime);
      grouped.set(language, runtimes);
    }
    return [...grouped].map(([language, runtimes]) => {
      const versions = [
        ...new Set(
          runtimes.flatMap((runtime) =>
            runtime.version ? [runtime.version] : [],
          ),
        ),
      ];
      const state = runtimes.some((runtime) => runtime.state === "downloading")
        ? "downloading"
        : runtimes.length === 2 &&
            runtimes.every((runtime) => runtime.state === "installed")
          ? "installed"
          : runtimes.some((runtime) => runtime.state === "error")
            ? "error"
            : "missing";
      return {
        language,
        runtimes,
        state,
        bytes: runtimes.reduce(
          (total, runtime) => total + (runtime.bytes ?? 0),
          0,
        ),
        ...(versions.length === 1 ? { version: versions[0] } : {}),
      };
    });
  };

  const renderLocalTranslationRuntimes = (): void => {
    localTranslationRuntimeLoading.hidden = true;
    localTranslationRuntimeList.replaceChildren();
    localTranslationRuntimeList.setAttribute("aria-busy", "false");
    const pairs = localTranslationRuntimePairs();
    localTranslationRuntimeList.hidden = pairs.length === 0;
    localTranslationRuntimeEmpty.hidden = pairs.length > 0;
    for (const pair of pairs) {
      const item = document.createElement("li");
      item.className = "runtime-item";
      const identity = document.createElement("div");
      identity.className = "runtime-identity local-runtime-identity";
      const name = document.createElement("strong");
      name.textContent = message("localTranslationPairValue", [
        localTranslationLanguageLabel(pair.language),
        localTranslationLanguageLabel("en"),
      ]);
      identity.append(name);
      if (pair.bytes > 0) {
        const size = document.createElement("small");
        size.textContent = formatRuntimeSize(pair.bytes);
        identity.append(size);
      }

      const status = document.createElement("div");
      status.className = "runtime-status";
      const badge = document.createElement("span");
      badge.className = "runtime-status-badge";
      badge.dataset.state = pair.state;
      badge.textContent = message(
        pair.state === "installed"
          ? "localTranslationRuntimeInstalled"
          : pair.state === "downloading"
            ? "localTranslationRuntimeDownloading"
            : pair.state === "error"
              ? "localTranslationRuntimeError"
              : "localTranslationRuntimeMissing",
      );
      status.append(badge);
      const activeProgress = localTranslationDownloadProgress;
      const progressRuntimes = activeProgress
        ? pair.runtimes.filter((runtime) =>
            activeProgress.packIds.has(runtime.packId),
          )
        : [];
      const progressTotalBytes = progressRuntimes.reduce(
        (total, runtime) => total + (runtime.downloadBytes ?? 0),
        0,
      );
      const progressReceivedBytes = progressRuntimes.reduce(
        (total, runtime) => {
          if (activeProgress?.completedPackIds.has(runtime.packId)) {
            return total + (runtime.downloadBytes ?? 0);
          }
          return (
            total +
            (runtime.state === "downloading"
              ? Math.min(runtime.bytes ?? 0, runtime.downloadBytes ?? 0)
              : 0)
          );
        },
        0,
      );
      if (pair.state === "downloading" && progressTotalBytes > 0) {
        const progress = document.createElement("progress");
        progress.max = progressTotalBytes;
        progress.value = progressReceivedBytes;
        progress.setAttribute(
          "aria-label",
          message("localTranslationRuntimeDownloadProgress", [
            String(
              Math.min(
                100,
                Math.round((progressReceivedBytes / progressTotalBytes) * 100),
              ),
            ),
            formatRuntimeSize(progressReceivedBytes),
            formatRuntimeSize(progressTotalBytes),
          ]),
        );
        const progressCopy = document.createElement("small");
        progressCopy.className = "runtime-progress-copy";
        progressCopy.textContent = progress.getAttribute("aria-label");
        status.append(progress, progressCopy);
      }
      if (pair.version) {
        const version = document.createElement("small");
        version.textContent = pair.version;
        status.append(version);
      }

      const action = document.createElement("div");
      action.className = "runtime-action";
      const button = document.createElement("button");
      button.type = "button";
      button.disabled =
        localTranslationRuntimeCommandPending || pair.state === "downloading";
      if (pair.state === "installed") {
        button.className = "button button-danger-quiet";
        button.textContent = message("ocrRuntimeDelete");
        button.addEventListener("click", () => {
          void deleteLocalTranslationRuntimePair(pair);
        });
      } else {
        button.className = "button button-secondary";
        button.textContent = message("ocrRuntimeDownload");
        button.addEventListener("click", () => {
          void downloadLocalTranslationRuntimePair(pair);
        });
      }
      action.append(button);
      item.append(identity, status, action);
      localTranslationRuntimeList.append(item);
    }
  };

  async function loadLocalTranslationRuntimes(
    showLoading: boolean,
  ): Promise<void> {
    if (showLoading) {
      localTranslationRuntimeLoading.hidden = false;
      localTranslationRuntimeEmpty.hidden = true;
      localTranslationRuntimeList.hidden = true;
      localTranslationRuntimeList.setAttribute("aria-busy", "true");
    }
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "LOCAL_TRANSLATION_RUNTIME_LIST",
      });
      if (!isLocalTranslationRuntimeListResponse(response)) {
        throw new Error("local-translation-runtime-list-failed");
      }
      localTranslationRuntimes = response.runtimes;
      localTranslationRuntimeLoaded = true;
      renderLocalTranslationRuntimes();
      syncLanguageRestrictions();
      localTranslationRuntimeMessage.textContent = "";
      localTranslationRuntimeMessage.dataset.tone = "";
    } catch {
      renderLocalTranslationRuntimes();
      showFeedback(
        localTranslationRuntimeMessage,
        "localTranslationRuntimesLoadFailed",
        "error",
      );
    }
  }

  async function downloadLocalTranslationRuntimePair(
    pair: LocalTranslationRuntimePair,
  ): Promise<void> {
    if (localTranslationRuntimeCommandPending) return;
    const granted = await requestLocalTranslationRuntimePermission();
    if (!granted) {
      showFeedback(
        localTranslationRuntimeMessage,
        "localTranslationRuntimePermissionDenied",
        "error",
      );
      return;
    }
    localTranslationRuntimeCommandPending = true;
    const packIds = new Set(
      pair.runtimes
        .filter((runtime) => runtime.state !== "installed")
        .map((runtime) => runtime.packId),
    );
    localTranslationDownloadProgress = {
      packIds,
      completedPackIds: new Set(),
    };
    localTranslationRuntimes = localTranslationRuntimes.map((candidate) =>
      packIds.has(candidate.packId)
        ? { ...candidate, state: "downloading" }
        : candidate,
    );
    renderLocalTranslationRuntimes();
    const stopPolling = (): void => {
      if (localTranslationRuntimePollTimer !== undefined) {
        window.clearTimeout(localTranslationRuntimePollTimer);
        localTranslationRuntimePollTimer = undefined;
      }
    };
    const schedulePolling = (): void => {
      stopPolling();
      if (!localTranslationRuntimeCommandPending) return;
      localTranslationRuntimePollTimer = window.setTimeout(() => {
        localTranslationRuntimePollTimer = undefined;
        void loadLocalTranslationRuntimes(false).finally(schedulePolling);
      }, 200);
    };
    schedulePolling();
    try {
      let failure: unknown;
      for (const runtime of pair.runtimes) {
        if (!packIds.has(runtime.packId)) continue;
        localTranslationRuntimes = localTranslationRuntimes.map((candidate) =>
          candidate.packId === runtime.packId
            ? { ...candidate, state: "downloading" }
            : candidate,
        );
        renderLocalTranslationRuntimes();
        try {
          const response: unknown = await browser.runtime.sendMessage({
            type: "LOCAL_TRANSLATION_RUNTIME_DOWNLOAD",
            packId: runtime.packId,
          });
          if (!isSuccessfulResponse(response) && failure === undefined) {
            failure = response;
          } else if (isSuccessfulResponse(response)) {
            localTranslationDownloadProgress?.completedPackIds.add(
              runtime.packId,
            );
            renderLocalTranslationRuntimes();
          }
        } catch (error) {
          if (failure === undefined) failure = error;
        }
      }
      stopPolling();
      await loadLocalTranslationRuntimes(false);
      if (failure !== undefined) {
        showFeedback(
          localTranslationRuntimeMessage,
          localTranslationRuntimeFailureMessage(failure),
          "error",
        );
      }
    } finally {
      stopPolling();
      localTranslationRuntimeCommandPending = false;
      localTranslationDownloadProgress = undefined;
      renderLocalTranslationRuntimes();
    }
  }

  async function deleteLocalTranslationRuntimePair(
    pair: LocalTranslationRuntimePair,
  ): Promise<void> {
    if (
      localTranslationRuntimeCommandPending ||
      !confirm(
        message("localTranslationRuntimeDeleteConfirm", [
          localTranslationLanguageLabel(pair.language),
          localTranslationLanguageLabel("en"),
        ]),
      )
    ) {
      return;
    }
    localTranslationRuntimeCommandPending = true;
    renderLocalTranslationRuntimes();
    try {
      for (const runtime of pair.runtimes) {
        const response: unknown = await browser.runtime.sendMessage({
          type: "LOCAL_TRANSLATION_RUNTIME_DELETE",
          packId: runtime.packId,
        });
        if (!isSuccessfulResponse(response)) {
          throw new Error("local-translation-runtime-delete-failed");
        }
      }
      await loadLocalTranslationRuntimes(false);
      showFeedback(
        localTranslationRuntimeMessage,
        "localTranslationRuntimeDeleted",
        "success",
      );
    } catch {
      showFeedback(
        localTranslationRuntimeMessage,
        "localTranslationRuntimeDeleteFailed",
        "error",
      );
    } finally {
      localTranslationRuntimeCommandPending = false;
      renderLocalTranslationRuntimes();
    }
  }

  type ProfileEditorKind = "builtin" | "override" | "user" | "site" | "new";
  let activeProfileId = "";
  let editorSnapshot = "";
  const profileCatalogExpanded = { builtin: true, user: true };
  let activeProfileMatch: SiteTranslationProfile["match"] = structuredClone(
    MINIMAL_USER_SITE_PROFILE_TEMPLATE.match,
  );
  let syncingProfileEditor = false;

  const normalizedProfileJson = (profile: SiteProfileDocument): string =>
    JSON.stringify(profile, null, 2);

  const splitProfileLines = (value: string): string[] =>
    value
      .split(/\r?\n/gu)
      .map((item) => item.trim())
      .filter(Boolean);

  const captureControls = [
    profileCaptureParser,
    profileCapturePriority,
    profileCaptureFormats,
    profileCaptureVideoSelector,
    profileCaptureCaptionSelectors,
    profileCaptureNativeSelectors,
    profileCaptureHostnames,
    profileCaptureUrlPatterns,
    profileCaptureCompletePatterns,
  ] as const;

  const fallbackSurfaceValues = (
    surface: "page" | "selection" | "subtitles",
  ):
    | SitePageTranslationOverride
    | SiteSelectionTranslationOverride
    | SiteSubtitleTranslationOverride => {
    if (surface === "selection") {
      return {
        sourceLanguage: settings.page.selectionTranslationSourceLanguage,
        targetLanguage: settings.page.selectionTranslationTargetLanguage,
        mode: settings.page.selectionTranslationMode,
        fastProvider: settings.provider.fastProvider,
        modelOverride: settings.page.selectionTranslationModelOverride,
        enabled: settings.page.selectionTranslationEnabled,
        aiResponseMode: settings.page.selectionTranslationAiResponseMode,
        displayMode: settings.page.selectionTranslationDisplayMode,
      };
    }
    if (surface === "page") {
      return {
        sourceLanguage: settings.page.sourceLanguage,
        targetLanguage: settings.page.targetLanguage,
        mode: settings.page.mode,
        fastProvider: settings.provider.fastProvider,
        modelOverride: "",
        aiResponseMode: settings.page.aiResponseMode,
        displayMode: settings.page.displayMode,
        autoTranslate: settings.page.autoTranslate,
        floatingButtonEnabled: settings.page.floatingButtonEnabled,
      };
    }
    return {
      sourceLanguage: settings.subtitles.sourceLanguage,
      targetLanguage: settings.subtitles.targetLanguage,
      mode: settings.subtitles.mode,
      fastProvider: settings.provider.fastProvider,
      modelOverride: "",
      enabled: settings.subtitles.enabled,
      floatingButtonEnabled: settings.subtitles.floatingButtonEnabled,
      aiResponseMode: settings.subtitles.aiResponseMode,
      displayMode: settings.subtitles.displayMode,
      hideNativeSubtitles: settings.subtitles.hideNativeSubtitles,
      position: settings.subtitles.position,
      customPosition: structuredClone(settings.subtitles.customPosition),
      fontScale: settings.subtitles.fontScale,
      backgroundOpacity: settings.subtitles.backgroundOpacity,
    };
  };

  const surfaceControls = {
    page: {
      toggle: profilePageOverride,
      source: profilePageSourceLanguage,
      target: profilePageTargetLanguage,
      method: profilePageMethod,
      model: profilePageModel,
    },
    selection: {
      toggle: profileSelectionOverride,
      source: profileSelectionSourceLanguage,
      target: profileSelectionTargetLanguage,
      method: profileSelectionMethod,
      model: profileSelectionModel,
    },
    subtitles: {
      toggle: profileSubtitleOverride,
      source: profileSubtitleSourceLanguage,
      target: profileSubtitleTargetLanguage,
      method: profileSubtitleMethod,
      model: profileSubtitleModel,
    },
  } as const;

  const surfaceAdditionalControls = {
    page: [
      profilePageResponseMode,
      profilePageDisplayMode,
      profilePageAutoTranslate,
      profilePageFloatingButton,
    ],
    selection: [
      profileSelectionResponseMode,
      profileSelectionDisplayMode,
      profileSelectionEnabled,
    ],
    subtitles: [
      profileSubtitleResponseMode,
      profileSubtitleDisplayMode,
      profileSubtitlePosition,
      profileSubtitleFontScale,
      profileSubtitleBackgroundOpacity,
      profileSubtitleCustomX,
      profileSubtitleCustomY,
      profileSubtitleEnabled,
      profileSubtitleFloatingButton,
      profileSubtitleHideNative,
    ],
  } as const;

  const syncProfileSurface = (
    surface: keyof typeof surfaceControls,
    override: SiteTranslationProfile["overrides"][typeof surface],
  ): void => {
    const controls = surfaceControls[surface];
    const value = override ?? fallbackSurfaceValues(surface);
    controls.toggle.checked = Boolean(override);
    controls.source.value = value.sourceLanguage;
    controls.target.value = value.targetLanguage;
    controls.method.value = translationMethodValue(
      value.mode,
      value.fastProvider,
    );
    controls.model.value = value.modelOverride;
    const enabled = Boolean(override);
    controls.source.disabled = !enabled;
    controls.target.disabled = !enabled;
    controls.method.disabled = !enabled;
    controls.model.disabled = !enabled || value.mode !== "ai";
    if (surface === "page") {
      const pageValue = value as SitePageTranslationOverride;
      profilePageResponseMode.value = pageValue.aiResponseMode ?? "stream";
      profilePageDisplayMode.value = pageValue.displayMode ?? "translated";
      profilePageAutoTranslate.checked = pageValue.autoTranslate ?? false;
      profilePageFloatingButton.checked =
        pageValue.floatingButtonEnabled ?? true;
      for (const control of [
        profilePageResponseMode,
        profilePageDisplayMode,
        profilePageAutoTranslate,
        profilePageFloatingButton,
      ]) {
        control.disabled = !enabled;
      }
      profilePageResponseMode.disabled = !enabled || value.mode !== "ai";
    } else if (surface === "selection") {
      const selectionValue = value as SiteSelectionTranslationOverride;
      profileSelectionResponseMode.value =
        selectionValue.aiResponseMode ?? "stream";
      profileSelectionDisplayMode.value =
        selectionValue.displayMode ?? "bilingual";
      profileSelectionEnabled.checked = selectionValue.enabled ?? true;
      for (const control of [
        profileSelectionResponseMode,
        profileSelectionDisplayMode,
        profileSelectionEnabled,
      ]) {
        control.disabled = !enabled;
      }
      profileSelectionResponseMode.disabled = !enabled || value.mode !== "ai";
    } else {
      const subtitleValue = value as SiteSubtitleTranslationOverride;
      profileSubtitleResponseMode.value =
        subtitleValue.aiResponseMode ?? "stream";
      profileSubtitleDisplayMode.value =
        subtitleValue.displayMode ?? "bilingual";
      profileSubtitlePosition.value = subtitleValue.position ?? "bottom";
      profileSubtitleFontScale.value = String(subtitleValue.fontScale ?? 1.2);
      profileSubtitleBackgroundOpacity.value = String(
        subtitleValue.backgroundOpacity ?? 0.5,
      );
      profileSubtitleCustomX.value = String(
        subtitleValue.customPosition?.x ?? 0.5,
      );
      profileSubtitleCustomY.value = String(
        subtitleValue.customPosition?.y ?? 0.82,
      );
      profileSubtitleEnabled.checked = subtitleValue.enabled ?? true;
      profileSubtitleFloatingButton.checked =
        subtitleValue.floatingButtonEnabled ?? true;
      profileSubtitleHideNative.checked =
        subtitleValue.hideNativeSubtitles ?? false;
      for (const control of [
        profileSubtitleResponseMode,
        profileSubtitleDisplayMode,
        profileSubtitlePosition,
        profileSubtitleFontScale,
        profileSubtitleBackgroundOpacity,
        profileSubtitleEnabled,
        profileSubtitleFloatingButton,
        profileSubtitleHideNative,
      ]) {
        control.disabled = !enabled;
      }
      profileSubtitleResponseMode.disabled = !enabled || value.mode !== "ai";
      const customPositionEnabled =
        enabled && profileSubtitlePosition.value === "custom";
      profileSubtitleCustomX.disabled = !customPositionEnabled;
      profileSubtitleCustomY.disabled = !customPositionEnabled;
    }
    controls.toggle
      .closest<HTMLElement>(".profile-surface-card")
      ?.toggleAttribute("data-overridden", enabled);
  };

  const currentTranslationProfile = (): SiteTranslationProfile | undefined =>
    translationProfiles.find((profile) => profile.id === activeProfileId);

  const translationProfileId = (hostname: string): string => {
    if (activeProfileId) return activeProfileId;
    const base = hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 56);
    return `user-${base || "custom"}`;
  };

  const buildSurfaceOverride = (
    surface: keyof typeof surfaceControls,
  ): SiteTranslationProfile["overrides"][typeof surface] => {
    const controls = surfaceControls[surface];
    if (!controls.toggle.checked) return undefined;
    const method = parseTranslationMethod(controls.method.value);
    if (!method) throw new Error("invalid-translation-method");
    const base: SiteSurfaceTranslationOverride = {
      sourceLanguage: controls.source.value,
      targetLanguage: controls.target.value,
      mode: method.mode,
      fastProvider:
        method.mode === "fast"
          ? (method.fastProvider ?? settings.provider.fastProvider)
          : settings.provider.fastProvider,
      modelOverride: controls.model.value.trim(),
    };
    if (surface === "page") {
      return {
        ...base,
        aiResponseMode: profilePageResponseMode.value as "stream" | "batch",
        displayMode: profilePageDisplayMode.value as "translated" | "bilingual",
        autoTranslate: profilePageAutoTranslate.checked,
        floatingButtonEnabled: profilePageFloatingButton.checked,
      };
    }
    if (surface === "selection") {
      return {
        ...base,
        enabled: profileSelectionEnabled.checked,
        aiResponseMode: profileSelectionResponseMode.value as
          "stream" | "batch",
        displayMode: profileSelectionDisplayMode.value as
          "translated" | "bilingual",
      };
    }
    return {
      ...base,
      enabled: profileSubtitleEnabled.checked,
      floatingButtonEnabled: profileSubtitleFloatingButton.checked,
      aiResponseMode: profileSubtitleResponseMode.value as "stream" | "batch",
      displayMode: profileSubtitleDisplayMode.value as
        "translated" | "bilingual" | "original",
      hideNativeSubtitles: profileSubtitleHideNative.checked,
      position: profileSubtitlePosition.value as
        "top" | "center" | "bottom" | "custom",
      customPosition: {
        x: Number(profileSubtitleCustomX.value),
        y: Number(profileSubtitleCustomY.value),
      },
      fontScale: Number(profileSubtitleFontScale.value),
      backgroundOpacity: Number(profileSubtitleBackgroundOpacity.value),
    };
  };

  const buildTranslationProfile = (): SiteTranslationProfile => {
    const hostname = profileHostname.value
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/gu, "");
    const page = buildSurfaceOverride("page") as
      SitePageTranslationOverride | undefined;
    const selection = buildSurfaceOverride("selection") as
      SiteSelectionTranslationOverride | undefined;
    const subtitles = buildSurfaceOverride("subtitles") as
      SiteSubtitleTranslationOverride | undefined;
    const originalHostname = activeProfileMatch.hostnameSuffixes[0] ?? "";
    const match =
      hostname === originalHostname
        ? structuredClone(activeProfileMatch)
        : { hostnameSuffixes: [hostname] };
    return {
      id: translationProfileId(hostname),
      version: 1,
      name: profileName.value.trim(),
      match,
      overrides: {
        ...(page ? { page } : {}),
        ...(selection ? { selection } : {}),
        ...(subtitles ? { subtitles } : {}),
      },
    };
  };

  const buildCaptureProfile = (
    translation: SiteTranslationProfile,
  ): SubtitleSiteProfile => {
    const formats = Array.from(profileCaptureFormats.selectedOptions).map(
      (option) => option.value,
    ) as SubtitleSiteProfile["capture"]["formats"];
    const completeFilePatterns = splitProfileLines(
      profileCaptureCompletePatterns.value,
    );
    return {
      id: translation.id,
      version: 1,
      name: translation.name,
      parser: profileCaptureParser.value as SubtitleSiteProfile["parser"],
      priority: Number(profileCapturePriority.value),
      match: structuredClone(translation.match),
      selectors: {
        video: profileCaptureVideoSelector.value.trim(),
        captions: splitProfileLines(profileCaptureCaptionSelectors.value),
        nativeCaptions: splitProfileLines(profileCaptureNativeSelectors.value),
      },
      capture: {
        formats,
        allowedHostnameSuffixes: splitProfileLines(
          profileCaptureHostnames.value,
        ),
        urlPatterns: splitProfileLines(profileCaptureUrlPatterns.value),
        ...(completeFilePatterns.length > 0 ? { completeFilePatterns } : {}),
      },
    };
  };

  const buildProfileDocument = (): SiteProfileDocument => {
    const translation = buildTranslationProfile();
    return createSiteProfileDocument(
      translation,
      buildCaptureProfile(translation),
      profileCaptureOverride.checked,
    );
  };

  const syncTranslationEditor = (profile: SubtitleSiteProfile): void => {
    const translationProfile = currentTranslationProfile();
    profileName.value = translationProfile?.name ?? profile.name;
    profileHostname.value =
      translationProfile?.match.hostnameSuffixes[0] ??
      profile.match.hostnameSuffixes[0] ??
      "";
    syncProfileSurface("page", translationProfile?.overrides.page);
    syncProfileSurface("selection", translationProfile?.overrides.selection);
    syncProfileSurface("subtitles", translationProfile?.overrides.subtitles);
    syncLanguageRestrictions();
  };

  const syncCaptureEditor = (
    profile: SubtitleSiteProfile,
    customized: boolean,
  ): void => {
    profileCaptureOverride.checked = customized;
    profileCaptureDetails.open = customized;
    profileCaptureParser.value = profile.parser;
    profileCapturePriority.value = String(profile.priority);
    for (const option of profileCaptureFormats.options) {
      option.selected = profile.capture.formats.includes(
        option.value as SubtitleSiteProfile["capture"]["formats"][number],
      );
    }
    profileCaptureVideoSelector.value = profile.selectors.video;
    profileCaptureCaptionSelectors.value =
      profile.selectors.captions.join("\n");
    profileCaptureNativeSelectors.value =
      profile.selectors.nativeCaptions.join("\n");
    profileCaptureHostnames.value =
      profile.capture.allowedHostnameSuffixes.join("\n");
    profileCaptureUrlPatterns.value = profile.capture.urlPatterns.join("\n");
    profileCaptureCompletePatterns.value =
      profile.capture.completeFilePatterns?.join("\n") ?? "";
    for (const control of captureControls) control.disabled = !customized;
  };

  const syncJsonFromVisualEditor = (): void => {
    if (syncingProfileEditor) return;
    try {
      profileJson.value = normalizedProfileJson(buildProfileDocument());
    } catch {
      // Keep the last valid document while the user is midway through a field.
    }
  };

  const applyDocumentToVisualEditor = (
    document: SiteProfileDocument,
    capture: SubtitleSiteProfile,
  ): void => {
    syncingProfileEditor = true;
    activeProfileMatch = structuredClone(document.match);
    profileName.value = document.name;
    profileHostname.value = document.match.hostnameSuffixes[0] ?? "";
    syncProfileSurface("page", document.overrides.page);
    syncProfileSurface("selection", document.overrides.selection);
    syncProfileSurface("subtitles", document.overrides.subtitles);
    syncCaptureEditor(capture, document.subtitleCapture.customized);
    syncLanguageRestrictions();
    syncingProfileEditor = false;
  };

  const profileKindMessage = (kind: ProfileEditorKind): string =>
    message(
      kind === "builtin"
        ? "profileKindBuiltin"
        : kind === "override"
          ? "profileKindOverride"
          : kind === "user" || kind === "site"
            ? "profileKindUser"
            : "profileUnsaved",
    );

  const syncProfileEditor = (
    profile: SubtitleSiteProfile,
    kind: ProfileEditorKind,
  ): void => {
    activeProfileId = kind === "new" ? "" : profile.id;
    activeProfileMatch = structuredClone(
      currentTranslationProfile()?.match ?? profile.match,
    );
    syncTranslationEditor(profile);
    syncCaptureEditor(profile, kind === "override" || kind === "user");
    editorSnapshot = normalizedProfileJson(buildProfileDocument());
    profileJson.value = editorSnapshot;
    profileEditorKind.textContent = profileKindMessage(kind);
    profileEditorKind.dataset.kind = kind;
    profileEditorNote.textContent = message(
      kind === "builtin"
        ? "profileBuiltinEditNote"
        : kind === "override"
          ? "profileOverrideEditNote"
          : kind === "user" || kind === "site"
            ? "profileUserEditNote"
            : "profileNewEditNote",
    );
    profileDelete.hidden =
      kind !== "user" &&
      kind !== "site" &&
      !translationProfiles.some((candidate) => candidate.id === profile.id);
    profileRestore.hidden = kind !== "override";
    profileSave.textContent = message(
      kind === "builtin" ? "profileSaveOverride" : "profileSave",
    );
    profileMessage.textContent = "";
    renderProfileCatalog();
  };

  const selectBuiltInProfile = (id: string): void => {
    const builtIn = builtInProfiles.find((profile) => profile.id === id);
    if (!builtIn) return;
    const override = profileOverrides.find((profile) => profile.id === id);
    syncProfileEditor(override ?? builtIn, override ? "override" : "builtin");
  };

  const selectUserProfile = (id: string): void => {
    const profile = customProfiles.find((candidate) => candidate.id === id);
    if (profile) syncProfileEditor(profile, "user");
  };

  const selectTranslationProfile = (id: string): void => {
    const profile = translationProfiles.find(
      (candidate) => candidate.id === id,
    );
    if (!profile) return;
    syncProfileEditor(
      {
        ...MINIMAL_USER_SITE_PROFILE_TEMPLATE,
        id: profile.id,
        name: profile.name,
        match: profile.match,
      },
      "site",
    );
  };

  function renderProfileCatalog(): void {
    profileLoading.hidden = true;
    profileCatalogList.replaceChildren();
    profileCatalogList.setAttribute("aria-busy", "false");
    profileTotalCount.textContent = String(
      new Set([
        ...builtInProfiles.map((profile) => profile.id),
        ...customProfiles.map((profile) => profile.id),
        ...translationProfiles.map((profile) => profile.id),
      ]).size,
    );

    const addGroup = (
      group: keyof typeof profileCatalogExpanded,
      labelKey: string,
      entries: Array<{
        profile: SubtitleSiteProfile;
        kind: "builtin" | "override" | "user" | "site";
      }>,
    ): void => {
      const sectionItem = document.createElement("li");
      sectionItem.className = "profile-catalog-section-item";
      const section = document.createElement("details");
      section.className = "profile-catalog-section";
      section.open = profileCatalogExpanded[group];
      const summary = document.createElement("summary");
      const label = document.createElement("span");
      label.textContent = message(labelKey);
      const count = document.createElement("em");
      count.textContent = String(entries.length);
      summary.append(label, count);
      const list = document.createElement("ul");
      list.className = "profile-catalog-group-list";
      section.addEventListener("toggle", () => {
        profileCatalogExpanded[group] = section.open;
      });
      for (const entry of entries) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "profile-catalog-item";
        button.dataset.kind = entry.kind;
        const isActive = activeProfileId === entry.profile.id;
        if (isActive) button.setAttribute("aria-current", "true");
        const name = document.createElement("strong");
        name.textContent = entry.profile.name;
        const meta = document.createElement("span");
        meta.textContent = entry.profile.match.hostnameSuffixes
          .filter((hostname) => hostname !== "*")
          .join(", ");
        const badge = document.createElement("em");
        badge.textContent = profileKindMessage(entry.kind);
        button.append(name, meta, badge);
        button.addEventListener("click", () => {
          if (entry.kind === "user") selectUserProfile(entry.profile.id);
          else if (entry.kind === "site") {
            selectTranslationProfile(entry.profile.id);
          } else selectBuiltInProfile(entry.profile.id);
        });
        item.append(button);
        list.append(item);
      }
      if (entries.length === 0) {
        const empty = document.createElement("li");
        empty.className = "profile-catalog-group-empty";
        empty.textContent = message("profileCatalogGroupEmpty");
        list.append(empty);
      }
      section.append(summary, list);
      sectionItem.append(section);
      profileCatalogList.append(sectionItem);
    };

    const overrides = new Map(
      profileOverrides.map((profile) => [profile.id, profile] as const),
    );
    addGroup(
      "builtin",
      "builtInProfiles",
      builtInProfiles.map((profile) => {
        const override = overrides.get(profile.id);
        return {
          profile: override ?? profile,
          kind: override ? ("override" as const) : ("builtin" as const),
        };
      }),
    );
    const captureIds = new Set([
      ...builtInProfiles.map((profile) => profile.id),
      ...customProfiles.map((profile) => profile.id),
    ]);
    const translationOnlyProfiles = translationProfiles.filter(
      (profile) => !captureIds.has(profile.id),
    );
    addGroup("user", "customProfiles", [
      ...customProfiles.map((profile) => ({
        profile,
        kind: "user" as const,
      })),
      ...translationOnlyProfiles.map((profile) => ({
        profile: {
          ...MINIMAL_USER_SITE_PROFILE_TEMPLATE,
          id: profile.id,
          name: profile.name,
          match: profile.match,
        },
        kind: "site" as const,
      })),
    ]);
  }

  const showProfileValidationFailure = (failure: {
    path: string;
    reason: SiteProfileValidationReason;
  }): void => {
    const reasonKey: Record<SiteProfileValidationReason, string> = {
      type: "profileValidationType",
      unknown_field: "profileValidationUnknownField",
      required: "profileValidationRequired",
      format: "profileValidationFormat",
      range: "profileValidationRange",
      unsafe_selector: "profileValidationUnsafeSelector",
      unsafe_hostname: "profileValidationUnsafeHostname",
      unsafe_url_pattern: "profileValidationUnsafeUrlPattern",
      parser_not_allowed: "profileValidationParser",
      tencent_ocr_only: "profileValidationTencentOcrOnly",
      override_not_supported: "profileValidationOverrideNarrowOnly",
    };
    profileMessage.dataset.tone = "error";
    profileMessage.textContent = message("profileValidationError", [
      failure.path,
      message(reasonKey[failure.reason]),
    ]);
  };

  const copyProfileText = async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text);
    showFeedback(profileMessage, "profileJsonCopied", "success");
  };

  for (const [surface, controls] of Object.entries(surfaceControls) as Array<
    [
      keyof typeof surfaceControls,
      (typeof surfaceControls)[keyof typeof surfaceControls],
    ]
  >) {
    controls.toggle.addEventListener("change", () => {
      syncProfileSurface(
        surface,
        controls.toggle.checked ? fallbackSurfaceValues(surface) : undefined,
      );
      syncLanguageRestrictions();
      syncJsonFromVisualEditor();
    });
    controls.method.addEventListener("change", () => {
      controls.model.disabled =
        !controls.toggle.checked ||
        parseTranslationMethod(controls.method.value)?.mode !== "ai";
      syncLanguageRestrictions();
      const responseMode =
        surface === "page"
          ? profilePageResponseMode
          : surface === "selection"
            ? profileSelectionResponseMode
            : profileSubtitleResponseMode;
      responseMode.disabled =
        !controls.toggle.checked ||
        parseTranslationMethod(controls.method.value)?.mode !== "ai";
      syncJsonFromVisualEditor();
    });
    for (const control of [controls.source, controls.target, controls.model]) {
      control.addEventListener("input", syncJsonFromVisualEditor);
      control.addEventListener("change", syncJsonFromVisualEditor);
    }
    for (const control of surfaceAdditionalControls[surface]) {
      control.addEventListener("input", syncJsonFromVisualEditor);
      control.addEventListener("change", syncJsonFromVisualEditor);
    }
  }
  profileSubtitlePosition.addEventListener("change", () => {
    const enabled =
      profileSubtitleOverride.checked &&
      profileSubtitlePosition.value === "custom";
    profileSubtitleCustomX.disabled = !enabled;
    profileSubtitleCustomY.disabled = !enabled;
  });

  for (const control of [profileName, profileHostname]) {
    control.addEventListener("input", syncJsonFromVisualEditor);
  }
  profileCaptureOverride.addEventListener("change", () => {
    for (const control of captureControls) {
      control.disabled = !profileCaptureOverride.checked;
    }
    if (profileCaptureOverride.checked) profileCaptureDetails.open = true;
    syncJsonFromVisualEditor();
  });
  for (const control of captureControls) {
    control.addEventListener("input", syncJsonFromVisualEditor);
    control.addEventListener("change", syncJsonFromVisualEditor);
  }
  profileJson.addEventListener("change", () => {
    try {
      const parsed = parseSiteProfileDocument(JSON.parse(profileJson.value));
      applyDocumentToVisualEditor(parsed.document, parsed.capture);
      profileJson.value = normalizedProfileJson(parsed.document);
    } catch (error) {
      if (error instanceof SiteProfileValidationError) {
        showProfileValidationFailure(error);
      } else {
        showProfileValidationFailure({ path: "$", reason: "format" });
      }
    }
  });

  profileNew.addEventListener("click", () => {
    syncProfileEditor(MINIMAL_USER_SITE_PROFILE_TEMPLATE, "new");
    profileName.value = "";
    profileHostname.value = "";
    syncJsonFromVisualEditor();
    profileName.focus();
  });
  profileFileOpen.addEventListener("click", () => {
    profileFileDialog.showModal();
    profileJson.focus();
  });
  profileFileClose.addEventListener("click", () => profileFileDialog.close());
  profileFileDialog.addEventListener("click", (event) => {
    if (event.target === profileFileDialog) profileFileDialog.close();
  });
  profileFileImport.addEventListener("click", () => profileFileInput.click());
  profileFileInput.addEventListener("change", () => {
    void (async () => {
      const file = profileFileInput.files?.[0];
      profileFileInput.value = "";
      if (!file || file.size > 50_000) {
        showFeedback(profileMessage, "profileFileImportFailed", "error");
        return;
      }
      try {
        const parsed = parseSiteProfileDocument(JSON.parse(await file.text()));
        if (activeProfileId && parsed.translation.id !== activeProfileId) {
          activeProfileId = "";
          profileEditorKind.textContent = profileKindMessage("new");
          profileEditorKind.dataset.kind = "new";
          profileDelete.hidden = true;
          profileRestore.hidden = true;
          profileSave.textContent = message("profileSave");
        }
        profileJson.value = normalizedProfileJson(parsed.document);
        applyDocumentToVisualEditor(parsed.document, parsed.capture);
        showFeedback(profileMessage, "profileFileImported", "success");
      } catch (error) {
        if (error instanceof SiteProfileValidationError) {
          showProfileValidationFailure(error);
        } else {
          showFeedback(profileMessage, "profileFileImportFailed", "error");
        }
      }
    })();
  });
  profileFileExport.addEventListener("click", () => {
    try {
      const parsed = parseSiteProfileDocument(JSON.parse(profileJson.value));
      const blob = new Blob([normalizedProfileJson(parsed.document), "\n"], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${parsed.document.id}.profile.json`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      showFeedback(profileMessage, "profileFileExported", "success");
    } catch {
      showFeedback(profileMessage, "profileFileExportFailed", "error");
    }
  });
  profileFormat.addEventListener("click", () => {
    try {
      const parsed = parseSiteProfileDocument(JSON.parse(profileJson.value));
      profileJson.value = normalizedProfileJson(parsed.document);
      applyDocumentToVisualEditor(parsed.document, parsed.capture);
      showFeedback(profileMessage, "profileJsonFormatted", "success");
    } catch (error) {
      if (error instanceof SiteProfileValidationError) {
        showProfileValidationFailure(error);
      } else {
        showProfileValidationFailure({ path: "$", reason: "format" });
      }
    }
  });
  profileCopyCurrent.addEventListener("click", () => {
    void copyProfileText(profileJson.value).catch(() =>
      showFeedback(profileMessage, "profileCopyFailed", "error"),
    );
  });
  profileCopyTemplate.addEventListener("click", () => {
    void copyProfileText(profileTemplate.textContent ?? "").catch(() =>
      showFeedback(profileMessage, "profileCopyFailed", "error"),
    );
  });
  profileCancel.addEventListener("click", () => {
    profileJson.value = editorSnapshot;
    const parsed = parseSiteProfileDocument(JSON.parse(editorSnapshot));
    applyDocumentToVisualEditor(parsed.document, parsed.capture);
    showFeedback(profileMessage, "profileChangesCancelled");
  });
  profileSave.addEventListener("click", () => {
    void (async () => {
      let parsedDocument: ReturnType<typeof parseSiteProfileDocument>;
      try {
        parsedDocument = parseSiteProfileDocument(
          JSON.parse(profileJson.value),
        );
        if (
          activeProfileId &&
          parsedDocument.translation.id !== activeProfileId
        ) {
          throw new Error("existing_site_profile_id_changed");
        }
        if (parsedDocument.document.subtitleCapture.customized) {
          parseEditableSiteProfile(parsedDocument.capture);
        }
      } catch (error) {
        if (error instanceof SiteProfileValidationError) {
          showProfileValidationFailure(error);
        } else {
          showProfileValidationFailure({ path: "$", reason: "format" });
        }
        return;
      }
      profileSave.disabled = true;
      try {
        const translationResponse: unknown = await browser.runtime.sendMessage({
          type: "SITE_TRANSLATION_PROFILE_SAVE",
          profile: parsedDocument.translation,
        });
        const validationFailure = profileValidationFailure(translationResponse);
        if (validationFailure) {
          showProfileValidationFailure(validationFailure);
          return;
        }
        if (!isSiteTranslationProfileSaveResponse(translationResponse)) {
          throw new Error("site-profile-save-failed");
        }
        translationProfiles = [
          translationResponse.profile,
          ...translationProfiles.filter(
            (candidate) => candidate.id !== translationResponse.profile.id,
          ),
        ].sort((left, right) => left.name.localeCompare(right.name));

        let captureProfile: SubtitleSiteProfile = {
          ...MINIMAL_USER_SITE_PROFILE_TEMPLATE,
          id: translationResponse.profile.id,
          name: translationResponse.profile.name,
          match: translationResponse.profile.match,
        };
        let nextKind: ProfileEditorKind = "site";
        if (parsedDocument.document.subtitleCapture.customized) {
          const captureResponse: unknown = await browser.runtime.sendMessage({
            type: "SITE_PROFILE_EDITOR_SAVE",
            profile: parsedDocument.capture,
          });
          const captureFailure = profileValidationFailure(captureResponse);
          if (captureFailure) {
            showProfileValidationFailure(captureFailure);
            return;
          }
          if (!isProfileEditorSaveResponse(captureResponse)) {
            throw new Error("site-profile-save-failed");
          }
          captureProfile = captureResponse.profile;
          nextKind = captureResponse.kind;
          if (captureResponse.kind === "user") {
            customProfiles = [
              captureResponse.profile,
              ...customProfiles.filter(
                (candidate) => candidate.id !== captureResponse.profile.id,
              ),
            ].sort((left, right) => left.name.localeCompare(right.name));
          } else {
            profileOverrides = [
              captureResponse.profile,
              ...profileOverrides.filter(
                (candidate) => candidate.id !== captureResponse.profile.id,
              ),
            ];
          }
        } else {
          const existingOverride = profileOverrides.find(
            (candidate) => candidate.id === activeProfileId,
          );
          const existingUser = customProfiles.find(
            (candidate) => candidate.id === activeProfileId,
          );
          if (existingOverride) {
            const response: unknown = await browser.runtime.sendMessage({
              type: "SITE_PROFILE_OVERRIDE_RESTORE",
              id: existingOverride.id,
            });
            if (!isSuccessfulResponse(response)) {
              throw new Error("site-profile-restore-failed");
            }
            profileOverrides = profileOverrides.filter(
              (candidate) => candidate.id !== existingOverride.id,
            );
          }
          if (existingUser) {
            const response: unknown = await browser.runtime.sendMessage({
              type: "SITE_PROFILE_EDITOR_DELETE",
              id: existingUser.id,
            });
            if (!isSuccessfulResponse(response)) {
              throw new Error("site-profile-delete-failed");
            }
            customProfiles = customProfiles.filter(
              (candidate) => candidate.id !== existingUser.id,
            );
          }
          const builtIn = builtInProfiles.find(
            (candidate) => candidate.id === translationResponse.profile.id,
          );
          if (builtIn) {
            captureProfile = builtIn;
            nextKind = "builtin";
          }
        }
        syncProfileEditor(captureProfile, nextKind);
        showFeedback(profileMessage, "profileSaved", "success");
      } catch {
        showFeedback(profileMessage, "profileSaveFailed", "error");
      } finally {
        profileSave.disabled = false;
      }
    })();
  });
  profileDelete.addEventListener("click", () => {
    const captureProfile = customProfiles.find(
      (candidate) => candidate.id === activeProfileId,
    );
    const translationProfile = translationProfiles.find(
      (candidate) => candidate.id === activeProfileId,
    );
    const profileNameValue = translationProfile?.name ?? captureProfile?.name;
    if (
      !profileNameValue ||
      !confirm(message("profileDeleteConfirm", profileNameValue))
    )
      return;
    void (async () => {
      profileDelete.disabled = true;
      try {
        if (translationProfile) {
          const response: unknown = await browser.runtime.sendMessage({
            type: "SITE_TRANSLATION_PROFILE_DELETE",
            id: translationProfile.id,
          });
          if (!isSuccessfulResponse(response)) throw new Error("delete-failed");
          translationProfiles = translationProfiles.filter(
            (candidate) => candidate.id !== translationProfile.id,
          );
        }
        if (captureProfile) {
          const response: unknown = await browser.runtime.sendMessage({
            type: "SITE_PROFILE_EDITOR_DELETE",
            id: captureProfile.id,
          });
          if (!isSuccessfulResponse(response)) throw new Error("delete-failed");
          customProfiles = customProfiles.filter(
            (candidate) => candidate.id !== captureProfile.id,
          );
        }
        const first = builtInProfiles[0];
        if (first) selectBuiltInProfile(first.id);
        else syncProfileEditor(MINIMAL_USER_SITE_PROFILE_TEMPLATE, "new");
        showFeedback(profileMessage, "profileDeleted", "success");
      } catch {
        showFeedback(profileMessage, "profileDeleteFailed", "error");
      } finally {
        profileDelete.disabled = false;
      }
    })();
  });
  profileRestore.addEventListener("click", () => {
    const profile = profileOverrides.find(
      (candidate) => candidate.id === activeProfileId,
    );
    if (!profile || !confirm(message("profileRestoreConfirm", profile.name)))
      return;
    void (async () => {
      profileRestore.disabled = true;
      try {
        const translationProfile = translationProfiles.find(
          (candidate) => candidate.id === profile.id,
        );
        if (translationProfile) {
          const translationResponse: unknown =
            await browser.runtime.sendMessage({
              type: "SITE_TRANSLATION_PROFILE_DELETE",
              id: translationProfile.id,
            });
          if (!isSuccessfulResponse(translationResponse)) {
            throw new Error("restore-failed");
          }
          translationProfiles = translationProfiles.filter(
            (candidate) => candidate.id !== translationProfile.id,
          );
        }
        const response: unknown = await browser.runtime.sendMessage({
          type: "SITE_PROFILE_OVERRIDE_RESTORE",
          id: profile.id,
        });
        if (!isSuccessfulResponse(response)) throw new Error("restore-failed");
        profileOverrides = profileOverrides.filter(
          (candidate) => candidate.id !== profile.id,
        );
        selectBuiltInProfile(profile.id);
        showFeedback(profileMessage, "profileBuiltinRestored", "success");
      } catch {
        showFeedback(profileMessage, "profileRestoreFailed", "error");
      } finally {
        profileRestore.disabled = false;
      }
    })();
  });

  const loadSiteProfiles = async (): Promise<void> => {
    profileLoading.hidden = false;
    profileCatalogList.setAttribute("aria-busy", "true");
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "SITE_PROFILES_GET",
      });
      if (!isSiteProfilesResponse(response)) {
        throw new Error("site-profiles-load-failed");
      }
      builtInProfiles = response.builtIns.filter(
        (profile) => !profile.match.hostnameSuffixes.includes("*"),
      );
      customProfiles = response.profiles;
      profileOverrides = response.overrides;
      translationProfiles = response.translationProfiles;
      renderProfileCatalog();
      const first = builtInProfiles[0];
      if (first) selectBuiltInProfile(first.id);
      else syncProfileEditor(MINIMAL_USER_SITE_PROFILE_TEMPLATE, "new");
    } catch {
      builtInProfiles = [];
      customProfiles = [];
      profileOverrides = [];
      translationProfiles = [];
      renderProfileCatalog();
      showFeedback(profileMessage, "profileLoadFailed", "error");
    }
  };

  profileTemplate.textContent = normalizedProfileJson(
    createSiteProfileDocument(
      {
        id: MINIMAL_USER_SITE_PROFILE_TEMPLATE.id,
        version: 1,
        name: MINIMAL_USER_SITE_PROFILE_TEMPLATE.name,
        match: MINIMAL_USER_SITE_PROFILE_TEMPLATE.match,
        overrides: {},
      },
      MINIMAL_USER_SITE_PROFILE_TEMPLATE,
      true,
    ),
  );
  profileParserGuide.textContent = message("profileFieldParser", [
    SITE_PROFILE_PARSER_ALLOWLIST.join(", "),
  ]);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    void (async () => {
      saveButton.disabled = true;
      try {
        if (ocrEnabled.checked) {
          await requestOcrCapturePermission();
        }
        const languageChanged = await persist(true);
        showFeedback(saveMessage, "settingsSaved", "success");
        if (languageChanged) window.location.reload();
      } catch (error) {
        showFeedback(
          saveMessage,
          failureMessage(error, "settingsSaveFailed"),
          "error",
        );
      } finally {
        saveButton.disabled = false;
      }
    })();
  });

  subtitleFontScale.addEventListener("input", syncRangeOutputs);
  subtitleBackgroundOpacity.addEventListener("input", syncRangeOutputs);

  ocrSelfTest.addEventListener("click", () => {
    void (async () => {
      const engine = createLocalOcrEngine();
      const controller = new AbortController();
      ocrSelfTest.disabled = true;
      ocrTestMessage.dataset.tone = "";
      ocrTestMessage.textContent = message("ocrTestPreparing");
      try {
        const sourceLanguage = ocrSourceLanguage.value;
        if (!isOcrSourceLanguageSupported(sourceLanguage)) {
          throw new Error(message("ocrSourceLanguageUnsupported"));
        }
        await engine.prepare?.(
          controller.signal,
          ({ progress }) => {
            ocrTestMessage.textContent = message(
              "ocrTestLoading",
              String(Math.round(progress * 100)),
            );
          },
          sourceLanguage,
        );
        const canvas = document.createElement("canvas");
        canvas.width = 720;
        canvas.height = 190;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("canvas-unavailable");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#111";
        context.font = "700 52px Arial, sans-serif";
        context.textAlign = "center";
        if (sourceLanguage !== "zh-CN") {
          context.fillText("HELLO OCR 123", canvas.width / 2, 72);
        }
        if (sourceLanguage !== "en") {
          context.font = '700 52px "PingFang SC", sans-serif';
          context.fillText("你好", canvas.width / 2, 148);
        }
        const result = ocrRecognitionText(
          await engine.recognize(canvas, controller.signal),
        );
        if (!result) throw new Error("ocr-empty-result");
        ocrTestMessage.dataset.tone = "success";
        ocrTestMessage.textContent = message(
          "ocrTestSucceeded",
          result.replace(/\s+/gu, " ").slice(0, 80),
        );
      } catch (error) {
        ocrTestMessage.dataset.tone = "error";
        const rawDetail = error instanceof Error ? error.message : "";
        if (/^ocr_runtime_missing(?::|$)/u.test(rawDetail)) {
          ocrTestMessage.textContent = message("ocrRuntimeMissing");
        } else {
          const detail = rawDetail
            .replace(/chrome-extension:\/\/[^/]+/gu, "extension:")
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, 240);
          ocrTestMessage.textContent = detail
            ? `${message("ocrTestFailed")} (${detail})`
            : message("ocrTestFailed");
        }
      } finally {
        await engine.destroy?.();
        ocrSelfTest.disabled = false;
      }
    })();
  });

  testButton.addEventListener("click", () => {
    if (!form.reportValidity()) return;
    void (async () => {
      testButton.disabled = true;
      connectionDiagnostic.hidden = true;
      connectionDiagnostic.open = false;
      connectionDiagnosticText.textContent = "";
      showFeedback(testMessage, "connectionTesting");
      try {
        const languageChanged = await persist(true);
        const response: unknown = await browser.runtime.sendMessage({
          type: "TEST_CONNECTION",
        });
        if (!isConnectionTestResponse(response)) {
          throw new Error("connection-test-failed");
        }
        if (!response.ok) {
          showFeedback(testMessage, "connectionFailed", "error");
          const detail = response.message?.trim();
          if (detail) {
            connectionDiagnosticText.textContent = detail;
            connectionDiagnostic.hidden = false;
          }
          return;
        }
        showFeedback(testMessage, "connectionSucceeded", "success");
        if (languageChanged) window.location.reload();
      } catch (error) {
        showFeedback(
          testMessage,
          failureMessage(error, "connectionFailed"),
          "error",
        );
      } finally {
        testButton.disabled = false;
      }
    })();
  });

  clearCacheButton.addEventListener("click", () => {
    if (!confirm(message("clearCacheConfirm"))) return;
    void (async () => {
      clearCacheButton.disabled = true;
      try {
        await browser.runtime.sendMessage({ type: "CACHE_CLEAR" });
        showFeedback(saveMessage, "cacheCleared", "success");
      } catch {
        showFeedback(saveMessage, "cacheClearFailed", "error");
      } finally {
        clearCacheButton.disabled = false;
      }
    })();
  });

  clearCredentialsButton.addEventListener("click", () => {
    if (!confirm(message("clearCredentialsConfirm"))) return;
    void (async () => {
      clearCredentialsButton.disabled = true;
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: "CREDENTIALS_CLEAR",
        });
        if (!isSuccessfulResponse(response)) {
          throw new Error("credentials-clear-failed");
        }
        settings = {
          ...settings,
          provider: {
            ...settings.provider,
            apiKey: "",
            googleApiKey: "",
            microsoftApiKey: "",
            deeplApiKey: "",
          },
        };
        apiKey.value = "";
        googleApiKey.value = "";
        microsoftApiKey.value = "";
        deeplApiKey.value = "";
        showFeedback(saveMessage, "credentialsCleared", "success");
      } catch {
        showFeedback(saveMessage, "credentialsClearFailed", "error");
      } finally {
        clearCredentialsButton.disabled = false;
      }
    })();
  });

  restoreSessionFloating.addEventListener("click", () => {
    void (async () => {
      restoreSessionFloating.disabled = true;
      restoreSessionFloatingMessage.dataset.tone = "";
      restoreSessionFloatingMessage.textContent = "";
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: "FLOATING_SESSION_RESTORE",
        });
        if (!isFloatingRestoreResponse(response)) {
          throw new Error("floating-session-restore-failed");
        }
        restoreSessionFloatingMessage.dataset.tone = "success";
        restoreSessionFloatingMessage.textContent = message(
          "floatingSessionRestored",
          String(response.restored),
        );
      } catch {
        restoreSessionFloatingMessage.dataset.tone = "error";
        restoreSessionFloatingMessage.textContent = message(
          "floatingSessionRestoreFailed",
        );
      } finally {
        restoreSessionFloating.disabled = false;
      }
    })();
  });

  updateAutoCheck.addEventListener("change", () => {
    void (async () => {
      updateAutoCheck.disabled = true;
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: "UPDATE_AUTO_CHECK_SET",
          enabled: updateAutoCheck.checked,
        });
        if (!isUpdateStatus(response)) throw new Error("invalid-update-status");
        renderUpdateStatus(response);
      } catch {
        if (updateStatus) renderUpdateStatus(updateStatus);
        updateStatusOutput.dataset.tone = "error";
        updateStatusOutput.textContent = message("updateCheckFailed");
      } finally {
        updateAutoCheck.disabled = false;
      }
    })();
  });
  checkUpdatesButton.addEventListener("click", () => {
    void refreshUpdateStatus(true);
  });
  viewUpdateButton.addEventListener("click", () => {
    if (!updateStatus?.releaseUrl) return;
    void browser.tabs.create({ url: updateStatus.releaseUrl });
  });
  ignoreUpdateButton.addEventListener("click", () => {
    if (!updateStatus?.latestVersion) return;
    void (async () => {
      const response: unknown = await browser.runtime.sendMessage({
        type: "UPDATE_IGNORE",
        version: updateStatus?.latestVersion,
      });
      if (isUpdateStatus(response)) renderUpdateStatus(response);
    })();
  });

  const controlIdentifier = (
    control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  ): string => control.name || control.id;
  const markDirtyControl = (event: Event): void => {
    const control = event.target;
    if (
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement
    ) {
      if (control.id === "update-auto-check") return;
      const id = controlIdentifier(control);
      dirtyControls.mark(id);
    }
  };
  form.addEventListener("input", markDirtyControl);
  form.addEventListener("change", markDirtyControl);
  fastProvider.addEventListener("change", () => {
    syncFastProviderFields();
    syncTranslationMethodDependentControls();
  });
  const handleTranslationMethodChange = (select: HTMLSelectElement): void => {
    const method = parseTranslationMethod(select.value);
    if (method?.fastProvider) {
      fastProvider.value = method.fastProvider;
      dirtyControls.mark(controlIdentifier(fastProvider));
      syncFastProviderFields();
    } else {
      syncLanguageRestrictions();
    }
    syncTranslationMethodDependentControls();
  };
  pageMode.addEventListener("change", () => {
    handleTranslationMethodChange(pageMode);
  });
  selectionTranslationMode.addEventListener("change", () => {
    handleTranslationMethodChange(selectionTranslationMode);
  });
  subtitleMode.addEventListener("change", () => {
    handleTranslationMethodChange(subtitleMode);
  });
  imageMode.addEventListener("change", () => {
    handleTranslationMethodChange(imageMode);
  });
  for (const control of [
    pageSourceLanguage,
    pageTargetLanguage,
    selectionTranslationSourceLanguage,
    selectionTranslationTargetLanguage,
    subtitleSourceLanguage,
    subtitleTargetLanguage,
    imageSourceLanguage,
    imageTargetLanguage,
    ocrSourceLanguage,
    ocrTargetLanguage,
    ocrProvider,
  ]) {
    control.addEventListener("change", syncLanguageRestrictions);
  }

  const handleStorageChange = (
    changes: Record<string, Browser.storage.StorageChange>,
    areaName: string,
  ): void => {
    const change = changes.settings;
    if (areaName !== "local" || !change) return;
    const preserved = new Map<string, { value: string; checked?: boolean }>();
    for (const control of Array.from(
      form.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input,select,textarea"),
    )) {
      const id = controlIdentifier(control);
      if (!dirtyControls.has(id)) continue;
      preserved.set(id, {
        value: control.value,
        ...(control instanceof HTMLInputElement &&
        (control.type === "checkbox" || control.type === "radio")
          ? { checked: control.checked }
          : {}),
      });
    }
    const preservedAutoTranslateSites = dirtyControls.has(
      "auto-translate-site-patterns",
    )
      ? {
          included: settings.page.autoTranslateSitePatterns,
          excluded: settings.page.autoTranslateExcludedSitePatterns,
        }
      : undefined;
    settings = mergeSettings(change.newValue);
    if (preservedAutoTranslateSites) {
      settings = {
        ...settings,
        page: {
          ...settings.page,
          autoTranslateSitePatterns: preservedAutoTranslateSites.included,
          autoTranslateExcludedSitePatterns:
            preservedAutoTranslateSites.excluded,
        },
      };
    }
    syncForm();
    for (const control of Array.from(
      form.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >("input,select,textarea"),
    )) {
      const value = preserved.get(controlIdentifier(control));
      if (!value) continue;
      control.value = value.value;
      if (control instanceof HTMLInputElement && value.checked !== undefined) {
        control.checked = value.checked;
      }
    }
    syncRangeOutputs();
    syncFastProviderFields();
    syncTranslationMethodDependentControls();
    if (dirtyControls.size > 0) {
      showFeedback(saveMessage, "settingsUpdatedExternally");
    }
  };
  browser.storage.onChanged.addListener(handleStorageChange);
  window.addEventListener(
    "pagehide",
    () => {
      browser.storage.onChanged.removeListener(handleStorageChange);
      stopOcrRuntimePolling();
    },
    { once: true },
  );

  syncForm();
  void queryChromeTranslationPairs().then((pairs) => {
    chromeTranslationPairs = pairs;
    chromeTranslationPairsLoaded = true;
    syncLanguageRestrictions();
  });
  void loadLocalTranslationRuntimes(false);
  void refreshUpdateStatus(false);
  void loadSiteProfiles();
  void loadOcrRuntimes(true).finally(scheduleOcrRuntimePolling);
}

void (async () => {
  await initializeUiLanguage();
  localizeDocument();
  await initialize();
})().catch(() => {
  document.documentElement.dataset.localized = "true";
  const feedback = document.querySelector<HTMLElement>("#save-message");
  if (feedback) {
    feedback.dataset.tone = "error";
    feedback.textContent = message("settingsLoadFailed");
  }
  for (const control of document.querySelectorAll<
    | HTMLButtonElement
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
  >("button,input,select,textarea")) {
    control.disabled = true;
  }
});
