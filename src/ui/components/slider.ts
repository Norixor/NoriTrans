import { LitElement, css, html } from "lit";
import { live } from "lit/directives/live.js";
import { baseStyles, emit } from "./shared";

let sliderInstance = 0;

/**
 * `<nt-slider label="Background" .value=${0.5} min="0.3" max="0.95"
 *   step="0.05" .format=${(v) => `${Math.round(v * 100)}%`}>`
 *
 * Native range input with a visible label and value. Keyboard and pointer
 * handling are native. Fires `nt-input` with `detail.value` while dragging
 * and `change` with `detail.value` once the value is committed (pointer
 * release or a key step), both bubbling and not composed. `format` also
 * provides `aria-valuetext`.
 */
export class NtSlider extends LitElement {
  static override shadowRootOptions: ShadowRootInit = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    label: { type: String },
    value: { type: Number },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    format: { attribute: false },
    disabled: { type: Boolean, reflect: true },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: grid;
        gap: 6px;
        min-width: 0;
      }
      .head {
        display: flex;
        justify-content: space-between;
        gap: var(--nt-space-3);
        font-size: var(--nt-fs-sm);
        font-weight: 600;
        color: var(--nt-fg-2);
      }
      output {
        color: var(--nt-fg);
        font-variant-numeric: tabular-nums;
      }
      input {
        -webkit-appearance: none;
        appearance: none;
        width: 100%;
        height: 44px;
        margin: 0;
        background: transparent;
        cursor: pointer;
      }
      input::-webkit-slider-runnable-track {
        height: 6px;
        border-radius: 3px;
        background: var(--nt-surface-3);
      }
      input::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 22px;
        height: 22px;
        margin-top: -8px;
        border-radius: 50%;
        border: 3px solid var(--nt-surface);
        background: var(--nt-accent);
        box-shadow: var(--nt-shadow-card);
      }
      input:focus-visible {
        outline: none;
      }
      input:focus-visible::-webkit-slider-thumb {
        outline: var(--nt-focus-width) solid var(--nt-focus);
        outline-offset: 2px;
      }
      input:disabled {
        opacity: 0.55;
        cursor: default;
      }
    `,
  ];

  declare label: string;
  declare value: number;
  declare min: number;
  declare max: number;
  declare step: number;
  declare format: ((value: number) => string) | undefined;
  declare disabled: boolean;

  private readonly uid = `nt-slider-${++sliderInstance}`;

  constructor() {
    super();
    this.label = "";
    this.value = 0;
    this.min = 0;
    this.max = 1;
    this.step = 0.01;
    this.format = undefined;
    this.disabled = false;
  }

  private text(value: number): string {
    return this.format ? this.format(value) : String(value);
  }

  private readonly onInput = (event: Event): void => {
    event.stopPropagation();
    this.value = Number((event.target as HTMLInputElement).value);
    emit(this, "nt-input", { value: this.value });
  };

  private readonly onChange = (event: Event): void => {
    event.stopPropagation();
    this.value = Number((event.target as HTMLInputElement).value);
    emit(this, "change", { value: this.value });
  };

  protected override render() {
    const id = `${this.uid}-control`;
    return html`<div class="head">
        <label for=${id}>${this.label}</label>
        <output for=${id} aria-hidden="true">${this.text(this.value)}</output>
      </div>
      <input
        id=${id}
        part="control"
        type="range"
        min=${this.min}
        max=${this.max}
        step=${this.step}
        aria-valuetext=${this.text(this.value)}
        ?disabled=${this.disabled}
        .value=${live(String(this.value))}
        @input=${this.onInput}
        @change=${this.onChange}
      />`;
  }
}
