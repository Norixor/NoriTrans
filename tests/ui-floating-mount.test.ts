import { DEFAULT_SETTINGS, toContentSettings } from "@/src/shared/settings";
import type * as InjectModule from "@/src/ui/inject";
import { describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({
  browser: {
    i18n: { getMessage: (key: string) => key, getUILanguage: () => "en" },
    runtime: { sendMessage: vi.fn() },
  },
}));

vi.mock("@/src/ui/inject", async (importOriginal) => ({
  ...(await importOriginal<typeof InjectModule>()),
  ensureInjectedUi: () => ({ ok: false, code: "polyfill-loaded-too-late" }),
}));

describe("FloatingControl without usable custom elements", () => {
  it("renders nothing, reports the code and ignores calls", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { FloatingControl } = await import("@/src/ui/floating");
    const onHideCurrent = vi.fn();
    const control = new FloatingControl({
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
      onHideCurrent,
    });
    expect(control.mount).toEqual({
      ok: false,
      code: "polyfill-loaded-too-late",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("polyfill-loaded-too-late"),
    );
    expect(document.querySelector("[data-noritrans-ui]")).toBeNull();
    expect(() => {
      control.updatePageStatus({
        state: "translating",
        total: 1,
        completed: 0,
        failed: 0,
      });
      control.show();
      control.hide();
      control.destroy();
    }).not.toThrow();
    warn.mockRestore();
  });
});
