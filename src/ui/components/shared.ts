import { css } from "lit";

/**
 * Visual states shared by status glyphs, the status card and the floating
 * button. Mirrors the unified status model (README §2.1); the mapping from
 * domain status to these presentational states belongs to the caller.
 */
export type NtVisualState =
  | "disabled"
  | "unavailable"
  | "idle"
  | "scanning"
  | "waiting"
  | "translating"
  | "ready"
  | "partial"
  | "cancelled"
  | "error";

export const NT_VISUAL_STATES: readonly NtVisualState[] = [
  "disabled",
  "unavailable",
  "idle",
  "scanning",
  "waiting",
  "translating",
  "ready",
  "partial",
  "cancelled",
  "error",
];

export function isVisualState(value: unknown): value is NtVisualState {
  return (
    typeof value === "string" &&
    (NT_VISUAL_STATES as readonly string[]).includes(value)
  );
}

/** States that render as "work in progress" (spinning glyph, progress tone). */
export function isBusyState(state: NtVisualState): boolean {
  return state === "scanning" || state === "waiting" || state === "translating";
}

/** Clamps a 0..1 progress value; `null`/NaN means indeterminate. */
export function normalizeProgress(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined || !Number.isFinite(value))
    return null;
  return Math.min(1, Math.max(0, value));
}

/**
 * Dispatches a bubbling custom event on the component itself. It is
 * deliberately not composed: consumers listen on the element (or an ancestor
 * inside the same tree), while a page script listening on `window` or
 * `document`, in either the capture or bubble phase, never sees the event or
 * its `detail` once the component lives in an injected shadow root.
 */
export function emit<T>(target: EventTarget, type: string, detail: T): boolean {
  return target.dispatchEvent(
    new CustomEvent<T>(type, {
      detail,
      bubbles: true,
      composed: false,
      cancelable: true,
    }),
  );
}

/** Returns the focused element, descending through open shadow roots. */
export function deepActiveElement(doc: Document = document): Element | null {
  let active: Element | null = doc.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active;
}

/**
 * Base rules every component includes. Tokens come from the theme root
 * (see src/ui/tokens); components only consume them.
 */
export const baseStyles = css`
  :host {
    box-sizing: border-box;
    font-family: var(--nt-font);
    -webkit-tap-highlight-color: transparent;
  }
  :host([hidden]) {
    display: none !important;
  }
  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }
  button,
  input,
  select {
    font: inherit;
    color: inherit;
    margin: 0;
  }
  :focus {
    outline: none;
  }
  :focus-visible {
    outline: var(--nt-focus-width) solid var(--nt-focus);
    outline-offset: 2px;
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
  @keyframes nt-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
`;

/**
 * Extends a control's hit area to the 44px minimum without changing its
 * visual size. Apply `.hit` to a positioned control.
 */
export const hitAreaStyles = css`
  .hit {
    position: relative;
  }
  .hit::before {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: max(100%, var(--nt-target-min));
    height: max(100%, var(--nt-target-min));
    transform: translate(-50%, -50%);
  }
`;
