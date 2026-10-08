import { html, nothing, type TemplateResult } from "lit";
import type { LocalTranslationRuntimeInfo } from "@/src/messaging/protocol";
import { message, currentUiLocale } from "@/src/shared/i18n";
import {
  displayLanguageName,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
} from "@/src/shared/languages";
import type {
  AiProviderId,
  AppSettings,
  FastProviderId,
} from "@/src/shared/settings";
import type { SettingsPatch } from "@/src/shared/settings-patch";
import type { NtSegmentOption, NtSelectOption } from "@/src/ui/components";
import {
  installedBergamotPackIds,
  providerSourceLanguageAvailable,
  providerTargetLanguageAvailable,
} from "@/src/translation/provider-capabilities";
import type { TranslationMode } from "@/src/translation/types";

/** Language support known for the device-side providers. */
export interface LanguageCapabilities {
  chromePairs: string[];
  chromeLoaded: boolean;
  localRuntimes: LocalTranslationRuntimeInfo[];
  localLoaded: boolean;
}

/** What every section template receives from the options app. */
export interface SectionContext {
  settings: AppSettings;
  capabilities: LanguageCapabilities;
  /** Autosaves `patch` after the debounce window. */
  update(patch: SettingsPatch, debounceMs?: number): void;
  beginEditing(path: string): void;
  endEditing(path: string): void;
}

export function languageLabel(code: string): string {
  return code === "auto"
    ? message("languageAuto")
    : displayLanguageName(code, currentUiLocale());
}

/** The provider a surface uses for `mode`, for language availability. */
export function surfaceProvider(
  settings: AppSettings,
  mode: TranslationMode,
): FastProviderId | AiProviderId {
  return mode === "ai"
    ? settings.provider.aiProvider
    : settings.provider.fastProvider;
}

/**
 * Language choices filtered by what `provider` can do on this device. A
 * stored value that is no longer available stays selectable-but-disabled so
 * the control never silently shows a different language than the setting.
 */
export function languageOptions(
  kind: "source" | "target",
  provider: FastProviderId | AiProviderId | "chrome-local" | "bergamot-local",
  capabilities: LanguageCapabilities,
  selected: string,
): NtSelectOption[] {
  const ready =
    provider === "chrome-local"
      ? capabilities.chromeLoaded
      : provider === "bergamot-local"
        ? capabilities.localLoaded
        : true;
  const translationCapabilities = {
    chromePairs: capabilities.chromePairs,
    installedBergamotPackIds: installedBergamotPackIds(
      capabilities.localRuntimes,
    ),
  };
  const languages = kind === "source" ? SOURCE_LANGUAGES : TARGET_LANGUAGES;
  const available = (code: string): boolean =>
    !ready ||
    (kind === "source"
      ? providerSourceLanguageAvailable(provider, code, translationCapabilities)
      : providerTargetLanguageAvailable(
          provider,
          code,
          translationCapabilities,
        ));
  const options: NtSelectOption[] = languages
    .filter(({ code }) => available(code))
    .map(({ code }) => ({ value: code, label: languageLabel(code) }));
  if (!options.some((option) => option.value === selected)) {
    options.unshift({
      value: selected,
      label: `${languageLabel(selected)} · ${message("languageUnavailable")}`,
      disabled: true,
    });
  }
  return options;
}

export function modeOptions(): NtSegmentOption[] {
  return [
    { value: "ai", label: message("translationMethodAi") },
    { value: "fast", label: message("optModeFast") },
  ];
}

export function responseModeOptions(): NtSegmentOption[] {
  return [
    { value: "stream", label: message("responseModeStream") },
    { value: "batch", label: message("responseModeBatch") },
  ];
}

export function detailValue<T>(event: Event): T {
  return (event as CustomEvent<{ value: T }>).detail.value;
}

export function detailChecked(event: Event): boolean {
  return (event as CustomEvent<{ checked: boolean }>).detail.checked;
}

/** A settings row: label column and control column. */
export function row(
  label: string,
  help: string | undefined,
  content: unknown,
  options: { id?: string } = {},
): TemplateResult {
  return html`<div class="r" id=${options.id ?? nothing}>
    <div class="lab">
      ${label}${help ? html`<small>${help}</small>` : nothing}
    </div>
    <div class="val">${content}</div>
  </div>`;
}

/** A row whose whole content is one switch (label and help inside it). */
export function switchRow(content: TemplateResult): TemplateResult {
  return html`<div class="r sw-row">${content}</div>`;
}

const ADVANCED_STORAGE_KEY = "noritrans.options.advancedOpen";
const advancedMemory = new Map<string, boolean>();

function readAdvancedOpen(id: string): boolean {
  if (advancedMemory.has(id)) return advancedMemory.get(id) === true;
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(ADVANCED_STORAGE_KEY) ?? "{}",
    );
    const value =
      typeof stored === "object" && stored !== null
        ? (stored as Record<string, unknown>)[id]
        : undefined;
    advancedMemory.set(id, value === true);
  } catch {
    advancedMemory.set(id, false);
  }
  return advancedMemory.get(id) === true;
}

/** Remembers a `details.adv` open state (per viewer, best effort). */
export function rememberAdvancedOpen(id: string, open: boolean): void {
  advancedMemory.set(id, open);
  try {
    localStorage.setItem(
      ADVANCED_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(advancedMemory)),
    );
  } catch {
    // Storage can be unavailable; the in-memory state still applies.
  }
}

/** Collapsible "advanced" block whose open state is remembered. */
export function advanced(
  id: string,
  summary: string,
  body: unknown,
): TemplateResult {
  return html`<details
    class="adv"
    id=${id}
    ?open=${readAdvancedOpen(id)}
    @toggle=${(event: Event) =>
      rememberAdvancedOpen(
        id,
        (event.currentTarget as HTMLDetailsElement).open,
      )}
  >
    <summary>
      <span>${summary}</span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M8 10l4 4 4-4"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </summary>
    <div class="rows">${body}</div>
  </details>`;
}

/** A titled group card. */
export function groupCard(
  id: string,
  title: string,
  body: unknown,
  options: {
    headerExtra?: TemplateResult;
    advanced?: TemplateResult;
  } = {},
): TemplateResult {
  return html`<section class="grp" aria-labelledby=${`${id}-title`}>
    <header>
      <h2 id=${`${id}-title`}>${title}</h2>
      ${options.headerExtra ?? nothing}
    </header>
    <div class="rows">${body}</div>
    ${options.advanced ?? nothing}
  </section>`;
}

/** Inline feedback line (polite live region). */
export function feedback(
  text: string,
  tone: "" | "success" | "error" = "",
  id?: string,
): TemplateResult {
  return html`<p
    class="feedback"
    data-tone=${tone}
    id=${id ?? nothing}
    role="status"
    aria-live="polite"
  >
    ${text}
  </p>`;
}
