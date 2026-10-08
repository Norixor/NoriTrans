import { DEFAULT_SETTINGS, toContentSettings } from "@/src/shared/settings";
import type { NtPillFab } from "@/src/ui/components";
import {
  FloatingControl,
  type FloatingControlOptions,
} from "@/src/ui/floating";
import type * as CapabilitiesModule from "@/src/translation/provider-capabilities";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: { getMessage: (key: string) => key, getUILanguage: () => "en" },
    runtime: {
      getURL: (path: string) => `chrome-extension://test${path}`,
      sendMessage: vi.fn(),
    },
  },
}));

vi.mock("@/src/shared/i18n", () => ({
  currentUiLocale: () => "en",
  message: (key: string) => key,
}));

vi.mock("@/src/translation/provider-capabilities", async (importOriginal) => {
  const actual = await importOriginal<typeof CapabilitiesModule>();
  return {
    ...actual,
    queryDocumentTranslationCapabilities: vi.fn(
      () => new Promise<never>(() => undefined),
    ),
  };
});

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const STORAGE_KEY = `noritrans:unified-control:${location.origin}${location.pathname}`;
const ORIGINAL_WIDTH = window.innerWidth;
const ORIGINAL_HEIGHT = window.innerHeight;

let control: FloatingControl | undefined;
let fullscreenElement: Element | null = null;

afterEach(() => {
  control?.destroy();
  control = undefined;
  sessionStorage.clear();
  setViewport(ORIGINAL_WIDTH, ORIGINAL_HEIGHT);
  Reflect.deleteProperty(document.documentElement, "clientWidth");
  Reflect.deleteProperty(document, "fullscreenElement");
  fullscreenElement = null;
  vi.restoreAllMocks();
});

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: height,
  });
}

function setFullscreen(element: Element | null): void {
  fullscreenElement = element;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  document.dispatchEvent(new Event("fullscreenchange"));
}

function seedPosition(left: number, top: number): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ left, top }));
}

function create(overrides: Partial<FloatingControlOptions> = {}) {
  control = new FloatingControl({
    settings: toContentSettings(DEFAULT_SETTINGS),
    onPageTranslate: vi.fn(),
    onPageRestore: vi.fn(),
    onAutoTranslateChange: vi.fn(),
    onPageSettingsChange: vi.fn(),
    onPageModeChange: vi.fn(),
    onPageResponseModeChange: vi.fn(),
    onSubtitleSettingsChange: vi.fn(),
    onSubtitleStart: vi.fn(),
    onSubtitleCancel: vi.fn(),
    onCreateProfile: vi.fn(),
    onHideCurrent: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  });
  const host = document.querySelector<HTMLElement>(
    '[data-noritrans-ui="floating-control"]',
  );
  const root = host?.shadowRoot;
  if (!host || !root) throw new Error("missing floating control");
  const fab = root.querySelector<NtPillFab>("nt-pill-fab")!;
  const panel = root.querySelector<HTMLElement>(".panel")!;
  const left = () => host.style.getPropertyValue("left");
  const top = () => host.style.getPropertyValue("top");
  return { host, root, fab, panel, left, top };
}

/** Pins the launcher's measured box; used until a position is set. */
function placeAt(host: HTMLElement, left: number, top: number): void {
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    right: left + 48,
    bottom: top + 48,
    width: 48,
    height: 48,
    toJSON: () => ({}),
  });
}

function pointer(
  target: EventTarget,
  type: string,
  clientX: number,
  clientY: number,
  relatedTarget?: EventTarget | null,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    composed: true,
    button: 0,
    clientX,
    clientY,
    ...(relatedTarget !== undefined ? { relatedTarget } : {}),
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    isPrimary: { value: true },
  });
  target.dispatchEvent(event);
}

function key(target: EventTarget, name: string, shiftKey = false): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: name,
      shiftKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}

describe("FloatingControl launcher dragging", () => {
  it("drags past the threshold, docks, persists and swallows the release click", async () => {
    const onPositionChange = vi.fn();
    const { host, fab, panel, left, top } = create({ onPositionChange });
    placeAt(host, 100, 100);
    fab.click();
    await tick();
    expect(panel.hidden).toBe(false);

    pointer(fab, "pointerdown", 110, 110);
    pointer(fab, "pointermove", 114, 110);
    // Below the drag threshold the launcher keeps its default anchor.
    expect(left()).toBe("auto");
    expect(host.dataset.dragging).toBeUndefined();
    pointer(fab, "pointermove", -100, -100);
    expect(host.dataset.dragging).toBe("true");
    pointer(fab, "pointerup", -100, -100);

    expect(left()).toBe("10px");
    expect(top()).toBe("10px");
    expect(host.style.getPropertyValue("right")).toBe("auto");
    expect(host.style.getPropertyValue("bottom")).toBe("auto");
    expect(host.dataset.dragging).toBeUndefined();
    expect(host.dataset.dockedEdge).toBe("left");
    expect(host.dataset.edgeHidden).toBe("true");
    expect(panel.hidden).toBe(true);

    // The click that ends a drag does not toggle the panel.
    fab.click();
    await tick();
    expect(panel.hidden).toBe(true);
    fab.click();
    await tick();
    expect(panel.hidden).toBe(false);
    expect(host.dataset.edgeHidden).toBe("false");

    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      left: 10,
      top: 10,
    });
    expect(onPositionChange).toHaveBeenCalledWith({ x: 0, y: 0 });

    control!.destroy();
    const restored = create();
    expect(restored.left()).toBe("10px");
    expect(restored.top()).toBe("10px");
  });

  it.each([
    { edge: "left", x: -100, y: 320, property: "left", expected: "10px" },
    { edge: "top", x: 320, y: -100, property: "top", expected: "10px" },
    {
      edge: "right",
      x: ORIGINAL_WIDTH + 100,
      y: 320,
      property: "left",
      expected: `${ORIGINAL_WIDTH - 58}px`,
    },
    {
      edge: "bottom",
      x: 320,
      y: ORIGINAL_HEIGHT + 100,
      property: "top",
      expected: `${ORIGINAL_HEIGHT - 58}px`,
    },
  ])(
    "docks and tucks at the $edge edge",
    ({ edge, x, y, property, expected }) => {
      const { host, fab } = create();
      placeAt(host, 300, 300);
      pointer(fab, "pointerdown", 320, 320);
      pointer(fab, "pointermove", x, y);
      pointer(fab, "pointerup", x, y);

      expect(host.dataset.dockedEdge).toBe(edge);
      expect(host.dataset.edgeHidden).toBe("true");
      expect(host.style.getPropertyValue(property)).toBe(expected);
      const sign = edge === "left" || edge === "top" ? "-" : "";
      const axis = edge === "left" || edge === "right" ? "X" : "Y";
      expect(host.style.getPropertyValue("transform")).toBe(
        `translate${axis}(${sign}38px)`,
      );
    },
  );

  it("keeps a right-edge reveal strip inside the content beside a scrollbar", () => {
    setViewport(375, ORIGINAL_HEIGHT);
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 360,
    });
    const { host, fab, left } = create();
    placeAt(host, 300, 300);
    pointer(fab, "pointerdown", 320, 320);
    pointer(fab, "pointermove", 500, 320);
    pointer(fab, "pointerup", 500, 320);

    expect(host.dataset.dockedEdge).toBe("right");
    expect(host.dataset.edgeHidden).toBe("true");
    // 360 - 48 - 10: the 20px strip stays left of the 15px scrollbar.
    expect(left()).toBe("302px");
    expect(360 - (302 + 38)).toBe(20);
  });

  it("continues through window events when pointer capture is unavailable", () => {
    const { host, fab, left, top } = create();
    Object.defineProperty(fab, "setPointerCapture", {
      configurable: true,
      value: () => {
        throw new DOMException("capture unavailable", "NotSupportedError");
      },
    });
    placeAt(host, 100, 100);

    pointer(fab, "pointerdown", 110, 110);
    pointer(window, "pointermove", 210, 210);
    pointer(window, "pointerup", 210, 210);

    expect(left()).toBe("200px");
    expect(top()).toBe("200px");
    expect(host.dataset.dragging).toBeUndefined();
  });

  it("commits and persists the last position when pointer capture is lost", async () => {
    const onPositionChange = vi.fn();
    const { host, fab, left, top } = create({ onPositionChange });
    Object.defineProperty(fab, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    placeAt(host, 100, 100);

    pointer(fab, "pointerdown", 110, 110);
    pointer(window, "pointermove", 210, 210);
    pointer(fab, "lostpointercapture", 210, 210);
    expect(left()).toBe("200px");
    expect(top()).toBe("200px");
    expect(host.dataset.dragging).toBeUndefined();

    pointer(window, "pointermove", 310, 310);
    expect(left()).toBe("200px");
    await tick();
    expect(onPositionChange).toHaveBeenCalledTimes(1);
  });

  it("commits a fallback drag before the pointer enters an iframe", async () => {
    const onPositionChange = vi.fn();
    const { host, fab, left, top } = create({ onPositionChange });
    Object.defineProperty(fab, "setPointerCapture", {
      configurable: true,
      value: undefined,
    });
    placeAt(host, 100, 100);
    const ordinary = document.createElement("div");
    const iframe = document.createElement("iframe");
    document.body.append(ordinary, iframe);

    try {
      pointer(fab, "pointerdown", 110, 110);
      pointer(window, "pointermove", 210, 210);
      pointer(window, "pointerout", 210, 210, ordinary);
      expect(host.dataset.dragging).toBe("true");
      pointer(window, "pointerout", 210, 210, iframe);
      expect(host.dataset.dragging).toBeUndefined();

      pointer(window, "pointermove", 310, 310);
      expect(left()).toBe("200px");
      expect(top()).toBe("200px");
      await tick();
      expect(onPositionChange).toHaveBeenCalledTimes(1);
    } finally {
      ordinary.remove();
      iframe.remove();
    }
  });

  it("commits the current position when the window loses focus", async () => {
    const onPositionChange = vi.fn();
    const { host, fab, left, top } = create({ onPositionChange });
    placeAt(host, 100, 100);

    pointer(fab, "pointerdown", 110, 110);
    pointer(window, "pointermove", 230, 240);
    window.dispatchEvent(new Event("blur"));

    expect(left()).toBe("220px");
    expect(top()).toBe("230px");
    expect(host.dataset.dragging).toBeUndefined();
    await tick();
    expect(onPositionChange).toHaveBeenCalledTimes(1);
  });

  it("restores the position and docking state on pointer cancellation", () => {
    seedPosition(20, 300);
    const { host, fab, left, top } = create();
    expect(host.dataset.edgeHidden).toBe("true");

    pointer(fab, "pointerdown", 15, 320);
    pointer(fab, "pointermove", 150, 460);
    expect(left()).not.toBe("10px");
    expect(host.dataset.edgeHidden).toBe("false");
    pointer(fab, "pointercancel", 150, 460);

    expect(left()).toBe("10px");
    expect(top()).toBe("300px");
    expect(host.dataset.dockedEdge).toBe("left");
    expect(host.dataset.edgeHidden).toBe("true");
  });
});

describe("FloatingControl tucked launcher", () => {
  it("opens from the reveal strip without moving the hit target first", async () => {
    seedPosition(ORIGINAL_WIDTH, 176);
    const { host, fab, panel } = create();
    expect(host.dataset.dockedEdge).toBe("right");
    expect(host.dataset.edgeHidden).toBe("true");

    pointer(fab, "pointerdown", ORIGINAL_WIDTH - 5, 200);
    expect(host.dataset.edgeHidden).toBe("true");
    pointer(fab, "pointerup", ORIGINAL_WIDTH - 5, 200);
    fab.click();
    await tick();

    expect(host.dataset.edgeHidden).toBe("false");
    expect(fab.expanded).toBe("true");
    expect(panel.hidden).toBe(false);
  });

  it("reveals only once an actual drag starts", () => {
    seedPosition(ORIGINAL_WIDTH, 176);
    const { host, fab } = create();

    pointer(fab, "pointerdown", ORIGINAL_WIDTH - 5, 200);
    pointer(fab, "pointermove", ORIGINAL_WIDTH - 2, 200);
    expect(host.dataset.edgeHidden).toBe("true");
    pointer(fab, "pointermove", ORIGINAL_WIDTH - 30, 220);
    expect(host.dataset.edgeHidden).toBe("false");
    pointer(fab, "pointerup", ORIGINAL_WIDTH - 30, 220);
  });

  it("moves, docks without tucking and reveals with arrow keys", async () => {
    const onPositionChange = vi.fn();
    seedPosition(20, 300);
    const { host, fab, left, top } = create({ onPositionChange });
    expect(host.dataset.edgeHidden).toBe("true");

    key(fab, "ArrowRight");
    expect(host.dataset.edgeHidden).toBe("false");
    expect(host.dataset.dockedEdge).toBeUndefined();
    expect(left()).toBe("18px");

    key(fab, "ArrowLeft");
    expect(left()).toBe("10px");
    expect(host.dataset.dockedEdge).toBe("left");
    // Focus stays on the launcher, so a keyboard dock never tucks it away.
    expect(host.dataset.edgeHidden).toBe("false");

    key(fab, "ArrowDown", true);
    expect(top()).toBe("332px");
    await tick();
    expect(onPositionChange).toHaveBeenCalledTimes(3);
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      left: 10,
      top: 332,
    });
  });

  it("keeps an open panel visible when an edge position finishes loading", async () => {
    let resolvePosition: (position: { x: number; y: number }) => void = () =>
      undefined;
    const loadPosition = vi.fn(
      () =>
        new Promise<{ x: number; y: number }>((resolve) => {
          resolvePosition = resolve;
        }),
    );
    const { host, fab, panel } = create({ loadPosition });
    fab.click();
    await tick();
    expect(panel.hidden).toBe(false);

    resolvePosition({ x: 0, y: 0.5 });
    await tick();
    expect(host.dataset.dockedEdge).toBe("left");
    expect(host.dataset.edgeHidden).toBe("false");
    expect(panel.hidden).toBe(false);
  });
});

describe("FloatingControl viewport changes", () => {
  it("clamps and persists a stored position after the viewport shrinks", () => {
    seedPosition(600, 500);
    const { host, left, top } = create();
    expect(host.dataset.dockedEdge).toBeUndefined();

    setViewport(375, 640);
    window.dispatchEvent(new Event("resize"));
    expect(left()).toBe("317px");
    expect(top()).toBe("500px");
    expect(host.dataset.dockedEdge).toBe("right");
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      left: 317,
      top: 500,
    });
  });

  it("stays usable when session storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const { host, fab, left } = create();
    expect(control!.mount).toEqual({ ok: true });
    placeAt(host, 100, 100);
    expect(() => key(fab, "ArrowRight")).not.toThrow();
    expect(left()).toBe("108px");
  });
});

describe("FloatingControl fullscreen", () => {
  it("collapses the panel but keeps the launcher usable, then restores it", async () => {
    const { host, fab, panel } = create();
    const origin = host.parentNode;
    fab.click();
    await tick();
    expect(panel.hidden).toBe(false);

    setFullscreen(document.body);
    await tick();
    expect(control!.isExpanded).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(document.body.contains(host)).toBe(true);
    expect(host.style.getPropertyValue("display")).toBe("block");

    // The launcher keeps working inside the fullscreen container.
    fab.click();
    await tick();
    expect(panel.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(panel.hidden).toBe(true);

    setFullscreen(null);
    await tick();
    expect(host.parentNode).toBe(origin);
    // The panel was open before fullscreen, so it opens again.
    expect(control!.isExpanded).toBe(true);
    expect(panel.hidden).toBe(false);
  });

  it("restores a tucked launcher after leaving fullscreen", () => {
    seedPosition(20, 100);
    const { host } = create();
    expect(host.dataset.edgeHidden).toBe("true");

    setFullscreen(document.body);
    expect(host.dataset.edgeHidden).toBe("false");

    setFullscreen(null);
    expect(host.dataset.dockedEdge).toBe("left");
    expect(host.dataset.edgeHidden).toBe("true");
  });

  it("keeps a docked launcher attached across a wider fullscreen viewport", async () => {
    seedPosition(ORIGINAL_WIDTH, 100);
    const { host, fab, panel, left } = create();
    expect(left()).toBe(`${ORIGINAL_WIDTH - 58}px`);

    setViewport(ORIGINAL_WIDTH + 400, ORIGINAL_HEIGHT);
    setFullscreen(document.body);
    expect(host.dataset.dockedEdge).toBe("right");
    expect(host.dataset.edgeHidden).toBe("false");
    expect(left()).toBe(`${ORIGINAL_WIDTH + 342}px`);

    setViewport(ORIGINAL_WIDTH, ORIGINAL_HEIGHT);
    setFullscreen(null);
    expect(host.dataset.dockedEdge).toBe("right");
    expect(host.dataset.edgeHidden).toBe("true");
    expect(left()).toBe(`${ORIGINAL_WIDTH - 58}px`);

    fab.click();
    await tick();
    expect(host.dataset.edgeHidden).toBe("false");
    expect(panel.hidden).toBe(false);
  });

  it("restores a free position after a narrower fullscreen viewport without persisting it", () => {
    const onPositionChange = vi.fn();
    seedPosition(600, 500);
    const { host, left, top } = create({ onPositionChange });

    setViewport(500, 400);
    setFullscreen(document.body);
    expect(left()).toBe("442px");
    expect(top()).toBe("342px");

    setViewport(ORIGINAL_WIDTH, ORIGINAL_HEIGHT);
    setFullscreen(null);
    expect(left()).toBe("600px");
    expect(top()).toBe("500px");
    expect(host.dataset.dockedEdge).toBeUndefined();
    // Fullscreen clamps are temporary; the stored position stays as it was.
    expect(onPositionChange).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      left: 600,
      top: 500,
    });
  });
});
