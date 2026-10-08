import type { ImageTranslationStatus } from "@/src/image-translation/controller";
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
import { imageCardView, imagePhase } from "@/src/ui/floating/image-view";
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
  imageTranslation: Partial<ContentSettings["imageTranslation"]> = {},
): ContentSettings {
  const base = toContentSettings(DEFAULT_SETTINGS);
  return {
    ...base,
    imageTranslation: { ...base.imageTranslation, ...imageTranslation },
  };
}

function image(
  partial: Partial<ImageTranslationStatus> = {},
): ImageTranslationStatus {
  return {
    state: "available",
    total: 0,
    completed: 0,
    hasCurrentImage: true,
    ...partial,
  };
}

describe("image translation view mapping", () => {
  it("uses one primary slot across the image task", () => {
    const view = (status: ImageTranslationStatus) =>
      imageCardView({ status, pairAvailable: true });
    const idle = view(image({ state: "idle", hasCurrentImage: false }));
    expect(idle.title).toEqual({ key: "floatingImageNoImageTitle" });
    expect(idle.primary).toMatchObject({ id: "translate", disabled: true });
    expect(view(image()).primary).toMatchObject({
      id: "translate",
      disabled: false,
    });
    expect(view(image({ state: "recognizing" })).state).toBe("scanning");
    const translating = view(
      image({ state: "translating", total: 8, completed: 2 }),
    );
    expect(translating.progress).toBeCloseTo(0.25);
    expect(translating.count).toEqual({
      key: "floatingImageCount",
      substitutions: ["2", "8"],
    });
    expect(translating.primary?.id).toBe("stop");
    expect(
      view(image({ state: "ready", total: 8, completed: 8 })).primary?.id,
    ).toBe("clear");
    const cancelled = view(image({ state: "cancelled" }));
    expect(cancelled.primary?.id).toBe("translate");
    expect(cancelled.secondary.map((item) => item.id)).toEqual(["clear"]);
    expect(
      imageCardView({ status: image(), pairAvailable: false }).primary
        ?.disabled,
    ).toBe(true);
  });

  it("chooses the remedy from the reason code", () => {
    const view = (status: Partial<ImageTranslationStatus>) =>
      imageCardView({ status: image(status), pairAvailable: true });
    expect(
      view({ state: "unavailable", reasonCode: "ocr_runtime_missing" }).primary
        ?.id,
    ).toBe("openSettings");
    expect(
      view({ state: "unavailable", reasonCode: "provider_unavailable" }).primary
        ?.id,
    ).toBe("openProviderSettings");
    expect(
      view({
        state: "unavailable",
        reasonCode: "image_not_visible",
        hasCurrentImage: false,
      }).primary,
    ).toBeUndefined();
    const error = view({
      state: "error",
      message: "Image translation failed.",
      details: "request_failed: x",
      reasonCode: "request_failed",
    });
    expect(error.title).toEqual({ key: "floatingImageErrorTitle" });
    expect(error.description).toEqual({ raw: "Image translation failed." });
    expect(error.primary?.id).toBe("translate");
    expect(error.diagnostics).toBe("request_failed: x");
  });

  it("spells the collapsed state", () => {
    expect(imagePhase(image({ state: "idle" }), false)).toBe("off");
    expect(imagePhase(image({ state: "idle" }), true)).toBe("waiting");
    expect(imagePhase(image({ state: "translating" }), true)).toBe("running");
    expect(imagePhase(image({ state: "error" }), true)).toBe("problem");
  });
});

/** `undefined` removes a callback (the host does not offer it). */
type Overrides = {
  [K in keyof FloatingControlOptions]?: FloatingControlOptions[K] | undefined;
};

async function openPage(overrides: Overrides = {}) {
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
    onImageSettingsChange: vi.fn(),
    onImageStart: vi.fn(),
    onImageCancelOrClear: vi.fn(),
  };
  const options = Object.fromEntries(
    Object.entries({
      settings: settingsWith({ enabled: true }),
      ...spies,
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  ) as unknown as FloatingControlOptions;
  control = new FloatingControl(options);
  const root = document.querySelector<HTMLElement>(
    '[data-noritrans-ui="floating-control"]',
  )?.shadowRoot;
  if (!root) throw new Error("missing floating control");
  root.querySelector<NtPillFab>("nt-pill-fab")!.click();
  await tick();
  const q = <T extends Element = Element>(selector: string) =>
    root.querySelector<T>(
      `[data-tab="page"] [data-section="image"] ${selector}`,
    );
  const head = () => q<HTMLButtonElement>(".sec-head");
  const expand = async () => {
    if (head()?.getAttribute("aria-expanded") !== "true") head()!.click();
    await tick();
  };
  const card = () => q("nt-status-card");
  const action = (id: string) => q<NtButton>(`nt-button[data-action="${id}"]`);
  const change = async (field: string, detail: object) => {
    q(`[data-field="${field}"]`)!.dispatchEvent(
      new CustomEvent("change", { bubbles: true, detail }),
    );
    await tick();
  };
  return { spies, root, q, head, expand, card, action, change };
}

describe("FloatingControl · image translation block", () => {
  it("lives in the page tab and is absent without a start callback", async () => {
    const ui = await openPage({ onImageStart: undefined });
    expect(ui.head()).toBeNull();
    control!.destroy();
    const shown = await openPage();
    expect(shown.head()!.textContent).toContain("floatingImageTitle");
    expect(shown.head()!.textContent).toContain("floatingImageStateWaiting");
  });

  it("translates, stops and clears with transitional labels", async () => {
    const ui = await openPage();
    await ui.expand();
    expect(ui.q('[data-image="privacy"]')!.textContent).toContain(
      "imageTranslationPrivacy",
    );
    expect(ui.action("translate")!.disabled).toBe(true);
    control!.updateImageStatus(image());
    await tick();
    ui.action("translate")!.click();
    await tick();
    expect(ui.spies.onImageStart).toHaveBeenCalledTimes(1);
    expect(ui.action("translate")!.busy).toBe(true);
    control!.updateImageStatus(image({ state: "capturing" }));
    await tick();
    expect(ui.card()!.getAttribute("state")).toBe("scanning");
    control!.updateImageStatus(
      image({ state: "translating", total: 4, completed: 1 }),
    );
    await tick();
    expect(ui.card()!.getAttribute("count")).toBe("floatingImageCount(1,4)");
    expect(ui.head()!.textContent).toContain("floatingImageStateRunning");
    ui.action("stop")!.click();
    await tick();
    expect(ui.spies.onImageCancelOrClear).toHaveBeenCalledTimes(1);
    expect(ui.action("stop")!.textContent?.trim()).toBe("statusActionStopping");
    control!.updateImageStatus(
      image({ state: "ready", total: 4, completed: 4 }),
    );
    await tick();
    ui.action("clear")!.click();
    await tick();
    expect(ui.spies.onImageCancelOrClear).toHaveBeenCalledTimes(2);
  });

  it("shows a failed request as a notice", async () => {
    const ui = await openPage({
      onImageStart: vi.fn(() => Promise.reject(new Error("no"))),
    });
    await ui.expand();
    control!.updateImageStatus(image());
    await tick();
    ui.action("translate")!.click();
    await tick();
    await tick();
    expect(ui.q('[data-image="notice"]')!.textContent).toContain(
      "floatingImageActionFailed",
    );
    expect(ui.action("translate")!.busy).toBe(false);
  });

  it("opens the pack settings when recognition is not installed", async () => {
    const ui = await openPage();
    await ui.expand();
    control!.updateImageStatus(
      image({
        state: "unavailable",
        message: "pack missing",
        reasonCode: "ocr_runtime_missing",
      }),
    );
    await tick();
    expect(ui.card()!.getAttribute("description")).toBe("pack missing");
    ui.action("openSettings")!.click();
    expect(ui.spies.onOpenSettings).toHaveBeenCalledWith("ocr");
  });

  it("saves image settings immediately and keeps the model override", async () => {
    const onImageSettingsChange = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("save failed"));
    const settings = settingsWith({ enabled: true, modelOverride: "m-1" });
    const ui = await openPage({ settings, onImageSettingsChange });
    await ui.expand();
    await ui.change("image-method", { value: "fast:deepl" });
    expect(onImageSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "fast", modelOverride: "m-1" }),
      "deepl",
    );
    await tick();
    const other =
      settings.imageTranslation.displayMode === "translated"
        ? "bilingual"
        : "translated";
    await ui.change("image-display", { value: other });
    expect(onImageSettingsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ displayMode: other }),
    );
    await tick();
    await tick();
    expect(ui.q('[data-image="notice"]')!.textContent).toContain(
      "settingsSaveFailed",
    );
    expect(
      (ui.q('[data-field="image-display"]') as unknown as { value: string })
        .value,
    ).toBe(settings.imageTranslation.displayMode);
  });

  it("switches the feature on from the block", async () => {
    const ui = await openPage({ settings: settingsWith({ enabled: false }) });
    await ui.expand();
    expect(ui.head()!.textContent).toContain("floatingImageStateOff");
    expect(ui.card()).toBeNull();
    await ui.change("image-enabled", { checked: true });
    expect(ui.spies.onImageSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });
});
