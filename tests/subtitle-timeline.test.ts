import {
  normalizeSubtitleTrack,
  subtitleTrackFingerprint,
} from "@/src/subtitles/timeline";
import type { SubtitleTrack } from "@/src/subtitles/types";
import { describe, expect, it } from "vitest";

describe("subtitle timeline identity", () => {
  it("sorts cues, rejects unusable timestamps, and preserves multiline text", () => {
    const track: SubtitleTrack = {
      source: "network",
      completeness: "full",
      language: "en",
      cues: [
        {
          id: "later",
          startMs: 2_000,
          endMs: 3_000,
          originalText: "Line 1\nLine 2",
        },
        { id: "invalid", startMs: -1, endMs: 2_000, originalText: "Invalid" },
        { id: "first", startMs: 0, endMs: 1_000, originalText: "First" },
      ],
    };

    expect(normalizeSubtitleTrack(track).cues).toEqual([
      { id: "first", startMs: 0, endMs: 1_000, originalText: "First" },
      {
        id: "later",
        startMs: 2_000,
        endMs: 3_000,
        originalText: "Line 1\nLine 2",
      },
    ]);
  });

  it("changes the full-track fingerprint when a middle cue changes", () => {
    const base: SubtitleTrack = {
      source: "youtube-timedtext",
      completeness: "full",
      language: "en",
      cues: [
        { id: "first", startMs: 0, endMs: 1_000, originalText: "First" },
        { id: "middle", startMs: 1_000, endMs: 2_000, originalText: "Middle" },
        { id: "last", startMs: 2_000, endMs: 3_000, originalText: "Last" },
      ],
    };
    const changed = {
      ...base,
      cues: base.cues.map((cue) =>
        cue.id === "middle" ? { ...cue, originalText: "Changed" } : cue,
      ),
    };

    expect(subtitleTrackFingerprint(changed)).not.toBe(
      subtitleTrackFingerprint(base),
    );
  });
});
