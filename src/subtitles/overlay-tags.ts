import {
  createStatusGlyph,
  type DomStatusGlyph,
} from "@/src/ui/dom/status-glyph";

/** How long the live-subtitle tag stays on the video before it collapses. */
export const LIVE_TAG_DURATION_MS = 4_000;
/**
 * Translated-only mode stays blank this long before it says the translation
 * is on its way; a quick translation therefore never flashes a status tag.
 */
export const PENDING_TAG_DELAY_MS = 1_500;

/** Timer seam so tests (and embedders) can drive the tags with a fake clock. */
export interface OverlayTimers {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
}

export const windowTimers: OverlayTimers = {
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: (handle) => window.clearTimeout(handle),
};

export type OverlayTagKind = "live" | "pending";

const TAG_GLYPH: Record<OverlayTagKind, DomStatusGlyph> = {
  live: "partial",
  pending: "translating",
};

/**
 * A small pill on the subtitle layer (glyph + text). It owns a single timer:
 * either the delay before it appears or the time until it collapses.
 * `onChange` lets the overlay recompute its own visibility.
 */
export class OverlayTag {
  readonly element: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private timer: number | undefined;

  constructor(
    readonly kind: OverlayTagKind,
    private readonly text: () => string,
    private readonly timers: OverlayTimers,
    private readonly onChange: () => void,
  ) {
    this.element = document.createElement("div");
    this.element.className = "tag";
    this.element.dataset.kind = kind;
    this.element.hidden = true;
    this.element.setAttribute("role", "status");
    this.label = document.createElement("span");
    this.element.append(createStatusGlyph(TAG_GLYPH[kind]), this.label);
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** True while a delayed show is scheduled or the tag is on screen. */
  get engaged(): boolean {
    return this.timer !== undefined || this.visible;
  }

  /** Shows the tag now and collapses it after `durationMs`. */
  showFor(durationMs: number): void {
    this.clearTimer();
    this.reveal();
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.conceal();
    }, durationMs);
  }

  /** Shows the tag after `delayMs` unless it is already scheduled or shown. */
  showAfter(delayMs: number): void {
    if (this.engaged) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.reveal();
    }, delayMs);
  }

  hide(): void {
    this.clearTimer();
    this.conceal();
  }

  refreshLocale(): void {
    if (this.visible) this.label.textContent = this.text();
  }

  private reveal(): void {
    this.label.textContent = this.text();
    if (!this.element.hidden) return;
    this.element.hidden = false;
    this.onChange();
  }

  private conceal(): void {
    if (this.element.hidden) return;
    this.element.hidden = true;
    this.label.textContent = "";
    this.onChange();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
