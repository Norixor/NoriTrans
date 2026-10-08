import {
  initializeUiLanguage,
  localizeDocument,
  message,
} from "@/src/shared/i18n";
import { loadSettings } from "@/src/shared/settings";
import { defineNtComponents } from "@/src/ui/components";
import { installDocumentTheme } from "@/src/ui/tokens/tokens";
import { PopupApp } from "./app";

/** Popup entry: installs the theme and components, then starts the app. */
async function start(): Promise<void> {
  installDocumentTheme();
  defineNtComponents();
  await initializeUiLanguage();
  localizeDocument();
  const root = document.querySelector<HTMLElement>("#popup");
  if (!root) throw new Error("popup_root_missing");
  const app = new PopupApp(root, await loadSettings());
  window.addEventListener("pagehide", () => app.dispose(), { once: true });
  await app.start();
}

void start().catch(() => {
  document.documentElement.dataset.localized = "true";
  const root = document.querySelector<HTMLElement>("#popup");
  if (!root) return;
  const failure = document.createElement("p");
  failure.className = "notice";
  failure.setAttribute("role", "alert");
  failure.textContent = message("settingsLoadFailed");
  root.replaceChildren(failure);
  root.setAttribute("aria-busy", "false");
});
