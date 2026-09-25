import type { FastProviderId } from "@/src/shared/settings";
import type { TranslationMode } from "@/src/translation/types";

export type TranslationMethodValue = `fast:${FastProviderId}` | "ai";

export interface TranslationMethodSelection {
  mode: TranslationMode;
  fastProvider?: FastProviderId;
}

export const TRANSLATION_METHODS: readonly {
  value: TranslationMethodValue;
  labelKey: string;
}[] = [
  { value: "fast:chrome-local", labelKey: "translationMethodChromeLocal" },
  {
    value: "fast:bergamot-local",
    labelKey: "translationMethodBergamotLocal",
  },
  {
    value: "fast:google-translate",
    labelKey: "translationMethodGoogleTranslate",
  },
  {
    value: "fast:microsoft-translator",
    labelKey: "translationMethodMicrosoftTranslator",
  },
  { value: "fast:deepl", labelKey: "translationMethodDeepL" },
  {
    value: "ai",
    labelKey: "translationMethodAi",
  },
] as const;

export function translationMethodValue(
  mode: TranslationMode,
  fastProvider: FastProviderId,
): TranslationMethodValue {
  return mode === "ai" ? "ai" : `fast:${fastProvider}`;
}

export function parseTranslationMethod(
  value: string,
): TranslationMethodSelection | undefined {
  if (
    value === "ai" ||
    value === "ai:openai-compatible" ||
    value === "fast:openai-compatible"
  ) {
    return { mode: "ai" };
  }
  const provider = value.startsWith("fast:") ? value.slice(5) : "";
  if (
    provider === "chrome-local" ||
    provider === "bergamot-local" ||
    provider === "google-translate" ||
    provider === "microsoft-translator" ||
    provider === "deepl"
  ) {
    return { mode: "fast", fastProvider: provider };
  }
  return undefined;
}
