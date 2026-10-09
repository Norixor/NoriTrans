import { css, html, nothing, svg, type TemplateResult } from "lit";
import { isBusyState, normalizeProgress, type NtVisualState } from "./shared";

/**
 * Status arc of the floating button. The arc is the only state signal on the
 * collapsed button, so every style differs in shape, not just colour:
 * progress (an arc advancing from the start), solid (ready), dashed
 * (partial), dotted with round caps (error), dash-dot (cancelled), none.
 */
export type NtFabRing =
  "progress" | "solid" | "dashed" | "dotted" | "dashdot" | "none";

/** Viewport edge the button is tucked into; only that half stays visible. */
export type NtFabEdge = "left" | "right" | "top" | "bottom";

/**
 * Geometry in the 48px button box. The arc's outer edge stops at
 * radius + stroke / 2 = 22.75px, 1.25px inside the box, so the pill's
 * `overflow: hidden` never clips it; its inner edge (19.25px) clears the
 * 36px disc by 1.25px.
 */
export const FAB_RING_GEOMETRY = {
  box: 48,
  center: 24,
  radius: 21,
  stroke: 3.5,
} as const;

/** Dash units (`pathLength`) per full circle; half arcs use half of it. */
export const FAB_RING_UNITS = 120;

export function isFabEdge(value: unknown): value is NtFabEdge {
  return (
    value === "left" ||
    value === "right" ||
    value === "top" ||
    value === "bottom"
  );
}

export function fabRingKind(state: NtVisualState): NtFabRing {
  if (isBusyState(state)) return "progress";
  switch (state) {
    case "ready":
      return "solid";
    case "partial":
      return "dashed";
    case "error":
      return "dotted";
    case "cancelled":
      return "dashdot";
    default:
      return "none";
  }
}

export interface FabArcPath {
  /** SVG path data, drawn in the direction progress advances. */
  d: string;
  /** `pathLength` of the path, in dash units. */
  length: number;
}

const round = (value: number) => Number(value.toFixed(3));

/**
 * The arc the ring draws. Without an edge it is the full circle, clockwise
 * from the top. Tucked into an edge only the visible half is drawn:
 * left edge (right half visible) runs top to bottom clockwise, right edge
 * (left half visible) top to bottom anticlockwise, top and bottom edges
 * (bottom / top half visible) left to right. SVG's y axis points down, so
 * sweep flag 1 is clockwise on screen.
 */
export function fabArcPath(
  edge: NtFabEdge | undefined,
  center: number = FAB_RING_GEOMETRY.center,
  radius: number = FAB_RING_GEOMETRY.radius,
): FabArcPath {
  const c = round(center);
  const r = round(radius);
  const top = `${c} ${round(c - r)}`;
  const bottom = `${c} ${round(c + r)}`;
  const left = `${round(c - r)} ${c}`;
  const right = `${round(c + r)} ${c}`;
  const arc = (sweep: 0 | 1, to: string) => `A ${r} ${r} 0 0 ${sweep} ${to}`;
  const half = FAB_RING_UNITS / 2;
  switch (edge) {
    case "left":
      return { d: `M ${top} ${arc(1, bottom)}`, length: half };
    case "right":
      return { d: `M ${top} ${arc(0, bottom)}`, length: half };
    case "top":
      return { d: `M ${left} ${arc(0, right)}`, length: half };
    case "bottom":
      return { d: `M ${left} ${arc(1, right)}`, length: half };
    default:
      return {
        d: `M ${top} ${arc(1, bottom)} ${arc(1, top)}`,
        length: FAB_RING_UNITS,
      };
  }
}

export interface FabArcSpec extends FabArcPath {
  kind: Exclude<NtFabRing, "none">;
  /** `stroke-dasharray` in dash units; null for a continuous stroke. */
  dasharray: string | null;
  dashoffset: number;
  linecap: "butt" | "round";
  /** Progress without a known fraction: a short arc that travels. */
  indeterminate: boolean;
}

/**
 * Patterns repeat a whole number of times per half circle (60 units), and
 * the offsets centre them, so a half arc starts and ends symmetrically and a
 * full circle has no seam.
 */
const PATTERNS = {
  solid: { dasharray: null, dashoffset: 0, linecap: "butt" },
  dashed: { dasharray: "7 5", dashoffset: 9.5, linecap: "butt" },
  dotted: { dasharray: "0 6", dashoffset: 3, linecap: "round" },
  dashdot: { dasharray: "10 4 2 4", dashoffset: 18, linecap: "butt" },
} as const;

/** Length of the travelling arc for indeterminate progress, in dash units. */
export const FAB_INDETERMINATE_UNITS = 30;

/**
 * Everything needed to draw the arc for a ring kind. `progress` is 0..1 or
 * null (indeterminate) and only matters for `progress`; 0..1 maps onto the
 * visible arc, so a tucked button reaches the far end of its half at 100%.
 */
export function fabArcSpec(
  kind: NtFabRing,
  edge: NtFabEdge | undefined,
  progress: number | null,
): FabArcSpec | null {
  if (kind === "none") return null;
  const path = fabArcPath(edge);
  if (kind !== "progress")
    return { ...path, kind, ...PATTERNS[kind], indeterminate: false };
  const value = normalizeProgress(progress);
  if (value === null) {
    const dash = (FAB_INDETERMINATE_UNITS * path.length) / FAB_RING_UNITS;
    return {
      ...path,
      kind,
      dasharray: `${round(dash)} ${round(FAB_RING_UNITS + path.length - dash)}`,
      dashoffset: 0,
      linecap: "round",
      indeterminate: true,
    };
  }
  return {
    ...path,
    kind,
    dasharray: `${round(value * path.length)} ${path.length}`,
    dashoffset: 0,
    // A round cap would turn an empty arc into a dot.
    linecap: value > 0 ? "round" : "butt",
    indeterminate: false,
  };
}

/** Renders the status arc (plus the progress track while busy). */
export function fabRing(
  kind: NtFabRing,
  edge: NtFabEdge | undefined,
  progress: number | null,
): TemplateResult | typeof nothing {
  const spec = fabArcSpec(kind, edge, progress);
  if (!spec) return nothing;
  const { box, stroke } = FAB_RING_GEOMETRY;
  // The travelling arc enters before the start and leaves past the end.
  const travel = spec.indeterminate
    ? `--nt-arc-from:${round((FAB_INDETERMINATE_UNITS * spec.length) / FAB_RING_UNITS)};--nt-arc-to:${-spec.length}`
    : "";
  return html`<svg
    class="dial"
    part="ring"
    viewBox="0 0 ${box} ${box}"
    width=${box}
    height=${box}
    aria-hidden="true"
    focusable="false"
  >
    ${
      kind === "progress"
        ? svg`<path class="track" d=${spec.d} pathLength=${spec.length} fill="none" stroke-width=${stroke}/>`
        : nothing
    }
    ${svg`<path class="arc ${spec.indeterminate ? "indet" : ""}" d=${spec.d} pathLength=${spec.length} fill="none" stroke-width=${stroke} stroke-linecap=${spec.linecap} stroke-dasharray=${spec.dasharray ?? nothing} stroke-dashoffset=${spec.dashoffset} style=${travel || nothing}/>`}
  </svg>`;
}

export const fabRingStyles = css`
  .dial {
    position: absolute;
    inset: -2px;
    width: 48px;
    height: 48px;
    display: block;
    pointer-events: none;
  }
  .dial .track {
    stroke: color-mix(in srgb, var(--nt-s-progress) 22%, transparent);
  }
  .dial .arc {
    stroke: var(--nt-fab-arc, var(--nt-s-progress));
    transition: stroke-dasharray var(--nt-dur-slow) var(--nt-ease-standard);
  }
  .dial .arc.indet {
    animation: nt-fab-arc-travel 1.4s linear infinite;
  }
  @keyframes nt-fab-arc-travel {
    from {
      stroke-dashoffset: var(--nt-arc-from);
    }
    to {
      stroke-dashoffset: var(--nt-arc-to);
    }
  }
  /* Static arc at the start instead of the travel's (empty) end frame. */
  @media (prefers-reduced-motion: reduce) {
    .dial .arc.indet {
      animation: none;
    }
  }
`;
