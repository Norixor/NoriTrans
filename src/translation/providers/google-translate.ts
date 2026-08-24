import {
  CloudMachineTranslationProvider,
  decodeProviderHtml,
  isProviderRecord,
} from "@/src/translation/providers/cloud-machine";
import type { ProviderCapabilities } from "@/src/translation/types";

function googleLanguage(value: string): string {
  const normalized = value.trim().replace(/_/gu, "-").toLowerCase();
  if (normalized === "zh-hant" || normalized === "zh-tw") return "zh-TW";
  if (normalized === "zh-hans" || normalized === "zh-cn") return "zh-CN";
  return normalized;
}

export class GoogleTranslateProvider extends CloudMachineTranslationProvider {
  readonly id = "google-translate" as const;
  readonly capabilities: ProviderCapabilities = {
    maxBatchCharacters: 30_000,
    maxBatchSegments: 100,
    supportsContext: false,
    runtime: "background",
  };

  protected async requestTranslations(
    texts: string[],
    sourceLanguage: string,
    targetLanguage: string,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    const endpoint = new URL(
      "https://translation.googleapis.com/language/translate/v2",
    );
    endpoint.searchParams.set("key", apiKey);
    const payload = await this.fetchJson(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          q: texts,
          target: googleLanguage(targetLanguage),
          ...(sourceLanguage === "auto"
            ? {}
            : { source: googleLanguage(sourceLanguage) }),
          format: "text",
        }),
      },
      signal,
    );
    const translations =
      isProviderRecord(payload) && isProviderRecord(payload.data)
        ? payload.data.translations
        : undefined;
    if (!Array.isArray(translations)) return [];
    return translations.map((item) =>
      isProviderRecord(item) && typeof item.translatedText === "string"
        ? decodeProviderHtml(item.translatedText)
        : "",
    );
  }
}
