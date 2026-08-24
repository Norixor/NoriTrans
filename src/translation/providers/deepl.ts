import {
  CloudMachineTranslationProvider,
  isProviderRecord,
} from "@/src/translation/providers/cloud-machine";
import type { ProviderCapabilities } from "@/src/translation/types";

function deeplLanguage(value: string, target: boolean): string {
  const normalized = value.trim().replace(/_/gu, "-").toLowerCase();
  if (normalized === "zh-hant" || normalized === "zh-tw") return "ZH-HANT";
  if (normalized === "zh" || normalized === "zh-hans" || normalized === "zh-cn")
    return target ? "ZH-HANS" : "ZH";
  return normalized.toUpperCase();
}

export class DeepLProvider extends CloudMachineTranslationProvider {
  readonly id = "deepl" as const;
  readonly capabilities: ProviderCapabilities = {
    maxBatchCharacters: 30_000,
    maxBatchSegments: 50,
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
    const origin =
      this.config.deeplPlan === "pro"
        ? "https://api.deepl.com"
        : "https://api-free.deepl.com";
    const payload = await this.fetchJson(
      `${origin}/v2/translate`,
      {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: texts,
          target_lang: deeplLanguage(targetLanguage, true),
          ...(sourceLanguage === "auto"
            ? {}
            : { source_lang: deeplLanguage(sourceLanguage, false) }),
        }),
      },
      signal,
    );
    const translations = isProviderRecord(payload)
      ? payload.translations
      : undefined;
    if (!Array.isArray(translations)) return [];
    return translations.map((item) =>
      isProviderRecord(item) && typeof item.text === "string" ? item.text : "",
    );
  }
}
