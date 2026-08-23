import type { PageStatus, SubtitleStatus } from "@/src/messaging/protocol";
import {
  displayLanguageName,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
} from "@/src/shared/languages";
import { loadSettings } from "@/src/shared/settings";
import { browser } from "wxt/browser";

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
  if (!value) throw new Error(`Missing popup element: ${id}`);
  return value;
}

function message(key: string, substitutions?: string | string[]): string {
  return chrome.i18n.getMessage(key, substitutions) || key;
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
  let statusRefreshBusy = false;
  let actionBusy = false;
  let pageAvailable = false;

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
      : displayLanguageName(code, chrome.i18n.getUILanguage());
  for (const language of SOURCE_LANGUAGES) {
    sourceSelect.add(new Option(languageLabel(language.code), language.code));
  }
  for (const language of TARGET_LANGUAGES) {
    targetSelect.add(new Option(languageLabel(language.code), language.code));
  }

  const syncForm = (): void => {
    sourceSelect.value = settings.page.sourceLanguage;
    targetSelect.value = settings.page.targetLanguage;
    const mode = form.elements.namedItem("mode");
    if (mode instanceof RadioNodeList) mode.value = settings.page.mode;
    responseModeSelect.value = settings.page.aiResponseMode;
    responseModeSelect.disabled = actionBusy || settings.page.mode !== "ai";
    const displayMode = form.elements.namedItem("display-mode");
    if (displayMode instanceof RadioNodeList)
      displayMode.value = settings.page.displayMode;
  };

  const readForm = (): typeof settings => {
    const data = new FormData(form);
    return {
      ...settings,
      page: {
        ...settings.page,
        sourceLanguage: sourceSelect.value,
        targetLanguage: targetSelect.value,
        mode: data.get("mode") === "ai" ? "ai" : "fast",
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
    translateButton.disabled = actionBusy || !pageAvailable;
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
    const draft = readForm();
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

localizeDocument();
void initialize().catch(() => {
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
