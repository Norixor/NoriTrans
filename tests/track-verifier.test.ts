import {
  TRACK_VERIFY_HEAL_COOLDOWN_MS,
  TRACK_VERIFY_MAX_HEALS_PER_MEDIA,
  TRACK_VERIFY_WARMUP_MS,
  TrackVerifier,
  captionSimilarity,
  dominantScript,
  nativeCaptionMatchesTrack,
  normalizeCaptionText,
  scriptsComparable,
  trackScript,
  type TrackVerifyOutcome,
} from "@/src/subtitles/track-verifier";
import type { SubtitleCue } from "@/src/subtitles/types";
import { describe, expect, it } from "vitest";

// Synthetic, self-written lines only.
const ENGLISH_CUES: SubtitleCue[] = [
  {
    id: "e1",
    startMs: 10_000,
    endMs: 12_000,
    originalText: "The lighthouse keeper counted every boat at dawn.",
  },
  {
    id: "e2",
    startMs: 12_500,
    endMs: 14_000,
    originalText: "<i>Nobody</i> remembered the third bell.",
  },
  {
    id: "e3",
    startMs: 40_000,
    endMs: 42_000,
    originalText: "Bring the copper kettle back to the kitchen.",
  },
];

describe("caption normalization and similarity", () => {
  it("normalizes width, tags, punctuation, case and whitespace", () => {
    expect(normalizeCaptionText("  <i>ＨＥＬＬＯ</i>,\n  World!! ")).toBe(
      "hello world",
    );
    expect(normalizeCaptionText("「こんにちは。」")).toBe("こんにちは");
  });

  it("matches English lines despite punctuation, case and line breaks", () => {
    expect(
      captionSimilarity(
        "- The lighthouse keeper\ncounted every boat at dawn",
        "The lighthouse keeper counted every boat at dawn.",
        "latin",
      ),
    ).toBeGreaterThan(0.9);
  });

  it("tolerates a small word difference but not unrelated stopword overlap", () => {
    expect(
      captionSimilarity(
        "We should leave before the river floods the road",
        "We should go before the river floods the road",
        "latin",
      ),
    ).toBeGreaterThanOrEqual(0.5);
    expect(
      captionSimilarity(
        "I don't know what you want from me",
        "You know what I mean",
        "latin",
      ),
    ).toBeLessThan(0.5);
  });

  it("compares Japanese and Chinese by character bigrams", () => {
    expect(
      captionSimilarity(
        "明日の朝、駅の前で待っているよ。",
        "明日の朝 駅の前で待っているよ",
        "japanese",
      ),
    ).toBe(1);
    expect(
      captionSimilarity(
        "我们明天早上在车站门口见面吧",
        "我们明天早上在车站门口见吧",
        "han",
      ),
    ).toBeGreaterThan(0.8);
    expect(
      captionSimilarity(
        "我们明天早上在车站门口见面吧",
        "这本书的封面被雨水打湿了",
        "han",
      ),
    ).toBeLessThan(0.5);
  });

  it("matches a native caption against cues within the playback window", () => {
    expect(
      nativeCaptionMatchesTrack(
        "Nobody remembered the third bell",
        ENGLISH_CUES,
        11_000,
        "latin",
      ),
    ).toBe(true);
    // Two overlapping cues shown as one block (different line breaking).
    expect(
      nativeCaptionMatchesTrack(
        "counted every boat at dawn. Nobody remembered the third bell.",
        ENGLISH_CUES,
        12_000,
        "latin",
      ),
    ).toBe(true);
    // The matching cue is outside the ±3 s window.
    expect(
      nativeCaptionMatchesTrack(
        "Bring the copper kettle back to the kitchen",
        ENGLISH_CUES,
        11_000,
        "latin",
      ),
    ).toBe(false);
  });
});

describe("script comparability", () => {
  it("detects dominant scripts", () => {
    expect(dominantScript("Hello there, friend")).toBe("latin");
    expect(dominantScript("明日の朝、駅で待つ")).toBe("japanese");
    expect(dominantScript("我们明天早上见")).toBe("han");
    expect(dominantScript("내일 아침에 만나요")).toBe("hangul");
    expect(dominantScript("Доброе утро")).toBe("cyrillic");
    expect(dominantScript("12:30 !!")).toBeNull();
    expect(trackScript(ENGLISH_CUES)).toBe("latin");
  });

  it("treats different writing systems and unknown scripts as incomparable", () => {
    expect(scriptsComparable("latin", "latin")).toBe(true);
    expect(scriptsComparable("han", "japanese")).toBe(false);
    expect(scriptsComparable("latin", "han")).toBe(false);
    expect(scriptsComparable(null, null)).toBe(false);
  });
});

const WRONG_LINES = [
  "A completely different sentence about orange trains",
  "Another unrelated remark concerning the winter market",
  "Yet one more line describing a quiet mountain road",
  "The fourth unrelated caption mentions silver spoons",
];

function startedVerifier(mediaKey = "media-a", fingerprint = "fp-1") {
  const verifier = new TrackVerifier();
  let now = 1_000_000;
  let mediaMs = 10_000;
  verifier.beginTrack(mediaKey, fingerprint, ENGLISH_CUES, now);
  const step = (nativeText: string): TrackVerifyOutcome => {
    now += 1_500;
    mediaMs += 1_500;
    return verifier.sample({ nativeText, currentTimeMs: mediaMs, now });
  };
  const warm = (): void => {
    // Warmup samples anchor time and are never judged.
    for (let index = 0; index < 3; index += 1) {
      expect(step(WRONG_LINES[0] as string).kind).toBe("idle");
    }
  };
  return {
    verifier,
    step,
    warm,
    advance: (ms: number) => {
      now += ms;
      mediaMs += ms;
    },
    now: () => now,
  };
}

describe("TrackVerifier", () => {
  it("ignores samples during the warmup period", () => {
    const { step } = startedVerifier();
    const outcomes = [
      step(WRONG_LINES[0]!),
      step(WRONG_LINES[1]!),
      step(WRONG_LINES[2]!),
    ];
    expect(outcomes.every((outcome) => outcome.kind === "idle")).toBe(true);
    expect(TRACK_VERIFY_WARMUP_MS).toBe(5_000);
  });

  it("declares a track invalid after three distinct consecutive mismatches", () => {
    const { step, warm } = startedVerifier();
    warm();
    expect(step(WRONG_LINES[1]!)).toEqual({ kind: "mismatch", streak: 1 });
    // The same line repeated on the next sample is not counted again.
    expect(step(WRONG_LINES[1]!)).toEqual({
      kind: "idle",
      reason: "repeated-text",
    });
    expect(step(WRONG_LINES[2]!)).toEqual({ kind: "mismatch", streak: 2 });
    expect(step(WRONG_LINES[3]!)).toEqual({ kind: "invalid", streak: 3 });
  });

  it("resets the streak on any match", () => {
    const { verifier, step, warm, advance } = startedVerifier();
    warm();
    expect(step(WRONG_LINES[1]!).kind).toBe("mismatch");
    expect(step(WRONG_LINES[2]!).kind).toBe("mismatch");
    // Jump the clock back near the matching cue without a discontinuity.
    verifier.interrupt();
    void advance;
    const matched = verifier.sample({
      nativeText: "The lighthouse keeper counted every boat at dawn",
      currentTimeMs: 11_000,
      now: 2_000_000,
    });
    expect(matched).toEqual({ kind: "idle", reason: "discontinuity" });
    expect(
      verifier.sample({
        nativeText: "The lighthouse keeper counted every boat at dawn",
        currentTimeMs: 12_500,
        now: 2_001_500,
      }),
    ).toEqual({ kind: "match" });
    expect(
      verifier.sample({
        nativeText: WRONG_LINES[3]!,
        currentTimeMs: 14_000,
        now: 2_003_000,
      }),
    ).toEqual({ kind: "mismatch", streak: 1 });
  });

  it("does not count empty, short or other-script captions", () => {
    const { step, warm } = startedVerifier();
    warm();
    expect(step("")).toEqual({ kind: "idle", reason: "empty" });
    expect(step("Okay, fine.")).toEqual({
      kind: "skipped",
      reason: "text-too-short",
    });
    expect(step("我们明天早上在车站门口见面吧")).toEqual({
      kind: "skipped",
      reason: "script-mismatch",
    });
    expect(step(WRONG_LINES[1]!)).toEqual({ kind: "mismatch", streak: 1 });
    // Incomparable samples neither count nor clear the streak.
    expect(step("明日の朝、駅の前で待っているよ")).toMatchObject({
      kind: "skipped",
    });
    expect(step(WRONG_LINES[2]!)).toEqual({ kind: "mismatch", streak: 2 });
  });

  it("ignores samples across a playback discontinuity", () => {
    const { verifier, warm, now } = startedVerifier();
    warm();
    expect(
      verifier.sample({
        nativeText: WRONG_LINES[1]!,
        currentTimeMs: 90_000,
        now: now() + 1_500,
      }),
    ).toEqual({ kind: "idle", reason: "discontinuity" });
  });

  it("enforces the heal cooldown and per-media heal limit", () => {
    const verifier = new TrackVerifier();
    let now = 0;
    let mediaMs = 10_000;
    const runToInvalid = (fingerprint: string): TrackVerifyOutcome => {
      verifier.beginTrack("media-a", fingerprint, ENGLISH_CUES, now);
      let last: TrackVerifyOutcome = { kind: "idle", reason: "no-track" };
      for (const line of [
        WRONG_LINES[0],
        WRONG_LINES[0],
        WRONG_LINES[0],
        WRONG_LINES[1],
        WRONG_LINES[2],
        WRONG_LINES[3],
      ]) {
        now += 1_500;
        mediaMs += 1_500;
        last = verifier.sample({
          nativeText: line!,
          currentTimeMs: mediaMs,
          now,
        });
      }
      return last;
    };
    expect(runToInvalid("fp-1").kind).toBe("invalid");
    verifier.recordHeal(now);
    expect(verifier.isHealed("media-a", "fp-1")).toBe(true);
    // A second wrong track inside the cooldown is not healed.
    expect(runToInvalid("fp-2")).toEqual({
      kind: "skipped",
      reason: "cooldown",
    });
    now += TRACK_VERIFY_HEAL_COOLDOWN_MS;
    expect(runToInvalid("fp-2").kind).toBe("invalid");
    verifier.recordHeal(now);
    expect(verifier.healCount).toBe(TRACK_VERIFY_MAX_HEALS_PER_MEDIA);
    now += TRACK_VERIFY_HEAL_COOLDOWN_MS;
    verifier.beginTrack("media-a", "fp-3", ENGLISH_CUES, now);
    expect(
      verifier.sample({
        nativeText: WRONG_LINES[1]!,
        currentTimeMs: mediaMs,
        now,
      }),
    ).toEqual({ kind: "skipped", reason: "heal-limit" });
    // A new media restores the budget and forgets rejected tracks.
    expect(verifier.isHealed("media-b", "fp-1")).toBe(false);
    expect(verifier.healCount).toBe(0);
  });
});
