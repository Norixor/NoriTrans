import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { icon, type NtIconName } from "./icons";
import { baseStyles, deepActiveElement, emit } from "./shared";

export interface NtMenuItem {
  id: string;
  label: string;
  icon?: NtIconName;
  /** Destructive or hard-to-undo actions (rendered in the error tone). */
  danger?: boolean;
  disabled?: boolean;
  /** Draws a separator above this item. */
  separatorBefore?: boolean;
}

export type NtMenuCloseReason = "escape" | "outside" | "select" | "tab";

/**
 * `<nt-menu label="More actions" .items=${[…]} .anchor=${triggerEl} open>`
 *
 * Action menu surface. The host positions the element; this component owns
 * focus and dismissal. When opened it remembers the focused element and moves
 * focus to the first enabled item. Up/Down (wrapping), Home/End move;
 * Enter/Space activate; Escape closes and restores focus; Tab closes and lets
 * focus move on; a pointer press outside the menu and its `anchor` closes it.
 *
 * Events: `nt-select` `{ id }` (then closes), `nt-close` `{ reason }`.
 */
export class NtMenu extends LitElement {
  static override properties = {
    open: { type: Boolean, reflect: true },
    items: { attribute: false },
    label: { type: String },
    anchor: { attribute: false },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        min-width: 200px;
        max-width: min(320px, calc(100vw - 24px));
      }
      :host(:not([open])) {
        display: none;
      }
      .menu {
        display: grid;
        padding: 6px;
        border: 1px solid var(--nt-line);
        border-radius: 14px;
        background: var(--nt-surface);
        color: var(--nt-fg);
        box-shadow: var(--nt-shadow-float);
      }
      .item {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 40px;
        padding: 6px 12px;
        border: 0;
        border-radius: 10px;
        background: transparent;
        text-align: start;
        font-weight: 600;
        cursor: pointer;
        overflow-wrap: anywhere;
      }
      .item:hover,
      .item:focus-visible {
        background: var(--nt-surface-3);
      }
      .item:focus-visible {
        outline-offset: -3px;
      }
      .item[data-danger="true"] {
        color: var(--nt-s-err);
      }
      .item[aria-disabled="true"] {
        opacity: 0.5;
        cursor: default;
      }
      .item svg {
        width: 16px;
        height: 16px;
        flex: 0 0 auto;
      }
      hr {
        margin: 4px 6px;
        border: 0;
        border-top: 1px solid var(--nt-line-2);
      }
      @media (pointer: coarse) {
        .item {
          min-height: 44px;
        }
      }
    `,
  ];

  declare open: boolean;
  declare items: NtMenuItem[];
  declare label: string;
  /** The trigger element; presses on it are not treated as "outside". */
  declare anchor: Element | null;

  private returnFocus: HTMLElement | null = null;

  constructor() {
    super();
    this.open = false;
    this.items = [];
    this.label = "";
    this.anchor = null;
  }

  private readonly onDocumentPointerDown = (event: Event): void => {
    if (!this.open) return;
    const path = event.composedPath();
    if (path.includes(this) || (this.anchor && path.includes(this.anchor)))
      return;
    this.close("outside", false);
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.onDocumentPointerDown, true);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    document.removeEventListener(
      "pointerdown",
      this.onDocumentPointerDown,
      true,
    );
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("open") && this.open) {
      const active = deepActiveElement();
      this.returnFocus = active instanceof HTMLElement ? active : null;
    }
  }

  protected override updated(changed: PropertyValues<this>): void {
    if (changed.has("open") && this.open) this.itemButtons()[0]?.focus();
  }

  private itemButtons(): HTMLButtonElement[] {
    return Array.from(
      this.renderRoot.querySelectorAll<HTMLButtonElement>(
        '.item:not([aria-disabled="true"])',
      ),
    );
  }

  /** Closes the menu. Focus returns to the opener for keyboard dismissals. */
  close(reason: NtMenuCloseReason, restoreFocus = true): void {
    if (!this.open) return;
    this.open = false;
    const target = this.returnFocus;
    this.returnFocus = null;
    if (restoreFocus && target?.isConnected) target.focus();
    emit(this, "nt-close", { reason });
  }

  private activate(item: NtMenuItem): void {
    if (item.disabled) return;
    emit(this, "nt-select", { id: item.id });
    this.close("select");
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const buttons = this.itemButtons();
    const current = buttons.findIndex(
      (button) => button === this.shadowRoot?.activeElement,
    );
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = current + 1;
        break;
      case "ArrowUp":
        next = current < 0 ? buttons.length - 1 : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = buttons.length - 1;
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        this.close("escape");
        return;
      case "Tab":
        this.close("tab", false);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (buttons.length === 0) return;
    buttons[(next + buttons.length) % buttons.length]?.focus();
  };

  protected override render() {
    return html`<div
      class="menu"
      part="menu"
      role="menu"
      aria-label=${this.label || nothing}
      @keydown=${this.onKeyDown}
    >
      ${this.items.map(
        (item) =>
          html`${item.separatorBefore ? html`<hr role="separator" />` : nothing}<button
              class="item"
              part="item"
              type="button"
              role="menuitem"
              tabindex="-1"
              data-danger=${item.danger ? "true" : "false"}
              aria-disabled=${item.disabled ? "true" : "false"}
              @click=${() => this.activate(item)}
            >
              ${item.icon ? icon(item.icon) : nothing}<span>${item.label}</span>
            </button>`,
      )}
    </div>`;
  }
}
