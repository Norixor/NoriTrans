import {
  deleteSharedSubtitleTrack,
  getSharedCachedTranslation,
  getSharedSubtitleTrack,
  invalidateSharedCacheLeases,
  setSharedCachedTranslation,
  setSharedSubtitleTrack,
} from "@/src/cache/content-client";
import { sha256 } from "@/src/cache/keys";
import {
  isContentSettings,
  type ContentCommand,
  type PageStatus,
  type SubtitleStatus,
} from "@/src/messaging/protocol";
import { PageTranslationSession } from "@/src/page/session";
import { pageRouteKey } from "@/src/page/navigation";
import { SelectionTranslation } from "@/src/page/selection-translation";
import {
  aggregatePageStatuses,
  aggregateSubtitleStatuses,
} from "@/src/frames/status";
import { OcrSession } from "@/src/ocr/session";
import { OcrSubtitleAdapter } from "@/src/ocr/subtitle-adapter";
import { ImageTranslationController } from "@/src/image-translation/controller";
import type {
  ContentSettings,
  SubtitleCustomPosition,
  SubtitleSettings,
} from "@/src/shared/settings";
import { isSiteAutoTranslateEnabled } from "@/src/shared/auto-translate-sites";
import {
  configureUiLanguage,
  message as localizedMessage,
} from "@/src/shared/i18n";
import {
  localizeRuntimeError,
  runtimeErrorToken,
  safeRuntimeErrorToken,
} from "@/src/shared/runtime-errors";
import { runtimeId } from "@/src/shared/runtime-id";
import { removeStaleRuntimeUi } from "@/src/shared/runtime-ui-cleanup";
import {
  UnifiedFloatingControl,
  type UnifiedFloatingControlOptions,
} from "@/src/shared/unified-floating-control";
import { createSubtitleAdapters } from "@/src/subtitles/adapters";
import { SUBTITLE_DISCOVERY_CONTROL_EVENT } from "@/src/subtitles/adapters/captured";
import { ProfileDomSubtitleAdapter } from "@/src/subtitles/adapters/profile-dom";
import {
  SubtitleController,
  subtitlePromptVersion,
  type SubtitleTaskStore,
} from "@/src/subtitles/controller";
import type { SubtitleTrack } from "@/src/subtitles/types";
import { NativeSubtitleVisibility } from "@/src/subtitles/native-visibility";
import { SubtitleProfileWizard } from "@/src/subtitles/profile-wizard";
import {
  builtInSiteProfile,
  effectiveBuiltInSiteProfiles,
  isBuiltInProfileOverride,
  isEditableSiteProfile,
  isOcrOnlySubtitleLocation,
  isUserSiteProfile,
  profileMatchesLocation,
} from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import { MAIN_WORLD_CAPTURE_PROFILE_IDS } from "@/src/subtitles/profiles/catalog";
import { queryDocumentTranslationCapabilities } from "@/src/translation/provider-capabilities";
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
import { injectScript } from "wxt/utils/inject-script";

declare global {
  interface Window {
    __norixorTransVideoReady?: boolean;
  }
}

function isMainWorldCapturePage(locationValue: Location = location): boolean {
  return MAIN_WORLD_CAPTURE_PROFILE_IDS.some((id) =>
    profileMatchesLocation(builtInSiteProfile(id), locationValue),
  );
}

let mainWorldHookInjection: Promise<boolean> | undefined;

async function ensureMainWorldCaptureHook(): Promise<boolean> {
  if (!isMainWorldCapturePage()) return false;
  if (!mainWorldHookInjection) {
    mainWorldHookInjection = injectScript("/video-main-world.js")
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        mainWorldHookInjection = undefined;
      });
  }
  return mainWorldHookInjection;
}

function providerCacheContext(settings: ContentSettings) {
  return {
    fastProviderId:
      settings.subtitles.fastProviderOverride ?? settings.provider.fastProvider,
    aiProviderId: settings.provider.aiProvider,
    baseUrl: [
      settings.provider.baseUrl,
      settings.provider.microsoftRegion,
      settings.provider.deeplPlan,
    ].join("\u001f"),
    model: settings.subtitles.modelOverride?.trim() || settings.provider.model,
    promptVersion: subtitlePromptVersion(settings.provider.systemPrompt),
  };
}

async function loadContentSettings(): Promise<ContentSettings> {
  const value: unknown = await browser.runtime.sendMessage({
    type: "CONTENT_SETTINGS_GET",
  });
  if (!isContentSettings(value))
    throw new Error(runtimeErrorToken("content_settings_unavailable"));
  return value;
}

function currentPageAutoTranslate(settings: ContentSettings): boolean {
  return isSiteAutoTranslateEnabled(settings.page, location.hostname);
}

function withSubtitleCustomPosition(
  settings: ContentSettings,
  position: SubtitleCustomPosition,
): ContentSettings {
  return {
    ...settings,
    subtitles: {
      ...settings.subtitles,
      position: "custom",
      customPosition: { ...position },
    },
  };
}

async function loadSiteProfiles(): Promise<SubtitleSiteProfile[]> {
  let value: unknown;
  try {
    value = await browser.runtime.sendMessage({ type: "SITE_PROFILES_GET" });
  } catch {
    return [];
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("ok" in value) ||
    value.ok !== true ||
    !("profiles" in value) ||
    !Array.isArray(value.profiles)
  ) {
    return [];
  }
  return value.profiles.filter((profile): profile is SubtitleSiteProfile =>
    isEditableSiteProfile(profile),
  );
}

function nativeCaptionSelectorsForLocation(
  profiles: readonly SubtitleSiteProfile[],
): string[] {
  if (isOcrOnlySubtitleLocation(location)) return [];
  return [
    ...new Set([
      ...profiles
        .filter((profile) => isUserSiteProfile(profile))
        .filter((profile) => profileMatchesLocation(profile, location))
        .flatMap((profile) => profile.selectors.nativeCaptions),
    ]),
  ];
}

function effectiveBuiltInNativeCaptionSelectorsForLocation(
  profiles: readonly SubtitleSiteProfile[],
): string[] {
  if (isOcrOnlySubtitleLocation(location)) return [];
  return [
    ...new Set(
      effectiveBuiltInSiteProfiles(profiles.filter(isBuiltInProfileOverride))
        .filter((profile) => profileMatchesLocation(profile, location))
        .flatMap((profile) => profile.selectors.nativeCaptions),
    ),
  ];
}

function createSubtitleCache() {
  return {
    get: async (key: string) => getSharedCachedTranslation(await sha256(key)),
    set: async (key: string, translatedText: string) =>
      setSharedCachedTranslation(await sha256(key), translatedText),
  };
}

function createSubtitleTaskStore(): SubtitleTaskStore {
  return {
    getTrack: async (key: string) => getSharedSubtitleTrack(await sha256(key)),
    setTrack: async (key: string, track: SubtitleTrack) =>
      setSharedSubtitleTrack(await sha256(key), track),
    deleteTrack: async (key: string) =>
      deleteSharedSubtitleTrack(await sha256(key)),
  };
}

function isContentCommand(value: unknown): value is ContentCommand {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function setSubtitleDiscoveryEnabled(
  enabled: boolean,
  sourceLanguage: string,
): void {
  if (enabled && !isMainWorldCapturePage()) return;
  window.dispatchEvent(
    new CustomEvent(SUBTITLE_DISCOVERY_CONTROL_EVENT, {
      detail: { enabled, sourceLanguage },
    }),
  );
}

function successfulResponse(value: unknown): value is { ok: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

function localizedRuntimeMessage(value: unknown): string {
  return localizeRuntimeError(value, localizedMessage);
}

function pageTranslationConfigurationChanged(
  previous: ContentSettings,
  next: ContentSettings,
): boolean {
  return (
    previous.page.sourceLanguage !== next.page.sourceLanguage ||
    previous.page.targetLanguage !== next.page.targetLanguage ||
    previous.page.mode !== next.page.mode ||
    previous.page.aiResponseMode !== next.page.aiResponseMode ||
    previous.page.displayMode !== next.page.displayMode ||
    previous.page.fastProviderOverride !== next.page.fastProviderOverride ||
    previous.page.modelOverride !== next.page.modelOverride ||
    previous.provider.fastProvider !== next.provider.fastProvider ||
    previous.provider.aiProvider !== next.provider.aiProvider ||
    previous.provider.baseUrl !== next.provider.baseUrl ||
    previous.provider.model !== next.provider.model ||
    previous.provider.systemPrompt !== next.provider.systemPrompt ||
    previous.provider.timeoutMs !== next.provider.timeoutMs
  );
}

function listenForHistoryEntryChanges(listener: EventListener): () => void {
  const navigation = (window as Window & { navigation?: EventTarget })
    .navigation;
  navigation?.addEventListener("currententrychange", listener);
  return () => navigation?.removeEventListener("currententrychange", listener);
}

function localizePageStatus(status: PageStatus): PageStatus {
  return status.message
    ? { ...status, message: localizedRuntimeMessage(status.message) }
    : status;
}

export function shouldHideNativeSubtitles(
  settings: SubtitleSettings,
  status: SubtitleStatus,
  overlayVisible: boolean,
): boolean {
  if (!settings.enabled || !settings.hideNativeSubtitles) return false;
  // Keep the site's caption layer hidden while a newly mounted or replaced
  // player is still being discovered. Toggling it back on during this short
  // state exposes one native cue before the translated overlay resumes.
  if (status.state === "waiting") return true;
  if (!["translating", "ready", "partial"].includes(status.state)) {
    return false;
  }
  // Once a task owns the caption surface, keep the website layer hidden across
  // cue gaps in every display mode. Bilingual/original text comes from our own
  // synchronized overlay; exposing the website cue while translation catches
  // up causes the native subtitle to flash for a few frames.
  return status.total > 0 || overlayVisible;
}

interface ChildFrameStatusRecord {
  frameInstanceId: string;
  pageStatus: PageStatus;
  subtitleStatus: SubtitleStatus;
  updatedAt: number;
}

const CHILD_FRAME_STATUS_TTL_MS = 5_000;
const CLEARED_FRAME_INSTANCE_TTL_MS = 30_000;

/** Tracks child-frame state visible to the top frame and rejects late updates from disposed instances. */
export class ChildFrameStatusStore {
  private readonly statuses = new Map<number, ChildFrameStatusRecord>();
  private readonly clearedInstances = new Map<string, number>();

  private instanceKey(frameId: number, frameInstanceId: string): string {
    return `${frameId}\u001f${frameInstanceId}`;
  }

  update(
    frameId: number,
    frameInstanceId: string,
    pageStatus: PageStatus,
    subtitleStatus: SubtitleStatus,
    now = Date.now(),
  ): boolean {
    this.prune(now);
    const instanceKey = this.instanceKey(frameId, frameInstanceId);
    if (this.clearedInstances.has(instanceKey)) return false;
    const current = this.statuses.get(frameId);
    if (current && current.frameInstanceId !== frameInstanceId) {
      this.clearedInstances.set(
        this.instanceKey(frameId, current.frameInstanceId),
        now,
      );
    }
    this.statuses.set(frameId, {
      frameInstanceId,
      pageStatus,
      subtitleStatus,
      updatedAt: now,
    });
    return true;
  }

  clear(frameId: number, frameInstanceId: string, now = Date.now()): boolean {
    this.clearedInstances.set(this.instanceKey(frameId, frameInstanceId), now);
    const current = this.statuses.get(frameId);
    if (current?.frameInstanceId !== frameInstanceId) return false;
    this.statuses.delete(frameId);
    return true;
  }

  prune(now = Date.now()): void {
    const statusCutoff = now - CHILD_FRAME_STATUS_TTL_MS;
    for (const [frameId, status] of this.statuses) {
      if (status.updatedAt < statusCutoff) this.statuses.delete(frameId);
    }
    const tombstoneCutoff = now - CLEARED_FRAME_INSTANCE_TTL_MS;
    for (const [key, clearedAt] of this.clearedInstances) {
      if (clearedAt < tombstoneCutoff) this.clearedInstances.delete(key);
    }
  }

  values(): ChildFrameStatusRecord[] {
    return [...this.statuses.values()];
  }

  clearStatuses(): void {
    this.statuses.clear();
  }
}

async function runEmbeddedFrame(
  initialSettings: ContentSettings,
  registerCleanup: (cleanup: () => void) => void,
): Promise<void> {
  let settings = initialSettings;
  const siteProfiles = await loadSiteProfiles();
  const nativeSubtitleVisibility = new NativeSubtitleVisibility(
    nativeCaptionSelectorsForLocation(siteProfiles),
    effectiveBuiltInNativeCaptionSelectorsForLocation(siteProfiles),
  );
  let pageStatus: PageStatus = {
    state: "idle",
    total: 0,
    completed: 0,
    failed: 0,
  };
  let subtitleStatus: SubtitleStatus = {
    state: "unavailable",
    total: 0,
    completed: 0,
    failed: 0,
  };
  let frameInstanceId = runtimeId("frame");
  let frameStatusCleared = false;
  let reportTimer: number | undefined;
  const clearFrameStatus = (): void => {
    if (frameStatusCleared) return;
    frameStatusCleared = true;
    if (reportTimer !== undefined) {
      window.clearTimeout(reportTimer);
      reportTimer = undefined;
    }
    void browser.runtime
      .sendMessage({
        type: "FRAME_STATUS_CLEAR",
        frameInstanceId,
      })
      .catch(() => undefined);
  };
  const reportStatus = (): void => {
    if (frameStatusCleared) return;
    if (reportTimer !== undefined) window.clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => {
      reportTimer = undefined;
      if (frameStatusCleared) return;
      void browser.runtime
        .sendMessage({
          type: "FRAME_STATUS_UPDATE",
          frameInstanceId,
          pageStatus,
          subtitleStatus,
        })
        .catch(() => undefined);
    }, 50);
  };
  const handleFramePageHide = (): void => clearFrameStatus();
  const handleFramePageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted) return;
    frameInstanceId = runtimeId("frame");
    frameStatusCleared = false;
    reportStatus();
  };
  window.addEventListener("pagehide", handleFramePageHide);
  window.addEventListener("pageshow", handleFramePageShow);
  let subtitleOverlayVisible = false;
  const syncNativeSubtitleVisibility = (): void => {
    nativeSubtitleVisibility.update(
      shouldHideNativeSubtitles(
        settings.subtitles,
        subtitleStatus,
        subtitleOverlayVisible,
      ),
    );
  };
  const pageSession = new PageTranslationSession((status) => {
    pageStatus = localizePageStatus(status);
    reportStatus();
  });
  const selectionTranslation = new SelectionTranslation(settings);
  const controller = new SubtitleController({
    settings: settings.subtitles,
    adapters: createSubtitleAdapters(siteProfiles, location),
    providerCacheContext: providerCacheContext(settings),
    providerSettings: settings.provider,
    cache: createSubtitleCache(),
    taskStore: createSubtitleTaskStore(),
    onStatus: (status) => {
      subtitleStatus = status;
      syncNativeSubtitleVisibility();
      reportStatus();
    },
    onCueVisibilityChange: (visible) => {
      subtitleOverlayVisible = visible;
      syncNativeSubtitleVisibility();
    },
    onVideoChange: (video) => nativeSubtitleVisibility.setVideo(video),
    onPositionChange: async (position) => {
      const response: unknown = await browser.runtime.sendMessage({
        type: "SUBTITLE_POSITION_SET",
        x: position.x,
        y: position.y,
      });
      if (!successfulResponse(response)) {
        throw new Error(runtimeErrorToken("settings_save_failed"));
      }
      settings = withSubtitleCustomPosition(settings, position);
    },
  });
  let pageFollowsNavigation = false;
  const translatePage = (followNavigation = pageFollowsNavigation): void => {
    pageFollowsNavigation = followNavigation;
    void pageSession.translate(settings);
  };

  void controller.start().catch(() => {
    subtitleStatus = {
      state: "error",
      total: 0,
      completed: 0,
      failed: 0,
    };
    syncNativeSubtitleVisibility();
    reportStatus();
  });
  setSubtitleDiscoveryEnabled(
    settings.subtitles.enabled,
    settings.subtitles.sourceLanguage,
  );
  subtitleStatus = controller.getStatus();
  syncNativeSubtitleVisibility();
  reportStatus();

  if (currentPageAutoTranslate(settings)) {
    if (document.body) translatePage(true);
    else
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          if (currentPageAutoTranslate(settings)) translatePage(true);
        },
        { once: true },
      );
  }

  let previousPageUrl = pageRouteKey();
  let navigationTimer: number | undefined;
  const handleNavigation = (): void => {
    const nextPageUrl = pageRouteKey();
    if (nextPageUrl === previousPageUrl) return;
    previousPageUrl = nextPageUrl;
    const shouldRestart =
      pageFollowsNavigation || currentPageAutoTranslate(settings);
    pageSession.restore();
    setSubtitleDiscoveryEnabled(false, settings.subtitles.sourceLanguage);
    controller.replaceAdapters(createSubtitleAdapters(siteProfiles, location));
    nativeSubtitleVisibility.updateAdditionalSelectors(
      nativeCaptionSelectorsForLocation(siteProfiles),
      effectiveBuiltInNativeCaptionSelectorsForLocation(siteProfiles),
    );
    void ensureMainWorldCaptureHook().then((installed) => {
      if (installed) {
        setSubtitleDiscoveryEnabled(
          settings.subtitles.enabled,
          settings.subtitles.sourceLanguage,
        );
      }
    });
    if (navigationTimer !== undefined) window.clearTimeout(navigationTimer);
    if (shouldRestart) {
      navigationTimer = window.setTimeout(
        () => translatePage(shouldRestart),
        350,
      );
    }
  };
  window.addEventListener("popstate", handleNavigation);
  window.addEventListener("hashchange", handleNavigation);
  window.addEventListener("yt-navigate-start", handleNavigation);
  window.addEventListener("yt-navigate-finish", handleNavigation);
  const stopHistoryEntryChanges =
    listenForHistoryEntryChanges(handleNavigation);
  const maintenanceTimer = window.setInterval(() => {
    handleNavigation();
    nativeSubtitleVisibility.refresh();
    reportStatus();
  }, 2_000);

  const videoObserver = new MutationObserver((records) => {
    if (
      records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof HTMLVideoElement ||
            (node instanceof Element && node.querySelector("video") !== null),
        ),
      )
    ) {
      controller.refreshMedia();
    }
  });
  videoObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  const handleCommand = (message: ContentCommand): unknown => {
    switch (message.type) {
      case "CONTENT_RUNTIME_INFO":
        return { version: browser.runtime.getManifest().version };
      case "TRANSLATION_CAPABILITIES_GET":
        return queryDocumentTranslationCapabilities().then((capabilities) => ({
          ok: true,
          capabilities,
        }));
      case "PAGE_TRANSLATE":
        translatePage(true);
        return pageStatus;
      case "PAGE_AUTO_TRANSLATE_CURRENT":
        translatePage(true);
        return pageStatus;
      case "PAGE_RESTORE":
        pageFollowsNavigation = false;
        pageStatus = pageSession.restore();
        reportStatus();
        return pageStatus;
      case "PAGE_STATUS":
        return pageStatus;
      case "CACHE_CLEARED":
        invalidateSharedCacheLeases();
        pageStatus = pageSession.handleCacheCleared();
        if (subtitleStatus.state === "translating") {
          subtitleStatus = controller.cancelTranslationTask();
        }
        syncNativeSubtitleVisibility();
        reportStatus();
        return { ok: true };
      case "SUBTITLE_STATUS":
        return subtitleStatus;
      case "SUBTITLE_START":
        void controller.startTranslationTask().catch(() => undefined);
        return controller.getStatus();
      case "SUBTITLE_RETRY_FAILED":
        void controller.retryFailed().catch(() => undefined);
        return controller.getStatus();
      case "SUBTITLE_CANCEL":
        return controller.cancelTranslationTask();
      case "SETTINGS_UPDATED": {
        const previousSettings = settings;
        const languageChanged =
          previousSettings.uiLanguage !== message.settings.uiLanguage;
        settings = message.settings;
        if (languageChanged) configureUiLanguage(settings.uiLanguage);
        const wasAutomaticPageSession = pageFollowsNavigation;
        if (
          currentPageAutoTranslate(previousSettings) &&
          !currentPageAutoTranslate(settings)
        ) {
          pageFollowsNavigation = false;
          if (navigationTimer !== undefined) {
            window.clearTimeout(navigationTimer);
            navigationTimer = undefined;
          }
          if (wasAutomaticPageSession) {
            pageSession.stopFollowingDynamicContent();
          }
        } else if (
          !currentPageAutoTranslate(previousSettings) &&
          currentPageAutoTranslate(settings) &&
          pageSession.getStatus().state !== "idle"
        ) {
          pageFollowsNavigation = true;
          pageSession.resumeFollowingDynamicContent();
        }
        pageSession.updateSettings(settings);
        selectionTranslation.updateSettings(settings);
        if (languageChanged) selectionTranslation.refreshLocale();
        setSubtitleDiscoveryEnabled(
          settings.subtitles.enabled,
          settings.subtitles.sourceLanguage,
        );
        controller.updateSettings(
          settings.subtitles,
          providerCacheContext(settings),
          settings.provider,
        );
        if (languageChanged) controller.refreshLocale();
        subtitleStatus = controller.getStatus();
        syncNativeSubtitleVisibility();
        if (
          pageSession.getStatus().state !== "idle" &&
          pageTranslationConfigurationChanged(previousSettings, settings)
        ) {
          pageSession.restore();
          translatePage();
        }
        reportStatus();
        return { ok: true };
      }
      case "FLOATING_SESSION_SHOW":
        return { ok: true, restored: false };
      default:
        return undefined;
    }
  };
  const handleMessage = (
    message: unknown,
    _sender: Browser.runtime.MessageSender,
    sendResponse: (response?: unknown) => void,
  ): true | undefined => {
    if (!isContentCommand(message)) return undefined;
    void Promise.resolve(handleCommand(message)).then(sendResponse, () =>
      sendResponse({ ok: false }),
    );
    return true;
  };
  browser.runtime.onMessage.addListener(handleMessage);

  registerCleanup(() => {
    clearFrameStatus();
    setSubtitleDiscoveryEnabled(false, settings.subtitles.sourceLanguage);
    if (reportTimer !== undefined) window.clearTimeout(reportTimer);
    if (navigationTimer !== undefined) window.clearTimeout(navigationTimer);
    window.clearInterval(maintenanceTimer);
    window.removeEventListener("popstate", handleNavigation);
    window.removeEventListener("hashchange", handleNavigation);
    window.removeEventListener("yt-navigate-start", handleNavigation);
    window.removeEventListener("yt-navigate-finish", handleNavigation);
    stopHistoryEntryChanges();
    window.removeEventListener("pagehide", handleFramePageHide);
    window.removeEventListener("pageshow", handleFramePageShow);
    videoObserver.disconnect();
    browser.runtime.onMessage.removeListener(handleMessage);
    pageSession.restore();
    selectionTranslation.destroy();
    controller.stop();
    nativeSubtitleVisibility.destroy();
    window.__norixorTransVideoReady = false;
  });
}

export default defineContentScript({
  matches: ["https://*/*", "http://*/*"],
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: true,
  runAt: "document_start",
  async main(context) {
    if (window.__norixorTransVideoReady) return;
    removeStaleRuntimeUi();
    // The helper is also ensured after same-document route changes below.
    // Repeated injection is safe because the MAIN-world script owns an
    // installation flag and preserves the page's original fetch/XHR behavior.
    await ensureMainWorldCaptureHook();

    let settings = await loadContentSettings();
    configureUiLanguage(settings.uiLanguage);
    if (window.__norixorTransVideoReady) return;
    window.__norixorTransVideoReady = true;
    if (window.top !== window) {
      await runEmbeddedFrame(settings, (cleanup) =>
        context.onInvalidated(cleanup),
      );
      return;
    }
    let siteProfiles = await loadSiteProfiles();
    let profileWizard: SubtitleProfileWizard | undefined;
    const floatingHiddenKey = (): string =>
      `norixortrans.unified-widget-hidden:${location.href.split("#", 1)[0] ?? location.href}`;
    const floatingHiddenForCurrentPage = (): boolean => {
      try {
        return sessionStorage.getItem(floatingHiddenKey()) === "1";
      } catch {
        return false;
      }
    };
    const floatingEnabled = (): boolean =>
      (settings.page.floatingButtonEnabled ||
        settings.subtitles.floatingButtonEnabled ||
        settings.imageTranslation.enabled) &&
      !floatingHiddenForCurrentPage();

    const nativeSubtitleVisibility = new NativeSubtitleVisibility(
      nativeCaptionSelectorsForLocation(siteProfiles),
      effectiveBuiltInNativeCaptionSelectorsForLocation(siteProfiles),
    );
    let subtitleOverlayVisible = false;
    const syncNativeSubtitleVisibility = (status: SubtitleStatus): void => {
      nativeSubtitleVisibility.update(
        shouldHideNativeSubtitles(
          settings.subtitles,
          status,
          subtitleOverlayVisible,
        ),
      );
    };
    nativeSubtitleVisibility.update(false);
    const cache = createSubtitleCache();
    const childFrameStatuses = new ChildFrameStatusStore();
    let topPageStatus: PageStatus = {
      state: "idle",
      total: 0,
      completed: 0,
      failed: 0,
    };
    let topSubtitleStatus: SubtitleStatus = {
      state: "unavailable",
      total: 0,
      completed: 0,
      failed: 0,
    };
    let subtitleCancellationRequested = false;
    const pruneChildFrameStatuses = (): void => {
      childFrameStatuses.prune();
    };
    const aggregatePageStatus = (): PageStatus => {
      pruneChildFrameStatuses();
      return aggregatePageStatuses(
        topPageStatus,
        childFrameStatuses.values().map((value) => value.pageStatus),
      );
    };
    const aggregateSubtitleStatus = (): SubtitleStatus => {
      pruneChildFrameStatuses();
      return aggregateSubtitleStatuses(
        topSubtitleStatus,
        childFrameStatuses.values().map((value) => value.subtitleStatus),
        { cancelRequested: subtitleCancellationRequested },
      );
    };
    const refreshAggregatedStatusUi = (): void => {
      floatingControl.updatePageStatus(aggregatePageStatus());
      floatingControl.updateSubtitleStatus(aggregateSubtitleStatus());
    };

    const pageSession = new PageTranslationSession((status) => {
      topPageStatus = localizePageStatus(status);
      refreshAggregatedStatusUi();
    });
    const selectionTranslation = new SelectionTranslation(settings);
    let pageFollowsNavigation = false;
    const translatePage = (followNavigation = pageFollowsNavigation): void => {
      pageFollowsNavigation = followNavigation;
      void pageSession.translate(settings);
    };
    const broadcastContentCommand = async (
      command:
        | "PAGE_TRANSLATE"
        | "PAGE_AUTO_TRANSLATE_CURRENT"
        | "PAGE_RESTORE"
        | "SUBTITLE_START"
        | "SUBTITLE_RETRY_FAILED"
        | "SUBTITLE_CANCEL",
    ): Promise<void> => {
      if (command === "SUBTITLE_CANCEL") {
        subtitleCancellationRequested = true;
        refreshAggregatedStatusUi();
      } else if (
        command === "SUBTITLE_START" ||
        command === "SUBTITLE_RETRY_FAILED"
      ) {
        subtitleCancellationRequested = false;
      }
      const response: unknown = await browser.runtime.sendMessage({
        type: "CONTENT_COMMAND_BROADCAST",
        command,
      });
      if (!successfulResponse(response)) {
        if (command === "SUBTITLE_CANCEL") {
          subtitleCancellationRequested = false;
          refreshAggregatedStatusUi();
        }
        throw new Error(runtimeErrorToken("settings_save_failed"));
      }
    };
    const setManualTranslationIntent = async (
      enabled: boolean,
    ): Promise<void> => {
      const response: unknown = await browser.runtime.sendMessage({
        type: "PAGE_MANUAL_TRANSLATION_SET",
        enabled,
      });
      if (!successfulResponse(response)) {
        throw new Error(runtimeErrorToken("settings_save_failed"));
      }
    };
    const setAutoTranslate = async (enabled: boolean): Promise<void> => {
      const response: unknown = await browser.runtime.sendMessage({
        type: "PAGE_AUTO_TRANSLATE_SITE_SET",
        enabled,
      });
      if (!successfulResponse(response)) {
        throw new Error(runtimeErrorToken("settings_save_failed"));
      }
      if (
        typeof response === "object" &&
        response !== null &&
        "settings" in response &&
        isContentSettings(response.settings)
      ) {
        settings = response.settings;
      } else {
        settings = await loadContentSettings();
      }
      if (enabled) await broadcastContentCommand("PAGE_AUTO_TRANSLATE_CURRENT");
    };
    const saveProfile = async (profile: SubtitleSiteProfile): Promise<void> => {
      const response: unknown = await browser.runtime.sendMessage({
        type: "SITE_PROFILE_SAVE",
        profile,
      });
      if (!successfulResponse(response)) {
        throw new Error(runtimeErrorToken("profile_save_failed"));
      }
      siteProfiles = [
        profile,
        ...siteProfiles.filter((candidate) => candidate.id !== profile.id),
      ];
      nativeSubtitleVisibility.updateAdditionalSelectors(
        nativeCaptionSelectorsForLocation(siteProfiles),
        effectiveBuiltInNativeCaptionSelectorsForLocation(siteProfiles),
      );
      controller.addAdapter(new ProfileDomSubtitleAdapter(profile, true, 0));
      controller.refreshMedia();
    };
    const startOcr = async () => {
      const subtitleStatus = aggregateSubtitleStatus();
      if (subtitleStatus.total > 0 && subtitleStatus.source !== "ocr") {
        const reason = localizedMessage("ocrExistingSubtitlesAvailable");
        controller.showNotice(reason);
        return ocrSession.rejectStart(reason);
      }
      return ocrSession.start();
    };

    const floatingControlRef: { current?: UnifiedFloatingControl } = {};
    const imageController = new ImageTranslationController({
      settings,
      onStatus: (status) =>
        floatingControlRef.current?.updateImageStatus(status),
    });
    const adoptQuickSettingsResponse = async (
      response: unknown,
    ): Promise<void> => {
      if (!successfulResponse(response)) {
        throw new Error(runtimeErrorToken("settings_save_failed"));
      }
      settings =
        typeof response === "object" &&
        response !== null &&
        "settings" in response &&
        isContentSettings(response.settings)
          ? response.settings
          : await loadContentSettings();
      pageSession.updateSettings(settings);
      selectionTranslation.updateSettings(settings);
      controller.updateSettings(
        settings.subtitles,
        providerCacheContext(settings),
        settings.provider,
      );
      controller.updateOcrSettings(settings.ocr);
      imageController.updateSettings(settings);
      floatingControlRef.current?.updateSettings(settings);
    };
    const floatingControlOptions: UnifiedFloatingControlOptions = {
      settings,
      onPageTranslate: () => broadcastContentCommand("PAGE_TRANSLATE"),
      onPageRestore: () => broadcastContentCommand("PAGE_RESTORE"),
      onAutoTranslateChange: setAutoTranslate,
      onPageSettingsChange: async (patch, fastProvider) => {
        const response: unknown = await browser.runtime.sendMessage({
          type: "PAGE_QUICK_SETTINGS_SET",
          sourceLanguage: patch.sourceLanguage,
          targetLanguage: patch.targetLanguage,
          mode: settings.page.mode,
          fastProvider,
          responseMode: settings.page.aiResponseMode,
          displayMode: patch.displayMode,
          selectionTranslationEnabled: patch.selectionTranslationEnabled,
          selectionTranslationMode: patch.selectionTranslationMode,
        });
        await adoptQuickSettingsResponse(response);
      },
      onPageModeChange: async (mode, fastProvider) => {
        const response: unknown = await browser.runtime.sendMessage({
          type: "PAGE_QUICK_SETTINGS_SET",
          sourceLanguage: settings.page.sourceLanguage,
          targetLanguage: settings.page.targetLanguage,
          mode,
          fastProvider,
          responseMode: settings.page.aiResponseMode,
          displayMode: settings.page.displayMode,
          selectionTranslationEnabled:
            settings.page.selectionTranslationEnabled,
          selectionTranslationMode: settings.page.selectionTranslationMode,
        });
        await adoptQuickSettingsResponse(response);
      },
      onPageResponseModeChange: async (responseMode) => {
        const response: unknown = await browser.runtime.sendMessage({
          type: "PAGE_QUICK_SETTINGS_SET",
          sourceLanguage: settings.page.sourceLanguage,
          targetLanguage: settings.page.targetLanguage,
          mode: settings.page.mode,
          responseMode,
          displayMode: settings.page.displayMode,
          selectionTranslationEnabled:
            settings.page.selectionTranslationEnabled,
          selectionTranslationMode: settings.page.selectionTranslationMode,
        });
        if (!successfulResponse(response)) {
          throw new Error(runtimeErrorToken("settings_save_failed"));
        }
        settings = {
          ...settings,
          page: { ...settings.page, aiResponseMode: responseMode },
        };
        pageSession.updateSettings(settings);
        selectionTranslation.updateSettings(settings);
      },
      onSubtitleSettingsChange: async (patch, fastProvider) => {
        const response: unknown = await browser.runtime.sendMessage({
          type: "SUBTITLE_QUICK_SETTINGS_SET",
          sourceLanguage: patch.sourceLanguage,
          targetLanguage: patch.targetLanguage,
          mode: patch.mode,
          fastProvider,
          responseMode: patch.aiResponseMode,
          displayMode: patch.displayMode,
          hideNativeSubtitles: patch.hideNativeSubtitles,
          fontScale: patch.fontScale,
          backgroundOpacity: patch.backgroundOpacity,
        });
        await adoptQuickSettingsResponse(response);
        setSubtitleDiscoveryEnabled(
          settings.subtitles.enabled,
          settings.subtitles.sourceLanguage,
        );
        controller.updateSettings(
          settings.subtitles,
          providerCacheContext(settings),
          settings.provider,
        );
        topSubtitleStatus = controller.getStatus();
        syncNativeSubtitleVisibility(topSubtitleStatus);
        ocrSession.setSourceLanguage(settings.ocr.sourceLanguage);
      },
      onSubtitleStart: () => broadcastContentCommand("SUBTITLE_START"),
      onSubtitleCancel: () => broadcastContentCommand("SUBTITLE_CANCEL"),
      onCreateProfile: () => {
        profileWizard?.destroy();
        profileWizard = new SubtitleProfileWizard({ onSave: saveProfile });
        profileWizard.start();
      },
      onOcrSettingsChange: async (ocrSettings) => {
        if (ocrSettings.enabled && !settings.ocr.enabled) {
          const permission: unknown = await browser.runtime.sendMessage({
            type: "OCR_PERMISSION_REQUEST",
          });
          if (
            typeof permission !== "object" ||
            permission === null ||
            !("granted" in permission) ||
            permission.granted !== true
          ) {
            throw new Error("ocr-capture-permission-denied");
          }
        }
        const response: unknown = await browser.runtime.sendMessage({
          type: "OCR_SETTINGS_SET",
          ...ocrSettings,
        });
        if (!successfulResponse(response)) {
          throw new Error(runtimeErrorToken("settings_save_failed"));
        }
        settings = { ...settings, ocr: ocrSettings };
        ocrSession.setEnabled(ocrSettings.enabled);
        ocrSession.setSourceLanguage(ocrSettings.sourceLanguage);
        controller.updateOcrSettings(ocrSettings);
        if (!ocrSettings.enabled) controller.invalidateMedia();
      },
      onOcrStart: async () => {
        await startOcr();
      },
      onOcrStop: () => {
        ocrSession.stop("cancelled");
        controller.invalidateMedia();
      },
      onImageSettingsChange: async (patch, fastProvider) => {
        const response: unknown = await browser.runtime.sendMessage({
          type: "IMAGE_TRANSLATION_SETTINGS_SET",
          ...patch,
          fastProvider,
        });
        await adoptQuickSettingsResponse(response);
      },
      onImageStart: async () => {
        await imageController.startCurrent();
      },
      onImageCancelOrClear: () => imageController.cancelOrClearCurrent(),
      loadPosition: async () => {
        const response: unknown = await browser.runtime.sendMessage({
          type: "FLOATING_POSITION_GET",
        });
        if (
          typeof response !== "object" ||
          response === null ||
          !("ok" in response) ||
          response.ok !== true ||
          !("position" in response) ||
          typeof response.position !== "object" ||
          response.position === null ||
          !("x" in response.position) ||
          typeof response.position.x !== "number" ||
          !("y" in response.position) ||
          typeof response.position.y !== "number"
        ) {
          return undefined;
        }
        return { x: response.position.x, y: response.position.y };
      },
      onPositionChange: async (position) => {
        const response: unknown = await browser.runtime.sendMessage({
          type: "FLOATING_POSITION_SET",
          x: position.x,
          y: position.y,
        });
        if (!successfulResponse(response)) {
          throw new Error(runtimeErrorToken("settings_save_failed"));
        }
      },
      onHideCurrent: () => {
        sessionStorage.setItem(floatingHiddenKey(), "1");
        if (sessionStorage.getItem(floatingHiddenKey()) !== "1") {
          throw new Error(runtimeErrorToken("settings_save_failed"));
        }
      },
    };
    const createFloatingControl = (): UnifiedFloatingControl => {
      floatingControlOptions.settings = settings;
      return new UnifiedFloatingControl(floatingControlOptions);
    };
    let floatingControl = createFloatingControl();
    floatingControlRef.current = floatingControl;
    floatingControl.updateImageStatus(imageController.getStatus());

    const ocrAdapter = new OcrSubtitleAdapter();
    const controller = new SubtitleController({
      settings: settings.subtitles,
      ocrSettings: settings.ocr,
      adapters: [...createSubtitleAdapters(siteProfiles, location), ocrAdapter],
      providerCacheContext: providerCacheContext(settings),
      providerSettings: settings.provider,
      cache,
      taskStore: createSubtitleTaskStore(),
      onStatus: (status) => {
        topSubtitleStatus = status;
        syncNativeSubtitleVisibility(status);
        refreshAggregatedStatusUi();
      },
      onCueVisibilityChange: (visible) => {
        subtitleOverlayVisible = visible;
        syncNativeSubtitleVisibility(topSubtitleStatus);
      },
      onTrackSelected: (track) => {
        if (
          track.source !== "ocr" &&
          [
            "selecting",
            "initializing",
            "capturing",
            "recognizing",
            "active",
          ].includes(ocrSession.getStatus().state)
        ) {
          ocrSession.stop("idle");
          controller.showNotice(
            localizedMessage("ocrExistingSubtitlesAvailable"),
          );
        }
      },
      onVideoChange: (video) => {
        subtitleCancellationRequested = false;
        nativeSubtitleVisibility.setVideo(video);
      },
      onPositionChange: async (position) => {
        const response: unknown = await browser.runtime.sendMessage({
          type: "SUBTITLE_POSITION_SET",
          x: position.x,
          y: position.y,
        });
        if (!successfulResponse(response)) {
          throw new Error(runtimeErrorToken("settings_save_failed"));
        }
        settings = withSubtitleCustomPosition(settings, position);
      },
    });
    let ocrWasRunning = false;
    let pendingOcrStopNotice: string | undefined;
    const ocrSession = new OcrSession({
      enabled: settings.ocr.enabled,
      sourceLanguage: settings.ocr.sourceLanguage,
      adapter: ocrAdapter,
      onStatus: (status) => {
        const running = [
          "selecting",
          "initializing",
          "capturing",
          "recognizing",
          "active",
        ].includes(status.state);
        if (
          ocrWasRunning &&
          (status.state === "error" || status.state === "unavailable") &&
          status.message
        ) {
          pendingOcrStopNotice = status.message;
          controller.showNotice(status.message);
        }
        ocrWasRunning = running;
        floatingControl.updateOcrStatus(status);
        controller.setOcrCaptureRegion(status.region ?? null);
      },
      onMediaTarget: (target) => controller.setOcrMediaTarget(target),
      onTrackUpdated: () => controller.refreshMedia(),
      onStopped: () => {
        const notice = pendingOcrStopNotice;
        pendingOcrStopNotice = undefined;
        controller.invalidateOcrMedia();
        if (notice) controller.showNotice(notice);
      },
      filterRecognizedText: (text) => controller.filterOcrFeedbackText(text),
    });
    floatingControl.updateOcrStatus(ocrSession.getStatus());
    if (floatingEnabled()) floatingControl.show();
    else floatingControl.hide();
    void controller.start().catch(() => {
      topSubtitleStatus = {
        state: "error",
        total: 0,
        completed: 0,
        failed: 0,
      };
      refreshAggregatedStatusUi();
    });
    setSubtitleDiscoveryEnabled(
      settings.subtitles.enabled,
      settings.subtitles.sourceLanguage,
    );
    topSubtitleStatus = controller.getStatus();
    refreshAggregatedStatusUi();
    if (currentPageAutoTranslate(settings)) {
      if (document.body) void translatePage(true);
      else {
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            if (currentPageAutoTranslate(settings)) void translatePage(true);
          },
          { once: true },
        );
      }
    }

    let previousPageUrl = pageRouteKey();
    let navigationTimer: number | undefined;
    const handleNavigation = (): void => {
      const nextPageUrl = pageRouteKey();
      if (nextPageUrl === previousPageUrl) return;
      previousPageUrl = nextPageUrl;
      childFrameStatuses.clearStatuses();
      const shouldRestart =
        pageFollowsNavigation || currentPageAutoTranslate(settings);
      pageSession.restore();
      ocrSession.stop("cancelled");
      imageController.clearForNavigation();
      setSubtitleDiscoveryEnabled(false, settings.subtitles.sourceLanguage);
      controller.replaceAdapters([
        ...createSubtitleAdapters(siteProfiles, location),
        ocrAdapter,
      ]);
      nativeSubtitleVisibility.updateAdditionalSelectors(
        nativeCaptionSelectorsForLocation(siteProfiles),
        effectiveBuiltInNativeCaptionSelectorsForLocation(siteProfiles),
      );
      void ensureMainWorldCaptureHook().then((installed) => {
        if (installed) {
          setSubtitleDiscoveryEnabled(
            settings.subtitles.enabled,
            settings.subtitles.sourceLanguage,
          );
        }
      });
      profileWizard?.destroy();
      profileWizard = undefined;
      if (floatingEnabled()) floatingControl.show();
      else floatingControl.hide();
      if (navigationTimer !== undefined) window.clearTimeout(navigationTimer);
      if (shouldRestart) {
        navigationTimer = window.setTimeout(() => {
          navigationTimer = undefined;
          translatePage(shouldRestart);
        }, 350);
      }
    };
    window.addEventListener("popstate", handleNavigation);
    window.addEventListener("hashchange", handleNavigation);
    window.addEventListener("yt-navigate-start", handleNavigation);
    window.addEventListener("yt-navigate-finish", handleNavigation);
    const stopHistoryEntryChanges =
      listenForHistoryEntryChanges(handleNavigation);
    const maintenanceTimer = window.setInterval(() => {
      handleNavigation();
      nativeSubtitleVisibility.refresh();
      refreshAggregatedStatusUi();
    }, 500);

    const videoObserver = new MutationObserver((records) => {
      const touchesVideo = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node instanceof HTMLVideoElement ||
            (node instanceof Element && node.querySelector("video") !== null),
        ),
      );
      if (touchesVideo) {
        nativeSubtitleVisibility.refresh();
        controller.refreshMedia();
      }
    });
    videoObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    const handleCommand = async (message: ContentCommand): Promise<unknown> => {
      switch (message.type) {
        case "CONTENT_RUNTIME_INFO":
          return { version: browser.runtime.getManifest().version };
        case "TRANSLATION_CAPABILITIES_GET":
          return {
            ok: true,
            capabilities: await queryDocumentTranslationCapabilities(),
          };
        case "PAGE_TRANSLATE":
          await setManualTranslationIntent(true).catch(() => undefined);
          translatePage(true);
          return aggregatePageStatus();
        case "PAGE_AUTO_TRANSLATE_CURRENT":
          translatePage(true);
          return aggregatePageStatus();
        case "PAGE_RESTORE": {
          await setManualTranslationIntent(false).catch(() => undefined);
          pageFollowsNavigation = false;
          topPageStatus = pageSession.restore();
          refreshAggregatedStatusUi();
          return aggregatePageStatus();
        }
        case "PAGE_STATUS":
          return aggregatePageStatus();
        case "FRAME_STATUS_UPDATED": {
          const updated = childFrameStatuses.update(
            message.frameId,
            message.frameInstanceId,
            message.pageStatus,
            message.subtitleStatus,
          );
          if (updated) refreshAggregatedStatusUi();
          return { ok: true };
        }
        case "FRAME_STATUS_CLEARED": {
          if (
            childFrameStatuses.clear(message.frameId, message.frameInstanceId)
          ) {
            refreshAggregatedStatusUi();
          }
          return { ok: true };
        }
        case "FLOATING_SESSION_SHOW": {
          const restored = floatingHiddenForCurrentPage();
          sessionStorage.removeItem(floatingHiddenKey());
          if (sessionStorage.getItem(floatingHiddenKey()) !== null) {
            throw new Error(runtimeErrorToken("settings_save_failed"));
          }
          if (floatingEnabled()) floatingControl.show();
          return { ok: true, restored };
        }
        case "SUBTITLE_STATUS":
          return aggregateSubtitleStatus();
        case "SUBTITLE_START":
          subtitleCancellationRequested = false;
          void controller.startTranslationTask().catch(() => undefined);
          return aggregateSubtitleStatus();
        case "SUBTITLE_RETRY_FAILED":
          subtitleCancellationRequested = false;
          void controller.retryFailed().catch(() => undefined);
          return aggregateSubtitleStatus();
        case "SUBTITLE_CANCEL":
          subtitleCancellationRequested = true;
          childFrameStatuses.clearStatuses();
          topSubtitleStatus = controller.cancelTranslationTask();
          refreshAggregatedStatusUi();
          return aggregateSubtitleStatus();
        case "OCR_STATUS":
          return ocrSession.getStatus();
        case "OCR_START":
          return startOcr();
        case "OCR_STOP":
          ocrSession.stop("cancelled");
          controller.invalidateMedia();
          return ocrSession.getStatus();
        case "CACHE_CLEARED":
          invalidateSharedCacheLeases();
          topPageStatus = pageSession.handleCacheCleared();
          if (topSubtitleStatus.state === "translating") {
            subtitleCancellationRequested = true;
            topSubtitleStatus = controller.cancelTranslationTask();
          }
          refreshAggregatedStatusUi();
          return { ok: true };
        case "SETTINGS_UPDATED": {
          const previousSettings = settings;
          const languageChanged =
            previousSettings.uiLanguage !== message.settings.uiLanguage;
          const wasOcrEnabled = settings.ocr.enabled;
          settings = message.settings;
          if (languageChanged) configureUiLanguage(settings.uiLanguage);
          if (!settings.subtitles.enabled) {
            subtitleCancellationRequested = false;
          }
          const wasAutomaticPageSession = pageFollowsNavigation;
          if (
            currentPageAutoTranslate(previousSettings) &&
            !currentPageAutoTranslate(settings)
          ) {
            pageFollowsNavigation = false;
            if (navigationTimer !== undefined) {
              window.clearTimeout(navigationTimer);
              navigationTimer = undefined;
            }
            if (wasAutomaticPageSession) {
              pageSession.stopFollowingDynamicContent();
            }
          } else if (
            !currentPageAutoTranslate(previousSettings) &&
            currentPageAutoTranslate(settings) &&
            pageSession.getStatus().state !== "idle"
          ) {
            pageFollowsNavigation = true;
            pageSession.resumeFollowingDynamicContent();
          }
          pageSession.updateSettings(settings);
          selectionTranslation.updateSettings(settings);
          if (languageChanged) selectionTranslation.refreshLocale();
          setSubtitleDiscoveryEnabled(
            settings.subtitles.enabled,
            settings.subtitles.sourceLanguage,
          );
          controller.updateSettings(
            settings.subtitles,
            providerCacheContext(settings),
            settings.provider,
          );
          if (languageChanged) controller.refreshLocale();
          topSubtitleStatus = controller.getStatus();
          syncNativeSubtitleVisibility(topSubtitleStatus);
          ocrSession.setEnabled(settings.ocr.enabled);
          ocrSession.setSourceLanguage(settings.ocr.sourceLanguage);
          controller.updateOcrSettings(settings.ocr);
          if (wasOcrEnabled && !settings.ocr.enabled) {
            controller.invalidateMedia();
          }
          imageController.updateSettings(settings);
          if (languageChanged) {
            imageController.refreshLocale();
            delete floatingControlRef.current;
            floatingControl.destroy();
            floatingControl = createFloatingControl();
            floatingControlRef.current = floatingControl;
            floatingControl.updateImageStatus(imageController.getStatus());
            refreshAggregatedStatusUi();
          } else {
            floatingControl.updateSettings(settings);
          }
          if (floatingEnabled()) floatingControl.show();
          else floatingControl.hide();
          if (
            pageSession.getStatus().state !== "idle" &&
            pageTranslationConfigurationChanged(previousSettings, settings)
          ) {
            pageSession.restore();
            translatePage();
          }
          refreshAggregatedStatusUi();
          return { ok: true };
        }
        default:
          return undefined;
      }
    };

    const handleMessage = (
      message: unknown,
      _sender: Browser.runtime.MessageSender,
      sendResponse: (response?: unknown) => void,
    ): true | undefined => {
      if (!isContentCommand(message)) return undefined;
      void Promise.resolve(handleCommand(message)).then(
        sendResponse,
        (error: unknown) => {
          sendResponse({ ok: false, error: safeRuntimeErrorToken(error) });
        },
      );
      return true;
    };

    const clearManualIntent = (): void => {
      void setManualTranslationIntent(false).catch(() => undefined);
    };
    window.addEventListener("pagehide", clearManualIntent);
    browser.runtime.onMessage.addListener(handleMessage);
    context.onInvalidated(() => {
      clearManualIntent();
      setSubtitleDiscoveryEnabled(false, settings.subtitles.sourceLanguage);
      window.clearInterval(maintenanceTimer);
      if (navigationTimer !== undefined) window.clearTimeout(navigationTimer);
      window.removeEventListener("popstate", handleNavigation);
      window.removeEventListener("hashchange", handleNavigation);
      window.removeEventListener("yt-navigate-start", handleNavigation);
      window.removeEventListener("yt-navigate-finish", handleNavigation);
      stopHistoryEntryChanges();
      window.removeEventListener("pagehide", clearManualIntent);
      videoObserver.disconnect();
      browser.runtime.onMessage.removeListener(handleMessage);
      pageSession.restore();
      selectionTranslation.destroy();
      profileWizard?.destroy();
      nativeSubtitleVisibility.destroy();
      floatingControl.destroy();
      ocrSession.destroy();
      imageController.destroy();
      controller.stop();
      window.__norixorTransVideoReady = false;
    });
  },
});
