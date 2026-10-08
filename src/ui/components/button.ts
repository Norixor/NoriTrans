import { LitElement, css, html, nothing } from "lit";
import { baseStyles, hitAreaStyles } from "./shared";

export type NtButtonVariant = "secondary" | "primary" | "ghost" | "danger";
export type NtButtonSize = "sm" | "md" | "lg";

/**
 * `<nt-button variant="primary" block busy>Label</nt-button>`
 *
 * Pill button. The label is slotted from the caller. `busy` keeps the button
 * in place with a spinner (the "transition state" rule: the action slot never
 * disappears while a request is in flight) and blocks activation. `sm` keeps
 * a 44px hit area around its 32px visual.
 */
export class NtButton extends LitElement {
  static override shadowRootOptions: ShadowRootInit = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    variant: { type: String, reflect: true },
    size: { type: String, reflect: true },
    block: { type: Boolean, reflect: true },
    busy: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    label: { type: String },
    pressed: { type: String },
  };

  static override styles = [
    baseStyles,
    hitAreaStyles,
    css`
      :host {
        display: inline-flex;
        vertical-align: middle;
        min-width: 0;
      }
      :host([block]) {
        display: flex;
        width: 100%;
      }
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--nt-space-3);
        width: 100%;
        min-width: 0;
        min-height: 40px;
        padding: 0 var(--nt-space-5);
        border: 0;
        border-radius: var(--nt-r-pill);
        background: var(--nt-surface-3);
        color: var(--nt-fg);
        font-weight: 600;
        font-size: var(--nt-fs-body);
        line-height: var(--nt-lh-tight);
        cursor: pointer;
        transition:
          transform 80ms,
          background-color var(--nt-dur-base) var(--nt-ease-standard);
      }
      .label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      :host([block]) .label {
        white-space: normal;
        overflow-wrap: anywhere;
        text-align: center;
      }
      button:hover {
        background: var(--nt-line);
      }
      button:active {
        transform: scale(0.98);
      }
      :host([variant="primary"]) button {
        background: var(--nt-accent);
        color: var(--nt-on-accent);
      }
      :host([variant="primary"]) button:hover {
        background: var(--nt-accent-hover);
      }
      :host([variant="ghost"]) button {
        background: transparent;
        color: var(--nt-fg-2);
      }
      :host([variant="ghost"]) button:hover {
        background: var(--nt-surface-3);
        color: var(--nt-fg);
      }
      :host([variant="danger"]) button {
        background: var(--nt-s-err-bg);
        color: var(--nt-s-err);
      }
      :host([size="sm"]) button {
        min-height: 32px;
        padding: 0 var(--nt-space-4);
        font-size: var(--nt-fs-sm);
      }
      :host([size="lg"]) button,
      :host([block]) button {
        min-height: 44px;
        padding-top: 6px;
        padding-bottom: 6px;
      }
      button[aria-disabled="true"] {
        opacity: 0.55;
        cursor: default;
        transform: none;
      }
      :host([busy]) button {
        opacity: 0.8;
        cursor: progress;
      }
      .spin {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
        border: 2.5px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: nt-spin 1s linear infinite;
      }
      ::slotted(svg),
      ::slotted([slot="icon"]) {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
      }
      @media (pointer: coarse) {
        button {
          min-height: 44px;
        }
      }
    `,
  ];

  declare variant: NtButtonVariant;
  declare size: NtButtonSize;
  declare block: boolean;
  declare busy: boolean;
  declare disabled: boolean;
  /** Optional accessible name override, e.g. when the slot holds only an icon. */
  declare label: string;
  /** Toggle buttons: "true" | "false"; empty for a plain button. */
  declare pressed: string;

  constructor() {
    super();
    this.variant = "secondary";
    this.size = "md";
    this.block = false;
    this.busy = false;
    this.disabled = false;
    this.label = "";
    this.pressed = "";
    // Swallow activation while inert so callers never see a click from a busy
    // or disabled button (the inner button stays focusable for discoverability).
    this.addEventListener(
      "click",
      (event) => {
        if (this.disabled || this.busy) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  }

  protected override render() {
    const inert = this.disabled || this.busy;
    return html`<button
      class="hit"
      part="button"
      type="button"
      aria-disabled=${inert ? "true" : "false"}
      aria-busy=${this.busy ? "true" : nothing}
      aria-label=${this.label || nothing}
      aria-pressed=${
        this.pressed === "true" || this.pressed === "false"
          ? this.pressed
          : nothing
      }
    >
      ${this.busy ? html`<span class="spin" aria-hidden="true"></span>` : nothing}
      <slot name="icon"></slot>
      <span class="label"><slot></slot></span>
    </button>`;
  }
}
