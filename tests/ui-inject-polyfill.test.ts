import { describe, expect, it } from "vitest";

/*
 * Simulates a content-script isolated world, where `customElements` is null.
 * Runs in its own file because the polyfill patches DOM prototypes for the
 * whole test environment. Defining and rendering components under the
 * polyfill is verified in real Chromium only: jsdom's separate realm makes
 * the polyfill reject class prototypes (`instanceof Object` across realms).
 */
describe("injected UI polyfill in an isolated world", () => {
  it("replaces the null registry and disables document-wide flushing", async () => {
    const nativeHTMLElement = window.HTMLElement;
    Object.defineProperty(window, "customElements", {
      configurable: true,
      value: null,
    });
    const { customElementsMode } = await import("@/src/ui/inject/polyfill");
    expect(customElementsMode).toBe("polyfill");
    const registry = window.customElements as CustomElementRegistry &
      Record<symbol, unknown>;
    expect(typeof registry.define).toBe("function");
    // The pre-polyfill placeholder must not survive the installation.
    expect(registry).not.toHaveProperty("noDocumentConstructionObserver");
    expect(
      registry[Symbol.for("noritrans.ui.custom-elements-flush-disabled")],
    ).toBe(true);
    expect(window.HTMLElement).not.toBe(nativeHTMLElement);
  });
});
