const TRANSIENT_UI_MARKERS = new Set([
  "floating-control-fullscreen-portal",
  "native-subtitle-visibility",
  "ocr-fullscreen-portal",
  "ocr-region-selector",
  "selection-translation",
  "subtitle-fullscreen-portal",
  "subtitle-overlay",
  "subtitle-profile-wizard",
  "unified-floating-control",
]);

/** Removes DOM left behind when Chrome invalidates an older extension world. */
export function removeStaleRuntimeUi(root: ParentNode = document): number {
  const stale = new Set<Element>();
  for (const element of root.querySelectorAll("[data-norixortrans-ui]")) {
    const marker = element.getAttribute("data-norixortrans-ui");
    if (marker && TRANSIENT_UI_MARKERS.has(marker)) stale.add(element);
  }
  for (const element of root.querySelectorAll("[data-norixor-ui]")) {
    stale.add(element);
  }
  for (const element of stale) element.remove();
  return stale.size;
}
