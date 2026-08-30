const EXTENSION_HIDES_NATIVE_ATTRIBUTE = "data-noritrans-hide-native-subtitles";

interface CaptionVisibilityStyle {
  display: string;
  visibility: string;
  opacity: string;
}

function styleSnapshot(element: HTMLElement): CaptionVisibilityStyle {
  const style = getComputedStyle(element);
  return {
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
  };
}

function captionComputedStyle(element: HTMLElement): CaptionVisibilityStyle {
  const root = document.documentElement;
  if (!root.hasAttribute(EXTENSION_HIDES_NATIVE_ATTRIBUTE)) {
    return styleSnapshot(element);
  }

  // NativeSubtitleVisibility hides the website cue with an !important rule.
  // Remove only our root flag for one synchronous style read so the adapter
  // can still distinguish a cue hidden by the website itself. The flag is
  // restored before the browser can paint, so the native subtitle never
  // flashes on screen.
  root.removeAttribute(EXTENSION_HIDES_NATIVE_ATTRIBUTE);
  try {
    return styleSnapshot(element);
  } finally {
    root.setAttribute(EXTENSION_HIDES_NATIVE_ATTRIBUTE, "");
  }
}

export function visibleCaptionText(element: HTMLElement): string {
  if (
    element.hidden ||
    element.closest('[hidden],[aria-hidden="true"]') ||
    element.getAttribute("aria-hidden") === "true"
  ) {
    return "";
  }
  const style = captionComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    Number(style.opacity) === 0
  ) {
    return "";
  }
  return (element.innerText || element.textContent || "").trim();
}

export function mutationTouchesCaptionSelector(
  records: readonly MutationRecord[],
  selector: string,
): boolean {
  const touches = (node: Node): boolean => {
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return false;
    return (
      element.matches(selector) ||
      element.closest(selector) !== null ||
      element.querySelector(selector) !== null
    );
  };
  try {
    document.querySelector(selector);
  } catch {
    return false;
  }
  return records.some((record) => {
    return (
      touches(record.target) ||
      [...record.addedNodes, ...record.removedNodes].some(touches)
    );
  });
}
