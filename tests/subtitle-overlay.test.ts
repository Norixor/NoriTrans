import {
  DEFAULT_SETTINGS,
  type SubtitleCustomPosition,
} from "@/src/shared/settings";
import { projectOcrRegionToViewport } from "@/src/ocr/geometry";
import {
  SubtitleOverlay,
  subtitleCueVisibility,
} from "@/src/subtitles/overlay";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/src/shared/i18n", () => ({
  message: (key: string) => {
    if (key === "subtitleDragHandle") return "Move subtitles";
    if (key === "subtitlePositionSaveFailed")
      return "Could not save subtitle position.";
    return key;
  },
}));

describe("subtitle overlay display modes", () => {
  it("shows only the requested original, translated, or bilingual lines", () => {
    expect(subtitleCueVisibility("original", true, true)).toEqual({
      original: true,
      translated: false,
    });
    expect(subtitleCueVisibility("translated", true, true)).toEqual({
      original: false,
      translated: true,
    });
    expect(subtitleCueVisibility("bilingual", true, true)).toEqual({
      original: true,
      translated: true,
    });
  });

  it("removes a provider-added translation label from the subtitle text", () => {
    const overlay = new SubtitleOverlay({
      ...DEFAULT_SETTINGS.subtitles,
      displayMode: "translated",
    });
    overlay.showCue("Original", "译：Translated subtitle");
    const translated = document
      .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
      ?.shadowRoot?.querySelector<HTMLElement>(".cue.translated");

    expect(translated?.textContent).toBe("Translated subtitle");
    overlay.destroy();
  });

  it("does not pretend a missing translation is available", () => {
    expect(subtitleCueVisibility("translated", true, false)).toEqual({
      original: false,
      translated: false,
    });
    expect(subtitleCueVisibility("translated", true, false, true)).toEqual({
      original: true,
      translated: false,
    });
  });

  it("keeps translated-only OCR hidden until the local translation is ready", () => {
    const overlay = new SubtitleOverlay({
      ...DEFAULT_SETTINGS.subtitles,
      displayMode: "translated",
    });
    const root = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )?.shadowRoot;
    const original = root?.querySelector<HTMLElement>(".cue.original");
    const translated = root?.querySelector<HTMLElement>(".cue.translated");
    if (!original || !translated) throw new Error("missing subtitle cues");

    overlay.showCue("Locally recognized OCR text");
    expect(original.hidden).toBe(true);
    expect(original.textContent).toBe("Locally recognized OCR text");
    expect(translated.hidden).toBe(true);

    overlay.showCue("Locally recognized OCR text", undefined, {
      showOriginalFallback: true,
    });
    expect(original.hidden).toBe(false);
    expect(translated.hidden).toBe(true);

    overlay.showCue("Locally recognized OCR text", "本地译文");
    expect(original.hidden).toBe(true);
    expect(translated.hidden).toBe(false);
    expect(translated.textContent).toBe("本地译文");
    overlay.destroy();
  });

  it("keeps task actions out of the video overlay", () => {
    const overlay = new SubtitleOverlay({
      ...DEFAULT_SETTINGS.subtitles,
      displayMode: "translated",
    });
    const root = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )?.shadowRoot;
    const cueCard = root?.querySelector<HTMLElement>(".cue-card");
    if (!cueCard) throw new Error("missing subtitle cue card");

    expect(cueCard.hidden).toBe(true);
    expect(root?.querySelector(".stop-button")).toBeNull();

    overlay.showCue("Original awaiting translation");
    expect(cueCard.hidden).toBe(true);
    overlay.destroy();
  });

  it("keeps progress text off the video and hides the layer without a cue", () => {
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const container = host?.shadowRoot?.querySelector<HTMLElement>(".overlay");
    const status = host?.shadowRoot?.querySelector<HTMLElement>(".status");
    if (!container || !status) throw new Error("missing subtitle overlay");

    overlay.setStatus("partial", 0, 86);
    expect(container.hidden).toBe(true);
    expect(status.hidden).toBe(true);

    overlay.showCue("Original", "Translated");
    expect(container.hidden).toBe(false);
    overlay.clearCue();
    expect(container.hidden).toBe(true);
    overlay.destroy();
  });

  it("keeps a cancelled task distinct from a partial failure", () => {
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const status = host?.shadowRoot?.querySelector<HTMLElement>(".status");
    if (!status) throw new Error("missing subtitle overlay status");

    overlay.setStatus("cancelled", 12, 12);

    expect(status.dataset.state).toBe("cancelled");
    expect(status.textContent).toBe("subtitleStatusCancelled 12/12");
    overlay.destroy();
  });

  it("exposes the selected position on the shadow host", () => {
    const overlay = new SubtitleOverlay({
      ...DEFAULT_SETTINGS.subtitles,
      position: "top",
    });
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    expect(host?.dataset.position).toBe("top");

    overlay.updateSettings({
      ...DEFAULT_SETTINGS.subtitles,
      position: "center",
    });
    expect(host?.dataset.position).toBe("center");
    overlay.destroy();
  });

  it("anchors subtitles to the video and caps them at 80 percent width", () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 100, y: 50, width: 800, height: 450 });
    document.body.append(video);
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    overlay.setVideo(video);
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );

    expect(host?.style.getPropertyValue("--norixortrans-anchor-x")).toBe(
      "500px",
    );
    expect(host?.style.getPropertyValue("--norixortrans-anchor-y")).toBe(
      "464px",
    );
    expect(host?.style.getPropertyValue("--norixortrans-max-width")).toBe(
      "640px",
    );
    overlay.destroy();
  });

  it("does not leave a page overlay behind while native Picture-in-Picture is active", () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      document,
      "pictureInPictureElement",
    );
    const video = document.createElement("video");
    video.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 100, y: 50, width: 800, height: 450 });
    document.body.append(video);
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    overlay.setVideo(video);
    overlay.showCue("Original", "Translated");
    const container = document
      .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
      ?.shadowRoot?.querySelector<HTMLElement>(".overlay");
    expect(container?.hidden).toBe(false);

    Object.defineProperty(document, "pictureInPictureElement", {
      configurable: true,
      value: video,
    });
    video.dispatchEvent(new Event("enterpictureinpicture"));
    expect(container?.hidden).toBe(true);

    Object.defineProperty(document, "pictureInPictureElement", {
      configurable: true,
      value: null,
    });
    video.dispatchEvent(new Event("leavepictureinpicture"));
    expect(container?.hidden).toBe(false);
    overlay.destroy();
    if (descriptor) {
      Object.defineProperty(document, "pictureInPictureElement", descriptor);
    } else {
      Reflect.deleteProperty(document, "pictureInPictureElement");
    }
  });

  it("follows a video that moves without resizing or scrolling", async () => {
    vi.useFakeTimers();
    let bounds = DOMRect.fromRect({ x: 100, y: 50, width: 800, height: 450 });
    const video = document.createElement("video");
    video.getBoundingClientRect = () => bounds;
    document.body.append(video);
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    overlay.setVideo(video);
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );

    bounds = DOMRect.fromRect({ x: 220, y: 140, width: 800, height: 450 });
    await vi.advanceTimersByTimeAsync(250);

    expect(host?.style.getPropertyValue("--norixortrans-anchor-x")).toBe(
      "620px",
    );
    expect(host?.style.getPropertyValue("--norixortrans-anchor-y")).toBe(
      "554px",
    );
    overlay.destroy();
    vi.useRealTimers();
  });

  it("never exceeds 80 percent of a very small video", () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 20, y: 20, width: 100, height: 80 });
    document.body.append(video);
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    overlay.setVideo(video);
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    expect(host?.style.getPropertyValue("--norixortrans-max-width")).toBe(
      "80px",
    );
    overlay.destroy();
  });

  it("bounds oversized cues without adding task controls over the video", () => {
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    overlay.showCue("x".repeat(5_000), "y".repeat(5_000));
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const root = host?.shadowRoot;
    const container = root?.querySelector<HTMLElement>(".overlay");
    const original = root?.querySelector<HTMLElement>(".original");
    const translated = root?.querySelector<HTMLElement>(".translated");
    const style = root?.querySelector("style")?.textContent ?? "";
    if (!container) throw new Error("missing subtitle overlay");

    expect(original?.textContent).toHaveLength(1_000);
    expect(translated?.textContent).toHaveLength(1_000);
    expect(style).toContain("max-height: min(45vh, 320px)");
    expect(style).toContain("overflow-wrap: anywhere");
    expect(style).toContain("position: fixed");
    expect(root?.querySelector(".stop-button")).toBeNull();
    expect(container.hidden).toBe(false);
    overlay.destroy();
  });

  it("keeps an OCR failure notice visible even when subtitle cues are hidden", () => {
    vi.useFakeTimers();
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    overlay.showNotice("Protected video cannot be captured.");
    overlay.hide();
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const root = host?.shadowRoot;

    expect(root?.querySelector<HTMLElement>(".overlay")?.hidden).toBe(false);
    expect(root?.querySelector<HTMLElement>(".notice")?.textContent).toBe(
      "Protected video cannot be captured.",
    );
    expect(root?.querySelector<HTMLElement>(".notice")?.hidden).toBe(false);
    expect(root?.querySelector(".stop-button")).toBeNull();
    vi.advanceTimersByTime(8_000);
    expect(root?.querySelector<HTMLElement>(".notice")?.hidden).toBe(true);
    overlay.destroy();
    vi.useRealTimers();
  });

  it("keeps OCR translations outside the reprojected capture region", () => {
    const video = document.createElement("video");
    let bounds = DOMRect.fromRect({ x: 100, y: 50, width: 800, height: 450 });
    video.getBoundingClientRect = () => bounds;
    document.body.append(video);
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    overlay.setVideo(video);
    const mediaRegion = { x: 0.1, y: 0.4, width: 0.7, height: 0.25 };
    const initialRegion = projectOcrRegionToViewport(
      mediaRegion,
      bounds,
      window.innerWidth,
      window.innerHeight,
    );
    if (!initialRegion) throw new Error("missing initial OCR projection");
    overlay.setOcrCaptureRegion(initialRegion);
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );

    expect(host?.dataset.ocrSafeSide).toBe("above");
    expect(host?.style.getPropertyValue("--norixortrans-anchor-y")).toBe(
      `${initialRegion.y * window.innerHeight - 8}px`,
    );
    expect(host?.shadowRoot?.querySelector("style")?.textContent).toContain(
      '[data-ocr-safe-side="above"]',
    );

    bounds = DOMRect.fromRect({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const fullscreenRegion = projectOcrRegionToViewport(
      mediaRegion,
      bounds,
      window.innerWidth,
      window.innerHeight,
    );
    if (!fullscreenRegion) throw new Error("missing fullscreen OCR projection");
    overlay.setOcrCaptureRegion(fullscreenRegion);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host?.style.getPropertyValue("--norixortrans-anchor-y")).toBe(
      `${fullscreenRegion.y * window.innerHeight - 8}px`,
    );

    bounds = DOMRect.fromRect({ x: 180, y: 120, width: 600, height: 320 });
    const resizedRegion = projectOcrRegionToViewport(
      mediaRegion,
      bounds,
      window.innerWidth,
      window.innerHeight,
    );
    if (!resizedRegion) throw new Error("missing resized OCR projection");
    overlay.setOcrCaptureRegion(resizedRegion);
    window.dispatchEvent(new Event("resize"));
    const resizedRegionTop = resizedRegion.y * window.innerHeight;
    expect(host?.style.getPropertyValue("--norixortrans-anchor-y")).toBe(
      `${resizedRegionTop - 8}px`,
    );
    expect(
      Number.parseFloat(
        host?.style.getPropertyValue("--norixortrans-anchor-y") ?? "NaN",
      ),
    ).toBeLessThan(resizedRegionTop);

    overlay.setOcrCaptureRegion(null);
    expect(host?.dataset.ocrSafeSide).toBeUndefined();
    expect(host?.style.getPropertyValue("--norixortrans-anchor-y")).toBe(
      `${bounds.top + bounds.height * 0.92}px`,
    );
    overlay.destroy();
  });

  it.each([
    {
      name: "the full viewport",
      region: { x: 0, y: 0, width: 1, height: 1 },
      expectedSide: "above",
    },
    {
      name: "the viewport top edge",
      region: { x: 0, y: 0, width: 1, height: 0.2 },
      expectedSide: "below",
    },
    {
      name: "the viewport bottom edge",
      region: { x: 0, y: 0.8, width: 1, height: 0.2 },
      expectedSide: "above",
    },
  ])("clamps an OCR overlay selected at $name", ({ region, expectedSide }) => {
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    overlay.showCue("OCR original", "OCR translation");
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const container = host?.shadowRoot?.querySelector<HTMLElement>(".overlay");
    if (!container) throw new Error("missing OCR overlay");
    const overlayWidth = 320;
    const overlayHeight = 96;
    container.getBoundingClientRect = () =>
      new DOMRect(0, 0, overlayWidth, overlayHeight);

    overlay.setOcrCaptureRegion(region);

    const anchorX = Number.parseFloat(
      host?.style.getPropertyValue("--norixortrans-anchor-x") ?? "NaN",
    );
    const anchorY = Number.parseFloat(
      host?.style.getPropertyValue("--norixortrans-anchor-y") ?? "NaN",
    );
    const top = expectedSide === "above" ? anchorY - overlayHeight : anchorY;
    const bottom = expectedSide === "above" ? anchorY : anchorY + overlayHeight;
    expect(host?.dataset.ocrSafeSide).toBe(expectedSide);
    expect(anchorX - overlayWidth / 2).toBeGreaterThanOrEqual(8);
    expect(anchorX + overlayWidth / 2).toBeLessThanOrEqual(
      window.innerWidth - 8,
    );
    expect(top).toBeGreaterThanOrEqual(8);
    expect(bottom).toBeLessThanOrEqual(window.innerHeight - 8);
    overlay.destroy();
  });

  it("clears an OCR notice immediately when its media session ends", () => {
    vi.useFakeTimers();
    const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
    overlay.showNotice("Protected video cannot be captured.");
    const root = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    )?.shadowRoot;
    const notice = root?.querySelector<HTMLElement>(".notice");

    overlay.clearNotice();

    expect(notice?.hidden).toBe(true);
    expect(notice?.textContent).toBe("");
    vi.advanceTimersByTime(8_000);
    expect(notice?.hidden).toBe(true);
    overlay.destroy();
  });

  it("identifies only a translated overlay that actually overlaps the OCR crop", () => {
    const overlay = new SubtitleOverlay({
      ...DEFAULT_SETTINGS.subtitles,
      displayMode: "translated",
    });
    overlay.setOcrCaptureRegion({ x: 0.2, y: 0.2, width: 0.6, height: 0.5 });
    overlay.showCue("原字幕", "Translated subtitle");
    const cueCard = document
      .querySelector<HTMLElement>('[data-norixortrans-ui="subtitle-overlay"]')
      ?.shadowRoot?.querySelector<HTMLElement>(".cue-card");
    if (!cueCard) throw new Error("missing OCR cue card");
    cueCard.getBoundingClientRect = () => new DOMRect(300, 220, 260, 72);

    expect(overlay.isOcrFeedbackText("Translated subtitle")).toBe(true);
    expect(overlay.isOcrFeedbackText("Translated subritle")).toBe(true);
    expect(overlay.isOcrFeedbackText("A real video subtitle")).toBe(false);

    cueCard.getBoundingClientRect = () => new DOMRect(0, 0, 100, 40);
    expect(overlay.isOcrFeedbackText("Translated subtitle")).toBe(false);
    overlay.destroy();
  });

  it("keeps a custom OCR position but renders it outside the capture region", () => {
    const video = document.createElement("video");
    const bounds = DOMRect.fromRect({ x: 100, y: 50, width: 800, height: 450 });
    video.getBoundingClientRect = () => bounds;
    document.body.append(video);
    const onPositionChange =
      vi.fn<(position: SubtitleCustomPosition) => void>();
    const overlay = new SubtitleOverlay(
      DEFAULT_SETTINGS.subtitles,
      onPositionChange,
    );
    overlay.setVideo(video);
    overlay.setOcrCaptureRegion({
      x: 0.2,
      y: 0.55,
      width: 0.4,
      height: 0.15,
    });
    overlay.showCue("OCR original", "OCR translation");
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const container = host?.shadowRoot?.querySelector<HTMLElement>(".overlay");
    const handle = host?.shadowRoot?.querySelector<HTMLElement>(".cue-card");
    if (!container || !handle) throw new Error("missing OCR drag controls");
    container.getBoundingClientRect = () => new DOMRect(300, 300, 300, 90);

    const down = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 450,
      clientY: 345,
    });
    Object.defineProperties(down, {
      pointerId: { value: 31 },
      buttons: { value: 1 },
    });
    handle.dispatchEvent(down);
    const move = new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 600,
      clientY: 220,
    });
    Object.defineProperties(move, {
      pointerId: { value: 31 },
      buttons: { value: 1 },
    });
    window.dispatchEvent(move);

    expect(host?.dataset.position).toBe("custom");
    expect(host?.dataset.ocrSafeSide).toBeUndefined();
    const draggedX = host?.style.getPropertyValue("--norixortrans-anchor-x");
    const draggedY = host?.style.getPropertyValue("--norixortrans-anchor-y");
    expect(draggedX).toBe("600px");
    expect(draggedY).toBe("220px");

    const up = new MouseEvent("pointerup", {
      bubbles: true,
      clientX: 600,
      clientY: 220,
    });
    Object.defineProperty(up, "pointerId", { value: 31 });
    window.dispatchEvent(up);
    expect(onPositionChange).toHaveBeenCalledOnce();

    overlay.setOcrCaptureRegion({
      x: 0.1,
      y: 0.2,
      width: 0.7,
      height: 0.2,
    });
    window.dispatchEvent(new Event("resize"));
    expect(host?.style.getPropertyValue("--norixortrans-anchor-x")).toBe(
      draggedX,
    );
    expect(host?.dataset.ocrSafeSide).toBe("above");
    expect(host?.style.getPropertyValue("--norixortrans-anchor-y")).toBe(
      `${window.innerHeight * 0.2 - 8}px`,
    );

    overlay.setOcrCaptureRegion(null);
    expect(host?.dataset.ocrSafeSide).toBeUndefined();
    expect(host?.style.getPropertyValue("--norixortrans-anchor-y")).toBe(
      draggedY,
    );

    overlay.destroy();
  });

  it("moves a hidden custom subtitle before its first OCR translation is painted", () => {
    const video = document.createElement("video");
    video.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 100, y: 50, width: 800, height: 450 });
    document.body.append(video);
    const overlay = new SubtitleOverlay({
      ...DEFAULT_SETTINGS.subtitles,
      position: "custom",
      customPosition: { x: 0.5, y: 0.5 },
    });
    overlay.setVideo(video);

    overlay.setOcrCaptureRegion({
      x: 0.2,
      y: 0.2,
      width: 0.6,
      height: 0.5,
    });

    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    expect(host?.dataset.ocrSafeSide).toBe("above");
    expect(host?.style.getPropertyValue("--norixortrans-anchor-y")).toBe(
      `${window.innerHeight * 0.2 - 8}px`,
    );

    overlay.destroy();
  });

  it("keeps the subtitle overlay in the top layer over fullscreen canvas", () => {
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

    try {
      const overlay = new SubtitleOverlay(DEFAULT_SETTINGS.subtitles);
      const host = document.querySelector<HTMLElement>(
        '[data-norixortrans-ui="subtitle-overlay"]',
      );
      expect(host?.parentElement?.dataset.norixortransUi).toBe(
        "subtitle-fullscreen-portal",
      );
      expect(showPopover).toHaveBeenCalledOnce();
      overlay.destroy();
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

  it("supports keyboard position adjustment and persists custom coordinates", () => {
    const onPositionChange =
      vi.fn<(position: SubtitleCustomPosition) => void>();
    const overlay = new SubtitleOverlay(
      {
        ...DEFAULT_SETTINGS.subtitles,
        position: "center",
      },
      onPositionChange,
    );
    overlay.showCue("Original", "Translated");
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const container = host?.shadowRoot?.querySelector<HTMLElement>(".overlay");
    const handle = host?.shadowRoot?.querySelector<HTMLElement>(".cue-card");
    if (!container || !handle)
      throw new Error("missing subtitle drag controls");
    container.getBoundingClientRect = () => ({
      left: 312,
      top: 300,
      right: 712,
      bottom: 420,
      width: 400,
      height: 120,
      x: 312,
      y: 300,
      toJSON: () => ({}),
    });

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));

    expect(host?.dataset.position).toBe("custom");
    expect(onPositionChange).toHaveBeenCalledOnce();
    const position = onPositionChange.mock.calls[0]?.[0];
    expect(typeof position?.x).toBe("number");
    expect(typeof position?.y).toBe("number");
    overlay.destroy();
  });

  it("uses the cue card itself as the accessible drag handle and cancels stale drags", () => {
    const onPositionChange =
      vi.fn<(position: SubtitleCustomPosition) => void>();
    const overlay = new SubtitleOverlay(
      DEFAULT_SETTINGS.subtitles,
      onPositionChange,
    );
    overlay.showCue("Original", "Translated");
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const root = host?.shadowRoot;
    const handle = root?.querySelector<HTMLElement>(".cue-card");
    const style = root?.querySelector("style")?.textContent ?? "";
    if (!handle) throw new Error("missing drag handle");
    expect(handle.tabIndex).toBe(0);
    expect(handle.getAttribute("aria-label")).toBe("Move subtitles");
    expect(style).toContain('.cue-card[data-dragging="true"]');
    expect(style).toContain("touch-action: none");
    expect(style).toContain(":host([hidden])");

    const pointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    Object.defineProperties(pointerDown, {
      pointerId: { value: 1 },
      buttons: { value: 1 },
    });
    handle.dispatchEvent(pointerDown);
    window.dispatchEvent(new Event("blur"));
    const pointerMove = new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 200,
      clientY: 50,
    });
    Object.defineProperties(pointerMove, {
      pointerId: { value: 1 },
      buttons: { value: 1 },
    });
    handle.dispatchEvent(pointerMove);
    expect(host?.dataset.position).toBe("bottom");
    expect(onPositionChange).not.toHaveBeenCalled();
    overlay.destroy();
  });

  it("restores the previous position without saving on pointer cancellation", () => {
    const onPositionChange =
      vi.fn<(position: SubtitleCustomPosition) => void>();
    const overlay = new SubtitleOverlay(
      DEFAULT_SETTINGS.subtitles,
      onPositionChange,
    );
    overlay.showCue("Original", "Translated");
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const container = host?.shadowRoot?.querySelector<HTMLElement>(".overlay");
    const handle = host?.shadowRoot?.querySelector<HTMLElement>(".cue-card");
    if (!container || !handle) throw new Error("missing drag controls");
    container.getBoundingClientRect = () => new DOMRect(300, 300, 400, 120);

    const down = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 500,
      clientY: 360,
    });
    Object.defineProperties(down, {
      pointerId: { value: 9 },
      buttons: { value: 1 },
    });
    handle.dispatchEvent(down);
    expect(host?.dataset.dragging).toBe("true");
    const move = new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 650,
      clientY: 250,
    });
    Object.defineProperties(move, {
      pointerId: { value: 9 },
      buttons: { value: 1 },
    });
    window.dispatchEvent(move);
    expect(host?.dataset.position).toBe("custom");
    expect(host?.dataset.dragging).toBe("true");

    const cancel = new MouseEvent("pointercancel", { bubbles: true });
    Object.defineProperty(cancel, "pointerId", { value: 9 });
    handle.dispatchEvent(cancel);

    expect(host?.dataset.position).toBe("bottom");
    expect(onPositionChange).not.toHaveBeenCalled();
    overlay.destroy();
  });

  it("cancels a drag when fullscreen reparenting loses pointer capture", () => {
    const onPositionChange =
      vi.fn<(position: SubtitleCustomPosition) => void>();
    const overlay = new SubtitleOverlay(
      DEFAULT_SETTINGS.subtitles,
      onPositionChange,
    );
    overlay.showCue("Original", "Translated");
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const container = host?.shadowRoot?.querySelector<HTMLElement>(".overlay");
    const handle = host?.shadowRoot?.querySelector<HTMLElement>(".cue-card");
    if (!container || !handle) throw new Error("missing drag controls");
    container.getBoundingClientRect = () => new DOMRect(300, 300, 400, 120);

    const down = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 500,
      clientY: 360,
    });
    Object.defineProperties(down, {
      pointerId: { value: 12 },
      buttons: { value: 1 },
    });
    handle.dispatchEvent(down);
    const move = new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 650,
      clientY: 250,
    });
    Object.defineProperties(move, {
      pointerId: { value: 12 },
      buttons: { value: 1 },
    });
    window.dispatchEvent(move);
    expect(host?.dataset.position).toBe("custom");

    const lost = new MouseEvent("lostpointercapture", { bubbles: true });
    Object.defineProperty(lost, "pointerId", { value: 12 });
    handle.dispatchEvent(lost);

    expect(host?.dataset.position).toBe("bottom");
    expect(host?.dataset.dragging).toBeUndefined();
    expect(onPositionChange).not.toHaveBeenCalled();
    overlay.destroy();
  });

  it("keeps dragging through compatibility mouse events over a player iframe", () => {
    const onPositionChange =
      vi.fn<(position: SubtitleCustomPosition) => void>();
    const overlay = new SubtitleOverlay(
      DEFAULT_SETTINGS.subtitles,
      onPositionChange,
    );
    overlay.showCue("Original", "Translated");
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const container = host?.shadowRoot?.querySelector<HTMLElement>(".overlay");
    const handle = host?.shadowRoot?.querySelector<HTMLElement>(".cue-card");
    if (!container || !handle) throw new Error("missing drag controls");
    container.getBoundingClientRect = () => new DOMRect(300, 300, 400, 120);
    Object.defineProperty(handle, "setPointerCapture", {
      configurable: true,
      value: () => {
        throw new DOMException("capture unavailable", "NotFoundError");
      },
    });

    const down = new MouseEvent("pointerdown", {
      bubbles: true,
      button: 0,
      clientX: 500,
      clientY: 360,
    });
    Object.defineProperties(down, {
      pointerId: { value: 12 },
      buttons: { value: 1 },
    });
    handle.dispatchEvent(down);
    expect(host?.dataset.dragging).toBe("true");
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        buttons: 1,
        clientX: 650,
        clientY: 250,
      }),
    );
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    expect(host?.dataset.position).toBe("custom");
    expect(host?.dataset.dragging).toBeUndefined();
    expect(handle.dataset.dragging).toBeUndefined();
    expect(onPositionChange).toHaveBeenCalledOnce();
    overlay.destroy();
  });

  it("rolls back and reports an asynchronous position save failure", async () => {
    const onPositionChange = vi.fn(() => Promise.reject(new Error("failed")));
    const overlay = new SubtitleOverlay(
      DEFAULT_SETTINGS.subtitles,
      onPositionChange,
    );
    overlay.showCue("Original", "Translated");
    const host = document.querySelector<HTMLElement>(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const root = host?.shadowRoot;
    const container = root?.querySelector<HTMLElement>(".overlay");
    const handle = root?.querySelector<HTMLElement>(".cue-card");
    const status = root?.querySelector<HTMLElement>(".status");
    if (!container || !handle || !status)
      throw new Error("missing drag controls");
    container.getBoundingClientRect = () => new DOMRect(300, 300, 400, 120);

    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(host?.dataset.position).toBe("custom");
    await vi.waitFor(() => expect(host?.dataset.position).toBe("bottom"));

    expect(status.dataset.visible).toBe("true");
    expect(status.textContent).toBe("Could not save subtitle position.");
    overlay.setStatus("ready", 1, 1);
    expect(status.textContent).toBe("Could not save subtitle position.");
    expect(handle.dataset.saving).toBeUndefined();
    overlay.destroy();
  });
});
