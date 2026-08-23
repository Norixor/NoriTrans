import { DirtyControlTracker } from "@/entrypoints/options/dirty-control-tracker";
import { describe, expect, it } from "vitest";

describe("options dirty control tracker", () => {
  it("clears only fields that did not change again while save was pending", () => {
    const tracker = new DirtyControlTracker();
    tracker.mark("model");
    tracker.mark("target-language");
    const submitted = tracker.snapshot();

    tracker.mark("model");
    tracker.confirm(submitted);

    expect(tracker.has("model")).toBe(true);
    expect(tracker.has("target-language")).toBe(false);
    expect(tracker.size).toBe(1);
  });

  it("does not clear a field first edited after the submitted snapshot", () => {
    const tracker = new DirtyControlTracker();
    const submitted = tracker.snapshot();

    tracker.mark("system-prompt");
    tracker.confirm(submitted);

    expect(tracker.has("system-prompt")).toBe(true);
  });
});
