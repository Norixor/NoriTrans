import { SOURCE_LANGUAGES } from "@/src/shared/languages";

function normalizedLanguageParts(code: string): string[] {
  return code
    .trim()
    .toLowerCase()
    .replace(/_/gu, "-")
    .split("-")
    .filter(Boolean);
}

function chineseVariant(parts: readonly string[]): "hans" | "hant" | undefined {
  if (parts[0] !== "zh") return undefined;
  if (
    parts.includes("hans") ||
    parts.some((part) => ["cn", "sg"].includes(part))
  ) {
    return "hans";
  }
  if (
    parts.includes("hant") ||
    parts.some((part) => ["tw", "hk", "mo"].includes(part))
  ) {
    return "hant";
  }
  return undefined;
}

/** Maps a declared language tag to one of the source languages supported by the UI. */
export function supportedSourceLanguageHint(code: string): string | undefined {
  const parts = normalizedLanguageParts(code);
  const primary = parts[0];
  if (!primary) return undefined;
  if (primary === "zh") {
    return chineseVariant(parts) === "hant" ? "zh-Hant" : "zh-CN";
  }
  return SOURCE_LANGUAGES.find(
    (language) => language.code !== "auto" && language.code === primary,
  )?.code;
}

/** Returns only high-confidence Unicode script matches suitable for bypassing a model. */
export function strongScriptSourceLanguageHint(
  text: string,
  declaredLanguage: string | undefined,
  resolveAmbiguousHan = true,
): string | undefined {
  if (/[\uac00-\ud7af\u1100-\u11ff]/u.test(text)) return "ko";
  if (/[\u3040-\u30ff\u31f0-\u31ff]/u.test(text)) return "ja";
  if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(text)) {
    if (declaredLanguage === "ja" || declaredLanguage === "ko") {
      return declaredLanguage;
    }
    if (!resolveAmbiguousHan) return undefined;
    return declaredLanguage === "zh-Hant" ? "zh-Hant" : "zh-CN";
  }
  return undefined;
}

/** Identifies Han-only samples that still need statistical language detection. */
export function requiresAutomaticHanDetection(text: string): boolean {
  return (
    /\p{Script=Han}/u.test(text) &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
  );
}
