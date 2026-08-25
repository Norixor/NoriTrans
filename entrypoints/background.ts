import {
  cacheStats,
  clearCache,
  deleteSubtitleTrack,
  getCachedTranslation,
  getSubtitleTrack,
  setCachedTranslation,
  setSubtitleTrack,
} from "@/src/cache/database";
import {
  isBackgroundCommand,
  type BackgroundCommand,
  type OcrCaptureResponse,
  type TranslationProgressMessage,
  type TranslationResponse,
} from "@/src/messaging/protocol";
import {
  loadSettings,
  mergeSettings,
  saveSettings,
  toContentSettings,
  type AppSettings,
} from "@/src/shared/settings";
import {
  applySiteProfileSettings,
  resolveSiteTranslationProfile,
} from "@/src/shared/site-profile-settings";
import {
  deleteSiteTranslationProfile,
  loadSiteTranslationProfiles,
  saveSiteTranslationProfile,
} from "@/src/site-profiles/storage";
import {
  autoTranslateSitePatternForHostname,
  updateSiteAutoTranslateRules,
} from "@/src/shared/auto-translate-sites";
import { NorixorTransError, errorMessage } from "@/src/shared/errors";
import {
  runtimeErrorToken,
  safeRuntimeErrorToken,
} from "@/src/shared/runtime-errors";
import { runtimeId } from "@/src/shared/runtime-id";
import {
  TranslationRequestGate,
  translationBucketForTab,
} from "@/src/shared/translation-request-gate";
import {
  isFullDocumentNavigationUpdate,
  prepareContentFramesForBroadcast,
  sendCommandToContentFrames,
  refreshExistingContentScripts,
  TabManualTranslationIntentStore,
  type ContentFrameTarget,
} from "@/src/shared/content-script-refresh";
import {
  invalidateLocalTranslationModelIdentity,
  translateInBackground,
} from "@/src/translation/service";
import type { TranslationResult } from "@/src/translation/types";
import {
  deleteSiteProfileOverride,
  deleteUserSiteProfile,
  loadRuntimeSiteProfiles,
  loadSiteProfileOverrides,
  loadUserSiteProfiles,
  saveEditableSiteProfile,
  saveUserSiteProfile,
} from "@/src/subtitles/profiles/storage";
import {
  BUILT_IN_SITE_PROFILES,
  profileMatchesHostname,
  SiteProfileValidationError,
} from "@/src/subtitles/profiles/registry";
import { createOcrOffscreenDocumentEnsurer } from "@/src/ocr/offscreen-manager";
import {
  isOcrCaptureRequest,
  isOcrOffscreenRequest,
  isOcrOffscreenProgress,
  isOcrOffscreenResponse,
  OCR_BACKGROUND_TARGET,
  OCR_CLIENT_TARGET,
  OCR_OFFSCREEN_TARGET,
  OCR_SAMPLE_INTERVAL_MS,
  shouldRejectMalformedOcrBackgroundMessage,
  type OcrOffscreenRequest,
  type OcrOffscreenProgress,
  type OcrOffscreenResponse,
} from "@/src/ocr/types";
import {
  captureOcrDataUrl,
  OCR_CAPTURE_MAX_DATA_URL_LENGTH,
} from "@/src/ocr/capture-policy";
import {
  deleteRuntimePack as deleteOcrRuntimePack,
  installRuntimePack as installOcrRuntimePack,
  installedLanguages as installedOcrRuntimeLanguages,
  list as listOcrRuntimes,
} from "@/src/ocr/runtime-storage";
import {
  getOcrRuntimePackage,
  type OcrRuntimePack,
} from "@/src/ocr/runtime-catalog";
import { selectInstalledOcrRuntime } from "@/src/ocr/languages";
import {
  deleteRuntime as deleteLocalTranslationRuntime,
  install as installLocalTranslationRuntime,
  list as listLocalTranslationRuntimes,
} from "@/src/local-translation/runtime-storage";
import { BergamotOffscreenClient } from "@/src/local-translation/client";
import { BergamotRuntimeError } from "@/src/local-translation/errors";
import {
  checkForUpdates,
  getUpdateStatus,
  ignoreUpdate,
  initializeUpdateChecker,
  setAutomaticUpdateChecks,
} from "@/src/update/checker";

const translationRequestGate = new TranslationRequestGate(8);
const OCR_CAPTURE_MIN_INTERVAL_MS = Math.max(OCR_SAMPLE_INTERVAL_MS, 550);
const OCR_OFFSCREEN_URL = browser.runtime.getURL("ocr-offscreen.html" as never);
const OCR_PERMISSION_URL = browser.runtime.getURL(
  "ocr-permission.html" as never,
);
const OCR_OFFSCREEN_REQUEST_TIMEOUT_MS = 95_000;
const OCR_RUNTIME_DOWNLOAD_ORIGINS = [
  "https://media.githubusercontent.com/*",
  "https://raw.githubusercontent.com/*",
];
const LOCAL_TRANSLATION_RUNTIME_DOWNLOAD_ORIGINS = [
  "https://storage.googleapis.com/*",
];
const IMAGE_SOURCE_MAX_BYTES = 8_000_000;
const IMAGE_SOURCE_FETCH_TIMEOUT_MS = 15_000;
const FLOATING_POSITION_STORAGE_KEY = "norixortrans:floating-position-v1";
const MANUAL_TRANSLATION_STORAGE_KEY =
  "norixortrans:manual-page-translation-tabs-v1";
let ocrPermissionWindowId: number | undefined;
let ocrPermissionRequestTabId: number | undefined;
const OCR_PERMISSION_REQUEST_TAB_KEY = "ocrPermissionRequestTabId";
let contentRefreshPromise: Promise<void> | undefined;
let settingsMutationTail: Promise<void> = Promise.resolve();
let siteProfileMutationTail: Promise<void> = Promise.resolve();
let cacheEpoch = 0;
let cacheMutationTail: Promise<void> = Promise.resolve();
let lastOcrCaptureAtMs = 0;
let ocrCaptureGate: Promise<void> = Promise.resolve();

function waitForOcrCaptureSlot(): Promise<void> {
  const operation = ocrCaptureGate.then(async () => {
    const remaining = Math.max(
      0,
      OCR_CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastOcrCaptureAtMs),
    );
    if (remaining > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
    lastOcrCaptureAtMs = Date.now();
  });
  ocrCaptureGate = operation.catch(() => undefined);
  return operation;
}

function isOcrCaptureRateLimitError(error: unknown): boolean {
  const detail = errorMessage(error).toLowerCase();
  return (
    detail.includes("max_capture_visible_tab_calls_per_second") ||
    (detail.includes("capturevisibletab") && detail.includes("quota")) ||
    detail.includes("exceeds the max_capture_visible_tab")
  );
}
const ocrProgressRoutes = new Map<
  string,
  { tabId?: number; frameId?: number }
>();
const manualTranslationIntents = new TabManualTranslationIntentStore({
  read: async () => {
    const stored = await browser.storage.session.get(
      MANUAL_TRANSLATION_STORAGE_KEY,
    );
    return stored[MANUAL_TRANSLATION_STORAGE_KEY];
  },
  write: (state) =>
    browser.storage.session.set({ [MANUAL_TRANSLATION_STORAGE_KEY]: state }),
});

async function refreshOpenPageContentScripts(): Promise<void> {
  if (!contentRefreshPromise) {
    const version = browser.runtime.getManifest().version;
    const operation = refreshExistingContentScripts({
      queryTabs: () => browser.tabs.query({}),
      isCurrent: async (tabId) => {
        const response: unknown = await browser.tabs.sendMessage(
          tabId,
          { type: "CONTENT_RUNTIME_INFO" },
          { frameId: 0 },
        );
        return (
          typeof response === "object" &&
          response !== null &&
          "version" in response &&
          response.version === version
        );
      },
      inject: (tabId) =>
        browser.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["/content-scripts/video.js"],
        }),
    }).then(() => undefined);
    contentRefreshPromise = operation.catch((error: unknown) => {
      contentRefreshPromise = undefined;
      throw error;
    });
  }
  await contentRefreshPromise;
}

function enqueueCacheMutation(
  expectedEpoch: number,
  mutation: () => Promise<void>,
): Promise<boolean> {
  const operation = cacheMutationTail.then(async () => {
    if (expectedEpoch !== cacheEpoch) return false;
    await mutation();
    return true;
  });
  cacheMutationTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function readCacheAtCurrentEpoch<T>(
  read: () => Promise<T>,
): Promise<{ epoch: number; value: T }> {
  for (;;) {
    const epoch = cacheEpoch;
    await cacheMutationTail;
    const value = await read();
    if (epoch === cacheEpoch) return { epoch, value };
  }
}

const ensureOcrOffscreenDocument = createOcrOffscreenDocumentEnsurer({
  getContexts: () =>
    chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    }),
  createDocument: () =>
    chrome.offscreen.createDocument({
      url: "ocr-offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        "Run bundled local OCR and translation workers outside website CSP; page text and cropped images stay inside the extension.",
    }),
});

async function openOcrPermissionWindow(requestTabId?: number): Promise<void> {
  if (requestTabId !== undefined) {
    ocrPermissionRequestTabId = requestTabId;
    await browser.storage.session.set({
      [OCR_PERMISSION_REQUEST_TAB_KEY]: requestTabId,
    });
  }
  if (ocrPermissionWindowId !== undefined) {
    try {
      const existing = await browser.windows.get(ocrPermissionWindowId, {
        populate: true,
      });
      if (existing.tabs?.some((tab) => tab.url === OCR_PERMISSION_URL)) {
        await browser.windows.update(ocrPermissionWindowId, { focused: true });
        return;
      }
      ocrPermissionWindowId = undefined;
    } catch {
      ocrPermissionWindowId = undefined;
    }
  }
  const permissionWindow = await browser.windows.create({
    url: OCR_PERMISSION_URL,
    type: "popup",
    focused: true,
    width: 640,
    height: 600,
  });
  if (permissionWindow?.id === undefined) {
    throw new Error("ocr_permission_window_unavailable");
  }
  ocrPermissionWindowId = permissionWindow.id;
}

async function takeOcrPermissionRequestTabId(): Promise<number | undefined> {
  const inMemory = ocrPermissionRequestTabId;
  ocrPermissionRequestTabId = undefined;
  const stored: Record<string, unknown> = await browser.storage.session
    .get(OCR_PERMISSION_REQUEST_TAB_KEY)
    .catch(() => ({}));
  await browser.storage.session
    .remove(OCR_PERMISSION_REQUEST_TAB_KEY)
    .catch(() => undefined);
  const candidate = stored[OCR_PERMISSION_REQUEST_TAB_KEY];
  return typeof candidate === "number" && Number.isInteger(candidate)
    ? candidate
    : inMemory;
}

function clearOcrPermissionRequestTabId(): void {
  ocrPermissionRequestTabId = undefined;
  void browser.storage.session
    .remove(OCR_PERMISSION_REQUEST_TAB_KEY)
    .catch(() => undefined);
}

function toOffscreenRequest(request: OcrOffscreenRequest): OcrOffscreenRequest {
  return { ...request, target: OCR_OFFSCREEN_TARGET };
}

function ocrRequestKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

async function relayOcrProgress(message: OcrOffscreenProgress): Promise<void> {
  const route = ocrProgressRoutes.get(
    ocrRequestKey(message.sessionId, message.requestId),
  );
  if (!route) return;
  const clientMessage = { ...message, target: OCR_CLIENT_TARGET };
  if (route.tabId !== undefined) {
    await browser.tabs.sendMessage(route.tabId, clientMessage, {
      frameId: route.frameId ?? 0,
    });
    return;
  }
  await browser.runtime.sendMessage(clientMessage);
}

async function relayTranslationProgress(
  sender: Browser.runtime.MessageSender,
  requestId: string,
  result: TranslationResult,
): Promise<void> {
  const message: TranslationProgressMessage = {
    type: "TRANSLATION_PROGRESS",
    requestId,
    result,
  };
  if (sender.tab?.id !== undefined) {
    await browser.tabs
      .sendMessage(sender.tab.id, message, { frameId: sender.frameId ?? 0 })
      .catch(() => undefined);
    return;
  }
  await browser.runtime.sendMessage(message).catch(() => undefined);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(
          () => reject(new Error("ocr_request_timeout")),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}

async function forwardOcrOffscreenRequest(
  request: OcrOffscreenRequest,
): Promise<OcrOffscreenResponse> {
  await ensureOcrOffscreenDocument();
  const response: unknown = await withTimeout(
    browser.runtime.sendMessage(toOffscreenRequest(request)),
    OCR_OFFSCREEN_REQUEST_TIMEOUT_MS,
  );
  if (!isOcrOffscreenResponse(response, request.sessionId, request.requestId)) {
    throw new Error("ocr_invalid_offscreen_response");
  }
  return response;
}

async function assertOcrRuntimeDownloadPermission(): Promise<void> {
  if (
    await browser.permissions.contains({
      origins: OCR_RUNTIME_DOWNLOAD_ORIGINS,
    })
  ) {
    return;
  }
  throw new Error("ocr_runtime_download_permission_required");
}

async function assertLocalTranslationRuntimePermission(): Promise<void> {
  if (
    await browser.permissions.contains({
      origins: LOCAL_TRANSLATION_RUNTIME_DOWNLOAD_ORIGINS,
    })
  ) {
    return;
  }
  throw new Error("local_translation_runtime_download_permission_required");
}

async function assertOcrPrepareRuntimesInstalled(
  sourceLanguage?: string,
): Promise<void> {
  const installed = await installedOcrRuntimeLanguages();
  if (selectInstalledOcrRuntime(sourceLanguage, installed)) return;
  throw new Error(`ocr_runtime_missing:${sourceLanguage || "auto"}`);
}

async function invalidateLoadedOcrRuntime(pack: OcrRuntimePack): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [OCR_OFFSCREEN_URL],
  });
  if (contexts.length === 0) return;
  const language = getOcrRuntimePackage(pack).languages[0];
  if (!language) return;
  const response = await forwardOcrOffscreenRequest({
    target: OCR_BACKGROUND_TARGET,
    type: "OCR_OFFSCREEN_RUNTIME_INVALIDATE",
    sessionId: runtimeId("ocr-runtime-session"),
    requestId: runtimeId("ocr-runtime-invalidate"),
    language,
  });
  if (!response.ok)
    throw new Error(response.error ?? "ocr_runtime_invalidate_failed");
}

async function resetLoadedLocalTranslationRuntime(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length === 0) return;
  await new BergamotOffscreenClient().reset();
}

function localTranslationRuntimeFailureResponse(error: unknown): {
  ok: false;
  error: string;
} {
  return {
    ok: false,
    error:
      error instanceof BergamotRuntimeError
        ? error.code
        : "bergamot_runtime_failed",
  };
}

async function installAllMissingOcrRuntimes(): Promise<void> {
  const missing = (await listOcrRuntimes()).filter(
    (runtime) => runtime.state !== "installed",
  );
  let cursor = 0;
  const failures: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (cursor < missing.length) {
      const runtime = missing[cursor];
      cursor += 1;
      if (!runtime) continue;
      try {
        await installOcrRuntimePack(runtime.pack);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(2, missing.length) }, worker),
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "ocr_runtime_download_all_failed");
  }
}

function providerOriginPattern(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/*`;
}

function providerOriginForMode(
  settings: AppSettings,
  mode: "fast" | "ai",
  providerOverride?: AppSettings["provider"]["fastProvider"],
): string | undefined {
  const providerId =
    mode === "ai"
      ? settings.provider.aiProvider
      : (providerOverride ?? settings.provider.fastProvider);
  if (providerId === "chrome-local" || providerId === "bergamot-local") {
    return undefined;
  }
  if (providerId === "openai-compatible" || providerId === "anthropic-messages")
    return providerOriginPattern(settings.provider.baseUrl);
  if (providerId === "google-translate")
    return "https://translation.googleapis.com/*";
  if (providerId === "microsoft-translator")
    return "https://api.cognitive.microsofttranslator.com/*";
  return settings.provider.deeplPlan === "pro"
    ? "https://api.deepl.com/*"
    : "https://api-free.deepl.com/*";
}

async function assertProviderPermission(
  settings: AppSettings,
  mode: "fast" | "ai",
  providerOverride?: AppSettings["provider"]["fastProvider"],
): Promise<void> {
  const origin = providerOriginForMode(settings, mode, providerOverride);
  if (!origin) return;
  if (await browser.permissions.contains({ origins: [origin] })) return;
  throw new NorixorTransError(
    "尚未授权访问当前翻译服务，请在设置中重新保存 Provider。",
    "permission_required",
  );
}

function isPageStatus(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    "failed" in value
  );
}

function isSubtitleStatus(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    "failed" in value &&
    "total" in value
  );
}

function isCurrentContentRuntime(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === browser.runtime.getManifest().version
  );
}

function isSuccessfulResponse(value: unknown): value is { ok: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

function isFloatingSessionShowResponse(
  value: unknown,
): value is { ok: true; restored: boolean } {
  return (
    isSuccessfulResponse(value) &&
    "restored" in value &&
    typeof value.restored === "boolean"
  );
}

async function ensureVideoContent(tabId: number): Promise<void> {
  try {
    const runtimeInfo: unknown = await browser.tabs.sendMessage(
      tabId,
      { type: "CONTENT_RUNTIME_INFO" },
      { frameId: 0 },
    );
    if (isCurrentContentRuntime(runtimeInfo)) return;
  } catch {
    // A generic or stale page receives the current pipeline after a user gesture.
  }
  await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["/content-scripts/video.js"],
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response: unknown = await browser.tabs
      .sendMessage(tabId, { type: "SUBTITLE_STATUS" }, { frameId: 0 })
      .catch(() => undefined);
    if (isSubtitleStatus(response)) return;
  }
  throw new Error("字幕脚本没有响应。");
}

async function ensurePageContent(
  tabId: number,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await ensureVideoContent(tabId);
    const response: unknown = await browser.tabs.sendMessage(
      tabId,
      { type: "PAGE_STATUS" },
      { frameId: 0 },
    );
    if (!isPageStatus(response)) {
      return { ok: false, error: "统一翻译脚本没有响应。" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: safeRuntimeErrorToken(error) };
  }
}

async function discoverCommandBroadcastFrames(
  tabId: number,
): Promise<ContentFrameTarget[]> {
  const results = await browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => true,
    injectImmediately: true,
  });
  return results.map(({ frameId, documentId }) => ({ frameId, documentId }));
}

async function prepareCommandBroadcastFrames(
  tabId: number,
): Promise<ContentFrameTarget[]> {
  const version = browser.runtime.getManifest().version;
  let discoveredTargets: ContentFrameTarget[] = [];
  await prepareContentFramesForBroadcast({
    discover: async () => {
      discoveredTargets = await discoverCommandBroadcastFrames(tabId);
      return discoveredTargets;
    },
    isCurrent: async (target: ContentFrameTarget) => {
      const response: unknown = await browser.tabs.sendMessage(
        tabId,
        { type: "CONTENT_RUNTIME_INFO" },
        { documentId: target.documentId },
      );
      return (
        typeof response === "object" &&
        response !== null &&
        "version" in response &&
        response.version === version
      );
    },
    inject: (target: ContentFrameTarget) =>
      browser.scripting.executeScript({
        target: { tabId, documentIds: [target.documentId] },
        files: ["/content-scripts/video.js"],
        injectImmediately: true,
      }),
  });
  return discoveredTargets;
}

function translationError(error: unknown): TranslationResponse {
  if (error instanceof NorixorTransError) {
    const allowedCodes = new Set([
      "provider_unavailable",
      "permission_required",
      "invalid_configuration",
      "invalid_response",
      "request_failed",
      "cancelled",
    ]);
    return {
      ok: false,
      error: {
        code: allowedCodes.has(error.code)
          ? (error.code as "request_failed")
          : "request_failed",
        message: error.message,
        retryable: error.retryable,
        ...(error.details ? { details: error.details.slice(0, 4_000) } : {}),
        ...(error.reason === "bergamot_package_missing" ||
        error.reason === "bergamot_unsupported_language" ||
        error.reason === "chrome_language_detection_failed" ||
        error.reason === "chrome_pair_unavailable"
          ? { reason: error.reason }
          : {}),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "request_failed",
      message: runtimeErrorToken("request_failed"),
      retryable: false,
      details: `Unexpected provider failure type: ${error instanceof Error ? error.name : typeof error}.`,
    },
  };
}

function safeConnectionDiagnostic(error: unknown): string {
  const values =
    error instanceof NorixorTransError
      ? [error.message, error.details]
      : [errorMessage(error)];
  return values
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n")
    .replace(
      /\b(authorization|api[-_ ]?key)\s*[:=]\s*[^\s,;]+/giu,
      "$1: [redacted]",
    )
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/gu, "[redacted]")
    .slice(0, 2_000);
}

async function testConnection(): Promise<{ ok: boolean; message?: string }> {
  const settings = await loadSettings();
  const controller = new AbortController();
  const testMode = "ai" as const;
  try {
    await assertProviderPermission(settings, testMode);
    const results = await translateInBackground(
      {
        sourceLanguage: "auto",
        targetLanguage: settings.page.targetLanguage,
        mode: testMode,
        segments: [{ id: "connection-test", text: "Hello" }],
        prompt: settings.provider.systemPrompt,
      },
      settings,
      controller.signal,
      { cachePolicy: "bypass" },
    );
    return {
      ok: results[0]?.translatedText.length ? true : false,
      ...(results[0]?.translatedText.length
        ? {}
        : { message: "Provider returned no translated text." }),
    };
  } catch (error) {
    return { ok: false, message: safeConnectionDiagnostic(error) };
  }
}

async function broadcastSettingsUpdated(
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Promise<void> {
  const [tabs, siteProfiles] = await Promise.all([
    browser.tabs.query({}),
    loadSiteTranslationProfiles(),
  ]);
  await Promise.allSettled(
    tabs.flatMap((tab) =>
      tab.id === undefined
        ? []
        : [
            browser.tabs.sendMessage(tab.id, {
              type: "SETTINGS_UPDATED",
              settings: effectiveContentSettings(
                settings,
                siteProfiles,
                siteLocationFromUrl(tab.url),
              ),
            }),
          ],
    ),
  );
}

function siteLocationFromUrl(
  rawUrl: string | undefined,
): { hostname: string; pathname: string } | undefined {
  if (!rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return {
      hostname: url.hostname.toLowerCase().replace(/\.$/u, ""),
      pathname: url.pathname || "/",
    };
  } catch {
    return undefined;
  }
}

function effectiveContentSettings(
  settings: AppSettings,
  siteProfiles: Awaited<ReturnType<typeof loadSiteTranslationProfiles>>,
  locationValue: ReturnType<typeof siteLocationFromUrl>,
) {
  const contentSettings = toContentSettings(settings);
  return locationValue
    ? applySiteProfileSettings(contentSettings, siteProfiles, locationValue)
    : contentSettings;
}

async function contentSettingsForSender(
  settings: AppSettings,
  sender: Browser.runtime.MessageSender,
) {
  return effectiveContentSettings(
    settings,
    await loadSiteTranslationProfiles(),
    siteLocationFromUrl(sender.tab?.url),
  );
}

async function broadcastCacheCleared(): Promise<void> {
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs.flatMap((tab) =>
      tab.id === undefined
        ? []
        : [browser.tabs.sendMessage(tab.id, { type: "CACHE_CLEARED" })],
    ),
  );
}

function mutateSettings(
  update: (current: AppSettings) => AppSettings,
): Promise<AppSettings> {
  const operation = settingsMutationTail.then(async () => {
    const updated = update(await loadSettings());
    await saveSettings(updated);
    await broadcastSettingsUpdated(updated);
    return updated;
  });
  settingsMutationTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function serializeSiteProfileMutation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const pending = siteProfileMutationTail.then(operation);
  siteProfileMutationTail = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

function updateSiteTranslationProfile(
  id: string,
  update: (
    current: Awaited<ReturnType<typeof loadSiteTranslationProfiles>>[number],
  ) => Awaited<ReturnType<typeof loadSiteTranslationProfiles>>[number],
) {
  return serializeSiteProfileMutation(async () => {
    const current = (await loadSiteTranslationProfiles()).find(
      (profile) => profile.id === id,
    );
    if (!current) throw new Error("site_translation_profile_not_found");
    return saveSiteTranslationProfile(update(current));
  });
}

async function restoreSessionHiddenFloatingControls(): Promise<{
  ok: true;
  restored: number;
}> {
  const tabs = await browser.tabs.query({});
  const results = await Promise.allSettled(
    tabs.flatMap((tab) =>
      tab.id === undefined
        ? []
        : [
            browser.tabs.sendMessage(
              tab.id,
              {
                type: "FLOATING_SESSION_SHOW",
              },
              { frameId: 0 },
            ),
          ],
    ),
  );
  const restored = results.filter((result) => {
    if (result.status !== "fulfilled") return false;
    const value: unknown = result.value;
    return isFloatingSessionShowResponse(value) && value.restored;
  }).length;
  return { ok: true, restored };
}

function verifiedContentHostname(
  sender: Browser.runtime.MessageSender,
  allowSubframe = false,
): string | undefined {
  try {
    if (
      (!allowSubframe && sender.frameId !== 0) ||
      sender.tab?.id === undefined ||
      !sender.url
    ) {
      return undefined;
    }
    const frameUrl = new URL(sender.url);
    if (frameUrl.protocol !== "https:" && frameUrl.protocol !== "http:") {
      return undefined;
    }
    if (!allowSubframe) {
      if (!sender.tab.url) return undefined;
      const tabUrl = new URL(sender.tab.url);
      if (frameUrl.origin !== tabUrl.origin) return undefined;
    }
    return frameUrl.hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return undefined;
  }
}

function allowedOcrClientSender(
  sender: Browser.runtime.MessageSender,
): boolean {
  if (sender.id !== browser.runtime.id) return false;
  if (isExtensionPageSender(sender)) return sender.url !== OCR_OFFSCREEN_URL;
  return verifiedContentHostname(sender) !== undefined;
}

function ocrFailureResponse(
  request: OcrOffscreenRequest,
  error: unknown,
): OcrOffscreenResponse {
  return {
    target: OCR_CLIENT_TARGET,
    type: "OCR_OFFSCREEN_RESPONSE",
    sessionId: request.sessionId,
    requestId: request.requestId,
    ok: false,
    error: errorMessage(error)
      .replace(/chrome-extension:\/\/[^/]+/gu, "extension:")
      .slice(0, 240),
  };
}

async function captureOcrFrame(
  sender: Browser.runtime.MessageSender,
): Promise<OcrCaptureResponse> {
  const tab = sender.tab;
  const tabId = tab?.id;
  if (
    sender.frameId !== 0 ||
    !tab ||
    tabId === undefined ||
    tab.windowId === undefined
  ) {
    return { ok: false, error: "inactive_tab" };
  }
  const [activeTab] = await browser.tabs.query({
    active: true,
    windowId: tab.windowId,
  });
  if (activeTab?.id !== tabId) {
    return { ok: false, error: "inactive_tab" };
  }
  const settings = await loadSettings();
  if (!settings.ocr.enabled) {
    return { ok: false, error: "capture_failed" };
  }
  if (!(await browser.permissions.contains({ origins: ["<all_urls>"] }))) {
    return { ok: false, error: "permission_required" };
  }
  try {
    const dataUrl = await captureOcrDataUrl(async (options) => {
      await waitForOcrCaptureSlot();
      return browser.tabs.captureVisibleTab(tab.windowId, options);
    });
    const [capturedActiveTab] = await browser.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    if (capturedActiveTab?.id !== tabId) {
      return { ok: false, error: "inactive_tab" };
    }
    if (!dataUrl || dataUrl.length > OCR_CAPTURE_MAX_DATA_URL_LENGTH) {
      return { ok: false, error: "capture_too_large" };
    }
    return { ok: true, dataUrl };
  } catch (error) {
    if (isOcrCaptureRateLimitError(error)) {
      return { ok: false, error: "rate_limited" };
    }
    return {
      ok: false,
      error: "capture_failed",
      message: errorMessage(error).slice(0, 240),
    };
  }
}

function detectedRasterMimeType(
  declaredType: string,
  bytes: Uint8Array,
): string | undefined {
  const normalized = declaredType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/avif",
      "image/bmp",
    ].includes(normalized)
  ) {
    return normalized;
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const prefix = String.fromCharCode(...bytes.subarray(0, 12));
  if (prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a")) {
    return "image/gif";
  }
  if (prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP") {
    return "image/webp";
  }
  if (prefix.startsWith("BM")) return "image/bmp";
  if (
    prefix.slice(4, 12) === "ftypavif" ||
    prefix.slice(4, 12) === "ftypavis"
  ) {
    return "image/avif";
  }
  return undefined;
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)),
    );
  }
  return btoa(chunks.join(""));
}

async function fetchImageSource(
  sourceUrl: string,
  sender: Browser.runtime.MessageSender,
): Promise<OcrCaptureResponse> {
  if (!verifiedContentHostname(sender, true)) {
    return { ok: false, error: "capture_failed" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    IMAGE_SOURCE_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(sourceUrl, {
      cache: "force-cache",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        error: "capture_failed",
        message: `image_source_http_${response.status}`,
      };
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > IMAGE_SOURCE_MAX_BYTES
    ) {
      return { ok: false, error: "capture_too_large" };
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0) {
      return {
        ok: false,
        error: "capture_failed",
        message: "image_source_empty",
      };
    }
    if (buffer.byteLength > IMAGE_SOURCE_MAX_BYTES) {
      return { ok: false, error: "capture_too_large" };
    }
    const bytes = new Uint8Array(buffer);
    const mimeType = detectedRasterMimeType(
      response.headers.get("content-type") ?? "",
      bytes,
    );
    if (!mimeType) {
      return {
        ok: false,
        error: "capture_failed",
        message: "image_source_unsupported_format",
      };
    }
    return {
      ok: true,
      dataUrl: `data:${mimeType};base64,${encodeBase64(bytes)}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: "capture_failed",
      message: errorMessage(error).slice(0, 240),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function handleBackgroundCommand(
  message: BackgroundCommand,
  sender: Browser.runtime.MessageSender,
): Promise<unknown> {
  switch (message.type) {
    case "ENSURE_PAGE_CONTENT":
      return ensurePageContent(message.tabId);
    case "CONTENT_COMMAND_BROADCAST": {
      if (sender.frameId !== 0 || sender.tab?.id === undefined) {
        throw new Error("只有顶层页面可以广播翻译命令。");
      }
      const tabId = sender.tab.id;
      if (message.command === "PAGE_RESTORE") {
        await manualTranslationIntents.deactivate(tabId);
      }
      // Stop/restore commands must reach every already-running frame without
      // waiting for version probes or reinjection. Commands that start work
      // still prepare stale/dynamic frames first.
      let targets: ContentFrameTarget[] = [];
      if (
        message.command === "SUBTITLE_CANCEL" ||
        message.command === "PAGE_RESTORE"
      ) {
        try {
          targets = await discoverCommandBroadcastFrames(tabId);
        } catch {
          // The explicit sender below retains the existing tab-wide fallback.
        }
      } else {
        targets = await prepareCommandBroadcastFrames(tabId);
      }
      await sendCommandToContentFrames({
        targets,
        send: (target) =>
          browser.tabs.sendMessage(
            tabId,
            { type: message.command },
            { documentId: target.documentId },
          ),
        fallback: () =>
          browser.tabs.sendMessage(tabId, {
            type: message.command,
          }),
      });
      return { ok: true };
    }
    case "PAGE_MANUAL_TRANSLATION_SET": {
      if (sender.frameId !== 0 || sender.tab?.id === undefined) {
        throw new Error("只有顶层页面可以更新手工网页翻译状态。");
      }
      if (message.enabled) {
        await manualTranslationIntents.activate(sender.tab.id);
      } else {
        await manualTranslationIntents.deactivate(sender.tab.id);
      }
      return { ok: true };
    }
    case "FRAME_STATUS_UPDATE": {
      if (
        sender.frameId === undefined ||
        sender.frameId <= 0 ||
        sender.tab?.id === undefined
      ) {
        throw new Error("无效的子页面状态来源。");
      }
      await browser.tabs
        .sendMessage(
          sender.tab.id,
          {
            type: "FRAME_STATUS_UPDATED",
            frameId: sender.frameId,
            frameInstanceId: message.frameInstanceId,
            pageStatus: message.pageStatus,
            subtitleStatus: message.subtitleStatus,
          },
          { frameId: 0 },
        )
        .catch(() => undefined);
      if (
        await manualTranslationIntents.frameNeedsTranslation(
          sender.tab.id,
          message.frameInstanceId,
        )
      ) {
        const target = sender.documentId
          ? { documentId: sender.documentId }
          : { frameId: sender.frameId };
        await browser.tabs
          .sendMessage(sender.tab.id, { type: "PAGE_TRANSLATE" }, target)
          .catch(() => undefined);
      }
      return { ok: true };
    }
    case "FRAME_STATUS_CLEAR": {
      if (
        sender.frameId === undefined ||
        sender.frameId <= 0 ||
        sender.tab?.id === undefined
      ) {
        throw new Error("无效的子页面状态来源。");
      }
      await browser.tabs
        .sendMessage(
          sender.tab.id,
          {
            type: "FRAME_STATUS_CLEARED",
            frameId: sender.frameId,
            frameInstanceId: message.frameInstanceId,
          },
          { frameId: 0 },
        )
        .catch(() => undefined);
      return { ok: true };
    }
    case "TRANSLATE": {
      try {
        const results = await translationRequestGate.run(
          translationBucketForTab(sender.tab?.id),
          message.requestId,
          async (signal) => {
            await cacheMutationTail;
            const requestCacheEpoch = cacheEpoch;
            const settings = await loadSettings();
            if (
              message.request.mode === "fast" &&
              (message.request.providerOverride ??
                settings.provider.fastProvider) === "bergamot-local"
            ) {
              await ensureOcrOffscreenDocument();
            }
            await assertProviderPermission(
              settings,
              message.request.mode,
              message.request.providerOverride,
            );
            return translateInBackground(message.request, settings, signal, {
              cacheWriter: {
                set: async (key, translatedText) => {
                  if (signal.aborted) return;
                  await enqueueCacheMutation(requestCacheEpoch, async () => {
                    if (signal.aborted) return;
                    await setCachedTranslation(key, translatedText);
                  });
                },
              },
              onProgress: (result) =>
                relayTranslationProgress(sender, message.requestId, result),
            });
          },
        );
        return { ok: true, results } satisfies TranslationResponse;
      } catch (error) {
        return translationError(error);
      }
    }
    case "TRANSLATE_CANCEL":
      translationRequestGate.cancel(
        translationBucketForTab(sender.tab?.id),
        message.requestId,
      );
      return { ok: true };
    case "CACHE_EPOCH_GET":
      await cacheMutationTail;
      return { ok: true, epoch: cacheEpoch };
    case "TRANSLATION_CACHE_GET": {
      const { epoch, value: translatedText } = await readCacheAtCurrentEpoch(
        () => getCachedTranslation(message.key),
      );
      return translatedText === undefined
        ? { ok: true, hit: false, epoch }
        : { ok: true, hit: true, translatedText, epoch };
    }
    case "TRANSLATION_CACHE_SET": {
      const stored = await enqueueCacheMutation(message.epoch, () =>
        setCachedTranslation(message.key, message.translatedText),
      );
      return { ok: true, stored, epoch: cacheEpoch };
    }
    case "SUBTITLE_TRACK_GET": {
      const { epoch, value: track } = await readCacheAtCurrentEpoch(() =>
        getSubtitleTrack(message.key),
      );
      return track === undefined
        ? { ok: true, hit: false, epoch }
        : { ok: true, hit: true, track, epoch };
    }
    case "SUBTITLE_TRACK_SET": {
      const stored = await enqueueCacheMutation(message.epoch, () =>
        setSubtitleTrack(message.key, message.track),
      );
      return { ok: true, stored, epoch: cacheEpoch };
    }
    case "SUBTITLE_TRACK_DELETE": {
      const stored = await enqueueCacheMutation(message.epoch, () =>
        deleteSubtitleTrack(message.key),
      );
      return { ok: true, stored, epoch: cacheEpoch };
    }
    case "PAGE_AUTO_TRANSLATE_SET": {
      await mutateSettings((settings) => ({
        ...settings,
        page: { ...settings.page, autoTranslate: message.enabled },
      }));
      return { ok: true };
    }
    case "PAGE_AUTO_TRANSLATE_SITE_SET": {
      const hostname = verifiedContentHostname(sender);
      const pattern = hostname
        ? autoTranslateSitePatternForHostname(hostname)
        : null;
      if (!pattern) {
        throw new Error("无法确认当前网页的自动翻译范围。");
      }
      const updated = await mutateSettings((settings) => ({
        ...settings,
        page: {
          ...settings.page,
          ...updateSiteAutoTranslateRules(
            settings.page,
            pattern,
            message.enabled,
          ),
        },
      }));
      return {
        ok: true,
        pattern,
        settings: toContentSettings(updated),
      };
    }
    case "PAGE_QUICK_SETTINGS_SET": {
      const locationValue = siteLocationFromUrl(sender.tab?.url);
      const profiles = await loadSiteTranslationProfiles();
      const siteProfile = locationValue
        ? resolveSiteTranslationProfile(profiles, locationValue)
        : undefined;
      if (siteProfile) {
        const currentSettings = await loadSettings();
        const effective = applySiteProfileSettings(
          toContentSettings(currentSettings),
          profiles,
          locationValue!,
        );
        await updateSiteTranslationProfile(siteProfile.id, (current) => ({
          ...current,
          overrides: {
            ...current.overrides,
            page: {
              sourceLanguage: message.sourceLanguage,
              targetLanguage: message.targetLanguage,
              mode: message.mode,
              fastProvider:
                message.fastProvider ??
                current.overrides.page?.fastProvider ??
                currentSettings.provider.fastProvider,
              modelOverride: current.overrides.page?.modelOverride ?? "",
            },
            ...(message.selectionTranslationMode
              ? {
                  selection: {
                    sourceLanguage:
                      effective.page.selectionTranslationSourceLanguage,
                    targetLanguage:
                      effective.page.selectionTranslationTargetLanguage,
                    mode: message.selectionTranslationMode,
                    fastProvider:
                      current.overrides.selection?.fastProvider ??
                      currentSettings.provider.fastProvider,
                    modelOverride:
                      current.overrides.selection?.modelOverride ??
                      effective.page.selectionTranslationModelOverride,
                  },
                }
              : {}),
          },
        }));
        const updated = await mutateSettings((settings) => ({
          ...settings,
          page: {
            ...settings.page,
            aiResponseMode:
              message.responseMode ?? settings.page.aiResponseMode,
            displayMode: message.displayMode,
            selectionTranslationEnabled:
              message.selectionTranslationEnabled ??
              settings.page.selectionTranslationEnabled,
          },
        }));
        return {
          ok: true,
          settings: await contentSettingsForSender(updated, sender),
        };
      }
      const updated = await mutateSettings((settings) => ({
        ...settings,
        provider: message.fastProvider
          ? { ...settings.provider, fastProvider: message.fastProvider }
          : settings.provider,
        page: {
          ...settings.page,
          sourceLanguage: message.sourceLanguage,
          targetLanguage: message.targetLanguage,
          mode: message.mode,
          aiResponseMode: message.responseMode ?? settings.page.aiResponseMode,
          displayMode: message.displayMode,
          selectionTranslationEnabled:
            message.selectionTranslationEnabled ??
            settings.page.selectionTranslationEnabled,
          selectionTranslationMode:
            message.selectionTranslationMode ??
            settings.page.selectionTranslationMode,
        },
      }));
      return { ok: true, settings: toContentSettings(updated) };
    }
    case "FLOATING_BUTTON_SET": {
      await mutateSettings((settings) =>
        message.surface === "all"
          ? {
              ...settings,
              page: {
                ...settings.page,
                floatingButtonEnabled: message.enabled,
              },
              subtitles: {
                ...settings.subtitles,
                floatingButtonEnabled: message.enabled,
              },
            }
          : message.surface === "page"
            ? {
                ...settings,
                page: {
                  ...settings.page,
                  floatingButtonEnabled: message.enabled,
                },
              }
            : {
                ...settings,
                subtitles: {
                  ...settings.subtitles,
                  floatingButtonEnabled: message.enabled,
                },
              },
      );
      return { ok: true };
    }
    case "FLOATING_POSITION_GET": {
      const stored = await browser.storage.local.get(
        FLOATING_POSITION_STORAGE_KEY,
      );
      const position = stored[FLOATING_POSITION_STORAGE_KEY];
      if (
        typeof position === "object" &&
        position !== null &&
        "x" in position &&
        typeof position.x === "number" &&
        Number.isFinite(position.x) &&
        position.x >= 0 &&
        position.x <= 1 &&
        "y" in position &&
        typeof position.y === "number" &&
        Number.isFinite(position.y) &&
        position.y >= 0 &&
        position.y <= 1
      ) {
        return { ok: true, position: { x: position.x, y: position.y } };
      }
      return { ok: true };
    }
    case "FLOATING_POSITION_SET":
      await browser.storage.local.set({
        [FLOATING_POSITION_STORAGE_KEY]: { x: message.x, y: message.y },
      });
      return { ok: true };
    case "FLOATING_SESSION_RESTORE":
      return restoreSessionHiddenFloatingControls();
    case "SUBTITLE_QUICK_SETTINGS_SET": {
      const locationValue = siteLocationFromUrl(sender.tab?.url);
      const profiles = await loadSiteTranslationProfiles();
      const siteProfile = locationValue
        ? resolveSiteTranslationProfile(profiles, locationValue)
        : undefined;
      if (siteProfile) {
        const currentSettings = await loadSettings();
        await updateSiteTranslationProfile(siteProfile.id, (current) => ({
          ...current,
          overrides: {
            ...current.overrides,
            subtitles: {
              sourceLanguage: message.sourceLanguage,
              targetLanguage: message.targetLanguage,
              mode: message.mode,
              fastProvider:
                message.fastProvider ??
                current.overrides.subtitles?.fastProvider ??
                currentSettings.provider.fastProvider,
              modelOverride: current.overrides.subtitles?.modelOverride ?? "",
            },
          },
        }));
        const updated = await mutateSettings((settings) => ({
          ...settings,
          subtitles: {
            ...settings.subtitles,
            aiResponseMode:
              message.responseMode ?? settings.subtitles.aiResponseMode,
            displayMode: message.displayMode,
            hideNativeSubtitles: message.hideNativeSubtitles,
            fontScale: message.fontScale ?? settings.subtitles.fontScale,
            backgroundOpacity:
              message.backgroundOpacity ?? settings.subtitles.backgroundOpacity,
          },
        }));
        return {
          ok: true,
          settings: await contentSettingsForSender(updated, sender),
        };
      }
      const updated = await mutateSettings((settings) => ({
        ...settings,
        provider: message.fastProvider
          ? { ...settings.provider, fastProvider: message.fastProvider }
          : settings.provider,
        subtitles: {
          ...settings.subtitles,
          sourceLanguage: message.sourceLanguage,
          targetLanguage: message.targetLanguage,
          mode: message.mode,
          aiResponseMode:
            message.responseMode ?? settings.subtitles.aiResponseMode,
          displayMode: message.displayMode,
          hideNativeSubtitles: message.hideNativeSubtitles,
          fontScale: message.fontScale ?? settings.subtitles.fontScale,
          backgroundOpacity:
            message.backgroundOpacity ?? settings.subtitles.backgroundOpacity,
        },
      }));
      return { ok: true, settings: toContentSettings(updated) };
    }
    case "SUBTITLE_POSITION_SET": {
      await mutateSettings((settings) => ({
        ...settings,
        subtitles: {
          ...settings.subtitles,
          position: "custom" as const,
          customPosition: { x: message.x, y: message.y },
        },
      }));
      return { ok: true };
    }
    case "OCR_SETTINGS_SET": {
      await mutateSettings((settings) => ({
        ...settings,
        subtitles: message.enabled
          ? { ...settings.subtitles, enabled: true }
          : settings.subtitles,
        ocr: {
          enabled: message.enabled,
          sourceLanguage: message.sourceLanguage,
          targetLanguage: message.targetLanguage,
          provider: message.provider,
        },
      }));
      return { ok: true };
    }
    case "IMAGE_SOURCE_GET":
      return fetchImageSource(message.url, sender);
    case "IMAGE_TRANSLATION_SETTINGS_SET": {
      const updated = await mutateSettings((settings) => ({
        ...settings,
        provider: message.fastProvider
          ? { ...settings.provider, fastProvider: message.fastProvider }
          : settings.provider,
        imageTranslation: {
          enabled: message.enabled,
          sourceLanguage: message.sourceLanguage,
          targetLanguage: message.targetLanguage,
          mode: message.mode,
          modelOverride: message.modelOverride.trim(),
          displayMode: message.displayMode,
        },
      }));
      return { ok: true, settings: toContentSettings(updated) };
    }
    case "OCR_PERMISSION_REQUEST": {
      const origins = ["<all_urls>"];
      const granted = await browser.permissions.contains({ origins });
      if (!granted) await openOcrPermissionWindow(sender.tab?.id);
      return { ok: granted, granted, requiresInteraction: !granted };
    }
    case "OCR_PERMISSION_COMPLETE": {
      if (!(await browser.permissions.contains({ origins: ["<all_urls>"] }))) {
        return { ok: false, resumed: false, error: "permission_required" };
      }
      const tabId = await takeOcrPermissionRequestTabId();
      if (tabId === undefined) return { ok: true, resumed: false };
      try {
        await browser.tabs.sendMessage(
          tabId,
          { type: "OCR_START" },
          { frameId: 0 },
        );
        return { ok: true, resumed: true };
      } catch {
        return { ok: true, resumed: false };
      }
    }
    case "OCR_RUNTIME_LIST":
      return { ok: true, runtimes: await listOcrRuntimes() };
    case "OCR_RUNTIME_DOWNLOAD":
      await assertOcrRuntimeDownloadPermission();
      await installOcrRuntimePack(message.pack);
      return { ok: true };
    case "OCR_RUNTIME_DOWNLOAD_ALL":
      await assertOcrRuntimeDownloadPermission();
      await installAllMissingOcrRuntimes();
      return { ok: true };
    case "OCR_RUNTIME_DELETE":
      if ((await deleteOcrRuntimePack(message.pack)).physicalPackDeleted) {
        await invalidateLoadedOcrRuntime(message.pack);
      }
      return { ok: true };
    case "LOCAL_TRANSLATION_RUNTIME_LIST":
      return { ok: true, runtimes: await listLocalTranslationRuntimes() };
    case "LOCAL_TRANSLATION_RUNTIME_DOWNLOAD":
      await assertLocalTranslationRuntimePermission();
      await installLocalTranslationRuntime(message.packId);
      invalidateLocalTranslationModelIdentity();
      await resetLoadedLocalTranslationRuntime();
      return { ok: true };
    case "LOCAL_TRANSLATION_RUNTIME_DELETE":
      await deleteLocalTranslationRuntime(message.packId);
      invalidateLocalTranslationModelIdentity();
      await resetLoadedLocalTranslationRuntime();
      return { ok: true };
    case "SITE_PROFILES_GET": {
      if (isExtensionPageSender(sender)) {
        const [profiles, overrides, translationProfiles] = await Promise.all([
          loadUserSiteProfiles(),
          loadSiteProfileOverrides(),
          loadSiteTranslationProfiles(),
        ]);
        return {
          ok: true,
          builtIns: BUILT_IN_SITE_PROFILES,
          profiles,
          overrides,
          translationProfiles,
        };
      }
      const hostname = verifiedContentHostname(sender, true);
      if (!hostname) throw new Error("无法确认当前字幕 Profile 的网站范围。");
      const profiles = await loadRuntimeSiteProfiles();
      return {
        ok: true,
        profiles: profiles.filter((profile) =>
          profileMatchesHostname(profile, hostname),
        ),
      };
    }
    case "SITE_PROFILE_SAVE": {
      if (isExtensionPageSender(sender)) {
        throw new Error("请从目标视频网站打开字幕采集向导。");
      }
      const expectedHostname = verifiedContentHostname(sender);
      if (!expectedHostname) {
        throw new Error("无法确认当前字幕 Profile 的网站范围。");
      }
      await saveUserSiteProfile(message.profile, expectedHostname);
      return { ok: true };
    }
    case "SITE_PROFILE_DELETE":
      await deleteUserSiteProfile(message.id);
      return { ok: true };
    case "SITE_PROFILE_EDITOR_SAVE": {
      if (!isExtensionPageSender(sender)) {
        return { ok: false, error: "private_settings" };
      }
      try {
        const saved = await saveEditableSiteProfile(message.profile);
        return { ok: true, ...saved };
      } catch (error) {
        if (error instanceof SiteProfileValidationError) {
          return {
            ok: false,
            error: "site_profile_invalid",
            path: error.path,
            reason: error.reason,
          };
        }
        throw error;
      }
    }
    case "SITE_PROFILE_EDITOR_DELETE":
      if (!isExtensionPageSender(sender)) {
        return { ok: false, error: "private_settings" };
      }
      await deleteUserSiteProfile(message.id);
      return { ok: true };
    case "SITE_PROFILE_OVERRIDE_RESTORE":
      if (!isExtensionPageSender(sender)) {
        return { ok: false, error: "private_settings" };
      }
      await deleteSiteProfileOverride(message.id);
      return { ok: true };
    case "SITE_TRANSLATION_PROFILE_SAVE": {
      if (!isExtensionPageSender(sender)) {
        return { ok: false, error: "private_settings" };
      }
      try {
        const profile = await serializeSiteProfileMutation(() =>
          saveSiteTranslationProfile(message.profile),
        );
        await broadcastSettingsUpdated(await loadSettings());
        return { ok: true, profile };
      } catch (error) {
        if (error instanceof SiteProfileValidationError) {
          return {
            ok: false,
            error: "site_profile_invalid",
            path: error.path,
            reason: error.reason,
          };
        }
        throw error;
      }
    }
    case "SITE_TRANSLATION_PROFILE_DELETE":
      if (!isExtensionPageSender(sender)) {
        return { ok: false, error: "private_settings" };
      }
      await serializeSiteProfileMutation(() =>
        deleteSiteTranslationProfile(message.id),
      );
      await broadcastSettingsUpdated(await loadSettings());
      return { ok: true };
    case "SETTINGS_GET":
      return loadSettings();
    case "CONTENT_SETTINGS_GET": {
      const settings = await loadSettings();
      return contentSettingsForSender(settings, sender);
    }
    case "UPDATE_STATUS_GET":
      return getUpdateStatus();
    case "UPDATE_CHECK":
      return checkForUpdates(true);
    case "UPDATE_AUTO_CHECK_SET":
      return setAutomaticUpdateChecks(message.enabled);
    case "UPDATE_IGNORE":
      return ignoreUpdate(message.version);
    case "SETTINGS_SET":
      await mutateSettings(() => mergeSettings(message.settings));
      return { ok: true };
    case "TEST_CONNECTION":
      return testConnection();
    case "CREDENTIALS_CLEAR": {
      await mutateSettings((settings) => ({
        ...settings,
        provider: {
          ...settings.provider,
          apiKey: "",
          googleApiKey: "",
          microsoftApiKey: "",
          deeplApiKey: "",
        },
      }));
      return { ok: true };
    }
    case "CACHE_CLEAR": {
      cacheEpoch += 1;
      const clearOperation = enqueueCacheMutation(cacheEpoch, clearCache);
      translationRequestGate.cancelAll();
      await broadcastCacheCleared();
      await clearOperation;
      return { ok: true };
    }
    case "CACHE_STATS":
      return cacheStats();
  }
}

function commandAllowedFromContentScript(command: BackgroundCommand): boolean {
  return (
    command.type === "CONTENT_COMMAND_BROADCAST" ||
    command.type === "PAGE_MANUAL_TRANSLATION_SET" ||
    command.type === "FRAME_STATUS_UPDATE" ||
    command.type === "FRAME_STATUS_CLEAR" ||
    command.type === "TRANSLATE" ||
    command.type === "TRANSLATE_CANCEL" ||
    command.type === "CACHE_EPOCH_GET" ||
    command.type === "TRANSLATION_CACHE_GET" ||
    command.type === "TRANSLATION_CACHE_SET" ||
    command.type === "SUBTITLE_TRACK_GET" ||
    command.type === "SUBTITLE_TRACK_SET" ||
    command.type === "SUBTITLE_TRACK_DELETE" ||
    command.type === "CONTENT_SETTINGS_GET" ||
    command.type === "UPDATE_STATUS_GET" ||
    command.type === "UPDATE_IGNORE" ||
    command.type === "PAGE_AUTO_TRANSLATE_SET" ||
    command.type === "PAGE_AUTO_TRANSLATE_SITE_SET" ||
    command.type === "PAGE_QUICK_SETTINGS_SET" ||
    command.type === "FLOATING_BUTTON_SET" ||
    command.type === "FLOATING_POSITION_GET" ||
    command.type === "FLOATING_POSITION_SET" ||
    command.type === "SUBTITLE_QUICK_SETTINGS_SET" ||
    command.type === "SUBTITLE_POSITION_SET" ||
    command.type === "OCR_SETTINGS_SET" ||
    command.type === "IMAGE_SOURCE_GET" ||
    command.type === "IMAGE_TRANSLATION_SETTINGS_SET" ||
    command.type === "LOCAL_TRANSLATION_RUNTIME_LIST" ||
    command.type === "OCR_PERMISSION_REQUEST" ||
    command.type === "SITE_PROFILES_GET" ||
    command.type === "SITE_PROFILE_SAVE"
  );
}

function isExtensionPageSender(sender: Browser.runtime.MessageSender): boolean {
  return sender.url?.startsWith(browser.runtime.getURL("")) === true;
}

export default defineBackground(() => {
  void refreshOpenPageContentScripts().catch(() => undefined);
  void initializeUpdateChecker().catch(() => undefined);
  browser.runtime.onInstalled.addListener(() => {
    void refreshOpenPageContentScripts().catch(() => undefined);
    void initializeUpdateChecker().catch(() => undefined);
  });
  browser.runtime.onStartup.addListener(() => {
    void refreshOpenPageContentScripts().catch(() => undefined);
    void initializeUpdateChecker().catch(() => undefined);
  });
  browser.permissions.onRemoved.addListener((removed) => {
    if (!removed.origins?.includes("<all_urls>")) return;
    void mutateSettings((settings) =>
      settings.ocr.enabled
        ? {
            ...settings,
            ocr: { ...settings.ocr, enabled: false },
          }
        : settings,
    ).catch(() => undefined);
  });
  browser.windows.onRemoved.addListener((windowId) => {
    if (windowId !== ocrPermissionWindowId) return;
    ocrPermissionWindowId = undefined;
    clearOcrPermissionRequestTabId();
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    translationRequestGate.cancelBucket(translationBucketForTab(tabId));
    void manualTranslationIntents.deactivate(tabId).catch(() => undefined);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!isFullDocumentNavigationUpdate(changeInfo)) return;
    void manualTranslationIntents.deactivate(tabId).catch(() => undefined);
  });
  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (isOcrCaptureRequest(message)) {
        if (!allowedOcrClientSender(sender)) {
          sendResponse({ ok: false, error: "capture_failed" });
          return false;
        }
        void captureOcrFrame(sender).then(sendResponse, (error: unknown) => {
          sendResponse({
            ok: false,
            error: "capture_failed",
            message: errorMessage(error).slice(0, 240),
          });
        });
        return true;
      }
      if (
        sender.id === browser.runtime.id &&
        sender.url === OCR_OFFSCREEN_URL &&
        isOcrOffscreenProgress(message, OCR_BACKGROUND_TARGET)
      ) {
        void relayOcrProgress(message).catch(() => undefined);
        return undefined;
      }
      if (isOcrOffscreenRequest(message, OCR_BACKGROUND_TARGET)) {
        if (!allowedOcrClientSender(sender)) {
          sendResponse(ocrFailureResponse(message, "ocr_sender_rejected"));
          return false;
        }
        const key = ocrRequestKey(message.sessionId, message.requestId);
        ocrProgressRoutes.set(
          key,
          sender.tab?.id === undefined
            ? {}
            : { tabId: sender.tab.id, frameId: sender.frameId ?? 0 },
        );
        const operation =
          message.type === "OCR_OFFSCREEN_PREPARE"
            ? assertOcrPrepareRuntimesInstalled(message.sourceLanguage).then(
                () => forwardOcrOffscreenRequest(message),
              )
            : forwardOcrOffscreenRequest(message);
        void operation
          .then(sendResponse, (error: unknown) =>
            sendResponse(ocrFailureResponse(message, error)),
          )
          .finally(() => ocrProgressRoutes.delete(key));
        return true;
      }
      if (isOcrOffscreenRequest(message, OCR_OFFSCREEN_TARGET)) {
        // The background emitted this request for the offscreen listener.
        return undefined;
      }
      if (shouldRejectMalformedOcrBackgroundMessage(message)) {
        sendResponse({ ok: false, error: "ocr_invalid_request" });
        return false;
      }
      if (!isBackgroundCommand(message)) return undefined;
      if (
        !isExtensionPageSender(sender) &&
        !commandAllowedFromContentScript(message)
      ) {
        sendResponse({
          ok: false,
          error: "当前页面无权访问扩展私有设置。",
        });
        return false;
      }
      void handleBackgroundCommand(message, sender).then(
        sendResponse,
        (error: unknown) => {
          sendResponse(
            message.type === "LOCAL_TRANSLATION_RUNTIME_DOWNLOAD" ||
              message.type === "LOCAL_TRANSLATION_RUNTIME_DELETE"
              ? localTranslationRuntimeFailureResponse(error)
              : { ok: false, error: safeRuntimeErrorToken(error) },
          );
        },
      );
      return true;
    },
  );

  browser.commands.onCommand.addListener((command) => {
    if (command !== "translate-page" && command !== "restore-page") return;
    void browser.tabs
      .query({ active: true, currentWindow: true })
      .then(async ([tab]) => {
        if (tab?.id === undefined) return;
        const ready = await ensurePageContent(tab.id);
        if (!ready.ok) return;
        await browser.tabs.sendMessage(tab.id, {
          type:
            command === "translate-page" ? "PAGE_TRANSLATE" : "PAGE_RESTORE",
        });
      });
  });
});
