import { describe, expect, it } from "vitest";

/*
 * When an entry evaluates `lit` before the polyfill, the components extend the
 * native `HTMLElement`, which an isolated world cannot construct. The failure
 * must be reported with its own code instead of throwing on first render.
 * Runs in its own file because the polyfill patches DOM prototypes.
 */
describe("ensureInjectedUi with a wrong import order", () => {
  it("reports polyfill-loaded-too-late", async () => {
    await import("lit");
    await import("@/src/ui/components");
    Object.defineProperty(window, "customElements", {
      configurable: true,
      value: null,
    });
    const { ensureInjectedUi } = await import("@/src/ui/inject");
    expect(ensureInjectedUi()).toEqual({
      ok: false,
      code: "polyfill-loaded-too-late",
    });
  });
});
