import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { baseStyles, emit, hitAreaStyles } from "./shared";

let stepperInstance = 0;

/** Delay before a held button starts repeating, then the repeat interval. */
export const STEPPER_REPEAT_DELAY_MS = 400;
export const STEPPER_REPEAT_INTERVAL_MS = 90;
/** Idle time after the last click or key step before `change` fires. */
export const STEPPER_COMMIT_DELAY_MS = 450;

/** Large step multiplier for PageUp / PageDown. */
const PAGE_STEPS = 5;

function decimalsOf(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const text = String(value);
  const exponent = /e-(\d+)$/.exec(text);
  if (exponent) return Number(exponent[1]);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * `<nt-stepper label="Font size" .value=${1.2} min="0.75" max="1.8"
 *   step="0.05" scale="100" unit="%" decrement-label="Smaller"
 *   increment-label="Larger">`
 *
 * Numeric stepper: − / value / + in one pill. The value is an ARIA
 * `spinbutton` (one tab stop): ↑/↓ step, PageUp/PageDown take five steps,
 * Home/End jump to the bounds, Enter commits at once. The buttons stay out of
 * the tab order (APG spinbutton pattern) but keep a 44px hit area; holding one
 * repeats after a short delay.
 *
 * Display: `value × scale`, rounded to the precision of `step × scale`, plus
 * `unit` (e.g. 1.2 → "120%"). Set `format` for anything else; its result is
 * also the `aria-valuetext`.
 *
 * Events (bubbling, not composed): `nt-input` on every step with
 * `detail.value`, and one `change` with `detail.value` when the interaction
 * settles (a held button released, Enter, blur, or a short idle after
 * clicks and key presses).
 * Callers persist on `change` and may preview on `nt-input`.
 */
export class NtStepper extends LitElement {
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
    scale: { type: Number },
    unit: { type: String },
    format: { attribute: false },
    decrementLabel: { type: String, attribute: "decrement-label" },
    incrementLabel: { type: String, attribute: "increment-label" },
    disabled: { type: Boolean, reflect: true },
    hideLabel: { type: Boolean, attribute: "hide-label" },
  };

  static override styles = [
    baseStyles,
    hitAreaStyles,
    css`
      :host {
        display: grid;
        gap: 6px;
        min-width: 0;
        justify-items: start;
      }
      .label {
        font-size: var(--nt-fs-sm);
        color: var(--nt-fg-2);
        font-weight: 600;
        overflow-wrap: anywhere;
      }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        max-width: 100%;
        padding: 2px;
        border-radius: var(--nt-r-pill);
        background: var(--nt-surface-3);
      }
      button {
        flex: 0 0 auto;
        display: grid;
        place-items: center;
        width: 36px;
        height: 32px;
        padding: 0;
        border: 0;
        border-radius: var(--nt-r-pill);
        background: transparent;
        color: var(--nt-fg);
        cursor: pointer;
        touch-action: manipulation;
        user-select: none;
        -webkit-user-select: none;
        transition: background-color var(--nt-dur-fast) var(--nt-ease-standard);
      }
      button svg {
        width: 16px;
        height: 16px;
        display: block;
      }
      button:hover:not(:disabled) {
        background: var(--nt-surface);
      }
      button:active:not(:disabled) {
        background: var(--nt-surface-2);
      }
      button:disabled {
        color: var(--nt-fg-3);
        cursor: default;
        opacity: 0.6;
      }
      .value {
        min-width: 52px;
        padding: 0 4px;
        border-radius: var(--nt-r-ctl);
        text-align: center;
        font-weight: 700;
        font-size: var(--nt-fs-sm);
        font-variant-numeric: tabular-nums;
        line-height: 32px;
        color: var(--nt-fg);
        cursor: default;
        user-select: none;
        -webkit-user-select: none;
      }
      .value:focus-visible {
        outline-offset: 0;
      }
      :host([disabled]) .pill {
        opacity: 0.55;
      }
      @media (pointer: coarse) {
        button {
          width: 44px;
          height: 40px;
        }
        .value {
          line-height: 40px;
        }
      }
    `,
  ];

  declare label: string;
  declare value: number;
  declare min: number;
  declare max: number;
  declare step: number;
  declare scale: number;
  declare unit: string;
  declare format: ((value: number) => string) | undefined;
  declare decrementLabel: string;
  declare incrementLabel: string;
  declare disabled: boolean;
  declare hideLabel: boolean;

  private readonly uid = `nt-stepper-${++stepperInstance}`;
  /** Value at the start of the current interaction; `undefined` when idle. */
  private interactionStart: number | undefined;
  private repeatTimer: ReturnType<typeof setTimeout> | undefined;
  private commitTimer: ReturnType<typeof setTimeout> | undefined;
  private heldPointer: number | undefined;
  /** Whether the current hold went past its first step. */
  private repeating = false;

  constructor() {
    super();
    this.label = "";
    this.value = 0;
    this.min = 0;
    this.max = 100;
    this.step = 1;
    this.scale = 1;
    this.unit = "";
    this.format = undefined;
    this.decrementLabel = "";
    this.incrementLabel = "";
    this.disabled = false;
    this.hideLabel = false;
  }

  override disconnectedCallback(): void {
    // A pending interaction still reports its final value.
    this.stopRepeat();
    this.commit();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues<this>): void {
    // Going disabled mid-interaction ends it with the value reached so far.
    if (changed.has("disabled") && this.disabled) {
      this.stopRepeat();
      this.commit();
    }
  }

  /** Text shown and announced for `value`. */
  displayText(value = this.value): string {
    if (this.format) return this.format(value);
    const scaled = value * this.scale;
    const decimals = Math.min(6, decimalsOf(this.step * this.scale));
    return `${Number(scaled.toFixed(decimals))}${this.unit}`;
  }

  private bounds(): { low: number; high: number } {
    const low = Number.isFinite(this.min) ? this.min : -Infinity;
    const high = Number.isFinite(this.max) ? this.max : Infinity;
    return low <= high ? { low, high } : { low: high, high: low };
  }

  private clamp(value: number): number {
    const { low, high } = this.bounds();
    const decimals = Math.min(10, decimalsOf(this.step) + 2);
    const rounded = Number(value.toFixed(decimals));
    return Math.min(high, Math.max(low, rounded));
  }

  private current(): number {
    return Number.isFinite(this.value)
      ? this.clamp(this.value)
      : this.bounds().low;
  }

  /** Moves to `next`; false when the value could not change. */
  private setValue(next: number): boolean {
    if (this.disabled) return false;
    const from = this.current();
    const value = this.clamp(next);
    if (value === from) return false;
    this.interactionStart ??= from;
    this.value = value;
    emit(this, "nt-input", { value });
    return true;
  }

  private atLimit(direction: 1 | -1): boolean {
    const { low, high } = this.bounds();
    const value = this.current();
    return direction > 0 ? value >= high : value <= low;
  }

  private stepBy(steps: number): boolean {
    const size = this.step > 0 && Number.isFinite(this.step) ? this.step : 1;
    return this.setValue(this.current() + steps * size);
  }

  /** Fires `change` once per interaction, when the value actually moved. */
  private commit(): void {
    if (this.commitTimer !== undefined) clearTimeout(this.commitTimer);
    this.commitTimer = undefined;
    const start = this.interactionStart;
    this.interactionStart = undefined;
    if (start === undefined || start === this.value) return;
    emit(this, "change", { value: this.value });
  }

  private scheduleCommit(): void {
    if (this.commitTimer !== undefined) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => this.commit(), STEPPER_COMMIT_DELAY_MS);
  }

  private stopRepeat(): void {
    if (this.repeatTimer !== undefined) clearTimeout(this.repeatTimer);
    this.repeatTimer = undefined;
    this.heldPointer = undefined;
    this.repeating = false;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.disabled) return;
    const { low, high } = this.bounds();
    let moved: boolean;
    switch (event.key) {
      case "ArrowUp":
        moved = this.stepBy(1);
        break;
      case "ArrowDown":
        moved = this.stepBy(-1);
        break;
      case "PageUp":
        moved = this.stepBy(PAGE_STEPS);
        break;
      case "PageDown":
        moved = this.stepBy(-PAGE_STEPS);
        break;
      case "Home":
        moved = Number.isFinite(low) && this.setValue(low);
        break;
      case "End":
        moved = Number.isFinite(high) && this.setValue(high);
        break;
      case "Enter":
        event.preventDefault();
        this.commit();
        return;
      default:
        return;
    }
    event.preventDefault();
    if (moved) this.scheduleCommit();
  };

  private onPointerDown(event: PointerEvent, direction: 1 | -1): void {
    if (this.disabled || event.button !== 0) return;
    // Keep focus on the spinbutton so arrow keys keep working afterwards.
    event.preventDefault();
    this.renderRoot.querySelector<HTMLElement>(".value")?.focus({
      preventScroll: true,
    });
    if (this.commitTimer !== undefined) clearTimeout(this.commitTimer);
    this.commitTimer = undefined;
    this.stopRepeat();
    // Reaching a bound disables the button, which may then never see its
    // pointerup, so the interaction ends right there.
    if (!this.stepBy(direction) || this.atLimit(direction)) {
      this.commit();
      return;
    }
    this.heldPointer = event.pointerId;
    const target = event.currentTarget as HTMLElement | null;
    try {
      target?.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture is best effort; pointerleave still ends the hold.
    }
    const repeat = (): void => {
      if (this.heldPointer === undefined) return;
      this.repeating = true;
      if (!this.stepBy(direction) || this.atLimit(direction)) {
        this.stopRepeat();
        this.commit();
        return;
      }
      this.repeatTimer = setTimeout(repeat, STEPPER_REPEAT_INTERVAL_MS);
    };
    this.repeatTimer = setTimeout(repeat, STEPPER_REPEAT_DELAY_MS);
  }

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (this.heldPointer === undefined || event.pointerId !== this.heldPointer)
      return;
    const repeated = this.repeating;
    this.stopRepeat();
    // A held run is one deliberate change; single clicks may follow each
    // other quickly, so they settle like key presses.
    if (repeated) this.commit();
    else this.scheduleCommit();
  };

  /**
   * Clicks without a pointer sequence (assistive tech, `element.click()`)
   * step once; pointer clicks were already handled on `pointerdown`.
   */
  private onClick(event: MouseEvent, direction: 1 | -1): void {
    if (event.detail !== 0) return;
    if (this.stepBy(direction)) this.scheduleCommit();
  }

  private readonly onFocusOut = (): void => {
    if (this.heldPointer !== undefined) return;
    this.commit();
  };

  private renderButton(direction: 1 | -1, atLimit: boolean) {
    const label = direction < 0 ? this.decrementLabel : this.incrementLabel;
    return html`<button
      class="hit"
      part=${direction < 0 ? "decrement" : "increment"}
      type="button"
      tabindex="-1"
      aria-label=${label || nothing}
      aria-controls="${this.uid}-value"
      ?disabled=${this.disabled || atLimit}
      @pointerdown=${(event: PointerEvent) => this.onPointerDown(event, direction)}
      @pointerup=${this.onPointerEnd}
      @pointercancel=${this.onPointerEnd}
      @pointerleave=${this.onPointerEnd}
      @lostpointercapture=${this.onPointerEnd}
      @click=${(event: MouseEvent) => this.onClick(event, direction)}
      @contextmenu=${(event: Event) => event.preventDefault()}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path
          d=${direction < 0 ? "M3.5 8h9" : "M3.5 8h9M8 3.5v9"}
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </svg>
    </button>`;
  }

  protected override render() {
    const value = this.current();
    const { low, high } = this.bounds();
    const text = this.displayText(value);
    return html`<span
        class=${this.hideLabel ? "label vh" : "label"}
        id="${this.uid}-label"
        >${this.label}</span
      >
      <div class="pill" part="pill" @focusout=${this.onFocusOut}>
        ${this.renderButton(-1, value <= low)}
        <div
          class="value"
          part="value"
          id="${this.uid}-value"
          role="spinbutton"
          tabindex=${this.disabled ? "-1" : "0"}
          aria-labelledby="${this.uid}-label"
          aria-valuenow=${String(value)}
          aria-valuemin=${Number.isFinite(low) ? String(low) : nothing}
          aria-valuemax=${Number.isFinite(high) ? String(high) : nothing}
          aria-valuetext=${text}
          aria-disabled=${this.disabled ? "true" : "false"}
          @keydown=${this.onKeyDown}
        >
          ${text}
        </div>
        ${this.renderButton(1, value >= high)}
      </div>`;
  }
}
