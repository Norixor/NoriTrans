import type { SubtitleStatus } from "@/src/messaging/protocol";
import { OCR_REASON, type OcrStatus } from "@/src/ocr/types";
import {
  DEFAULT_SETTINGS,
  toContentSettings,
  type ContentSettings,
} from "@/src/shared/settings";
import { STATUS_REASON } from "@/src/shared/status-reasons";
import type { NtButton, NtPillFab } from "@/src/ui/components";
import {
  FloatingControl,
  type FloatingControlOptions,
} from "@/src/ui/floating";
import {
  ocrCardView,
  ocrOwnsCard,
  ocrPhase,
  ocrShellView,
  type OcrViewInput,
} from "@/src/ui/floating/ocr-view";
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
});

function settingsWith(
  ocr: Partial<ContentSettings["ocr"]> = {},
): ContentSettings {
  const base = toContentSettings(DEFAULT_SETTINGS);
  return { ...base, ocr: { ...base.ocr, ...ocr } };
}

function subtitle(partial: Partial<SubtitleStatus> = {}): SubtitleStatus {
  return {
    state: "unavailable",
    total: 0,
    completed: 0,
    failed: 0,
    ...partial,
  };
}

const NO_TRACK = subtitle({ reasonCode: STATUS_REASON.subtitleNoTrack });

function input(partial: Partial<OcrViewInput> = {}): OcrViewInput {
  return {
    status: { state: "idle", recognized: 0 },
    enabled: true,
    subtitle: NO_TRACK,
    dismissed: false,
    runtime: "unknown",
    pairAvailable: true,
    canStart: true,
    ...partial,
  };
}

describe("OCR view mapping", () => {
  it("maps running phases to one card with stop as the primary action", () => {
    const selecting = ocrCardView(
      input({ status: { state: "selecting", recognized: 0 } }),
    );
    expect(selecting.state).toBe("waiting");
    expect(selecting.title).toEqual({ key: "floatingOcrSelectingTitle" });
    expect(selecting.primary?.id).toBe("stop");

    const preparing = ocrCardView(
      input({
        status: { state: "initializing", recognized: 0, progress: 0.4 },
      }),
    );
    expect(preparing.state).toBe("translating");
    expect(preparing.progress).toBeCloseTo(0.4);

    const active = ocrCardView(
      input({ status: { state: "active", recognized: 37 } }),
    );
    expect(active.title).toEqual({ key: "floatingOcrRunningTitle" });
    expect(active.count).toEqual({
      key: "ocrRecognizedCount",
      substitutions: ["37"],
    });
    expect(active.description).toEqual({ key: "statusReasonOcrLocalOnly" });
    expect(active.liveChips).toBe(true);
    expect(active.primary?.id).toBe("stop");
    expect(active.secondary.map((item) => item.id)).toEqual(["reselect"]);

    // Pauses arrive as a message on a running state and replace the line.
    const paused = ocrCardView(
      input({
        status: { state: "capturing", recognized: 2, message: "paused" },
      }),
    );
    expect(paused.description).toEqual({ raw: "paused" });
  });

  it("names the stop reason from the code, not from the message", () => {
    const blackFrame = ocrCardView(
      input({
        status: {
          state: "unavailable",
          recognized: 3,
          message: "anything",
          reasonCode: OCR_REASON.protectedVideo,
        },
      }),
    );
    expect(blackFrame.state).toBe("error");
    expect(blackFrame.title).toEqual({ key: "floatingOcrStoppedTitle" });
    expect(blackFrame.description).toEqual({
      key: "statusReasonOcrProtectedVideo",
    });
    expect(blackFrame.primary?.id).toBe("reselect");
    expect(blackFrame.secondary.map((item) => item.id)).toEqual(["dismiss"]);

    const missing = ocrCardView(
      input({
        status: {
          state: "error",
          recognized: 0,
          reasonCode: OCR_REASON.runtimeMissing,
        },
      }),
    );
    expect(missing.title).toEqual({ key: "floatingOcrNotReadyTitle" });
    expect(missing.primary?.id).toBe("openSettings");

    const permission = ocrCardView(
      input({
        status: {
          state: "unavailable",
          recognized: 0,
          reasonCode: OCR_REASON.capturePermissionRequired,
        },
      }),
    );
    expect(permission.description).toEqual({
      key: "floatingOcrReasonPermission",
    });

    const unknown = ocrCardView(
      input({ status: { state: "error", recognized: 0, message: "raw text" } }),
    );
    expect(unknown.description).toEqual({ raw: "raw text" });
    expect(unknown.diagnostics).toBeUndefined();

    const failed = ocrCardView(
      input({
        status: {
          state: "error",
          recognized: 0,
          message: "start failed (detail)",
          reasonCode: OCR_REASON.startFailed,
        },
      }),
    );
    expect(failed.diagnostics).toBe("start failed (detail)");
  });

  it("keeps recognized text visible when local translation is not ready", () => {
    const view = ocrCardView(
      input({
        status: { state: "active", recognized: 4 },
        subtitle: subtitle({
          state: "ready",
          source: "ocr",
          completeness: "stream",
          total: 4,
          completed: 0,
          reasonCode: STATUS_REASON.ocrLocalTranslationUnavailable,
        }),
      }),
    );
    expect(view.notes).toEqual([
      { tone: "warn", text: { key: "statusReasonOcrTranslationUnavailable" } },
    ]);
  });

  it("never takes over from another subtitle track", () => {
    const fullTrack = subtitle({
      state: "ready",
      source: "youtube-timedtext",
      completeness: "full",
      total: 40,
      completed: 40,
    });
    const blocked = input({
      status: { state: "active", recognized: 1 },
      subtitle: fullTrack,
    });
    expect(ocrOwnsCard(blocked)).toBe(false);
    expect(ocrPhase(input({ subtitle: fullTrack }))).toBe("blocked");
    expect(
      ocrOwnsCard(
        input({
          status: {
            state: "unavailable",
            recognized: 0,
            reasonCode: OCR_REASON.existingSubtitles,
          },
        }),
      ),
    ).toBe(false);
  });

  it("drops a closed problem card and reports live work to the shell", () => {
    const problem = input({
      status: {
        state: "unavailable",
        recognized: 0,
        reasonCode: OCR_REASON.protectedVideo,
      },
    });
    expect(ocrOwnsCard(problem)).toBe(true);
    expect(ocrOwnsCard({ ...problem, dismissed: true })).toBe(false);
    expect(ocrShellView(problem)).toBeUndefined();

    const running = ocrShellView(
      input({ status: { state: "recognizing", recognized: 1 } }),
    );
    expect(running?.kind).toBe("translating");
    expect(running?.tracks).toEqual(["stream", "experimental"]);
    expect(
      ocrShellView(input({ status: { state: "selecting", recognized: 0 } }))
        ?.kind,
    ).toBe("scanning");
    // Once the OCR track carries cues, the subtitle view speaks for it.
    expect(
      ocrShellView(
        input({
          status: { state: "active", recognized: 1 },
          subtitle: subtitle({ state: "translating", source: "ocr", total: 1 }),
        }),
      ),
    ).toBeUndefined();
  });
});

/** `undefined` removes a callback (the host does not offer it). */
type Overrides = {
  [K in keyof FloatingControlOptions]?: FloatingControlOptions[K] | undefined;
};

async function openVideo(overrides: Overrides = {}) {
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
    onOcrSettingsChange: vi.fn(),
    onOcrStart: vi.fn(),
    onOcrStop: vi.fn(),
    queryOcrRuntime: vi.fn(() => Promise.resolve(true)),
  };
  const options = Object.fromEntries(
    Object.entries({ settings: settingsWith(), ...spies, ...overrides }).filter(
      ([, value]) => value !== undefined,
    ),
  ) as unknown as FloatingControlOptions;
  control = new FloatingControl(options);
  const root = document.querySelector<HTMLElement>(
    '[data-noritrans-ui="floating-control"]',
  )?.shadowRoot;
  if (!root) throw new Error("missing floating control");
  const open = async () => {
    root.querySelector<NtPillFab>("nt-pill-fab")!.click();
    await tick();
    root
      .querySelector("nt-tabs")!
      .dispatchEvent(new CustomEvent("nt-change", { detail: { id: "video" } }));
    await tick();
  };
  await open();
  const q = <T extends Element = Element>(selector: string) =>
    root.querySelector<T>(`[data-tab="video"] ${selector}`);
  const card = () => q("nt-status-card.status")!;
  const head = () => q<HTMLButtonElement>('[data-section="ocr"] .sec-head');
  const expand = async () => {
    if (head()?.getAttribute("aria-expanded") !== "true") head()!.click();
    await tick();
  };
  const body = <T extends Element = HTMLElement>(selector: string) =>
    q<T>(`[data-section="ocr"] ${selector}`);
  const cardAction = (id: string) =>
    q<NtButton>(`nt-status-card.status nt-button[data-action="${id}"]`);
  const change = async (field: string, detail: object) => {
    body(`[data-field="${field}"]`)!.dispatchEvent(
      new CustomEvent("change", { bubbles: true, detail }),
    );
    await tick();
  };
  return {
    spies,
    root,
    open,
    card,
    head,
    expand,
    body,
    cardAction,
    change,
  };
}

function ocr(partial: Partial<OcrStatus>): OcrStatus {
  return { state: "idle", recognized: 0, ...partial };
}

describe("FloatingControl · image recognition block", () => {
  it("is absent when the host cannot start OCR", async () => {
    const ui = await openVideo({ onOcrStart: undefined });
    expect(ui.head()).toBeNull();
  });

  it("collapses to a header with a spelled-out state", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: false }) });
    expect(ui.head()!.getAttribute("aria-expanded")).toBe("false");
    expect(ui.head()!.textContent).toContain("floatingOcrTitle");
    expect(ui.head()!.textContent).toContain("floatingOcrStateOff");
    await ui.expand();
    expect(ui.body('[data-ocr="privacy"]')!.textContent).toContain(
      "floatingOcrPrivacy",
    );
    // Off: the switch is offered, the start button is not.
    expect(ui.body('[data-field="ocr-enabled"]')).not.toBeNull();
    expect(ui.body('[data-ocr-action="start"]')).toBeNull();
  });

  it("turns OCR on with the full patch and reverts with a permission hint", async () => {
    let fail = true;
    const onOcrSettingsChange = vi.fn(async () => {
      await tick();
      if (fail) throw new Error("ocr-capture-permission-denied");
    });
    const ui = await openVideo({
      settings: settingsWith({ enabled: false }),
      onOcrSettingsChange,
    });
    await ui.expand();
    await ui.change("ocr-enabled", { checked: true });
    expect(onOcrSettingsChange).toHaveBeenCalledWith({
      ...settingsWith().ocr,
      enabled: true,
    });
    await tick();
    await tick();
    expect(ui.body('[data-ocr="notice"]')!.textContent).toContain(
      "ocrCapturePermissionRequired",
    );
    expect(
      (ui.body('[data-field="ocr-enabled"]') as unknown as { checked: boolean })
        .checked,
    ).toBe(false);

    fail = false;
    await ui.change("ocr-enabled", { checked: true });
    await tick();
    await tick();
    expect(ui.body('[data-ocr="notice"]')).toBeNull();
    expect(ui.body('[data-ocr-action="start"]')).not.toBeNull();
    expect(ui.head()!.textContent).toContain("floatingOcrStateReady");
  });

  it("starts selection, swaps in the OCR card and stops with a transition", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: true }) });
    control!.updateSubtitleStatus(NO_TRACK);
    control!.updateOcrStatus(ocr({ state: "idle" }));
    await ui.expand();
    ui.body<NtButton>('[data-ocr-action="start"]')!.click();
    await tick();
    expect(ui.spies.onOcrStart).toHaveBeenCalledTimes(1);
    // The selection overlay needs the video unobstructed.
    expect(control!.isExpanded).toBe(false);

    control!.updateOcrStatus(ocr({ state: "selecting" }));
    await ui.open();
    expect(ui.card().getAttribute("data-ocr-card")).toBe("selecting");
    expect(ui.card().getAttribute("heading")).toBe("floatingOcrSelectingTitle");

    control!.updateOcrStatus(ocr({ state: "active", recognized: 5 }));
    await tick();
    expect(ui.card().getAttribute("heading")).toBe("floatingOcrRunningTitle");
    expect(ui.card().getAttribute("count")).toBe("ocrRecognizedCount(5)");
    expect(
      Array.from(
        ui.root.querySelectorAll('[data-tab="video"] nt-status-card nt-chip'),
      ).map((chip) => chip.getAttribute("data-track")),
    ).toEqual(["stream", "experimental"]);
    expect(ui.head()!.textContent).toContain("floatingOcrStateRunning");
    // The tab dot and collapsed button report the work in progress.
    expect(ui.root.querySelector("nt-pill-fab")!.getAttribute("state")).toBe(
      "translating",
    );

    ui.cardAction("stop")!.click();
    await tick();
    expect(ui.spies.onOcrStop).toHaveBeenCalledTimes(1);
    expect(ui.cardAction("stop")!.busy).toBe(true);
    expect(ui.cardAction("stop")!.textContent?.trim()).toBe(
      "statusActionStopping",
    );
    control!.updateOcrStatus(ocr({ state: "cancelled", recognized: 5 }));
    await tick();
    // Back to the subtitle card; the block remembers the stop.
    expect(ui.card().hasAttribute("data-ocr-card")).toBe(false);
    expect(ui.head()!.textContent).toContain("floatingOcrStateStopped");
  });

  it("reselects from the running card", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: true }) });
    control!.updateOcrStatus(ocr({ state: "active", recognized: 1 }));
    await tick();
    ui.cardAction("reselect")!.click();
    await tick();
    expect(ui.spies.onOcrStart).toHaveBeenCalledTimes(1);
  });

  it("enables and starts OCR from the 'no readable subtitles' remedy", async () => {
    let release: () => void = () => undefined;
    const onOcrSettingsChange = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    const ui = await openVideo({
      settings: settingsWith({ enabled: false }),
      onOcrSettingsChange,
    });
    control!.updateSubtitleStatus(NO_TRACK);
    await tick();
    const remedy = ui.root.querySelector<NtButton>(
      '[data-tab="video"] nt-button[data-action="tryOcr"]',
    );
    expect(remedy).not.toBeNull();
    remedy!.click();
    await tick();
    expect(onOcrSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    // While Chrome's permission is pending, the OCR card holds the slot.
    expect(ui.card().getAttribute("heading")).toBe("floatingOcrEnablingTitle");
    expect(ui.cardAction("enable")!.busy).toBe(true);
    expect(ui.spies.onOcrStart).not.toHaveBeenCalled();
    release();
    await tick();
    await tick();
    expect(ui.spies.onOcrStart).toHaveBeenCalledTimes(1);
    expect(ui.head()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("explains a black frame stop and lets the user close the card", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: true }) });
    control!.updateSubtitleStatus(NO_TRACK);
    control!.updateOcrStatus(
      ocr({
        state: "unavailable",
        recognized: 2,
        message: "session text",
        reasonCode: OCR_REASON.protectedVideo,
      }),
    );
    await tick();
    expect(ui.card().getAttribute("state")).toBe("error");
    expect(ui.card().getAttribute("heading")).toBe("floatingOcrStoppedTitle");
    expect(ui.card().getAttribute("description")).toBe(
      "statusReasonOcrProtectedVideo",
    );
    ui.cardAction("dismiss")!.click();
    await tick();
    expect(ui.card().getAttribute("heading")).toBe(
      "statusTitleUnavailableSubtitle",
    );
    expect(ui.head()!.textContent).toContain("floatingOcrStateProblem");
    await ui.expand();
    expect(ui.body('[data-ocr="problem"]')!.textContent).toContain(
      "statusReasonOcrProtectedVideo",
    );
  });

  it("stops on a refused capture permission and says so", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: true }) });
    control!.updateOcrStatus(
      ocr({
        state: "unavailable",
        reasonCode: OCR_REASON.capturePermissionRequired,
      }),
    );
    await tick();
    expect(ui.card().getAttribute("description")).toBe(
      "floatingOcrReasonPermission",
    );
    expect(ui.cardAction("reselect")!.disabled).toBe(false);
  });

  it("warns when local translation is not ready and keeps the original", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: true }) });
    control!.updateSubtitleStatus(
      subtitle({
        state: "ready",
        source: "ocr",
        completeness: "stream",
        total: 3,
        completed: 0,
        reasonCode: STATUS_REASON.ocrLocalTranslationUnavailable,
      }),
    );
    control!.updateOcrStatus(ocr({ state: "active", recognized: 3 }));
    await tick();
    const note = ui.root.querySelector(
      '[data-tab="video"] nt-status-card [data-ocr-note="warn"]',
    );
    expect(note?.textContent).toContain(
      "statusReasonOcrTranslationUnavailable",
    );
  });

  it("shows pack readiness and links to settings without downloading", async () => {
    const queryOcrRuntime = vi.fn(() => Promise.resolve(false));
    const ui = await openVideo({
      settings: settingsWith({ enabled: true }),
      queryOcrRuntime,
    });
    await ui.expand();
    await tick();
    expect(queryOcrRuntime).toHaveBeenCalledWith("auto");
    expect(ui.body('[data-ocr="runtime-missing"]')).not.toBeNull();
    expect(ui.head()!.textContent).toContain("floatingOcrStateNotReady");
    ui.body<NtButton>('[data-ocr-action="open-settings"]')!.click();
    expect(ui.spies.onOpenSettings).toHaveBeenCalledWith("ocr");

    // A missing pack reported by the session opens settings from the card.
    control!.updateOcrStatus(
      ocr({ state: "error", reasonCode: OCR_REASON.runtimeMissing }),
    );
    await tick();
    ui.cardAction("openSettings")!.click();
    expect(ui.spies.onOpenSettings).toHaveBeenLastCalledWith("ocr");
  });

  it("reports a ready pack", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: true }) });
    await ui.expand();
    await tick();
    expect(ui.body('[data-ocr="runtime-ready"]')).not.toBeNull();
  });

  it("saves languages and the local translator, reverting on failure", async () => {
    const onOcrSettingsChange = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("save failed"));
    const ui = await openVideo({
      settings: settingsWith({ enabled: true, sourceLanguage: "auto" }),
      onOcrSettingsChange,
    });
    await ui.expand();
    await ui.change("ocr-source", { value: "ja" });
    expect(onOcrSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, sourceLanguage: "ja" }),
    );
    await tick();
    await ui.change("ocr-translator", { value: "bergamot-local" });
    expect(onOcrSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceLanguage: "ja",
        provider: "bergamot-local",
      }),
    );
    await tick();
    await tick();
    expect(ui.body('[data-ocr="notice"]')!.textContent).toContain(
      "settingsSaveFailed",
    );
    expect(
      (ui.body('[data-field="ocr-translator"]') as unknown as { value: string })
        .value,
    ).toBe("chrome-local");
    // Only languages the recognizer supports are offered as source.
    const options = (
      ui.body('[data-field="ocr-source"]') as unknown as {
        options: { value: string }[];
      }
    ).options.map((option) => option.value);
    expect(options).toContain("ja");
    expect(options).not.toContain("ru");
  });

  it("is not offered while another subtitle track exists", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: true }) });
    control!.updateSubtitleStatus(
      subtitle({
        state: "ready",
        source: "youtube-timedtext",
        completeness: "full",
        total: 12,
        completed: 12,
      }),
    );
    await ui.expand();
    expect(ui.head()!.textContent).toContain("floatingOcrStateBlocked");
    expect(ui.body('[data-ocr="blocked"]')).not.toBeNull();
    expect(ui.body<NtButton>('[data-ocr-action="start"]')!.disabled).toBe(true);
  });

  it("closes the expanded block on Escape before the panel", async () => {
    const ui = await openVideo();
    await ui.expand();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(ui.head()!.getAttribute("aria-expanded")).toBe("false");
    expect(control!.isExpanded).toBe(true);
  });
});

describe("FloatingControl · image recognition races and diagnostics", () => {
  it("holds the switch while an on/off-only host saves, then adopts a newer snapshot", async () => {
    let resolveSave: () => void = () => undefined;
    const onOcrEnabledChange = vi.fn(
      () => new Promise<void>((resolve) => (resolveSave = resolve)),
    );
    const ui = await openVideo({
      settings: settingsWith({ enabled: false }),
      onOcrSettingsChange: undefined,
      onOcrEnabledChange,
    });
    await ui.expand();
    const toggle = () =>
      ui.body('[data-field="ocr-enabled"]') as unknown as Element & {
        checked: boolean;
      };

    await ui.change("ocr-enabled", { checked: true });
    expect(onOcrEnabledChange).toHaveBeenCalledWith(true);
    expect(toggle().checked).toBe(true);
    expect(toggle().hasAttribute("disabled")).toBe(true);

    control!.updateSettings(settingsWith({ enabled: false }));
    await tick();
    expect(toggle().checked).toBe(true);
    expect(toggle().hasAttribute("disabled")).toBe(true);

    resolveSave();
    await tick();
    // The newer snapshot already carries the saved state and wins.
    expect(toggle().hasAttribute("disabled")).toBe(false);
    expect(toggle().checked).toBe(false);
  });

  it("bounds a long failure diagnostic and drops it once OCR is idle", async () => {
    const ui = await openVideo({ settings: settingsWith({ enabled: true }) });
    control!.updateSubtitleStatus(NO_TRACK);
    const long = `OCR failed: ${"x".repeat(5_000)}`;
    control!.updateOcrStatus(
      ocr({
        state: "error",
        message: long,
        reasonCode: OCR_REASON.startFailed,
      }),
    );
    await tick();
    const diag = () =>
      ui.root.querySelector<HTMLDetailsElement>(
        '[data-tab="video"] nt-status-card details.diag',
      );
    expect(diag()!.querySelector("summary")?.textContent).toBe(
      "floatingOcrDetails",
    );
    expect(diag()!.querySelector("pre")?.textContent).toBe(
      long.slice(0, 4_000),
    );

    control!.updateOcrStatus(ocr({ state: "idle" }));
    await tick();
    expect(diag()).toBeNull();
  });
});
