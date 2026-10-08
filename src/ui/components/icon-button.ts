import { LitElement, css, html, nothing } from "lit";
import { icon, isIconName, type NtIconName } from "./icons";
import { baseStyles, hitAreaStyles } from "./shared";

/**
 * `<nt-icon-button icon="more" label="More actions" haspopup="menu">`
 *
 * Transparent round icon button for title bars. `label` is required and
 * becomes the accessible name (icons alone are never the only label).
 * `expanded` / `haspopup` wire it as a menu trigger; `pressed` makes it a
 * toggle. A custom icon can be slotted instead of a named one.
 */
export class NtIconButton extends LitElement {
  static override shadowRootOptions: ShadowRootInit = {
    ...LitElement.shadowRootOptions,
    delegatesFocus: true,
  };

  static override properties = {
    icon: { type: String },
    label: { type: String },
    disabled: { type: Boolean, reflect: true },
    expanded: { type: String },
    haspopup: { type: String },
    pressed: { type: String },
  };

  static override styles = [
    baseStyles,
    hitAreaStyles,
    css`
      :host {
        display: inline-flex;
        flex: 0 0 auto;
      }
      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--nt-fg-2);
        cursor: pointer;
        transition: background-color var(--nt-dur-base) var(--nt-ease-standard);
      }
      button:hover,
      button[aria-expanded="true"],
      button[aria-pressed="true"] {
        background: var(--nt-surface-3);
        color: var(--nt-fg);
      }
      button:focus-visible {
        border-radius: 50%;
      }
      button[aria-disabled="true"] {
        opacity: 0.5;
        cursor: default;
      }
      svg,
      ::slotted(svg) {
        width: 20px;
        height: 20px;
        display: block;
      }
      @media (pointer: coarse) {
        button {
          width: 44px;
          height: 44px;
        }
      }
    `,
  ];

  declare icon: NtIconName | "";
  declare label: string;
  declare disabled: boolean;
  declare expanded: string;
  declare haspopup: string;
  declare pressed: string;

  constructor() {
    super();
    this.icon = "";
    this.label = "";
    this.disabled = false;
    this.expanded = "";
    this.haspopup = "";
    this.pressed = "";
    this.addEventListener(
      "click",
      (event) => {
        if (this.disabled) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  }

  protected override render() {
    const boolAttr = (value: string) =>
      value === "true" || value === "false" ? value : nothing;
    return html`<button
      class="hit"
      part="button"
      type="button"
      aria-label=${this.label || nothing}
      aria-disabled=${this.disabled ? "true" : "false"}
      aria-expanded=${boolAttr(this.expanded)}
      aria-haspopup=${this.haspopup || nothing}
      aria-pressed=${boolAttr(this.pressed)}
    >
      ${isIconName(this.icon) ? icon(this.icon) : html`<slot></slot>`}
    </button>`;
  }
}
