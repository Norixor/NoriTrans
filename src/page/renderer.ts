import type { DisplayMode } from "@/src/shared/settings";
import type { PageSegment } from "@/src/page/scanner";
import { composedContains, composedParentNode } from "@/src/page/composed-tree";
import { cleanTranslatedText } from "@/src/translation/output";
import {
  createProtectedText,
  parseProtectedText,
  plainTextFromProtectedText,
} from "@/src/translation/protected-text";

interface AppliedReplacement {
  kind: "replacement";
  segment: PageSegment;
  appliedTexts: string[];
}

interface AppliedBilingual {
  kind: "bilingual";
  segment: PageSegment;
  host: HTMLElement;
  anchor: Element;
  nodes: Text[];
  placement:
    "assigned-slot" | "inside-source" | "inside-anchor" | "after-anchor";
}

interface BilingualPlacement {
  placement: AppliedBilingual["placement"];
  presentation?: "compact-interactive" | "contained" | "inline";
  /**
   * Inline-axis box offsets copied from the source block for a sibling
   * companion, so translated text lines up with the source content box even
   * when the source carries its own padding or margin.
   */
  inlineInset?: {
    paddingStart: string;
    paddingEnd: string;
    marginStart: string;
    marginEnd: string;
  };
}

const COMPACT_INTERACTIVE_SELECTOR = [
  "a",
  "button",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
].join(",");

type AppliedTranslation = AppliedReplacement | AppliedBilingual;

type IndicatorKind = "pending" | "failed";

interface BlockIndicator {
  kind: IndicatorKind;
  segment: PageSegment;
  indicator: HTMLElement;
}

const PENDING_VIEWPORT_GAP_PX = 6;
const PENDING_INDICATOR_SIZE_PX = 10;
const PENDING_INSET_PX = 2;
// The failed marker is a clickable retry control, so it needs a larger hit
// target than the passive pending ring.
const FAILED_INDICATOR_SIZE_PX = 18;
const REFLOW_RELAYOUT_DELAY_MS = 250;

function translatedNodeTexts(
  segment: PageSegment,
  translatedText: string,
): string[] | undefined {
  if (segment.nodes.length <= 1) {
    const cleaned = cleanTranslatedText(translatedText).trim();
    return cleaned ? [cleaned] : undefined;
  }
  return parseProtectedText(
    createProtectedText(segment.originalTexts),
    translatedText,
  );
}

function translatedDisplayText(
  segment: PageSegment,
  translatedText: string,
): string | undefined {
  if (segment.nodes.length <= 1) {
    const cleaned = cleanTranslatedText(translatedText).trim();
    return cleaned || undefined;
  }
  const displayText = plainTextFromProtectedText(
    createProtectedText(segment.originalTexts),
    translatedText,
  );
  if (displayText === undefined) return undefined;
  const cleaned = cleanTranslatedText(displayText).trim();
  return cleaned || undefined;
}

function appliedAnchor(applied: AppliedTranslation): Element {
  return applied.kind === "bilingual" ? applied.anchor : applied.segment.anchor;
}

function restoreReplacement(applied: AppliedReplacement): void {
  applied.segment.nodes.forEach((node, index) => {
    if (node.isConnected && node.textContent === applied.appliedTexts[index]) {
      node.textContent = applied.segment.originalTexts[index] ?? "";
    }
  });
}

function composedParentElement(element: Element): Element | null {
  const parent = element.parentElement;
  if (parent) return parent;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function isSelfVisible(element: Element): boolean {
  if (
    element.hasAttribute("hidden") ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return false;
  }
  const style = getComputedStyle(element);
  return !(
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.visibility === "collapse" ||
    Number(style.opacity) === 0
  );
}

/**
 * Checks the element and every composed ancestor. Callers that test many
 * anchors in one read phase pass a shared memo so each ancestor's computed
 * style is read once; the memo must not outlive a DOM or style write.
 */
function isComposedVisible(
  element: Element,
  memo?: Map<Element, boolean>,
): boolean {
  const chain: Element[] = [];
  let current: Element | null = element;
  let visible = true;
  while (current) {
    const known = memo?.get(current);
    if (known !== undefined) {
      visible = known;
      break;
    }
    chain.push(current);
    if (!isSelfVisible(current)) {
      visible = false;
      break;
    }
    current = composedParentElement(current);
  }
  if (memo) {
    // Every element below a hidden ancestor is hidden; every element on a
    // fully visible chain is visible.
    for (const entry of chain) memo.set(entry, visible);
  }
  return visible;
}

function createBilingualHost(
  segmentId: string,
  translatedText: string,
  targetLanguage: string,
  anchor: Element,
): HTMLElement {
  const host = document.createElement("noritrans-translation");
  host.dataset.noritransTranslated = segmentId;
  host.setAttribute("role", "note");
  const sourceStyle = getComputedStyle(anchor);
  host.style.color = sourceStyle.color;
  host.style.direction = sourceStyle.direction;
  host.style.fontFamily = sourceStyle.fontFamily;
  host.style.fontSize = sourceStyle.fontSize;
  host.style.fontStyle = sourceStyle.fontStyle;
  host.style.fontWeight = sourceStyle.fontWeight;
  host.style.letterSpacing = sourceStyle.letterSpacing;
  host.style.lineHeight = sourceStyle.lineHeight;
  host.style.overflowAnchor = "none";
  host.style.textAlign = sourceStyle.textAlign;
  host.style.writingMode = sourceStyle.writingMode;
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      display: block;
      margin-block: 0.16em 0.42em;
      color: inherit;
      font: inherit;
      line-height: inherit;
      opacity: 0.76;
      overflow-wrap: anywhere;
      text-wrap: pretty;
    }
    :host([data-contained]) { margin-block: 0.14em 0.22em; }
    :host([data-inline]) {
      display: inline;
      margin: 0 0.28em;
    }
    :host([data-compact-interactive]) {
      display: inline;
      margin: 0 0 0 0.32em;
      opacity: 0.62;
      white-space: nowrap;
    }
    :host([data-compact-interactive]) span {
      font-size: 0.78em;
      line-height: inherit;
    }
    :host([data-compact-interactive]) span::before { content: "· "; }
    :host(:hover) { opacity: 0.96; }
    span {
      color: inherit;
      direction: inherit;
      font-family: inherit;
      font-size: inherit;
      font-style: inherit;
      font-weight: inherit;
      line-height: inherit;
      letter-spacing: inherit;
      text-align: inherit;
      writing-mode: inherit;
    }
    @media (prefers-reduced-motion: no-preference) {
      :host { transition: opacity 120ms ease; }
    }
    @media (forced-colors: active) { :host { opacity: 1; } }
  `;
  const text = document.createElement("span");
  text.lang = targetLanguage;
  text.textContent = cleanTranslatedText(translatedText);
  shadow.append(style, text);
  return host;
}

function directChildContaining(node: Node, container: Element): Node | null {
  let current: Node | null = node;
  while (current?.parentNode && current.parentNode !== container) {
    current = current.parentNode;
  }
  return current?.parentNode === container ? current : null;
}

function insertInsideAfterSource(
  host: HTMLElement,
  segment: PageSegment,
): boolean {
  const lastNode = segment.nodes.at(-1);
  const sourceChild = lastNode
    ? directChildContaining(lastNode, segment.anchor)
    : null;
  if (!sourceChild) return false;
  segment.anchor.insertBefore(host, sourceChild.nextSibling);
  return true;
}

function isCurrentSlotAssignment(segment: PageSegment): boolean {
  const assignment = segment.assignedSlot;
  return (
    !assignment ||
    (assignment.slot.isConnected &&
      assignment.source.isConnected &&
      assignment.source.assignedSlot === assignment.slot)
  );
}

function insertIntoAssignedSlot(
  host: HTMLElement,
  segment: PageSegment,
): boolean {
  const assignment = segment.assignedSlot;
  const parent = assignment?.source.parentNode;
  if (!assignment || !parent || !isCurrentSlotAssignment(segment)) return false;
  const slotName = assignment.slot.name || null;
  if (
    host.parentNode === parent &&
    assignment.source.nextSibling === host &&
    host.getAttribute("slot") === slotName
  ) {
    return true;
  }
  if (slotName) host.slot = slotName;
  else host.removeAttribute("slot");
  parent.insertBefore(host, assignment.source.nextSibling);
  return true;
}

function bilingualPlacement(segment: PageSegment): BilingualPlacement {
  const parentDisplay = segment.anchor.parentElement
    ? getComputedStyle(segment.anchor.parentElement).display
    : "";
  const anchorDisplay = getComputedStyle(segment.anchor).display;
  if (segment.anchor.matches(COMPACT_INTERACTIVE_SELECTOR)) {
    return {
      placement: "inside-anchor",
      presentation: "compact-interactive",
    };
  }
  if (segment.assignedSlot) return { placement: "assigned-slot" };
  if (
    segment.anchor === document.body ||
    segment.anchor === document.documentElement
  ) {
    return { placement: "inside-source", presentation: "contained" };
  }
  if (
    ["LI", "TD", "TH"].includes(segment.anchor.tagName) ||
    parentDisplay.includes("flex") ||
    parentDisplay.includes("grid") ||
    parentDisplay === "table-row" ||
    anchorDisplay.includes("flex") ||
    anchorDisplay.includes("grid") ||
    anchorDisplay === "table-row"
  ) {
    return { placement: "inside-anchor", presentation: "contained" };
  }
  if (anchorDisplay.startsWith("inline")) {
    return { placement: "after-anchor", presentation: "inline" };
  }
  const anchorStyle = getComputedStyle(segment.anchor);
  return {
    placement: "after-anchor",
    // Physical sides: the companion copies the source's direction, so the
    // same physical offsets keep both text boxes aligned in LTR and RTL.
    inlineInset: {
      paddingStart: anchorStyle.paddingLeft,
      paddingEnd: anchorStyle.paddingRight,
      marginStart: anchorStyle.marginLeft,
      marginEnd: anchorStyle.marginRight,
    },
  };
}

function syncInlineInset(
  host: HTMLElement,
  inset: BilingualPlacement["inlineInset"],
): void {
  const entries: Array<[string, string]> = [
    ["padding-left", inset?.paddingStart ?? ""],
    ["padding-right", inset?.paddingEnd ?? ""],
    ["margin-left", inset?.marginStart ?? ""],
    ["margin-right", inset?.marginEnd ?? ""],
  ];
  for (const [property, value] of entries) {
    // Only resolved lengths are copied; "auto" (centered blocks) and zero
    // leave the companion's own box untouched.
    const normalized = value === "0px" || !value.endsWith("px") ? "" : value;
    if (host.style.getPropertyValue(property) === normalized) continue;
    if (normalized) host.style.setProperty(property, normalized);
    else host.style.removeProperty(property);
  }
}

function reflectedTransform(style: CSSStyleDeclaration): string | undefined {
  const transform = style.transform.trim();
  const match = /^matrix\(([^)]+)\)$/u.exec(transform);
  if (!match) return undefined;
  const values =
    match[1]?.split(",").map((value) => Number(value.trim())) ?? [];
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    return undefined;
  }
  const [a = 1, b = 0, c = 0, d = 1] = values;
  return a * d - b * c < 0 ? transform : undefined;
}

interface ExternalOrientation {
  transform: string;
  transformOrigin: string;
}

/** Read phase only: never mutates the DOM. */
function externalBilingualOrientation(
  anchor: Element,
  placement: AppliedBilingual["placement"],
): ExternalOrientation | undefined {
  if (placement !== "after-anchor" && placement !== "assigned-slot") return;
  const sourceStyle = getComputedStyle(anchor);
  const transform = reflectedTransform(sourceStyle);
  if (!transform) return undefined;
  // Some result pages flip a container and counter-flip each source child.
  // A sibling translation must copy that counter-transform to stay upright.
  return { transform, transformOrigin: sourceStyle.transformOrigin };
}

function syncExternalBilingualOrientation(
  host: HTMLElement,
  orientation: ExternalOrientation | undefined,
): void {
  const transform = orientation?.transform ?? "";
  const transformOrigin = orientation?.transformOrigin ?? "";
  if (host.style.transform !== transform) {
    if (transform) host.style.transform = transform;
    else host.style.removeProperty("transform");
  }
  if (host.style.transformOrigin !== transformOrigin) {
    if (transformOrigin) host.style.transformOrigin = transformOrigin;
    else host.style.removeProperty("transform-origin");
  }
}

function syncPresentationFlag(
  host: HTMLElement,
  key: "compactInteractive" | "contained" | "inline",
  enabled: boolean,
): void {
  // Avoid touching unchanged attributes: every write invalidates the host
  // style and would force another recalculation on the next read.
  if (enabled && host.dataset[key] === undefined) host.dataset[key] = "";
  else if (!enabled && host.dataset[key] !== undefined)
    delete host.dataset[key];
}

/** Write phase only: callers compute `next` and `orientation` beforehand. */
function placeBilingualHost(
  host: HTMLElement,
  segment: PageSegment,
  next: BilingualPlacement,
  orientation: ExternalOrientation | undefined,
): boolean {
  syncPresentationFlag(
    host,
    "compactInteractive",
    next.presentation === "compact-interactive",
  );
  syncPresentationFlag(host, "contained", next.presentation === "contained");
  syncPresentationFlag(host, "inline", next.presentation === "inline");
  syncExternalBilingualOrientation(host, orientation);
  syncInlineInset(host, next.inlineInset);
  if (next.placement === "assigned-slot") {
    return insertIntoAssignedSlot(host, segment);
  }
  if (next.placement === "inside-anchor") {
    if (host.parentElement !== segment.anchor) segment.anchor.append(host);
    return true;
  }
  if (next.placement === "inside-source") {
    return insertInsideAfterSource(host, segment);
  }
  if (
    host.parentNode !== segment.anchor.parentNode ||
    segment.anchor.nextElementSibling !== host
  ) {
    segment.anchor.insertAdjacentElement("afterend", host);
  }
  return true;
}

function createIndicatorOverlay(): {
  host: HTMLElement;
  layer: HTMLElement;
} {
  const host = document.createElement("noritrans-translation-pending");
  host.dataset.noritransUi = "page-translation-pending";
  // The overlay is decorative for assistive technology: the floating control
  // announces progress and exposes a keyboard-reachable "retry failed items"
  // action, so the per-block markers stay pointer-only.
  host.setAttribute("aria-hidden", "true");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      position: fixed;
      inset: 0 auto auto 0;
      inline-size: 0;
      block-size: 0;
      overflow: visible;
      pointer-events: none;
      z-index: 2147483646;
    }
    .layer {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }
    .indicator {
      position: fixed;
      box-sizing: border-box;
      inline-size: ${PENDING_INDICATOR_SIZE_PX}px;
      block-size: ${PENDING_INDICATOR_SIZE_PX}px;
      border: 1.5px solid currentColor;
      border-inline-end-color: transparent;
      border-radius: 50%;
      opacity: 0.56;
    }
    .indicator[hidden] { display: none; }
    .failed {
      position: fixed;
      display: grid;
      box-sizing: border-box;
      inline-size: ${FAILED_INDICATOR_SIZE_PX}px;
      block-size: ${FAILED_INDICATOR_SIZE_PX}px;
      margin: 0;
      padding: 0;
      border: 1.5px solid currentColor;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      font: 700 11px/1 system-ui, sans-serif;
      opacity: 0.82;
      place-items: center;
      cursor: pointer;
      pointer-events: auto;
    }
    .failed[hidden] { display: none; }
    .failed:hover, .failed:focus-visible { opacity: 1; }
    .failed:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
    @media (prefers-reduced-motion: no-preference) {
      .indicator { animation: noritrans-page-pending 720ms linear infinite; }
      @keyframes noritrans-page-pending {
        to { transform: rotate(360deg); }
      }
    }
    @media (prefers-reduced-motion: reduce) {
      /* A static dotted ring still reads as "waiting" without a spinner. */
      .indicator { border-style: dotted; border-inline-end-color: currentColor; }
    }
    @media (forced-colors: active) {
      .indicator, .failed {
        border-color: CanvasText;
        color: CanvasText;
        opacity: 1;
      }
      .indicator { border-inline-end-color: transparent; }
      .failed { background: Canvas; }
    }
  `;
  const layer = document.createElement("div");
  layer.className = "layer";
  shadow.append(style, layer);
  return { host, layer };
}

export class PageRenderer {
  private applied: AppliedTranslation[] = [];
  // Node indexes keep per-mutation ownership checks independent of the number
  // of translated blocks on the page.
  private readonly replacementTextByNode = new Map<Text, string>();
  private readonly bilingualByNode = new Map<Text, AppliedBilingual>();
  private readonly pending = new Map<PageSegment, BlockIndicator>();
  private readonly failed = new Map<PageSegment, BlockIndicator>();
  private pendingOverlay: ReturnType<typeof createIndicatorOverlay> | undefined;
  private pendingFrame: number | undefined;
  private documentResizeObserver: ResizeObserver | undefined;
  private reflowLayoutTimer: number | undefined;

  /**
   * Document reflows happen on nearly every applied translation. Re-measuring
   * thousands of pending rings per frame would dominate the main thread, so a
   * reflow only re-measures when clickable failed markers exist, and at most
   * a few times per second; pending rings still follow scroll and resize.
   */
  private readonly scheduleReflowLayout = (): void => {
    if (this.failed.size === 0 || this.reflowLayoutTimer !== undefined) return;
    this.reflowLayoutTimer = window.setTimeout(() => {
      this.reflowLayoutTimer = undefined;
      this.schedulePendingLayout();
    }, REFLOW_RELAYOUT_DELAY_MS);
  };
  /** Invoked when the user clicks a failed block's in-page retry marker. */
  onRetryFailed: ((segment: PageSegment) => void) | undefined;
  /** Accessible name for the failed marker; set by the owner (localized). */
  failedMarkerLabel = "";

  private readonly schedulePendingLayout = (): void => {
    if (this.pendingFrame !== undefined) return;
    this.pendingFrame = window.requestAnimationFrame(() => {
      this.pendingFrame = undefined;
      this.layoutPendingIndicators();
    });
  };

  private ensurePendingOverlay(): ReturnType<typeof createIndicatorOverlay> {
    if (!this.pendingOverlay) {
      this.pendingOverlay = createIndicatorOverlay();
      (document.body ?? document.documentElement).append(
        this.pendingOverlay.host,
      );
      window.addEventListener("scroll", this.schedulePendingLayout, true);
      window.addEventListener("resize", this.schedulePendingLayout, {
        passive: true,
      });
      window.visualViewport?.addEventListener(
        "resize",
        this.schedulePendingLayout,
        { passive: true },
      );
      // Applied translations reflow the page without a scroll or viewport
      // resize; a document-size change is the cheapest signal that failed
      // markers beside later blocks must be re-measured (see
      // scheduleReflowLayout for why pending rings are excluded).
      if (typeof ResizeObserver === "function") {
        this.documentResizeObserver = new ResizeObserver(
          this.scheduleReflowLayout,
        );
        this.documentResizeObserver.observe(document.documentElement);
      }
    }
    return this.pendingOverlay;
  }

  /**
   * True when a marker placed beside `anchor` would sit on top of unrelated
   * content (an adjacent table cell, a sibling column). Elements that contain
   * the anchor, the anchor's own descendants and the overlay itself are fine.
   */
  private indicatorCollides(
    anchor: Element,
    centerX: number,
    centerY: number,
  ): boolean {
    // jsdom and some embedders lack hit testing; without it, fall back to the
    // side placement rather than hiding the marker.
    if (typeof document.elementFromPoint !== "function") return false;
    const hit = document.elementFromPoint(centerX, centerY);
    if (!hit || hit === document.documentElement || hit === document.body)
      return false;
    if (hit === this.pendingOverlay?.host) return false;
    if (hit === anchor || composedContains(hit, anchor)) return false;
    if (composedContains(anchor, hit)) return false;
    return true;
  }

  private layoutPendingIndicators(): void {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const visibility = new Map<Element, boolean>();
    // Read every anchor's geometry before touching any indicator. Interleaving
    // indicator style writes with layout reads forces one layout per segment.
    // Pending rings and failed markers share one pass so a page with both
    // still pays for a single layout.
    const layouts: Array<{
      indicator: HTMLElement;
      position?: { left: number; top: number; color: string };
    }> = [];
    for (const entry of [...this.pending.values(), ...this.failed.values()]) {
      const { anchor } = entry.segment;
      const size =
        entry.kind === "failed"
          ? FAILED_INDICATOR_SIZE_PX
          : PENDING_INDICATOR_SIZE_PX;
      if (!anchor.isConnected || !isComposedVisible(anchor, visibility)) {
        layouts.push({ indicator: entry.indicator });
        continue;
      }
      const rect = anchor.getBoundingClientRect();
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.bottom < 0 ||
        rect.top > viewportHeight ||
        rect.right < 0 ||
        rect.left > viewportWidth
      ) {
        layouts.push({ indicator: entry.indicator });
        continue;
      }
      const color = getComputedStyle(anchor).color;
      const hasRightSpace =
        rect.right + PENDING_VIEWPORT_GAP_PX + size <= viewportWidth;
      const hasLeftSpace = rect.left - PENDING_VIEWPORT_GAP_PX - size >= 0;
      let left: number | undefined;
      let top: number | undefined;
      if (hasRightSpace || hasLeftSpace) {
        const sideLeft = hasRightSpace
          ? rect.right + PENDING_VIEWPORT_GAP_PX
          : rect.left - PENDING_VIEWPORT_GAP_PX - size;
        const sideTop = Math.max(
          0,
          Math.min(viewportHeight - size, rect.top + (rect.height - size) / 2),
        );
        // One hit test per on-screen marker: the geometry above is already
        // resolved, so elementFromPoint does not force another layout.
        if (
          !this.indicatorCollides(
            anchor,
            sideLeft + size / 2,
            sideTop + size / 2,
          )
        ) {
          left = sideLeft;
          top = sideTop;
        }
      }
      if (left === undefined || top === undefined) {
        // Full-width blocks and blocks with occupied side space have no safe
        // outer edge. Pin the marker to the inner top-right boundary instead
        // of hiding it, keeping it away from the source text body.
        left = Math.max(
          0,
          Math.min(viewportWidth - size, rect.right - size - PENDING_INSET_PX),
        );
        top = Math.max(
          0,
          Math.min(viewportHeight - size, rect.top + PENDING_INSET_PX),
        );
      }
      layouts.push({
        indicator: entry.indicator,
        position: { left, top, color },
      });
    }
    for (const { indicator, position } of layouts) {
      if (!position) {
        indicator.hidden = true;
        continue;
      }
      indicator.style.color = position.color;
      indicator.style.left = `${position.left}px`;
      indicator.style.top = `${position.top}px`;
      indicator.hidden = false;
    }
  }

  private removePendingOverlayIfEmpty(): void {
    if (this.pending.size > 0 || this.failed.size > 0 || !this.pendingOverlay)
      return;
    if (this.pendingFrame !== undefined) {
      window.cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = undefined;
    }
    window.removeEventListener("scroll", this.schedulePendingLayout, true);
    window.removeEventListener("resize", this.schedulePendingLayout);
    window.visualViewport?.removeEventListener(
      "resize",
      this.schedulePendingLayout,
    );
    this.documentResizeObserver?.disconnect();
    this.documentResizeObserver = undefined;
    if (this.reflowLayoutTimer !== undefined) {
      window.clearTimeout(this.reflowLayoutTimer);
      this.reflowLayoutTimer = undefined;
    }
    this.pendingOverlay.host.remove();
    this.pendingOverlay = undefined;
  }

  markPending(segments: readonly PageSegment[]): void {
    for (const segment of segments) {
      if (this.pending.has(segment) || !segment.anchor.isConnected) {
        continue;
      }
      this.clearFailed([segment]);
      const indicator = document.createElement("span");
      indicator.className = "indicator";
      this.ensurePendingOverlay().layer.append(indicator);
      this.pending.set(segment, { kind: "pending", segment, indicator });
    }
    this.schedulePendingLayout();
  }

  clearPending(segments?: readonly PageSegment[]): void {
    const targets = segments ?? [...this.pending.keys()];
    for (const segment of targets) {
      const pending = this.pending.get(segment);
      if (!pending) continue;
      pending.indicator.remove();
      this.pending.delete(segment);
    }
    this.removePendingOverlayIfEmpty();
  }

  /**
   * Shows a clickable retry marker beside each failed block. Markers are laid
   * out together with pending rings and removed again by `markPending`,
   * `clearFailed`, anchor invalidation and `restore`.
   */
  markFailed(segments: readonly PageSegment[]): void {
    for (const segment of segments) {
      if (this.failed.has(segment) || !segment.anchor.isConnected) continue;
      this.clearPending([segment]);
      const indicator = document.createElement("button");
      indicator.type = "button";
      indicator.className = "failed";
      indicator.tabIndex = -1;
      indicator.textContent = "!";
      indicator.title = this.failedMarkerLabel;
      indicator.setAttribute("aria-label", this.failedMarkerLabel);
      indicator.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onRetryFailed?.(segment);
      });
      this.ensurePendingOverlay().layer.append(indicator);
      this.failed.set(segment, { kind: "failed", segment, indicator });
    }
    this.schedulePendingLayout();
  }

  clearFailed(segments?: readonly PageSegment[]): void {
    const targets = segments ?? [...this.failed.keys()];
    for (const segment of targets) {
      const failed = this.failed.get(segment);
      if (!failed) continue;
      failed.indicator.remove();
      this.failed.delete(segment);
    }
    this.removePendingOverlayIfEmpty();
  }

  /** Segments currently carrying an in-page failed marker. */
  failedSegments(): PageSegment[] {
    return [...this.failed.keys()];
  }

  restoreAnchors(anchors: ReadonlySet<Element>): Text[] {
    const restoredNodes: Text[] = [];
    this.clearPending(
      [...this.pending.keys()].filter((segment) => anchors.has(segment.anchor)),
    );
    this.clearFailed(
      [...this.failed.keys()].filter((segment) => anchors.has(segment.anchor)),
    );
    for (let index = this.applied.length - 1; index >= 0; index -= 1) {
      const applied = this.applied[index];
      if (!applied || !anchors.has(appliedAnchor(applied))) continue;
      restoredNodes.push(
        ...(applied.kind === "bilingual"
          ? applied.nodes
          : applied.segment.nodes),
      );
      if (applied.kind === "bilingual") {
        applied.host.remove();
      } else {
        restoreReplacement(applied);
      }
      this.forget(applied);
      this.applied.splice(index, 1);
    }
    return restoredNodes;
  }

  /** Returns the innermost translated source anchor containing `node`. */
  sourceAnchorContaining(node: Node): Element | undefined {
    if (this.applied.length === 0) return undefined;
    const anchors = new Set(this.applied.map(appliedAnchor));
    let current: Node | null = node;
    for (let depth = 0; current && depth < 4_096; depth += 1) {
      if (current instanceof Element && anchors.has(current)) return current;
      current = composedParentNode(current);
    }
    return undefined;
  }

  private remember(applied: AppliedTranslation): void {
    if (applied.kind === "replacement") {
      applied.segment.nodes.forEach((node, index) => {
        this.replacementTextByNode.set(node, applied.appliedTexts[index] ?? "");
      });
      return;
    }
    for (const node of applied.nodes) this.bilingualByNode.set(node, applied);
  }

  private forget(applied: AppliedTranslation): void {
    if (applied.kind === "replacement") {
      applied.segment.nodes.forEach((node, index) => {
        if (
          this.replacementTextByNode.get(node) ===
          (applied.appliedTexts[index] ?? "")
        ) {
          this.replacementTextByNode.delete(node);
        }
      });
      return;
    }
    for (const node of applied.nodes) {
      if (this.bilingualByNode.get(node) === applied) {
        this.bilingualByNode.delete(node);
      }
    }
  }

  /** Structural check plus a full visibility and placement pass. */
  reconcile(): PageSegment[] {
    const discarded = this.discardDetached();
    this.syncLayout();
    return discarded;
  }

  /**
   * Drops translations whose source nodes left their block. Reads no styles,
   * so it is cheap enough to run on every structural page mutation.
   */
  discardDetached(): PageSegment[] {
    const discarded: PageSegment[] = [];
    const detachedIndicator = (segment: PageSegment): boolean =>
      !segment.anchor.isConnected ||
      segment.nodes.some(
        (node) => !node.isConnected || !composedContains(segment.anchor, node),
      );
    this.clearPending([...this.pending.keys()].filter(detachedIndicator));
    this.clearFailed([...this.failed.keys()].filter(detachedIndicator));
    this.schedulePendingLayout();
    const kept: AppliedTranslation[] = [];
    for (let index = this.applied.length - 1; index >= 0; index -= 1) {
      const applied = this.applied[index];
      if (!applied) continue;
      if (applied.kind === "replacement") {
        if (
          !applied.segment.anchor.isConnected ||
          applied.segment.nodes.some(
            (node) =>
              !node.isConnected ||
              !composedContains(applied.segment.anchor, node),
          )
        ) {
          restoreReplacement(applied);
          this.forget(applied);
          discarded.push(applied.segment);
          continue;
        }
        kept.push(applied);
        continue;
      }
      if (
        !applied.anchor.isConnected ||
        applied.nodes.some(
          (node) =>
            !node.isConnected || !composedContains(applied.anchor, node),
        ) ||
        !isCurrentSlotAssignment(applied.segment)
      ) {
        applied.host.remove();
        this.forget(applied);
        discarded.push(applied.segment);
        continue;
      }
      kept.push(applied);
    }
    this.applied = kept.reverse();
    return discarded;
  }

  /**
   * Synchronizes bilingual companions with their source's visibility and
   * layout. With `roots`, only companions whose source lies inside one of the
   * changed subtrees are measured; style changes elsewhere cannot affect them.
   */
  syncLayout(roots?: ReadonlySet<Node>): void {
    const attached: AppliedBilingual[] = [];
    for (const applied of this.applied) {
      if (applied.kind !== "bilingual") continue;
      if (
        roots &&
        ![...roots].some(
          (root) =>
            composedContains(root, applied.anchor) ||
            (applied.segment.assignedSlot !== undefined &&
              composedContains(root, applied.segment.assignedSlot.slot)),
        )
      ) {
        continue;
      }
      attached.push(applied);
    }
    if (attached.length === 0) return;

    // Read phase: resolve visibility and placement for every host before any
    // write, so the whole pass costs one style recalculation instead of one
    // per translated block.
    const visibility = new Map<Element, boolean>();
    const updates = attached.map((applied) => {
      const hidden =
        !isComposedVisible(applied.anchor, visibility) ||
        (applied.segment.assignedSlot
          ? !isComposedVisible(applied.segment.assignedSlot.slot, visibility)
          : false);
      if (hidden) return { applied, hidden } as const;
      const next = bilingualPlacement(applied.segment);
      const orientation = externalBilingualOrientation(
        applied.anchor,
        next.placement,
      );
      return { applied, hidden, next, orientation } as const;
    });
    // Write phase.
    for (const update of updates) {
      const { applied, hidden } = update;
      if (applied.host.hidden !== hidden) applied.host.hidden = hidden;
      if (
        !update.hidden &&
        placeBilingualHost(
          applied.host,
          applied.segment,
          update.next,
          update.orientation,
        )
      ) {
        applied.placement = update.next.placement;
      }
    }
  }

  /**
   * Removes bilingual companions that already own any of `nodes`. Detached
   * companions elsewhere are left to `reconcile()`, which keeps each apply
   * proportional to the segment size instead of the page size.
   */
  private pruneBilingual(nodes: readonly Text[]): void {
    const stale = new Set<AppliedBilingual>();
    for (const node of nodes) {
      const owner = this.bilingualByNode.get(node);
      if (owner) stale.add(owner);
    }
    if (stale.size === 0) return;
    for (const applied of stale) {
      applied.host.remove();
      this.forget(applied);
    }
    this.applied = this.applied.filter(
      (applied) => applied.kind !== "bilingual" || !stale.has(applied),
    );
  }

  ownsCurrentText(node: Text): boolean {
    const applied = this.replacementTextByNode.get(node);
    return applied !== undefined && node.textContent === applied;
  }

  apply(
    segment: PageSegment,
    translatedText: string,
    mode: DisplayMode,
    targetLanguage: string,
  ): boolean {
    if (
      !segment.anchor.isConnected ||
      !isComposedVisible(segment.anchor) ||
      (segment.assignedSlot &&
        (!isCurrentSlotAssignment(segment) ||
          !isComposedVisible(segment.assignedSlot.slot))) ||
      !segment.nodes.every(
        (node, index) =>
          node.isConnected &&
          composedContains(segment.anchor, node) &&
          node.textContent === segment.originalTexts[index],
      )
    ) {
      return false;
    }

    if (mode === "translated") {
      const appliedTexts = translatedNodeTexts(segment, translatedText);
      if (!appliedTexts || appliedTexts.length !== segment.nodes.length) {
        return false;
      }
      segment.nodes.forEach((node, index) => {
        node.textContent = appliedTexts[index] ?? "";
      });
      const applied: AppliedReplacement = {
        kind: "replacement",
        segment,
        appliedTexts,
      };
      this.applied.push(applied);
      this.remember(applied);
      return true;
    }

    this.pruneBilingual(segment.nodes);

    const displayText = translatedDisplayText(segment, translatedText);
    if (displayText === undefined) return false;

    const host = createBilingualHost(
      segment.id,
      displayText,
      targetLanguage,
      segment.anchor,
    );
    const nextPlacement = bilingualPlacement(segment);
    const orientation = externalBilingualOrientation(
      segment.anchor,
      nextPlacement.placement,
    );
    if (!placeBilingualHost(host, segment, nextPlacement, orientation)) {
      return false;
    }
    const applied: AppliedBilingual = {
      kind: "bilingual",
      segment,
      host,
      anchor: segment.anchor,
      nodes: [...segment.nodes],
      placement: nextPlacement.placement,
    };
    this.applied.push(applied);
    this.remember(applied);
    return true;
  }

  restore(): void {
    this.clearPending();
    this.clearFailed();
    for (const applied of this.applied.reverse()) {
      if (applied.kind === "bilingual") {
        applied.host.remove();
        continue;
      }
      restoreReplacement(applied);
    }
    this.applied = [];
    this.replacementTextByNode.clear();
    this.bilingualByNode.clear();
  }
}
