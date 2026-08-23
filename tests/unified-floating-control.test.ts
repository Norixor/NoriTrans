import type { PageStatus, SubtitleStatus } from "@/src/messaging/protocol";
import { DEFAULT_SETTINGS, toContentSettings } from "@/src/shared/settings";
import {
  stableSubtitleDisplayState,
  UnifiedFloatingControl,
  type UnifiedFloatingControlOptions,
} from "@/src/shared/unified-floating-control";
import { browser } from "wxt/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: {
      getMessage: (key: string) => key,
      getUILanguage: () => "en",
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://test${path}`,
      sendMessage: vi.fn(),
    },
  },
}));

function createControl(overrides: Partial<UnifiedFloatingControlOptions> = {}) {
  const onPageTranslate = vi.fn();
  const onPageRestore = vi.fn();
  const onAutoTranslateChange = vi.fn();
  const onPageSettingsChange = vi.fn();
  const onPageModeChange = vi.fn();
  const onPageResponseModeChange = vi.fn();
  const onSubtitleSettingsChange = vi.fn();
  const onSubtitleStart = vi.fn();
  const onSubtitleCancel = vi.fn();
  const onCreateProfile = vi.fn();
  const onHideCurrent = vi.fn();
  const control = new UnifiedFloatingControl({
    settings: toContentSettings(DEFAULT_SETTINGS),
    onPageTranslate,
    onPageRestore,
    onAutoTranslateChange,
    onPageSettingsChange,
    onPageModeChange,
    onPageResponseModeChange,
    onSubtitleSettingsChange,
    onSubtitleStart,
    onSubtitleCancel,
    onCreateProfile,
    onHideCurrent,
    ...overrides,
  });
  const host = document.querySelector<HTMLElement>(
    '[data-norixortrans-ui="unified-floating-control"]',
  );
  const root = host?.shadowRoot;
  if (!host || !root) throw new Error("missing unified floating control");
  return {
    control,
    host,
    root,
    onPageTranslate,
    onPageRestore,
    onAutoTranslateChange,
    onPageSettingsChange,
    onPageModeChange,
    onPageResponseModeChange,
    onSubtitleSettingsChange,
    onSubtitleStart,
    onSubtitleCancel,
    onCreateProfile,
    onHideCurrent,
  };
}

function dispatchPointer(
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

describe("unified floating control", () => {
  beforeEach(() => {
    vi.mocked(browser.runtime.sendMessage).mockReset();
    document.documentElement.replaceChildren(
      document.createElement("head"),
      document.createElement("body"),
    );
    sessionStorage.clear();
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
  });

  it("combines accessible page and video controls in one panel", async () => {
    const {
      control,
      root,
      onPageTranslate,
      onPageRestore,
      onAutoTranslateChange,
      onPageSettingsChange,
      onPageModeChange,
      onPageResponseModeChange,
      onSubtitleSettingsChange,
      onCreateProfile,
    } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const panel = root.querySelector<HTMLElement>(".panel");
    const tabs = root.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    const pagePanel = root.querySelector<HTMLElement>(
      "#norixortrans-page-panel",
    );
    const videoPanel = root.querySelector<HTMLElement>(
      "#norixortrans-video-panel",
    );
    const imagePanel = root.querySelector<HTMLElement>(
      "#norixortrans-image-panel",
    );
    if (
      !launcher ||
      !panel ||
      !pagePanel ||
      !videoPanel ||
      !imagePanel ||
      tabs.length !== 3
    ) {
      throw new Error("missing unified control structure");
    }

    expect(launcher.querySelector("svg")).not.toBeNull();
    expect(launcher.textContent).not.toContain("N");
    expect(launcher.getAttribute("aria-keyshortcuts")).toBe(
      "ArrowUp ArrowDown ArrowLeft ArrowRight",
    );
    expect(panel.hidden).toBe(true);
    launcher.click();
    expect(panel.hidden).toBe(false);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(pagePanel.getAttribute("role")).toBe("tabpanel");

    const pageStatus: PageStatus = {
      state: "translated",
      total: 4,
      completed: 4,
      failed: 0,
    };
    control.updatePageStatus(pageStatus);
    expect(pagePanel.querySelector(".progress")?.textContent).toBe("4/4");
    const pageSelects = pagePanel.querySelectorAll<HTMLSelectElement>("select");
    const pageSourceLanguage = pageSelects[0];
    const pageTargetLanguage = pageSelects[1];
    const pageMode = pageSelects[2];
    const pageResponseMode = pageSelects[3];
    const pageDisplayMode = pageSelects[4];
    const selectionTranslationMode = pageSelects[5];
    if (
      !pageSourceLanguage ||
      !pageTargetLanguage ||
      !pageMode ||
      !pageResponseMode ||
      !pageDisplayMode ||
      !selectionTranslationMode
    ) {
      throw new Error("missing page translation settings");
    }
    expect(pageSourceLanguage.options[0]?.textContent).toBe("languageAuto");
    expect(pageSourceLanguage.value).toBe("auto");
    expect(pageTargetLanguage.value).toBe("zh-CN");
    expect(pageDisplayMode.value).toBe("bilingual");
    expect(selectionTranslationMode.value).toBe("fast");
    const pageCheckboxes = pagePanel.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const autoTranslate = pageCheckboxes[0];
    const selectionTranslationEnabled = pageCheckboxes[1];
    if (!autoTranslate || !selectionTranslationEnabled) {
      throw new Error("missing page translation toggles");
    }
    pageSourceLanguage.value = "en";
    pageTargetLanguage.value = "ja";
    pageDisplayMode.value = "translated";
    selectionTranslationMode.value = "ai";
    selectionTranslationEnabled.checked = false;
    selectionTranslationMode.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(onPageSettingsChange).toHaveBeenCalledWith({
        sourceLanguage: "en",
        targetLanguage: "ja",
        displayMode: "translated",
        selectionTranslationEnabled: false,
        selectionTranslationMode: "ai",
      }),
    );
    expect(pageMode.value).toBe("fast");
    expect(pageResponseMode.disabled).toBe(true);
    pageMode.value = "ai";
    pageMode.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(onPageModeChange).toHaveBeenCalledWith("ai"));
    expect(pageResponseMode.disabled).toBe(false);
    pageResponseMode.value = "batch";
    pageResponseMode.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(onPageResponseModeChange).toHaveBeenCalledWith("batch"),
    );
    const pageButtons = pagePanel.querySelectorAll<HTMLButtonElement>("button");
    pageButtons[0]?.click();
    await vi.waitFor(() => expect(pageButtons[1]?.disabled).toBe(false));
    pageButtons[1]?.click();
    expect(onPageTranslate).toHaveBeenCalledOnce();
    expect(onPageRestore).toHaveBeenCalledOnce();

    autoTranslate.checked = true;
    autoTranslate.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(onAutoTranslateChange).toHaveBeenCalledWith(true),
    );

    tabs[1]?.click();
    expect(videoPanel.hidden).toBe(false);
    tabs[1]?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    tabs[1]?.click();
    const subtitleStatus: SubtitleStatus = {
      state: "ready",
      total: 12,
      completed: 9,
      failed: 0,
    };
    control.updateSubtitleStatus(subtitleStatus);
    expect(videoPanel.querySelector(".progress")?.textContent).toBe("9/12");
    const selects = videoPanel.querySelectorAll<HTMLSelectElement>("select");
    const hideNative = videoPanel.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (
      !selects[0] ||
      !selects[1] ||
      !selects[2] ||
      !selects[3] ||
      !selects[4] ||
      !hideNative
    ) {
      throw new Error("missing subtitle settings");
    }
    selects[0].value = "en";
    selects[1].value = "ja";
    selects[2].value = "fast";
    selects[3].value = "batch";
    selects[4].value = "translated";
    hideNative.checked = true;
    hideNative.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(onSubtitleSettingsChange).toHaveBeenLastCalledWith({
        sourceLanguage: "en",
        targetLanguage: "ja",
        mode: "fast",
        aiResponseMode: "batch",
        displayMode: "translated",
        hideNativeSubtitles: true,
        fontScale: 1.2,
        backgroundOpacity: 0.5,
      }),
    );

    videoPanel
      .querySelector<HTMLButtonElement>("button.profile-action")
      ?.click();
    expect(onCreateProfile).toHaveBeenCalledOnce();
    expect(panel.hidden).toBe(true);

    control.updateSettings({
      ...toContentSettings(DEFAULT_SETTINGS),
      page: {
        ...DEFAULT_SETTINGS.page,
        sourceLanguage: "de",
        targetLanguage: "fr",
        mode: "ai",
        displayMode: "translated",
        autoTranslate: true,
        selectionTranslationEnabled: false,
        selectionTranslationMode: "ai",
      },
      subtitles: {
        ...DEFAULT_SETTINGS.subtitles,
        sourceLanguage: "ko",
        targetLanguage: "en",
        mode: "fast",
        displayMode: "original",
        hideNativeSubtitles: true,
      },
    });
    expect(autoTranslate.checked).toBe(true);
    expect(pageSourceLanguage.value).toBe("de");
    expect(pageTargetLanguage.value).toBe("fr");
    expect(pageMode.value).toBe("ai");
    expect(pageResponseMode.value).toBe("stream");
    expect(pageDisplayMode.value).toBe("translated");
    expect(selectionTranslationEnabled.checked).toBe(false);
    expect(selectionTranslationMode.value).toBe("ai");
    expect(selects[0].value).toBe("ko");
    expect(selects[1].value).toBe("en");
    expect(selects[2].value).toBe("fast");
    expect(selects[3].disabled).toBe(true);
    expect(selects[4].value).toBe("original");
    expect(hideNative.checked).toBe(true);
    control.destroy();
  });

  it("reverts page mode and shows an error when saving fails", async () => {
    const { control, root, onPageModeChange } = createControl();
    onPageModeChange.mockRejectedValueOnce(new Error("save failed"));
    const pagePanel = root.querySelector<HTMLElement>(
      "#norixortrans-page-panel",
    );
    const pageMode =
      pagePanel?.querySelectorAll<HTMLSelectElement>("select")[2];
    const statusRow = pagePanel?.querySelector<HTMLElement>(".status-row");
    const status = statusRow?.querySelector<HTMLElement>(".status");
    if (!pageMode || !statusRow || !status) {
      throw new Error("missing page mode settings");
    }

    pageMode.value = "ai";
    pageMode.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(status.textContent).toBe("settingsSaveFailed"),
    );
    expect(onPageModeChange).toHaveBeenCalledWith("ai");
    expect(pageMode.value).toBe("fast");
    expect(pageMode.disabled).toBe(false);
    expect(statusRow.dataset.state).toBe("error");
    control.destroy();
  });

  it("reverts page and selection quick settings when saving fails", async () => {
    const { control, root, onPageSettingsChange } = createControl();
    onPageSettingsChange.mockRejectedValueOnce(new Error("save failed"));
    const pagePanel = root.querySelector<HTMLElement>(
      "#norixortrans-page-panel",
    );
    const selects = pagePanel?.querySelectorAll<HTMLSelectElement>("select");
    const sourceLanguage = selects?.[0];
    const targetLanguage = selects?.[1];
    const displayMode = selects?.[4];
    const selectionMode = selects?.[5];
    const selectionEnabled = pagePanel?.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    )[1];
    const status = pagePanel?.querySelector<HTMLElement>(".status");
    if (
      !sourceLanguage ||
      !targetLanguage ||
      !displayMode ||
      !selectionMode ||
      !selectionEnabled ||
      !status
    ) {
      throw new Error("missing page quick settings");
    }

    sourceLanguage.value = "fr";
    targetLanguage.value = "de";
    displayMode.value = "translated";
    selectionMode.value = "ai";
    selectionEnabled.checked = false;
    selectionMode.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(status.textContent).toBe("settingsSaveFailed"),
    );
    expect(onPageSettingsChange).toHaveBeenCalledWith({
      sourceLanguage: "fr",
      targetLanguage: "de",
      displayMode: "translated",
      selectionTranslationEnabled: false,
      selectionTranslationMode: "ai",
    });
    expect(sourceLanguage.value).toBe("auto");
    expect(targetLanguage.value).toBe("zh-CN");
    expect(displayMode.value).toBe("bilingual");
    expect(selectionMode.value).toBe("fast");
    expect(selectionEnabled.checked).toBe(true);
    expect(sourceLanguage.disabled).toBe(false);
    expect(targetLanguage.disabled).toBe(false);
    expect(displayMode.disabled).toBe(false);
    expect(selectionMode.disabled).toBe(false);
    expect(selectionEnabled.disabled).toBe(false);
    control.destroy();
  });

  it("reverts video quick settings and shows an error when saving fails", async () => {
    const { control, root, onSubtitleSettingsChange } = createControl();
    onSubtitleSettingsChange.mockRejectedValueOnce(new Error("save failed"));
    const tabs = root.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs[1]?.click();
    const videoPanel = root.querySelector<HTMLElement>(
      "#norixortrans-video-panel",
    );
    const selects = videoPanel?.querySelectorAll<HTMLSelectElement>("select");
    const hideNative = videoPanel?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const status = videoPanel?.querySelector<HTMLElement>(".status");
    if (
      !selects?.[0] ||
      !selects[1] ||
      !selects[2] ||
      !selects[3] ||
      !selects[4] ||
      !hideNative ||
      !status
    ) {
      throw new Error("missing video quick settings");
    }

    selects[0].value = "fr";
    selects[1].value = "de";
    selects[2].value = "fast";
    selects[3].value = "batch";
    selects[4].value = "translated";
    hideNative.checked = true;
    hideNative.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(status.textContent).toBe("settingsSaveFailed"),
    );
    expect(selects[0].value).toBe("auto");
    expect(selects[1].value).toBe("zh-CN");
    expect(selects[2].value).toBe("ai");
    expect(selects[3].value).toBe("stream");
    expect(selects[4].value).toBe("bilingual");
    expect(hideNative.checked).toBe(false);
    expect(selects[0].disabled).toBe(false);
    expect(selects[4].disabled).toBe(false);
    expect(hideNative.disabled).toBe(false);
    control.destroy();
  });

  it("reverts auto translation and exposes a semantic error when saving fails", async () => {
    const { control, root, onAutoTranslateChange } = createControl();
    onAutoTranslateChange.mockRejectedValueOnce(new Error("save failed"));
    const pagePanel = root.querySelector<HTMLElement>(
      "#norixortrans-page-panel",
    );
    const autoTranslate = pagePanel?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    const statusRow = pagePanel?.querySelector<HTMLElement>(".status-row");
    const status = statusRow?.querySelector<HTMLElement>(".status");
    if (!autoTranslate || !statusRow || !status) {
      throw new Error("missing page quick settings");
    }

    autoTranslate.checked = true;
    autoTranslate.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(status.textContent).toBe("settingsSaveFailed"),
    );
    expect(autoTranslate.checked).toBe(false);
    expect(autoTranslate.disabled).toBe(false);
    expect(statusRow.dataset.state).toBe("error");
    control.destroy();
  });

  it("keeps the page draft busy and reconciles a newer settings snapshot", async () => {
    let resolveMode!: () => void;
    const onPageModeChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveMode = resolve;
        }),
    );
    const { control, root } = createControl({ onPageModeChange });
    const pagePanel = root.querySelector<HTMLElement>(
      "#norixortrans-page-panel",
    );
    const selects = pagePanel?.querySelectorAll<HTMLSelectElement>("select");
    const targetLanguage = selects?.[1];
    const pageMode = selects?.[2];
    const autoTranslate = pagePanel?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!targetLanguage || !pageMode || !autoTranslate) {
      throw new Error("missing page settings race fixture");
    }

    pageMode.value = "ai";
    pageMode.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(onPageModeChange).toHaveBeenCalledWith("ai"));
    expect(pageMode.disabled).toBe(true);
    expect(autoTranslate.disabled).toBe(true);

    control.updateSettings({
      ...toContentSettings(DEFAULT_SETTINGS),
      page: {
        ...DEFAULT_SETTINGS.page,
        targetLanguage: "ja",
        mode: "fast",
      },
    });
    expect(pageMode.value).toBe("ai");
    expect(targetLanguage.value).toBe("ja");
    expect(pageMode.disabled).toBe(true);
    expect(autoTranslate.disabled).toBe(true);

    resolveMode();
    await vi.waitFor(() => expect(pageMode.disabled).toBe(false));
    expect(pageMode.value).toBe("fast");
    expect(targetLanguage.value).toBe("ja");
    expect(autoTranslate.disabled).toBe(false);
    control.destroy();
  });

  it("keeps the subtitle draft busy and reconciles a newer settings snapshot", async () => {
    let resolveSettings!: () => void;
    const onSubtitleSettingsChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    const { control, root } = createControl({ onSubtitleSettingsChange });
    const videoPanel = root.querySelector<HTMLElement>(
      "#norixortrans-video-panel",
    );
    const selects = videoPanel?.querySelectorAll<HTMLSelectElement>("select");
    const sourceLanguage = selects?.[0];
    const targetLanguage = selects?.[1];
    const hideNative = videoPanel?.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (!sourceLanguage || !targetLanguage || !hideNative) {
      throw new Error("missing subtitle settings race fixture");
    }

    sourceLanguage.value = "en";
    hideNative.checked = true;
    hideNative.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(onSubtitleSettingsChange).toHaveBeenCalledOnce(),
    );
    expect(sourceLanguage.disabled).toBe(true);
    expect(hideNative.disabled).toBe(true);

    control.updateSettings({
      ...toContentSettings(DEFAULT_SETTINGS),
      subtitles: {
        ...DEFAULT_SETTINGS.subtitles,
        sourceLanguage: "de",
        targetLanguage: "ja",
        hideNativeSubtitles: false,
      },
    });
    expect(sourceLanguage.value).toBe("en");
    expect(hideNative.checked).toBe(true);
    expect(sourceLanguage.disabled).toBe(true);
    expect(hideNative.disabled).toBe(true);

    resolveSettings();
    await vi.waitFor(() => expect(sourceLanguage.disabled).toBe(false));
    expect(sourceLanguage.value).toBe("de");
    expect(targetLanguage.value).toBe("ja");
    expect(hideNative.checked).toBe(false);
    control.destroy();
  });

  it("keeps the OCR draft busy and reconciles a newer settings snapshot", async () => {
    let resolveOcr!: () => void;
    const onOcrEnabledChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOcr = resolve;
        }),
    );
    const { control, root } = createControl({ onOcrEnabledChange });
    const ocrEnabled = root.querySelector<HTMLInputElement>(
      ".ocr-section input[type=checkbox]",
    );
    if (!ocrEnabled) throw new Error("missing OCR settings race fixture");

    ocrEnabled.checked = true;
    ocrEnabled.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(onOcrEnabledChange).toHaveBeenCalledWith(true),
    );
    expect(ocrEnabled.disabled).toBe(true);

    control.updateSettings(toContentSettings(DEFAULT_SETTINGS));
    expect(ocrEnabled.checked).toBe(true);
    expect(ocrEnabled.disabled).toBe(true);

    resolveOcr();
    await vi.waitFor(() => expect(ocrEnabled.disabled).toBe(false));
    expect(ocrEnabled.checked).toBe(false);
    control.destroy();
  });

  it("keeps failed subtitle status stable while another request starts", () => {
    expect(
      stableSubtitleDisplayState({
        state: "translating",
        total: 2,
        completed: 0,
        failed: 1,
      }),
    ).toBe("error");
    expect(
      stableSubtitleDisplayState({
        state: "translating",
        total: 2,
        completed: 1,
        failed: 1,
      }),
    ).toBe("partial");
    expect(
      stableSubtitleDisplayState({
        state: "cancelled",
        total: 2,
        completed: 1,
        failed: 1,
      }),
    ).toBe("cancelled");
  });

  it("keeps subtitle start and cancel controls inside the video tab", async () => {
    const { control, root, onSubtitleStart, onSubtitleCancel } =
      createControl();
    const start = root.querySelector<HTMLButtonElement>(
      ".subtitle-actions .primary",
    );
    const cancel = root.querySelector<HTMLButtonElement>(
      ".subtitle-actions button:not(.primary)",
    );
    if (!start || !cancel) throw new Error("missing subtitle task actions");
    expect(document.querySelector(".stop-button")).toBeNull();
    const videoPanel = root.querySelector<HTMLElement>(
      "#norixortrans-video-panel",
    );
    expect(videoPanel?.children[1]).toBe(start.parentElement);

    control.updateSubtitleStatus({
      state: "waiting",
      total: 0,
      completed: 0,
      failed: 0,
    });
    expect(start.textContent).toBe("startSubtitleTranslation");
    expect(start.disabled).toBe(false);
    expect(cancel.disabled).toBe(true);

    start.click();
    await vi.waitFor(() => expect(onSubtitleStart).toHaveBeenCalledOnce());

    control.updateSubtitleStatus({
      state: "unavailable",
      total: 0,
      completed: 0,
      failed: 0,
    });
    expect(start.disabled).toBe(false);
    start.click();
    await vi.waitFor(() => expect(onSubtitleStart).toHaveBeenCalledTimes(2));

    control.updateSubtitleStatus({
      state: "translating",
      source: "texttrack",
      completeness: "full",
      total: 3,
      completed: 1,
      failed: 0,
    });
    expect(start.disabled).toBe(true);
    expect(cancel.disabled).toBe(false);
    cancel.click();
    await vi.waitFor(() => expect(onSubtitleCancel).toHaveBeenCalledOnce());

    control.updateSubtitleStatus({
      state: "cancelled",
      source: "texttrack",
      completeness: "full",
      total: 3,
      completed: 1,
      failed: 2,
    });
    expect(start.textContent).toBe("startSubtitleTranslation");
    expect(start.disabled).toBe(false);
    expect(cancel.disabled).toBe(true);

    control.updateSubtitleStatus({
      state: "ready",
      source: "texttrack",
      completeness: "full",
      total: 3,
      completed: 3,
      failed: 0,
    });
    expect(start.textContent).toBe("startSubtitleTranslation");
    expect(start.disabled).toBe(true);
    expect(cancel.disabled).toBe(false);
    expect(
      root.querySelector<HTMLElement>("#norixortrans-video-panel .status")
        ?.textContent,
    ).toBe("subtitleStatusReady · subtitleTrackFull");

    control.updateSubtitleStatus({
      state: "ready",
      source: "dom",
      completeness: "stream",
      total: 4,
      completed: 4,
      failed: 0,
    });
    expect(
      root.querySelector<HTMLElement>("#norixortrans-video-panel .status")
        ?.textContent,
    ).toBe("subtitleStatusReady · subtitleTrackStream");
    control.destroy();
  });

  it("keeps cancel available while a slow subtitle start command is pending", async () => {
    let resolveStart!: () => void;
    const onSubtitleStart = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const onSubtitleCancel = vi.fn(() => Promise.resolve());
    const { control, root } = createControl({
      onSubtitleStart,
      onSubtitleCancel,
    });
    const start = root.querySelector<HTMLButtonElement>(
      ".subtitle-actions .primary",
    );
    const cancel = root.querySelector<HTMLButtonElement>(
      ".subtitle-actions button:not(.primary)",
    );
    if (!start || !cancel) throw new Error("missing subtitle task actions");

    start.click();
    await vi.waitFor(() => expect(onSubtitleStart).toHaveBeenCalledOnce());

    expect(start.disabled).toBe(true);
    start.click();
    expect(onSubtitleStart).toHaveBeenCalledOnce();
    control.updateSubtitleStatus({
      state: "translating",
      source: "texttrack",
      completeness: "full",
      total: 3,
      completed: 0,
      failed: 0,
    });
    expect(cancel.disabled).toBe(false);
    cancel.click();
    await vi.waitFor(() => expect(onSubtitleCancel).toHaveBeenCalledOnce());

    control.updateSubtitleStatus({
      state: "cancelled",
      source: "texttrack",
      completeness: "full",
      total: 3,
      completed: 0,
      failed: 3,
    });
    expect(start.disabled).toBe(true);

    resolveStart();
    await vi.waitFor(() => expect(start.disabled).toBe(false));
    control.destroy();
  });

  it("reveals bounded provider diagnostics only when an error has details", () => {
    const { control, root } = createControl();
    const pageDiagnostic = root.querySelector<HTMLDetailsElement>(
      "#norixortrans-page-panel .diagnostic",
    );
    const subtitleDiagnostic = root.querySelector<HTMLDetailsElement>(
      "#norixortrans-video-panel .diagnostic",
    );
    if (!pageDiagnostic || !subtitleDiagnostic) {
      throw new Error("missing provider diagnostics");
    }

    control.updatePageStatus({
      state: "error",
      total: 2,
      completed: 0,
      failed: 2,
      message: "invalid response",
      details: "Missing result IDs: page-1, page-2.",
    });
    expect(pageDiagnostic.hidden).toBe(false);
    expect(pageDiagnostic.querySelector("summary")?.textContent).toBe(
      "viewProviderDetails",
    );
    expect(pageDiagnostic.querySelector("pre")?.textContent).toContain(
      "page-1",
    );
    pageDiagnostic.open = true;

    control.updatePageStatus({
      state: "translated",
      total: 2,
      completed: 2,
      failed: 0,
    });
    expect(pageDiagnostic.hidden).toBe(true);
    expect(pageDiagnostic.open).toBe(false);

    control.updateSubtitleStatus({
      state: "partial",
      source: "texttrack",
      completeness: "full",
      total: 2,
      completed: 1,
      failed: 1,
      details: "Unknown result ID: subtitle-extra.",
    });
    expect(subtitleDiagnostic.hidden).toBe(false);
    expect(subtitleDiagnostic.querySelector("pre")?.textContent).toContain(
      "subtitle-extra",
    );
    control.destroy();
  });

  it("closes an open diagnostic before Escape closes the panel", () => {
    const { control, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const panel = root.querySelector<HTMLElement>(".panel");
    const diagnostic = root.querySelector<HTMLDetailsElement>(
      "#norixortrans-page-panel .diagnostic",
    );
    const summary = diagnostic?.querySelector<HTMLElement>("summary");
    if (!launcher || !panel || !diagnostic || !summary) {
      throw new Error("missing diagnostic Escape fixture");
    }
    control.updatePageStatus({
      state: "error",
      total: 1,
      completed: 0,
      failed: 1,
      details: "Missing result ID: page-1.",
    });
    launcher.click();
    diagnostic.open = true;
    summary.focus();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(diagnostic.open).toBe(false);
    expect(panel.hidden).toBe(false);
    expect(root.activeElement).toBe(summary);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel.hidden).toBe(true);
    expect(root.activeElement).toBe(launcher);
    control.destroy();
  });

  it("shows a circular non-color-only launcher progress ring", () => {
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const style = root.querySelector("style")?.textContent ?? "";
    if (!launcher) throw new Error("missing launcher");

    expect(host.dataset.loading).toBe("false");
    expect(launcher.getAttribute("aria-busy")).toBe("false");
    control.updatePageStatus({
      state: "scanning",
      total: 10,
      completed: 0,
      failed: 0,
    });
    expect(host.dataset.loading).toBe("true");
    expect(launcher.getAttribute("aria-busy")).toBe("true");
    control.updatePageStatus({
      state: "translated",
      total: 10,
      completed: 10,
      failed: 0,
    });
    expect(host.dataset.loading).toBe("false");
    control.updateSubtitleStatus({
      state: "translating",
      completeness: "full",
      total: 20,
      completed: 2,
      failed: 0,
    });
    expect(host.dataset.loading).toBe("true");
    control.updateSubtitleStatus({
      state: "ready",
      total: 20,
      completed: 20,
      failed: 0,
    });
    expect(host.dataset.loading).toBe("false");
    control.updateOcrStatus({
      state: "initializing",
      recognized: 0,
      progress: 0.35,
    });
    expect(host.dataset.loading).toBe("true");
    expect(launcher.getAttribute("aria-busy")).toBe("true");
    control.updateOcrStatus({ state: "recognizing", recognized: 0 });
    expect(host.dataset.loading).toBe("true");
    control.updateOcrStatus({ state: "active", recognized: 1 });
    expect(host.dataset.loading).toBe("false");
    expect(launcher.getAttribute("aria-busy")).toBe("false");
    expect(
      root.querySelector<HTMLElement>(".ocr-section .progress")?.textContent,
    ).toBe("ocrRecognizedCount");
    expect(style).toContain("border-radius: 50%");
    expect(style).toContain(".launcher::after");
    expect(style).toContain("border: 2px solid transparent");
    expect(style).toContain("@keyframes norixor-launcher-spin");
    control.destroy();
  });

  it("does not show a no-track warning while OCR owns the video status", () => {
    const { control, root } = createControl();
    const subtitleStatus = root.querySelector<HTMLElement>(
      "#norixortrans-video-panel > .status-row",
    );
    if (!subtitleStatus) throw new Error("missing subtitle status row");

    control.updateSubtitleStatus({
      state: "unavailable",
      total: 0,
      completed: 0,
      failed: 0,
    });
    expect(subtitleStatus.hidden).toBe(false);

    control.updateOcrStatus({ state: "capturing", recognized: 0 });
    expect(subtitleStatus.hidden).toBe(true);
    control.updateOcrStatus({ state: "cancelled", recognized: 17 });
    expect(subtitleStatus.hidden).toBe(true);

    control.updateSubtitleStatus({
      state: "ready",
      total: 20,
      completed: 20,
      failed: 0,
    });
    expect(subtitleStatus.hidden).toBe(false);

    control.updateSubtitleStatus({
      state: "unavailable",
      total: 0,
      completed: 0,
      failed: 0,
    });
    control.updateOcrStatus({ state: "idle", recognized: 0 });
    expect(subtitleStatus.hidden).toBe(false);
    control.destroy();
  });

  it("allows an in-progress page translation to be cancelled", async () => {
    const { control, root, onPageRestore } = createControl();
    const pagePanel = root.querySelector<HTMLElement>(
      "#norixortrans-page-panel",
    );
    const buttons = pagePanel?.querySelectorAll<HTMLButtonElement>("button");
    const restoreButton = buttons?.[1];
    if (!restoreButton) throw new Error("missing page restore button");

    control.updatePageStatus({
      state: "translating",
      total: 383,
      completed: 1,
      failed: 0,
    });

    expect(restoreButton.disabled).toBe(false);
    expect(restoreButton.textContent).toBe("cancelPageTranslation");
    restoreButton.click();
    await vi.waitFor(() => expect(onPageRestore).toHaveBeenCalledOnce());
    control.destroy();
  });

  it("exposes accessible responsive OCR controls without mandatory motion", () => {
    const { control, root } = createControl();
    const ocrSection = root.querySelector<HTMLElement>(".ocr-section");
    const status = ocrSection?.querySelector<HTMLElement>('[role="status"]');
    expect(ocrSection).toBeInstanceOf(HTMLDetailsElement);
    expect((ocrSection as HTMLDetailsElement | null)?.open).toBe(false);
    const buttons = ocrSection?.querySelectorAll<HTMLButtonElement>("button");
    const style = root.querySelector("style")?.textContent ?? "";
    expect(ocrSection).not.toBeNull();
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(buttons).toHaveLength(2);
    expect(style).toContain("@media (max-width: 375px)");
    expect(style).toContain("prefers-reduced-motion: no-preference");
    control.destroy();
  });

  it("reveals a bounded OCR error diagnostic instead of leaving long text ellipsized", () => {
    const { control, root } = createControl();
    const diagnostic = root.querySelector<HTMLDetailsElement>(
      ".ocr-section .diagnostic",
    );
    const diagnosticText = diagnostic?.querySelector("pre");
    if (!diagnostic || !diagnosticText) {
      throw new Error("missing OCR diagnostic");
    }

    const longMessage = `OCR failed: ${"x".repeat(5_000)}`;
    control.updateOcrStatus({
      state: "error",
      recognized: 0,
      message: longMessage,
    });

    expect(diagnostic.hidden).toBe(false);
    expect(diagnostic.querySelector("summary")?.textContent).toBe(
      "viewProviderDetails",
    );
    expect(diagnosticText.textContent).toBe(longMessage.slice(0, 4_000));

    control.updateOcrStatus({ state: "idle", recognized: 0 });
    expect(diagnostic.hidden).toBe(true);
    expect(diagnostic.open).toBe(false);
    control.destroy();
  });

  it("uses a dense two-column layout without dropping any quick setting", () => {
    const { control, root } = createControl();
    const pageGrid = root.querySelector<HTMLElement>(
      "#norixortrans-page-panel .settings-grid",
    );
    const videoGrid = root.querySelector<HTMLElement>(
      "#norixortrans-video-panel .settings-grid",
    );
    const style = root.querySelector("style")?.textContent ?? "";

    expect(pageGrid?.children).toHaveLength(8);
    expect(pageGrid?.querySelectorAll("select")).toHaveLength(6);
    expect(pageGrid?.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      2,
    );
    expect(videoGrid?.children).toHaveLength(7);
    expect(videoGrid?.querySelectorAll("select")).toHaveLength(5);
    expect(videoGrid?.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(style).toContain("width: min(336px, calc(100vw - 20px))");
    expect(style).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
    expect(style).toContain("white-space: nowrap");
    expect(style).toContain("overflow: hidden");
    control.destroy();
  });

  it("clamps the expanded panel across a narrow viewport", () => {
    const originalWidth = window.innerWidth;
    const { control, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const panel = root.querySelector<HTMLElement>(".panel");
    if (!launcher || !panel) throw new Error("missing floating panel");

    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 375,
      });
      vi.spyOn(launcher, "getBoundingClientRect").mockReturnValue({
        x: 160,
        y: 500,
        left: 160,
        top: 500,
        right: 208,
        bottom: 548,
        width: 48,
        height: 48,
        toJSON: () => ({}),
      });
      vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 355,
        bottom: 400,
        width: 355,
        height: 400,
        toJSON: () => ({}),
      });

      launcher.click();

      expect(panel.style.left).toBe("-150px");
      expect(panel.style.right).toBe("auto");
      expect(160 + Number.parseInt(panel.style.left, 10)).toBe(10);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      control.destroy();
    }
  });

  it("drags with a threshold, clamps, persists, and suppresses the drag click", async () => {
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const panel = root.querySelector<HTMLElement>(".panel");
    if (!launcher || !panel) throw new Error("missing launcher");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 148,
      bottom: 148,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });

    launcher.click();
    expect(panel.hidden).toBe(false);
    dispatchPointer(launcher, "pointerdown", 110, 110);
    dispatchPointer(launcher, "pointermove", 114, 110);
    expect(host.style.left).toBe("");
    dispatchPointer(launcher, "pointermove", -100, -100);
    dispatchPointer(launcher, "pointerup", -100, -100);
    expect(host.style.left).toBe("10px");
    expect(host.style.top).toBe("10px");
    expect(host.style.right).toBe("auto");
    expect(host.style.bottom).toBe("auto");
    expect(host.dataset.dockedEdge).toBe("left");
    expect(host.dataset.edgeHidden).toBe("true");
    expect(panel.hidden).toBe(true);
    expect(root.activeElement).toBeNull();

    launcher.click();
    expect(panel.hidden).toBe(true);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    launcher.click();
    expect(panel.hidden).toBe(false);
    expect(host.dataset.edgeHidden).toBe("false");

    const key = `norixortrans:unified-control:${location.origin}${location.pathname}`;
    expect(JSON.parse(sessionStorage.getItem(key) ?? "{}")).toEqual({
      left: 10,
      top: 10,
    });
    control.destroy();

    const restored = createControl();
    expect(restored.host.style.left).toBe("10px");
    expect(restored.host.style.top).toBe("10px");
    restored.control.destroy();
  });

  it("moves, docks, and persists the launcher with keyboard arrows", async () => {
    const onPositionChange = vi.fn(() => Promise.resolve());
    const { control, host, root } = createControl({ onPositionChange });
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");

    Object.assign(host.style, { left: "120px", top: "120px" });
    launcher.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    launcher.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(host.style.left).toBe("128px");
    expect(host.style.top).toBe("152px");
    expect(host.dataset.edgeHidden).not.toBe("true");
    await vi.waitFor(() => expect(onPositionChange).toHaveBeenCalledTimes(2));

    Object.assign(host.style, { left: "10px", top: "152px" });
    host.dataset.dockedEdge = "left";
    host.dataset.edgeHidden = "true";
    launcher.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(host.dataset.edgeHidden).toBe("false");
    expect(host.style.left).toBe("18px");
    expect(host.dataset.dockedEdge).toBeUndefined();
    launcher.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(host.style.left).toBe("10px");
    expect(host.dataset.dockedEdge).toBe("left");

    control.destroy();
  });

  it("continues dragging through window events when pointer capture is unavailable", () => {
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");
    Object.defineProperty(launcher, "setPointerCapture", {
      configurable: true,
      value: () => {
        throw new DOMException("capture unavailable", "NotSupportedError");
      },
    });
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 148,
      bottom: 148,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });

    dispatchPointer(launcher, "pointerdown", 110, 110);
    dispatchPointer(window, "pointermove", 210, 210);
    dispatchPointer(window, "pointerup", 210, 210);

    expect(host.style.left).toBe("200px");
    expect(host.style.top).toBe("200px");
    expect(host.dataset.dragging).toBeUndefined();
    control.destroy();
  });

  it("commits and persists the last drag position when pointer capture is lost", async () => {
    const onPositionChange = vi.fn(() => Promise.resolve());
    const { control, host, root } = createControl({ onPositionChange });
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");
    Object.defineProperty(launcher, "setPointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 148,
      bottom: 148,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });

    dispatchPointer(launcher, "pointerdown", 110, 110);
    dispatchPointer(window, "pointermove", 210, 210);
    dispatchPointer(launcher, "lostpointercapture", 210, 210);

    expect(host.style.left).toBe("200px");
    expect(host.style.top).toBe("200px");
    expect(host.dataset.dragging).toBeUndefined();
    dispatchPointer(window, "pointermove", 310, 310);
    expect(host.style.left).toBe("200px");
    expect(host.style.top).toBe("200px");
    await vi.waitFor(() => expect(onPositionChange).toHaveBeenCalledOnce());
    control.destroy();
  });

  it("commits a fallback drag before the pointer enters an iframe", async () => {
    const onPositionChange = vi.fn(() => Promise.resolve());
    const { control, host, root } = createControl({ onPositionChange });
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");
    Object.defineProperty(launcher, "setPointerCapture", {
      configurable: true,
      value: undefined,
    });
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 148,
      bottom: 148,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });
    const ordinaryTarget = document.createElement("div");
    const iframe = document.createElement("iframe");
    document.body.append(ordinaryTarget, iframe);

    dispatchPointer(launcher, "pointerdown", 110, 110);
    dispatchPointer(window, "pointermove", 210, 210);
    dispatchPointer(window, "pointerout", 210, 210, ordinaryTarget);
    expect(host.dataset.dragging).toBe("true");
    dispatchPointer(window, "pointerout", 210, 210, iframe);

    expect(host.dataset.dragging).toBeUndefined();
    dispatchPointer(window, "pointermove", 310, 310);
    expect(host.style.left).toBe("200px");
    expect(host.style.top).toBe("200px");
    await vi.waitFor(() => expect(onPositionChange).toHaveBeenCalledOnce());
    control.destroy();
  });

  it("commits the current drag position when the window loses focus", async () => {
    const onPositionChange = vi.fn(() => Promise.resolve());
    const { control, host, root } = createControl({ onPositionChange });
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 148,
      bottom: 148,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });

    dispatchPointer(launcher, "pointerdown", 110, 110);
    dispatchPointer(window, "pointermove", 230, 240);
    window.dispatchEvent(new Event("blur"));

    expect(host.style.left).toBe("220px");
    expect(host.style.top).toBe("230px");
    expect(host.dataset.dragging).toBeUndefined();
    await vi.waitFor(() => expect(onPositionChange).toHaveBeenCalledOnce());
    control.destroy();
  });

  it("restores a persistent normalized launcher position across page sessions", async () => {
    const loadPosition = vi.fn(() => Promise.resolve({ x: 0.25, y: 0.5 }));
    const { control, host } = createControl({ loadPosition });
    const expectedLeft = Math.round(10 + (window.innerWidth - 48 - 20) * 0.25);
    const expectedTop = Math.round(10 + (window.innerHeight - 48 - 20) * 0.5);

    await vi.waitFor(() => {
      expect(host.style.left).toBe(`${expectedLeft}px`);
      expect(host.style.top).toBe(`${expectedTop}px`);
    });
    expect(loadPosition).toHaveBeenCalledOnce();
    control.destroy();
  });

  it("keeps an open panel visible when an edge position finishes loading", async () => {
    let resolvePosition:
      ((position: { x: number; y: number }) => void) | undefined;
    const loadPosition = vi.fn(
      () =>
        new Promise<{ x: number; y: number }>((resolve) => {
          resolvePosition = resolve;
        }),
    );
    const { control, host, root } = createControl({ loadPosition });
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const panel = root.querySelector<HTMLElement>(".panel");
    if (!launcher || !panel || !resolvePosition) {
      throw new Error("missing delayed position fixture");
    }

    launcher.click();
    expect(panel.hidden).toBe(false);
    resolvePosition({ x: 0, y: 0.5 });

    await vi.waitFor(() => expect(host.dataset.dockedEdge).toBe("left"));
    expect(host.dataset.edgeHidden).toBe("false");
    expect(panel.hidden).toBe(false);
    control.destroy();
  });

  it("persists a dragged launcher as viewport-relative coordinates", async () => {
    const onPositionChange = vi.fn(() => Promise.resolve());
    const { control, host, root } = createControl({ onPositionChange });
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 100,
      left: 100,
      top: 100,
      right: 148,
      bottom: 148,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });

    dispatchPointer(launcher, "pointerdown", 110, 110);
    dispatchPointer(launcher, "pointermove", -100, -100);
    dispatchPointer(launcher, "pointerup", -100, -100);

    await vi.waitFor(() =>
      expect(onPositionChange).toHaveBeenCalledWith({ x: 0, y: 0 }),
    );
    control.destroy();
  });

  it("restores launcher position and docking state on pointer cancellation", () => {
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");
    host.style.left = "100px";
    host.style.top = "120px";
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.dataset.dockedEdge = "left";
    host.dataset.edgeHidden = "true";
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 100,
      y: 120,
      left: 100,
      top: 120,
      right: 148,
      bottom: 168,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });

    dispatchPointer(launcher, "pointerdown", 110, 130);
    dispatchPointer(launcher, "pointermove", 250, 260);
    expect(host.style.left).not.toBe("100px");
    dispatchPointer(launcher, "pointercancel", 250, 260);

    expect(host.style.left).toBe("100px");
    expect(host.style.top).toBe("120px");
    expect(host.dataset.dockedEdge).toBe("left");
    expect(host.dataset.edgeHidden).toBe("true");
    control.destroy();
  });

  it("docks and hides the launcher at the nearest top or bottom edge", () => {
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 300,
      y: 300,
      left: 300,
      top: 300,
      right: 348,
      bottom: 348,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });

    dispatchPointer(launcher, "pointerdown", 320, 320);
    dispatchPointer(launcher, "pointermove", 320, window.innerHeight + 100);
    dispatchPointer(launcher, "pointerup", 320, window.innerHeight + 100);

    expect(host.dataset.dockedEdge).toBe("bottom");
    expect(host.dataset.edgeHidden).toBe("true");
    expect(host.style.top).toBe(`${window.innerHeight - 58}px`);
    const style = root.querySelector("style")?.textContent ?? "";
    expect(style).toContain("translateX(-38px)");
    expect(style).toContain("translateX(38px)");
    expect(style).toContain("translateY(-38px)");
    expect(style).toContain("translateY(38px)");
    control.destroy();
  });

  it("keeps a right-edge reveal strip inside the content viewport beside a scrollbar", () => {
    const originalWidth = window.innerWidth;
    const originalClientWidth = document.documentElement.clientWidth;
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 375,
    });
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 360,
    });
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 300,
      y: 300,
      left: 300,
      top: 300,
      right: 348,
      bottom: 348,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });

    try {
      dispatchPointer(launcher, "pointerdown", 320, 320);
      dispatchPointer(launcher, "pointermove", 500, 320);
      dispatchPointer(launcher, "pointerup", 500, 320);

      expect(host.dataset.dockedEdge).toBe("right");
      expect(host.dataset.edgeHidden).toBe("true");
      expect(host.style.left).toBe("302px");
      expect(root.querySelector("style")?.textContent).toContain(
        "translateX(38px)",
      );
      expect(302 + 38).toBeLessThan(360);
      expect(360 - (302 + 38)).toBe(20);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      Object.defineProperty(document.documentElement, "clientWidth", {
        configurable: true,
        value: originalClientWidth,
      });
      control.destroy();
    }
  });

  it("keeps the edge wake handle stable while the pointer enters it", () => {
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      x: 300,
      y: 300,
      left: 300,
      top: 300,
      right: 348,
      bottom: 348,
      width: 48,
      height: 48,
      toJSON: () => ({}),
    });

    dispatchPointer(launcher, "pointerdown", 320, 320);
    dispatchPointer(launcher, "pointermove", window.innerWidth + 100, 320);
    dispatchPointer(launcher, "pointerup", window.innerWidth + 100, 320);
    expect(host.dataset.edgeHidden).toBe("true");

    host.dispatchEvent(new PointerEvent("pointerenter"));
    expect(host.dataset.edgeHidden).toBe("true");
    expect(root.querySelector("style")?.textContent).not.toContain(
      '[data-edge-hidden="true"]:hover',
    );
    expect(root.querySelector("style")?.textContent).toContain(
      '[data-docked-edge="right"]) .launcher-surface::before',
    );
    control.destroy();
  });

  it("opens from the visible edge wake tab without moving the hit target", () => {
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const panel = root.querySelector<HTMLElement>(".panel");
    if (!launcher || !panel) throw new Error("missing floating control");

    host.style.left = "302px";
    host.style.top = "176px";
    host.dataset.dockedEdge = "right";
    host.dataset.edgeHidden = "true";

    dispatchPointer(launcher, "pointerdown", 359, 200);
    expect(host.dataset.edgeHidden).toBe("true");
    dispatchPointer(launcher, "pointerup", 359, 200);
    launcher.click();

    expect(host.dataset.edgeHidden).toBe("false");
    expect(launcher.getAttribute("aria-expanded")).toBe("true");
    expect(panel.hidden).toBe(false);
    control.destroy();
  });

  it("reveals a hidden edge control only after an actual drag starts", () => {
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    if (!launcher) throw new Error("missing launcher");

    host.style.left = "302px";
    host.style.top = "176px";
    host.dataset.dockedEdge = "right";
    host.dataset.edgeHidden = "true";

    dispatchPointer(launcher, "pointerdown", 359, 200);
    dispatchPointer(launcher, "pointermove", 362, 200);
    expect(host.dataset.edgeHidden).toBe("true");

    dispatchPointer(launcher, "pointermove", 340, 220);
    expect(host.dataset.edgeHidden).toBe("false");
    dispatchPointer(launcher, "pointerup", 340, 220);
    control.destroy();
  });

  it("docks and hides at the top and right edges too", () => {
    const cases = [
      {
        x: 320,
        y: -100,
        edge: "top",
        expected: `${10}px`,
        property: "top" as const,
      },
      {
        x: window.innerWidth + 100,
        y: 320,
        edge: "right",
        expected: `${window.innerWidth - 58}px`,
        property: "left" as const,
      },
    ];

    for (const testCase of cases) {
      sessionStorage.clear();
      const { control, host, root } = createControl();
      const launcher = root.querySelector<HTMLButtonElement>(".launcher");
      if (!launcher) throw new Error("missing launcher");
      vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
        x: 300,
        y: 300,
        left: 300,
        top: 300,
        right: 348,
        bottom: 348,
        width: 48,
        height: 48,
        toJSON: () => ({}),
      });

      dispatchPointer(launcher, "pointerdown", 320, 320);
      dispatchPointer(launcher, "pointermove", testCase.x, testCase.y);
      dispatchPointer(launcher, "pointerup", testCase.x, testCase.y);

      expect(host.dataset.dockedEdge).toBe(testCase.edge);
      expect(host.dataset.edgeHidden).toBe("true");
      expect(host.style[testCase.property]).toBe(testCase.expected);
      control.destroy();
    }
  });

  it("clamps a stored launcher position after the viewport shrinks", () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    const { control, host } = createControl();
    host.style.left = "900px";
    host.style.top = "700px";
    host.style.right = "auto";
    host.style.bottom = "auto";
    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 375,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 640,
      });
      window.dispatchEvent(new Event("resize"));
      expect(host.style.left).toBe("317px");
      expect(host.style.top).toBe("582px");
      expect(host.dataset.dockedEdge).toBe("right");
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalHeight,
      });
      control.destroy();
    }
  });

  it("collapses the panel but keeps the launcher available in fullscreen", async () => {
    const { control, host, root, onHideCurrent } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const panel = root.querySelector<HTMLElement>(".panel");
    const hideButton = root.querySelector<HTMLButtonElement>(
      ".panel-menu-popover button",
    );
    const visibilityLink = root.querySelector<HTMLAnchorElement>(
      '.panel-menu-popover a[href$="options.html#visibility"]',
    );
    const settingsLink = root.querySelector<HTMLAnchorElement>(
      '.panel-menu-popover a[href$="options.html"]',
    );
    if (
      !launcher ||
      !panel ||
      !hideButton ||
      !visibilityLink ||
      !settingsLink
    ) {
      throw new Error("missing lifecycle controls");
    }
    expect(settingsLink.textContent).toBe("optionsTitle");
    expect(root.querySelector(".dismiss-actions")).toBeNull();

    launcher.click();
    const menu = root.querySelector<HTMLDetailsElement>(".panel-menu");
    if (!menu) throw new Error("missing panel menu");
    menu.open = true;
    expect(root.activeElement).toBe(
      root.querySelector("#norixortrans-page-panel-tab"),
    );
    root
      .querySelector<HTMLElement>("#norixortrans-page-panel")
      ?.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, composed: true }),
      );
    expect(menu.open).toBe(false);
    expect(panel.hidden).toBe(false);
    menu.open = true;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(menu.open).toBe(false);
    expect(panel.hidden).toBe(false);
    expect(root.activeElement).toBe(menu.querySelector("summary"));
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, composed: true }),
    );
    expect(panel.hidden).toBe(true);
    expect(menu.open).toBe(false);
    expect(root.activeElement).toBe(launcher);
    launcher.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(panel.hidden).toBe(true);
    expect(root.activeElement).toBe(launcher);

    launcher.click();
    const subtitleOverlay = document.createElement("norixor-subtitle-overlay");
    document.body.append(subtitleOverlay);
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: document.body,
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host.dataset.fullscreenHidden).toBe("false");
    expect(host.parentElement).toBe(document.body);
    expect(panel.hidden).toBe(true);
    expect(launcher.hidden).toBe(false);
    expect(subtitleOverlay.hidden).toBe(false);
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host.dataset.fullscreenHidden).toBe("false");
    expect(host.parentElement).toBe(document.documentElement);

    hideButton.click();
    expect(onHideCurrent).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(host.dataset.hidden).toBe("true"));
    control.destroy();
    expect(host.isConnected).toBe(false);
  });

  it("permanently hides through the shared visibility setting", async () => {
    const { control, host, root } = createControl();
    vi.mocked(browser.runtime.sendMessage).mockResolvedValueOnce({
      ok: true,
    } as never);
    const permanentButton = Array.from(
      root.querySelectorAll<HTMLButtonElement>(".panel-menu-popover button"),
    ).find((button) => button.textContent === "disableFloatingPermanently");
    const visibilityLink = root.querySelector<HTMLAnchorElement>(
      '.panel-menu-popover a[href$="options.html#visibility"]',
    );
    if (!permanentButton || !visibilityLink) {
      throw new Error("missing permanent visibility controls");
    }

    permanentButton.click();

    await vi.waitFor(() =>
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        type: "FLOATING_BUTTON_SET",
        surface: "all",
        enabled: false,
      }),
    );
    expect(host.dataset.hidden).toBe("true");
    expect(visibilityLink.textContent).toBe("manageVisibilityMemory");
    control.destroy();
  });

  it("restores edge-hidden launcher state after leaving fullscreen", () => {
    const { control, host } = createControl();
    host.style.left = "10px";
    host.style.top = "100px";
    host.dataset.dockedEdge = "left";
    host.dataset.edgeHidden = "true";

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: document.body,
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host.dataset.edgeHidden).toBe("false");

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: null,
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(host.dataset.dockedEdge).toBe("left");
    expect(host.dataset.edgeHidden).toBe("true");
    control.destroy();
  });

  it("keeps a docked wake handle attached across fullscreen viewport changes", () => {
    const originalWidth = window.innerWidth;
    const { control, host, root } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const panel = root.querySelector<HTMLElement>(".panel");
    if (!launcher || !panel) throw new Error("missing launcher");
    host.style.left = `${originalWidth - 58}px`;
    host.style.top = "100px";
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.dataset.dockedEdge = "right";
    host.dataset.edgeHidden = "true";

    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth + 400,
      });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: document.body,
      });
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(host.dataset.dockedEdge).toBe("right");
      expect(host.dataset.edgeHidden).toBe("false");
      expect(host.style.left).toBe(`${originalWidth + 342}px`);

      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: null,
      });
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(host.dataset.dockedEdge).toBe("right");
      expect(host.dataset.edgeHidden).toBe("true");
      expect(host.style.left).toBe(`${originalWidth - 58}px`);

      launcher.click();
      expect(host.dataset.edgeHidden).toBe("false");
      expect(panel.hidden).toBe(false);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      control.destroy();
    }
  });

  it("restores a free launcher position after a narrower fullscreen viewport", () => {
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    const onPositionChange = vi.fn();
    const { control, host } = createControl({ onPositionChange });
    host.style.left = "600px";
    host.style.top = "500px";
    host.style.right = "auto";
    host.style.bottom = "auto";
    delete host.dataset.dockedEdge;

    try {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: 500,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: 400,
      });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: document.body,
      });
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(host.style.left).toBe("442px");
      expect(host.style.top).toBe("342px");
      expect(onPositionChange).not.toHaveBeenCalled();

      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalHeight,
      });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        value: null,
      });
      document.dispatchEvent(new Event("fullscreenchange"));

      expect(host.style.left).toBe("600px");
      expect(host.style.top).toBe("500px");
      expect(host.dataset.dockedEdge).toBeUndefined();
      expect(onPositionChange).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalWidth,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalHeight,
      });
      control.destroy();
    }
  });

  it("keeps the panel visible and retryable when hiding this page fails", async () => {
    const { control, host, root, onHideCurrent } = createControl();
    const launcher = root.querySelector<HTMLButtonElement>(".launcher");
    const panel = root.querySelector<HTMLElement>(".panel");
    const status = root.querySelector<HTMLElement>(
      "#norixortrans-page-panel .status",
    );
    const hideButton = root.querySelector<HTMLButtonElement>(
      ".panel-menu-popover button",
    );
    if (!launcher || !panel || !status || !hideButton) {
      throw new Error("missing hide controls");
    }

    launcher.click();
    onHideCurrent.mockRejectedValueOnce(new Error("storage unavailable"));
    hideButton.click();
    await vi.waitFor(() =>
      expect(status.textContent).toBe("floatingHideFailed"),
    );
    expect(panel.hidden).toBe(false);
    expect(host.dataset.hidden).not.toBe("true");
    expect(hideButton.disabled).toBe(false);

    hideButton.click();
    await vi.waitFor(() => expect(host.dataset.hidden).toBe("true"));
    expect(onHideCurrent).toHaveBeenCalledTimes(2);
    control.destroy();
  });

  it.each([
    ["translate", "onPageTranslate"],
    ["restore", "onPageRestore"],
  ] as const)(
    "shows a retryable page action error when %s broadcasting fails",
    async (action, callbackName) => {
      const fixture = createControl();
      const { control, root } = fixture;
      const buttons = root.querySelectorAll<HTMLButtonElement>(
        "#norixortrans-page-panel .actions button",
      );
      const button = buttons[action === "translate" ? 0 : 1];
      const statusRow = root.querySelector<HTMLElement>(
        "#norixortrans-page-panel .status-row",
      );
      const status = statusRow?.querySelector<HTMLElement>(".status");
      if (!button || !statusRow || !status) {
        throw new Error("missing page action controls");
      }

      if (action === "restore") {
        control.updatePageStatus({
          state: "translated",
          total: 1,
          completed: 1,
          failed: 0,
        });
      }

      fixture[callbackName].mockRejectedValueOnce(
        new Error("broadcast failed"),
      );
      button.click();

      await vi.waitFor(() =>
        expect(status.textContent).toBe("pageActionFailed"),
      );
      expect(statusRow.dataset.state).toBe("error");
      expect(button.disabled).toBe(false);

      button.click();
      await vi.waitFor(() =>
        expect(fixture[callbackName]).toHaveBeenCalledTimes(2),
      );
      control.destroy();
    },
  );

  it("keeps compact responsive, focus, and motion rules explicit", () => {
    const { control, root } = createControl();
    const style = root.querySelector("style")?.textContent ?? "";
    expect(style).toContain("min-height: 44px");
    expect(style).toContain("height: 36px");
    expect(style).toContain(".header-actions > .icon-button");
    expect(style).toContain("width: 48px");
    expect(style).toContain("@media (max-width: 375px)");
    expect(style).toContain(".ocr-section > summary { min-height: 44px; }");
    expect(style).toContain("select { height: 44px; min-height: 44px; }");
    expect(style).toContain(":focus-visible");
    expect(style).toContain(".tab-panel:focus-visible");
    expect(style).not.toContain("outline: none");
    expect(style).toContain("prefers-reduced-motion: no-preference");
    expect(style).toContain("prefers-reduced-motion: reduce");
    expect(style).toContain("overflow: visible !important");
    expect(style).toContain("writing-mode: horizontal-tb !important");
    control.destroy();
  });

  it("ignores unavailable session storage", () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementationOnce(() => {
        throw new DOMException("blocked");
      });
    let created: ReturnType<typeof createControl> | undefined;
    expect(() => {
      created = createControl();
    }).not.toThrow();
    getItem.mockRestore();
    created?.control.destroy();
  });
});
