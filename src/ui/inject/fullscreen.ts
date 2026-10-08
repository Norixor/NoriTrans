/**
 * Keeps an injected host visible while the page is in fullscreen, and
 * interactive where Chromium allows it, then puts it back where it was.
 *
 * Measured in Chromium 151 (headless and headed):
 * - Only the fullscreen element's subtree and later top-layer elements are
 *   painted above the fullscreen element.
 * - Everything outside the fullscreen element's subtree is inert while it is
 *   fullscreen, including a `popover` shown later at the document root: it is
 *   painted on top but receives no pointer or focus. (The existing floating
 *   control portal lives at the document root and is affected by this.)
 * - A `popover="manual"` portal *inside* the fullscreen element is painted on
 *   top and stays interactive, independent of the page's stacking contexts,
 *   overflow clipping or transforms.
 * - A `<video>` (or other replaced element) renders no children, so nothing can
 *   be interactive above it short of a modal dialog, which would make the video
 *   and its native controls inert. The portal is then placed at the document
 *   root: visible, but inert (`inert-portal`), and callers should present
 *   status-only UI.
 *
 * The portal covers the viewport with `pointer-events: none`; the host's own
 * `all: initial` reset restores `pointer-events: auto`, so only the host takes
 * input. The portal carries the same inline `!important` reset as the host so
 * page rules (e.g. `div { display: none !important }` or borders on
 * `[popover]`) cannot hide or decorate it, and is itself a shadow host so its
 * pseudo-elements can be suppressed (inline styles cannot reach them).
 */

/** How the host is currently presented. */
export type FullscreenPresentation =
  /** Not in fullscreen; the host is at its original position. */
  | "inline"
  /** Top-layer portal inside the fullscreen element: visible, interactive. */
  | "portal"
  /** Top-layer portal at the root (childless fullscreen element): inert. */
  | "inert-portal"
  /** Appended to the fullscreen element (no Popover API): interactive. */
  | "element"
  /** No Popover API and a childless fullscreen element: not shown. */
  | "unsupported";

export interface FullscreenChange {
  presentation: FullscreenPresentation;
  /** Innermost fullscreen element reachable through open shadow roots. */
  fullscreenElement: Element | null;
}

export interface FullscreenPortalOptions {
  /** Host element to keep visible; it must already be connected. */
  host: HTMLElement;
  /** `data-noritrans-ui` marker for the portal element. */
  surface: string;
  /** Called after the host has been moved for a fullscreen change. */
  onChange?: (change: FullscreenChange) => void;
}

export interface FullscreenPortal {
  readonly presentation: FullscreenPresentation;
  /** Re-evaluates the current fullscreen state (e.g. right after mounting). */
  sync(): void;
  /** Restores the host, removes the portal and stops listening. */
  dispose(): void;
}

const PORTAL_STYLE: Readonly<Record<string, string>> = {
  all: "initial",
  display: "block",
  position: "fixed",
  inset: "0",
  width: "100vw",
  height: "100vh",
  "max-width": "none",
  "max-height": "none",
  margin: "0",
  padding: "0",
  border: "0",
  background: "transparent",
  overflow: "visible",
  "pointer-events": "none",
};

/*
 * Important declarations from the inner (shadow) context beat the page's
 * important declarations, so this suppresses page `div::before` rules.
 */
const PORTAL_SHADOW_CSS =
  ":host::before, :host::after { content: none !important; display: none !important; }";

function adoptPortalStyles(root: ShadowRoot): void {
  const doc = root.ownerDocument;
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(PORTAL_SHADOW_CSS);
    root.adoptedStyleSheets = [sheet];
    return;
  } catch {
    // Constructable stylesheets unavailable; fall back to a style element.
  }
  const style = doc.createElement("style");
  style.textContent = PORTAL_SHADOW_CSS;
  root.append(style);
}

/** HTML elements whose children are never rendered. */
const CHILDLESS_ELEMENTS = new Set([
  "AUDIO",
  "CANVAS",
  "EMBED",
  "IFRAME",
  "IMG",
  "OBJECT",
  "VIDEO",
]);

interface PopoverElement extends HTMLElement {
  showPopover(): void;
  hidePopover(): void;
}

function supportsPopover(element: HTMLElement): element is PopoverElement {
  return (
    typeof (element as Partial<PopoverElement>).showPopover === "function" &&
    typeof (element as Partial<PopoverElement>).hidePopover === "function"
  );
}

/**
 * `document.fullscreenElement` is retargeted to a shadow host when the page
 * fullscreens an element inside a shadow tree; descend through open roots.
 */
export function deepFullscreenElement(doc: Document): Element | null {
  let element = doc.fullscreenElement;
  while (element?.shadowRoot?.fullscreenElement) {
    element = element.shadowRoot.fullscreenElement;
  }
  return element;
}

function canHostChildren(element: Element): boolean {
  return (
    element instanceof HTMLElement && !CHILDLESS_ELEMENTS.has(element.tagName)
  );
}

export function createFullscreenPortal(
  options: FullscreenPortalOptions,
): FullscreenPortal {
  const { host } = options;
  const doc = host.ownerDocument;
  const portal = doc.createElement("div");
  portal.dataset.noritransUi = options.surface;
  portal.setAttribute("popover", "manual");
  for (const [property, value] of Object.entries(PORTAL_STYLE)) {
    portal.style.setProperty(property, value, "important");
  }
  const portalRoot = portal.attachShadow({ mode: "open" });
  adoptPortalStyles(portalRoot);
  portalRoot.append(doc.createElement("slot"));

  let presentation: FullscreenPresentation = "inline";
  let origin: { parent: Node; next: Node | null } | undefined;
  let disposed = false;

  const hidePortal = (): void => {
    if (!supportsPopover(portal)) return;
    try {
      portal.hidePopover();
    } catch {
      // Already closed, e.g. by the browser when the portal was moved.
    }
  };

  const restore = (): void => {
    hidePortal();
    portal.remove();
    if (origin) {
      const { parent, next } = origin;
      origin = undefined;
      const target = parent.isConnected ? parent : doc.documentElement;
      const before = next && next.parentNode === target ? next : null;
      if (host.parentNode !== target || host.nextSibling !== before) {
        target.insertBefore(host, before);
      }
    }
    presentation = "inline";
  };

  const enter = (fullscreen: Element): void => {
    if (!origin && host.parentNode) {
      origin = { parent: host.parentNode, next: host.nextSibling };
    }
    const interactive = canHostChildren(fullscreen);
    if (supportsPopover(portal)) {
      const container = interactive ? fullscreen : doc.documentElement;
      // Moving a shown popover closes it; it is re-shown below.
      if (portal.parentNode !== container) container.append(portal);
      if (host.parentNode !== portal) portal.append(host);
      // Top-layer order is insertion order. Re-showing re-inserts the portal
      // above a fullscreen element that entered the top layer after it, e.g.
      // when fullscreen moves to another element without exiting.
      hidePortal();
      try {
        portal.showPopover();
        presentation = interactive ? "portal" : "inert-portal";
        return;
      } catch {
        // Fall back to plain DOM placement below.
        portal.remove();
      }
    }
    if (!interactive) {
      presentation = "unsupported";
      return;
    }
    if (host.parentNode !== fullscreen) fullscreen.append(host);
    presentation = "element";
  };

  const sync = (): void => {
    if (disposed) return;
    const fullscreen = deepFullscreenElement(doc);
    if (fullscreen) enter(fullscreen);
    else if (presentation !== "inline") restore();
    options.onChange?.({ presentation, fullscreenElement: fullscreen });
  };

  doc.addEventListener("fullscreenchange", sync);
  return {
    get presentation() {
      return presentation;
    },
    sync,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      doc.removeEventListener("fullscreenchange", sync);
      if (presentation !== "inline") restore();
      portal.remove();
    },
  };
}
