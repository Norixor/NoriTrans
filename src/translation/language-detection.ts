import { SOURCE_LANGUAGES } from "@/src/shared/languages";

const LANGUAGE_SAMPLE_MAX_CHARACTERS = 20_000;

interface ScriptCounts {
  han: number;
  hangul: number;
  kana: number;
  latin: number;
}

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

/** Builds one bounded document-level sample instead of detecting each request batch. */
export function buildLanguageDetectionSample(
  texts: readonly string[],
  maxCharacters = LANGUAGE_SAMPLE_MAX_CHARACTERS,
): string {
  const parts: string[] = [];
  let remaining = Math.max(0, maxCharacters);
  for (const text of texts) {
    const separatorLength = parts.length > 0 ? 1 : 0;
    if (remaining <= separatorLength) break;
    const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!normalized) continue;
    const part = normalized.slice(0, remaining - separatorLength);
    parts.push(part);
    remaining -= part.length + separatorLength;
  }
  return parts.join(" ").slice(0, maxCharacters);
}

function countScripts(text: string): ScriptCounts {
  return {
    han: text.match(/\p{Script=Han}/gu)?.length ?? 0,
    hangul: text.match(/\p{Script=Hangul}/gu)?.length ?? 0,
    kana: text.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0,
    latin: text.match(/\p{Script=Latin}/gu)?.length ?? 0,
  };
}

/** Returns true when the visible text is already dominated by the target script. */
export function isPredominantlyTargetScript(
  text: string,
  targetLanguage: string,
): boolean {
  const counts = countScripts(text.normalize("NFKC"));
  const primary = normalizedLanguageParts(targetLanguage)[0];
  if (primary === "zh") {
    return (
      counts.han > 0 &&
      counts.kana === 0 &&
      counts.hangul === 0 &&
      counts.han >= counts.latin
    );
  }
  if (primary === "ja") {
    return (
      counts.kana > 0 &&
      counts.kana + counts.han >= counts.latin + counts.hangul
    );
  }
  if (primary === "ko") {
    return counts.hangul > 0 && counts.hangul >= counts.latin + counts.kana;
  }
  if (["en", "es", "fr", "de"].includes(primary ?? "")) {
    return (
      counts.latin > 0 &&
      counts.latin >= counts.han + counts.hangul + counts.kana
    );
  }
  return false;
}

function chineseLanguage(declaredLanguage: string | undefined): string {
  return declaredLanguage === "zh-Hant" ? "zh-Hant" : "zh-CN";
}

/** Returns the dominant supported script family without loading a detector model. */
export function dominantScriptSourceLanguageHint(
  texts: string | readonly string[],
  declaredLanguage: string | undefined,
  resolveAmbiguousHan = true,
): string | undefined {
  const sample =
    typeof texts === "string" ? texts : buildLanguageDetectionSample(texts);
  const counts = countScripts(sample);
  const candidates: Array<{ language: string; count: number }> = [];

  if (counts.kana > 0) {
    candidates.push({ language: "ja", count: counts.kana + counts.han });
  } else if (counts.han > 0 && resolveAmbiguousHan) {
    candidates.push({
      language:
        declaredLanguage === "ja" || declaredLanguage === "ko"
          ? declaredLanguage
          : chineseLanguage(declaredLanguage),
      count: counts.han,
    });
  } else if (
    counts.han > 0 &&
    (declaredLanguage === "zh-CN" || declaredLanguage === "zh-Hant")
  ) {
    candidates.push({
      language: chineseLanguage(declaredLanguage),
      count: counts.han,
    });
  }

  if (counts.hangul > 0) {
    candidates.push({ language: "ko", count: counts.hangul });
  }
  if (counts.latin > 0 && declaredLanguage) {
    const declaredPrimary = supportedSourceLanguageHint(declaredLanguage);
    if (["en", "es", "fr", "de"].includes(declaredPrimary ?? "")) {
      candidates.push({ language: declaredPrimary!, count: counts.latin });
    }
  }

  candidates.sort((left, right) => right.count - left.count);
  const dominant = candidates[0];
  if (!dominant || dominant.count === 0) return undefined;
  const runnerUp = candidates[1];
  if (runnerUp && runnerUp.count === dominant.count) {
    return candidates.find(
      (candidate) => candidate.language === declaredLanguage,
    )?.language;
  }
  return dominant.language;
}

/**
 * Detects the dominant language with Chrome's CLD implementation and falls
 * back to deterministic script counts when the native result is unavailable.
 */
export async function detectDominantSourceLanguage(
  texts: string | readonly string[],
  declaredLanguage: string | undefined,
  resolveAmbiguousHan = true,
): Promise<string | undefined> {
  const sample =
    typeof texts === "string"
      ? texts
          .normalize("NFKC")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, LANGUAGE_SAMPLE_MAX_CHARACTERS)
      : buildLanguageDetectionSample(texts);
  if (!sample) return declaredLanguage;

  try {
    const result = await chrome.i18n.detectLanguage(sample);
    const candidates = result.languages
      .map((candidate) => ({
        language: supportedSourceLanguageHint(candidate.language),
        percentage: candidate.percentage,
      }))
      .sort((left, right) => right.percentage - left.percentage);
    const dominant = candidates[0];
    const runnerUp = candidates[1];
    if (
      dominant?.language &&
      (result.isReliable || dominant.percentage >= 40) &&
      (!runnerUp || dominant.percentage > runnerUp.percentage)
    ) {
      return dominant.language === "zh-CN"
        ? chineseLanguage(declaredLanguage)
        : dominant.language;
    }
  } catch {
    // Content scripts on restricted pages can lack this API. Script counting
    // remains deterministic and does not require a downloaded model.
  }

  return dominantScriptSourceLanguageHint(
    sample,
    declaredLanguage,
    resolveAmbiguousHan,
  );
}

/** Identifies Han-only samples that still need statistical language detection. */
export function requiresAutomaticHanDetection(text: string): boolean {
  return (
    /\p{Script=Han}/u.test(text) &&
    !/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
  );
}
