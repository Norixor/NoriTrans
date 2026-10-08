import { LitElement, css, html, nothing, svg, type TemplateResult } from "lit";
import { baseStyles, normalizeProgress } from "./shared";

/**
 * Renders a progress ring as SVG. Shared by `<nt-progress-ring>` and the
 * floating button. `value` null draws an indeterminate quarter arc that
 * spins (static under reduced motion). Colours come from
 * `--nt-ring-color` / `--nt-ring-track` on the containing element.
 */
export function progressRing(
  value: number | null,
  size: number,
  thickness: number,
): TemplateResult {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = value === null ? 0.25 : value;
  const dash = `${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}`;
  const center = size / 2;
  return html`<svg
    class="ring ${value === null ? "indet" : ""}"
    viewBox="0 0 ${size} ${size}"
    width=${size}
    height=${size}
    aria-hidden="true"
    focusable="false"
  >
    ${svg`<circle cx=${center} cy=${center} r=${radius} fill="none" stroke="var(--nt-ring-track)" stroke-width=${thickness}/>
    <circle class="arc" cx=${center} cy=${center} r=${radius} fill="none" stroke="var(--nt-ring-color)" stroke-width=${thickness} stroke-linecap="round" stroke-dasharray=${dash} transform="rotate(-90 ${center} ${center})"/>`}
  </svg>`;
}

export const progressRingStyles = css`
  .ring {
    display: block;
  }
  .ring .arc {
    transition: stroke-dasharray var(--nt-dur-slow) var(--nt-ease-standard);
  }
  .ring.indet {
    animation: nt-spin 1.1s linear infinite;
  }
`;

/**
 * `<nt-progress-ring .value=${0.4} size="24" label="Translating 40%">`
 *
 * Standalone ring. With `label` it is a `progressbar`; otherwise decorative.
 */
export class NtProgressRing extends LitElement {
  static override properties = {
    value: { type: Number },
    size: { type: Number },
    thickness: { type: Number },
    label: { type: String },
  };

  static override styles = [
    baseStyles,
    progressRingStyles,
    css`
      :host {
        display: inline-block;
        flex: 0 0 auto;
        line-height: 0;
        --nt-ring-color: var(--nt-s-progress);
        --nt-ring-track: color-mix(
          in srgb,
          var(--nt-s-progress) 18%,
          transparent
        );
      }
    `,
  ];

  declare value: number | null;
  declare size: number;
  declare thickness: number;
  declare label: string;

  constructor() {
    super();
    this.value = null;
    this.size = 24;
    this.thickness = 3;
    this.label = "";
  }

  protected override render() {
    const value = normalizeProgress(this.value);
    const size = Number.isFinite(this.size) && this.size > 0 ? this.size : 24;
    const thickness =
      Number.isFinite(this.thickness) && this.thickness > 0
        ? Math.min(this.thickness, size / 2)
        : 3;
    return html`<span
      role=${this.label ? "progressbar" : nothing}
      aria-hidden=${this.label ? nothing : "true"}
      aria-label=${this.label || nothing}
      aria-valuemin=${this.label ? 0 : nothing}
      aria-valuemax=${this.label ? 100 : nothing}
      aria-valuenow=${this.label && value !== null ? Math.round(value * 100) : nothing}
      >${progressRing(value, size, thickness)}</span
    >`;
  }
}
