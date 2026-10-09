import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EDGE_REVEAL_SIZE,
  LAUNCHER_SIZE,
  PANEL_MAX_WIDTH,
  VIEWPORT_PADDING,
  alignToEdge,
  clampPosition,
  denormalizePosition,
  edgeHiddenTransform,
  isNormalizedPosition,
  nearestDockEdge,
  normalizePosition,
  panelPlacement,
  pillDirection,
  touchesEdge,
} from "@/src/ui/floating/geometry";
import { PendingActionTracker } from "@/src/ui/floating/pending";
import {
  announcementFor,
  launcherSource,
  tabIndicator,
  withLocalPending,
} from "@/src/ui/floating/view";
import { pageStatusView, subtitleStatusView } from "@/src/ui/status";

vi.mock("@/src/shared/i18n", () => ({
  currentUiLocale: () => "en",
  message: (key: string, subs?: string | string[]) =>
    subs && subs.length > 0 ? `${key}(${[subs].flat().join(",")})` : key,
}));

const viewport = { width: 1000, height: 800 };
const maxLeft = viewport.width - LAUNCHER_SIZE - VIEWPORT_PADDING;
const maxTop = viewport.height - LAUNCHER_SIZE - VIEWPORT_PADDING;

describe("floating geometry", () => {
  it("clamps the launcher inside the padded viewport", () => {
    expect(clampPosition({ left: -50, top: 9999 }, viewport)).toEqual({
      left: VIEWPORT_PADDING,
      top: maxTop,
    });
    expect(clampPosition({ left: 300.4, top: 200.6 }, viewport)).toEqual({
      left: 300,
      top: 201,
    });
  });

  it("docks only within the threshold and aligns to the nearest edge", () => {
    expect(nearestDockEdge({ left: 400, top: 400 }, viewport)).toBeUndefined();
    expect(nearestDockEdge({ left: maxLeft - 20, top: 400 }, viewport)).toBe(
      "right",
    );
    expect(nearestDockEdge({ left: 400, top: 30 }, viewport)).toBe("top");
    expect(alignToEdge({ left: 900, top: 400 }, "right", viewport)).toEqual({
      left: maxLeft,
      top: 400,
    });
    expect(touchesEdge({ left: maxLeft, top: 400 }, viewport)).toBe(true);
    expect(touchesEdge({ left: 400, top: 400 }, viewport)).toBe(false);
  });

  it("round-trips normalized positions and validates stored values", () => {
    const point = { left: 400, top: 300 };
    const normalized = normalizePosition(point, viewport);
    expect(normalized.x).toBeGreaterThan(0);
    expect(normalized.x).toBeLessThan(1);
    expect(denormalizePosition(normalized, viewport)).toEqual(point);
    // Rescales to a different viewport proportionally.
    expect(
      denormalizePosition({ x: 1, y: 0 }, { width: 400, height: 300 }),
    ).toEqual({ left: 400 - LAUNCHER_SIZE - VIEWPORT_PADDING, top: 10 });
    expect(isNormalizedPosition({ x: 0.2, y: 1 })).toBe(true);
    expect(isNormalizedPosition({ x: 1.2, y: 0 })).toBe(false);
    expect(isNormalizedPosition({ x: Number.NaN, y: 0 })).toBe(false);
    expect(isNormalizedPosition(undefined)).toBe(false);
  });

  it("keeps half the launcher visible when tucked", () => {
    expect(EDGE_REVEAL_SIZE).toBe(LAUNCHER_SIZE / 2);
    expect(edgeHiddenTransform("left")).toBe("translateX(-34px)");
    expect(edgeHiddenTransform("right")).toBe("translateX(34px)");
    expect(edgeHiddenTransform("top")).toBe("translateY(-34px)");
    expect(edgeHiddenTransform("bottom")).toBe("translateY(34px)");
  });

  it("places the panel inside the viewport and flips near the bottom", () => {
    const below = panelPlacement(
      { left: 900, top: 20, right: 948, bottom: 68 },
      400,
      viewport,
    );
    expect(below).toMatchObject({ width: PANEL_MAX_WIDTH, openUp: false });
    // Right-aligned with the launcher.
    expect(900 + below.left + below.width).toBe(948);

    const above = panelPlacement(
      { left: 900, top: 700, right: 948, bottom: 748 },
      400,
      viewport,
    );
    expect(above.openUp).toBe(true);
    expect(above.maxHeight).toBe(700 - VIEWPORT_PADDING - 8);

    // A launcher at the left edge never pushes the panel off screen.
    const left = panelPlacement(
      { left: 10, top: 20, right: 58, bottom: 68 },
      300,
      viewport,
    );
    expect(10 + left.left).toBe(VIEWPORT_PADDING);
  });

  it("fits 375px and shrinks below the panel width", () => {
    const at375 = panelPlacement(
      { left: 317, top: 20, right: 365, bottom: 68 },
      300,
      { width: 375, height: 700 },
    );
    expect(at375.width).toBe(PANEL_MAX_WIDTH);
    expect(317 + at375.left + at375.width).toBeLessThanOrEqual(
      375 - VIEWPORT_PADDING,
    );
    const at320 = panelPlacement(
      { left: 262, top: 20, right: 310, bottom: 68 },
      300,
      { width: 320, height: 700 },
    );
    expect(at320.width).toBe(320 - VIEWPORT_PADDING * 2);
    expect(262 + at320.left).toBe(VIEWPORT_PADDING);
  });

  it("grows the pill away from the nearer horizontal edge", () => {
    expect(pillDirection(20, viewport)).toBe("end");
    expect(pillDirection(900, viewport)).toBe("start");
  });
});

describe("PendingActionTracker", () => {
  afterEach(() => vi.useRealTimers());

  it("stays pending after resolve until the status moves", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const tracker = new PendingActionTracker(onChange, 1000);
    const result = await tracker.run(
      { id: "translate", label: "starting", baseline: "idle" },
      () => undefined,
    );
    expect(result).toBe("done");
    expect(tracker.current?.id).toBe("translate");
    tracker.observe("idle");
    expect(tracker.current).toBeDefined();
    tracker.observe("scanning");
    expect(tracker.current).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("ends after the grace period when no status arrives", async () => {
    vi.useFakeTimers();
    const tracker = new PendingActionTracker(() => undefined, 1000);
    await tracker.run({ id: "stop", baseline: "translating" }, () => undefined);
    vi.advanceTimersByTime(999);
    expect(tracker.current).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(tracker.current).toBeUndefined();
  });

  it("ends at once on failure and rejects concurrent runs", async () => {
    const tracker = new PendingActionTracker(() => undefined);
    let release: () => void = () => undefined;
    const first = tracker.run(
      { id: "retry", baseline: "partial" },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(
      await tracker.run(
        { id: "restore", baseline: "partial" },
        () => undefined,
      ),
    ).toBe("busy");
    release();
    await first;
    tracker.dispose();
    expect(
      await tracker.run({ id: "retry", baseline: "partial" }, () => {
        throw new Error("x");
      }),
    ).toBe("failed");
    expect(tracker.current).toBeUndefined();
  });
});

describe("floating view helpers", () => {
  const page = (state: "idle" | "translating" | "translated" | "partial") =>
    pageStatusView({
      state,
      total: 10,
      completed: state === "partial" ? 8 : 4,
      failed: state === "partial" ? 2 : 0,
    });
  const video = subtitleStatusView({
    state: "unavailable",
    total: 0,
    completed: 0,
    failed: 0,
  });

  it("speaks for the only running task, else attention, else preferred", () => {
    expect(launcherSource({ page: page("translating"), video }, "video")).toBe(
      "page",
    );
    // Both quiet: the preferred tab.
    expect(launcherSource({ page: page("idle"), video }, "video")).toBe(
      "video",
    );
    // Preferred tab quiet, the other finished: the other one.
    expect(launcherSource({ page: page("partial"), video }, "video")).toBe(
      "page",
    );
  });

  it("announces outcomes only", () => {
    expect(announcementFor(page("translating"))).toBe("");
    expect(announcementFor(page("translated"))).toBe(
      "statusTitleReadyPage(10)",
    );
    expect(announcementFor(page("partial"))).toContain(
      "statusTitlePartialPage",
    );
  });

  it("maps states to tab dots", () => {
    expect(tabIndicator(page("translating"))).toBe("run");
    expect(tabIndicator(page("partial"))).toBe("warn");
    expect(tabIndicator(page("idle"))).toBe("none");
  });

  it("freezes all actions while a label-less request runs", () => {
    const view = withLocalPending(page("partial"), "restore");
    expect(view.primaryAction).toMatchObject({ id: "retry", disabled: true });
    expect(view.secondaryActions[0]).toMatchObject({
      id: "restore",
      busy: true,
      disabled: true,
    });
  });
});
