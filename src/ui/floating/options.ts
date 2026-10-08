import { currentUiLocale, message } from "@/src/shared/i18n";
import {
  displayLanguageName,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
} from "@/src/shared/languages";
import type { AiProviderId, FastProviderId } from "@/src/shared/settings";
import {
  TRANSLATION_METHODS,
  translationMethodValue,
} from "@/src/shared/translation-methods";
import {
  providerLanguagePairAvailable,
  providerSourceLanguageAvailable,
  providerTargetLanguageAvailable,
  type TranslationCapabilities,
} from "@/src/translation/provider-capabilities";
import type { TranslationMode } from "@/src/translation/types";
import type { NtSelectOption } from "@/src/ui/components";

/**
 * Option lists and availability rules shared by the floating control tabs.
 * Availability follows the previous control: until the capability query
 * settles every language counts as available, so nothing is hidden on a
 * slow or failed probe.
 */
export interface CapabilitySnapshot {
  ready: boolean;
  capabilities: TranslationCapabilities;
}

export const EMPTY_CAPABILITIES: CapabilitySnapshot = {
  ready: false,
  capabilities: { chromePairs: [], installedBergamotPackIds: [] },
};

export type LanguageProviderId = FastProviderId | AiProviderId;

export function languageLabel(
  code: string,
  locale = currentUiLocale(),
): string {
  return code === "auto"
    ? message("languageAuto")
    : displayLanguageName(code, locale);
}

/**
 * Languages the provider supports. The current value is always present: when
 * the provider cannot use it, it is prepended disabled and marked
 * unavailable, so the select never silently shows another language.
 */
export function languageOptions(
  role: "source" | "target",
  provider: LanguageProviderId,
  current: string,
  snapshot: CapabilitySnapshot,
  locale = currentUiLocale(),
): NtSelectOption[] {
  const languages = role === "source" ? SOURCE_LANGUAGES : TARGET_LANGUAGES;
  const available = (code: string): boolean =>
    !snapshot.ready ||
    (role === "source"
      ? providerSourceLanguageAvailable(provider, code, snapshot.capabilities)
      : providerTargetLanguageAvailable(provider, code, snapshot.capabilities));
  const options: NtSelectOption[] = languages
    .filter(({ code }) => available(code))
    .map(({ code }) => ({ value: code, label: languageLabel(code, locale) }));
  if (!options.some((option) => option.value === current)) {
    options.unshift({
      value: current,
      label: `${languageLabel(current, locale)} · ${message("languageUnavailable")}`,
      disabled: true,
    });
  }
  return options;
}

export function pairAvailable(
  provider: LanguageProviderId,
  sourceLanguage: string,
  targetLanguage: string,
  snapshot: CapabilitySnapshot,
): boolean {
  return (
    !snapshot.ready ||
    providerLanguagePairAvailable(
      provider,
      sourceLanguage,
      targetLanguage,
      snapshot.capabilities,
    )
  );
}

export function methodOptions(): NtSelectOption[] {
  return TRANSLATION_METHODS.map(({ value, labelKey }) => ({
    value,
    label: message(labelKey),
  }));
}

export function methodLabel(
  mode: TranslationMode,
  fastProvider: FastProviderId,
): string {
  const value = translationMethodValue(mode, fastProvider);
  const entry = TRANSLATION_METHODS.find((method) => method.value === value);
  return entry ? message(entry.labelKey) : value;
}
