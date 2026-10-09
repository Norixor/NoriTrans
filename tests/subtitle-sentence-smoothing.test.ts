import { describe, expect, it } from "vitest";
import { promptVersion } from "@/src/cache/keys";
import { isBackgroundCommand } from "@/src/messaging/protocol";
import { DEFAULT_SETTINGS, mergeSettings } from "@/src/shared/settings";
import { parseSettingsPatch } from "@/src/shared/settings-patch";
import {
  MAX_FRAGMENT_CONTEXT_ITEMS,
  MAX_FRAGMENT_NEIGHBOR_CHARACTERS,
  fragmentAwareSegments,
} from "@/src/subtitles/fragment-context";
import type { SubtitleCue, SubtitleTrack } from "@/src/subtitles/types";
import { contextualizeSegments } from "@/src/translation/context";
import {
  FRAGMENT_AWARE_PROMPT_VERSION,
  fragmentAwarePromptIdentity,
} from "@/src/translation/fragment-aware";

// Synthetic, self-written subtitle lines only.
function cue(
  id: string,
  startMs: number,
  endMs: number,
  originalText: string,
): SubtitleCue {
  return { id, startMs, endMs, originalText };
}

function fullTrack(cues: SubtitleCue[]): SubtitleTrack {
  return { source: "texttrack", completeness: "full", language: "en", cues };
}

function plainSegment(track: SubtitleTrack, target: SubtitleCue) {
  return contextualizeSegments(
    track.cues.map((item) => ({ id: item.id, text: item.originalText })),
    [{ id: target.id, text: target.originalText }],
  )[0];
}

const SPLIT_TRACK = fullTrack([
  cue("before-1", 0, 900, "The bus was late again."),
  cue("before-2", 1_000, 1_900, "We waited outside."),
  cue("split-1", 2_000, 2_900, "we walked down to the"),
  cue("split-2", 3_000, 3_900, "river and sat there"),
  cue("split-3", 4_000, 4_900, "until it got dark."),
  cue("after-1", 5_000, 5_900, "Nobody said a word."),
  cue("after-2", 6_000, 6_900, "Then it rained."),
  cue("after-3", 7_000, 7_900, "We went home."),
]);

function contextCharacters(values: readonly string[] | undefined): number {
  return (values ?? []).reduce((total, value) => total + value.length, 0);
}

describe("fragment-aware subtitle segments", () => {
  it("gives every fragment the whole sentence nearest to its text, then bounded neighbors", () => {
    const segments = fragmentAwareSegments(SPLIT_TRACK, SPLIT_TRACK.cues);
    const byId = new Map(segments.map((segment) => [segment.id, segment]));

    // Each cue keeps its own stable ID and own text.
    expect(segments.map((segment) => segment.id)).toEqual(
      SPLIT_TRACK.cues.map((item) => item.id),
    );
    expect(byId.get("split-2")).toEqual({
      id: "split-2",
      text: "river and sat there",
      contextBefore: [
        "The bus was late again.",
        "We waited outside.",
        "we walked down to the",
      ],
      contextAfter: [
        "until it got dark.",
        "Nobody said a word.",
        "Then it rained.",
      ],
    });
    expect(byId.get("split-1")).toMatchObject({
      contextBefore: ["The bus was late again.", "We waited outside."],
      contextAfter: [
        "river and sat there",
        "until it got dark.",
        "Nobody said a word.",
        "Then it rained.",
      ],
    });
    expect(byId.get("split-3")).toMatchObject({
      contextBefore: [
        "The bus was late again.",
        "We waited outside.",
        "we walked down to the",
        "river and sat there",
      ],
      contextAfter: ["Nobody said a word.", "Then it rained."],
    });
  });

  it("keeps the ordinary AI context for cues outside a multi-cue sentence", () => {
    const segments = fragmentAwareSegments(SPLIT_TRACK, SPLIT_TRACK.cues);
    for (const id of [
      "before-1",
      "before-2",
      "after-1",
      "after-2",
      "after-3",
    ]) {
      const target = SPLIT_TRACK.cues.find((item) => item.id === id);
      if (!target) throw new Error(`missing ${id}`);
      expect(segments.find((segment) => segment.id === id)).toEqual(
        plainSegment(SPLIT_TRACK, target),
      );
    }
  });

  it("does not join speaker-dash dialogue or sound labels into a sentence", () => {
    const track = fullTrack([
      cue("dash-1", 0, 900, "- Are you coming with us"),
      cue("dash-2", 1_000, 1_900, "- Not tonight"),
      cue("sound", 2_000, 2_900, "[music]"),
      cue("after-sound", 3_000, 3_900, "and then the lights went out"),
    ]);
    const segments = fragmentAwareSegments(track, track.cues);
    for (const target of track.cues.slice(0, 3)) {
      expect(segments.find((segment) => segment.id === target.id)).toEqual(
        plainSegment(track, target),
      );
    }
  });

  it("joins overlapping fragments and keeps each fragment as its own segment", () => {
    const track = fullTrack([
      cue("overlap-1", 0, 1_400, "if you really want to"),
      cue("overlap-2", 1_000, 2_400, "know the answer, ask her."),
    ]);
    expect(fragmentAwareSegments(track, track.cues)).toEqual([
      {
        id: "overlap-1",
        text: "if you really want to",
        contextBefore: [],
        contextAfter: ["know the answer, ask her."],
      },
      {
        id: "overlap-2",
        text: "know the answer, ask her.",
        contextBefore: ["if you really want to"],
        contextAfter: [],
      },
    ]);
  });

  it("bounds a long six-fragment sentence to the protocol context limit", () => {
    const words = ["so", "we", "kept", "on", "walking", "slowly"];
    const track = fullTrack([
      cue("lead", 0, 400, "Listen."),
      ...words.map((word, index) =>
        cue(`long-${index}`, 500 + index * 500, 900 + index * 500, word),
      ),
      // A seventh fragment exceeds the six-cue group limit and starts anew.
      cue("long-6", 3_500, 3_900, "along the shore"),
      cue("tail", 4_000, 4_400, "And stopped."),
    ]);
    const segments = fragmentAwareSegments(track, track.cues);
    const last = segments.find((segment) => segment.id === "long-5");
    expect(last?.contextBefore).toHaveLength(MAX_FRAGMENT_CONTEXT_ITEMS);
    // The farthest fragments collapse into one entry; none is dropped.
    expect(last?.contextBefore).toEqual(["so we", "kept", "on", "walking"]);
    const first = segments.find((segment) => segment.id === "long-0");
    expect(first?.contextAfter).toEqual(["we", "kept", "on", "walking slowly"]);
    for (const segment of segments) {
      expect(segment.contextBefore?.length ?? 0).toBeLessThanOrEqual(
        MAX_FRAGMENT_CONTEXT_ITEMS,
      );
      expect(segment.contextAfter?.length ?? 0).toBeLessThanOrEqual(
        MAX_FRAGMENT_CONTEXT_ITEMS,
      );
    }
  });

  it("caps neighboring dialogue characters while always keeping same-sentence fragments", () => {
    const longLine = `${"a long neighboring line ".repeat(17).trim()}.`;
    const track = fullTrack([
      cue("long-before-1", 0, 900, longLine),
      cue("long-before-2", 1_000, 1_900, longLine),
      cue("part-1", 2_000, 2_900, "she said that"),
      cue("part-2", 3_000, 3_900, "it was fine."),
      cue("long-after-1", 4_000, 4_900, longLine),
      cue("long-after-2", 5_000, 5_900, longLine),
    ]);
    const segments = fragmentAwareSegments(track, track.cues);
    const part1 = segments.find((segment) => segment.id === "part-1");
    const part2 = segments.find((segment) => segment.id === "part-2");
    expect(part1?.contextAfter?.[0]).toBe("it was fine.");
    expect(part2?.contextBefore?.at(-1)).toBe("she said that");
    for (const segment of [part1, part2]) {
      const neighborsBefore = (segment?.contextBefore ?? []).filter(
        (value) => value === longLine,
      );
      const neighborsAfter = (segment?.contextAfter ?? []).filter(
        (value) => value === longLine,
      );
      expect(contextCharacters(neighborsBefore)).toBeLessThanOrEqual(
        MAX_FRAGMENT_NEIGHBOR_CHARACTERS,
      );
      expect(contextCharacters(neighborsAfter)).toBeLessThanOrEqual(
        MAX_FRAGMENT_NEIGHBOR_CHARACTERS,
      );
    }
  });

  it("produces segments the TRANSLATE guard accepts only as an AI request", () => {
    const segments = fragmentAwareSegments(SPLIT_TRACK, SPLIT_TRACK.cues);
    const request = {
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
      mode: "ai" as const,
      segments,
      fragmentAware: true,
    };
    expect(
      isBackgroundCommand({ type: "TRANSLATE", requestId: "r", request }),
    ).toBe(true);
    for (const invalid of [
      { ...request, mode: "fast" as const },
      { ...request, fragmentAware: false },
      { ...request, fragmentAware: "yes" },
    ]) {
      expect(
        isBackgroundCommand({
          type: "TRANSLATE",
          requestId: "r",
          request: invalid,
        }),
      ).toBe(false);
    }
  });
});

describe("fragment-aware cache identity", () => {
  it("leaves unmarked prompt identities unchanged and separates marked ones", () => {
    const prompt = "Translate naturally.";
    expect(fragmentAwarePromptIdentity(prompt, undefined)).toBe(prompt);
    expect(fragmentAwarePromptIdentity(prompt, false)).toBe(prompt);
    expect(fragmentAwarePromptIdentity(prompt, true)).toBe(
      `${prompt}\u001f${FRAGMENT_AWARE_PROMPT_VERSION}`,
    );
    expect(promptVersion(fragmentAwarePromptIdentity(prompt, true))).not.toBe(
      promptVersion(prompt),
    );
  });
});

describe("sentence smoothing setting", () => {
  it("defaults on and normalizes missing or malformed stored values", () => {
    expect(DEFAULT_SETTINGS.subtitles.sentenceSmoothing).toBe(true);
    const legacySubtitles: Record<string, unknown> = {
      ...DEFAULT_SETTINGS.subtitles,
    };
    delete legacySubtitles.sentenceSmoothing;
    expect(
      mergeSettings({ ...DEFAULT_SETTINGS, subtitles: legacySubtitles })
        .subtitles.sentenceSmoothing,
    ).toBe(true);
    expect(
      mergeSettings({
        ...DEFAULT_SETTINGS,
        subtitles: { ...DEFAULT_SETTINGS.subtitles, sentenceSmoothing: "no" },
      }).subtitles.sentenceSmoothing,
    ).toBe(true);
    const stored = mergeSettings({
      ...DEFAULT_SETTINGS,
      subtitles: { ...DEFAULT_SETTINGS.subtitles, sentenceSmoothing: false },
    });
    expect(stored.subtitles.sentenceSmoothing).toBe(false);
    // Other subtitle choices are untouched by the new key.
    expect({ ...stored.subtitles, sentenceSmoothing: true }).toEqual(
      DEFAULT_SETTINGS.subtitles,
    );
  });

  it("accepts boolean patches and rejects other types", () => {
    expect(
      parseSettingsPatch({ subtitles: { sentenceSmoothing: false } }),
    ).toEqual({ ok: true, patch: { subtitles: { sentenceSmoothing: false } } });
    for (const value of ["false", 0, null]) {
      expect(
        parseSettingsPatch({ subtitles: { sentenceSmoothing: value } }).ok,
      ).toBe(false);
    }
  });

  it("requires the boolean in a full SETTINGS_SET payload", () => {
    expect(
      isBackgroundCommand({ type: "SETTINGS_SET", settings: DEFAULT_SETTINGS }),
    ).toBe(true);
    expect(
      isBackgroundCommand({
        type: "SETTINGS_SET",
        settings: {
          ...DEFAULT_SETTINGS,
          subtitles: { ...DEFAULT_SETTINGS.subtitles, sentenceSmoothing: 1 },
        },
      }),
    ).toBe(false);
  });
});
