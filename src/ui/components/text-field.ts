import { LitElement, css, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { baseStyles, emit } from "./shared";

export type NtTextFieldType = "text" | "password" | "url" | "number";

let textFieldInstance = 0;

/**
 * `<nt-text-field label="Model" value="gpt-4.1-mini" description="…">`
 *
 * Labelled native `<input>` (or `<textarea>` with `multiline`) at the 40px
 * settings size. Fires `nt-input` with `detail.value` on every edit and
 * `change` with `detail.value` when the edit is committed (blur or Enter in a
 * single-line field), both bubbling and not composed. `invalid` marks the
 * control with `aria-invalid` and shows `error` as its description.
 */
export class NtTextField extends LitElement {
  static override shadowRootOptions: ShadowRootInit = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    label: { type: String },
    value: { type: String },
    type: { type: String },
    placeholder: { type: String },
    description: { type: String },
    error: { type: String },
    invalid: { type: Boolean, reflect: true },
    disabled: { type: Boolean, reflect: true },
    required: { type: Boolean },
    multiline: { type: Boolean, reflect: true },
    rows: { type: Number },
    maxlength: { type: Number },
    min: { type: Number },
    max: { type: Number },
    autocomplete: { type: String },
    inputmode: { type: String },
    hideLabel: { type: Boolean, attribute: "hide-label" },
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
      input,
      textarea {
        width: 100%;
        min-width: 0;
        min-height: 40px;
        padding: 0 14px;
        border: 1.5px solid var(--nt-line);
        border-radius: var(--nt-r-ctl);
        background: var(--nt-surface);
        color: var(--nt-fg);
      }
      textarea {
        min-height: 112px;
        padding: 10px 14px;
        resize: vertical;
        line-height: var(--nt-lh-body);
        font-family: var(--nt-mono);
        font-size: var(--nt-fs-sm);
      }
      input:hover,
      textarea:hover {
        border-color: var(--nt-fg-3);
      }
      input:focus-visible,
      textarea:focus-visible {
        border-color: var(--nt-accent);
        outline: var(--nt-focus-width) solid var(--nt-focus);
        outline-offset: 1px;
      }
      input::placeholder,
      textarea::placeholder {
        color: var(--nt-fg-3);
      }
      :host([invalid]) input,
      :host([invalid]) textarea {
        border-color: var(--nt-s-err);
      }
      input:disabled,
      textarea:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .desc {
        margin: 0;
        font-size: var(--nt-fs-sm);
        color: var(--nt-fg-3);
        overflow-wrap: anywhere;
      }
      .desc.err {
        color: var(--nt-s-err);
      }
      @media (pointer: coarse) {
        input {
          min-height: 44px;
        }
      }
    `,
  ];

  declare label: string;
  declare value: string;
  declare type: NtTextFieldType;
  declare placeholder: string;
  declare description: string;
  declare error: string;
  declare invalid: boolean;
  declare disabled: boolean;
  declare required: boolean;
  declare multiline: boolean;
  declare rows: number;
  declare maxlength: number | undefined;
  declare min: number | undefined;
  declare max: number | undefined;
  declare autocomplete: string;
  declare inputmode: string;
  declare hideLabel: boolean;

  private readonly uid = `nt-text-field-${++textFieldInstance}`;

  constructor() {
    super();
    this.label = "";
    this.value = "";
    this.type = "text";
    this.placeholder = "";
    this.description = "";
    this.error = "";
    this.invalid = false;
    this.disabled = false;
    this.required = false;
    this.multiline = false;
    this.rows = 5;
    this.maxlength = undefined;
    this.min = undefined;
    this.max = undefined;
    this.autocomplete = "off";
    this.inputmode = "";
    this.hideLabel = false;
  }

  private readonly onInput = (event: Event): void => {
    event.stopPropagation();
    const control = event.target as HTMLInputElement | HTMLTextAreaElement;
    this.value = control.value;
    emit(this, "nt-input", { value: control.value });
  };

  private readonly onChange = (event: Event): void => {
    event.stopPropagation();
    const control = event.target as HTMLInputElement | HTMLTextAreaElement;
    this.value = control.value;
    emit(this, "change", { value: control.value });
  };

  protected override render() {
    const id = `${this.uid}-control`;
    const help = this.invalid && this.error ? this.error : this.description;
    const describedBy = help ? `${this.uid}-desc` : nothing;
    const control = this.multiline
      ? html`<textarea
          id=${id}
          part="control"
          rows=${this.rows}
          spellcheck="false"
          placeholder=${this.placeholder || nothing}
          maxlength=${this.maxlength ?? nothing}
          autocomplete=${this.autocomplete || nothing}
          aria-invalid=${this.invalid ? "true" : nothing}
          aria-describedby=${describedBy}
          ?required=${this.required}
          ?disabled=${this.disabled}
          .value=${live(this.value)}
          @input=${this.onInput}
          @change=${this.onChange}
        ></textarea>`
      : html`<input
          id=${id}
          part="control"
          type=${this.type}
          spellcheck="false"
          placeholder=${this.placeholder || nothing}
          maxlength=${this.maxlength ?? nothing}
          min=${this.min ?? nothing}
          max=${this.max ?? nothing}
          inputmode=${this.inputmode || nothing}
          autocomplete=${this.autocomplete || nothing}
          aria-invalid=${this.invalid ? "true" : nothing}
          aria-describedby=${describedBy}
          ?required=${this.required}
          ?disabled=${this.disabled}
          .value=${live(this.value)}
          @input=${this.onInput}
          @change=${this.onChange}
        />`;
    return html`<label class=${this.hideLabel ? "vh" : ""} for=${id}
        >${this.label}</label
      >
      ${control}
      ${
        help
          ? html`<p
              class="desc ${this.invalid && this.error ? "err" : ""}"
              id="${this.uid}-desc"
            >
              ${help}
            </p>`
          : nothing
      }`;
  }
}
