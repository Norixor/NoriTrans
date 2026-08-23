import type { NormalizedOcrRegion } from "@/src/ocr/types";
import type {
  SubtitleCustomPosition,
  SubtitleDisplayMode,
  SubtitlePosition,
  SubtitleSettings,
} from "@/src/shared/settings";
import { message } from "@/src/shared/i18n";
import { cleanTranslatedText } from "@/src/translation/output";

export type SubtitleOverlayState =
  | "waiting"
  | "translating"
  | "ready"
  | "partial"
  | "partial-failure"
  | "cancelled"
  | "error"
  | "unavailable";

const MAX_OVERLAY_CUE_CHARACTERS = 1_000;

function normalizedVisibleCueText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function likelySameVisibleCueText(left: string, right: string): boolean {
  if (left === right) return true;
  const longestLength = Math.max(left.length, right.length);
  const shortestLength = Math.min(left.length, right.length);
  if (shortestLength < 4 || longestLength === 0) return false;
  if (
    (left.includes(right) || right.includes(left)) &&
    shortestLength / longestLength >= 0.8
  ) {
    return true;
  }
  if (longestLength > 160 || shortestLength / longestLength < 0.8) {
    return false;
  }
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  const distance = previous[right.length] ?? longestLength;
  return 1 - distance / longestLength >= 0.88;
}

const STYLE = `
  :host {
    all: initial;
    position: fixed !important;
    z-index: 2147483646 !important;
    inset: 0 !important;
    display: block !important;
    width: auto !important;
    height: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
    max-width: none !important;
    max-height: none !important;
    overflow: visible !important;
    contain: none !important;
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
    pointer-events: none !important;
  }
  :host([hidden]) { display: none !important; }
  :host([data-dragging="true"]) { pointer-events: auto !important; }
  .overlay {
    position: fixed;
    z-index: 2147483646;
    left: var(--norixortrans-anchor-x, 50vw);
    top: var(--norixortrans-anchor-y, 82vh);
    transform: translate(-50%, -100%);
    width: max-content;
    max-width: var(--norixortrans-max-width, 80vw);
    display: grid;
    justify-items: center;
    gap: 6px;
    pointer-events: none;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    text-align: center;
  }
  :host([data-position="top"]) .overlay {
    transform: translate(-50%, 0);
  }
  :host([data-position="center"]) .overlay {
    transform: translate(-50%, -50%);
  }
  :host([data-position="custom"]) .overlay {
    transform: translate(-50%, -50%);
  }
  :host([data-ocr-safe-side="above"]) .overlay {
    transform: translate(-50%, -100%);
  }
  :host([data-ocr-safe-side="below"]) .overlay {
    transform: translate(-50%, 0);
  }
  .ocr-region-guide {
    position: fixed;
    left: var(--norixortrans-ocr-left, 0);
    top: var(--norixortrans-ocr-top, 0);
    width: var(--norixortrans-ocr-width, 0);
    height: var(--norixortrans-ocr-height, 0);
    box-sizing: border-box;
    display: none;
    border: 2px dashed rgb(139 92 246 / 88%);
    background: rgb(139 92 246 / 8%);
    box-shadow: 0 0 0 1px rgb(255 255 255 / 55%) inset;
    pointer-events: none;
  }
  :host([data-dragging="true"][data-has-ocr-region="true"]) .ocr-region-guide {
    display: block;
  }
  .cue-card {
    width: max-content;
    max-width: 100%;
    box-sizing: border-box;
    padding: 8px 14px;
    border-radius: 8px;
    background: rgb(8 10 14 / var(--norixortrans-opacity, 0.78));
    color: #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 45%);
    font-size: calc(18px * var(--norixortrans-scale, 1));
    line-height: 1.42;
    max-height: min(45vh, 320px);
    overflow: auto;
    overflow-wrap: anywhere;
    pointer-events: auto;
    cursor: grab;
    touch-action: none;
    user-select: none;
    white-space: pre-wrap;
  }
  .cue-card:active,
  .cue-card[data-dragging="true"] { cursor: grabbing; }
  .cue-card[data-saving="true"] { cursor: wait; }
  .cue-card:focus-visible {
    outline: 3px solid #93c5fd;
    outline-offset: 2px;
  }
  .cue {
    color: inherit;
    font: inherit;
    line-height: inherit;
    white-space: normal;
    overflow-wrap: normal;
    word-break: normal;
    hyphens: none;
  }
  .cue + .cue:not([hidden]) { margin-top: 3px; }
  .original { color: #f4f6f8; }
  .translated { color: #fff; font-weight: 600; }
  .status {
    display: none;
  }
  .status[data-visible="true"] {
    display: block;
    max-width: min(520px, 80vw);
    padding: 4px 8px;
    border-radius: 6px;
    background: rgb(127 29 29 / 92%);
    color: #fff;
    font: 600 13px/1.4 system-ui, sans-serif;
    text-align: center;
  }
  .notice {
    max-width: min(520px, 80vw);
    padding: 8px 12px;
    border: 1px solid rgb(254 202 202 / 72%);
    border-radius: 8px;
    background: rgb(69 10 10 / 94%);
    color: #fff;
    box-shadow: 0 4px 18px rgb(0 0 0 / 38%);
    font: 600 14px/1.45 system-ui, sans-serif;
    overflow-wrap: anywhere;
    pointer-events: auto;
    text-align: center;
  }
  .overlay[hidden], .cue-card[hidden], .original[hidden], .translated[hidden], .notice[hidden] { display: none; }
  @media (max-width: 600px) {
    .cue-card { font-size: calc(16px * var(--norixortrans-scale, 1)); padding: 7px 10px; }
  }
  @media (prefers-reduced-motion: reduce) { .overlay { scroll-behavior: auto; } }
`;

function stateMessage(state: SubtitleOverlayState): string {
  switch (state) {
    case "waiting":
      return message("subtitleWaiting");
    case "translating":
      return message("subtitleTranslating");
    case "ready":
      return message("subtitleReady");
    case "partial":
      return message("subtitlePartial");
    case "partial-failure":
      return message("subtitlePartialFailure");
    case "cancelled":
      return message("subtitleStatusCancelled");
    case "error":
      return message("subtitleError");
    case "unavailable":
      return message("subtitleUnavailable");
  }
}

export function subtitleCueVisibility(
  displayMode: SubtitleDisplayMode,
  hasOriginal: boolean,
  hasTranslated: boolean,
  showOriginalFallback = false,
): { original: boolean; translated: boolean } {
  return {
    original:
      hasOriginal &&
      (displayMode !== "translated" ||
        (showOriginalFallback && !hasTranslated)),
    translated: displayMode !== "original" && hasTranslated,
  };
}

export class SubtitleOverlay {
  private readonly host = document.createElement("div");
  private readonly fullscreenPortal = document.createElement("div");
  private readonly container: HTMLDivElement;
  private readonly original: HTMLDivElement;
  private readonly translated: HTMLDivElement;
  private readonly cueCard: HTMLDivElement;
  private readonly ocrRegionGuide: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private displayMode: SubtitleDisplayMode;
  private showOriginalFallback = false;
  private customPosition: SubtitleCustomPosition;
  private ocrRegion: NormalizedOcrRegion | null = null;
  private mediaTarget: HTMLElement | null = null;
  private positionSaveGeneration = 0;
  private noticeTimer: number | undefined;
  private readonly videoResizeObserver =
    typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(() => this.updateAnchor());
  private mediaGeometryTimer: number | undefined;
  private lastMediaGeometry = "";
  private positionSaving = false;
  private positionBeingSaved: SubtitleCustomPosition | undefined;
  private deferredCue:
    | {
        originalText: string;
        translatedText?: string;
        showOriginalFallback: boolean;
      }
    | null
    | undefined;
  private drag:
    | {
        pointerId: number;
        startPointerX: number;
        startPointerY: number;
        startCenterX: number;
        startCenterY: number;
        startPosition: SubtitlePosition;
        startCustomPosition: SubtitleCustomPosition;
        moved: boolean;
      }
    | undefined;

  constructor(
    settings: SubtitleSettings,
    private readonly onPositionChange?: (
      position: SubtitleCustomPosition,
    ) => Promise<void> | void,
  ) {
    this.host.dataset.norixortransUi = "subtitle-overlay";
    this.fullscreenPortal.dataset.norixortransUi = "subtitle-fullscreen-portal";
    this.fullscreenPortal.setAttribute("popover", "manual");
    Object.assign(this.fullscreenPortal.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      maxWidth: "none",
      maxHeight: "none",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      pointerEvents: "none",
      overflow: "visible",
    });
    const root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.container = document.createElement("div");
    this.container.className = "overlay";
    this.container.hidden = true;
    this.ocrRegionGuide = document.createElement("div");
    this.ocrRegionGuide.className = "ocr-region-guide";
    this.ocrRegionGuide.setAttribute("aria-hidden", "true");

    const dragLabel = message("subtitleDragHandle");

    this.cueCard = document.createElement("div");
    this.cueCard.className = "cue-card";
    this.cueCard.tabIndex = 0;
    this.cueCard.setAttribute("aria-label", dragLabel);
    this.cueCard.title = dragLabel;
    this.original = document.createElement("div");
    this.original.className = "cue original";
    this.translated = document.createElement("div");
    this.translated.className = "cue translated";
    this.status = document.createElement("div");
    this.status.className = "status";
    this.status.hidden = true;
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");

    this.notice = document.createElement("div");
    this.notice.className = "notice";
    this.notice.hidden = true;
    this.notice.setAttribute("role", "alert");
    this.notice.setAttribute("aria-live", "assertive");

    this.cueCard.append(this.original, this.translated);

    this.container.append(this.cueCard, this.status, this.notice);
    root.append(style, this.ocrRegionGuide, this.container);
    this.displayMode = settings.displayMode;
    this.customPosition = settings.customPosition;
    this.updateSettings(settings);
    this.mount();
    this.cueCard.addEventListener("pointerdown", this.startDrag);
    this.cueCard.addEventListener("pointerup", this.finishDrag);
    this.cueCard.addEventListener("pointercancel", this.cancelDrag);
    this.cueCard.addEventListener(
      "lostpointercapture",
      this.cancelLostPointerCapture,
    );
    this.cueCard.addEventListener("keydown", this.moveWithKeyboard);
    document.addEventListener("fullscreenchange", this.mount);
    window.addEventListener("resize", this.updateAnchor);
    window.addEventListener("scroll", this.updateAnchor, true);
    window.addEventListener("blur", this.cancelActiveDrag);
  }

  refreshLocale(): void {
    const dragLabel = message("subtitleDragHandle");
    this.cueCard.setAttribute("aria-label", dragLabel);
    this.cueCard.title = dragLabel;
  }

  private readonly mount = (): void => {
    // Reparenting during fullscreen can implicitly drop pointer capture. End
    // the gesture first so a stale drag cannot keep following the cursor.
    this.cancelActiveDrag();
    const fullscreen = document.fullscreenElement;
    const portal = this.fullscreenPortal as HTMLElement & {
      hidePopover?: () => void;
      showPopover?: () => void;
    };
    if (
      fullscreen instanceof HTMLElement &&
      typeof portal.showPopover === "function"
    ) {
      if (!portal.isConnected) document.documentElement.append(portal);
      if (this.host.parentElement !== portal) portal.append(this.host);
      try {
        portal.showPopover();
      } catch {
        // Repeated fullscreen notifications can arrive while it is already open.
      }
    } else {
      try {
        portal.hidePopover?.();
      } catch {
        // Ignore a portal that was not open.
      }
      const target = fullscreen ?? document.documentElement;
      if (this.host.parentElement !== target) target.append(this.host);
      portal.remove();
    }
    this.updateAnchor();
  };

  setVideo(video: HTMLVideoElement | null): void {
    this.setMediaTarget(video);
  }

  setMediaTarget(target: HTMLElement | null): void {
    if (target === this.mediaTarget) return;
    if (this.mediaTarget instanceof HTMLVideoElement) {
      this.mediaTarget.removeEventListener(
        "enterpictureinpicture",
        this.handlePictureInPictureChange,
      );
      this.mediaTarget.removeEventListener(
        "leavepictureinpicture",
        this.handlePictureInPictureChange,
      );
    }
    this.videoResizeObserver?.disconnect();
    if (this.mediaGeometryTimer !== undefined) {
      window.clearInterval(this.mediaGeometryTimer);
      this.mediaGeometryTimer = undefined;
    }
    this.mediaTarget = target;
    this.lastMediaGeometry = "";
    if (target) {
      this.videoResizeObserver?.observe(target);
      this.mediaGeometryTimer = window.setInterval(this.pollMediaGeometry, 250);
      if (target instanceof HTMLVideoElement) {
        target.addEventListener(
          "enterpictureinpicture",
          this.handlePictureInPictureChange,
        );
        target.addEventListener(
          "leavepictureinpicture",
          this.handlePictureInPictureChange,
        );
      }
    }
    this.updateAnchor();
  }

  private readonly handlePictureInPictureChange = (): void => {
    this.updateAnchor();
    this.renderVisibility();
  };

  setOcrCaptureRegion(viewportRegion: NormalizedOcrRegion | null): void {
    this.ocrRegion = viewportRegion ? { ...viewportRegion } : null;
    this.updateOcrRegionGuide();
    this.updateAnchor();
  }

  private updateOcrRegionGuide(): void {
    if (!this.ocrRegion) {
      delete this.host.dataset.hasOcrRegion;
      return;
    }
    this.host.dataset.hasOcrRegion = "true";
    this.host.style.setProperty(
      "--norixortrans-ocr-left",
      `${this.ocrRegion.x * window.innerWidth}px`,
    );
    this.host.style.setProperty(
      "--norixortrans-ocr-top",
      `${this.ocrRegion.y * window.innerHeight}px`,
    );
    this.host.style.setProperty(
      "--norixortrans-ocr-width",
      `${this.ocrRegion.width * window.innerWidth}px`,
    );
    this.host.style.setProperty(
      "--norixortrans-ocr-height",
      `${this.ocrRegion.height * window.innerHeight}px`,
    );
  }

  /**
   * Rejects only text that can be proven to come from this overlay while it
   * actually overlaps the OCR crop. The geometric check avoids suppressing a
   * legitimate repeated subtitle merely because it equals the last result.
   */
  isOcrFeedbackText(text: string): boolean {
    return this.filterOcrFeedbackText(text) === "" && text.trim() !== "";
  }

  /**
   * Removes OCR lines produced by the visible translated subtitle overlay.
   * The overlay stays rendered during capture to avoid a 2 FPS visibility
   * flicker; a separately recognized native subtitle line remains available.
   */
  filterOcrFeedbackText(text: string): string {
    if (
      !this.ocrRegion ||
      this.cueCard.hidden ||
      this.translated.hidden ||
      !this.translated.textContent
    ) {
      return text;
    }
    const cueRect = this.cueCard.getBoundingClientRect();
    if (cueRect.width <= 0 || cueRect.height <= 0) return text;
    const regionLeft = this.ocrRegion.x * window.innerWidth;
    const regionTop = this.ocrRegion.y * window.innerHeight;
    const regionRight = regionLeft + this.ocrRegion.width * window.innerWidth;
    const regionBottom = regionTop + this.ocrRegion.height * window.innerHeight;
    if (
      cueRect.right <= regionLeft ||
      cueRect.left >= regionRight ||
      cueRect.bottom <= regionTop ||
      cueRect.top >= regionBottom
    ) {
      return text;
    }
    const translated = normalizedVisibleCueText(this.translated.textContent);
    if (!translated) return text;
    const lines = text.split(/\r?\n/gu).filter((line) => {
      const normalizedLine = normalizedVisibleCueText(line);
      return (
        !normalizedLine || !likelySameVisibleCueText(normalizedLine, translated)
      );
    });
    const filtered = lines.join("\n").trim();
    if (filtered !== text.trim()) return filtered;

    // Some engines flatten two visual lines. Dropping such a candidate is
    // safer than feeding the extension's own translation back into OCR.
    const recognized = normalizedVisibleCueText(text);
    if (!recognized) return "";
    if (
      likelySameVisibleCueText(recognized, translated) ||
      (recognized.includes(translated) &&
        translated.length / recognized.length >= 0.35)
    ) {
      return "";
    }
    return text;
  }

  updateSettings(settings: SubtitleSettings): void {
    this.displayMode = settings.displayMode;
    const acknowledgesPositionSave =
      this.positionBeingSaved !== undefined &&
      settings.position === "custom" &&
      settings.customPosition.x === this.positionBeingSaved.x &&
      settings.customPosition.y === this.positionBeingSaved.y;
    if (
      !this.drag &&
      (this.positionBeingSaved === undefined || acknowledgesPositionSave)
    ) {
      this.host.dataset.position = settings.position;
      this.customPosition = settings.customPosition;
    }
    this.host.style.setProperty(
      "--norixortrans-scale",
      String(settings.fontScale),
    );
    this.host.style.setProperty(
      "--norixortrans-opacity",
      String(settings.backgroundOpacity),
    );
    this.updateAnchor();
    this.renderVisibility();
  }

  showCue(
    originalText: string,
    translatedText?: string,
    options: { showOriginalFallback?: boolean } = {},
  ): void {
    if (this.drag) {
      this.deferredCue = {
        originalText,
        ...(translatedText === undefined ? {} : { translatedText }),
        showOriginalFallback: options.showOriginalFallback === true,
      };
      return;
    }
    this.showOriginalFallback = options.showOriginalFallback === true;
    this.original.textContent = originalText.slice(
      0,
      MAX_OVERLAY_CUE_CHARACTERS,
    );
    this.translated.textContent = translatedText
      ? cleanTranslatedText(translatedText).slice(0, MAX_OVERLAY_CUE_CHARACTERS)
      : "";
    this.container.hidden = false;
    this.renderVisibility();
    requestAnimationFrame(() => this.updateAnchor());
  }

  clearCue(): void {
    if (this.drag) {
      this.deferredCue = null;
      return;
    }
    this.showOriginalFallback = false;
    this.original.textContent = "";
    this.translated.textContent = "";
    this.renderVisibility();
  }

  setStatus(state: SubtitleOverlayState, completed = 0, total = 0): void {
    if (this.status.dataset.positionError === "true") return;
    this.status.dataset.state = state;
    const base = stateMessage(state);
    this.status.textContent =
      total > 0 ? `${base} ${completed}/${total}` : base;
  }

  showNotice(text: string, durationMs = 8_000): void {
    const normalized = text.trim().slice(0, 500);
    if (!normalized) return;
    if (this.noticeTimer !== undefined) window.clearTimeout(this.noticeTimer);
    this.notice.textContent = normalized;
    this.notice.hidden = false;
    this.renderVisibility();
    this.mount();
    this.noticeTimer = window.setTimeout(
      () => {
        this.noticeTimer = undefined;
        this.notice.hidden = true;
        this.notice.textContent = "";
        this.renderVisibility();
      },
      Math.max(1_000, durationMs),
    );
  }

  clearNotice(expectedText?: string): void {
    if (
      expectedText !== undefined &&
      this.notice.textContent !== expectedText
    ) {
      return;
    }
    if (this.noticeTimer !== undefined) {
      window.clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    this.notice.hidden = true;
    this.notice.textContent = "";
    this.renderVisibility();
  }

  hasVisibleTranslation(): boolean {
    return (
      !this.container.hidden &&
      !this.cueCard.hidden &&
      !this.translated.hidden &&
      Boolean(this.translated.textContent?.trim())
    );
  }

  hide(): void {
    this.container.hidden = this.notice.hidden;
  }

  destroy(): void {
    this.clearNotice();
    document.removeEventListener("fullscreenchange", this.mount);
    window.removeEventListener("resize", this.updateAnchor);
    window.removeEventListener("scroll", this.updateAnchor, true);
    window.removeEventListener("blur", this.cancelActiveDrag);
    window.removeEventListener("pointermove", this.moveDrag);
    window.removeEventListener("pointerup", this.finishDrag);
    window.removeEventListener("pointercancel", this.cancelDrag);
    window.removeEventListener("mousemove", this.moveMouseDrag);
    window.removeEventListener("mouseup", this.finishMouseDrag);
    if (this.mediaTarget instanceof HTMLVideoElement) {
      this.mediaTarget.removeEventListener(
        "enterpictureinpicture",
        this.handlePictureInPictureChange,
      );
      this.mediaTarget.removeEventListener(
        "leavepictureinpicture",
        this.handlePictureInPictureChange,
      );
    }
    this.videoResizeObserver?.disconnect();
    if (this.mediaGeometryTimer !== undefined) {
      window.clearInterval(this.mediaGeometryTimer);
      this.mediaGeometryTimer = undefined;
    }
    if (this.noticeTimer !== undefined) window.clearTimeout(this.noticeTimer);
    this.cueCard.removeEventListener("pointerdown", this.startDrag);
    this.cueCard.removeEventListener("pointerup", this.finishDrag);
    this.cueCard.removeEventListener("pointercancel", this.cancelDrag);
    this.cueCard.removeEventListener(
      "lostpointercapture",
      this.cancelLostPointerCapture,
    );
    this.cueCard.removeEventListener("keydown", this.moveWithKeyboard);
    try {
      (
        this.fullscreenPortal as HTMLElement & { hidePopover?: () => void }
      ).hidePopover?.();
    } catch {
      // Ignore a portal that was not open.
    }
    this.fullscreenPortal.remove();
    this.host.remove();
  }

  private readonly startDrag = (event: PointerEvent): void => {
    if (event.button !== 0 || this.positionSaving) return;
    event.preventDefault();
    this.cancelActiveDrag();
    const rect = this.container.getBoundingClientRect();
    this.drag = {
      pointerId: event.pointerId,
      startPointerX: event.clientX,
      startPointerY: event.clientY,
      startCenterX: rect.left + rect.width / 2,
      startCenterY: rect.top + rect.height / 2,
      startPosition: (this.host.dataset.position ??
        "bottom") as SubtitlePosition,
      startCustomPosition: { ...this.customPosition },
      moved: false,
    };
    this.cueCard.dataset.dragging = "true";
    this.host.dataset.dragging = "true";
    window.addEventListener("pointermove", this.moveDrag);
    window.addEventListener("pointerup", this.finishDrag);
    window.addEventListener("pointercancel", this.cancelDrag);
    window.addEventListener("mousemove", this.moveMouseDrag);
    window.addEventListener("mouseup", this.finishMouseDrag);
    try {
      this.cueCard.setPointerCapture?.(event.pointerId);
    } catch {
      // The full-viewport drag shield keeps cross-origin players from stealing
      // pointer events when capture is unavailable.
    }
  };

  private readonly moveDrag = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    if ((event.buttons & 1) === 0) {
      this.finishDrag(event);
      return;
    }
    this.moveActiveDrag(event.clientX, event.clientY);
  };

  private readonly moveMouseDrag = (event: MouseEvent): void => {
    if (!this.drag) return;
    if ((event.buttons & 1) === 0) {
      this.finishMouseDrag(event);
      return;
    }
    this.moveActiveDrag(event.clientX, event.clientY);
  };

  private moveActiveDrag(clientX: number, clientY: number): void {
    if (!this.drag) return;
    if (!this.drag.moved) {
      const distance = Math.hypot(
        clientX - this.drag.startPointerX,
        clientY - this.drag.startPointerY,
      );
      if (distance < 3) return;
      this.drag.moved = true;
    }
    this.applyCustomPosition(
      this.clampPosition(
        this.drag.startCenterX + clientX - this.drag.startPointerX,
        this.drag.startCenterY + clientY - this.drag.startPointerY,
      ),
    );
  }

  private readonly finishDrag = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.moveActiveDrag(event.clientX, event.clientY);
    this.completeActiveDrag(event.pointerId);
  };

  private readonly finishMouseDrag = (event: MouseEvent): void => {
    if (!this.drag) return;
    this.moveActiveDrag(event.clientX, event.clientY);
    this.completeActiveDrag(this.drag.pointerId);
  };

  private completeActiveDrag(pointerId: number): void {
    const completedDrag = this.drag;
    if (!completedDrag) return;
    this.drag = undefined;
    this.removeDragListeners();
    delete this.cueCard.dataset.dragging;
    delete this.host.dataset.dragging;
    if (this.cueCard.hasPointerCapture?.(pointerId)) {
      this.cueCard.releasePointerCapture?.(pointerId);
    }
    this.flushDeferredCue();
    if (completedDrag.moved) {
      const bounds = this.videoBounds();
      this.customPosition = this.clampPosition(
        bounds.left + this.customPosition.x * bounds.width,
        bounds.top + this.customPosition.y * bounds.height,
        bounds,
      );
      this.host.dataset.position = "custom";
    }
    this.updateAnchor();
    if (completedDrag.moved) {
      void this.savePosition(completedDrag, { ...this.customPosition });
    }
  }

  private readonly cancelDrag = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.cancelActiveDrag();
  };

  private readonly cancelLostPointerCapture = (event: PointerEvent): void => {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.cancelActiveDrag();
  };

  private readonly cancelActiveDrag = (): void => {
    const activeDrag = this.drag;
    const pointerId = activeDrag?.pointerId;
    this.drag = undefined;
    this.removeDragListeners();
    delete this.cueCard.dataset.dragging;
    delete this.host.dataset.dragging;
    if (
      pointerId !== undefined &&
      this.cueCard.hasPointerCapture?.(pointerId)
    ) {
      this.cueCard.releasePointerCapture(pointerId);
    }
    if (activeDrag) {
      this.customPosition = { ...activeDrag.startCustomPosition };
      this.host.dataset.position = activeDrag.startPosition;
      this.updateAnchor();
      this.flushDeferredCue();
    }
  };

  private flushDeferredCue(): void {
    const deferred = this.deferredCue;
    this.deferredCue = undefined;
    if (deferred === undefined) return;
    if (deferred === null) {
      this.clearCue();
      return;
    }
    this.showCue(deferred.originalText, deferred.translatedText, {
      showOriginalFallback: deferred.showOriginalFallback,
    });
  }

  private removeDragListeners(): void {
    window.removeEventListener("pointermove", this.moveDrag);
    window.removeEventListener("pointerup", this.finishDrag);
    window.removeEventListener("pointercancel", this.cancelDrag);
    window.removeEventListener("mousemove", this.moveMouseDrag);
    window.removeEventListener("mouseup", this.finishMouseDrag);
  }

  private readonly moveWithKeyboard = (event: KeyboardEvent): void => {
    if (this.positionSaving) return;
    const directions: Record<string, readonly [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction) return;
    const [deltaX, deltaY] = direction;
    event.preventDefault();
    const rect = this.container.getBoundingClientRect();
    const step = event.shiftKey ? 0.05 : 0.02;
    const bounds = this.videoBounds();
    const currentX =
      this.host.dataset.position === "custom"
        ? bounds.left + this.customPosition.x * bounds.width
        : rect.left + rect.width / 2;
    const currentY =
      this.host.dataset.position === "custom"
        ? bounds.top + this.customPosition.y * bounds.height
        : rect.top + rect.height / 2;
    const previous = {
      startPosition: (this.host.dataset.position ??
        "bottom") as SubtitlePosition,
      startCustomPosition: { ...this.customPosition },
    };
    this.applyCustomPosition(
      this.clampPosition(
        currentX + deltaX * step * bounds.width,
        currentY + deltaY * step * bounds.height,
        bounds,
      ),
    );
    void this.savePosition(previous, { ...this.customPosition });
  };

  private async savePosition(
    previous: {
      startPosition: SubtitlePosition;
      startCustomPosition: SubtitleCustomPosition;
    },
    position: SubtitleCustomPosition,
  ): Promise<void> {
    if (!this.onPositionChange) return;
    const generation = ++this.positionSaveGeneration;
    this.positionSaving = true;
    this.positionBeingSaved = { ...position };
    this.cueCard.dataset.saving = "true";
    this.cueCard.setAttribute("aria-busy", "true");
    this.status.hidden = true;
    delete this.status.dataset.visible;
    delete this.status.dataset.positionError;
    try {
      await this.onPositionChange(position);
      if (generation === this.positionSaveGeneration) {
        this.status.textContent = "";
      }
    } catch {
      if (generation !== this.positionSaveGeneration) return;
      this.customPosition = { ...previous.startCustomPosition };
      this.host.dataset.position = previous.startPosition;
      this.updateAnchor();
      this.status.textContent = message("subtitlePositionSaveFailed");
      this.status.hidden = false;
      this.status.dataset.visible = "true";
      this.status.dataset.positionError = "true";
    } finally {
      if (generation === this.positionSaveGeneration) {
        this.positionSaving = false;
        this.positionBeingSaved = undefined;
        delete this.cueCard.dataset.saving;
        this.cueCard.removeAttribute("aria-busy");
      }
    }
  }

  private clampPosition(
    centerX: number,
    centerY: number,
    bounds = this.videoBounds(),
  ): SubtitleCustomPosition {
    const rect = this.container.getBoundingClientRect();
    const margin = 10;
    const halfWidth = Math.max(
      0,
      Math.min(rect.width / 2, bounds.width / 2 - margin),
    );
    const topSpace = rect.height / 2;
    const halfHeight = rect.height / 2;
    const horizontalMargin = Math.min(halfWidth + margin, bounds.width / 2);
    const minimumY =
      bounds.top + Math.min(topSpace + margin, bounds.height / 2);
    const maximumY =
      bounds.bottom - Math.min(halfHeight + margin, bounds.height / 2);
    const clampedX = Math.min(
      bounds.right - horizontalMargin,
      Math.max(bounds.left + horizontalMargin, centerX),
    );
    const clampedY =
      maximumY < minimumY
        ? bounds.top + bounds.height / 2
        : Math.min(maximumY, Math.max(minimumY, centerY));
    return {
      x: (clampedX - bounds.left) / bounds.width,
      y: (clampedY - bounds.top) / bounds.height,
    };
  }

  private applyCustomPosition(position: SubtitleCustomPosition): void {
    this.customPosition = position;
    this.host.dataset.position = "custom";
    this.updateAnchor();
  }

  private videoBounds(): DOMRect {
    const rect = this.mediaTarget?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) return rect;
    return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  }

  private readonly pollMediaGeometry = (): void => {
    const target = this.mediaTarget;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const geometry = [rect.left, rect.top, rect.width, rect.height].join(":");
    if (geometry === this.lastMediaGeometry) return;
    this.updateAnchor();
  };

  private readonly updateAnchor = (): void => {
    this.updateOcrRegionGuide();
    const bounds = this.videoBounds();
    this.lastMediaGeometry = [
      bounds.left,
      bounds.top,
      bounds.width,
      bounds.height,
    ].join(":");
    const position = this.host.dataset.position;
    const configuredPosition =
      position === "top"
        ? { x: 0.5, y: 0.08 }
        : position === "center"
          ? { x: 0.5, y: 0.5 }
          : position === "custom"
            ? this.customPosition
            : { x: 0.5, y: 0.92 };
    let anchorX = bounds.left + configuredPosition.x * bounds.width;
    let anchorY = bounds.top + configuredPosition.y * bounds.height;
    if (position === "custom" && !this.drag) {
      const clampedPosition = this.clampPosition(anchorX, anchorY, bounds);
      anchorX = bounds.left + clampedPosition.x * bounds.width;
      anchorY = bounds.top + clampedPosition.y * bounds.height;
    }
    // While dragging, show the capture guide and follow the pointer exactly.
    // Re-apply OCR avoidance as soon as the gesture ends.
    if (this.ocrRegion && !this.drag) {
      const regionLeft = this.ocrRegion.x * window.innerWidth;
      const regionTop = this.ocrRegion.y * window.innerHeight;
      const regionRight = regionLeft + this.ocrRegion.width * window.innerWidth;
      const regionBottom =
        regionTop + this.ocrRegion.height * window.innerHeight;
      const overlayRect = this.container.getBoundingClientRect();
      const overlayWidth = overlayRect.width;
      const overlayHeight = overlayRect.height;
      const anchorInsideCaptureRegion =
        anchorX >= regionLeft &&
        anchorX <= regionRight &&
        anchorY >= regionTop &&
        anchorY <= regionBottom;
      const overlapsCaptureRegion =
        position !== "custom" ||
        (overlayWidth > 0 && overlayHeight > 0
          ? anchorX + overlayWidth / 2 > regionLeft &&
            anchorX - overlayWidth / 2 < regionRight &&
            anchorY + overlayHeight / 2 > regionTop &&
            anchorY - overlayHeight / 2 < regionBottom
          : anchorInsideCaptureRegion);
      if (!overlapsCaptureRegion) {
        delete this.host.dataset.ocrSafeSide;
      } else {
        const spaceAbove = regionTop - bounds.top;
        const spaceBelow = bounds.bottom - regionBottom;
        const safeGap = 8;
        const viewportMargin = 8;
        const requiredSpace =
          (overlayHeight > 0 ? overlayHeight : 64) + safeGap;
        const canPlaceAbove = spaceAbove >= requiredSpace;
        const canPlaceBelow = spaceBelow >= requiredSpace;
        const placeAbove = canPlaceAbove
          ? true
          : canPlaceBelow
            ? false
            : spaceAbove >= spaceBelow;
        const halfWidth = Math.min(overlayWidth / 2, bounds.width / 2);
        anchorX = Math.min(
          bounds.right - halfWidth,
          Math.max(bounds.left + halfWidth, anchorX),
        );
        const viewportHalfWidth = Math.min(
          overlayWidth / 2,
          Math.max(0, window.innerWidth / 2 - viewportMargin),
        );
        anchorX = Math.min(
          window.innerWidth - viewportMargin - viewportHalfWidth,
          Math.max(viewportMargin + viewportHalfWidth, anchorX),
        );
        if (placeAbove) {
          const minimumAnchorY = Math.min(
            window.innerHeight - viewportMargin,
            viewportMargin + overlayHeight,
          );
          anchorY = Math.min(
            window.innerHeight - viewportMargin,
            Math.max(minimumAnchorY, regionTop - safeGap),
          );
        } else {
          const maximumAnchorY = Math.max(
            viewportMargin,
            window.innerHeight - viewportMargin - overlayHeight,
          );
          anchorY = Math.min(
            maximumAnchorY,
            Math.max(viewportMargin, regionBottom + safeGap),
          );
        }
        this.host.dataset.ocrSafeSide = placeAbove ? "above" : "below";
      }
    } else {
      delete this.host.dataset.ocrSafeSide;
    }
    this.host.style.setProperty("--norixortrans-anchor-x", `${anchorX}px`);
    this.host.style.setProperty("--norixortrans-anchor-y", `${anchorY}px`);
    this.host.style.setProperty(
      "--norixortrans-max-width",
      `${Math.max(1, Math.min(window.innerWidth * 0.8, bounds.width * 0.8))}px`,
    );
  };

  private renderVisibility(): void {
    const hasOriginal = this.original.textContent !== "";
    const hasTranslated = this.translated.textContent !== "";
    const visibility = subtitleCueVisibility(
      this.displayMode,
      hasOriginal,
      hasTranslated,
      this.showOriginalFallback,
    );
    this.original.hidden = !visibility.original;
    this.translated.hidden = !visibility.translated;
    this.cueCard.hidden = !visibility.original && !visibility.translated;
    const nativePictureInPictureActive =
      this.mediaTarget instanceof HTMLVideoElement &&
      (
        document as Document & {
          pictureInPictureElement?: Element | null;
        }
      ).pictureInPictureElement === this.mediaTarget;
    this.container.hidden =
      nativePictureInPictureActive ||
      (!visibility.original && !visibility.translated && this.notice.hidden);
  }
}
