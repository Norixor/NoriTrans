import {
  DRAG_THRESHOLD,
  EDGE_HIDE_DELAY_MS,
  KEYBOARD_MOVE_LARGE_STEP,
  KEYBOARD_MOVE_STEP,
  alignToEdge,
  clampPosition,
  denormalizePosition,
  edgeHiddenTransform,
  isNormalizedPosition,
  nearestDockEdge,
  normalizePosition,
  readViewport,
  touchesEdge,
  type DockedEdge,
  type NormalizedPosition,
  type Point,
} from "./geometry";

/** Same session key as the previous control, so positions carry over. */
export function positionStorageKey(loc: Location = location): string {
  return `noritrans:unified-control:${loc.origin}${loc.pathname}`;
}

export interface PositionSnapshot {
  point?: Point;
  dockedEdge?: DockedEdge;
  edgeHidden: boolean;
  /** Generation at snapshot time; a later move invalidates the snapshot. */
  generation: number;
}

export interface FloatingPositionerOptions {
  /** Applies host declarations with `!important` (InjectedRoot.setHostStyle). */
  setHostStyle(declarations: Readonly<Record<string, string>>): void;
  host: HTMLElement;
  /** Element that starts drags (the launcher). */
  handle: HTMLElement;
  loadPosition?(): Promise<NormalizedPosition | undefined>;
  onPositionChange?(position: NormalizedPosition): Promise<void> | void;
  /** Position, dock or tuck state changed; re-place dependent UI. */
  onLayout(): void;
  /** A drag was released onto an edge: the panel should collapse. */
  onDockedByDrag(): void;
  /** Whether a docked launcher may tuck itself away right now. */
  canTuck(): boolean;
  /** Called right before the launcher tucks away (e.g. to drop focus). */
  beforeTuck(): void;
  win?: Window;
}

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Point;
  moved: boolean;
  before: PositionSnapshot;
}

/**
 * Owns the launcher position: dragging (with pointer capture plus window
 * fallbacks for players and iframes that swallow events), keyboard moves,
 * edge docking with a tucked-away state that keeps a 20px reveal strip,
 * viewport resizes and persistence (sessionStorage per page, plus the
 * caller's normalized `loadPosition`/`onPositionChange` store).
 *
 * Behaviour mirrors the previous control: a press on a tucked launcher does
 * not reveal it until it actually moves (moving the hit target before
 * `pointerup` would cancel the click on the reveal strip); a click right
 * after a drag is swallowed; Escape-free cancellation (`pointercancel`)
 * restores the position from before the drag.
 */
export class FloatingPositioner {
  private point: Point | undefined;
  private dockedEdge: DockedEdge | undefined;
  private edgeHidden = false;
  private drag: DragState | undefined;
  private suppressClick = false;
  private tuckTimer: ReturnType<typeof setTimeout> | undefined;
  private generationValue = 0;
  private disposed = false;
  private readonly win: Window;

  constructor(private readonly options: FloatingPositionerOptions) {
    this.win = options.win ?? window;
    const { handle } = options;
    handle.addEventListener("pointerdown", this.onPointerDown);
    handle.addEventListener("pointermove", this.onPointerMove);
    handle.addEventListener("pointerup", this.onPointerUp);
    handle.addEventListener("pointercancel", this.onPointerCancel);
    handle.addEventListener("lostpointercapture", this.onLostCapture);
    this.apply();
  }

  /** Increments whenever the user moves the launcher. */
  get generation(): number {
    return this.generationValue;
  }

  get dragging(): boolean {
    return this.drag?.moved === true;
  }

  get docked(): DockedEdge | undefined {
    return this.dockedEdge;
  }

  get tucked(): boolean {
    return this.edgeHidden && this.dockedEdge !== undefined;
  }

  /** Current top-left corner, measured when no explicit position is set. */
  currentPoint(): Point {
    if (this.point) return this.point;
    const rect = this.options.host.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  }

  /** Restores the session position, then the persisted one (async). */
  async restore(): Promise<void> {
    this.restoreSessionPosition();
    await this.restorePersistedPosition();
  }

  /** Returns true (once) when a click must be ignored because it ended a drag. */
  consumeClickSuppression(): boolean {
    const suppressed = this.suppressClick;
    this.suppressClick = false;
    return suppressed;
  }

  /** Arrow-key move by one step (`large`: Shift held). */
  moveBy(direction: { x: number; y: number }, large: boolean): void {
    this.generationValue += 1;
    this.reveal();
    const step = large ? KEYBOARD_MOVE_LARGE_STEP : KEYBOARD_MOVE_STEP;
    const from = this.currentPoint();
    const viewport = readViewport(this.win);
    this.dockedEdge = undefined;
    this.point = clampPosition(
      {
        left: from.left + direction.x * step,
        top: from.top + direction.y * step,
      },
      viewport,
    );
    // Keyboard moves dock but never tuck: focus stays on the launcher.
    if (touchesEdge(this.point, viewport)) this.dockNearby(false);
    this.apply();
    this.save();
  }

  /** Cancels a pending tuck and brings a docked launcher fully into view. */
  reveal(): void {
    this.clearTuckTimer();
    if (!this.edgeHidden) return;
    this.edgeHidden = false;
    this.apply();
  }

  /** Tucks a docked launcher away after a short delay (pointer left it). */
  scheduleTuck(): void {
    if (!this.dockedEdge || !this.options.canTuck() || this.drag) return;
    this.clearTuckTimer();
    this.tuckTimer = setTimeout(() => {
      this.tuckTimer = undefined;
      this.tuckNow();
    }, EDGE_HIDE_DELAY_MS);
  }

  /** Tucks immediately when docked and allowed. */
  tuckNow(): void {
    if (!this.dockedEdge || !this.options.canTuck() || this.edgeHidden) return;
    this.options.beforeTuck();
    this.edgeHidden = true;
    this.apply();
  }

  /** Re-clamps after a viewport change; persists unless told otherwise. */
  handleResize(persist: boolean): void {
    if (!this.point) {
      this.options.onLayout();
      return;
    }
    const viewport = readViewport(this.win);
    const edge = this.dockedEdge;
    this.point = edge
      ? alignToEdge(this.point, edge, viewport)
      : clampPosition(this.point, viewport);
    if (!edge) this.dockNearby(false);
    this.apply();
    if (persist) this.save();
  }

  snapshot(): PositionSnapshot {
    return {
      ...(this.point ? { point: { ...this.point } } : {}),
      ...(this.dockedEdge ? { dockedEdge: this.dockedEdge } : {}),
      edgeHidden: this.edgeHidden,
      generation: this.generationValue,
    };
  }

  /**
   * Puts the launcher back where a snapshot was taken. Ignored (apart from a
   * re-clamp) when the user moved the launcher since then.
   */
  restoreSnapshot(snapshot: PositionSnapshot): void {
    if (snapshot.generation !== this.generationValue) {
      this.handleResize(false);
      return;
    }
    this.point = snapshot.point ? { ...snapshot.point } : undefined;
    this.dockedEdge = snapshot.dockedEdge;
    this.edgeHidden = false;
    this.handleResize(false);
    if (snapshot.edgeHidden && this.dockedEdge && this.options.canTuck()) {
      this.tuckNow();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finishDrag("commit");
    this.clearTuckTimer();
    const { handle } = this.options;
    handle.removeEventListener("pointerdown", this.onPointerDown);
    handle.removeEventListener("pointermove", this.onPointerMove);
    handle.removeEventListener("pointerup", this.onPointerUp);
    handle.removeEventListener("pointercancel", this.onPointerCancel);
    handle.removeEventListener("lostpointercapture", this.onLostCapture);
  }

  private clearTuckTimer(): void {
    if (this.tuckTimer !== undefined) {
      clearTimeout(this.tuckTimer);
      this.tuckTimer = undefined;
    }
  }

  private apply(): void {
    const style: Record<string, string> = this.point
      ? {
          left: `${this.point.left}px`,
          top: `${this.point.top}px`,
          right: "auto",
          bottom: "auto",
        }
      : {
          left: "auto",
          top: "auto",
          right: "max(16px, env(safe-area-inset-right))",
          bottom: "max(16px, env(safe-area-inset-bottom))",
        };
    style.transform =
      this.edgeHidden && this.dockedEdge
        ? edgeHiddenTransform(this.dockedEdge)
        : "";
    this.options.setHostStyle(style);
    const { host } = this.options;
    if (this.dockedEdge) host.dataset.dockedEdge = this.dockedEdge;
    else delete host.dataset.dockedEdge;
    host.dataset.edgeHidden = String(this.tucked);
    if (this.dragging) host.dataset.dragging = "true";
    else delete host.dataset.dragging;
    this.options.onLayout();
  }

  /** Docks to an edge within the threshold; optionally tucks right away. */
  private dockNearby(tuck: boolean): boolean {
    if (!this.point) return false;
    const viewport = readViewport(this.win);
    const edge = nearestDockEdge(this.point, viewport);
    if (!edge) {
      this.dockedEdge = undefined;
      this.edgeHidden = false;
      return false;
    }
    this.point = alignToEdge(this.point, edge, viewport);
    this.dockedEdge = edge;
    if (tuck) {
      this.options.beforeTuck();
      this.edgeHidden = true;
    }
    return true;
  }

  private save(): void {
    if (!this.point) return;
    try {
      this.win.sessionStorage.setItem(
        positionStorageKey(this.win.location),
        JSON.stringify(this.point),
      );
    } catch {
      // Optional; restricted pages may reject sessionStorage.
    }
    if (!this.options.onPositionChange) return;
    const normalized = normalizePosition(this.point, readViewport(this.win));
    void Promise.resolve()
      .then(() => this.options.onPositionChange?.(normalized))
      .catch(() => undefined);
  }

  private restoreSessionPosition(): void {
    try {
      const stored = this.win.sessionStorage.getItem(
        positionStorageKey(this.win.location),
      );
      if (!stored) return;
      const value: unknown = JSON.parse(stored);
      if (typeof value !== "object" || value === null) return;
      const { left, top } = value as Partial<Point>;
      if (
        typeof left !== "number" ||
        !Number.isFinite(left) ||
        typeof top !== "number" ||
        !Number.isFinite(top)
      ) {
        return;
      }
      this.point = clampPosition({ left, top }, readViewport(this.win));
      this.dockNearby(this.options.canTuck());
      this.apply();
    } catch {
      // Restricted pages may reject sessionStorage; defaults stay usable.
    }
  }

  private async restorePersistedPosition(): Promise<void> {
    if (!this.options.loadPosition) return;
    const generation = this.generationValue;
    try {
      const position = await this.options.loadPosition();
      if (
        this.disposed ||
        generation !== this.generationValue ||
        !isNormalizedPosition(position)
      ) {
        return;
      }
      this.point = denormalizePosition(position, readViewport(this.win));
      this.dockNearby(this.options.canTuck());
      this.apply();
    } catch {
      // A persisted-position failure must not disable the controls.
    }
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || event.isPrimary === false || this.drag) return;
    this.generationValue += 1;
    // A tucked launcher keeps its layout position: revealing it here would
    // move the hit target before pointerup and cancel the click.
    this.drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: this.currentPoint(),
      moved: false,
      before: this.snapshot(),
    };
    this.addWindowListeners();
    try {
      this.options.handle.setPointerCapture?.(event.pointerId);
    } catch {
      // Window listeners keep the drag controllable without capture.
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      this.clearTuckTimer();
      this.edgeHidden = false;
    }
    event.preventDefault();
    this.dockedEdge = undefined;
    this.point = clampPosition(
      { left: drag.origin.left + dx, top: drag.origin.top + dy },
      readViewport(this.win),
    );
    this.apply();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.drag?.pointerId === event.pointerId) this.finishDrag("commit");
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.drag?.pointerId === event.pointerId) this.finishDrag("restore");
  };

  private readonly onLostCapture = (event: PointerEvent): void => {
    if (this.drag?.pointerId === event.pointerId) this.finishDrag("commit");
  };

  /** The pointer left into an iframe (or out of the window) mid-drag. */
  private readonly onPointerOut = (event: PointerEvent): void => {
    if (this.drag?.pointerId !== event.pointerId) return;
    const related = event.relatedTarget;
    if (related !== null && !(related instanceof HTMLIFrameElement)) return;
    this.finishDrag("commit");
  };

  private readonly onWindowBlur = (): void => {
    this.finishDrag("commit");
  };

  private addWindowListeners(): void {
    this.win.addEventListener("pointermove", this.onPointerMove);
    this.win.addEventListener("pointerup", this.onPointerUp);
    this.win.addEventListener("pointercancel", this.onPointerCancel);
    this.win.addEventListener("pointerout", this.onPointerOut);
    this.win.addEventListener("blur", this.onWindowBlur);
  }

  private removeWindowListeners(): void {
    this.win.removeEventListener("pointermove", this.onPointerMove);
    this.win.removeEventListener("pointerup", this.onPointerUp);
    this.win.removeEventListener("pointercancel", this.onPointerCancel);
    this.win.removeEventListener("pointerout", this.onPointerOut);
    this.win.removeEventListener("blur", this.onWindowBlur);
  }

  private finishDrag(outcome: "commit" | "restore"): void {
    const drag = this.drag;
    if (!drag) return;
    // Cleared first: releasePointerCapture can synchronously dispatch
    // lostpointercapture in some browser/player combinations.
    this.drag = undefined;
    try {
      if (this.options.handle.hasPointerCapture?.(drag.pointerId)) {
        this.options.handle.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Capture may already be gone at an iframe boundary.
    }
    this.removeWindowListeners();
    if (!drag.moved) return;
    if (outcome === "restore") {
      this.point = drag.before.point;
      this.dockedEdge = drag.before.dockedEdge;
      this.edgeHidden = drag.before.edgeHidden;
      this.apply();
      return;
    }
    this.suppressClick = true;
    setTimeout(() => {
      this.suppressClick = false;
    }, 0);
    const docked = this.dockNearby(false);
    this.apply();
    this.save();
    if (!docked) return;
    // Collapse first: a docked launcher only tucks away while collapsed.
    this.options.onDockedByDrag();
    this.tuckNow();
  }
}
