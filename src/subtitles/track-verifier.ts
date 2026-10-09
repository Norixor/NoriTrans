import type { SubtitleCue } from "@/src/subtitles/types";

/**
 * Self-healing check for a complete subtitle track: compares the caption the
 * website itself is currently showing with the cues the selected full track
 * has around the playback position. A track is declared invalid only after
 * several consecutive, distinct, comparable mismatches, so timing offsets,
 * different line breaking and small wording differences never trigger it.
 *
 * Pure logic: the caller supplies time, native text and playback position.
 */

export const TRACK_VERIFY_SAMPLE_INTERVAL_MS = 1_500;
/** Cues within this distance of the playback position are compared. */
export const TRACK_VERIFY_WINDOW_MS = 3_000;
export const TRACK_VERIFY_MATCH_THRESHOLD = 0.5;
/** Normalized native caption characters (spaces excluded) needed to compare. */
export const TRACK_VERIFY_MIN_CHARACTERS = 12;
export const TRACK_VERIFY_REQUIRED_MISMATCHES = 3;
/** A freshly selected track is not judged while the player settles. */
export const TRACK_VERIFY_WARMUP_MS = 5_000;
export const TRACK_VERIFY_HEAL_COOLDOWN_MS = 30_000;
export const TRACK_VERIFY_MAX_HEALS_PER_MEDIA = 2;
/**
 * A media/wall-clock drift above this between two samples means the
 * position jumped (seek, buffering stall, source swap); such a sample is
 * not trusted.
 */
const DISCONTINUITY_TOLERANCE_MS = 1_500;
const TRACK_SCRIPT_SAMPLE_CUES = 200;
/** A native line almost entirely contained in a cue also counts as a match. */
const CONTAINMENT_THRESHOLD = 0.9;
const CONTAINMENT_MIN_FEATURES = 3;

export type CaptionScript =
  | "latin"
  | "cyrillic"
  | "greek"
  | "arabic"
  | "hebrew"
  | "devanagari"
  | "thai"
  | "hangul"
  | "han"
  | "japanese";

const SCRIPT_PATTERNS: ReadonlyArray<[CaptionScript | "kana", RegExp]> = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["thai", /\p{Script=Thai}/u],
  ["hangul", /\p{Script=Hangul}/u],
  ["han", /\p{Script=Han}/u],
  ["kana", /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
];

/** Scripts written without word separators are compared by character bigrams. */
const UNSEGMENTED_SCRIPTS = new Set<CaptionScript>([
  "han",
  "japanese",
  "hangul",
  "thai",
]);

export function normalizeCaptionText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/<[^>]*>/gu, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedLength(normalized: string): number {
  return normalized.replace(/ /gu, "").length;
}

/**
 * Dominant writing system of a text, or null when it has no letters.
 * Japanese is told apart from Chinese by the presence of kana; Han and kana
 * count together so kanji-heavy Japanese lines remain Japanese.
 */
export function dominantScript(text: string): CaptionScript | null {
  const counts = new Map<CaptionScript | "kana", number>();
  for (const character of text) {
    for (const [script, pattern] of SCRIPT_PATTERNS) {
      if (pattern.test(character)) {
        counts.set(script, (counts.get(script) ?? 0) + 1);
        break;
      }
    }
  }
  const kana = counts.get("kana") ?? 0;
  const han = counts.get("han") ?? 0;
  counts.delete("kana");
  counts.delete("han");
  const cjk = kana + han;
  if (cjk > 0) {
    counts.set(kana > 0 && kana * 10 >= cjk ? "japanese" : "han", cjk);
  }
  let best: CaptionScript | null = null;
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (count > bestCount) {
      best = script as CaptionScript;
      bestCount = count;
    }
  }
  return best;
}

export function scriptsComparable(
  left: CaptionScript | null,
  right: CaptionScript | null,
): boolean {
  return left !== null && left === right;
}

/**
 * Word unigrams plus adjacent word pairs for segmented scripts: the pairs keep
 * common function words ("you", "the") from making unrelated lines look
 * alike. Character bigrams for scripts without word separators.
 */
export function captionFeatures(
  normalized: string,
  script: CaptionScript,
): Set<string> {
  const features = new Set<string>();
  if (UNSEGMENTED_SCRIPTS.has(script)) {
    const characters = Array.from(normalized.replace(/ /gu, ""));
    if (characters.length === 1 && characters[0]) features.add(characters[0]);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      features.add(`${characters[index]}${characters[index + 1]}`);
    }
    return features;
  }
  const words = normalized.split(" ").filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    features.add(words[index] as string);
    if (index + 1 < words.length) {
      features.add(`${words[index]} ${words[index + 1]}`);
    }
  }
  return features;
}

function intersectionSize(left: Set<string>, right: Set<string>): number {
  let shared = 0;
  for (const feature of left) if (right.has(feature)) shared += 1;
  return shared;
}

/** Dice similarity of two caption texts, both normalized internally. */
export function captionSimilarity(
  left: string,
  right: string,
  script: CaptionScript,
): number {
  const a = captionFeatures(normalizeCaptionText(left), script);
  const b = captionFeatures(normalizeCaptionText(right), script);
  if (a.size === 0 || b.size === 0) return 0;
  return (2 * intersectionSize(a, b)) / (a.size + b.size);
}

function windowCues(cues: readonly SubtitleCue[], atMs: number): SubtitleCue[] {
  return cues
    .filter(
      (cue) =>
        cue.startMs <= atMs + TRACK_VERIFY_WINDOW_MS &&
        (cue.endMs ?? cue.startMs) >= atMs - TRACK_VERIFY_WINDOW_MS,
    )
    .sort((left, right) => left.startMs - right.startMs);
}

/**
 * Whether the native caption matches any cue in the window around `atMs`.
 * Adjacent cue pairs are also tried because a player can show two short
 * overlapping cues as one caption block.
 */
export function nativeCaptionMatchesTrack(
  nativeText: string,
  cues: readonly SubtitleCue[],
  atMs: number,
  script: CaptionScript,
): boolean {
  const native = captionFeatures(normalizeCaptionText(nativeText), script);
  if (native.size === 0) return false;
  const nearby = windowCues(cues, atMs);
  const candidates = nearby.map((cue) => cue.originalText);
  for (let index = 0; index + 1 < nearby.length; index += 1) {
    candidates.push(
      `${nearby[index]?.originalText ?? ""} ${nearby[index + 1]?.originalText ?? ""}`,
    );
  }
  return candidates.some((candidate) => {
    const features = captionFeatures(normalizeCaptionText(candidate), script);
    if (features.size === 0) return false;
    const shared = intersectionSize(native, features);
    if (
      (2 * shared) / (native.size + features.size) >=
      TRACK_VERIFY_MATCH_THRESHOLD
    )
      return true;
    return (
      native.size >= CONTAINMENT_MIN_FEATURES &&
      shared / native.size >= CONTAINMENT_THRESHOLD
    );
  });
}

/** Dominant script of a track, from an evenly spread sample of its cues. */
export function trackScript(
  cues: readonly SubtitleCue[],
): CaptionScript | null {
  if (cues.length === 0) return null;
  const step = Math.max(1, Math.floor(cues.length / TRACK_SCRIPT_SAMPLE_CUES));
  const sample: string[] = [];
  for (let index = 0; index < cues.length; index += step) {
    sample.push(cues[index]?.originalText ?? "");
  }
  return dominantScript(sample.join(" "));
}

export type TrackVerifySkipReason =
  "script-mismatch" | "text-too-short" | "cooldown" | "heal-limit";

export type TrackVerifyOutcome =
  | {
      kind: "idle";
      reason:
        "no-track" | "warmup" | "empty" | "repeated-text" | "discontinuity";
    }
  | { kind: "match" }
  | { kind: "mismatch"; streak: number }
  | { kind: "skipped"; reason: TrackVerifySkipReason }
  | { kind: "invalid"; streak: number };

export interface TrackVerifySample {
  nativeText: string;
  currentTimeMs: number;
  now: number;
  playbackRate?: number;
}

interface VerifiedTrack {
  fingerprint: string;
  cues: readonly SubtitleCue[];
  selectedAt: number;
  script: CaptionScript | null | undefined;
}

export class TrackVerifier {
  private mediaKey = "";
  private heals = 0;
  private lastHealAt = Number.NEGATIVE_INFINITY;
  private readonly healedFingerprints = new Set<string>();
  private track: VerifiedTrack | null = null;
  /** Distinct normalized native texts of the current mismatch streak. */
  private mismatchTexts: string[] = [];
  private anchor: { mediaMs: number; wallMs: number } | null = null;

  /** Forget heal budget and rejected tracks when the persistent media changes. */
  private enterMedia(mediaKey: string): void {
    if (mediaKey === this.mediaKey) return;
    this.mediaKey = mediaKey;
    this.heals = 0;
    this.lastHealAt = Number.NEGATIVE_INFINITY;
    this.healedFingerprints.clear();
  }

  /** True when this exact track was already healed away for this media. */
  isHealed(mediaKey: string, fingerprint: string): boolean {
    this.enterMedia(mediaKey);
    return this.healedFingerprints.has(fingerprint);
  }

  beginTrack(
    mediaKey: string,
    fingerprint: string,
    cues: readonly SubtitleCue[],
    now: number,
  ): void {
    this.enterMedia(mediaKey);
    this.track = { fingerprint, cues, selectedAt: now, script: undefined };
    this.mismatchTexts = [];
    this.anchor = null;
  }

  endTrack(): void {
    this.track = null;
    this.mismatchTexts = [];
    this.anchor = null;
  }

  /** Playback paused, seeking or otherwise not progressing. */
  interrupt(): void {
    this.anchor = null;
  }

  get healCount(): number {
    return this.heals;
  }

  /** Records a heal of the current track; it is never verified or reused again. */
  recordHeal(now: number): void {
    if (this.track) this.healedFingerprints.add(this.track.fingerprint);
    this.heals += 1;
    this.lastHealAt = now;
    this.endTrack();
  }

  sample(input: TrackVerifySample): TrackVerifyOutcome {
    const track = this.track;
    if (!track) return { kind: "idle", reason: "no-track" };
    if (this.heals >= TRACK_VERIFY_MAX_HEALS_PER_MEDIA) {
      return { kind: "skipped", reason: "heal-limit" };
    }
    const previous = this.anchor;
    this.anchor = { mediaMs: input.currentTimeMs, wallMs: input.now };
    if (input.now - track.selectedAt < TRACK_VERIFY_WARMUP_MS) {
      return { kind: "idle", reason: "warmup" };
    }
    if (previous) {
      const expected =
        (input.now - previous.wallMs) * (input.playbackRate ?? 1);
      const actual = input.currentTimeMs - previous.mediaMs;
      if (Math.abs(actual - expected) > DISCONTINUITY_TOLERANCE_MS) {
        return { kind: "idle", reason: "discontinuity" };
      }
    } else {
      // The first sample after a pause, seek or new track only anchors time.
      return { kind: "idle", reason: "discontinuity" };
    }
    const normalized = normalizeCaptionText(input.nativeText);
    if (!normalized) return { kind: "idle", reason: "empty" };
    if (normalizedLength(normalized) < TRACK_VERIFY_MIN_CHARACTERS) {
      return { kind: "skipped", reason: "text-too-short" };
    }
    if (track.script === undefined) track.script = trackScript(track.cues);
    const nativeScript = dominantScript(normalized);
    if (!scriptsComparable(nativeScript, track.script) || !nativeScript) {
      return { kind: "skipped", reason: "script-mismatch" };
    }
    if (
      nativeCaptionMatchesTrack(
        normalized,
        track.cues,
        input.currentTimeMs,
        nativeScript,
      )
    ) {
      this.mismatchTexts = [];
      return { kind: "match" };
    }
    if (this.mismatchTexts.includes(normalized)) {
      return { kind: "idle", reason: "repeated-text" };
    }
    this.mismatchTexts.push(normalized);
    const streak = this.mismatchTexts.length;
    if (streak < TRACK_VERIFY_REQUIRED_MISMATCHES) {
      return { kind: "mismatch", streak };
    }
    this.mismatchTexts = [];
    if (input.now - this.lastHealAt < TRACK_VERIFY_HEAL_COOLDOWN_MS) {
      return { kind: "skipped", reason: "cooldown" };
    }
    return { kind: "invalid", streak };
  }
}
