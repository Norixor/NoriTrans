const TRANSIENT_UI_MARKERS = new Set([
  "floating-control",
  "floating-control-portal",
  // Hosts of the previous floating control (releases up to 0.1.151). An
  // extension update orphans their DOM on already open pages; the re-injected
  // content script removes it through these markers. Nothing creates them now.
  "floating-control-fullscreen-portal",
  "native-subtitle-visibility",
  "ocr-fullscreen-portal",
  "ocr-region-selector",
  "selection-translation",
  "subtitle-fullscreen-portal",
  "subtitle-overlay",
  "subtitle-profile-wizard",
  // Legacy, see "floating-control-fullscreen-portal" above.
  "unified-floating-control",
]);

/** Removes DOM left behind when Chrome invalidates an older extension world. */
export function removeStaleRuntimeUi(root: ParentNode = document): number {
  const stale = new Set<Element>();
  for (const element of root.querySelectorAll("[data-noritrans-ui]")) {
    const marker = element.getAttribute("data-noritrans-ui");
    if (marker && TRANSIENT_UI_MARKERS.has(marker)) stale.add(element);
  }
  for (const element of stale) element.remove();
  return stale.size;
}
