/*
 * Plain-DOM status glyphs for hot-path injected UI (subtitle overlay, in-page
 * block markers) that must not pull in a component runtime. Shapes mirror the
 * direction B glyphs in src/ui/components/icons.ts so state is encoded by
 * shape, never by colour alone. All geometry is static; nothing is parsed from
 * strings or fetched at runtime.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export type DomStatusGlyph = "translating" | "partial" | "error" | "skipped";

type Shape = readonly [
  tag: string,
  attributes: Readonly<Record<string, string>>,
];

const STROKE = { fill: "none", stroke: "currentColor", "stroke-width": "1.8" };

const GLYPHS: Record<DomStatusGlyph, readonly Shape[]> = {
  translating: [
    ["circle", { cx: "10", cy: "10", r: "7", ...STROKE, opacity: ".3" }],
    [
      "path",
      {
        d: "M10 3a7 7 0 0 1 7 7",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
      },
    ],
  ],
  partial: [
    ["circle", { cx: "10", cy: "10", r: "7", ...STROKE }],
    ["path", { d: "M10 3a7 7 0 0 1 0 14z", fill: "currentColor" }],
  ],
  error: [
    [
      "path",
      {
        d: "M10 2.5l8 14H2z",
        fill: "currentColor",
        stroke: "currentColor",
        "stroke-width": "1",
        "stroke-linejoin": "round",
      },
    ],
    [
      "path",
      {
        d: "M10 8v4.2",
        stroke: "var(--nt-on-status, #fff)",
        "stroke-width": "2",
        "stroke-linecap": "round",
      },
    ],
    [
      "circle",
      { cx: "10", cy: "14.4", r: "1.1", fill: "var(--nt-on-status, #fff)" },
    ],
  ],
  // Dashed circle with a bar: "not handled here" (README §2.1 unavailable).
  skipped: [
    [
      "circle",
      { cx: "10", cy: "10", r: "7", ...STROKE, "stroke-dasharray": "3 2" },
    ],
    [
      "path",
      {
        d: "M7 10h6",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
      },
    ],
  ],
};

/** Creates a decorative 20×20 status glyph; size it with CSS. */
export function createStatusGlyph(
  kind: DomStatusGlyph,
  doc: Document = document,
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.glyph = kind;
  for (const [tag, attributes] of GLYPHS[kind]) {
    const shape = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) {
      shape.setAttribute(name, value);
    }
    svg.append(shape);
  }
  return svg;
}
