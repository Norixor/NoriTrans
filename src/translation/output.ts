/** Removes common provider-added labels without altering the translated body. */
export function cleanTranslatedText(translatedText: string): string {
  return translatedText.replace(
    /^\s*(?:(?:译文|翻译|translation)|译)\s*[:：]\s*/iu,
    "",
  );
}
