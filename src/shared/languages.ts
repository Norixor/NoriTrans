export interface LanguageOption {
  code: string;
}

export const SOURCE_LANGUAGES: LanguageOption[] = [
  { code: "auto" },
  { code: "en" },
  { code: "zh-CN" },
  { code: "zh-Hant" },
  { code: "ja" },
  { code: "ko" },
  { code: "es" },
  { code: "fr" },
  { code: "de" },
];

export const TARGET_LANGUAGES = SOURCE_LANGUAGES.filter(
  (language) => language.code !== "auto",
);

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
  )
    return "hans";
  if (
    parts.includes("hant") ||
    parts.some((part) => ["tw", "hk", "mo"].includes(part))
  )
    return "hant";
  return undefined;
}

/** Matches equivalent caption language tags without merging Chinese scripts. */
export function languageTagsMatch(
  preferred: string,
  candidate: string,
): boolean {
  const preferredParts = normalizedLanguageParts(preferred);
  const candidateParts = normalizedLanguageParts(candidate);
  if (preferredParts.length === 0 || candidateParts.length === 0) return false;
  if (preferredParts.join("-") === candidateParts.join("-")) return true;
  if (preferredParts[0] !== candidateParts[0]) return false;
  if (preferredParts.length === 1 || candidateParts.length === 1) return true;
  if (preferredParts[0] !== "zh") return true;
  const preferredVariant = chineseVariant(preferredParts);
  const candidateVariant = chineseVariant(candidateParts);
  return (
    preferredVariant !== undefined && preferredVariant === candidateVariant
  );
}

export function displayLanguageName(code: string, locale: string): string {
  try {
    return (
      new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code
    );
  } catch {
    return code;
  }
}
