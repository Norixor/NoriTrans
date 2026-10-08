import { unsafeCSS, type CSSResult } from "lit";

/**
 * Direction B "Prism" design tokens.
 *
 * The token maps below are the single source of truth. They are emitted as CSS
 * custom properties (prefixed `--nt-`) in three shapes:
 *
 * - `NT_THEME_WRAPPER_CSS` / `ntThemeWrapperStyles` for injected UI: tokens
 *   live on a `.nt-theme` wrapper element *inside* the root shadow tree (see
 *   src/ui/inject/mount.ts). This is the only shape that is safe on websites.
 * - `NT_THEME_HOST_CSS` / `ntThemeHostStyles` on a shadow host (`:host`). Not
 *   suitable for injected UI: the host element is matched by page selectors,
 *   and a page rule such as `* { --nt-fg: red !important }` wins over `:host`
 *   declarations (custom properties are not reset by `all: initial` either).
 *   Measured in Chromium against a hostile page.
 * - `NT_THEME_DOCUMENT_CSS` for extension pages (`:root`).
 *
 * Components never define tokens themselves; they only read them, so the
 * values cascade from whichever theme root they are rendered under.
 *
 * Deviations from the b-prism draft, from measured WCAG contrast:
 * `fg-3` is darker (light) / lighter (dark) so tertiary text reaches 4.5:1 on
 * every surface, and `accent-text` is added for accent-coloured text on
 * `accent-soft` (the draft's accent on accent-soft measured 4.26:1).
 *
 * Theme semantics match the existing UI: follow `prefers-color-scheme` by
 * default, and allow an explicit override through `data-theme="light|dark"`
 * on the theme root (`.nt-theme` wrapper, `:host` element or `<html>`).
 */

export type ThemePreference = "system" | "light" | "dark";

type TokenMap = Readonly<Record<string, string>>;

/** Tokens that do not change between light and dark. */
export const NT_STATIC_TOKENS: TokenMap = {
  font: 'ui-rounded, "SF Pro Rounded", -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI Variable", "Segoe UI", "Noto Sans CJK SC", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  "fs-xs": "12px",
  "fs-sm": "13px",
  "fs-body": "14px",
  "fs-lead": "15px",
  "fs-title": "16px",
  "fs-display": "26px",
  "lh-body": "1.5",
  "lh-tight": "1.3",
  "r-card": "16px",
  "r-ctl": "12px",
  "r-pill": "999px",
  "space-1": "4px",
  "space-2": "6px",
  "space-3": "8px",
  "space-4": "12px",
  "space-5": "16px",
  "space-6": "24px",
  "target-min": "44px",
  "focus-width": "3px",
  "dur-fast": "120ms",
  "dur-base": "180ms",
  "dur-slow": "280ms",
  "ease-standard": "cubic-bezier(0.2, 0, 0, 1)",
};

export const NT_LIGHT_TOKENS: TokenMap = {
  bg: "#f4f3fb",
  surface: "#ffffff",
  "surface-2": "#f6f5fd",
  "surface-3": "#ecebf7",
  glass: "rgba(255, 255, 255, 0.86)",
  fg: "#181530",
  "fg-2": "#5b5878",
  "fg-3": "#69668c",
  line: "#e3e1f2",
  "line-2": "#eeedf7",
  accent: "#6a4cff",
  "accent-hover": "#5636e6",
  "accent-soft": "#ece7ff",
  "accent-text": "#5636e6",
  "on-accent": "#ffffff",
  focus: "#6a4cff",
  "s-progress": "#6a4cff",
  "s-ok": "#0b7a52",
  "s-warn": "#a34b04",
  "s-err": "#bf2a30",
  "s-neutral": "#8e8ba8",
  "on-status": "#ffffff",
  "s-progress-bg": "#ece7ff",
  "s-ok-bg": "#dcf6ea",
  "s-warn-bg": "#fdebd8",
  "s-err-bg": "#fde3e4",
  "s-neutral-bg": "#eeedf7",
  "shadow-float":
    "0 2px 6px rgba(24, 21, 48, 0.08), 0 16px 40px rgba(24, 21, 48, 0.18)",
  "shadow-card":
    "0 1px 2px rgba(24, 21, 48, 0.05), 0 4px 16px rgba(24, 21, 48, 0.06)",
  "fab-bg": "linear-gradient(145deg, #7b5cff, #5a3de6)",
  "fab-fg": "#ffffff",
  "fab-ring": "#ffffff",
  "fab-ring-track": "rgba(255, 255, 255, 0.28)",
  "badge-border": "#ffffff",
  "sub-bg": "rgba(12, 10, 26, 0.74)",
  "sub-fg": "#ffffff",
};

export const NT_DARK_TOKENS: TokenMap = {
  bg: "#0e0d1a",
  surface: "#181630",
  "surface-2": "#1f1d3a",
  "surface-3": "#282647",
  glass: "rgba(24, 22, 48, 0.88)",
  fg: "#f1efff",
  "fg-2": "#b3b0d0",
  "fg-3": "#908db0",
  line: "#2d2b4d",
  "line-2": "#242243",
  accent: "#a08cff",
  "accent-hover": "#b6a6ff",
  "accent-soft": "#2a2452",
  "accent-text": "#b6a6ff",
  "on-accent": "#120f2a",
  focus: "#b6a6ff",
  "s-progress": "#a08cff",
  "s-ok": "#3ed59b",
  "s-warn": "#f5a04a",
  "s-err": "#ff7a7f",
  "s-neutral": "#8f8cad",
  "on-status": "#120f2a",
  "s-progress-bg": "#2a2452",
  "s-ok-bg": "#133a2c",
  "s-warn-bg": "#3f2a14",
  "s-err-bg": "#42202a",
  "s-neutral-bg": "#262442",
  "shadow-float":
    "0 2px 6px rgba(0, 0, 0, 0.4), 0 18px 48px rgba(0, 0, 0, 0.55)",
  "shadow-card": "0 1px 2px rgba(0, 0, 0, 0.3), 0 6px 20px rgba(0, 0, 0, 0.25)",
  "fab-bg": "linear-gradient(145deg, #a08cff, #7b5cff)",
  "fab-fg": "#120f2a",
  "fab-ring": "#120f2a",
  "fab-ring-track": "rgba(18, 15, 42, 0.28)",
  "badge-border": "#181630",
  "sub-bg": "rgba(12, 10, 26, 0.74)",
  "sub-fg": "#ffffff",
};

function declarations(tokens: TokenMap): string {
  return Object.entries(tokens)
    .map(([name, value]) => `--nt-${name}: ${value};`)
    .join(" ");
}

interface ThemeSelectors {
  /** Matches the theme root regardless of preference. */
  root: string;
  /** Matches the theme root unless it pins the light palette. */
  followsSystem: string;
  /** Matches the theme root when it pins `theme` through `data-theme`. */
  explicit(theme: "light" | "dark"): string;
}

const HOST_SELECTORS: ThemeSelectors = {
  root: ":host",
  followsSystem: `:host(:not([data-theme="light"]))`,
  explicit: (theme) => `:host([data-theme="${theme}"])`,
};

const DOCUMENT_SELECTORS: ThemeSelectors = {
  root: ":root",
  followsSystem: `:root:not([data-theme="light"])`,
  explicit: (theme) => `:root[data-theme="${theme}"]`,
};

/** Class of the theme wrapper element inside an injected shadow root. */
export const NT_THEME_WRAPPER_CLASS = "nt-theme";

const WRAPPER_SELECTORS: ThemeSelectors = {
  root: `.${NT_THEME_WRAPPER_CLASS}`,
  followsSystem: `.${NT_THEME_WRAPPER_CLASS}:not([data-theme="light"])`,
  explicit: (theme) => `.${NT_THEME_WRAPPER_CLASS}[data-theme="${theme}"]`,
};

const BASE_TYPOGRAPHY = `color: var(--nt-fg); font-family: var(--nt-font); font-size: var(--nt-fs-body); line-height: var(--nt-lh-body); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;`;

/*
 * The injected host is reset with `all: initial`, so the wrapper restores the
 * remaining inherited text properties explicitly instead of relying on
 * whatever the reset produced.
 */
const WRAPPER_TYPOGRAPHY = `${BASE_TYPOGRAPHY} font-weight: 400; font-style: normal; letter-spacing: normal; word-spacing: normal; text-align: start; text-indent: 0; text-transform: none; white-space: normal; visibility: visible;`;

/** Builds the theme rule set for one theme-root shape. */
function themeCss(selectors: ThemeSelectors, base: string): string {
  return [
    `${selectors.root} { ${declarations(NT_STATIC_TOKENS)} ${declarations(NT_LIGHT_TOKENS)} color-scheme: light; ${base} }`,
    `@media (prefers-color-scheme: dark) { ${selectors.followsSystem} { ${declarations(NT_DARK_TOKENS)} color-scheme: dark; } }`,
    `${selectors.explicit("light")} { ${declarations(NT_LIGHT_TOKENS)} color-scheme: light; }`,
    `${selectors.explicit("dark")} { ${declarations(NT_DARK_TOKENS)} color-scheme: dark; }`,
  ].join("\n");
}

/**
 * Theme tokens for the `.nt-theme` wrapper inside an injected shadow root, as
 * plain CSS text. Use this (not the host shape) for UI injected into websites.
 */
export const NT_THEME_WRAPPER_CSS: string = themeCss(
  WRAPPER_SELECTORS,
  `display: block; ${WRAPPER_TYPOGRAPHY}`,
);

/** `NT_THEME_WRAPPER_CSS` as a Lit stylesheet. */
export const ntThemeWrapperStyles: CSSResult = unsafeCSS(NT_THEME_WRAPPER_CSS);

/**
 * Theme tokens on a shadow host (`:host`), as plain CSS text. Only for hosts in
 * extension-owned documents; injected UI uses `NT_THEME_WRAPPER_CSS`.
 */
export const NT_THEME_HOST_CSS: string = themeCss(
  HOST_SELECTORS,
  BASE_TYPOGRAPHY,
);

/** Theme tokens for extension pages (popup/options), as plain CSS text. */
export const NT_THEME_DOCUMENT_CSS: string = themeCss(
  DOCUMENT_SELECTORS,
  BASE_TYPOGRAPHY,
);

/** `NT_THEME_HOST_CSS` as a Lit stylesheet for `static styles`. */
export const ntThemeHostStyles: CSSResult = unsafeCSS(NT_THEME_HOST_CSS);

const DOCUMENT_STYLE_ID = "nt-theme-tokens";

/**
 * Installs the document-level token stylesheet once. Intended for extension
 * pages only; never call it from a content script on a website document.
 */
export function installDocumentTheme(doc: Document = document): void {
  if (doc.getElementById(DOCUMENT_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = DOCUMENT_STYLE_ID;
  style.textContent = NT_THEME_DOCUMENT_CSS;
  doc.head.append(style);
}

/**
 * Applies a theme preference to a theme root. `system` removes the override so
 * `prefers-color-scheme` decides; `light`/`dark` pin the palette.
 */
export function applyThemePreference(
  root: HTMLElement,
  preference: ThemePreference,
): void {
  if (preference === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", preference);
  }
}
