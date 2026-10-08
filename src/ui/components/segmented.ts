import { LitElement, css, html, nothing } from "lit";
import { baseStyles, emit } from "./shared";

export interface NtSegmentOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/**
 * `<nt-segmented label="Display" .options=${[…]} value="bilingual">`
 *
 * Single-choice pill group with radio semantics: one tab stop, arrow keys
 * (RTL-aware) and Home/End move and select, Space/Enter select. Fires
 * `change` with `detail.value`. `label` names the radiogroup.
 */
export class NtSegmented extends LitElement {
  static override properties = {
    label: { type: String },
    value: { type: String, reflect: true },
    options: { attribute: false },
    disabled: { type: Boolean, reflect: true },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .group {
        display: flex;
        width: 100%;
        gap: 2px;
        padding: 3px;
        border-radius: var(--nt-r-pill);
        background: var(--nt-surface-3);
      }
      .seg {
        flex: 1 1 0;
        min-width: 0;
        min-height: 34px;
        padding: 2px 10px;
        border: 0;
        border-radius: var(--nt-r-pill);
        background: transparent;
        color: var(--nt-fg-2);
        font-weight: 600;
        font-size: var(--nt-fs-sm);
        line-height: var(--nt-lh-tight);
        cursor: pointer;
        overflow-wrap: anywhere;
        transition:
          background-color var(--nt-dur-base) var(--nt-ease-standard),
          color var(--nt-dur-base) var(--nt-ease-standard);
      }
      .seg:hover {
        color: var(--nt-fg);
      }
      .seg[aria-checked="true"] {
        background: var(--nt-surface);
        color: var(--nt-fg);
        box-shadow: var(--nt-shadow-card);
      }
      .seg:focus-visible {
        outline-offset: -3px;
      }
      .seg[aria-disabled="true"] {
        opacity: 0.5;
        cursor: default;
      }
      @media (pointer: coarse) {
        .seg {
          min-height: 44px;
        }
      }
    `,
  ];

  declare label: string;
  declare value: string;
  declare options: NtSegmentOption[];
  declare disabled: boolean;

  constructor() {
    super();
    this.label = "";
    this.value = "";
    this.options = [];
    this.disabled = false;
  }

  private enabledValues(): string[] {
    return this.options
      .filter((option) => !option.disabled)
      .map((option) => option.value);
  }

  private choose(value: string, focus: boolean): void {
    if (this.disabled) return;
    const option = this.options.find((item) => item.value === value);
    if (!option || option.disabled) return;
    if (value !== this.value) {
      this.value = value;
      emit(this, "change", { value });
    }
    if (focus) {
      void this.updateComplete.then(() => {
        Array.from(this.renderRoot.querySelectorAll<HTMLButtonElement>(".seg"))
          .find((button) => button.dataset.value === value)
          ?.focus();
      });
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const values = this.enabledValues();
    if (values.length === 0) return;
    const current = Math.max(0, values.indexOf(this.value));
    const rtl = getComputedStyle(this).direction === "rtl";
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = event.key === "ArrowRight" && rtl ? current - 1 : current + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = event.key === "ArrowLeft" && rtl ? current + 1 : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = values.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const value = values[(next + values.length) % values.length];
    if (value !== undefined) this.choose(value, true);
  };

  protected override render() {
    const values = this.enabledValues();
    // The checked option (or the first enabled one) owns the single tab stop.
    const focusable = values.includes(this.value) ? this.value : values[0];
    return html`<div
      class="group"
      role="radiogroup"
      part="group"
      aria-label=${this.label || nothing}
      aria-disabled=${this.disabled ? "true" : nothing}
      @keydown=${this.onKeyDown}
    >
      ${this.options.map(
        (option) =>
          html`<button
            class="seg"
            part="segment"
            type="button"
            role="radio"
            data-value=${option.value}
            aria-checked=${option.value === this.value ? "true" : "false"}
            aria-disabled=${this.disabled || option.disabled ? "true" : "false"}
            tabindex=${option.value === focusable && !this.disabled ? 0 : -1}
            @click=${() => this.choose(option.value, false)}
          >
            ${option.label}
          </button>`,
      )}
    </div>`;
  }
}
