import { browser } from "wxt/browser";
import {
  initializeUiLanguage,
  localizeDocument,
  message,
} from "@/src/shared/i18n";
import { loadSettings } from "@/src/shared/settings";
import { defineNtComponents } from "@/src/ui/components";
import { installDocumentTheme } from "@/src/ui/tokens/tokens";
import { queryChromeTranslationPairs } from "@/src/translation/provider-capabilities";
import { defaultOptionsAppDeps, OptionsApp, type ConfirmRequest } from "./app";
import { SettingsStore } from "./settings-store";
import { OptionsShell } from "./shell";

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error(`options_element_missing:${selector}`);
  return value;
}

/** Confirmation dialog for destructive actions (impact text included). */
function confirmWithDialog(request: ConfirmRequest): Promise<boolean> {
  const dialog = required<HTMLDialogElement>("#opt-confirm");
  required<HTMLElement>("#opt-confirm-title").textContent = request.title;
  required<HTMLElement>("#opt-confirm-body").textContent = request.body;
  const accept = required<HTMLElement>("#opt-confirm-accept");
  const cancel = required<HTMLElement>("#opt-confirm-cancel");
  accept.textContent = request.confirmLabel;
  accept.setAttribute("variant", request.danger ? "danger" : "primary");
  const opener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
  return new Promise((resolve) => {
    let result = false;
    const onAccept = (): void => {
      result = true;
      dialog.close();
    };
    const onCancel = (): void => dialog.close();
    const onClose = (): void => {
      accept.removeEventListener("click", onAccept);
      cancel.removeEventListener("click", onCancel);
      opener?.focus();
      resolve(result);
    };
    accept.addEventListener("click", onAccept);
    cancel.addEventListener("click", onCancel);
    dialog.addEventListener("close", onClose, { once: true });
    dialog.showModal();
    cancel.focus();
  });
}

async function start(): Promise<void> {
  installDocumentTheme();
  defineNtComponents();
  await initializeUiLanguage();

  const store = new SettingsStore(await loadSettings(), {
    send: (patch) =>
      browser.runtime.sendMessage({ type: "SETTINGS_PATCH", patch }),
  });
  const shell = new OptionsShell();
  const app = new OptionsApp(
    {
      services: required("#app-services"),
      page: required("#app-page"),
      video: required("#app-video"),
      privacy: required("#app-privacy"),
      sites: required("#app-sites"),
      general: required("#app-general"),
      status: required("#opt-autosave"),
    },
    store,
    defaultOptionsAppDeps(confirmWithDialog, (hash) => shell.navigate(hash)),
  );
  app.render();
  localizeDocument();
  shell.start();

  const handleStorageChange = (
    changes: Record<string, Browser.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName === "local" && changes.settings) {
      app.applyExternal(changes.settings.newValue);
    }
  };
  browser.storage.onChanged.addListener(handleStorageChange);

  const chromePairs = queryChromeTranslationPairs().catch(() => []);
  void chromePairs.then((pairs) => app.setChromePairs(pairs));
  void app.refreshLocalPermission();
  void app.refreshUpdateStatus(false);
  void app.sites.load();
  void app.runtimes.start();

  // Autosaved fields need no prompt; credentials and site profiles do.
  window.addEventListener("beforeunload", (event) => {
    if (app.hasUnsavedChanges) event.preventDefault();
  });
  window.addEventListener(
    "pagehide",
    () => {
      // Best effort: send edits still inside the debounce window.
      void store.flush();
      browser.storage.onChanged.removeListener(handleStorageChange);
      shell.dispose();
      app.dispose();
    },
    { once: true },
  );
}

void start().catch(() => {
  document.documentElement.dataset.localized = "true";
  const status = document.querySelector<HTMLElement>("#opt-autosave");
  if (status) {
    status.textContent = message("settingsLoadFailed");
    status.dataset.tone = "error";
  }
});
