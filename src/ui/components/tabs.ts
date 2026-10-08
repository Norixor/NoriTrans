import { LitElement, css, html, nothing } from "lit";
import { baseStyles, emit } from "./shared";

export type NtTabIndicator = "none" | "idle" | "run" | "ok" | "warn" | "err";

export interface NtTabItem {
  id: string;
  label: string;
  /** Small status dot after the label. Never the only signal: pair it with `indicatorLabel`. */
  indicator?: NtTabIndicator;
  /** Screen-reader text for the dot, e.g. "translating". */
  indicatorLabel?: string;
}

let tabsInstance = 0;

/**
 * `<nt-tabs label="…" .tabs=${[{ id: "page", label: "Page" }, …]} selected="page">
 *    <div slot="page">…</div><div slot="video">…</div>
 *  </nt-tabs>`
 *
 * Pill tabs with the panel inside the same shadow root, so `aria-controls` /
 * `aria-labelledby` resolve. Each panel is light-DOM content assigned to a
 * slot named after the tab id; only the selected one is rendered.
 * Keyboard: roving tabindex; Left/Right (RTL-aware), Home/End move and select
 * (automatic activation). Fires `nt-change` with `{ id }`; the selection is
 * applied immediately unless the event is cancelled.
 */
export class NtTabs extends LitElement {
  static override properties = {
    tabs: { attribute: false },
    selected: { type: String, reflect: true },
    label: { type: String },
  };

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        min-width: 0;
      }
      .list {
        display: flex;
        gap: 2px;
        padding: 4px;
        border-radius: var(--nt-r-pill);
        background: var(--nt-surface-3);
      }
      .tab {
        flex: 1 1 0;
        min-width: 0;
        min-height: 36px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 0 var(--nt-space-4);
        border: 0;
        border-radius: var(--nt-r-pill);
        background: transparent;
        color: var(--nt-fg-2);
        font-weight: 700;
        cursor: pointer;
        transition:
          background-color var(--nt-dur-base) var(--nt-ease-standard),
          color var(--nt-dur-base) var(--nt-ease-standard);
      }
      .tab:hover {
        color: var(--nt-fg);
      }
      .tab[aria-selected="true"] {
        background: var(--nt-surface);
        color: var(--nt-fg);
        box-shadow: var(--nt-shadow-card);
      }
      .tab:focus-visible {
        outline-offset: -1px;
      }
      .text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dot {
        width: 7px;
        height: 7px;
        flex: 0 0 auto;
        border-radius: 50%;
        background: var(--nt-s-neutral);
      }
      .dot[data-tone="run"] {
        background: var(--nt-s-progress);
      }
      .dot[data-tone="ok"] {
        background: var(--nt-s-ok);
      }
      .dot[data-tone="warn"] {
        background: var(--nt-s-warn);
      }
      .dot[data-tone="err"] {
        background: var(--nt-s-err);
      }
      .panel {
        display: block;
        margin-top: var(--nt-space-4);
      }
      @media (pointer: coarse) {
        .tab {
          min-height: 44px;
        }
      }
    `,
  ];

  declare tabs: NtTabItem[];
  declare selected: string;
  declare label: string;

  private readonly uid = `nt-tabs-${++tabsInstance}`;

  constructor() {
    super();
    this.tabs = [];
    this.selected = "";
    this.label = "";
  }

  private get selectedId(): string {
    if (this.tabs.some((tab) => tab.id === this.selected)) return this.selected;
    return this.tabs[0]?.id ?? "";
  }

  private tabDomId(id: string): string {
    return `${this.uid}-tab-${id}`;
  }

  private select(id: string, focus: boolean): void {
    if (id !== this.selectedId) {
      if (!emit(this, "nt-change", { id })) return;
      this.selected = id;
    }
    if (focus) {
      void this.updateComplete.then(() => {
        (this.renderRoot as ShadowRoot)
          .getElementById(this.tabDomId(id))
          ?.focus();
      });
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const ids = this.tabs.map((tab) => tab.id);
    const current = ids.indexOf(this.selectedId);
    if (current < 0 || ids.length === 0) return;
    const rtl = getComputedStyle(this).direction === "rtl";
    let next: number;
    switch (event.key) {
      case "ArrowRight":
        next = rtl ? current - 1 : current + 1;
        break;
      case "ArrowLeft":
        next = rtl ? current + 1 : current - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = ids.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const id = ids[(next + ids.length) % ids.length];
    if (id !== undefined) this.select(id, true);
  };

  protected override render() {
    const selected = this.selectedId;
    const panelId = `${this.uid}-panel`;
    return html`<div
        class="list"
        role="tablist"
        part="list"
        aria-label=${this.label || nothing}
        @keydown=${this.onKeyDown}
      >
        ${this.tabs.map((tab) => {
          const isSelected = tab.id === selected;
          const tone =
            tab.indicator && tab.indicator !== "none" ? tab.indicator : null;
          return html`<button
            class="tab"
            part="tab"
            type="button"
            role="tab"
            id=${this.tabDomId(tab.id)}
            aria-selected=${isSelected ? "true" : "false"}
            aria-controls=${isSelected ? panelId : nothing}
            tabindex=${isSelected ? 0 : -1}
            @click=${() => this.select(tab.id, false)}
          >
            <span class="text">${tab.label}</span>
            ${
              tone
                ? html`<span
                      class="dot"
                      data-tone=${tone}
                      aria-hidden="true"
                    ></span
                    >${
                      tab.indicatorLabel
                        ? html`<span class="vh">${tab.indicatorLabel}</span>`
                        : nothing
                    }`
                : nothing
            }
          </button>`;
        })}
      </div>
      <div
        class="panel"
        part="panel"
        role="tabpanel"
        id=${panelId}
        aria-labelledby=${selected ? this.tabDomId(selected) : nothing}
      >
        ${selected ? html`<slot name=${selected}></slot>` : nothing}
      </div>`;
  }
}
