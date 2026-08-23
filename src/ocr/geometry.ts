import type { NormalizedOcrRegion } from "@/src/ocr/types";

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeOcrSelection(
  start: ScreenPoint,
  end: ScreenPoint,
  bounds: ScreenRect,
  viewportWidth: number,
  viewportHeight: number,
): NormalizedOcrRegion | null {
  if (
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    bounds.right <= bounds.left ||
    bounds.bottom <= bounds.top
  ) {
    return null;
  }
  const startX = clamp(start.x, bounds.left, bounds.right);
  const startY = clamp(start.y, bounds.top, bounds.bottom);
  const endX = clamp(end.x, bounds.left, bounds.right);
  const endY = clamp(end.y, bounds.top, bounds.bottom);
  const left = Math.min(startX, endX);
  const top = Math.min(startY, endY);
  const width = Math.abs(endX - startX);
  const height = Math.abs(endY - startY);
  if (width < 20 || height < 12) return null;
  return {
    x: clamp(left / viewportWidth, 0, 1),
    y: clamp(top / viewportHeight, 0, 1),
    width: clamp(width / viewportWidth, 0, 1 - left / viewportWidth),
    height: clamp(height / viewportHeight, 0, 1 - top / viewportHeight),
  };
}

export function suggestedSubtitleRegion(
  bounds: ScreenRect,
  viewportWidth: number,
  viewportHeight: number,
): NormalizedOcrRegion | null {
  const height = bounds.bottom - bounds.top;
  return normalizeOcrSelection(
    {
      x: bounds.left,
      y: bounds.top + height * 0.7,
    },
    {
      x: bounds.right,
      y: bounds.bottom,
    },
    bounds,
    viewportWidth,
    viewportHeight,
  );
}

export function ocrRegionRelativeToBounds(
  region: NormalizedOcrRegion,
  bounds: ScreenRect,
  viewportWidth: number,
  viewportHeight: number,
): NormalizedOcrRegion | null {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0)
    return null;
  const left = region.x * viewportWidth;
  const top = region.y * viewportHeight;
  const right = left + region.width * viewportWidth;
  const bottom = top + region.height * viewportHeight;
  return {
    x: clamp((left - bounds.left) / width, 0, 1),
    y: clamp((top - bounds.top) / height, 0, 1),
    width: clamp((right - left) / width, 0, 1),
    height: clamp((bottom - top) / height, 0, 1),
  };
}

export function projectOcrRegionToViewport(
  region: NormalizedOcrRegion,
  bounds: ScreenRect,
  viewportWidth: number,
  viewportHeight: number,
): NormalizedOcrRegion | null {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  if (width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0)
    return null;
  return normalizeOcrSelection(
    {
      x: bounds.left + region.x * width,
      y: bounds.top + region.y * height,
    },
    {
      x: bounds.left + (region.x + region.width) * width,
      y: bounds.top + (region.y + region.height) * height,
    },
    { left: 0, top: 0, right: viewportWidth, bottom: viewportHeight },
    viewportWidth,
    viewportHeight,
  );
}
