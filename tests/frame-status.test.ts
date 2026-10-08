import {
  aggregatePageStatuses,
  aggregateSubtitleStatuses,
} from "@/src/frames/status";
import {
  ChildFrameStatusStore,
  shouldHideNativeSubtitles,
} from "@/entrypoints/video.content";
import { DEFAULT_SETTINGS } from "@/src/shared/settings";
import { describe, expect, it } from "vitest";

describe("frame status aggregation", () => {
  const pageStatus = (total: number) => ({
    state: "translated" as const,
    total,
    completed: total,
    failed: 0,
  });
  const subtitleStatus = (total: number) => ({
    state: "ready" as const,
    source: "texttrack",
    completeness: "full" as const,
    total,
    completed: total,
    failed: 0,
  });

  it("keeps native captions hidden throughout a translated-only task", () => {
    const settings = {
      ...DEFAULT_SETTINGS.subtitles,
      displayMode: "translated" as const,
      hideNativeSubtitles: true,
    };
    expect(
      shouldHideNativeSubtitles(
        settings,
        {
          state: "translating",
          source: "dom",
          completeness: "stream",
          total: 5,
          completed: 1,
          failed: 0,
        },
        false,
      ),
    ).toBe(true);
    expect(
      shouldHideNativeSubtitles(
        settings,
        {
          state: "cancelled",
          source: "dom",
          completeness: "stream",
          total: 5,
          completed: 1,
          failed: 4,
        },
        false,
      ),
    ).toBe(false);
  });

  it("keeps native bilingual captions hidden across translated cue gaps", () => {
    const settings = {
      ...DEFAULT_SETTINGS.subtitles,
      displayMode: "bilingual" as const,
      hideNativeSubtitles: true,
    };
    const status = {
      state: "translating" as const,
      source: "dom" as const,
      completeness: "stream" as const,
      total: 2,
      completed: 0,
      failed: 0,
    };
    expect(shouldHideNativeSubtitles(settings, status, false)).toBe(true);
    expect(shouldHideNativeSubtitles(settings, status, true)).toBe(true);
  });

  it("reports a cancelled page and treats unavailable as all-or-nothing", () => {
    expect(
      aggregatePageStatuses(
        { state: "cancelled", total: 4, completed: 3, failed: 1 },
        [{ state: "translated", total: 2, completed: 2, failed: 0 }],
      ),
    ).toMatchObject({ state: "cancelled", total: 6, completed: 5, failed: 1 });
    expect(
      aggregatePageStatuses(
        { state: "idle", total: 0, completed: 0, failed: 0 },
        [{ state: "unavailable", total: 0, completed: 0, failed: 0 }],
      ),
    ).toMatchObject({ state: "idle" });
    expect(
      aggregatePageStatuses(
        { state: "unavailable", total: 0, completed: 0, failed: 0 },
        [{ state: "unavailable", total: 0, completed: 0, failed: 0 }],
      ),
    ).toMatchObject({ state: "unavailable" });
  });

  it("sums page progress and keeps a child translation cancellable", () => {
    expect(
      aggregatePageStatuses(
        { state: "translated", total: 2, completed: 2, failed: 0 },
        [
          {
            state: "translating",
            total: 5,
            completed: 1,
            failed: 1,
            details: "Missing result IDs: child-1.",
          },
        ],
      ),
    ).toEqual({
      state: "translating",
      total: 7,
      completed: 3,
      failed: 1,
      details: "Missing result IDs: child-1.",
    });
  });

  it("keeps a disabled subtitle feature distinct from a missing track", () => {
    const disabled = {
      state: "disabled" as const,
      total: 0,
      completed: 0,
      failed: 0,
    };
    const unavailable = { ...disabled, state: "unavailable" as const };
    expect(aggregateSubtitleStatuses(disabled, [unavailable])).toEqual(
      disabled,
    );
    expect(aggregateSubtitleStatuses(unavailable, [unavailable])).toEqual(
      unavailable,
    );
    expect(
      aggregateSubtitleStatuses(disabled, [
        { state: "ready", total: 1, completed: 1, failed: 0 },
      ]),
    ).toMatchObject({ state: "ready", total: 1 });
  });

  it("combines independent frame subtitle tracks without claiming full completeness", () => {
    expect(
      aggregateSubtitleStatuses(
        { state: "unavailable", total: 0, completed: 0, failed: 0 },
        [
          {
            state: "ready",
            source: "texttrack",
            completeness: "full",
            total: 3,
            completed: 3,
            failed: 0,
          },
          {
            state: "partial",
            source: "dom",
            completeness: "stream",
            total: 2,
            completed: 1,
            failed: 1,
          },
        ],
      ),
    ).toEqual({
      state: "partial",
      completeness: "stream",
      total: 5,
      completed: 4,
      failed: 1,
    });
  });

  it("reports a cancelled frame above a frame that is still waiting for a track", () => {
    expect(
      aggregateSubtitleStatuses(
        {
          state: "cancelled",
          source: "dom",
          completeness: "stream",
          total: 8,
          completed: 6,
          failed: 2,
        },
        [{ state: "waiting", total: 0, completed: 0, failed: 0 }],
      ),
    ).toEqual({
      state: "cancelled",
      source: "dom",
      completeness: "stream",
      total: 8,
      completed: 6,
      failed: 2,
    });
  });

  it("follows the controller once a cancelled frame starts a new task", () => {
    // After a cancel the controller resets for the next video, a changed
    // source language, or a newly discovered track; the aggregate must not
    // keep reporting the earlier cancellation.
    expect(
      aggregateSubtitleStatuses(
        {
          state: "translating",
          source: "youtube-timedtext",
          completeness: "full",
          total: 10,
          completed: 2,
          failed: 0,
        },
        [],
      ),
    ).toMatchObject({ state: "translating", total: 10, completed: 2 });
    expect(
      aggregateSubtitleStatuses(
        { state: "waiting", total: 0, completed: 0, failed: 0 },
        [],
      ),
    ).toMatchObject({ state: "waiting" });
    expect(
      aggregateSubtitleStatuses(
        {
          state: "cancelled",
          source: "dom",
          completeness: "stream",
          total: 3,
          completed: 1,
          failed: 2,
        },
        [
          {
            state: "translating",
            source: "dom",
            completeness: "stream",
            total: 4,
            completed: 1,
            failed: 0,
          },
        ],
      ),
    ).toMatchObject({ state: "translating", total: 7 });
  });

  it("keeps the reason when every frame reports no usable subtitle track", () => {
    const reason = "subtitle language does not match";
    expect(
      aggregateSubtitleStatuses(
        { state: "unavailable", total: 0, completed: 0, failed: 0 },
        [
          {
            state: "unavailable",
            total: 0,
            completed: 0,
            failed: 0,
            message: reason,
          },
        ],
      ),
    ).toEqual({
      state: "unavailable",
      total: 0,
      completed: 0,
      failed: 0,
      message: reason,
    });
  });

  it("clears only the matching frame instance and rejects its late update", () => {
    const store = new ChildFrameStatusStore();
    expect(
      store.update(4, "frame-a", pageStatus(2), subtitleStatus(1), 1_000),
    ).toBe(true);
    expect(
      store.update(7, "frame-b", pageStatus(3), subtitleStatus(2), 1_000),
    ).toBe(true);

    expect(store.clear(4, "frame-a", 1_100)).toBe(true);
    expect(store.values()).toMatchObject([
      { frameInstanceId: "frame-b", pageStatus: { total: 3 } },
    ]);
    expect(
      store.update(4, "frame-a", pageStatus(9), subtitleStatus(9), 1_200),
    ).toBe(false);
    expect(store.values()).toHaveLength(1);
  });

  it("accepts a new instance for a reused frame ID without letting the old instance replace it", () => {
    const store = new ChildFrameStatusStore();
    store.update(4, "old-instance", pageStatus(1), subtitleStatus(1), 1_000);
    expect(
      store.update(4, "new-instance", pageStatus(2), subtitleStatus(2), 1_100),
    ).toBe(true);
    expect(store.clear(4, "old-instance", 1_200)).toBe(false);
    expect(
      store.update(4, "old-instance", pageStatus(8), subtitleStatus(8), 1_300),
    ).toBe(false);
    expect(store.values()).toMatchObject([
      { frameInstanceId: "new-instance", pageStatus: { total: 2 } },
    ]);
  });

  it("keeps the status TTL fallback for frames that cannot send cleanup", () => {
    const store = new ChildFrameStatusStore();
    store.update(4, "frame-a", pageStatus(1), subtitleStatus(1), 1_000);
    store.update(7, "frame-b", pageStatus(2), subtitleStatus(2), 4_000);

    store.prune(6_001);

    expect(store.values()).toMatchObject([
      { frameInstanceId: "frame-b", pageStatus: { total: 2 } },
    ]);
  });
});
