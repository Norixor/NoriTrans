import type { FastProviderId } from "@/src/shared/settings";
import type { TranslationMode } from "@/src/translation/types";

export type TranslationMethodValue =
  `fast:${FastProviderId}` | "ai:openai-compatible";

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
    value: "fast:openai-compatible",
    labelKey: "translationMethodOpenAiFast",
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
    value: "ai:openai-compatible",
    labelKey: "translationMethodOpenAiAi",
  },
] as const;

export function translationMethodValue(
  mode: TranslationMode,
  fastProvider: FastProviderId,
): TranslationMethodValue {
  return mode === "ai" ? "ai:openai-compatible" : `fast:${fastProvider}`;
}

export function parseTranslationMethod(
  value: string,
): TranslationMethodSelection | undefined {
  if (value === "ai:openai-compatible") {
    return { mode: "ai" };
  }
  const provider = value.startsWith("fast:") ? value.slice(5) : "";
  if (
    provider === "chrome-local" ||
    provider === "bergamot-local" ||
    provider === "openai-compatible" ||
    provider === "google-translate" ||
    provider === "microsoft-translator" ||
    provider === "deepl"
  ) {
    return { mode: "fast", fastProvider: provider };
  }
  return undefined;
}
