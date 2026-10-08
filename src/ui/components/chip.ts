import { LitElement, css, html } from "lit";
import { baseStyles } from "./shared";

/**
 * Chip tones. `full` / `stream` / `experimental` are the subtitle track
 * chips (always carry text, never colour alone); `neutral` is generic.
 */
export type NtChipTone = "neutral" | "full" | "stream" | "experimental";

/** `<nt-chip tone="stream">Live subtitles</nt-chip>` — short slotted label. */
export class NtChip extends LitElement {
  static override properties = {
    tone: { type: String, reflect: true },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: inline-flex;
        max-width: 100%;
        vertical-align: middle;
      }
      span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        min-height: 22px;
        max-width: 100%;
        padding: 1px 9px;
        border-radius: var(--nt-r-pill);
        background: var(--nt-surface-3);
        color: var(--nt-fg-2);
        font-size: var(--nt-fs-xs);
        font-weight: 700;
        line-height: var(--nt-lh-tight);
        overflow-wrap: anywhere;
      }
      :host([tone="full"]) span {
        background: var(--nt-s-ok-bg);
        color: var(--nt-s-ok);
      }
      :host([tone="stream"]) span {
        background: var(--nt-s-warn-bg);
        color: var(--nt-s-warn);
      }
      :host([tone="experimental"]) span {
        background: var(--nt-accent-soft);
        color: var(--nt-accent-text);
      }
    `,
  ];

  declare tone: NtChipTone;

  constructor() {
    super();
    this.tone = "neutral";
  }

  protected override render() {
    return html`<span part="chip"><slot></slot></span>`;
  }
}
