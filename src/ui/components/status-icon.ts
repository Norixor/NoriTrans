import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { statusGlyph } from "./icons";
import {
  baseStyles,
  isBusyState,
  isVisualState,
  type NtVisualState,
} from "./shared";

/**
 * `<nt-status-icon state="partial" label="…">`
 *
 * Shape-coded status glyph. Decorative (aria-hidden) unless `label` is set,
 * in which case it is exposed as an image with that accessible name.
 */
export class NtStatusIcon extends LitElement {
  static override properties = {
    state: { type: String, reflect: true },
    label: { type: String },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: inline-grid;
        place-items: center;
        width: var(--nt-status-icon-size, 20px);
        height: var(--nt-status-icon-size, 20px);
        flex: 0 0 auto;
        color: var(--nt-s-neutral);
      }
      span {
        display: block;
        width: 100%;
        height: 100%;
      }
      svg {
        width: 100%;
        height: 100%;
        display: block;
      }
      :host([state="scanning"]),
      :host([state="waiting"]),
      :host([state="translating"]) {
        color: var(--nt-s-progress);
      }
      :host([state="ready"]) {
        color: var(--nt-s-ok);
      }
      :host([state="partial"]) {
        color: var(--nt-s-warn);
      }
      :host([state="error"]) {
        color: var(--nt-s-err);
      }
      :host([state="scanning"]) svg,
      :host([state="waiting"]) svg {
        animation: nt-spin 2.4s linear infinite;
      }
      :host([state="translating"]) svg {
        animation: nt-spin 1.1s linear infinite;
      }
    `,
  ];

  declare state: NtVisualState;
  declare label: string;

  constructor() {
    super();
    this.state = "idle";
    this.label = "";
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("state") && !isVisualState(this.state)) this.state = "idle";
  }

  protected override render() {
    return html`<span
      role=${this.label ? "img" : nothing}
      aria-label=${this.label || nothing}
      aria-hidden=${this.label ? nothing : "true"}
      data-busy=${isBusyState(this.state) ? "true" : "false"}
      >${statusGlyph(this.state)}</span
    >`;
  }
}
