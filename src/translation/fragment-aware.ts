/**
 * Fixed rule appended to the AI system message for requests explicitly marked
 * `fragmentAware` (full subtitle tracks with sentence smoothing). The
 * user-editable system prompt is never rewritten. Any change to this text must
 * bump FRAGMENT_AWARE_PROMPT_VERSION so cached translations are not reused.
 */
export const FRAGMENT_AWARE_SUBTITLE_PROMPT =
  "Subtitle fragments: a segment may be one fragment of a sentence split across consecutive subtitle cues. Its nearest before/after entries are the other fragments of that same sentence, followed by neighboring lines. Return a separate, non-empty translation for every fragment, translating only its own text, but the fragments read in order must form one natural, fluent sentence in the target language; you may move words to an adjacent fragment of the same sentence to follow target-language word order. Never merge, drop, or repeat fragments, and never translate context.";

/** Joins the prompt cache identity so smoothed results never hit plain ones. */
export const FRAGMENT_AWARE_PROMPT_VERSION = "subtitle-fragments-v1";

/**
 * Prompt identity used for cache keys. Requests without the marker keep the
 * exact identity they had before fragment awareness existed.
 */
export function fragmentAwarePromptIdentity(
  prompt: string,
  fragmentAware: boolean | undefined,
): string {
  return fragmentAware
    ? `${prompt}\u001f${FRAGMENT_AWARE_PROMPT_VERSION}`
    : prompt;
}
