import type { SubtitleStatus } from "@/src/messaging/protocol";
import { STATUS_REASON } from "@/src/shared/status-reasons";
import {
  DEFAULT_SETTINGS,
  toContentSettings,
  type ContentSettings,
} from "@/src/shared/settings";
import type { NtButton, NtPillFab } from "@/src/ui/components";
import {
  FloatingControl,
  type FloatingControlOptions,
} from "@/src/ui/floating";
import { queryDocumentTranslationCapabilities } from "@/src/translation/provider-capabilities";
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
  message: (key: string, subs?: string | string[]) =>
    subs && subs.length > 0 ? `${key}(${[subs].flat().join(",")})` : key,
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

let control: FloatingControl | undefined;

afterEach(() => {
  control?.destroy();
  control = undefined;
  sessionStorage.clear();
  vi.useRealTimers();
});

function settingsWith(
  subtitles: Partial<ContentSettings["subtitles"]> = {},
): ContentSettings {
  const base = toContentSettings(DEFAULT_SETTINGS);
  return { ...base, subtitles: { ...base.subtitles, ...subtitles } };
}

function subtitle(partial: Partial<SubtitleStatus>): SubtitleStatus {
  return { state: "waiting", total: 0, completed: 0, failed: 0, ...partial };
}

async function openVideo(overrides: Partial<FloatingControlOptions> = {}) {
  const spies = {
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
  };
  const options: FloatingControlOptions = {
    settings: settingsWith(),
    ...spies,
    ...overrides,
  };
  control = new FloatingControl(options);
  const root = document.querySelector<HTMLElement>(
    '[data-noritrans-ui="floating-control"]',
  )?.shadowRoot;
  if (!root) throw new Error("missing floating control");
  root.querySelector<NtPillFab>("nt-pill-fab")!.click();
  await tick();
  root
    .querySelector("nt-tabs")!
    .dispatchEvent(new CustomEvent("nt-change", { detail: { id: "video" } }));
  await tick();
  const q = <T extends Element = Element>(selector: string) =>
    root.querySelector<T>(`[data-tab="video"] ${selector}`);
  const card = () => q("nt-status-card")!;
  const primary = () => q<NtButton>('nt-button[data-primary="true"]');
  const action = (id: string) => q<NtButton>(`nt-button[data-action="${id}"]`);
  const chips = () =>
    Array.from(root.querySelectorAll('[data-tab="video"] nt-chip')).map(
      (chip) => chip.getAttribute("data-track"),
    );
  const summary = () => q(".summary-text")?.textContent ?? "";
  const notice = () => q("nt-note.notice")?.textContent ?? "";
  const openEditor = async () => {
    q("nt-quick-line")!.dispatchEvent(
      new CustomEvent("nt-action", { bubbles: true }),
    );
    await tick();
  };
  const field = (name: string) => q(`.editor [data-field="${name}"]`);
  const change = async (name: string, detail: object) => {
    field(name)!.dispatchEvent(
      new CustomEvent("change", { bubbles: true, detail }),
    );
    await tick();
  };
  return {
    spies,
    root,
    card,
    primary,
    action,
    chips,
    summary,
    notice,
    openEditor,
    field,
    change,
  };
}

describe("FloatingControl video tab · state card", () => {
  it("shows 'off' with how to turn it on, never 'no subtitles found'", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: false }) });
    control!.updateSubtitleStatus(subtitle({ state: "unavailable" }));
    await tick();
    expect(ui.card().getAttribute("heading")).toBe(
      "statusTitleDisabledSubtitle",
    );
    expect(ui.card().getAttribute("description")).toBe(
      "floatingVideoDisabledSettingsHint",
    );
    expect(ui.chips()).toEqual([]);
    // Without an on/off callback the only way is the options page.
    expect(ui.primary()!.textContent?.trim()).toBe(
      "floatingVideoOpenSubtitleSettings",
    );
    ui.primary()!.click();
    await tick();
    expect(ui.spies.onOpenSettings).toHaveBeenCalledWith(undefined);
  });

  it("turns subtitle translation on and off through the callback", async () => {
    let settings = settingsWith({ enabled: false });
    const onSubtitleEnabledChange = vi.fn((enabled: boolean) => {
      settings = settingsWith({ enabled });
    });
    const ui = await openVideo({ settings, onSubtitleEnabledChange });
    expect(ui.card().getAttribute("description")).toBe(
      "floatingVideoDisabledHint",
    );
    expect(ui.primary()!.textContent?.trim()).toBe("statusActionEnable");
    ui.primary()!.click();
    await tick();
    expect(onSubtitleEnabledChange).toHaveBeenCalledWith(true);
    // Transitional label holds until the settings confirm the change.
    expect(ui.primary()!.busy).toBe(true);
    expect(ui.primary()!.textContent?.trim()).toBe("statusActionEnabling");
    control!.updateSettings(settings);
    control!.updateSubtitleStatus(subtitle({ state: "waiting" }));
    await tick();
    expect(ui.card().getAttribute("heading")).toBe(
      "statusTitleWaitingSubtitle",
    );
    expect(ui.primary()!.dataset.action).toBe("disable");
    ui.primary()!.click();
    await tick();
    expect(onSubtitleEnabledChange).toHaveBeenLastCalledWith(false);
    expect(ui.primary()!.busy).toBe(true);
    control!.updateSettings(settings);
    await tick();
    expect(ui.card().getAttribute("heading")).toBe(
      "statusTitleDisabledSubtitle",
    );

    // The editor switch shares the same path.
    await ui.openEditor();
    expect(ui.field("enabled")).not.toBeNull();
    await ui.change("enabled", { checked: true });
    expect(onSubtitleEnabledChange).toHaveBeenLastCalledWith(true);
  });

  it("does not offer 'turn off' when the host cannot switch the feature", async () => {
    const ui = await openVideo();
    control!.updateSubtitleStatus(subtitle({ state: "waiting" }));
    await tick();
    expect(ui.primary()).toBeNull();
    control!.updateSubtitleStatus(
      subtitle({
        state: "ready",
        completeness: "full",
        total: 40,
        completed: 40,
      }),
    );
    await tick();
    expect(ui.action("disable")).toBeNull();
    expect(ui.action("switchDisplay")).not.toBeNull();
  });

  it("runs stop, continue and retry with transitional labels and real progress", async () => {
    const onSubtitleRetryFailed = vi.fn();
    const ui = await openVideo({ onSubtitleRetryFailed });
    control!.updateSubtitleStatus(
      subtitle({
        state: "translating",
        completeness: "full",
        total: 412,
        completed: 128,
      }),
    );
    await tick();
    expect(ui.chips()).toEqual(["full"]);
    expect(ui.card().getAttribute("heading")).toBe(
      "statusTitleTranslatingSubtitle(128,412)",
    );
    expect((ui.card() as unknown as { progress: number }).progress).toBeCloseTo(
      128 / 412,
    );
    ui.primary()!.click();
    await tick();
    expect(ui.spies.onSubtitleCancel).toHaveBeenCalledTimes(1);
    expect(ui.primary()!.textContent?.trim()).toBe("statusActionStopping");
    ui.primary()!.click();
    await tick();
    expect(ui.spies.onSubtitleCancel).toHaveBeenCalledTimes(1);

    control!.updateSubtitleStatus(
      subtitle({
        state: "cancelled",
        completeness: "full",
        total: 412,
        completed: 128,
      }),
    );
    await tick();
    expect(ui.card().getAttribute("heading")).toBe(
      "statusTitleCancelled(128,412)",
    );
    expect(ui.primary()!.dataset.action).toBe("resume");
    ui.primary()!.click();
    await tick();
    expect(ui.spies.onSubtitleStart).toHaveBeenCalledTimes(1);
    expect(ui.primary()!.textContent?.trim()).toBe("statusActionResuming");

    control!.updateSubtitleStatus(
      subtitle({
        state: "partial",
        completeness: "full",
        total: 412,
        completed: 404,
        failed: 8,
        reasonCode: "invalid_response",
      }),
    );
    await tick();
    expect(ui.primary()!.textContent?.trim()).toBe("statusActionRetryCues(8)");
    ui.primary()!.click();
    await tick();
    expect(onSubtitleRetryFailed).toHaveBeenCalledTimes(1);
    control!.updateSubtitleStatus(
      subtitle({
        state: "translating",
        completeness: "full",
        total: 412,
        completed: 409,
      }),
    );
    await tick();
    expect(ui.card().getAttribute("heading")).toBe(
      "statusTitleRetryingSubtitle(5,8)",
    );
  });

  it("falls back to start for retry and reports a failed task action", async () => {
    const ui = await openVideo({
      onSubtitleStart: vi.fn(() => Promise.reject(new Error("x"))),
    });
    control!.updateSubtitleStatus(
      subtitle({
        state: "partial",
        completeness: "full",
        total: 10,
        completed: 8,
        failed: 2,
      }),
    );
    await tick();
    ui.primary()!.click();
    await tick();
    await tick();
    expect(ui.primary()!.busy).toBe(false);
    expect(ui.primary()!.dataset.action).toBe("retry");
    expect(ui.notice()).toContain("subtitleTaskActionFailed");
  });

  it("offers a rescan, not 'enable', when discovery ended without a track", async () => {
    let resolveStart: () => void = () => undefined;
    const onSubtitleStart = vi.fn(
      () => new Promise<void>((resolve) => (resolveStart = resolve)),
    );
    const ui = await openVideo({ onSubtitleStart });
    control!.updateSubtitleStatus(
      subtitle({
        state: "unavailable",
        reasonCode: STATUS_REASON.subtitleNoTrack,
      }),
    );
    await tick();
    expect(ui.card().getAttribute("description")).toBe("statusReasonNoTrack");
    expect(ui.primary()!.dataset.action).toBe("rescan");
    expect(ui.primary()!.textContent?.trim()).toBe("statusActionRescan");
    ui.primary()!.click();
    await tick();
    expect(onSubtitleStart).toHaveBeenCalledTimes(1);
    // Frozen in place with a spinner until the scan restarts.
    expect(ui.primary()!.dataset.action).toBe("rescan");
    expect(ui.primary()!.busy).toBe(true);
    resolveStart();
    await tick();
    control!.updateSubtitleStatus(subtitle({ state: "waiting" }));
    await tick();
    expect(ui.primary()?.dataset.action).not.toBe("rescan");
  });

  it("offers provider settings for a partial result that needs them", async () => {
    const ui = await openVideo();
    control!.updateSubtitleStatus(
      subtitle({
        state: "partial",
        completeness: "full",
        total: 10,
        completed: 8,
        failed: 2,
        reasonCode: "invalid_configuration",
      }),
    );
    await tick();
    ui.action("openProviderSettings")!.click();
    await tick();
    expect(ui.spies.onOpenSettings).toHaveBeenCalledWith("providers");
  });

  it("switches to auto-detect when the subtitle language does not match", async () => {
    const ui = await openVideo({
      settings: settingsWith({ sourceLanguage: "en" }),
    });
    control!.updateSubtitleStatus(
      subtitle({
        state: "unavailable",
        reasonCode: "source_language_mismatch",
      }),
    );
    await tick();
    expect(ui.card().getAttribute("heading")).toBe(
      "statusTitleUnavailableSubtitleLanguage",
    );
    ui.action("useAutoDetect")!.click();
    await tick();
    expect(ui.spies.onSubtitleSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ sourceLanguage: "auto" }),
    );
  });
});

describe("FloatingControl video tab · live tracks (AGENTS §8)", () => {
  it("says a stream track falls back to fast translation even in AI mode", async () => {
    const ui = await openVideo();
    expect(DEFAULT_SETTINGS.subtitles.mode).toBe("ai");
    control!.updateSubtitleStatus(
      subtitle({
        state: "translating",
        source: "dom",
        completeness: "stream",
        total: 12,
        completed: 11,
      }),
    );
    await tick();
    expect(ui.chips()).toEqual(["stream"]);
    expect(ui.card().getAttribute("heading")).toBe("statusTitleLiveSubtitle");
    expect(ui.card().getAttribute("description")).toBe(
      "statusReasonStreamFallback",
    );
    // No pre-translation progress for a live track.
    expect((ui.card() as unknown as { progress: unknown }).progress).toBeNull();
    expect(ui.summary()).toContain("floatingVideoFastFallbackSummary");
    await ui.openEditor();
    expect(ui.root.querySelector(".fallback-note")?.textContent).toContain(
      "floatingVideoStreamFastNote",
    );

    // Choosing a fast method removes the fallback marker.
    await ui.change("method", { value: "fast:chrome-local" });
    expect(ui.summary()).not.toContain("floatingVideoFastFallbackSummary");
    expect(ui.root.querySelector(".fallback-note")).toBeNull();
  });

  it("labels OCR as live and experimental with local-only translation", async () => {
    const ui = await openVideo();
    control!.updateSubtitleStatus(
      subtitle({
        state: "ready",
        source: "ocr",
        completeness: "stream",
        total: 5,
        completed: 5,
      }),
    );
    await tick();
    expect(ui.chips()).toEqual(["stream", "experimental"]);
    expect(ui.card().getAttribute("description")).toBe(
      "statusReasonOcrLocalOnly",
    );
    expect(ui.summary()).toContain("floatingVideoFastFallbackSummary");
    await ui.openEditor();
    expect(ui.root.querySelector(".fallback-note")?.textContent).toContain(
      "floatingVideoOcrFastNote",
    );
  });

  it("has no fallback marker for a full track", async () => {
    const ui = await openVideo();
    control!.updateSubtitleStatus(
      subtitle({
        state: "ready",
        completeness: "full",
        total: 3,
        completed: 3,
      }),
    );
    await tick();
    expect(ui.summary()).not.toContain("floatingVideoFastFallbackSummary");
  });
});

describe("FloatingControl video tab · settings", () => {
  it("sends the full patch like the previous control", async () => {
    const ui = await openVideo();
    await ui.openEditor();
    const base = {
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      mode: "ai",
      aiResponseMode: "stream",
      displayMode: "bilingual",
      hideNativeSubtitles: false,
      fontScale: 1.2,
      backgroundOpacity: 0.5,
    };
    await ui.change("target", { value: "ja" });
    expect(ui.spies.onSubtitleSettingsChange).toHaveBeenLastCalledWith({
      ...base,
      targetLanguage: "ja",
    });
    await ui.change("display", { value: "original" });
    expect(ui.spies.onSubtitleSettingsChange).toHaveBeenLastCalledWith({
      ...base,
      targetLanguage: "ja",
      displayMode: "original",
    });
    await ui.change("hide-native", { checked: true });
    await ui.change("response", { value: "batch" });
    expect(ui.spies.onSubtitleSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        hideNativeSubtitles: true,
        aiResponseMode: "batch",
      }),
    );

    // A fast method re-sends its provider; appearance steps never do.
    await ui.change("method", { value: "fast:bergamot-local" });
    expect(ui.spies.onSubtitleSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "fast" }),
      "bergamot-local",
    );
    expect(ui.field("response")).toBeNull();
    await ui.change("source", { value: "en" });
    expect(ui.spies.onSubtitleSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceLanguage: "en", mode: "fast" }),
      "bergamot-local",
    );
    await ui.change("font", { value: 1.3 });
    const last = ui.spies.onSubtitleSettingsChange.mock.lastCall!;
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ fontScale: 1.3, sourceLanguage: "en" });
    await ui.change("opacity", { value: 0.65 });
    expect(ui.spies.onSubtitleSettingsChange.mock.lastCall![0]).toMatchObject({
      backgroundOpacity: 0.65,
      fontScale: 1.3,
    });
    expect(ui.summary()).toContain("displayOriginal");
  });

  it("merges changes made while a save is in flight into one follow-up save", async () => {
    const resolvers: (() => void)[] = [];
    const onSubtitleSettingsChange = vi.fn(
      () => new Promise<void>((resolve) => resolvers.push(resolve)),
    );
    const ui = await openVideo({ onSubtitleSettingsChange });
    await ui.openEditor();
    await ui.change("font", { value: 1.25 });
    // Steppers stay usable while saving; other fields lock.
    expect(ui.field("display")!.hasAttribute("disabled")).toBe(true);
    expect(ui.field("font")!.hasAttribute("disabled")).toBe(false);
    await ui.change("font", { value: 1.3 });
    await ui.change("opacity", { value: 0.6 });
    expect(onSubtitleSettingsChange).toHaveBeenCalledTimes(1);
    resolvers[0]!();
    await tick();
    expect(onSubtitleSettingsChange).toHaveBeenCalledTimes(2);
    expect(onSubtitleSettingsChange.mock.lastCall).toEqual([
      expect.objectContaining({ fontScale: 1.3, backgroundOpacity: 0.6 }),
    ]);
    resolvers[1]!();
    await tick();
    expect(onSubtitleSettingsChange).toHaveBeenCalledTimes(2);
  });

  it("reverts and reports a failed save", async () => {
    const ui = await openVideo({
      onSubtitleSettingsChange: vi.fn(() => Promise.reject(new Error("x"))),
    });
    await ui.openEditor();
    await ui.change("display", { value: "translated" });
    await tick();
    expect(ui.notice()).toContain("settingsSaveFailed");
    expect(ui.summary()).toContain("displayBilingual");
    await ui.change("font", { value: 1.4 });
    await tick();
    expect((ui.field("font") as unknown as { value: number }).value).toBe(1.2);
  });

  it("previews stepper input before it is committed", async () => {
    const ui = await openVideo();
    await ui.openEditor();
    ui.field("font")!.dispatchEvent(
      new CustomEvent("nt-input", { bubbles: true, detail: { value: 1.35 } }),
    );
    await tick();
    expect(ui.spies.onSubtitleSettingsChange).not.toHaveBeenCalled();
    expect((ui.field("font") as unknown as { value: number }).value).toBe(1.35);
  });

  it("saves a position preset only when the host supports it", async () => {
    const plain = await openVideo();
    await plain.openEditor();
    expect(plain.field("position")).toBeNull();
    control!.destroy();

    const onSubtitlePositionChange = vi.fn();
    const ui = await openVideo({
      settings: settingsWith({ position: "custom" }),
      onSubtitlePositionChange,
    });
    await ui.openEditor();
    const select = ui.field("position") as unknown as {
      options: { value: string; disabled?: boolean }[];
      value: string;
    };
    expect(select.value).toBe("custom");
    expect(select.options.find((o) => o.value === "custom")?.disabled).toBe(
      true,
    );
    await ui.change("position", { value: "top" });
    expect(onSubtitlePositionChange).toHaveBeenCalledWith("top");
  });

  it("collapses the panel before starting the profile wizard", async () => {
    const ui = await openVideo();
    await ui.openEditor();
    (ui.field("profile") as HTMLElement).click();
    await tick();
    expect(ui.spies.onCreateProfile).toHaveBeenCalledTimes(1);
    expect(control!.isExpanded).toBe(false);
  });

  it("blocks starting work when the method cannot handle the pair", async () => {
    vi.mocked(queryDocumentTranslationCapabilities).mockResolvedValueOnce({
      chromePairs: [],
      installedBergamotPackIds: [],
    });
    const ui = await openVideo({
      settings: settingsWith({
        mode: "fast",
        sourceLanguage: "en",
        fastProviderOverride: "chrome-local",
      }),
    });
    control!.updateSubtitleStatus(
      subtitle({
        state: "cancelled",
        completeness: "full",
        total: 4,
        completed: 1,
      }),
    );
    await tick();
    expect(ui.primary()!.dataset.action).toBe("resume");
    expect(ui.primary()!.disabled).toBe(true);
    expect(ui.notice()).toContain("floatingPairUnavailable");
  });
});

describe("FloatingControl video tab · races and outcomes", () => {
  it("holds subtitle fields while a save runs and then adopts a newer snapshot", async () => {
    let resolveSave: () => void = () => undefined;
    const onSubtitleSettingsChange = vi.fn(
      () => new Promise<void>((resolve) => (resolveSave = resolve)),
    );
    const ui = await openVideo({ onSubtitleSettingsChange });
    await ui.openEditor();
    const value = (name: string) =>
      (ui.field(name) as unknown as { value: string }).value;
    const checked = (name: string) =>
      (ui.field(name) as unknown as { checked: boolean }).checked;

    await ui.change("hide-native", { checked: true });
    expect(onSubtitleSettingsChange).toHaveBeenCalledTimes(1);
    expect(checked("hide-native")).toBe(true);
    expect(ui.field("source")!.hasAttribute("disabled")).toBe(true);
    expect(ui.field("hide-native")!.hasAttribute("disabled")).toBe(true);

    control!.updateSettings(
      settingsWith({
        sourceLanguage: "de",
        targetLanguage: "ja",
        hideNativeSubtitles: false,
      }),
    );
    await tick();
    // The in-flight patch keeps showing what the user asked for.
    expect(checked("hide-native")).toBe(true);
    expect(ui.field("source")!.hasAttribute("disabled")).toBe(true);

    resolveSave();
    await tick();
    // The newer snapshot already carries the saved state and wins.
    expect(ui.field("source")!.hasAttribute("disabled")).toBe(false);
    expect(value("source")).toBe("de");
    expect(value("target")).toBe("ja");
    expect(checked("hide-native")).toBe(false);
  });

  it("keeps stop available while a slow continue request is still pending", async () => {
    let resolveStart: () => void = () => undefined;
    const onSubtitleStart = vi.fn(
      () => new Promise<void>((resolve) => (resolveStart = resolve)),
    );
    const ui = await openVideo({ onSubtitleStart });
    const full = { completeness: "full" as const, total: 3 };
    control!.updateSubtitleStatus(subtitle({ ...full, state: "cancelled" }));
    await tick();
    expect(ui.primary()!.dataset.action).toBe("resume");
    ui.primary()!.click();
    await tick();
    expect(onSubtitleStart).toHaveBeenCalledTimes(1);
    expect(ui.primary()!.busy).toBe(true);
    ui.primary()!.click();
    await tick();
    expect(onSubtitleStart).toHaveBeenCalledTimes(1);

    // The task started before the start request settled.
    control!.updateSubtitleStatus(subtitle({ ...full, state: "translating" }));
    await tick();
    expect(ui.primary()!.dataset.action).toBe("stop");
    expect(ui.primary()!.busy).toBe(false);
    expect(ui.primary()!.disabled).toBe(false);
    ui.primary()!.click();
    await tick();
    expect(ui.spies.onSubtitleCancel).toHaveBeenCalledTimes(1);

    control!.updateSubtitleStatus(
      subtitle({ ...full, state: "cancelled", failed: 3 }),
    );
    await tick();
    expect(ui.primary()!.dataset.action).toBe("resume");
    expect(ui.primary()!.busy).toBe(false);
    resolveStart();
    await tick();
    expect(ui.primary()!.dataset.action).toBe("resume");
    expect(ui.primary()!.busy).toBe(false);
    expect(ui.primary()!.disabled).toBe(false);
  });

  // Replaces the removed `stableSubtitleDisplayState`: a running task stays
  // running while failures accumulate, a cancellation stays a cancellation,
  // and only terminal reports split into partial and error.
  it("keeps running and cancelled outcomes stable while failures accumulate", async () => {
    const ui = await openVideo();
    const full = { completeness: "full" as const, total: 2 };
    const show = async (partial: Partial<SubtitleStatus>) => {
      control!.updateSubtitleStatus(subtitle({ ...full, ...partial }));
      await tick();
      return ui.card().getAttribute("state");
    };

    expect(await show({ state: "translating", completed: 0, failed: 1 })).toBe(
      "translating",
    );
    expect(ui.primary()!.dataset.action).toBe("stop");
    expect(await show({ state: "translating", completed: 1, failed: 1 })).toBe(
      "translating",
    );
    expect(await show({ state: "cancelled", completed: 1, failed: 1 })).toBe(
      "cancelled",
    );
    expect(ui.card().getAttribute("heading")).toBe("statusTitleCancelled(1,2)");
    expect(await show({ state: "partial", completed: 1, failed: 1 })).toBe(
      "partial",
    );
    expect(await show({ state: "partial", completed: 0, failed: 2 })).toBe(
      "error",
    );
    expect(await show({ state: "error", completed: 1, failed: 1 })).toBe(
      "partial",
    );
  });

  it("shows bounded provider diagnostics for a result with details", async () => {
    const ui = await openVideo();
    const diag = () =>
      ui.root.querySelector<HTMLDetailsElement>(
        '[data-tab="video"] details.diag',
      );
    control!.updateSubtitleStatus(
      subtitle({
        state: "partial",
        source: "texttrack",
        completeness: "full",
        total: 2,
        completed: 1,
        failed: 1,
        details: `Unknown result ID: subtitle-extra.${"x".repeat(5_000)}`,
      }),
    );
    await tick();
    expect(diag()!.querySelector("summary")?.textContent).toBe(
      "viewProviderDetails",
    );
    const text = diag()!.querySelector("pre")?.textContent?.trim() ?? "";
    expect(text).toContain("subtitle-extra");
    expect(text).toHaveLength(4_000);

    control!.updateSubtitleStatus(
      subtitle({
        state: "ready",
        completeness: "full",
        total: 2,
        completed: 2,
      }),
    );
    await tick();
    expect(diag()).toBeNull();
  });
});
