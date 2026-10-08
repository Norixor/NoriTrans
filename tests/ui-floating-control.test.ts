import type { PageStatus } from "@/src/messaging/protocol";
import { DEFAULT_SETTINGS, toContentSettings } from "@/src/shared/settings";
import type { NtButton, NtPillFab } from "@/src/ui/components";
import {
  FloatingControl,
  type FloatingControlOptions,
} from "@/src/ui/floating";
import { queryDocumentTranslationCapabilities } from "@/src/translation/provider-capabilities";
import type * as CapabilitiesModule from "@/src/translation/provider-capabilities";
import { browser } from "wxt/browser";
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
    // Pending by default: every language counts as available until it settles.
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

/** `undefined` removes a callback (the host does not offer it). */
type Overrides = {
  [K in keyof FloatingControlOptions]?: FloatingControlOptions[K] | undefined;
};

function create(overrides: Overrides = {}) {
  const spies = {
    onPageTranslate: vi.fn(),
    onPageRetryFailed: vi.fn(),
    onPageCancel: vi.fn(),
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
    onHidePermanently: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  const options = Object.fromEntries(
    Object.entries({
      settings: toContentSettings(DEFAULT_SETTINGS),
      ...spies,
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  ) as unknown as FloatingControlOptions;
  control = new FloatingControl(options);
  const host = document.querySelector<HTMLElement>(
    '[data-noritrans-ui="floating-control"]',
  );
  const root = host?.shadowRoot;
  if (!host || !root) throw new Error("missing floating control");
  const fab = root.querySelector<NtPillFab>("nt-pill-fab")!;
  const panel = root.querySelector<HTMLElement>(".panel")!;
  const action = (id: string) =>
    root.querySelector<NtButton>(`nt-button[data-action="${id}"]`);
  const primary = () =>
    root.querySelector<NtButton>('nt-button[data-primary="true"]');
  return { spies, host, root, fab, panel, action, primary };
}

function status(partial: Partial<PageStatus>): PageStatus {
  return { state: "idle", total: 0, completed: 0, failed: 0, ...partial };
}

describe("FloatingControl shell", () => {
  it("mounts a marked host with a collapsed launcher", async () => {
    const { host, fab, panel } = create();
    await tick();
    expect(control?.mount).toEqual({ ok: true });
    expect(host.style.getPropertyValue("position")).toBe("fixed");
    expect(panel.hidden).toBe(true);
    expect(fab.state).toBe("idle");
    expect(fab.expanded).toBe("false");
    expect(fab.label).toBe("floatingControl · statusTitleIdlePage");
  });

  it("maps page status to the launcher ring and badge", async () => {
    const { fab } = create();
    control!.updatePageStatus(
      status({ state: "translating", total: 10, completed: 4 }),
    );
    await tick();
    expect(fab.state).toBe("translating");
    expect(fab.progress).toBeCloseTo(0.4);
    expect(fab.message).toBe("");
    control!.updatePageStatus(
      status({ state: "translated", total: 10, completed: 10 }),
    );
    await tick();
    expect(fab.state).toBe("ready");
    expect(fab.message).toBe("statusTitleReadyPage(10)");
  });

  it("can turn pill announcements off", async () => {
    const { fab } = create({ announcements: false });
    await tick();
    expect(fab.silent).toBe(true);
    control!.setAnnouncementsEnabled(true);
    await tick();
    expect(fab.silent).toBe(false);
  });

  it("expands on click, collapses on Escape and outside press", async () => {
    const { fab, panel } = create();
    fab.click();
    await tick();
    expect(panel.hidden).toBe(false);
    expect(fab.expanded).toBe("true");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(panel.hidden).toBe(true);
    fab.click();
    await tick();
    expect(panel.hidden).toBe(false);
    document.body.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, composed: true }),
    );
    await tick();
    expect(panel.hidden).toBe(true);
  });

  it("links the launcher to the panel only while it is expanded", async () => {
    const { fab, panel } = create();
    await tick();
    expect(panel.id).not.toBe("");
    expect(fab.controls).toBe("");
    fab.click();
    await tick();
    expect(fab.controls).toBe(panel.id);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(fab.controls).toBe("");
  });
});

describe("FloatingControl page tab", () => {
  it("runs the primary action and holds the transition until confirmed", async () => {
    const { fab, spies, primary } = create();
    fab.click();
    await tick();
    const button = primary()!;
    expect(button.dataset.action).toBe("translate");
    expect(button.textContent?.trim()).toBe("statusActionTranslate");
    button.click();
    await tick();
    expect(spies.onPageTranslate).toHaveBeenCalledTimes(1);
    expect(primary()!.busy).toBe(true);
    expect(primary()!.textContent?.trim()).toBe("statusActionStarting");
    // A second click while in flight does nothing.
    primary()!.click();
    await tick();
    expect(spies.onPageTranslate).toHaveBeenCalledTimes(1);

    control!.updatePageStatus(status({ state: "translating", total: 8 }));
    await tick();
    expect(primary()!.dataset.action).toBe("stop");
    expect(primary()!.busy).toBe(false);
    primary()!.click();
    await tick();
    expect(spies.onPageCancel).toHaveBeenCalledTimes(1);
    expect(primary()!.textContent?.trim()).toBe("statusActionStopping");
  });

  it("retries failed blocks with a retry title and restores", async () => {
    const { fab, spies, primary, action, root } = create();
    control!.updatePageStatus(
      status({ state: "partial", total: 10, completed: 8, failed: 2 }),
    );
    fab.click();
    await tick();
    expect(primary()!.dataset.action).toBe("retry");
    primary()!.click();
    await tick();
    expect(spies.onPageRetryFailed).toHaveBeenCalledTimes(1);
    control!.updatePageStatus(
      status({ state: "translating", total: 10, completed: 9, failed: 0 }),
    );
    await tick();
    const card = root.querySelector("nt-status-card")!;
    expect(card.getAttribute("heading")).toBe("statusTitleRetryingPage(1,2)");
    control!.updatePageStatus(
      status({ state: "translated", total: 10, completed: 10 }),
    );
    await tick();
    expect(card.getAttribute("heading")).toBe("statusTitleReadyPage(10)");
    action("restore")!.click();
    await tick();
    expect(spies.onPageRestore).toHaveBeenCalledTimes(1);
    expect(action("restore")!.busy).toBe(true);
  });

  it("shows a notice when an action fails", async () => {
    const { fab, primary, root } = create({
      onPageTranslate: vi.fn(() => Promise.reject(new Error("x"))),
    });
    fab.click();
    await tick();
    primary()!.click();
    await tick();
    await tick();
    expect(primary()!.busy).toBe(false);
    expect(root.querySelector("nt-note")?.textContent).toContain(
      "pageActionFailed",
    );
  });

  it("edits settings inline through the existing callbacks", async () => {
    const { fab, spies, root } = create();
    fab.click();
    await tick();
    expect(root.querySelector(".editor")).toBeNull();
    root
      .querySelector("nt-quick-line")!
      .dispatchEvent(new CustomEvent("nt-action", { bubbles: true }));
    await tick();
    const field = (name: string) =>
      root.querySelector(`.editor [data-field="${name}"]`)!;
    expect(field("response")).toBeNull();

    field("target").dispatchEvent(
      new CustomEvent("change", { bubbles: true, detail: { value: "ja" } }),
    );
    await tick();
    expect(spies.onPageSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        targetLanguage: "ja",
        sourceLanguage: DEFAULT_SETTINGS.page.sourceLanguage,
        displayMode: DEFAULT_SETTINGS.page.displayMode,
        selectionTranslationEnabled:
          DEFAULT_SETTINGS.page.selectionTranslationEnabled,
      }),
      expect.anything(),
    );
    expect(root.querySelector(".summary-text")?.textContent).toContain(
      "Japanese",
    );

    field("method").dispatchEvent(
      new CustomEvent("change", { bubbles: true, detail: { value: "ai" } }),
    );
    await tick();
    expect(spies.onPageModeChange).toHaveBeenCalledWith("ai");
    expect(field("response")).not.toBeNull();
    field("response").dispatchEvent(
      new CustomEvent("change", { bubbles: true, detail: { value: "batch" } }),
    );
    await tick();
    expect(spies.onPageResponseModeChange).toHaveBeenCalledWith("batch");

    field("auto").dispatchEvent(
      new CustomEvent("change", { bubbles: true, detail: { checked: true } }),
    );
    await tick();
    expect(spies.onAutoTranslateChange).toHaveBeenCalledWith(true);

    // Escape closes the editor before the panel.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(root.querySelector(".editor")).toBeNull();
    expect(control!.isExpanded).toBe(true);
  });

  it("blocks translating when the method cannot handle the pair", async () => {
    vi.mocked(queryDocumentTranslationCapabilities).mockResolvedValueOnce({
      chromePairs: [],
      installedBergamotPackIds: [],
    });
    const { fab, primary, root, spies } = create();
    fab.click();
    await tick();
    expect(primary()!.disabled).toBe(true);
    expect(root.querySelector("nt-note")?.textContent).toContain(
      "floatingPairUnavailable",
    );
    primary()!.click();
    await tick();
    expect(spies.onPageTranslate).not.toHaveBeenCalled();
  });

  it("reverts and reports a failed settings change", async () => {
    const { fab, root } = create({
      onPageSettingsChange: vi.fn(() => Promise.reject(new Error("x"))),
    });
    fab.click();
    await tick();
    root
      .querySelector("nt-quick-line")!
      .dispatchEvent(new CustomEvent("nt-action", { bubbles: true }));
    await tick();
    root.querySelector('[data-field="display"]')!.dispatchEvent(
      new CustomEvent("change", {
        bubbles: true,
        detail: { value: "bilingual" },
      }),
    );
    await tick();
    await tick();
    expect(root.querySelector("nt-note")?.textContent).toContain(
      "settingsSaveFailed",
    );
    expect(root.querySelector(".summary-text")?.textContent).toContain(
      "pageDisplayReplace",
    );
  });
});

describe("FloatingControl menu", () => {
  const select = (root: ShadowRoot, id: string) =>
    root
      .querySelector("nt-menu")!
      .dispatchEvent(new CustomEvent("nt-select", { detail: { id } }));

  it("hides on the current page", async () => {
    const { fab, root, host, spies } = create();
    fab.click();
    await tick();
    select(root, "hide-current");
    await tick();
    expect(spies.onHideCurrent).toHaveBeenCalledTimes(1);
    expect(host.style.getPropertyValue("display")).toBe("none");
    control!.show();
    expect(host.style.getPropertyValue("display")).toBe("block");
  });

  it("reports a failed hide", async () => {
    const { fab, root, host } = create({
      onHideCurrent: vi.fn(() => Promise.reject(new Error("x"))),
    });
    fab.click();
    await tick();
    select(root, "hide-current");
    await tick();
    await tick();
    expect(host.style.getPropertyValue("display")).not.toBe("none");
    expect(root.querySelector(".body > nt-note")?.textContent).toContain(
      "floatingHideFailed",
    );
  });

  it("asks before hiding everywhere and tells how to restore", async () => {
    const { fab, root, host, spies } = create();
    fab.click();
    await tick();
    select(root, "hide-always");
    await tick();
    const confirm = root.querySelector(".confirm")!;
    expect(confirm.textContent).toContain("floatingHideAlwaysBody");
    confirm.querySelector<NtButton>('[data-confirm="cancel"]')!.click();
    await tick();
    expect(root.querySelector(".confirm")).toBeNull();
    expect(spies.onHidePermanently).not.toHaveBeenCalled();

    select(root, "hide-always");
    await tick();
    root.querySelector<NtButton>('.confirm [data-confirm="ok"]')!.click();
    await tick();
    expect(spies.onHidePermanently).toHaveBeenCalledTimes(1);
    expect(host.style.getPropertyValue("display")).toBe("none");
  });

  it("opens the spies page", async () => {
    const { fab, root, spies } = create();
    fab.click();
    await tick();
    select(root, "settings");
    await tick();
    expect(spies.onOpenSettings).toHaveBeenCalledWith(undefined);
    expect(control!.isExpanded).toBe(false);
  });
});

describe("FloatingControl position", () => {
  it("restores the session position and docks it", async () => {
    sessionStorage.setItem(
      `noritrans:unified-control:${location.origin}${location.pathname}`,
      JSON.stringify({ left: 20, top: 300 }),
    );
    const { host } = create();
    await tick();
    expect(host.style.getPropertyValue("left")).toBe("10px");
    expect(host.style.getPropertyValue("top")).toBe("300px");
    expect(host.dataset.dockedEdge).toBe("left");
    expect(host.dataset.edgeHidden).toBe("true");
    expect(host.style.getPropertyValue("transform")).toBe("translateX(-38px)");
  });

  it("applies the persisted normalized position", async () => {
    const { host } = create({
      loadPosition: () => Promise.resolve({ x: 0.5, y: 0.5 }),
    });
    await tick();
    await tick();
    expect(host.style.getPropertyValue("left")).not.toBe("");
    expect(host.dataset.dockedEdge).toBeUndefined();
  });

  it("moves with arrow keys and persists the position", async () => {
    const onPositionChange = vi.fn();
    const { fab, host } = create({
      loadPosition: () => Promise.resolve({ x: 0.5, y: 0.5 }),
      onPositionChange,
    });
    await tick();
    await tick();
    const left = Number.parseFloat(host.style.getPropertyValue("left"));
    fab.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await tick();
    expect(Number.parseFloat(host.style.getPropertyValue("left"))).toBe(
      left - 8,
    );
    expect(onPositionChange).toHaveBeenCalledWith(
      expect.objectContaining({ y: 0.5 }),
    );
  });
});

describe("FloatingControl page tab · settings saves", () => {
  async function openEditor(root: ShadowRoot): Promise<void> {
    root
      .querySelector("nt-quick-line")!
      .dispatchEvent(new CustomEvent("nt-action", { bubbles: true }));
    await tick();
  }
  const field = <T = { value: string; checked: boolean }>(
    root: ShadowRoot,
    name: string,
  ) => root.querySelector(`.editor [data-field="${name}"]`) as T & Element;
  const change = async (root: ShadowRoot, name: string, detail: object) => {
    field(root, name).dispatchEvent(
      new CustomEvent("change", { bubbles: true, detail }),
    );
    await tick();
  };

  it("reverts the method and the auto-translate switch when saving fails", async () => {
    const { fab, root, spies } = create({
      onPageModeChange: vi.fn(() => Promise.reject(new Error("x"))),
      onAutoTranslateChange: vi.fn(() => Promise.reject(new Error("x"))),
    });
    fab.click();
    await tick();
    await openEditor(root);
    const initialMethod = field(root, "method").value;
    expect(initialMethod).toMatch(/^fast:/);

    await change(root, "method", { value: "ai" });
    await tick();
    expect(root.querySelector("nt-note")?.textContent).toContain(
      "settingsSaveFailed",
    );
    expect(field(root, "method").value).toBe(initialMethod);
    expect(field(root, "method").hasAttribute("disabled")).toBe(false);
    expect(field(root, "response")).toBeNull();

    const autoBefore = field(root, "auto").checked;
    await change(root, "auto", { checked: !autoBefore });
    await tick();
    expect(field(root, "auto").checked).toBe(autoBefore);
    expect(field(root, "auto").hasAttribute("disabled")).toBe(false);
    expect(root.querySelector("nt-note")?.textContent).toContain(
      "settingsSaveFailed",
    );
    expect(spies.onPageSettingsChange).not.toHaveBeenCalled();
  });

  it("holds fields while a save runs and then adopts a newer settings snapshot", async () => {
    let resolveMode: () => void = () => undefined;
    const onPageModeChange = vi.fn(
      () => new Promise<void>((resolve) => (resolveMode = resolve)),
    );
    const { fab, root } = create({ onPageModeChange });
    fab.click();
    await tick();
    await openEditor(root);
    const initialMethod = field(root, "method").value;

    await change(root, "method", { value: "ai" });
    expect(onPageModeChange).toHaveBeenCalledWith("ai");
    expect(field(root, "method").value).toBe("ai");
    expect(field(root, "method").hasAttribute("disabled")).toBe(true);
    expect(field(root, "target").hasAttribute("disabled")).toBe(true);
    expect(field(root, "auto").hasAttribute("disabled")).toBe(true);

    const base = toContentSettings(DEFAULT_SETTINGS);
    control!.updateSettings({
      ...base,
      page: { ...base.page, targetLanguage: "ja", mode: "fast" },
    });
    await tick();
    // The requested value stays visible; unrelated fields follow the snapshot.
    expect(field(root, "method").value).toBe("ai");
    expect(field(root, "target").value).toBe("ja");
    expect(field(root, "target").hasAttribute("disabled")).toBe(true);

    resolveMode();
    await tick();
    // The newer snapshot already carries the saved state and wins.
    expect(field(root, "method").value).toBe(initialMethod);
    expect(field(root, "target").value).toBe("ja");
    expect(field(root, "method").hasAttribute("disabled")).toBe(false);
    expect(field(root, "auto").hasAttribute("disabled")).toBe(false);
  });
});

describe("FloatingControl page tab · task fallbacks and diagnostics", () => {
  it("stops through restore when the host has no cancel callback", async () => {
    const { fab, spies, primary } = create({ onPageCancel: undefined });
    control!.updatePageStatus(
      status({ state: "translating", total: 383, completed: 1 }),
    );
    fab.click();
    await tick();
    expect(primary()!.dataset.action).toBe("stop");
    expect(primary()!.disabled).toBe(false);
    primary()!.click();
    await tick();
    expect(spies.onPageRestore).toHaveBeenCalledTimes(1);
  });

  it("restores after a failed restore request without leaving the button busy", async () => {
    const onPageRestore = vi
      .fn()
      .mockRejectedValueOnce(new Error("broadcast failed"))
      .mockResolvedValueOnce(undefined);
    const { fab, root, action } = create({ onPageRestore });
    control!.updatePageStatus(
      status({ state: "translated", total: 1, completed: 1 }),
    );
    fab.click();
    await tick();
    action("restore")!.click();
    await tick();
    await tick();
    expect(root.querySelector("nt-note")?.textContent).toContain(
      "pageActionFailed",
    );
    expect(action("restore")!.busy).toBe(false);
    action("restore")!.click();
    await tick();
    expect(onPageRestore).toHaveBeenCalledTimes(2);
  });

  it("shows bounded provider diagnostics only while the error carries details", async () => {
    const { root } = create();
    const diag = () =>
      root.querySelector<HTMLDetailsElement>('[data-tab="page"] details.diag');
    expect(diag()).toBeNull();

    control!.updatePageStatus(
      status({
        state: "error",
        total: 2,
        failed: 2,
        message: "invalid response",
        details: "Missing result IDs: page-1, page-2.",
      }),
    );
    await tick();
    expect(diag()!.querySelector("summary")?.textContent).toBe(
      "viewProviderDetails",
    );
    expect(diag()!.querySelector("pre")?.textContent).toContain("page-1");

    control!.updatePageStatus(
      status({
        state: "error",
        total: 1,
        failed: 1,
        details: "x".repeat(5_000),
      }),
    );
    await tick();
    expect(diag()!.querySelector("pre")?.textContent?.trim()).toHaveLength(
      4_000,
    );

    control!.updatePageStatus(
      status({ state: "translated", total: 2, completed: 2 }),
    );
    await tick();
    expect(diag()).toBeNull();
  });

  it("closes an open diagnostic before Escape closes the panel", async () => {
    const { fab, root, panel } = create();
    control!.updatePageStatus(
      status({
        state: "error",
        total: 1,
        failed: 1,
        details: "Missing result ID: page-1.",
      }),
    );
    fab.click();
    await tick();
    const diag = root.querySelector<HTMLDetailsElement>(
      '[data-tab="page"] details.diag',
    )!;
    diag.open = true;

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(diag.open).toBe(false);
    expect(panel.hidden).toBe(false);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await tick();
    expect(panel.hidden).toBe(true);
  });
});

describe("FloatingControl menu · fallbacks", () => {
  const select = (root: ShadowRoot, id: string) =>
    root
      .querySelector("nt-menu")!
      .dispatchEvent(new CustomEvent("nt-select", { detail: { id } }));

  it("keeps the panel open after a failed hide and lets the user retry", async () => {
    const onHideCurrent = vi
      .fn()
      .mockRejectedValueOnce(new Error("storage unavailable"))
      .mockResolvedValueOnce(undefined);
    const { fab, root, host, panel } = create({ onHideCurrent });
    fab.click();
    await tick();
    select(root, "hide-current");
    await tick();
    await tick();
    expect(panel.hidden).toBe(false);
    expect(root.querySelector(".body > nt-note")?.textContent).toContain(
      "floatingHideFailed",
    );

    select(root, "hide-current");
    await tick();
    await tick();
    expect(onHideCurrent).toHaveBeenCalledTimes(2);
    expect(host.style.getPropertyValue("display")).toBe("none");
  });

  it("hides everywhere through the shared visibility setting by default", async () => {
    const sendMessage = vi.mocked(browser.runtime.sendMessage);
    sendMessage.mockReset();
    sendMessage.mockResolvedValueOnce({ ok: false } as never);
    sendMessage.mockResolvedValueOnce({ ok: true } as never);
    const { fab, root, host } = create({ onHidePermanently: undefined });
    fab.click();
    await tick();

    select(root, "hide-always");
    await tick();
    root.querySelector<NtButton>('.confirm [data-confirm="ok"]')!.click();
    await tick();
    await tick();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "FLOATING_BUTTON_SET",
      surface: "all",
      enabled: false,
    });
    // A refused update is a failure, not a silent hide.
    expect(host.style.getPropertyValue("display")).not.toBe("none");
    expect(root.querySelector(".body > nt-note")?.textContent).toContain(
      "floatingHideFailed",
    );

    root.querySelector<NtButton>('.confirm [data-confirm="ok"]')!.click();
    await tick();
    await tick();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(host.style.getPropertyValue("display")).toBe("none");
  });
});
