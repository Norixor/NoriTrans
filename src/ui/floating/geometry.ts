/**
 * Pure geometry for the floating control: clamping, edge docking, persisted
 * (normalized) positions and panel placement. No DOM access except
 * `readViewport()`, so the rules can be unit tested.
 *
 * Coordinates are CSS pixels relative to the layout viewport; a position is
 * the top-left corner of the 48px launcher box.
 */

/** Gap kept between the launcher and every viewport edge. */
export const VIEWPORT_PADDING = 10;
/** Launcher hit box (the 44px visual core sits inside it). */
export const LAUNCHER_SIZE = 48;
/**
 * Part of the launcher that stays visible while it is tucked into an edge:
 * exactly half, so the visible half circle can still show the status arc.
 */
export const EDGE_REVEAL_SIZE = LAUNCHER_SIZE / 2;
/** Release within this distance of an edge docks the launcher to it. */
export const EDGE_DOCK_THRESHOLD = 28;
/** Pointer travel before a press turns into a drag. */
export const DRAG_THRESHOLD = 6;
/** Delay before a docked launcher tucks itself away after the pointer left. */
export const EDGE_HIDE_DELAY_MS = 450;
export const KEYBOARD_MOVE_STEP = 8;
export const KEYBOARD_MOVE_LARGE_STEP = 32;
/** Desktop panel width (UI-SYSTEM.md); narrower viewports shrink it. */
export const PANEL_MAX_WIDTH = 336;
/** Space between the launcher and the panel. */
export const PANEL_GAP = 8;
/** Smallest usable panel height before content scrolls. */
export const PANEL_MIN_HEIGHT = 44;

export type DockedEdge = "left" | "right" | "top" | "bottom";

export interface Point {
  left: number;
  top: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** Persisted position: each axis in 0..1 of the usable range. */
export interface NormalizedPosition {
  x: number;
  y: number;
}

/**
 * The smallest positive of the candidate viewport widths/heights. Scrollbars
 * and pinch zoom make `innerWidth`, `clientWidth` and the visual viewport
 * disagree; the smallest keeps the launcher fully inside what is visible.
 */
export function readViewport(win: Window = window): Viewport {
  const pick = (values: readonly (number | undefined)[]): number => {
    const valid = values.filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    );
    return valid.length > 0 ? Math.max(1, Math.min(...valid)) : 1;
  };
  const root = win.document.documentElement as HTMLElement | null;
  return {
    width: pick([win.innerWidth, root?.clientWidth, win.visualViewport?.width]),
    height: pick([
      win.innerHeight,
      root?.clientHeight,
      win.visualViewport?.height,
    ]),
  };
}

function maxLeft(viewport: Viewport): number {
  return Math.max(
    VIEWPORT_PADDING,
    viewport.width - LAUNCHER_SIZE - VIEWPORT_PADDING,
  );
}

function maxTop(viewport: Viewport): number {
  return Math.max(
    VIEWPORT_PADDING,
    viewport.height - LAUNCHER_SIZE - VIEWPORT_PADDING,
  );
}

/** Keeps the launcher fully inside the padded viewport; rounds to pixels. */
export function clampPosition(point: Point, viewport: Viewport): Point {
  return {
    left: Math.round(
      Math.min(maxLeft(viewport), Math.max(VIEWPORT_PADDING, point.left)),
    ),
    top: Math.round(
      Math.min(maxTop(viewport), Math.max(VIEWPORT_PADDING, point.top)),
    ),
  };
}

/** The edge within `threshold` px of `point`, nearest first; else undefined. */
export function nearestDockEdge(
  point: Point,
  viewport: Viewport,
  threshold = EDGE_DOCK_THRESHOLD,
): DockedEdge | undefined {
  const distances: [DockedEdge, number][] = [
    ["left", Math.abs(point.left - VIEWPORT_PADDING)],
    ["right", Math.abs(maxLeft(viewport) - point.left)],
    ["top", Math.abs(point.top - VIEWPORT_PADDING)],
    ["bottom", Math.abs(maxTop(viewport) - point.top)],
  ];
  // Stable sort keeps left/right ahead of top/bottom on ties, as before.
  const nearest = [...distances].sort((a, b) => a[1] - b[1])[0];
  return nearest && nearest[1] <= threshold ? nearest[0] : undefined;
}

/** Moves `point` onto `edge`, keeping the other axis (clamped). */
export function alignToEdge(
  point: Point,
  edge: DockedEdge,
  viewport: Viewport,
): Point {
  return clampPosition(
    {
      left:
        edge === "left"
          ? VIEWPORT_PADDING
          : edge === "right"
            ? maxLeft(viewport)
            : point.left,
      top:
        edge === "top"
          ? VIEWPORT_PADDING
          : edge === "bottom"
            ? maxTop(viewport)
            : point.top,
    },
    viewport,
  );
}

/** True when the clamped point touches any padded edge. */
export function touchesEdge(point: Point, viewport: Viewport): boolean {
  return (
    point.left === VIEWPORT_PADDING ||
    point.left === Math.round(maxLeft(viewport)) ||
    point.top === VIEWPORT_PADDING ||
    point.top === Math.round(maxTop(viewport))
  );
}

export function normalizePosition(
  point: Point,
  viewport: Viewport,
): NormalizedPosition {
  const horizontal = Math.max(
    0,
    viewport.width - LAUNCHER_SIZE - VIEWPORT_PADDING * 2,
  );
  const vertical = Math.max(
    0,
    viewport.height - LAUNCHER_SIZE - VIEWPORT_PADDING * 2,
  );
  const ratio = (value: number, range: number): number =>
    range === 0
      ? 0
      : Math.min(1, Math.max(0, (value - VIEWPORT_PADDING) / range));
  return {
    x: ratio(point.left, horizontal),
    y: ratio(point.top, vertical),
  };
}

export function denormalizePosition(
  position: NormalizedPosition,
  viewport: Viewport,
): Point {
  const horizontal = Math.max(
    0,
    viewport.width - LAUNCHER_SIZE - VIEWPORT_PADDING * 2,
  );
  const vertical = Math.max(
    0,
    viewport.height - LAUNCHER_SIZE - VIEWPORT_PADDING * 2,
  );
  return clampPosition(
    {
      left: VIEWPORT_PADDING + horizontal * position.x,
      top: VIEWPORT_PADDING + vertical * position.y,
    },
    viewport,
  );
}

export function isNormalizedPosition(
  value: unknown,
): value is NormalizedPosition {
  if (typeof value !== "object" || value === null) return false;
  const { x, y } = value as Partial<NormalizedPosition>;
  return (
    typeof x === "number" &&
    Number.isFinite(x) &&
    x >= 0 &&
    x <= 1 &&
    typeof y === "number" &&
    Number.isFinite(y) &&
    y >= 0 &&
    y <= 1
  );
}

/** Translation that tucks a docked launcher into its edge. */
export function edgeHiddenTransform(edge: DockedEdge): string {
  const offset = LAUNCHER_SIZE + VIEWPORT_PADDING - EDGE_REVEAL_SIZE;
  switch (edge) {
    case "left":
      return `translateX(-${offset}px)`;
    case "right":
      return `translateX(${offset}px)`;
    case "top":
      return `translateY(-${offset}px)`;
    case "bottom":
      return `translateY(${offset}px)`;
  }
}

/**
 * The pill announcement grows away from the nearer horizontal edge so it
 * never runs off screen: towards the inline end on the left half.
 */
export function pillDirection(
  left: number,
  viewport: Viewport,
): "end" | "start" {
  return left + LAUNCHER_SIZE / 2 < viewport.width / 2 ? "end" : "start";
}

export function keyboardMoveDirection(
  key: string,
): { x: number; y: number } | undefined {
  switch (key) {
    case "ArrowLeft":
      return { x: -1, y: 0 };
    case "ArrowRight":
      return { x: 1, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -1 };
    case "ArrowDown":
      return { x: 0, y: 1 };
    default:
      return undefined;
  }
}

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PanelPlacement {
  /** Panel width in px. */
  width: number;
  /** Panel left, relative to the launcher box's left edge. */
  left: number;
  /** True when the panel opens above the launcher. */
  openUp: boolean;
  /** Height available on the chosen side. */
  maxHeight: number;
}

/**
 * Places the panel next to the launcher: right-aligned with it and clamped
 * into the viewport horizontally; below it unless there is more room above
 * and the panel would not fit below (flips near the bottom edge).
 */
export function panelPlacement(
  launcher: RectLike,
  panelHeight: number,
  viewport: Viewport,
): PanelPlacement {
  const width = Math.max(
    0,
    Math.min(PANEL_MAX_WIDTH, viewport.width - VIEWPORT_PADDING * 2),
  );
  const maximumLeft = Math.max(
    VIEWPORT_PADDING,
    viewport.width - VIEWPORT_PADDING - width,
  );
  const absoluteLeft = Math.min(
    Math.max(launcher.right - width, VIEWPORT_PADDING),
    maximumLeft,
  );
  const spaceAbove = launcher.top - VIEWPORT_PADDING - PANEL_GAP;
  const spaceBelow =
    viewport.height - launcher.bottom - VIEWPORT_PADDING - PANEL_GAP;
  const openUp = !(spaceBelow >= panelHeight || spaceBelow >= spaceAbove);
  return {
    width: Math.round(width),
    left: Math.round(absoluteLeft - launcher.left),
    openUp,
    maxHeight: Math.max(
      PANEL_MIN_HEIGHT,
      Math.floor(openUp ? spaceAbove : spaceBelow),
    ),
  };
}
