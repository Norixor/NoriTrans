import {
  OCR_RUNTIME_LANGUAGES,
  selectInstalledOcrRuntime,
  type OcrRuntimeLanguage,
} from "@/src/ocr/languages";
import { browser } from "wxt/browser";

function installedLanguages(response: unknown): OcrRuntimeLanguage[] {
  if (
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    response.ok !== true ||
    !("runtimes" in response) ||
    !Array.isArray(response.runtimes)
  ) {
    throw new Error("ocr-runtime-list-failed");
  }
  const known = new Set<string>(OCR_RUNTIME_LANGUAGES);
  const installed: OcrRuntimeLanguage[] = [];
  for (const runtime of response.runtimes as unknown[]) {
    if (
      typeof runtime !== "object" ||
      runtime === null ||
      !("state" in runtime) ||
      runtime.state !== "installed" ||
      !("languages" in runtime) ||
      !Array.isArray(runtime.languages)
    ) {
      continue;
    }
    for (const language of runtime.languages as unknown[]) {
      if (typeof language === "string" && known.has(language)) {
        installed.push(language as OcrRuntimeLanguage);
      }
    }
  }
  return installed;
}

/**
 * Default readiness probe for the image recognition block: asks the
 * background for the installed recognition packs (the read-only
 * `OCR_RUNTIME_LIST` message the options page uses) and checks the one the
 * source language needs. Never downloads anything (AGENTS §7). Rejects when
 * the answer is unusable or the language has no pack, so the caller shows
 * nothing rather than guessing.
 */
export async function defaultQueryOcrRuntime(
  sourceLanguage: string,
): Promise<boolean> {
  const response: unknown = await browser.runtime.sendMessage({
    type: "OCR_RUNTIME_LIST",
  });
  return (
    selectInstalledOcrRuntime(sourceLanguage, installedLanguages(response)) !==
    undefined
  );
}
