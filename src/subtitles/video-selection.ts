function visibleVideoArea(video: HTMLVideoElement): number {
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
      return 0;
    }
    current = current.parentElement;
  }
  const rect = video.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const width = Math.max(
    0,
    Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0),
  );
  const height = Math.max(
    0,
    Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0),
  );
  return width * height;
}

function videoScore(
  video: HTMLVideoElement,
  preferred: HTMLVideoElement | null,
): number {
  const fullscreen = document.fullscreenElement;
  const pictureInPicture = (
    document as Document & { pictureInPictureElement?: Element | null }
  ).pictureInPictureElement;
  if (fullscreen === video || fullscreen?.contains(video)) return 4e12;
  if (pictureInPicture === video) return 3e12;
  const visibleArea = visibleVideoArea(video);
  if (visibleArea > 0) {
    const playing = !video.paused && !video.ended;
    const activationBonus = playing && video === preferred ? 1e11 : 0;
    return (playing ? 2e12 : 1e12) + activationBonus + visibleArea;
  }
  return !video.paused && !video.ended ? 1 : 0;
}

export function orderedVideos(
  selector = "video",
  preferred: HTMLVideoElement | null = null,
): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll<HTMLVideoElement>(selector))
    .map((video, index) => ({
      video,
      index,
      score: videoScore(video, preferred),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ video }) => video);
}

export function selectActiveVideo(
  selector = "video",
  preferred: HTMLVideoElement | null = null,
): HTMLVideoElement | null {
  return orderedVideos(selector, preferred)[0] ?? null;
}

function rectangleDistance(left: DOMRect, right: DOMRect): number | null {
  if (
    left.width <= 0 ||
    left.height <= 0 ||
    right.width <= 0 ||
    right.height <= 0
  ) {
    return null;
  }
  const horizontal = Math.max(
    0,
    left.left - right.right,
    right.left - left.right,
  );
  const vertical = Math.max(
    0,
    left.top - right.bottom,
    right.top - left.bottom,
  );
  return horizontal * horizontal + vertical * vertical;
}

/**
 * Keeps DOM captions owned by the selected player. A single-video page retains
 * the broad fallback, while multi-video pages require either a unique shared
 * player scope or an unambiguous geometric match.
 */
export function captionsForVideo<T extends HTMLElement>(
  elements: T[],
  video: HTMLVideoElement | null,
  videoSelector = "video",
): T[] {
  if (!video) return [];
  let videos: HTMLVideoElement[];
  try {
    videos = Array.from(
      document.querySelectorAll<HTMLVideoElement>(videoSelector),
    );
  } catch {
    return [];
  }
  if (videos.length <= 1) return elements;

  return elements.filter((element) => {
    let scope: HTMLElement | null = element;
    while (
      scope &&
      scope !== document.body &&
      scope !== document.documentElement
    ) {
      const scopedVideos = videos.filter((candidate) =>
        scope?.contains(candidate),
      );
      if (scopedVideos.length === 1) return scopedVideos[0] === video;
      if (scopedVideos.length > 1) break;
      scope = scope.parentElement;
    }

    const elementRect = element.getBoundingClientRect();
    const relevantVideos = videos.filter(
      (candidate) => candidate === video || visibleVideoArea(candidate) > 0,
    );
    const distances = relevantVideos.flatMap((candidate) => {
      const distance = rectangleDistance(
        elementRect,
        candidate.getBoundingClientRect(),
      );
      return distance === null ? [] : [{ candidate, distance }];
    });
    if (distances.length === 0) return false;
    const closestDistance = Math.min(
      ...distances.map(({ distance }) => distance),
    );
    const closest = distances.filter(
      ({ distance }) => distance === closestDistance,
    );
    return closest.length === 1 && closest[0]?.candidate === video;
  });
}

const videoIdentities = new WeakMap<HTMLVideoElement, number>();
const videoMediaSources = new WeakMap<HTMLVideoElement, string>();
let nextVideoIdentity = 0;

function stableSiteMediaSource(pageUrl: string): string | undefined {
  try {
    const url = new URL(pageUrl);
    if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/iu.test(url.hostname)) {
      const id =
        url.searchParams.get("v") ??
        /^\/(?:shorts|embed)\/([^/?#]+)/u.exec(url.pathname)?.[1];
      if (id) return `youtube:${id}`;
    }
    if (/(^|\.)netflix\.com$/iu.test(url.hostname)) {
      const id = /^\/watch\/([^/?#]+)/u.exec(url.pathname)?.[1];
      if (id) return `netflix:${id}`;
    }
    if (/(^|\.)v\.qq\.com$/iu.test(url.hostname)) {
      return `tencent:${url.pathname}`;
    }
  } catch {
    // Invalid page URLs safely fall back to the media element source.
  }
  return undefined;
}

function stableElementMediaSource(video: HTMLVideoElement): string {
  const raw = video.currentSrc || video.src;
  if (!raw) return videoMediaSources.get(video) ?? "inline";
  let source: string;
  try {
    const url = new URL(raw, location.href);
    if (url.protocol === "blob:") {
      source = url.href;
      videoMediaSources.set(video, source);
      return source;
    }
    if (url.protocol === "data:") {
      let hash = 2_166_136_261;
      for (let index = 0; index < raw.length; index += 1) {
        hash ^= raw.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
      }
      source = `data:fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
      videoMediaSources.set(video, source);
      return source;
    }
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (
        /^(?:e|exp|expire|expires|hdnea|policy|signature|sig|token|auth|key-pair-id|x-amz-)/iu.test(
          key,
        )
      ) {
        url.searchParams.delete(key);
      }
    }
    source = url.href;
  } catch {
    source = raw;
  }
  videoMediaSources.set(video, source);
  return source;
}

export function stableVideoScope(
  video: HTMLVideoElement | null,
  pageUrl = location.href,
): string {
  if (!video) return "video:none";
  const videos = Array.from(document.querySelectorAll("video"));
  const source =
    stableSiteMediaSource(pageUrl) || stableElementMediaSource(video);
  const identity = video.id
    ? `id:${video.id}`
    : `index:${videos.indexOf(video)}`;
  return `${source}|${identity}`;
}

/**
 * Cross-world identity for captured subtitle responses. Site page identities
 * are stable across signed URL refreshes, while the normalized element source
 * prevents a late response from an earlier episode/media item being accepted
 * after a same-page player switch.
 */
export function stableVideoCaptureScope(
  video: HTMLVideoElement | null,
  pageUrl = location.href,
): string {
  if (!video) return stableVideoScope(video, pageUrl);
  return [
    stableVideoScope(video, pageUrl),
    `element-source:${stableElementMediaSource(video)}`,
  ].join("|");
}

/**
 * Stable identity for persisted full tracks and translations. Known site
 * routes identify the title across player/blob recreation, while unknown
 * pages retain the strict capture scope to avoid restoring another media item.
 */
export function stableVideoPersistenceScope(
  video: HTMLVideoElement | null,
  pageUrl = location.href,
): string {
  if (!video) return stableVideoScope(video, pageUrl);
  const siteSource = stableSiteMediaSource(pageUrl);
  if (!siteSource) return stableVideoCaptureScope(video, pageUrl);
  const videos = Array.from(document.querySelectorAll("video"));
  const identity = video.id
    ? `id:${video.id}`
    : `index:${videos.indexOf(video)}`;
  return `${siteSource}|${identity}`;
}

/** Runtime-only identity for invalidating adapter history when DOM players swap. */
export function videoSessionScope(video: HTMLVideoElement | null): string {
  if (!video) return stableVideoScope(video);
  let instanceIdentity = videoIdentities.get(video);
  if (instanceIdentity === undefined) {
    instanceIdentity = ++nextVideoIdentity;
    videoIdentities.set(video, instanceIdentity);
  }
  return [stableVideoCaptureScope(video), `instance:${instanceIdentity}`].join(
    "|",
  );
}
