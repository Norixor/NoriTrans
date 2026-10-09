import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import {
  fabRing,
  fabRingKind,
  fabRingStyles,
  isFabEdge,
  type NtFabEdge,
} from "./fab-ring";
import { icon, statusGlyph } from "./icons";
import {
  baseStyles,
  emit,
  isBusyState,
  isVisualState,
  normalizeProgress,
  type NtVisualState,
} from "./shared";

const fabStyles = css`
  :host {
    display: inline-flex;
    flex: 0 0 auto;
  }
  :host([data-ring="solid"]) {
    --nt-fab-arc: var(--nt-s-ok);
  }
  :host([data-ring="dashed"]) {
    --nt-fab-arc: var(--nt-s-warn);
  }
  :host([data-ring="dotted"]) {
    --nt-fab-arc: var(--nt-s-err);
  }
  :host([data-ring="dashdot"]) {
    --nt-fab-arc: var(--nt-s-neutral);
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
  /* 44px slot centred in the 48px box (2px padding in both the plain and the
     pill button). The surface plate behind the arc keeps every arc style
     legible on any page; the 36px disc carries the brand gradient. */
  .core {
    position: relative;
    flex: 0 0 auto;
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    color: var(--nt-fab-fg);
  }
  .core::before {
    content: "";
    position: absolute;
    inset: -1.25px;
    border-radius: 50%;
    background: var(--nt-surface);
    box-shadow: var(--nt-shadow-float);
  }
  .disc {
    position: relative;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: var(--nt-fab-bg);
    display: grid;
    place-items: center;
  }
  .disc > svg {
    width: 20px;
    height: 20px;
  }
`;

/**
 * `<nt-fab state="translating" .progress=${0.38} label="NoriTrans: translating 38%">`
 *
 * Collapsed floating button: a 36px gradient disc on a surface plate inside a
 * 48px target, ringed by a status arc whose stroke style carries the state
 * (see `fab-ring.ts`): a real progress arc while busy, solid when ready,
 * dashed when partial, dotted when failed, dash-dot when cancelled, none
 * otherwise. The style is reflected as `data-ring` on the host. With `edge`
 * set (the host tucked the button into that viewport edge) only the visible
 * half of the arc is drawn and progress fills that half. It never blinks.
 * `label` is the accessible name and should include the state. Dragging and
 * positioning stay with the host.
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
    edge: { type: String, reflect: true },
  };

  static override styles = [baseStyles, fabRingStyles, fabStyles];

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
  /**
   * Viewport edge the button is tucked into, so only the half facing the
   * page shows; undefined while fully visible.
   */
  declare edge: NtFabEdge | undefined;

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
    if (changed.has("edge") && this.edge !== undefined && !isFabEdge(this.edge))
      this.edge = undefined;
    this.setAttribute("data-ring", fabRingKind(this.state));
  }

  protected renderCore() {
    const value =
      this.state === "translating" ? normalizeProgress(this.progress) : null;
    return html`<span class="core" part="core"
      >${fabRing(fabRingKind(this.state), this.edge, value)}<span class="disc"
        >${icon("translate")}</span
      ></span
    >`;
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
 * collapses back to the circle and keeps its status arc. `partial`/`error` stay
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
