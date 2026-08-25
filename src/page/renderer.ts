import type { DisplayMode } from "@/src/shared/settings";
import type { PageSegment } from "@/src/page/scanner";
import { composedContains } from "@/src/page/composed-tree";
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

interface PendingTranslation {
  segment: PageSegment;
  indicator: HTMLElement;
}

const PENDING_VIEWPORT_GAP_PX = 6;
const PENDING_INDICATOR_SIZE_PX = 10;
const PENDING_INSET_PX = 2;

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

function isComposedVisible(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true"
    ) {
      return false;
    }
    const style = getComputedStyle(current);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const parent: Element | null = current.parentElement;
    if (parent) {
      current = parent;
      continue;
    }
    const root = current.getRootNode();
    current = root instanceof ShadowRoot ? root.host : null;
  }
  return true;
}

function createBilingualHost(
  segmentId: string,
  translatedText: string,
  targetLanguage: string,
  anchor: Element,
): HTMLElement {
  const host = document.createElement("norixor-translation");
  host.dataset.norixorTranslated = segmentId;
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
  return { placement: "after-anchor" };
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

function syncExternalBilingualOrientation(
  host: HTMLElement,
  anchor: Element,
  placement: AppliedBilingual["placement"],
): void {
  host.style.removeProperty("transform");
  host.style.removeProperty("transform-origin");
  if (placement !== "after-anchor" && placement !== "assigned-slot") return;
  const sourceStyle = getComputedStyle(anchor);
  const transform = reflectedTransform(sourceStyle);
  if (!transform) return;
  // Some result pages flip a container and counter-flip each source child.
  // A sibling translation must copy that counter-transform to stay upright.
  host.style.transform = transform;
  host.style.transformOrigin = sourceStyle.transformOrigin;
}

function placeBilingualHost(
  host: HTMLElement,
  segment: PageSegment,
  next: BilingualPlacement,
): boolean {
  delete host.dataset.compactInteractive;
  delete host.dataset.contained;
  delete host.dataset.inline;
  if (next.presentation === "compact-interactive") {
    host.dataset.compactInteractive = "";
  } else if (next.presentation === "contained") {
    host.dataset.contained = "";
  } else if (next.presentation === "inline") {
    host.dataset.inline = "";
  }
  syncExternalBilingualOrientation(host, segment.anchor, next.placement);
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

function createPendingOverlay(): {
  host: HTMLElement;
  layer: HTMLElement;
} {
  const host = document.createElement("norixor-translation-pending");
  host.dataset.norixortransUi = "page-translation-pending";
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
      inline-size: 10px;
      block-size: 10px;
      border: 1.5px solid currentColor;
      border-inline-end-color: transparent;
      border-radius: 50%;
      opacity: 0.56;
    }
    @media (prefers-reduced-motion: no-preference) {
      .indicator { animation: norixor-page-pending 720ms linear infinite; }
      @keyframes norixor-page-pending {
        to { transform: rotate(360deg); }
      }
    }
    @media (forced-colors: active) {
      .indicator {
        border-color: CanvasText;
        border-inline-end-color: transparent;
        opacity: 1;
      }
    }
  `;
  const layer = document.createElement("div");
  layer.className = "layer";
  shadow.append(style, layer);
  return { host, layer };
}

export class PageRenderer {
  private readonly applied: AppliedTranslation[] = [];
  private readonly pending = new Map<PageSegment, PendingTranslation>();
  private pendingOverlay: ReturnType<typeof createPendingOverlay> | undefined;
  private pendingFrame: number | undefined;

  private readonly schedulePendingLayout = (): void => {
    if (this.pendingFrame !== undefined) return;
    this.pendingFrame = window.requestAnimationFrame(() => {
      this.pendingFrame = undefined;
      this.layoutPendingIndicators();
    });
  };

  private ensurePendingOverlay(): ReturnType<typeof createPendingOverlay> {
    if (!this.pendingOverlay) {
      this.pendingOverlay = createPendingOverlay();
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
    }
    return this.pendingOverlay;
  }

  private layoutPendingIndicators(): void {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    for (const pending of this.pending.values()) {
      const { anchor } = pending.segment;
      if (!anchor.isConnected || !isComposedVisible(anchor)) {
        pending.indicator.hidden = true;
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
        pending.indicator.hidden = true;
        continue;
      }
      const sourceStyle = getComputedStyle(anchor);
      pending.indicator.style.color = sourceStyle.color;
      const hasRightSpace =
        rect.right + PENDING_VIEWPORT_GAP_PX + PENDING_INDICATOR_SIZE_PX <=
        viewportWidth;
      const hasLeftSpace =
        rect.left - PENDING_VIEWPORT_GAP_PX - PENDING_INDICATOR_SIZE_PX >= 0;
      let left: number;
      let top: number;
      if (hasRightSpace || hasLeftSpace) {
        left = hasRightSpace
          ? rect.right + PENDING_VIEWPORT_GAP_PX
          : rect.left - PENDING_VIEWPORT_GAP_PX - PENDING_INDICATOR_SIZE_PX;
        top = Math.max(
          0,
          Math.min(
            viewportHeight - PENDING_INDICATOR_SIZE_PX,
            rect.top + (rect.height - PENDING_INDICATOR_SIZE_PX) / 2,
          ),
        );
      } else {
        // Full-width blocks have no safe outer edge. Pin the tiny,
        // pointer-transparent ring to the inner top-right boundary instead of
        // hiding it, keeping it away from the source text body.
        left = Math.max(
          0,
          Math.min(
            viewportWidth - PENDING_INDICATOR_SIZE_PX,
            rect.right - PENDING_INDICATOR_SIZE_PX - PENDING_INSET_PX,
          ),
        );
        top = Math.max(
          0,
          Math.min(
            viewportHeight - PENDING_INDICATOR_SIZE_PX,
            rect.top + PENDING_INSET_PX,
          ),
        );
      }
      pending.indicator.style.left = `${left}px`;
      pending.indicator.style.top = `${top}px`;
      pending.indicator.hidden = false;
    }
  }

  private removePendingOverlayIfEmpty(): void {
    if (this.pending.size > 0 || !this.pendingOverlay) return;
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
    this.pendingOverlay.host.remove();
    this.pendingOverlay = undefined;
  }

  markPending(segments: readonly PageSegment[]): void {
    for (const segment of segments) {
      if (this.pending.has(segment) || !segment.anchor.isConnected) {
        continue;
      }
      const indicator = document.createElement("span");
      indicator.className = "indicator";
      this.ensurePendingOverlay().layer.append(indicator);
      this.pending.set(segment, { segment, indicator });
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

  restoreAnchors(anchors: ReadonlySet<Element>): Text[] {
    const restoredNodes: Text[] = [];
    this.clearPending(
      [...this.pending.keys()].filter((segment) => anchors.has(segment.anchor)),
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
      this.applied.splice(index, 1);
    }
    return restoredNodes;
  }

  sourceAnchorContaining(node: Node): Element | undefined {
    return this.applied
      .map(appliedAnchor)
      .filter((anchor) => composedContains(anchor, node))
      .sort((left, right) =>
        left === right ? 0 : composedContains(left, right) ? 1 : -1,
      )[0];
  }

  reconcile(): PageSegment[] {
    const discarded: PageSegment[] = [];
    this.clearPending(
      [...this.pending.keys()].filter(
        (segment) =>
          !segment.anchor.isConnected ||
          segment.nodes.some(
            (node) =>
              !node.isConnected || !composedContains(segment.anchor, node),
          ),
      ),
    );
    this.schedulePendingLayout();
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
          discarded.push(applied.segment);
          this.applied.splice(index, 1);
        }
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
        discarded.push(applied.segment);
        this.applied.splice(index, 1);
        continue;
      }
      const hidden =
        !isComposedVisible(applied.anchor) ||
        (applied.segment.assignedSlot
          ? !isComposedVisible(applied.segment.assignedSlot.slot)
          : false);
      if (applied.host.hidden !== hidden) applied.host.hidden = hidden;
      if (!hidden) this.reconcileBilingualPlacement(applied);
    }
    return discarded;
  }

  private reconcileBilingualPlacement(applied: AppliedBilingual): void {
    const next = bilingualPlacement(applied.segment);
    if (placeBilingualHost(applied.host, applied.segment, next)) {
      applied.placement = next.placement;
    }
  }

  private pruneBilingual(nodes: readonly Text[]): void {
    for (let index = this.applied.length - 1; index >= 0; index -= 1) {
      const applied = this.applied[index];
      if (applied?.kind !== "bilingual") continue;
      const stale =
        !applied.anchor.isConnected ||
        applied.nodes.some((node) => !node.isConnected) ||
        applied.nodes.some((node) => nodes.includes(node));
      if (!stale) continue;
      applied.host.remove();
      this.applied.splice(index, 1);
    }
  }

  ownsCurrentText(node: Text): boolean {
    return this.applied.some(
      (applied) =>
        applied.kind === "replacement" &&
        applied.segment.nodes.some(
          (candidate, index) =>
            candidate === node &&
            node.textContent === applied.appliedTexts[index],
        ),
    );
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
      this.applied.push({ kind: "replacement", segment, appliedTexts });
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
    if (!placeBilingualHost(host, segment, nextPlacement)) return false;
    this.applied.push({
      kind: "bilingual",
      segment,
      host,
      anchor: segment.anchor,
      nodes: [...segment.nodes],
      placement: nextPlacement.placement,
    });
    return true;
  }

  restore(): void {
    this.clearPending();
    for (const applied of this.applied.reverse()) {
      if (applied.kind === "bilingual") {
        applied.host.remove();
        continue;
      }
      restoreReplacement(applied);
    }
    this.applied.length = 0;
  }
}
