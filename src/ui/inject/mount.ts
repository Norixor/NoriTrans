// The polyfill must be evaluated before `lit` (pulled in through the tokens).
import "./polyfill";
import { adoptStyles, css, type CSSResultOrNative } from "lit";
import {
  NT_THEME_WRAPPER_CLASS,
  applyThemePreference,
  ntThemeWrapperStyles,
  type ThemePreference,
} from "../tokens/tokens";
import { guardInjectedEvents, type EventGuardOptions } from "./event-guard";

/** Host declarations every injected root starts from (all `!important`). */
const BASE_HOST_STYLE: Readonly<Record<string, string>> = {
  // `all` must come first: it resets every longhand set before it.
  all: "initial",
  display: "block",
  position: "fixed",
  "z-index": "2147483647",
};

/*
 * Page rules can still give the host `::before`/`::after` boxes. Important
 * declarations from the inner (shadow) context win over the page's important
 * declarations, so this rule neutralises them.
 */
const ROOT_STYLES = css`
  :host::before,
  :host::after {
    content: none !important;
    display: none !important;
  }
`;

export interface InjectedRootOptions {
  /**
   * Value of the host's `data-noritrans-ui` marker. Page scanning, subtitle
   * DOM detection and stale-UI cleanup recognise extension UI by this
   * attribute; see src/shared/runtime-ui-cleanup.ts for the cleanup list.
   */
  surface: string;
  /**
   * Extra host declarations (property → value), e.g. `inset` or
   * `pointer-events`. Applied with `!important` after the base reset.
   */
  hostStyle?: Readonly<Record<string, string>>;
  /** Initial theme preference of the wrapper; defaults to `system`. */
  theme?: ThemePreference;
  /** Stylesheets for the caller's own layout, adopted after the theme. */
  styles?: readonly CSSResultOrNative[];
  /** Options forwarded to the event guard. */
  eventGuard?: EventGuardOptions;
  /** Parent of the host; defaults to the document element. */
  parent?: Element;
}

export interface InjectedRoot {
  /** Page-facing host element carrying the inline `!important` reset. */
  readonly host: HTMLDivElement;
  /** Open shadow root of `host`. */
  readonly root: ShadowRoot;
  /** `.nt-theme` wrapper that defines the tokens; render content into it. */
  readonly theme: HTMLDivElement;
  /**
   * Sets host declarations with `!important`. An empty value removes the
   * declaration, which falls back to the `all: initial` reset.
   */
  setHostStyle(declarations: Readonly<Record<string, string>>): void;
  /** Applies a theme preference to the wrapper. */
  setTheme(preference: ThemePreference): void;
  /** Removes the event guard and the host. Safe to call more than once. */
  dispose(): void;
}

function applyHostStyle(
  host: HTMLElement,
  declarations: Readonly<Record<string, string>>,
): void {
  for (const [property, value] of Object.entries(declarations)) {
    if (value === "") host.style.removeProperty(property);
    else host.style.setProperty(property, value, "important");
  }
}

/**
 * Creates a shadow-DOM root for UI injected into a website.
 *
 * - The host is a plain `<div>`: a custom tag name could be claimed and
 *   upgraded by the page's own (main-world) registry.
 * - The host's inline `!important` declarations beat page rules such as
 *   `div { display: none !important }`; inline styles are set through CSSOM so
 *   page CSP for style attributes does not apply.
 * - Tokens live on the `.nt-theme` wrapper inside the shadow root, out of
 *   reach of page selectors; see `NT_THEME_WRAPPER_CSS`.
 * - The shadow root is open, matching the existing injected UI, so focus
 *   helpers such as `deepActiveElement()` can descend into it.
 *
 * Components must be defined (`ensureInjectedUi()`) before they are rendered
 * into the wrapper; definitions do not upgrade elements created earlier.
 */
export function createInjectedRoot(options: InjectedRootOptions): InjectedRoot {
  const parent = options.parent ?? document.documentElement;
  const doc = parent.ownerDocument;
  const host = doc.createElement("div");
  host.dataset.noritransUi = options.surface;
  applyHostStyle(host, BASE_HOST_STYLE);
  if (options.hostStyle) applyHostStyle(host, options.hostStyle);

  const root = host.attachShadow({ mode: "open" });
  adoptStyles(root, [
    ntThemeWrapperStyles,
    ROOT_STYLES,
    ...(options.styles ?? []),
  ]);
  const theme = doc.createElement("div");
  theme.className = NT_THEME_WRAPPER_CLASS;
  applyThemePreference(theme, options.theme ?? "system");
  root.append(theme);
  const releaseGuard = guardInjectedEvents(root, options.eventGuard);
  parent.append(host);

  let disposed = false;
  return {
    host,
    root,
    theme,
    setHostStyle: (declarations) => applyHostStyle(host, declarations),
    setTheme: (preference) => applyThemePreference(theme, preference),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      releaseGuard();
      host.remove();
    },
  };
}
