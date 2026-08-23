const BLOCKED_REGION_SELECTOR = [
  "[data-norixortrans-ui]",
  "[data-norixor-ui]",
  "norixor-translation",
  "nav",
  "aside",
  "form",
  "button",
  "input",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[aria-haspopup]",
  "[role='button']",
  "[role='dialog']",
  "[role='listbox']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='navigation']",
  "[role='option']",
  "[role='tab']",
  "[role='tablist']",
  "[role='toolbar']",
].join(",");

const INTERACTIVE_DESCENDANT_SELECTOR = [
  "button",
  "input",
  "select",
  "textarea",
  "[aria-haspopup]",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
  "[role='tab']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const PLAYER_CHROME_HINT =
  /(?:^|[-_])(control|controls|dialog|episode|language|menu|option|panel|playlist|popover|popup|quality|recommend|resolution|setting|settings|sidebar|speed|toolbar|volume)(?:$|[-_])/iu;

export const MAX_DOM_CAPTION_CHARACTERS = 500;
const MAX_DOM_CAPTION_LINES = 4;

function elementHasPlayerChromeHint(element: Element): boolean {
  const values = [element.id, ...element.classList];
  return values.some((value) => PLAYER_CHROME_HINT.test(value));
}

export function isExcludedDomCaptionElement(element: Element): boolean {
  if (element.closest(BLOCKED_REGION_SELECTOR)) return true;
  if (element.querySelector(INTERACTIVE_DESCENDANT_SELECTOR)) return true;
  let current: Element | null = element;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (elementHasPlayerChromeHint(current)) return true;
    if (current instanceof HTMLVideoElement) break;
    current = current.parentElement;
  }
  return false;
}

export function normalizedDomCaptionText(text: string): string {
  const lines = text
    .split(/[\r\n]+/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean);
  if (lines.length === 0 || lines.length > MAX_DOM_CAPTION_LINES) return "";
  const normalized = lines.join(" ").trim();
  if (
    normalized.length < 2 ||
    normalized.length > MAX_DOM_CAPTION_CHARACTERS ||
    /^[\d\s.,%$€¥£+\-*/=()[\]{}:;]+$/u.test(normalized)
  ) {
    return "";
  }
  return normalized;
}

export function isWithinVideoCaptionArea(
  element: Element,
  video: HTMLVideoElement,
): boolean {
  const elementRect = element.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();
  if (elementRect.width <= 0 || elementRect.height <= 0) return false;
  if (videoRect.width <= 0 || videoRect.height <= 0) return false;
  let current: HTMLElement | null = video;
  while (current) {
    const style = getComputedStyle(current);
    if (
      current.hidden ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    current = current.parentElement;
  }
  if (
    elementRect.width > videoRect.width * 1.1 ||
    elementRect.height > Math.max(120, videoRect.height * 0.4)
  ) {
    return false;
  }
  const overlapWidth = Math.max(
    0,
    Math.min(elementRect.right, videoRect.right) -
      Math.max(elementRect.left, videoRect.left),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(elementRect.bottom, videoRect.bottom) -
      Math.max(elementRect.top, videoRect.top),
  );
  const elementArea = elementRect.width * elementRect.height;
  return overlapWidth * overlapHeight >= elementArea * 0.6;
}
