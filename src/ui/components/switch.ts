import { LitElement, css, html, nothing } from "lit";
import { baseStyles, emit } from "./shared";

let switchInstance = 0;

/**
 * `<nt-switch label="Auto-translate example.com" description="…" checked>`
 *
 * A `role="switch"` button with a visible label row (the whole row is the
 * 44px target). Fires `change` (bubbling, not composed) after toggling, with
 * `detail.checked`; cancel the preceding `nt-before-change` to veto.
 */
export class NtSwitch extends LitElement {
  static override shadowRootOptions: ShadowRootInit = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    checked: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    label: { type: String },
    description: { type: String },
    compact: { type: Boolean, reflect: true },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      button {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--nt-space-4);
        width: 100%;
        min-height: 44px;
        padding: 0;
        border: 0;
        background: transparent;
        text-align: start;
        cursor: pointer;
        border-radius: var(--nt-r-ctl);
      }
      :host([compact]) button {
        min-height: 40px;
      }
      .text {
        display: grid;
        gap: 2px;
        min-width: 0;
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .desc {
        color: var(--nt-fg-3);
        font-size: var(--nt-fs-sm);
        font-weight: 400;
      }
      .track {
        position: relative;
        flex: 0 0 auto;
        width: 44px;
        height: 26px;
        border-radius: 13px;
        background: var(--nt-fg-3);
        transition: background-color var(--nt-dur-base) var(--nt-ease-standard);
      }
      .track::after {
        content: "";
        position: absolute;
        top: 3px;
        left: 3px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
        transition: transform var(--nt-dur-base) var(--nt-ease-standard);
      }
      button[aria-checked="true"] .track {
        background: var(--nt-accent);
      }
      button[aria-checked="true"] .track::after {
        transform: translateX(18px);
      }
      :host(:dir(rtl)) button[aria-checked="true"] .track::after {
        transform: translateX(-18px);
      }
      :host(:dir(rtl)) .track::after {
        left: auto;
        right: 3px;
      }
      button:focus-visible {
        outline: none;
      }
      button:focus-visible .track {
        outline: var(--nt-focus-width) solid var(--nt-focus);
        outline-offset: 2px;
      }
      button[aria-disabled="true"] {
        cursor: default;
        opacity: 0.55;
      }
    `,
  ];

  declare checked: boolean;
  declare disabled: boolean;
  declare label: string;
  declare description: string;
  declare compact: boolean;

  private readonly uid = `nt-switch-${++switchInstance}`;

  constructor() {
    super();
    this.checked = false;
    this.disabled = false;
    this.label = "";
    this.description = "";
    this.compact = false;
  }

  private readonly toggle = (): void => {
    if (this.disabled) return;
    const next = !this.checked;
    if (!emit(this, "nt-before-change", { checked: next })) return;
    this.checked = next;
    emit(this, "change", { checked: next });
  };

  protected override render() {
    return html`<button
      part="button"
      type="button"
      role="switch"
      aria-checked=${this.checked ? "true" : "false"}
      aria-disabled=${this.disabled ? "true" : "false"}
      aria-labelledby="${this.uid}-label"
      aria-describedby=${this.description ? `${this.uid}-desc` : nothing}
      @click=${this.toggle}
    >
      <span class="text">
        <span id="${this.uid}-label">${this.label}</span>
        ${
          this.description
            ? html`<span class="desc" id="${this.uid}-desc"
                >${this.description}</span
              >`
            : nothing
        }
      </span>
      <span class="track" aria-hidden="true"></span>
    </button>`;
  }
}
