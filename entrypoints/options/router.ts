/** Settings groups in navigation order (README §2.4). */
export const OPTIONS_GROUPS = [
  "services",
  "page",
  "video",
  "sites",
  "privacy",
  "general",
] as const;
export type OptionsGroup = (typeof OPTIONS_GROUPS)[number];

/**
 * Sub-sections a deep link can open inside a group. Each one is a `details`
 * element (or block) whose id matches the value.
 */
export type OptionsAnchor =
  | "offline-components"
  | "selection-translation"
  | "image-translation"
  | "page-marks"
  | "image-recognition";

export interface OptionsRoute {
  group: OptionsGroup;
  anchor?: OptionsAnchor;
  /** True when the hash was not recognised and the first group was used. */
  fallback: boolean;
}

/**
 * Hash aliases. `providers`, `visibility`, `ocr`, `image` and `video` are
 * opened by the floating control and popup through `OPTIONS_PAGE_OPEN`
 * (see OPTIONS_PAGE_SECTIONS); the rest are the groups' own anchors.
 */
const ALIASES: Readonly<
  Record<string, { group: OptionsGroup; anchor?: OptionsAnchor }>
> = {
  providers: { group: "services" },
  "offline-components": { group: "services", anchor: "offline-components" },
  selection: { group: "page", anchor: "selection-translation" },
  image: { group: "page", anchor: "image-translation" },
  ocr: { group: "video", anchor: "image-recognition" },
  visibility: { group: "general" },
  marks: { group: "page", anchor: "page-marks" },
  profiles: { group: "sites" },
  updates: { group: "general" },
};

/** Resolves `location.hash` to a group; unknown values fall back safely. */
export function resolveOptionsRoute(hash: string): OptionsRoute {
  const key = hash.replace(/^#/u, "").trim().toLowerCase();
  if ((OPTIONS_GROUPS as readonly string[]).includes(key)) {
    return { group: key as OptionsGroup, fallback: false };
  }
  if (Object.hasOwn(ALIASES, key)) {
    const alias = ALIASES[key];
    if (alias) return { ...alias, fallback: false };
  }
  return { group: OPTIONS_GROUPS[0], fallback: key.length > 0 };
}
