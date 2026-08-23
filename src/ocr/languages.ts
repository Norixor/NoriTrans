export const OCR_RUNTIME_LANGUAGES = [
  "eng",
  "chi_sim",
  "chi_tra",
  "jpn",
  "kor",
  "spa",
  "fra",
  "deu",
] as const;

export type OcrRuntimeLanguage = (typeof OCR_RUNTIME_LANGUAGES)[number];

const AUTO_RUNTIME_PRIORITY: readonly OcrRuntimeLanguage[] = [
  "eng",
  "chi_sim",
  "chi_tra",
  "jpn",
  "kor",
  "spa",
  "fra",
  "deu",
];

function normalizedSourceLanguage(sourceLanguage?: string): string {
  return sourceLanguage?.trim().toLowerCase().replaceAll("_", "-") || "auto";
}

export function isOcrSourceLanguageSupported(sourceLanguage?: string): boolean {
  const normalized = normalizedSourceLanguage(sourceLanguage);
  return (
    normalized === "auto" ||
    normalized === "en" ||
    normalized.startsWith("en-") ||
    normalized === "zh-cn" ||
    normalized === "zh-hans" ||
    normalized === "zh-sg" ||
    normalized === "zh-hant" ||
    normalized === "zh-tw" ||
    normalized === "zh-hk" ||
    normalized === "zh-mo" ||
    normalized === "ja" ||
    normalized.startsWith("ja-") ||
    normalized === "ko" ||
    normalized.startsWith("ko-") ||
    normalized === "es" ||
    normalized.startsWith("es-") ||
    normalized === "fr" ||
    normalized.startsWith("fr-") ||
    normalized === "de" ||
    normalized.startsWith("de-")
  );
}

export function ocrRuntimeLanguages(
  sourceLanguage?: string,
): readonly OcrRuntimeLanguage[] {
  const normalized = normalizedSourceLanguage(sourceLanguage);
  // The PP-OCRv5 Chinese recognizer also covers Latin and Japanese glyphs, so
  // auto mode keeps one warm model instead of running two OCR engines per frame.
  if (normalized === "auto") return ["chi_sim"];
  if (normalized === "en" || normalized.startsWith("en-")) return ["eng"];
  if (["zh-cn", "zh-hans", "zh-sg"].includes(normalized)) {
    return ["chi_sim"];
  }
  if (["zh-hant", "zh-tw", "zh-hk", "zh-mo"].includes(normalized)) {
    return ["chi_tra"];
  }
  if (normalized === "ja" || normalized.startsWith("ja-")) return ["jpn"];
  if (normalized === "ko" || normalized.startsWith("ko-")) return ["kor"];
  if (normalized === "es" || normalized.startsWith("es-")) return ["spa"];
  if (normalized === "fr" || normalized.startsWith("fr-")) return ["fra"];
  if (normalized === "de" || normalized.startsWith("de-")) return ["deu"];
  throw new RangeError(`Unsupported OCR source language: ${normalized}`);
}

export function ocrRuntimeLanguageKey(sourceLanguage?: string): string {
  return ocrRuntimeLanguages(sourceLanguage).join("+");
}

/**
 * Resolves automatic OCR to a runtime the user has explicitly installed.
 * The common English/Chinese/Japanese pack is preferred, while a sole Korean
 * or Latin installation remains usable without silently downloading another
 * model. Explicit source-language choices still require their own logical
 * installation marker even when model bytes are shared.
 */
export function selectInstalledOcrRuntime(
  sourceLanguage: string | undefined,
  installedLanguages: readonly OcrRuntimeLanguage[],
): OcrRuntimeLanguage | undefined {
  const installed = new Set(installedLanguages);
  if (normalizedSourceLanguage(sourceLanguage) !== "auto") {
    return ocrRuntimeLanguages(sourceLanguage).find((language) =>
      installed.has(language),
    );
  }
  return AUTO_RUNTIME_PRIORITY.find((language) => installed.has(language));
}
