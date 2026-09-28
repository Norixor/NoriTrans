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

const selectorValidity = new Map<string, boolean>();

function isValidSelector(selector: string): boolean {
  const known = selectorValidity.get(selector);
  if (known !== undefined) return known;
  let valid = true;
  try {
    // An empty fragment validates syntax without scanning the document.
    document.createDocumentFragment().querySelector(selector);
  } catch {
    valid = false;
  }
  selectorValidity.set(selector, valid);
  return valid;
}

/**
 * Decides whether a mutation batch can affect a caption. Runs for every page
 * mutation batch, so it avoids subtree queries except where a change can
 * genuinely reach a caption: nodes entering or leaving the tree, and
 * visibility attributes on an ancestor of a caption.
 */
export function mutationTouchesCaptionSelector(
  records: readonly MutationRecord[],
  selector: string,
): boolean {
  if (!isValidSelector(selector)) return false;
  const insideCaption = (node: Node): boolean => {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest(selector) != null;
  };
  const containsCaption = (node: Node): boolean =>
    node instanceof Element &&
    (node.matches(selector) || node.querySelector(selector) !== null);
  const checkedTargets = new Set<Node>();
  const checkedAttributeTargets = new Set<Node>();
  return records.some((record) => {
    const { target } = record;
    if (!checkedTargets.has(target)) {
      checkedTargets.add(target);
      if (insideCaption(target)) return true;
    }
    if (record.type === "attributes" && !checkedAttributeTargets.has(target)) {
      checkedAttributeTargets.add(target);
      if (containsCaption(target)) return true;
    }
    return [...record.addedNodes, ...record.removedNodes].some(
      (node) => insideCaption(node) || containsCaption(node),
    );
  });
}
