import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { styleMap } from "lit/directives/style-map.js";
import { statusGlyph } from "./icons";
import {
  baseStyles,
  isBusyState,
  isVisualState,
  normalizeProgress,
  type NtVisualState,
} from "./shared";

/**
 * `<nt-status-card state="translating" heading="…" count="128 / 412"
 *   description="…" .progress=${0.31} progress-label="…">`
 *
 * Direction B "state card": tinted hero with a shape-coded glyph, a verb-first
 * heading, a reason line, an optional progress bar and one action row.
 * Purely presentational: all text comes from the caller.
 *
 * Slots:
 * - `meta`: chips shown at the start of the reason line (e.g. track type).
 * - `actions`: the single main action plus optional `variant="ghost"`
 *   actions; non-ghost actions stretch to fill the row.
 * - `details`: expandable diagnostics or extra content, full width.
 *
 * Accessibility: heading and reason are a polite live region unless `quiet`
 * is set (use `quiet` for cards whose numbers tick frequently and announce
 * through another channel). The bar is a `progressbar` labelled by
 * `progress-label`.
 */
export class NtStatusCard extends LitElement {
  static override properties = {
    state: { type: String, reflect: true },
    heading: { type: String },
    count: { type: String },
    description: { type: String },
    progress: { type: Number },
    progressLabel: { type: String, attribute: "progress-label" },
    showProgress: { type: Boolean, attribute: "show-progress" },
    quiet: { type: Boolean },
    hasMeta: { state: true },
    hasActions: { state: true },
    hasDetails: { state: true },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .card {
        display: grid;
        grid-template-columns: 36px minmax(0, 1fr);
        gap: 2px var(--nt-space-4);
        align-items: start;
        padding: 14px;
        border-radius: var(--nt-r-card);
        background: var(--nt-surface-2);
        color: var(--nt-fg);
        transition: background-color var(--nt-dur-base) var(--nt-ease-standard);
      }
      .glyph {
        grid-row: span 2;
        width: 36px;
        height: 36px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: var(--nt-surface);
        color: var(--nt-s-neutral);
        box-shadow: var(--nt-shadow-card);
      }
      .glyph svg {
        width: 22px;
        height: 22px;
        display: block;
      }
      .heading {
        margin: 0;
        padding-top: 2px;
        font-size: var(--nt-fs-title);
        font-weight: 700;
        line-height: var(--nt-lh-tight);
        letter-spacing: -0.01em;
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 4px var(--nt-space-3);
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .count {
        font-weight: 500;
        color: var(--nt-fg-2);
        font-size: var(--nt-fs-body);
      }
      .desc {
        grid-column: 2;
        color: var(--nt-fg-2);
        font-size: var(--nt-fs-sm);
        line-height: var(--nt-lh-body);
        overflow-wrap: anywhere;
        min-width: 0;
      }
      .meta {
        display: inline-flex;
        flex-wrap: wrap;
        gap: 4px;
        vertical-align: middle;
        margin-right: 4px;
      }
      .meta[hidden] {
        display: none;
      }
      .bar {
        grid-column: 2;
        height: 6px;
        margin: var(--nt-space-3) 0 2px;
        border-radius: 3px;
        background: color-mix(in srgb, var(--nt-s-progress) 18%, transparent);
        overflow: hidden;
      }
      .bar > i {
        display: block;
        height: 100%;
        width: var(--p, 0%);
        border-radius: 3px;
        background: var(--nt-s-progress);
        transition: width var(--nt-dur-slow) var(--nt-ease-standard);
      }
      .bar.indet > i {
        width: 40%;
        animation: nt-indet 1.4s ease-in-out infinite;
      }
      @keyframes nt-indet {
        from {
          transform: translateX(-100%);
        }
        to {
          transform: translateX(260%);
        }
      }
      .actions {
        grid-column: 1 / -1;
        display: flex;
        flex-wrap: wrap;
        gap: var(--nt-space-3);
        align-items: center;
        margin-top: 10px;
      }
      /* The single main action stretches; ghost (secondary) actions keep
         their intrinsic width. Light-DOM order can't be used here because
         other slots share the same parent. */
      .actions ::slotted(*) {
        flex: 1 1 auto;
        min-width: min(140px, 100%);
      }
      .actions ::slotted([variant="ghost"]) {
        flex: 0 0 auto;
        min-width: 0;
      }
      .details {
        grid-column: 1 / -1;
        min-width: 0;
      }
      [hidden] {
        display: none !important;
      }
      :host([state="scanning"]) .card,
      :host([state="waiting"]) .card,
      :host([state="translating"]) .card {
        background: var(--nt-s-progress-bg);
      }
      :host([state="scanning"]) .glyph,
      :host([state="waiting"]) .glyph,
      :host([state="translating"]) .glyph {
        color: var(--nt-s-progress);
      }
      :host([state="ready"]) .card {
        background: var(--nt-s-ok-bg);
      }
      :host([state="ready"]) .glyph {
        color: var(--nt-s-ok);
      }
      :host([state="partial"]) .card {
        background: var(--nt-s-warn-bg);
      }
      :host([state="partial"]) .glyph {
        color: var(--nt-s-warn);
      }
      :host([state="error"]) .card {
        background: var(--nt-s-err-bg);
      }
      :host([state="error"]) .glyph {
        color: var(--nt-s-err);
      }
      :host([state="disabled"]) .card,
      :host([state="unavailable"]) .card,
      :host([state="cancelled"]) .card {
        background: var(--nt-s-neutral-bg);
      }
      :host([state="scanning"]) .glyph svg,
      :host([state="waiting"]) .glyph svg {
        animation: nt-spin 2.4s linear infinite;
      }
      :host([state="translating"]) .glyph svg {
        animation: nt-spin 1.1s linear infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .bar.indet > i {
          width: 100%;
          opacity: 0.5;
        }
      }
    `,
  ];

  declare state: NtVisualState;
  declare heading: string;
  declare count: string;
  declare description: string;
  /** 0..1, or null for indeterminate. */
  declare progress: number | null;
  declare progressLabel: string;
  /** Forces the bar on in non-translating states (e.g. retrying). */
  declare showProgress: boolean;
  declare quiet: boolean;
  declare protected hasMeta: boolean;
  declare protected hasActions: boolean;
  declare protected hasDetails: boolean;

  constructor() {
    super();
    this.state = "idle";
    this.heading = "";
    this.count = "";
    this.description = "";
    this.progress = null;
    this.progressLabel = "";
    this.showProgress = false;
    this.quiet = false;
    this.hasMeta = false;
    this.hasActions = false;
    this.hasDetails = false;
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("state") && !isVisualState(this.state)) this.state = "idle";
  }

  private readonly onSlotChange = (event: Event): void => {
    const slot = event.target as HTMLSlotElement;
    const filled = slot
      .assignedNodes({ flatten: true })
      .some(
        (node) =>
          node.nodeType === Node.ELEMENT_NODE ||
          (node.nodeType === Node.TEXT_NODE &&
            Boolean(node.textContent?.trim())),
      );
    if (slot.name === "meta") this.hasMeta = filled;
    else if (slot.name === "actions") this.hasActions = filled;
    else if (slot.name === "details") this.hasDetails = filled;
  };

  private renderProgress() {
    const showBar = this.state === "translating" || this.showProgress;
    if (!showBar) return nothing;
    const value = normalizeProgress(this.progress);
    const percent = value === null ? null : Math.round(value * 100);
    return html`<div
      class="bar ${percent === null ? "indet" : ""}"
      role="progressbar"
      aria-label=${this.progressLabel || nothing}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${percent === null ? nothing : percent}
      style=${styleMap(percent === null ? {} : { "--p": `${percent}%` })}
    >
      <i></i>
    </div>`;
  }

  protected override render() {
    const live = this.quiet ? nothing : "polite";
    return html`<div
      class="card"
      part="card"
      data-busy=${isBusyState(this.state)}
    >
      <span class="glyph" aria-hidden="true">${statusGlyph(this.state)}</span>
      <p class="heading" aria-live=${live} aria-atomic="true">
        <span class="title">${this.heading}</span>
        ${this.count ? html`<span class="count">${this.count}</span>` : nothing}
      </p>
      ${this.renderProgress()}
      <div
        class="desc"
        ?hidden=${!this.description && !this.hasMeta}
        aria-live=${live}
      >
        <span class="meta" ?hidden=${!this.hasMeta}
          ><slot name="meta" @slotchange=${this.onSlotChange}></slot></span
        >${this.description}
      </div>
      <div class="actions" ?hidden=${!this.hasActions}>
        <slot name="actions" @slotchange=${this.onSlotChange}></slot>
      </div>
      <div class="details" ?hidden=${!this.hasDetails}>
        <slot name="details" @slotchange=${this.onSlotChange}></slot>
      </div>
    </div>`;
  }
}
