import { LitElement, css, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { baseStyles, emit } from "./shared";

export interface NtSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

let selectInstance = 0;

/**
 * `<nt-select label="Target language" .options=${[…]} value="zh-CN">`
 *
 * Styled native `<select>` (native popup, keyboard and screen-reader support
 * for free). `compact` uses the 36px floating-panel size; the default is
 * 40px and coarse pointers get 44px. `hide-label` keeps the label for
 * assistive tech only. Fires `change` with `detail.value`.
 */
export class NtSelect extends LitElement {
  static override shadowRootOptions: ShadowRootInit = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    label: { type: String },
    value: { type: String },
    options: { attribute: false },
    disabled: { type: Boolean, reflect: true },
    compact: { type: Boolean, reflect: true },
    hideLabel: { type: Boolean, attribute: "hide-label" },
    description: { type: String },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        gap: 6px;
        min-width: 0;
      }
      label {
        font-size: var(--nt-fs-sm);
        color: var(--nt-fg-2);
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .wrap {
        position: relative;
        min-width: 0;
      }
      select {
        appearance: none;
        width: 100%;
        min-width: 0;
        min-height: 40px;
        padding: 0 34px 0 14px;
        border: 1.5px solid var(--nt-line);
        border-radius: var(--nt-r-ctl);
        background: var(--nt-surface);
        color: var(--nt-fg);
        text-overflow: ellipsis;
        cursor: pointer;
      }
      :host([compact]) select {
        min-height: 36px;
      }
      select:hover {
        border-color: var(--nt-fg-3);
      }
      select:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .chev {
        position: absolute;
        inset-inline-end: 12px;
        top: 50%;
        width: 16px;
        height: 16px;
        transform: translateY(-50%);
        pointer-events: none;
        color: var(--nt-fg-2);
      }
      :host(:dir(rtl)) select {
        padding: 0 14px 0 34px;
      }
      .desc {
        margin: 0;
        font-size: var(--nt-fs-sm);
        color: var(--nt-fg-3);
      }
      @media (pointer: coarse) {
        select,
        :host([compact]) select {
          min-height: 44px;
        }
      }
    `,
  ];

  declare label: string;
  declare value: string;
  declare options: NtSelectOption[];
  declare disabled: boolean;
  declare compact: boolean;
  declare hideLabel: boolean;
  declare description: string;

  private readonly uid = `nt-select-${++selectInstance}`;

  constructor() {
    super();
    this.label = "";
    this.value = "";
    this.options = [];
    this.disabled = false;
    this.compact = false;
    this.hideLabel = false;
    this.description = "";
  }

  private readonly onChange = (event: Event): void => {
    event.stopPropagation();
    const select = event.target as HTMLSelectElement;
    this.value = select.value;
    emit(this, "change", { value: select.value });
  };

  protected override render() {
    const id = `${this.uid}-control`;
    return html`<label class=${this.hideLabel ? "vh" : ""} for=${id}
        >${this.label}</label
      >
      <div class="wrap">
        <select
          id=${id}
          part="select"
          ?disabled=${this.disabled}
          aria-describedby=${this.description ? `${this.uid}-desc` : nothing}
          .value=${live(this.value)}
          @change=${this.onChange}
        >
          ${this.options.map(
            (option) =>
              html`<option
                value=${option.value}
                ?disabled=${option.disabled ?? false}
                ?selected=${option.value === this.value}
              >
                ${option.label}
              </option>`,
          )}
        </select>
        <svg
          class="chev"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M8 10l4 4 4-4"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      ${
        this.description
          ? html`<p class="desc" id="${this.uid}-desc">${this.description}</p>`
          : nothing
      }`;
  }
}
