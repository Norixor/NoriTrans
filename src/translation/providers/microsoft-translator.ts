import { CloudMachineTranslationProvider } from "@/src/translation/providers/cloud-machine";
import { isProviderRecord } from "@/src/translation/providers/cloud-machine";
import type { ProviderCapabilities } from "@/src/translation/types";

function microsoftLanguage(value: string): string {
  const normalized = value.trim().replace(/_/gu, "-").toLowerCase();
  if (normalized === "zh-hant" || normalized === "zh-tw") return "zh-Hant";
  if (normalized === "zh" || normalized === "zh-hans" || normalized === "zh-cn")
    return "zh-Hans";
  return normalized;
}

export class MicrosoftTranslatorProvider extends CloudMachineTranslationProvider {
  readonly id = "microsoft-translator" as const;
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
      "https://api.cognitive.microsofttranslator.com/translate",
    );
    endpoint.searchParams.set("api-version", "3.0");
    endpoint.searchParams.set("to", microsoftLanguage(targetLanguage));
    if (sourceLanguage !== "auto")
      endpoint.searchParams.set("from", microsoftLanguage(sourceLanguage));
    const region = this.config.microsoftRegion?.trim();
    const payload = await this.fetchJson(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": apiKey,
          ...(region ? { "Ocp-Apim-Subscription-Region": region } : {}),
        },
        body: JSON.stringify(texts.map((Text) => ({ Text }))),
      },
      signal,
    );
    if (!Array.isArray(payload)) return [];
    return payload.map((item) => {
      if (!isProviderRecord(item) || !Array.isArray(item.translations))
        return "";
      const first: unknown = item.translations[0];
      return isProviderRecord(first) && typeof first.text === "string"
        ? first.text
        : "";
    });
  }
}
