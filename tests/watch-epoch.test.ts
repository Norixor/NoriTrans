import { WatchEpochTracker } from "@/src/subtitles/adapters/watch-epoch";
import { describe, expect, it } from "vitest";

describe("WatchEpochTracker", () => {
  it("stays in the same epoch while the watch path is unchanged", () => {
    const tracker = new WatchEpochTracker("/watch/1");

    expect(tracker.roll("/watch/1", ["https://cdn.example/old"])).toBe(false);
    expect(tracker.isStale("https://cdn.example/old")).toBe(false);
  });

  it("marks everything requested before a path change as stale", () => {
    const tracker = new WatchEpochTracker("/watch/1");

    expect(
      tracker.roll("/watch/2", [
        "https://cdn.example/episode-1-subtitles",
        "https://cdn.example/episode-1-video",
      ]),
    ).toBe(true);

    expect(tracker.currentPath).toBe("/watch/2");
    expect(tracker.isStale("https://cdn.example/episode-1-subtitles")).toBe(
      true,
    );
    // A URL requested after the change is never in the snapshot.
    expect(tracker.isStale("https://cdn.example/episode-2-subtitles")).toBe(
      false,
    );
  });

  it("keeps earlier episodes stale across several path changes", () => {
    const tracker = new WatchEpochTracker("/watch/1");
    tracker.roll("/watch/2", ["https://cdn.example/one"]);
    tracker.roll("/watch/3", ["https://cdn.example/two"]);

    expect(tracker.isStale("https://cdn.example/one")).toBe(true);
    expect(tracker.isStale("https://cdn.example/two")).toBe(true);
  });

  it("bounds the stale set by dropping the oldest URLs", () => {
    const tracker = new WatchEpochTracker("/watch/1");
    const urls = Array.from(
      { length: 2_100 },
      (_, index) => `https://cdn.example/${index}`,
    );
    tracker.roll("/watch/2", urls);

    expect(tracker.isStale("https://cdn.example/0")).toBe(false);
    expect(tracker.isStale("https://cdn.example/2099")).toBe(true);
  });
});
