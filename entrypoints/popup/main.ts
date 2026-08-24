import type { PageStatus, SubtitleStatus } from "@/src/messaging/protocol";
import type { ExtensionUpdateStatus } from "@/src/update/checker";
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
import { loadSettings } from "@/src/shared/settings";
import {
  parseTranslationMethod,
  TRANSLATION_METHODS,
  translationMethodValue,
} from "@/src/shared/translation-methods";
import {
  providerLanguagePairAvailable,
  providerSourceLanguageAvailable,
  providerTargetLanguageAvailable,
  type TranslationCapabilities,
} from "@/src/translation/provider-capabilities";
import { browser } from "wxt/browser";

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>(`#${id}`);
  if (!value) throw new Error(`Missing popup element: ${id}`);
  return value;
}

function isPageStatus(value: unknown): value is PageStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    typeof value.state === "string" &&
    [
      "idle",
      "scanning",
      "translating",
      "translated",
      "partial",
      "error",
    ].includes(value.state) &&
    "total" in value &&
    typeof value.total === "number" &&
    "completed" in value &&
    typeof value.completed === "number" &&
    "failed" in value &&
    typeof value.failed === "number"
  );
}

function isSubtitleStatus(value: unknown): value is SubtitleStatus {
  return (
    typeof value === "object" &&
    value !== null &&
    "state" in value &&
    typeof value.state === "string" &&
    [
      "unavailable",
      "waiting",
      "translating",
      "ready",
      "partial",
      "cancelled",
      "error",
    ].includes(value.state) &&
    "total" in value &&
    typeof value.total === "number" &&
    "completed" in value &&
    typeof value.completed === "number" &&
    "failed" in value &&
    typeof value.failed === "number"
  );
}

function isSuccessfulAction(value: unknown): value is { ok: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

function isUpdateStatus(value: unknown): value is ExtensionUpdateStatus {
  return (
    isSuccessfulAction(value) &&
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

function subtitleDisplayState(status: SubtitleStatus): SubtitleStatus["state"] {
  if (status.failed > 0) return status.completed > 0 ? "partial" : "error";
  return status.state;
}

function subtitleStatusMessage(status: SubtitleStatus): string {
  const state = subtitleDisplayState(status);
  const stateMessage = status.message ?? message(statusKey("subtitle", state));
  if (!status.completeness) return stateMessage;
  const trackKind = message(
    status.completeness === "full"
      ? "subtitleTrackFull"
      : "subtitleTrackStream",
  );
  return `${stateMessage} · ${trackKind}`;
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function ensureContent(tabId: number): Promise<void> {
  await browser.runtime.sendMessage({ type: "ENSURE_PAGE_CONTENT", tabId });
}

function statusKey(prefix: "page" | "subtitle", state: string): string {
  const normalized = state.charAt(0).toUpperCase() + state.slice(1);
  return `${prefix}Status${normalized}`;
}

function setProgress(
  element: HTMLElement,
  completed: number,
  total: number,
): void {
  element.textContent =
    total > 0
      ? message("progressCount", [String(completed), String(total)])
      : "";
}

async function initialize(): Promise<void> {
  let settings = await loadSettings();
  const form = element<HTMLFormElement>("translation-form");
  const sourceSelect = element<HTMLSelectElement>("source-language");
  const targetSelect = element<HTMLSelectElement>("target-language");
  const translationMethodSelect =
    element<HTMLSelectElement>("translation-method");
  const responseModeField = element<HTMLElement>("response-mode-field");
  const responseModeSelect = element<HTMLSelectElement>("response-mode");
  const translateButton = element<HTMLButtonElement>("translate-page");
  const restoreButton = element<HTMLButtonElement>("restore-page");
  const actionMessage = element<HTMLParagraphElement>("action-message");
  const statusSection = element<HTMLElement>("status-section");
  const openOptionsButton = element<HTMLButtonElement>("open-options");
  const pageStatusElement = element<HTMLElement>("page-status");
  const pageProgressElement = element<HTMLElement>("page-progress");
  const pageDiagnostic = element<HTMLDetailsElement>("page-diagnostic");
  const subtitleStatusElement = element<HTMLElement>("subtitle-status");
  const subtitleProgressElement = element<HTMLElement>("subtitle-progress");
  const subtitleDiagnostic = element<HTMLDetailsElement>("subtitle-diagnostic");
  const updateBanner = element<HTMLElement>("update-banner");
  const updateTitle = element<HTMLElement>("update-title");
  const viewUpdateButton = element<HTMLButtonElement>("view-update");
  const ignoreUpdateButton = element<HTMLButtonElement>("ignore-update");
  let updateStatus: ExtensionUpdateStatus | undefined;
  let statusRefreshBusy = false;
  let actionBusy = false;
  let pageAvailable = false;
  let translationCapabilities: TranslationCapabilities | undefined;

  const renderUpdateStatus = (status: ExtensionUpdateStatus): void => {
    updateStatus = status;
    const available =
      status.state === "available" &&
      Boolean(status.latestVersion) &&
      Boolean(status.releaseUrl);
    updateBanner.hidden = !available;
    updateTitle.textContent = available
      ? message("updateAvailableTitle", status.latestVersion)
      : "";
  };

  viewUpdateButton.addEventListener("click", () => {
    if (!updateStatus?.releaseUrl) return;
    void browser.tabs.create({ url: updateStatus.releaseUrl });
  });
  ignoreUpdateButton.addEventListener("click", () => {
    if (!updateStatus?.latestVersion) return;
    void browser.runtime
      .sendMessage({
        type: "UPDATE_IGNORE",
        version: updateStatus.latestVersion,
      })
      .then((response: unknown) => {
        if (isUpdateStatus(response)) renderUpdateStatus(response);
      });
  });

  const updateDiagnostic = (
    diagnostic: HTMLDetailsElement,
    details: string | undefined,
  ): void => {
    const value = details?.trim().slice(0, 4_000) ?? "";
    const output = diagnostic.querySelector("pre");
    if (output) output.textContent = value;
    diagnostic.hidden = !value;
    if (!value) diagnostic.open = false;
  };

  const languageLabel = (code: string): string =>
    code === "auto"
      ? message("languageAuto")
      : displayLanguageName(code, currentUiLocale());
  for (const language of SOURCE_LANGUAGES) {
    sourceSelect.add(new Option(languageLabel(language.code), language.code));
  }
  for (const language of TARGET_LANGUAGES) {
    targetSelect.add(new Option(languageLabel(language.code), language.code));
  }
  for (const method of TRANSLATION_METHODS) {
    translationMethodSelect.add(
      new Option(message(method.labelKey), method.value),
    );
  }

  const syncLanguageOptions = (): void => {
    const method = parseTranslationMethod(translationMethodSelect.value);
    const provider =
      method?.mode === "ai"
        ? "openai-compatible"
        : (method?.fastProvider ?? settings.provider.fastProvider);
    const sourceLanguage = sourceSelect.value || settings.page.sourceLanguage;
    const targetLanguage = targetSelect.value || settings.page.targetLanguage;
    const sourceAvailable = (source: string): boolean =>
      !translationCapabilities ||
      providerSourceLanguageAvailable(
        provider,
        source,
        translationCapabilities,
      );
    const targetAvailable = (target: string): boolean =>
      !translationCapabilities ||
      providerTargetLanguageAvailable(
        provider,
        target,
        translationCapabilities,
      );
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

  const syncForm = (): void => {
    sourceSelect.value = settings.page.sourceLanguage;
    targetSelect.value = settings.page.targetLanguage;
    translationMethodSelect.value = translationMethodValue(
      settings.page.mode,
      settings.provider.fastProvider,
    );
    syncLanguageOptions();
    responseModeSelect.value = settings.page.aiResponseMode;
    responseModeField.hidden = settings.page.mode !== "ai";
    responseModeSelect.disabled = actionBusy || settings.page.mode !== "ai";
    const displayMode = form.elements.namedItem("display-mode");
    if (displayMode instanceof RadioNodeList)
      displayMode.value = settings.page.displayMode;
  };

  const readForm = (): typeof settings => {
    const data = new FormData(form);
    const method = parseTranslationMethod(translationMethodSelect.value) ?? {
      mode: settings.page.mode,
      fastProvider: settings.provider.fastProvider,
    };
    return {
      ...settings,
      provider: method.fastProvider
        ? { ...settings.provider, fastProvider: method.fastProvider }
        : settings.provider,
      page: {
        ...settings.page,
        sourceLanguage: sourceSelect.value,
        targetLanguage: targetSelect.value,
        mode: method.mode,
        aiResponseMode:
          responseModeSelect.value === "batch" ? "batch" : "stream",
        displayMode:
          data.get("display-mode") === "translated"
            ? "translated"
            : "bilingual",
      },
    };
  };

  const persist = async (): Promise<void> => {
    const draft = readForm();
    const response: unknown = await browser.runtime.sendMessage({
      type: "PAGE_QUICK_SETTINGS_SET",
      sourceLanguage: draft.page.sourceLanguage,
      targetLanguage: draft.page.targetLanguage,
      mode: draft.page.mode,
      fastProvider:
        draft.page.mode === "fast" ? draft.provider.fastProvider : undefined,
      responseMode: draft.page.aiResponseMode,
      displayMode: draft.page.displayMode,
    });
    if (!isSuccessfulAction(response)) {
      throw new Error("settings-save-failed");
    }
    settings = draft;
    syncForm();
  };

  const syncActionAvailability = (): void => {
    const method = parseTranslationMethod(translationMethodSelect.value);
    const provider =
      method?.mode === "ai"
        ? "openai-compatible"
        : (method?.fastProvider ?? settings.provider.fastProvider);
    const pairAvailable =
      !translationCapabilities ||
      providerLanguagePairAvailable(
        provider,
        sourceSelect.value,
        targetSelect.value,
        translationCapabilities,
      );
    translateButton.disabled = actionBusy || !pageAvailable || !pairAvailable;
    restoreButton.disabled = actionBusy || !pageAvailable;
  };

  const setPageAvailable = (available: boolean): void => {
    pageAvailable = available;
    syncActionAvailability();
  };

  const setBusy = (busy: boolean): void => {
    actionBusy = busy;
    syncActionAvailability();
    sourceSelect.disabled = busy;
    targetSelect.disabled = busy;
    translationMethodSelect.disabled = busy;
    responseModeSelect.disabled = busy || settings.page.mode !== "ai";
  };

  const refreshStatuses = async (): Promise<void> => {
    if (statusRefreshBusy) return;
    statusRefreshBusy = true;
    statusSection.setAttribute("aria-busy", "true");
    try {
      const tabId = await activeTabId();
      if (tabId === null) {
        setPageAvailable(false);
        pageStatusElement.textContent = message("pageStatusUnavailable");
        subtitleStatusElement.textContent = message(
          "subtitleStatusUnavailable",
        );
        updateDiagnostic(pageDiagnostic, undefined);
        updateDiagnostic(subtitleDiagnostic, undefined);
        return;
      }
      await ensureContent(tabId);
      const capabilitiesResponse: unknown = await browser.tabs.sendMessage(
        tabId,
        { type: "TRANSLATION_CAPABILITIES_GET" },
        { frameId: 0 },
      );
      if (
        typeof capabilitiesResponse === "object" &&
        capabilitiesResponse !== null &&
        "ok" in capabilitiesResponse &&
        capabilitiesResponse.ok === true &&
        "capabilities" in capabilitiesResponse &&
        typeof capabilitiesResponse.capabilities === "object" &&
        capabilitiesResponse.capabilities !== null &&
        "chromePairs" in capabilitiesResponse.capabilities &&
        Array.isArray(capabilitiesResponse.capabilities.chromePairs) &&
        "installedBergamotPackIds" in capabilitiesResponse.capabilities &&
        Array.isArray(
          capabilitiesResponse.capabilities.installedBergamotPackIds,
        )
      ) {
        translationCapabilities =
          capabilitiesResponse.capabilities as TranslationCapabilities;
        syncLanguageOptions();
        syncActionAvailability();
      }
      const pageStatus: unknown = await browser.tabs.sendMessage(
        tabId,
        { type: "PAGE_STATUS" },
        { frameId: 0 },
      );
      const subtitleStatus: unknown = await browser.tabs.sendMessage(
        tabId,
        { type: "SUBTITLE_STATUS" },
        { frameId: 0 },
      );
      if (isPageStatus(pageStatus)) {
        setPageAvailable(true);
        pageStatusElement.textContent =
          pageStatus.message ?? message(statusKey("page", pageStatus.state));
        setProgress(
          pageProgressElement,
          pageStatus.completed,
          pageStatus.total,
        );
        updateDiagnostic(pageDiagnostic, pageStatus.details);
      } else {
        setPageAvailable(false);
        pageStatusElement.textContent = message("pageStatusUnavailable");
        pageProgressElement.textContent = "";
        updateDiagnostic(pageDiagnostic, undefined);
      }
      if (isSubtitleStatus(subtitleStatus)) {
        subtitleStatusElement.textContent =
          subtitleStatusMessage(subtitleStatus);
        setProgress(
          subtitleProgressElement,
          subtitleStatus.completed,
          subtitleStatus.total,
        );
        updateDiagnostic(subtitleDiagnostic, subtitleStatus.details);
      } else {
        subtitleStatusElement.textContent = message(
          "subtitleStatusUnavailable",
        );
        subtitleProgressElement.textContent = "";
        updateDiagnostic(subtitleDiagnostic, undefined);
      }
    } catch {
      setPageAvailable(false);
      pageStatusElement.textContent = message("pageStatusUnavailable");
      subtitleStatusElement.textContent = message("subtitleStatusUnavailable");
      pageProgressElement.textContent = "";
      subtitleProgressElement.textContent = "";
      updateDiagnostic(pageDiagnostic, undefined);
      updateDiagnostic(subtitleDiagnostic, undefined);
    } finally {
      statusRefreshBusy = false;
      statusSection.setAttribute("aria-busy", "false");
    }
  };

  form.addEventListener("change", () => {
    syncLanguageOptions();
    syncActionAvailability();
    const draft = readForm();
    responseModeField.hidden = draft.page.mode !== "ai";
    responseModeSelect.disabled = draft.page.mode !== "ai";
    void persist().catch(() => {
      syncForm();
      actionMessage.dataset.tone = "error";
      actionMessage.textContent = message("settingsSaveFailed");
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      setBusy(true);
      actionMessage.dataset.tone = "";
      actionMessage.textContent = message("translationStarting");
      try {
        await persist();
        const tabId = await activeTabId();
        if (tabId === null) throw new Error("no-active-tab");
        await ensureContent(tabId);
        await browser.tabs.sendMessage(tabId, { type: "PAGE_TRANSLATE" });
        actionMessage.textContent = message("translationStarted");
        await refreshStatuses();
      } catch {
        actionMessage.dataset.tone = "error";
        actionMessage.textContent = message("pageActionFailed");
      } finally {
        setBusy(false);
      }
    })();
  });

  restoreButton.addEventListener("click", () => {
    void (async () => {
      setBusy(true);
      actionMessage.dataset.tone = "";
      try {
        const tabId = await activeTabId();
        if (tabId === null) throw new Error("no-active-tab");
        await ensureContent(tabId);
        await browser.tabs.sendMessage(tabId, { type: "PAGE_RESTORE" });
        actionMessage.textContent = message("pageRestored");
        await refreshStatuses();
      } catch {
        actionMessage.dataset.tone = "error";
        actionMessage.textContent = message("pageActionFailed");
      } finally {
        setBusy(false);
      }
    })();
  });

  openOptionsButton.addEventListener("click", () => {
    void (async () => {
      openOptionsButton.disabled = true;
      try {
        await browser.runtime.openOptionsPage();
      } catch {
        actionMessage.dataset.tone = "error";
        actionMessage.textContent = message("openSettingsFailed");
      } finally {
        openOptionsButton.disabled = false;
      }
    })();
  });

  const handleStorageChange = (
    changes: Record<string, Browser.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== "local" || !changes.settings) return;
    void loadSettings()
      .then((nextSettings) => {
        if (nextSettings.uiLanguage !== settings.uiLanguage) {
          window.location.reload();
          return;
        }
        settings = nextSettings;
        syncForm();
      })
      .catch(() => {
        actionMessage.dataset.tone = "error";
        actionMessage.textContent = message("settingsLoadFailed");
      });
  };
  browser.storage.onChanged.addListener(handleStorageChange);

  syncForm();
  syncActionAvailability();
  const initialUpdateStatus: unknown = await browser.runtime.sendMessage({
    type: "UPDATE_STATUS_GET",
  });
  if (isUpdateStatus(initialUpdateStatus)) {
    renderUpdateStatus(initialUpdateStatus);
  }
  await refreshStatuses();
  const statusInterval = window.setInterval(() => void refreshStatuses(), 1500);
  window.addEventListener(
    "pagehide",
    () => {
      window.clearInterval(statusInterval);
      browser.storage.onChanged.removeListener(handleStorageChange);
    },
    { once: true },
  );
}

void (async () => {
  await initializeUiLanguage();
  localizeDocument();
  await initialize();
})().catch(() => {
  document.documentElement.dataset.localized = "true";
  const actionMessage = document.querySelector<HTMLElement>("#action-message");
  if (actionMessage) {
    actionMessage.dataset.tone = "error";
    actionMessage.textContent = message("settingsLoadFailed");
  }
  for (const control of document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement
  >("button,input,select")) {
    control.disabled = true;
  }
});
