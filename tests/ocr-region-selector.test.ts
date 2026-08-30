import { OcrRegionSelector } from "@/src/ocr/region-selector";
import { describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({
  browser: { i18n: { getMessage: (key: string) => key } },
}));

vi.mock("@/src/shared/i18n", () => ({
  message: (key: string) => key,
}));

describe("OcrRegionSelector", () => {
  it("marks the selector ready only after a host frame has been presented", async () => {
    const frames: FrameRequestCallback[] = [];
    let nextFrameId = 0;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.push(callback);
        nextFrameId += 1;
        return nextFrameId;
      });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);
    const selector = new OcrRegionSelector();
    const controller = new AbortController();

    try {
      const selection = selector.select(video, controller.signal);
      const host = document.querySelector<HTMLElement>(
        "noritrans-ocr-region-selector",
      );
      expect(host?.dataset.ready).toBe("false");
      expect(frames).toHaveLength(1);

      frames.shift()?.(16);
      expect(host?.dataset.ready).toBe("false");
      expect(frames).toHaveLength(1);

      frames.shift()?.(32);
      expect(host?.dataset.ready).toBe("true");

      controller.abort();
      await expect(selection).rejects.toMatchObject({ name: "AbortError" });
      expect(requestFrame).toHaveBeenCalledTimes(2);
      expect(cancelFrame).not.toHaveBeenCalled();
    } finally {
      selector.destroy();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it("cleans pending ready frames and timers when aborted or destroyed", async () => {
    vi.useFakeTimers();
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        nextFrameId += 1;
        frames.set(nextFrameId, callback);
        return nextFrameId;
      });
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);

    try {
      const abortedSelector = new OcrRegionSelector();
      const controller = new AbortController();
      const abortedSelection = abortedSelector.select(video, controller.signal);
      controller.abort();
      await expect(abortedSelection).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(frames.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      const destroyedSelector = new OcrRegionSelector();
      const destroyedSelection = destroyedSelector.select(
        video,
        new AbortController().signal,
      );
      destroyedSelector.destroy();
      await expect(destroyedSelection).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(frames.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      expect(cancelFrame).toHaveBeenCalledTimes(2);
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.useRealTimers();
    }
  });

  it("cancels without claiming readiness when no frame can be presented", async () => {
    vi.useFakeTimers();
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 1);
    const cancelFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);
    const selector = new OcrRegionSelector();

    try {
      const selection = selector.select(video, new AbortController().signal);
      const host = document.querySelector<HTMLElement>(
        "noritrans-ocr-region-selector",
      );
      const rejection = selection.catch((error: unknown) => error);
      expect(host?.dataset.ready).toBe("false");

      await vi.advanceTimersByTimeAsync(5_000);

      await expect(rejection).resolves.toMatchObject({ name: "AbortError" });
      expect(host?.dataset.ready).not.toBe("true");
      expect(host?.isConnected).toBe(false);
      expect(cancelFrame).toHaveBeenCalledWith(1);
    } finally {
      selector.destroy();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
      vi.useRealTimers();
    }
  });

  it("captures a headed mouse drag even when the shadow surface misses the hit", async () => {
    const iframe = document.createElement("iframe");
    iframe.getBoundingClientRect = () => new DOMRect(40, 50, 800, 450);
    document.body.append(iframe);
    const selector = new OcrRegionSelector();

    const selection = selector.select(iframe, new AbortController().signal);
    const host = document.querySelector<HTMLElement>(
      "noritrans-ocr-region-selector",
    );
    expect(host?.style.position).toBe("fixed");
    expect(host?.style.inset).toBe("0px");
    expect(host?.style.pointerEvents).toBe("auto");
    iframe.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 112,
        clientY: 285,
      }),
    );
    iframe.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: 692,
        clientY: 429,
      }),
    );
    iframe.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 692,
        clientY: 429,
      }),
    );

    await expect(selection).resolves.toMatchObject({
      x: 112 / window.innerWidth,
      y: 285 / window.innerHeight,
      width: 580 / window.innerWidth,
      height: 144 / window.innerHeight,
    });
    expect(document.querySelector("noritrans-ocr-region-selector")).toBeNull();
  });

  it("deduplicates compatibility mouse events after pointer input", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);
    const selector = new OcrRegionSelector();
    const selection = selector.select(video, new AbortController().signal);
    const dispatchPointer = (
      type: string,
      clientX: number,
      clientY: number,
    ): void => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX,
        clientY,
      });
      Object.defineProperties(event, {
        pointerId: { value: 9 },
        isPrimary: { value: true },
      });
      video.dispatchEvent(event);
    };

    dispatchPointer("pointerdown", 120, 300);
    video.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 400,
        clientY: 200,
      }),
    );
    dispatchPointer("pointermove", 700, 430);
    video.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 320,
      }),
    );
    dispatchPointer("pointerup", 700, 430);

    await expect(selection).resolves.toMatchObject({
      x: 120 / window.innerWidth,
      y: 300 / window.innerHeight,
      width: 580 / window.innerWidth,
      height: 130 / window.innerHeight,
    });
  });

  it("ignores dialog input and allows retry after a too-small drag", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);
    const selector = new OcrRegionSelector();
    const selection = selector.select(video, new AbortController().signal);
    const host = document.querySelector("noritrans-ocr-region-selector");
    const root = host?.shadowRoot;
    const suggested = root?.querySelector<HTMLButtonElement>("button");
    const feedback = root?.querySelector<HTMLElement>(".feedback");
    if (!suggested || !feedback) throw new Error("missing OCR controls");

    suggested.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        composed: true,
        cancelable: true,
        button: 0,
        clientX: 300,
        clientY: 50,
      }),
    );
    suggested.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        composed: true,
        cancelable: true,
        button: 0,
        clientX: 500,
        clientY: 200,
      }),
    );
    expect(feedback.textContent).toBe("");

    video.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 120,
        clientY: 120,
      }),
    );
    video.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 125,
        clientY: 125,
      }),
    );
    expect(feedback.textContent).toBe("ocrRegionTooSmall");
    expect(host?.isConnected).toBe(true);

    suggested.click();
    await expect(selection).resolves.toBeDefined();
  });

  it("cancels an active captured pointer drag and removes its listeners", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);
    const selector = new OcrRegionSelector();
    const selection = selector.select(video, new AbortController().signal);
    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 120,
      clientY: 200,
    });
    Object.defineProperties(pointerDown, {
      pointerId: { value: 7 },
      isPrimary: { value: true },
    });
    video.dispatchEvent(pointerDown);
    const pointerCancel = new MouseEvent("pointercancel", {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pointerCancel, "pointerId", { value: 7 });
    video.dispatchEvent(pointerCancel);

    await expect(selection).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector("noritrans-ocr-region-selector")).toBeNull();

    const strayEscape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(strayEscape);
    expect(strayEscape.defaultPrevented).toBe(false);
  });

  it("traps keyboard focus and restores the deepest Shadow DOM control", async () => {
    const launcherHost = document.createElement("div");
    const launcherRoot = launcherHost.attachShadow({ mode: "open" });
    const collapsedPanel = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.textContent = "Start OCR";
    collapsedPanel.append(trigger);
    const launcher = document.createElement("button");
    launcher.className = "launcher";
    launcherRoot.append(collapsedPanel, launcher);
    document.body.append(launcherHost);
    trigger.focus();
    collapsedPanel.hidden = true;

    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);
    const selector = new OcrRegionSelector();
    const selection = selector.select(video, new AbortController().signal);
    const host = document.querySelector("noritrans-ocr-region-selector");
    const root = host?.shadowRoot;
    const buttons = root?.querySelectorAll<HTMLButtonElement>("button");
    const suggested = buttons?.[0];
    const cancel = buttons?.[1];
    if (!suggested || !cancel) throw new Error("missing OCR controls");

    expect(root?.activeElement).toBe(suggested);
    suggested.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        composed: true,
      }),
    );
    expect(root?.activeElement).toBe(cancel);
    cancel.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        composed: true,
      }),
    );
    expect(root?.activeElement).toBe(suggested);
    suggested.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        composed: true,
      }),
    );
    expect(root?.activeElement).toBe(cancel);

    cancel.click();
    await expect(selection).rejects.toMatchObject({ name: "AbortError" });
    expect(launcherRoot.activeElement).toBe(launcher);
  });

  it("cancels selection when fullscreen changes so coordinates cannot go stale", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);
    const selector = new OcrRegionSelector();

    const selection = selector.select(video, new AbortController().signal);
    document.dispatchEvent(new Event("fullscreenchange"));

    await expect(selection).rejects.toThrow("ocr_selection_viewport_changed");
    expect(document.querySelector("noritrans-ocr-region-selector")).toBeNull();
  });

  it("cancels selection when the page scrolls so coordinates cannot go stale", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);
    const selector = new OcrRegionSelector();

    const selection = selector.select(video, new AbortController().signal);
    window.dispatchEvent(new Event("scroll"));

    await expect(selection).rejects.toThrow("ocr_selection_viewport_changed");
    expect(document.querySelector("noritrans-ocr-region-selector")).toBeNull();

    const strayScroll = new Event("scroll");
    window.dispatchEvent(strayScroll);
    expect(document.querySelector("noritrans-ocr-region-selector")).toBeNull();
  });

  it("cancels selection with Escape", async () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () => new DOMRect(100, 100, 640, 360);
    document.body.append(video);
    const selector = new OcrRegionSelector();

    const selection = selector.select(video, new AbortController().signal);
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );

    await expect(selection).rejects.toMatchObject({ name: "AbortError" });
    expect(document.querySelector("noritrans-ocr-region-selector")).toBeNull();
  });

  it("uses a top-layer portal over a fullscreen canvas player", async () => {
    const fullscreenDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "fullscreenElement",
    );
    const showPopover = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "showPopover", {
      configurable: true,
      value: showPopover,
    });
    Object.defineProperty(HTMLElement.prototype, "hidePopover", {
      configurable: true,
      value: vi.fn(),
    });
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () => new DOMRect(0, 0, 800, 450);
    document.body.append(canvas);
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: canvas,
    });
    const selector = new OcrRegionSelector();

    try {
      const selection = selector.select(canvas, new AbortController().signal);
      const host = document.querySelector("noritrans-ocr-region-selector");
      expect(host?.parentElement?.dataset.noritransUi).toBe(
        "ocr-fullscreen-portal",
      );
      expect(showPopover).toHaveBeenCalledOnce();
      host?.shadowRoot?.querySelectorAll("button")[1]?.click();
      await expect(selection).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      if (fullscreenDescriptor) {
        Object.defineProperty(
          document,
          "fullscreenElement",
          fullscreenDescriptor,
        );
      } else {
        Reflect.deleteProperty(document, "fullscreenElement");
      }
      Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
      Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
    }
  });
});
