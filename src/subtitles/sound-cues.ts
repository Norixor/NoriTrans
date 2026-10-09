/**
 * Detects subtitle cues that are only a sound or music annotation, such as
 * "(🎵 siren)", "[Music]" or "♪". The rules are deliberately conservative: a
 * cue counts only when every non-empty line is an annotation, so any line that
 * carries dialogue or lyrics keeps the cue translatable.
 */

const BRACKET_PAIRS: ReadonlyMap<string, string> = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["（", "）"],
  ["［", "］"],
  ["【", "】"],
  ["｛", "｝"],
  ["〔", "〕"],
  ["〈", "〉"],
  ["《", "》"],
]);
const BRACKET_CLOSERS: ReadonlySet<string> = new Set(BRACKET_PAIRS.values());

// Music note glyphs and the emoji used for them (including the musical score
// and clef symbols).
const MUSIC_SYMBOL = /[\u2669-\u266F\u{1F3B5}\u{1F3B6}\u{1F3BC}\u{1D11E}]/u;
const MUSIC_ONLY_LINE =
  /^(?:[\s\p{P}~\u301C\u2669-\u266F\u{1F3B5}\u{1F3B6}\u{1F3BC}\u{1D11E}]|\uFE0F|\u200D)+$/u;
const SPEAKER_DASH = /^[-\u2013\u2014]\s+/u;
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/u;

/**
 * True when the whole line is wrapped by one matching pair of brackets, so
 * "(a) b (c)" is not a wrapped line but "(a (b) c)" is.
 */
function isFullyBracketed(line: string): boolean {
  const chars = Array.from(line);
  const first = chars[0];
  const expectedCloser = first ? BRACKET_PAIRS.get(first) : undefined;
  if (!first || !expectedCloser || chars.length < 3) return false;
  const stack: string[] = [];
  for (const [index, char] of chars.entries()) {
    const closer = BRACKET_PAIRS.get(char);
    if (closer) {
      stack.push(closer);
      continue;
    }
    if (!BRACKET_CLOSERS.has(char)) continue;
    if (stack.pop() !== char) return false;
    if (stack.length === 0) {
      // The opening bracket must close exactly at the end of the line, and the
      // wrapped content must not be empty.
      return (
        index === chars.length - 1 &&
        chars.slice(1, index).join("").trim() !== ""
      );
    }
  }
  return false;
}

function isMusicOnlyLine(line: string): boolean {
  return MUSIC_SYMBOL.test(line) && MUSIC_ONLY_LINE.test(line);
}

function isCueLine(line: string): boolean {
  return isFullyBracketed(line) || isMusicOnlyLine(line);
}

export function isSoundCue(text: string): boolean {
  const lines = text
    .split(LINE_BREAK)
    .map((line) => line.trim().replace(SPEAKER_DASH, "").trim())
    .filter((line) => line !== "");
  return lines.length > 0 && lines.every(isCueLine);
}
