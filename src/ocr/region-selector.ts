import {
  normalizeOcrSelection,
  suggestedSubtitleRegion,
  type ScreenPoint,
  type ScreenRect,
} from "@/src/ocr/geometry";
import type { NormalizedOcrRegion } from "@/src/ocr/types";
import { message } from "@/src/shared/i18n";

const STYLE = `
  :host { all: initial; position: fixed !important; z-index: 2147483647 !important; inset: 0 !important; display: block !important; width: auto !important; height: auto !important; max-width: none !important; max-height: none !important; overflow: visible !important; contain: none !important; writing-mode: horizontal-tb !important; text-orientation: mixed !important; pointer-events: auto !important; }
  .surface { position: fixed; inset: 0; cursor: crosshair; background: rgb(0 0 0 / 42%); touch-action: none; }
  .video-guide { position: fixed; border: 2px solid #93c5fd; background: rgb(59 130 246 / 8%); pointer-events: none; }
  .selection { position: fixed; border: 2px solid #fff; background: rgb(37 99 235 / 26%); box-shadow: 0 0 0 1px rgb(0 0 0 / 70%); pointer-events: none; }
  .dialog { position: fixed; top: max(16px, env(safe-area-inset-top)); left: 50%; width: min(520px, calc(100vw - 24px)); padding: 14px; border: 1px solid #475569; border-radius: 8px; background: #0f172a; color: #fff; box-shadow: 0 12px 36px rgb(0 0 0 / 35%); font: 14px/1.5 system-ui, sans-serif; transform: translateX(-50%); cursor: default; }
  .dialog p { margin: 0; }
  .hint { color: #cbd5e1; }
  .feedback { min-height: 21px; margin-top: 4px !important; color: #fde68a; }
  .actions { display: flex; gap: 8px; margin-top: 10px; }
  button { min-height: 44px; padding: 0 14px; border: 1px solid #64748b; border-radius: 6px; background: #1e293b; color: #fff; cursor: pointer; font: 700 13px system-ui, sans-serif; }
  button.primary { border-color: #60a5fa; background: #2563eb; }
  button:focus-visible { outline: 3px solid #93c5fd; outline-offset: 2px; }
  @media (max-width: 375px) { .actions { display: grid; } button { width: 100%; } }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }
`;

const READY_TIMEOUT_MS = 5_000;

function mediaBounds(target: HTMLElement): ScreenRect | null {
  const rect = target.getBoundingClientRect();
  const bounds = {
    left: Math.max(0, rect.left),
    top: Math.max(0, rect.top),
    right: Math.min(window.innerWidth, rect.right),
    bottom: Math.min(window.innerHeight, rect.bottom),
  };
  return bounds.right - bounds.left >= 40 && bounds.bottom - bounds.top >= 24
    ? bounds
    : null;
}

function deepestActiveElement(): HTMLElement | null {
  let active: Element | null = document.activeElement;
  while (active instanceof HTMLElement && active.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return active instanceof HTMLElement ? active : null;
}

function restoreFocus(element: HTMLElement | null): void {
  if (!element?.isConnected) return;
  if (element.closest("[hidden]")) {
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      root.querySelector<HTMLElement>(".launcher")?.focus();
      return;
    }
  }
  element.focus();
}

export class OcrRegionSelector {
  private host: HTMLElement | undefined;
  private abort: (() => void) | undefined;

  select(
    target: HTMLElement,
    signal: AbortSignal,
  ): Promise<NormalizedOcrRegion> {
    this.destroy();
    const bounds = mediaBounds(target);
    if (!bounds) return Promise.reject(new Error("video_not_visible"));
    const previousFocus = deepestActiveElement();
    const host = document.createElement("noritrans-ocr-region-selector");
    host.dataset.noritransUi = "ocr-region-selector";
    host.dataset.ready = "false";
    Object.assign(host.style, {
      position: "fixed",
      zIndex: "2147483647",
      inset: "0",
      display: "block",
      cursor: "crosshair",
      pointerEvents: "auto",
      touchAction: "none",
    });
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    const surface = document.createElement("div");
    surface.className = "surface";
    const guide = document.createElement("div");
    guide.className = "video-guide";
    guide.style.left = `${bounds.left}px`;
    guide.style.top = `${bounds.top}px`;
    guide.style.width = `${bounds.right - bounds.left}px`;
    guide.style.height = `${bounds.bottom - bounds.top}px`;
    const selection = document.createElement("div");
    selection.className = "selection";
    selection.hidden = true;
    const dialog = document.createElement("section");
    dialog.className = "dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "noritrans-ocr-selector-title");
    const title = document.createElement("p");
    title.id = "noritrans-ocr-selector-title";
    title.textContent = message("ocrSelectTitle");
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = message("ocrSelectHint");
    const feedback = document.createElement("p");
    feedback.className = "feedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    const actions = document.createElement("div");
    actions.className = "actions";
    const suggested = document.createElement("button");
    suggested.type = "button";
    suggested.className = "primary";
    suggested.textContent = message("ocrUseSuggestedRegion");
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = message("ocrCancelSelection");
    actions.append(suggested, cancel);
    dialog.append(title, hint, feedback, actions);
    root.append(style, surface, guide, selection, dialog);
    const fullscreen = document.fullscreenElement;
    let fullscreenPortal: HTMLDivElement | undefined;
    if (
      fullscreen instanceof HTMLElement &&
      typeof HTMLElement.prototype.showPopover === "function"
    ) {
      fullscreenPortal = document.createElement("div");
      fullscreenPortal.dataset.noritransUi = "ocr-fullscreen-portal";
      fullscreenPortal.setAttribute("popover", "manual");
      Object.assign(fullscreenPortal.style, {
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
        overflow: "visible",
      });
      document.documentElement.append(fullscreenPortal);
      fullscreenPortal.append(host);
      fullscreenPortal.showPopover();
    } else {
      const mountTarget = fullscreen ?? document.documentElement;
      mountTarget.append(host);
    }
    this.host = host;

    return new Promise((resolve, reject) => {
      let start: ScreenPoint | undefined;
      let pointerId: number | undefined;
      let mouseActive = false;
      let settled = false;
      let firstReadyFrame: number | undefined;
      let secondReadyFrame: number | undefined;
      let readyTimeout: number | undefined;
      const cleanup = (): void => {
        if (firstReadyFrame !== undefined) {
          window.cancelAnimationFrame(firstReadyFrame);
          firstReadyFrame = undefined;
        }
        if (secondReadyFrame !== undefined) {
          window.cancelAnimationFrame(secondReadyFrame);
          secondReadyFrame = undefined;
        }
        if (readyTimeout !== undefined) {
          window.clearTimeout(readyTimeout);
          readyTimeout = undefined;
        }
        document.removeEventListener("pointerdown", pointerDown, true);
        document.removeEventListener("pointermove", pointerMove, true);
        document.removeEventListener("pointerup", pointerUp, true);
        document.removeEventListener("pointercancel", pointerCancel, true);
        document.removeEventListener("mousedown", mouseDown, true);
        document.removeEventListener("mousemove", mouseMove, true);
        document.removeEventListener("mouseup", mouseUp, true);
        suggested.removeEventListener("click", useSuggested);
        cancel.removeEventListener("click", cancelSelection);
        document.removeEventListener("keydown", keydown, true);
        document.removeEventListener("focusin", keepFocusInside, true);
        document.removeEventListener(
          "fullscreenchange",
          cancelForViewportChange,
        );
        window.removeEventListener("resize", cancelForViewportChange);
        window.removeEventListener("scroll", cancelForViewportChange, true);
        signal.removeEventListener("abort", cancelSelection);
        try {
          if (pointerId !== undefined && host.hasPointerCapture?.(pointerId)) {
            host.releasePointerCapture?.(pointerId);
          }
        } catch {
          // The pointer may already have ended or the host may have moved.
        }
        try {
          fullscreenPortal?.hidePopover();
        } catch {
          // Ignore a portal that was already closed with fullscreen.
        }
        fullscreenPortal?.remove();
        host.remove();
        if (this.host === host) this.host = undefined;
        this.abort = undefined;
        restoreFocus(previousFocus);
      };
      const finish = (region: NormalizedOcrRegion): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(region);
      };
      const rejectSelection = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const cancelSelection = (): void => {
        rejectSelection(
          new DOMException("OCR region selection cancelled.", "AbortError"),
        );
      };
      const cancelForViewportChange = (): void => {
        rejectSelection(new Error("ocr_selection_viewport_changed"));
      };
      const keydown = (event: KeyboardEvent): void => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelSelection();
          return;
        }
        if (event.key !== "Tab") return;
        const active = root.activeElement;
        const next = event.shiftKey
          ? active === suggested
            ? cancel
            : suggested
          : active === cancel
            ? suggested
            : cancel;
        event.preventDefault();
        event.stopPropagation();
        next.focus();
      };
      const keepFocusInside = (event: FocusEvent): void => {
        if (event.composedPath().includes(host)) return;
        suggested.focus();
      };
      const draw = (point: ScreenPoint): void => {
        if (!start) return;
        const left = Math.max(bounds.left, Math.min(start.x, point.x));
        const top = Math.max(bounds.top, Math.min(start.y, point.y));
        const right = Math.min(bounds.right, Math.max(start.x, point.x));
        const bottom = Math.min(bounds.bottom, Math.max(start.y, point.y));
        selection.hidden = false;
        selection.style.left = `${left}px`;
        selection.style.top = `${top}px`;
        selection.style.width = `${Math.max(0, right - left)}px`;
        selection.style.height = `${Math.max(0, bottom - top)}px`;
      };
      const isDialogInteraction = (event: Event): boolean =>
        event.composedPath().includes(dialog);
      const consumeDragEvent = (event: Event): void => {
        if (event.cancelable) event.preventDefault();
        event.stopPropagation();
      };
      const completeSelection = (point: ScreenPoint): void => {
        if (!start) return;
        const region = normalizeOcrSelection(
          start,
          point,
          bounds,
          window.innerWidth,
          window.innerHeight,
        );
        if (!region) {
          feedback.textContent = message("ocrRegionTooSmall");
          start = undefined;
          pointerId = undefined;
          mouseActive = false;
          selection.hidden = true;
          return;
        }
        finish(region);
      };
      const pointerDown = (event: PointerEvent): void => {
        if (
          isDialogInteraction(event) ||
          event.button !== 0 ||
          event.isPrimary === false
        ) {
          return;
        }
        start = { x: event.clientX, y: event.clientY };
        pointerId = event.pointerId;
        mouseActive = false;
        try {
          host.setPointerCapture?.(event.pointerId);
        } catch {
          // Capture can race a compositor hit-test; document capture remains active.
        }
        draw(start);
        consumeDragEvent(event);
      };
      const pointerMove = (event: PointerEvent): void => {
        if (!start || event.pointerId !== pointerId) return;
        draw({ x: event.clientX, y: event.clientY });
        consumeDragEvent(event);
      };
      const pointerUp = (event: PointerEvent): void => {
        if (!start || event.pointerId !== pointerId) return;
        consumeDragEvent(event);
        completeSelection({ x: event.clientX, y: event.clientY });
      };
      const pointerCancel = (event: PointerEvent): void => {
        if (pointerId === undefined || event.pointerId !== pointerId) return;
        consumeDragEvent(event);
        cancelSelection();
      };
      const mouseDown = (event: MouseEvent): void => {
        if (start || isDialogInteraction(event) || event.button !== 0) return;
        start = { x: event.clientX, y: event.clientY };
        pointerId = undefined;
        mouseActive = true;
        draw(start);
        consumeDragEvent(event);
      };
      const mouseMove = (event: MouseEvent): void => {
        if (!start || !mouseActive) return;
        draw({ x: event.clientX, y: event.clientY });
        consumeDragEvent(event);
      };
      const mouseUp = (event: MouseEvent): void => {
        if (!start || !mouseActive || event.button !== 0) return;
        consumeDragEvent(event);
        completeSelection({ x: event.clientX, y: event.clientY });
      };
      const useSuggested = (): void => {
        const region = suggestedSubtitleRegion(
          bounds,
          window.innerWidth,
          window.innerHeight,
        );
        if (region) finish(region);
        else feedback.textContent = message("ocrRegionTooSmall");
      };

      document.addEventListener("pointerdown", pointerDown, true);
      document.addEventListener("pointermove", pointerMove, true);
      document.addEventListener("pointerup", pointerUp, true);
      document.addEventListener("pointercancel", pointerCancel, true);
      document.addEventListener("mousedown", mouseDown, true);
      document.addEventListener("mousemove", mouseMove, true);
      document.addEventListener("mouseup", mouseUp, true);
      suggested.addEventListener("click", useSuggested);
      cancel.addEventListener("click", cancelSelection);
      document.addEventListener("keydown", keydown, true);
      document.addEventListener("focusin", keepFocusInside, true);
      document.addEventListener("fullscreenchange", cancelForViewportChange);
      window.addEventListener("resize", cancelForViewportChange);
      window.addEventListener("scroll", cancelForViewportChange, true);
      signal.addEventListener("abort", cancelSelection, { once: true });
      this.abort = cancelSelection;
      if (signal.aborted) {
        cancelSelection();
        return;
      }
      suggested.focus();
      // The second callback runs only after the mounted host had an
      // opportunity to be presented between two animation frames.
      firstReadyFrame = window.requestAnimationFrame(() => {
        firstReadyFrame = undefined;
        if (settled || !host.isConnected) return;
        secondReadyFrame = window.requestAnimationFrame(() => {
          secondReadyFrame = undefined;
          if (settled || !host.isConnected) return;
          host.dataset.ready = "true";
          if (readyTimeout !== undefined) {
            window.clearTimeout(readyTimeout);
            readyTimeout = undefined;
          }
        });
      });
      readyTimeout = window.setTimeout(() => {
        readyTimeout = undefined;
        if (host.dataset.ready !== "true") cancelSelection();
      }, READY_TIMEOUT_MS);
    });
  }

  destroy(): void {
    this.abort?.();
    this.abort = undefined;
    this.host?.remove();
    this.host = undefined;
  }
}
