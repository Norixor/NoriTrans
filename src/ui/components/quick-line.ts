import { LitElement, css, html, nothing } from "lit";
import { baseStyles, emit, hitAreaStyles } from "./shared";

/**
 * `<nt-quick-line action-label="Change" expanded="false" controls-label="…">
 *    Auto → <b>Chinese</b> · <b>AI</b>
 *  </nt-quick-line>`
 *
 * Direction B summary row: the current settings as one line of slotted text
 * (use `<b>` for values) plus a ghost "change" action that reveals the full
 * controls. `expanded` is reflected to `aria-expanded` on the action. Fires
 * `nt-action` when the action is activated.
 */
export class NtQuickLine extends LitElement {
  static override properties = {
    actionLabel: { type: String, attribute: "action-label" },
    expanded: { type: String },
  };

  static override styles = [
    baseStyles,
    hitAreaStyles,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: var(--nt-space-3);
        min-width: 0;
        padding: 0 2px;
        font-size: var(--nt-fs-sm);
        color: var(--nt-fg-2);
      }
      .summary {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      ::slotted(b),
      ::slotted(strong) {
        color: var(--nt-fg);
        font-weight: 600;
      }
      button {
        flex: 0 0 auto;
        min-height: 32px;
        padding: 0 var(--nt-space-4);
        border: 0;
        border-radius: var(--nt-r-pill);
        background: transparent;
        color: var(--nt-accent);
        font-weight: 600;
        font-size: var(--nt-fs-sm);
        cursor: pointer;
      }
      button:hover {
        background: var(--nt-surface-3);
      }
    `,
  ];

  declare actionLabel: string;
  declare expanded: string;

  constructor() {
    super();
    this.actionLabel = "";
    this.expanded = "";
  }

  protected override render() {
    return html`<span class="summary" part="summary"><slot></slot></span> ${
        this.actionLabel
          ? html`<button
              class="hit"
              part="action"
              type="button"
              aria-expanded=${
                this.expanded === "true" || this.expanded === "false"
                  ? this.expanded
                  : nothing
              }
              @click=${() => emit(this, "nt-action", {})}
            >
              ${this.actionLabel}
            </button>`
          : nothing
      }`;
  }
}
