import { describe, expect, it } from "vitest";

import {
  groupForCue,
  groupFullSubtitleTrack,
  groupSubtitleCues,
} from "@/src/subtitles/groups";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";

describe("subtitle sentence groups", () => {
  it("merges short fragments into stable semantic groups and preserves cue mapping", () => {
    const cues: SubtitleCue[] = [
      { id: "a", startMs: 0, endMs: 800, originalText: "Hello" },
      { id: "b", startMs: 850, endMs: 1_700, originalText: "world." },
      { id: "c", startMs: 1_800, endMs: 2_700, originalText: "Next sentence." },
    ];

    const groups = groupSubtitleCues(cues);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      id: "sentence:a+b",
      startMs: 0,
      endMs: 1_700,
      originalText: "Hello world.",
      sourceCueIds: ["a", "b"],
    });
    expect(groupForCue(groups, "b")?.id).toBe("sentence:a+b");
    expect(groupSubtitleCues(cues)).toEqual(groups);
  });

  it("keeps speaker changes, long gaps, and complete sentences separate", () => {
    const groups = groupSubtitleCues([
      { id: "a", startMs: 0, endMs: 800, originalText: "Complete." },
      { id: "b", startMs: 850, endMs: 1_500, originalText: "— New speaker" },
      { id: "c", startMs: 3_000, endMs: 3_900, originalText: "Later" },
    ]);

    expect(groups.map((group) => group.sourceCueIds)).toEqual([
      ["a"],
      ["b"],
      ["c"],
    ]);
  });

  it("joins CJK fragments without injecting Latin spaces and leaves streams untouched", () => {
    const stream: SubtitleTrack = {
      source: "dom",
      completeness: "stream",
      language: "zh-CN",
      cues: [
        { id: "a", startMs: 0, endMs: 500, originalText: "你" },
        { id: "b", startMs: 500, endMs: 1_000, originalText: "好。" },
      ],
    };

    expect(groupSubtitleCues(stream.cues)[0]?.originalText).toBe("你好。");
    expect(groupFullSubtitleTrack(stream)).toBe(stream);
  });
});
