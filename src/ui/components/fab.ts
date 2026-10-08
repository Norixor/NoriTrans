import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { badgeGlyph, icon, statusGlyph, type NtBadgeKind } from "./icons";
import { progressRing, progressRingStyles } from "./progress-ring";
import {
  baseStyles,
  emit,
  isBusyState,
  isVisualState,
  normalizeProgress,
  type NtVisualState,
} from "./shared";

function badgeKind(state: NtVisualState): NtBadgeKind | null {
  switch (state) {
    case "ready":
    case "partial":
    case "error":
    case "cancelled":
      return state;
    default:
      return null;
  }
}

const fabStyles = css`
  :host {
    display: inline-flex;
    flex: 0 0 auto;
    --nt-ring-color: var(--nt-fab-ring);
    --nt-ring-track: var(--nt-fab-ring-track);
  }
  button {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 48px;
    height: 48px;
    padding: 2px;
    border: 0;
    border-radius: var(--nt-r-pill);
    background: transparent;
    color: var(--nt-fg);
    font-weight: 700;
    font-size: var(--nt-fs-body);
    cursor: pointer;
    touch-action: none;
  }
  button:focus-visible {
    outline-offset: 1px;
  }
  .core {
    position: relative;
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--nt-fab-bg);
    color: var(--nt-fab-fg);
    display: grid;
    place-items: center;
    box-shadow: var(--nt-shadow-float);
  }
  .core > svg {
    width: 22px;
    height: 22px;
  }
  .core > .ring {
    position: absolute;
    inset: 2px;
    width: 40px;
    height: 40px;
  }
  .badge {
    position: absolute;
    top: -1px;
    left: 31px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid var(--nt-badge-border);
    display: grid;
    place-items: center;
    color: var(--nt-on-status);
    background: var(--nt-s-neutral);
  }
  .badge > svg {
    width: 12px;
    height: 12px;
    display: block;
  }
  .badge[data-kind="ready"] {
    background: var(--nt-s-ok);
  }
  .badge[data-kind="partial"] {
    background: var(--nt-s-warn);
  }
  .badge[data-kind="error"] {
    background: var(--nt-s-err);
  }
`;

/**
 * `<nt-fab state="translating" .progress=${0.38} label="NoriTrans: translating 38%">`
 *
 * Collapsed floating button: 44px gradient core inside a 48px target, a real
 * progress ring while busy, and a shape-coded badge for ready (check),
 * partial (half disc), error (triangle) and cancelled (square). It never
 * blinks. `label` is the accessible name and should include the state.
 * Dragging and positioning stay with the host (stage 3).
 */
export class NtFab extends LitElement {
  static override shadowRootOptions: ShadowRootInit = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    state: { type: String, reflect: true },
    progress: { type: Number },
    label: { type: String },
    expanded: { type: String },
    controls: { type: String },
  };

  static override styles = [baseStyles, progressRingStyles, fabStyles];

  declare state: NtVisualState;
  /** 0..1 while translating; null for indeterminate. */
  declare progress: number | null;
  declare label: string;
  /** Mirrors aria-expanded for the panel the button toggles ("true"/"false"). */
  declare expanded: string;
  /**
   * Id of the panel the button controls, resolved in the host's own tree
   * (the id lives outside this shadow root, so a plain aria-controls
   * attribute on the inner button cannot reach it). Empty when none.
   */
  declare controls: string;

  constructor() {
    super();
    this.state = "idle";
    this.progress = null;
    this.label = "";
    this.expanded = "";
    this.controls = "";
  }

  protected override updated(): void {
    const button = this.renderRoot.querySelector("button");
    if (!button) return;
    // ARIA element reflection is missing in some engines (and jsdom).
    const reflecting = button as HTMLButtonElement & {
      ariaControlsElements?: Element[] | null;
    };
    const supported = "ariaControlsElements" in reflecting;
    const target = this.controls
      ? (this.getRootNode() as Document | ShadowRoot).getElementById?.(
          this.controls,
        )
      : null;
    if (!target) {
      button.removeAttribute("aria-controls");
      if (supported) reflecting.ariaControlsElements = null;
    } else if (supported) {
      // Cross-root reference: allowed when the target's tree encloses ours.
      reflecting.ariaControlsElements = [target];
    } else {
      button.setAttribute("aria-controls", this.controls);
    }
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("state") && !isVisualState(this.state)) this.state = "idle";
  }

  protected renderCore() {
    const busy = isBusyState(this.state);
    const value =
      this.state === "translating" ? normalizeProgress(this.progress) : null;
    const kind = badgeKind(this.state);
    return html`<span class="core" part="core">
        ${busy ? progressRing(value, 40, 3) : nothing} ${icon("translate")}
      </span>
      ${
        kind
          ? html`<span class="badge" part="badge" data-kind=${kind}
              >${badgeGlyph(kind)}</span
            >`
          : nothing
      }`;
  }

  protected override render() {
    return html`<button
      part="button"
      type="button"
      aria-label=${this.label || nothing}
      aria-busy=${isBusyState(this.state) ? "true" : nothing}
      aria-expanded=${
        this.expanded === "true" || this.expanded === "false"
          ? this.expanded
          : nothing
      }
    >
      ${this.renderCore()}
    </button>`;
  }
}

/** States whose announcement stays expanded until the next change or a click. */
const ATTENTION_STATES: ReadonlySet<NtVisualState> = new Set([
  "partial",
  "error",
]);

/**
 * `<nt-pill-fab state="ready" label="NoriTrans" message="Translated 120 blocks">`
 *
 * The floating button with direction B's one-shot "pill announcement": when
 * `message` or `state` changes after the first render, the button stretches
 * into a pill showing the message for `duration` ms (default 3000), then
 * collapses back to the circle and keeps its badge. `partial`/`error` stay
 * expanded until the next change or activation. `silent` turns the visual
 * stretch off (for users who opt out); the message is still announced to
 * assistive tech through a polite live region. Reduced motion removes the
 * width animation but keeps the text. `direction="start"` grows the pill
 * towards the inline start (use when docked to the right edge).
 *
 * Fires `nt-announce-end` when an announcement collapses.
 */
export class NtPillFab extends NtFab {
  static override properties = {
    ...NtFab.properties,
    message: { type: String },
    silent: { type: Boolean, reflect: true },
    duration: { type: Number },
    direction: { type: String, reflect: true },
    announcing: { type: Boolean, reflect: true },
  };

  static override styles = [
    ...NtFab.styles,
    css`
      button {
        width: auto;
        max-width: 48px;
        gap: 10px;
        overflow: hidden;
        transition:
          max-width var(--nt-dur-slow) var(--nt-ease-standard),
          background-color var(--nt-dur-base) var(--nt-ease-standard),
          box-shadow var(--nt-dur-base) var(--nt-ease-standard);
      }
      :host([direction="start"]) button {
        flex-direction: row-reverse;
      }
      :host([announcing]) button {
        max-width: min(320px, calc(100vw - 32px));
        padding-inline-end: 16px;
        background: var(--nt-surface);
        box-shadow: var(--nt-shadow-float);
      }
      :host([announcing][direction="start"]) button {
        padding-inline-end: 2px;
        padding-inline-start: 16px;
      }
      .msg {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
        white-space: nowrap;
        opacity: 0;
        transition: opacity var(--nt-dur-base) var(--nt-ease-standard);
      }
      :host([announcing]) .msg {
        opacity: 1;
      }
      .msg-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .msg svg {
        width: 20px;
        height: 20px;
        flex: 0 0 auto;
        color: var(--nt-s-neutral);
      }
      :host([state="translating"]) .msg svg,
      :host([state="scanning"]) .msg svg,
      :host([state="waiting"]) .msg svg {
        color: var(--nt-s-progress);
      }
      :host([state="ready"]) .msg svg {
        color: var(--nt-s-ok);
      }
      :host([state="partial"]) .msg svg {
        color: var(--nt-s-warn);
      }
      :host([state="error"]) .msg svg {
        color: var(--nt-s-err);
      }
      :host([announcing]) .badge {
        display: none;
      }
    `,
  ];

  declare message: string;
  declare silent: boolean;
  declare duration: number;
  declare direction: "end" | "start";
  /** True while the pill is stretched (reflected for styling and tests). */
  declare announcing: boolean;

  private collapseTimer: ReturnType<typeof setTimeout> | undefined;
  private liveText = "";

  constructor() {
    super();
    this.message = "";
    this.silent = false;
    this.duration = 3000;
    this.direction = "end";
    this.announcing = false;
    this.addEventListener("click", () => {
      if (this.announcing) this.collapse();
    });
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearTimer();
    this.announcing = false;
  }

  /** Re-announces the current message (e.g. after the host re-mounts). */
  announceNow(): void {
    if (!this.message) return;
    this.liveText = this.message;
    if (this.silent) {
      this.collapse(false);
      this.requestUpdate();
      return;
    }
    this.clearTimer();
    this.announcing = true;
    if (!ATTENTION_STATES.has(this.state)) {
      const duration =
        Number.isFinite(this.duration) && this.duration > 0
          ? this.duration
          : 3000;
      this.collapseTimer = setTimeout(() => this.collapse(), duration);
    }
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    super.willUpdate(changed);
    if (changed.has("silent") && this.silent) this.collapse(false);
    if (!this.hasUpdated) return;
    const messageChanged =
      changed.has("message") && changed.get("message") !== this.message;
    const stateChanged =
      changed.has("state") && changed.get("state") !== this.state;
    if ((messageChanged || stateChanged) && this.message) {
      this.announceNow();
    } else if (stateChanged && !this.message) {
      this.collapse(false);
    }
  }

  private clearTimer(): void {
    if (this.collapseTimer !== undefined) {
      clearTimeout(this.collapseTimer);
      this.collapseTimer = undefined;
    }
  }

  private collapse(notify = true): void {
    this.clearTimer();
    if (!this.announcing) return;
    this.announcing = false;
    if (notify) emit(this, "nt-announce-end", { state: this.state });
  }

  protected override render() {
    return html`<button
        part="button"
        type="button"
        aria-label=${this.label || nothing}
        aria-busy=${isBusyState(this.state) ? "true" : nothing}
        aria-expanded=${
          this.expanded === "true" || this.expanded === "false"
            ? this.expanded
            : nothing
        }
      >
        ${this.renderCore()}
        <span class="msg" aria-hidden="true"
          >${statusGlyph(this.state)}<span class="msg-text"
            >${this.announcing ? this.message : ""}</span
          ></span
        >
      </button>
      <span class="vh" role="status" aria-live="polite"
        >${this.liveText}</span
      >`;
  }
}
