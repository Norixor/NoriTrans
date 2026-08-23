import { initializeUiLanguage, message } from "@/src/shared/i18n";
import { browser } from "wxt/browser";

function localizeDocument(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset.i18n;
    if (!key) continue;
    const localized = message(key);
    if (localized) node.textContent = localized;
  }
  document.documentElement.lang = message("documentLanguage");
  document.title = `${message("ocrPermissionTitle")} · ${message("extensionName")}`;
  document.documentElement.dataset.localized = "true";
}

async function initialize(): Promise<void> {
  await initializeUiLanguage();
  localizeDocument();
  const allow = document.querySelector<HTMLButtonElement>("#allow");
  const cancel = document.querySelector<HTMLButtonElement>("#cancel");
  const status = document.querySelector<HTMLElement>("#status");
  if (!allow || !cancel || !status) {
    throw new Error("Missing OCR permission controls");
  }

  status.dataset.tone = "neutral";
  status.textContent = message("ocrPermissionReady");
  allow.focus();

  cancel.addEventListener("click", () => window.close());
  allow.addEventListener("click", () => {
    allow.disabled = true;
    cancel.disabled = true;
    status.dataset.tone = "neutral";
    status.textContent = message("ocrPermissionRequesting");
    void (async () => {
      try {
        const granted = await browser.permissions.request({
          origins: ["<all_urls>"],
        });
        if (!granted) {
          status.dataset.tone = "error";
          status.textContent = message("ocrPermissionDenied");
          allow.disabled = false;
          cancel.disabled = false;
          return;
        }
        try {
          const response: unknown = await browser.runtime.sendMessage({
            type: "OCR_SETTINGS_SET",
            enabled: true,
          });
          if (
            typeof response !== "object" ||
            response === null ||
            !("ok" in response) ||
            response.ok !== true
          ) {
            throw new Error("ocr-settings-save-failed");
          }
          const resumeResponse: unknown = await browser.runtime.sendMessage({
            type: "OCR_PERMISSION_COMPLETE",
          });
          if (
            typeof resumeResponse !== "object" ||
            resumeResponse === null ||
            !("ok" in resumeResponse) ||
            resumeResponse.ok !== true
          ) {
            throw new Error("ocr-permission-complete-failed");
          }
          if (
            !("resumed" in resumeResponse) ||
            resumeResponse.resumed !== true
          ) {
            status.dataset.tone = "warning";
            status.textContent = message("ocrPermissionResumeFailed");
            cancel.textContent = message("ocrPermissionClose");
            cancel.disabled = false;
            return;
          }
        } catch {
          status.dataset.tone = "error";
          status.textContent = message("ocrPermissionSaveFailed");
          allow.disabled = false;
          cancel.disabled = false;
          return;
        }
        status.dataset.tone = "success";
        status.textContent = message("ocrPermissionGranted");
        globalThis.setTimeout(() => window.close(), 700);
      } catch {
        status.dataset.tone = "error";
        status.textContent = message("ocrPermissionDenied");
        allow.disabled = false;
        cancel.disabled = false;
      }
    })();
  });
}

void initialize().catch(() => {
  document.documentElement.dataset.localized = "true";
});
