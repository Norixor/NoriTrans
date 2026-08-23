import { orderedVideos } from "@/src/subtitles/video-selection";

const MINIMUM_TARGET_WIDTH = 160;
const MINIMUM_TARGET_HEIGHT = 90;
const MINIMUM_VIEWPORT_AREA_RATIO = 0.01;

function visibleArea(element: HTMLElement): number {
  let current: HTMLElement | null = element;
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
      return 0;
    }
    current = current.parentElement;
  }
  const rect = element.getBoundingClientRect();
  if (
    rect.width < MINIMUM_TARGET_WIDTH ||
    rect.height < MINIMUM_TARGET_HEIGHT
  ) {
    return 0;
  }
  const width = Math.max(
    0,
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
  );
  const height = Math.max(
    0,
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
  );
  const area = width * height;
  return area >=
    window.innerWidth * window.innerHeight * MINIMUM_VIEWPORT_AREA_RATIO
    ? area
    : 0;
}

function nonVideoScore(element: HTMLCanvasElement | HTMLIFrameElement): number {
  const area = visibleArea(element);
  if (area === 0) return 0;
  const fullscreen = document.fullscreenElement;
  if (fullscreen === element || fullscreen?.contains(element))
    return 4e12 + area;
  const source = element instanceof HTMLIFrameElement ? element.src : "";
  const knownPlayer =
    /(?:player|video|tvideo|libcocos|media)/iu.test(source) ||
    /(?:player|video|media)/iu.test(`${element.id} ${element.className}`);
  return (knownPlayer ? 3e12 : 1e12) + area;
}

function videoTargetScore(video: HTMLVideoElement): number {
  if (ocrMediaTargetIsPictureInPicture(video)) return 6e12;
  const area = visibleArea(video);
  if (area === 0) return 0;
  const fullscreen = document.fullscreenElement;
  if (fullscreen === video || fullscreen?.contains(video)) return 5e12 + area;
  return (!video.paused && !video.ended ? 2e12 : 1.5e12) + area;
}

export function ocrMediaTargetIsPictureInPicture(target: HTMLElement): boolean {
  return (
    target instanceof HTMLVideoElement &&
    (document as Document & { pictureInPictureElement?: Element | null })
      .pictureInPictureElement === target
  );
}

/**
 * Finds the visible pixels the OCR selector should be constrained to. HTML5
 * video remains preferred; large player canvases and cross-origin player
 * iframes cover sites such as Tencent Video where no top-frame video exists.
 */
export function selectOcrMediaTarget(): HTMLElement | null {
  const candidates: Array<{
    element: HTMLElement;
    index: number;
    score: number;
  }> = orderedVideos().map((element, index) => ({
    element,
    index,
    score: videoTargetScore(element),
  }));
  candidates.push(
    ...Array.from(
      document.querySelectorAll<HTMLCanvasElement | HTMLIFrameElement>(
        "canvas,iframe",
      ),
    )
      .filter(
        (element) =>
          !element.closest("[data-norixortrans-ui]") &&
          !element.closest("norixor-floating-control"),
      )
      .map((element, index) => ({
        element,
        index: candidates.length + index,
        score: nonVideoScore(element),
      })),
  );
  return (
    candidates
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) => right.score - left.score || left.index - right.index,
      )[0]?.element ?? null
  );
}

export function ocrMediaTargetIsCurrent(target: HTMLElement): boolean {
  if (!target.isConnected || visibleArea(target) === 0) return false;
  return selectOcrMediaTarget() === target;
}

export function ocrMediaTargetSource(target: HTMLElement): string {
  if (target instanceof HTMLVideoElement) {
    return target.currentSrc || target.src || "video:inline";
  }
  if (target instanceof HTMLIFrameElement) {
    return target.src || "iframe:inline";
  }
  const identity = target.id
    ? `id:${target.id}`
    : `index:${Array.from(document.querySelectorAll(target.tagName)).indexOf(target)}`;
  return `${target.tagName.toLowerCase()}:${identity}`;
}
