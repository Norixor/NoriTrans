import {
  isAllowedProviderBaseUrl,
  loadSettings,
  mergeSettings,
  type AppSettings,
} from "@/src/shared/settings";
import {
  displayLanguageName,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
} from "@/src/shared/languages";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import {
  isBuiltInProfileOverride,
  isUserSiteProfile,
  MINIMAL_USER_SITE_PROFILE_TEMPLATE,
  parseSiteProfile,
  SITE_PROFILE_PARSER_ALLOWLIST,
  type SiteProfileValidationReason,
} from "@/src/subtitles/profiles/registry";
import { createLocalOcrEngine, ocrRecognitionText } from "@/src/ocr/engine";
import { isOcrSourceLanguageSupported } from "@/src/ocr/languages";
import {
  getOcrRuntimeLanguage,
  OCR_RUNTIME_CATALOG,
  type OcrRuntimePack,
} from "@/src/ocr/runtime-catalog";
import type { OcrRuntimeInfo } from "@/src/messaging/protocol";
import type { ExtensionUpdateStatus } from "@/src/update/checker";
import { browser } from "wxt/browser";
import { DirtyControlTracker } from "./dirty-control-tracker";

function localizeDocument(): void {
  const resolveMessages = (value: string): string =>
    value.replace(
      /__MSG_([^_]+(?:_[^_]+)*)__/g,
      (placeholder, key: string) =>
        chrome.i18n.getMessage(key) || String(placeholder),
    );
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT);
  let textNode = walker.nextNode();
  while (textNode) {
    if (textNode.nodeValue?.includes("__MSG_")) {
      textNode.nodeValue = resolveMessages(textNode.nodeValue);
    }
    textNode = walker.nextNode();
  }
  for (const node of document.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.value.includes("__MSG_")) {
        node.setAttribute(attribute.name, resolveMessages(attribute.value));
      }
    }
  }
  document.documentElement.dataset.localized = "true";
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>(`#${id}`);
  if (!value) throw new Error(`Missing options element: ${id}`);
  return value;
}

function message(key: string, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

function isSuccessfulResponse(value: unknown): value is { ok: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
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
    value.overrides.every((profile) => isBuiltInProfileOverride(profile))
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

const OCR_RUNTIME_GROUPS: readonly {
  pack: OcrRuntimePack;
  labelKey: string;
}[] = [
  { pack: "zh", labelKey: "ocrRuntimeGroupEastAsian" },
  { pack: "latin", labelKey: "ocrRuntimeGroupLatin" },
  { pack: "korean", labelKey: "ocrRuntimeGroupKorean" },
];

function isOcrRuntimeStatus(value: unknown): value is OcrRuntimeStatus {
  if (typeof value !== "object" || value === null) return false;
  const runtime = value as Record<string, unknown>;
  return (
    typeof runtime.language === "string" &&
    typeof runtime.labelKey === "string" &&
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

const OCR_RUNTIME_ORIGINS = [
  "https://media.githubusercontent.com/*",
  "https://raw.githubusercontent.com/*",
];

async function requestOcrRuntimeDownloadPermission(): Promise<boolean> {
  try {
    return await browser.permissions.request({ origins: OCR_RUNTIME_ORIGINS });
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
  const origin = `${new URL(settings.provider.baseUrl).origin}/*`;
  const permissions = { origins: [origin] };
  if (!(await browser.permissions.request(permissions))) {
    throw new Error("provider-permission-denied");
  }
}

async function initialize(): Promise<void> {
  const form = element<HTMLFormElement>("settings-form");
  const pageSettingsTab = element<HTMLButtonElement>("page-settings-tab");
  const videoSettingsTab = element<HTMLButtonElement>("video-settings-tab");
  const profilesSettingsTab = element<HTMLButtonElement>(
    "profiles-settings-tab",
  );
  const imageSettingsTab = element<HTMLButtonElement>("image-settings-tab");
  const providerSettingsTab = element<HTMLButtonElement>(
    "provider-settings-tab",
  );
  const ocrRuntimesTab = element<HTMLButtonElement>("ocr-runtimes-tab");
  const visibilitySettingsTab = element<HTMLButtonElement>(
    "visibility-settings-tab",
  );
  const pageSettingsPanel = element<HTMLElement>("page-settings-panel");
  const videoSettingsPanel = element<HTMLElement>("video-settings-panel");
  const profilesSettingsPanel = element<HTMLElement>("profiles-settings-panel");
  const imageSettingsPanel = element<HTMLElement>("image-settings-panel");
  const providerSettingsPanel = element<HTMLElement>("provider-settings-panel");
  const ocrRuntimesPanel = element<HTMLElement>("ocr-runtimes-panel");
  const visibilitySettingsPanel = element<HTMLElement>(
    "visibility-settings-panel",
  );
  const fastProvider = element<HTMLSelectElement>("fast-provider");
  const baseUrl = element<HTMLInputElement>("base-url");
  const apiKey = element<HTMLInputElement>("api-key");
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
  const selectionTranslationMode = element<HTMLSelectElement>(
    "selection-translation-mode",
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
  let updateStatus: ExtensionUpdateStatus | undefined;
  let ocrRuntimes: OcrRuntimeStatus[] = [];
  let ocrRuntimeCommandPending = false;
  let ocrRuntimePollTimer: number | undefined;
  let ocrRuntimeListRequest: Promise<void> | undefined;
  let ocrRuntimeFocus:
    { language: string | undefined; action: string | undefined } | undefined;
  const dirtyControls = new DirtyControlTracker();

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
      : displayLanguageName(code, chrome.i18n.getUILanguage());
  for (const language of SOURCE_LANGUAGES) {
    pageSourceLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    subtitleSourceLanguage.add(
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
    subtitleTargetLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
    imageTargetLanguage.add(
      new Option(languageLabel(language.code), language.code),
    );
  }

  const tabItems = [
    { tab: providerSettingsTab, panel: providerSettingsPanel },
    { tab: pageSettingsTab, panel: pageSettingsPanel },
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
    tab.addEventListener("click", () => activateTab(index));
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
    fastProvider.value = settings.provider.fastProvider;
    baseUrl.value = settings.provider.baseUrl;
    apiKey.value = settings.provider.apiKey;
    model.value = settings.provider.model;
    timeout.value = String(Math.round(settings.provider.timeoutMs / 1000));
    systemPrompt.value = settings.provider.systemPrompt;
    pageSourceLanguage.value = settings.page.sourceLanguage;
    pageTargetLanguage.value = settings.page.targetLanguage;
    pageMode.value = settings.page.mode;
    pageResponseMode.value = settings.page.aiResponseMode;
    pageResponseMode.disabled = settings.page.mode !== "ai";
    pageDisplayMode.value = settings.page.displayMode;
    pageAutoTranslate.checked = settings.page.autoTranslate;
    selectionTranslationEnabled.checked =
      settings.page.selectionTranslationEnabled;
    selectionTranslationMode.value = settings.page.selectionTranslationMode;
    floatingControlEnabled.checked =
      settings.page.floatingButtonEnabled ||
      settings.subtitles.floatingButtonEnabled;
    floatingControlEnabled.indeterminate =
      settings.page.floatingButtonEnabled !==
      settings.subtitles.floatingButtonEnabled;
    subtitleEnabled.checked = settings.subtitles.enabled;
    subtitleSourceLanguage.value = settings.subtitles.sourceLanguage;
    subtitleTargetLanguage.value = settings.subtitles.targetLanguage;
    subtitleMode.value = settings.subtitles.mode;
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
    imageTranslationEnabled.checked = settings.imageTranslation.enabled;
    imageSourceLanguage.value = settings.imageTranslation.sourceLanguage;
    imageTargetLanguage.value = settings.imageTranslation.targetLanguage;
    imageMode.value = settings.imageTranslation.mode;
    imageDisplayMode.value = settings.imageTranslation.displayMode;
    imageModelOverride.value = settings.imageTranslation.modelOverride;
    imageModelOverride.disabled = settings.imageTranslation.mode !== "ai";
    syncRangeOutputs();
    renderAutoTranslateSites();
  };

  const readForm = (): AppSettings => ({
    ...settings,
    provider: {
      fastProvider:
        fastProvider.value === "openai-compatible"
          ? "openai-compatible"
          : "chrome-local",
      aiProvider: "openai-compatible",
      baseUrl: baseUrl.value.trim().replace(/\/$/, ""),
      apiKey: apiKey.value.trim(),
      model: model.value.trim(),
      systemPrompt: systemPrompt.value.trim(),
      timeoutMs: Math.round(Number(timeout.value) * 1000),
    },
    page: {
      sourceLanguage: pageSourceLanguage.value,
      targetLanguage: pageTargetLanguage.value,
      mode: pageMode.value === "ai" ? "ai" : "fast",
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
      selectionTranslationMode:
        selectionTranslationMode.value === "ai" ? "ai" : "fast",
    },
    subtitles: {
      ...settings.subtitles,
      enabled: subtitleEnabled.checked,
      sourceLanguage: subtitleSourceLanguage.value,
      targetLanguage: subtitleTargetLanguage.value,
      mode: subtitleMode.value === "fast" ? "fast" : "ai",
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
    },
    imageTranslation: {
      enabled: imageTranslationEnabled.checked,
      sourceLanguage: imageSourceLanguage.value,
      targetLanguage: imageTargetLanguage.value,
      mode: imageMode.value === "ai" ? "ai" : "fast",
      modelOverride: imageModelOverride.value.trim(),
      displayMode:
        imageDisplayMode.value === "bilingual" ? "bilingual" : "translated",
    },
  });

  const persist = async (requestPermission = false): Promise<void> => {
    const submittedSettings = readForm();
    const submittedDirtyVersions = dirtyControls.snapshot();
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
  };

  const showFeedback = (
    target: HTMLElement,
    key: string,
    tone: "success" | "error" | "" = "",
  ): void => {
    target.dataset.tone = tone;
    target.textContent = message(key);
  };

  const runtimeLanguageLabel = (runtime: OcrRuntimeStatus): string => {
    const localizedLabel = chrome.i18n.getMessage(runtime.labelKey);
    if (localizedLabel) return localizedLabel;
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
    const languageCode = languageCodes[runtime.language];
    return languageCode
      ? displayLanguageName(languageCode, chrome.i18n.getUILanguage())
      : runtime.language;
  };

  const runtimeProgress = (runtime: OcrRuntimeStatus): number => {
    const progress = runtime.progress ?? 0;
    return Math.round(
      Math.min(100, Math.max(0, progress <= 1 ? progress * 100 : progress)),
    );
  };

  const formatRuntimeSize = (bytes: number): string => {
    const locale = chrome.i18n.getUILanguage();
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

  const renderOcrRuntimes = (): void => {
    const focusedRuntimeControl =
      document.activeElement instanceof HTMLElement &&
      ocrRuntimeList.contains(document.activeElement) &&
      (document.activeElement.matches("button[data-runtime-language]") ||
        document.activeElement.matches(
          ".runtime-action[data-runtime-language]",
        ))
        ? document.activeElement
        : undefined;
    if (focusedRuntimeControl) {
      ocrRuntimeFocus = {
        language: focusedRuntimeControl.dataset.runtimeLanguage,
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

    for (const group of OCR_RUNTIME_GROUPS) {
      const groupRuntimes = ocrRuntimes.filter(
        (runtime) =>
          getOcrRuntimeLanguage(runtime.language).pack === group.pack,
      );
      if (groupRuntimes.length === 0) continue;
      const groupHasInstalled = groupRuntimes.some(
        (runtime) => runtime.state === "installed",
      );
      const language = OCR_RUNTIME_CATALOG.find(
        (candidate) => candidate.pack === group.pack,
      );
      const packBytes =
        language?.artifacts.reduce(
          (sum, artifact) => sum + artifact.bytes,
          0,
        ) ?? 0;

      const groupItem = document.createElement("li");
      groupItem.className = "runtime-group";
      const groupHeading = document.createElement("div");
      groupHeading.className = "runtime-group-heading";
      const groupName = document.createElement("strong");
      groupName.textContent = message(group.labelKey);
      const groupSummary = document.createElement("span");
      groupSummary.textContent = message("ocrRuntimeGroupSummary", [
        String(groupRuntimes.length),
        formatRuntimeSize(packBytes),
      ]);
      groupHeading.append(groupName, groupSummary);

      const groupList = document.createElement("ul");
      groupList.className = "runtime-group-list";
      for (const runtime of groupRuntimes) {
        const item = document.createElement("li");
        item.className = "runtime-item";

        const identity = document.createElement("div");
        identity.className = "runtime-identity";
        const name = document.createElement("strong");
        name.textContent = runtimeLanguageLabel(runtime);
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
              runtimeLanguageLabel(runtime),
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
          badge.textContent = message(
            groupHasInstalled
              ? "ocrRuntimeStateNotEnabled"
              : "ocrRuntimeStateMissing",
          );
          status.append(badge);
        }

        const action = document.createElement("div");
        action.className = "runtime-action";
        action.tabIndex = -1;
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.runtimeLanguage = runtime.language;
        button.disabled =
          ocrRuntimeCommandPending || runtime.state === "downloading";
        if (runtime.state === "installed") {
          button.dataset.runtimeAction = "delete";
          button.className = "button button-danger-quiet";
          button.textContent = message("ocrRuntimeDelete");
          button.setAttribute(
            "aria-label",
            message("ocrRuntimeDeleteLabel", runtimeLanguageLabel(runtime)),
          );
          button.addEventListener("click", () => deleteOcrRuntime(runtime));
        } else {
          button.dataset.runtimeAction = "download";
          button.className = "button button-secondary";
          button.textContent =
            runtime.state === "downloading"
              ? message("ocrRuntimeDownloading")
              : message(
                  groupHasInstalled ? "ocrRuntimeEnable" : "ocrRuntimeDownload",
                );
          button.setAttribute(
            "aria-label",
            message("ocrRuntimeDownloadLabel", runtimeLanguageLabel(runtime)),
          );
          button.addEventListener("click", () => {
            void downloadOcrRuntime(runtime);
          });
        }
        action.dataset.runtimeLanguage = runtime.language;
        action.dataset.runtimeAction = button.dataset.runtimeAction;
        action.setAttribute("role", "group");
        action.setAttribute(
          "aria-label",
          button.getAttribute("aria-label") ?? button.textContent ?? "",
        );
        action.append(button);
        item.append(identity, status, action);
        groupList.append(item);
      }
      groupItem.append(groupHeading, groupList);
      ocrRuntimeList.append(groupItem);
    }
    if (activeRuntimeAction?.language) {
      const runtimeButtons = Array.from(
        ocrRuntimeList.querySelectorAll<HTMLButtonElement>(
          "button[data-runtime-language]",
        ),
      );
      const runtimeActions = Array.from(
        ocrRuntimeList.querySelectorAll<HTMLElement>(
          ".runtime-action[data-runtime-language]",
        ),
      );
      const focusTarget =
        runtimeButtons.find(
          (button) =>
            !button.disabled &&
            button.dataset.runtimeLanguage === activeRuntimeAction.language &&
            button.dataset.runtimeAction === activeRuntimeAction.action,
        ) ??
        runtimeActions.find(
          (action) =>
            action.dataset.runtimeLanguage === activeRuntimeAction.language &&
            action.dataset.runtimeAction === activeRuntimeAction.action,
        ) ??
        runtimeButtons.find(
          (button) =>
            !button.disabled &&
            button.dataset.runtimeLanguage === activeRuntimeAction.language,
        ) ??
        runtimeActions.find(
          (action) =>
            action.dataset.runtimeLanguage === activeRuntimeAction.language,
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
      candidate.language === runtime.language
        ? { ...candidate, state: "downloading", progress: 0 }
        : candidate,
    );
    renderOcrRuntimes();
    scheduleOcrRuntimePolling();
    try {
      const response: unknown = await browser.runtime.sendMessage({
        type: "OCR_RUNTIME_DOWNLOAD",
        language: runtime.language,
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
      !confirm(
        message("ocrRuntimeDeleteConfirm", runtimeLanguageLabel(runtime)),
      )
    ) {
      return;
    }
    void (async () => {
      ocrRuntimeCommandPending = true;
      renderOcrRuntimes();
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: "OCR_RUNTIME_DELETE",
          language: runtime.language,
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

  type ProfileEditorKind = "builtin" | "override" | "user" | "new";
  let activeProfileId = "";
  let activeProfileKind: ProfileEditorKind = "new";
  let editorSnapshot = "";

  const normalizedProfileJson = (profile: SubtitleSiteProfile): string =>
    JSON.stringify(profile, null, 2);

  const profileKindMessage = (kind: ProfileEditorKind): string =>
    message(
      kind === "builtin"
        ? "profileKindBuiltin"
        : kind === "override"
          ? "profileKindOverride"
          : kind === "user"
            ? "profileKindUser"
            : "profileUnsaved",
    );

  const syncProfileEditor = (
    profile: SubtitleSiteProfile,
    kind: ProfileEditorKind,
  ): void => {
    activeProfileId = kind === "new" ? "" : profile.id;
    activeProfileKind = kind;
    editorSnapshot = normalizedProfileJson(profile);
    profileJson.value = editorSnapshot;
    profileEditorKind.textContent = profileKindMessage(kind);
    profileEditorKind.dataset.kind = kind;
    profileEditorNote.textContent = message(
      kind === "builtin"
        ? "profileBuiltinEditNote"
        : kind === "override"
          ? "profileOverrideEditNote"
          : kind === "user"
            ? "profileUserEditNote"
            : "profileNewEditNote",
    );
    profileDelete.hidden = kind !== "user";
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

  function renderProfileCatalog(): void {
    profileLoading.hidden = true;
    profileCatalogList.replaceChildren();
    profileCatalogList.setAttribute("aria-busy", "false");
    profileTotalCount.textContent = String(
      builtInProfiles.length + customProfiles.length,
    );

    const addGroup = (
      labelKey: string,
      entries: Array<{
        profile: SubtitleSiteProfile;
        kind: "builtin" | "override" | "user";
      }>,
    ): void => {
      const heading = document.createElement("li");
      heading.className = "profile-catalog-group";
      heading.textContent = message(labelKey);
      profileCatalogList.append(heading);
      for (const entry of entries) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "profile-catalog-item";
        button.dataset.kind = entry.kind;
        const isActive =
          activeProfileId === entry.profile.id &&
          (activeProfileKind === entry.kind ||
            (entry.kind === "override" && activeProfileKind === "builtin"));
        if (isActive) button.setAttribute("aria-current", "true");
        const name = document.createElement("strong");
        name.textContent = entry.profile.name;
        const meta = document.createElement("span");
        meta.textContent = `${entry.profile.id} · ${entry.profile.parser}`;
        const badge = document.createElement("em");
        badge.textContent = profileKindMessage(entry.kind);
        button.append(name, meta, badge);
        button.addEventListener("click", () => {
          if (entry.kind === "user") selectUserProfile(entry.profile.id);
          else selectBuiltInProfile(entry.profile.id);
        });
        item.append(button);
        profileCatalogList.append(item);
      }
    };

    const overrides = new Map(
      profileOverrides.map((profile) => [profile.id, profile] as const),
    );
    addGroup(
      "builtInProfiles",
      builtInProfiles.map((profile) => {
        const override = overrides.get(profile.id);
        return {
          profile: override ?? profile,
          kind: override ? ("override" as const) : ("builtin" as const),
        };
      }),
    );
    addGroup(
      "customProfiles",
      customProfiles.map((profile) => ({ profile, kind: "user" as const })),
    );
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

  profileNew.addEventListener("click", () => {
    syncProfileEditor(MINIMAL_USER_SITE_PROFILE_TEMPLATE, "new");
    profileJson.focus();
  });
  profileFormat.addEventListener("click", () => {
    try {
      const parsed: unknown = JSON.parse(profileJson.value);
      profileJson.value = JSON.stringify(parsed, null, 2);
      showFeedback(profileMessage, "profileJsonFormatted", "success");
    } catch {
      showProfileValidationFailure({ path: "$", reason: "format" });
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
    showFeedback(profileMessage, "profileChangesCancelled");
  });
  profileSave.addEventListener("click", () => {
    void (async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(profileJson.value);
      } catch {
        showProfileValidationFailure({ path: "$", reason: "format" });
        return;
      }
      profileSave.disabled = true;
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: "SITE_PROFILE_EDITOR_SAVE",
          profile: parsed,
        });
        const validationFailure = profileValidationFailure(response);
        if (validationFailure) {
          showProfileValidationFailure(validationFailure);
          return;
        }
        if (!isProfileEditorSaveResponse(response)) {
          throw new Error("site-profile-save-failed");
        }
        if (response.kind === "user") {
          customProfiles = [
            response.profile,
            ...customProfiles.filter(
              (candidate) => candidate.id !== response.profile.id,
            ),
          ].sort((left, right) => left.name.localeCompare(right.name));
        } else {
          profileOverrides = [
            response.profile,
            ...profileOverrides.filter(
              (candidate) => candidate.id !== response.profile.id,
            ),
          ];
        }
        syncProfileEditor(response.profile, response.kind);
        showFeedback(
          profileMessage,
          response.kind === "override"
            ? "profileOverrideSaved"
            : "profileSaved",
          "success",
        );
      } catch {
        showFeedback(profileMessage, "profileSaveFailed", "error");
      } finally {
        profileSave.disabled = false;
      }
    })();
  });
  profileDelete.addEventListener("click", () => {
    const profile = customProfiles.find(
      (candidate) => candidate.id === activeProfileId,
    );
    if (!profile || !confirm(message("profileDeleteConfirm", profile.name)))
      return;
    void (async () => {
      profileDelete.disabled = true;
      try {
        const response: unknown = await browser.runtime.sendMessage({
          type: "SITE_PROFILE_EDITOR_DELETE",
          id: profile.id,
        });
        if (!isSuccessfulResponse(response)) throw new Error("delete-failed");
        customProfiles = customProfiles.filter(
          (candidate) => candidate.id !== profile.id,
        );
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
      builtInProfiles = response.builtIns;
      customProfiles = response.profiles;
      profileOverrides = response.overrides;
      renderProfileCatalog();
      const first = builtInProfiles[0];
      if (first) selectBuiltInProfile(first.id);
      else syncProfileEditor(MINIMAL_USER_SITE_PROFILE_TEMPLATE, "new");
    } catch {
      builtInProfiles = [];
      customProfiles = [];
      profileOverrides = [];
      renderProfileCatalog();
      showFeedback(profileMessage, "profileLoadFailed", "error");
    }
  };

  profileTemplate.textContent = normalizedProfileJson(
    MINIMAL_USER_SITE_PROFILE_TEMPLATE,
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
        await persist(true);
        showFeedback(saveMessage, "settingsSaved", "success");
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
        const sourceLanguage = subtitleSourceLanguage.value;
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
        await persist(true);
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
          provider: { ...settings.provider, apiKey: "" },
        };
        apiKey.value = "";
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
  pageMode.addEventListener("change", () => {
    pageResponseMode.disabled = pageMode.value !== "ai";
  });
  subtitleMode.addEventListener("change", () => {
    subtitleResponseMode.disabled = subtitleMode.value !== "ai";
  });
  imageMode.addEventListener("change", () => {
    imageModelOverride.disabled = imageMode.value !== "ai";
  });

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
  void refreshUpdateStatus(false);
  void loadSiteProfiles();
  void loadOcrRuntimes(true).finally(scheduleOcrRuntimePolling);
}

localizeDocument();
void initialize().catch(() => {
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
