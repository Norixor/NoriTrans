import { LitElement, css, html } from "lit";
import { icon, isIconName, type NtIconName } from "./icons";
import { baseStyles } from "./shared";

export type NtNoteTone = "info" | "warn";

/**
 * `<nt-note tone="warn" icon="shield">Slotted text</nt-note>`
 *
 * Inline explanatory block (privacy notes, fallbacks). `role="note"`; the
 * icon is decorative, so the slotted text must carry the meaning.
 */
export class NtNote extends LitElement {
  static override properties = {
    tone: { type: String, reflect: true },
    icon: { type: String },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .note {
        display: flex;
        gap: 10px;
        padding: var(--nt-space-4) 14px;
        border-radius: var(--nt-r-ctl);
        background: var(--nt-surface-2);
        color: var(--nt-fg-2);
        font-size: var(--nt-fs-sm);
        line-height: var(--nt-lh-body);
        overflow-wrap: anywhere;
      }
      svg {
        width: 20px;
        height: 20px;
        flex: 0 0 auto;
        margin-top: 1px;
        color: var(--nt-accent);
      }
      .body {
        min-width: 0;
      }
      :host([tone="warn"]) .note {
        background: var(--nt-s-warn-bg);
        color: var(--nt-fg);
      }
      :host([tone="warn"]) svg {
        color: var(--nt-s-warn);
      }
    `,
  ];

  declare tone: NtNoteTone;
  declare icon: NtIconName | "";

  constructor() {
    super();
    this.tone = "info";
    this.icon = "";
  }

  protected override render() {
    const name: NtIconName = isIconName(this.icon)
      ? this.icon
      : this.tone === "warn"
        ? "warning"
        : "info";
    return html`<div class="note" part="note" role="note">
      ${icon(name)}<span class="body"><slot></slot></span>
    </div>`;
  }
}
