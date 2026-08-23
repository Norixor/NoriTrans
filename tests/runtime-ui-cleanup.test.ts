import { removeStaleRuntimeUi } from "@/src/shared/runtime-ui-cleanup";
import { beforeEach, describe, expect, it } from "vitest";

describe("stale content runtime UI cleanup", () => {
  beforeEach(() => {
    document.documentElement.replaceChildren(
      document.createElement("head"),
      document.createElement("body"),
    );
  });

  it("removes transient current and legacy UI while preserving page translations", () => {
    document.body.innerHTML = `
      <norixor-floating-control data-norixortrans-ui="unified-floating-control"></norixor-floating-control>
      <div data-norixortrans-ui="subtitle-overlay"><button class="stop-button">Old</button></div>
      <style data-norixortrans-ui="native-subtitle-visibility"></style>
      <div data-norixortrans-ui="subtitle-fullscreen-portal">
        <div data-norixortrans-ui="subtitle-overlay"></div>
      </div>
      <div data-norixortrans-ui="floating-control-fullscreen-portal"></div>
      <div data-norixortrans-ui="ocr-region-selector"></div>
      <div data-norixor-ui="legacy-widget"></div>
      <norixor-translation data-norixor-translated="segment-1">Translated</norixor-translation>
      <div data-norixortrans-ui="unknown-future-marker"></div>
    `;

    expect(removeStaleRuntimeUi()).toBe(8);
    expect(document.querySelector("norixor-floating-control")).toBeNull();
    expect(document.querySelector(".stop-button")).toBeNull();
    expect(document.querySelector("norixor-translation")?.textContent).toBe(
      "Translated",
    );
    expect(
      document.querySelector('[data-norixortrans-ui="unknown-future-marker"]'),
    ).not.toBeNull();
  });
});
