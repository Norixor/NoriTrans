import { removeStaleRuntimeUi } from "@/src/shared/runtime-ui-cleanup";
import { beforeEach, describe, expect, it } from "vitest";

describe("stale content runtime UI cleanup", () => {
  beforeEach(() => {
    document.documentElement.replaceChildren(
      document.createElement("head"),
      document.createElement("body"),
    );
  });

  it("removes transient runtime UI while preserving page translations", () => {
    document.body.innerHTML = `
      <noritrans-floating-control data-noritrans-ui="unified-floating-control"></noritrans-floating-control>
      <div data-noritrans-ui="subtitle-overlay"><button class="stop-button">Old</button></div>
      <style data-noritrans-ui="native-subtitle-visibility"></style>
      <div data-noritrans-ui="subtitle-fullscreen-portal">
        <div data-noritrans-ui="subtitle-overlay"></div>
      </div>
      <div data-noritrans-ui="floating-control-fullscreen-portal"></div>
      <div data-noritrans-ui="floating-control"></div>
      <div data-noritrans-ui="floating-control-portal"></div>
      <div data-noritrans-ui="ocr-region-selector"></div>
      <noritrans-translation data-noritrans-translated="segment-1">Translated</noritrans-translation>
      <div data-noritrans-ui="unknown-future-marker"></div>
    `;

    expect(removeStaleRuntimeUi()).toBe(9);
    // Legacy hosts of the previous control (orphaned by an update) go too.
    expect(document.querySelector("noritrans-floating-control")).toBeNull();
    expect(
      document.querySelector('[data-noritrans-ui^="floating-control"]'),
    ).toBeNull();
    expect(document.querySelector(".stop-button")).toBeNull();
    expect(document.querySelector("noritrans-translation")?.textContent).toBe(
      "Translated",
    );
    expect(
      document.querySelector('[data-noritrans-ui="unknown-future-marker"]'),
    ).not.toBeNull();
  });
});
