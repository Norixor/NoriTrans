import { html, svg, type SVGTemplateResult, type TemplateResult } from "lit";
import type { NtVisualState } from "./shared";

/*
 * Inline SVG glyphs for direction B. Status glyphs encode state by shape so
 * colour is never the only signal (README §2.1). All paths are static
 * literals; nothing is fetched or evaluated at runtime.
 */

const statusGlyphs: Record<NtVisualState, SVGTemplateResult> = {
  idle: svg`<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/>`,
  scanning: svg`<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2.6 2.6" stroke-linecap="round"/>`,
  waiting: svg`<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2.6 2.6" stroke-linecap="round"/>`,
  translating: svg`<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8" opacity=".3"/><path d="M10 3a7 7 0 0 1 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  ready: svg`<circle cx="10" cy="10" r="8" fill="currentColor"/><path d="M6.2 10.3l2.5 2.5 5.1-5.3" fill="none" stroke="var(--nt-on-status)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  partial: svg`<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M10 3a7 7 0 0 1 0 14z" fill="currentColor"/>`,
  cancelled: svg`<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="7" y="7" width="6" height="6" rx="1" fill="currentColor"/>`,
  error: svg`<path d="M10 2.5l8 14H2z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/><path d="M10 8v4.2" stroke="var(--nt-on-status)" stroke-width="2" stroke-linecap="round"/><circle cx="10" cy="14.4" r="1.1" fill="var(--nt-on-status)"/>`,
  disabled: svg`<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 14.5l9-9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  unavailable: svg`<circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="3 2"/><path d="M7 10h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
};

export function statusGlyph(state: NtVisualState): TemplateResult {
  return html`<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
    ${statusGlyphs[state]}
  </svg>`;
}

/** Generic UI icons (24px grid). */
export type NtIconName =
  | "translate"
  | "more"
  | "close"
  | "chevron"
  | "minimize"
  | "settings"
  | "eye-off"
  | "power"
  | "info"
  | "shield"
  | "warning"
  | "refresh"
  | "undo";

const icons: Record<NtIconName, SVGTemplateResult> = {
  translate: svg`<path d="M4 5h9M8.5 3v2M11 5c-.6 3.6-2.8 6.6-6 8.5M6.5 8.5c1 2.4 3 4.4 5.5 5.5M12.5 20l4-9 4 9M13.9 17h5.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  more: svg`<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>`,
  close: svg`<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  chevron: svg`<path d="M8 10l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  minimize: svg`<path d="M6 12h12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  settings: svg`<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  "eye-off": svg`<path d="M3 3l18 18M10.6 10.6A2 2 0 0 0 13.4 13.4M9.9 5.2A10 10 0 0 1 12 5c5 0 9 4 10 7a11 11 0 0 1-3 4.2M6.6 6.6C4.4 8 2.8 10 2 12c1 3 5 7 10 7a9.6 9.6 0 0 0 3.9-.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  power: svg`<path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
  info: svg`<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 11v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.6" r="1.2" fill="currentColor"/>`,
  shield: svg`<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`,
  warning: svg`<path d="M12 3.5l9.5 16.5h-19z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17.2" r="1.2" fill="currentColor"/>`,
  refresh: svg`<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  undo: svg`<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
};

export function isIconName(value: unknown): value is NtIconName {
  return typeof value === "string" && Object.hasOwn(icons, value);
}

export function icon(name: NtIconName): TemplateResult {
  return html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    ${icons[name]}
  </svg>`;
}
