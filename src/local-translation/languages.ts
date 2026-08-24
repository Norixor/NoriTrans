import {
  BERGAMOT_PACKAGE_LANGUAGES,
  type BergamotLanguage,
  type BergamotPackageLanguage,
} from "@/src/local-translation/types";

export interface BergamotLanguagePack {
  id: BergamotLanguagePackId;
  sourceLanguage: BergamotLanguage;
  targetLanguage: BergamotLanguage;
  packageLanguage: BergamotPackageLanguage;
}

const LANGUAGE_PACKS = BERGAMOT_PACKAGE_LANGUAGES.flatMap((language) => [
  {
    id: `en-${language}`,
    sourceLanguage: "en" as const,
    targetLanguage: language,
    packageLanguage: language,
  },
  {
    id: `${language}-en`,
    sourceLanguage: language,
    targetLanguage: "en" as const,
    packageLanguage: language,
  },
]);

export const BERGAMOT_LANGUAGE_PACK_IDS = LANGUAGE_PACKS.map(
  (pack) => pack.id,
) as readonly (
  | "en-es"
  | "es-en"
  | "en-fr"
  | "fr-en"
  | "en-de"
  | "de-en"
  | "en-ja"
  | "ja-en"
  | "en-ko"
  | "ko-en"
  | "en-zh-Hans"
  | "zh-Hans-en"
  | "en-zh-Hant"
  | "zh-Hant-en"
)[];

export type BergamotLanguagePackId =
  (typeof BERGAMOT_LANGUAGE_PACK_IDS)[number];

export const BERGAMOT_LANGUAGE_PACKS: readonly BergamotLanguagePack[] =
  Object.freeze(
    LANGUAGE_PACKS.map((pack) =>
      Object.freeze({ ...pack, id: pack.id as BergamotLanguagePackId }),
    ),
  );

const PACK_BY_ID = new Map(
  BERGAMOT_LANGUAGE_PACKS.map((pack) => [pack.id, pack]),
);

export function isBergamotLanguagePackId(
  value: unknown,
): value is BergamotLanguagePackId {
  return typeof value === "string" && PACK_BY_ID.has(value as never);
}

export function getBergamotLanguagePack(
  id: BergamotLanguagePackId,
): BergamotLanguagePack {
  const pack = PACK_BY_ID.get(id);
  if (!pack) throw new RangeError(`Unsupported Bergamot language pack: ${id}`);
  return pack;
}

export function bergamotLanguagePackId(
  sourceLanguage: BergamotLanguage,
  targetLanguage: BergamotLanguage,
): BergamotLanguagePackId | undefined {
  return BERGAMOT_LANGUAGE_PACKS.find(
    (pack) =>
      pack.sourceLanguage === sourceLanguage &&
      pack.targetLanguage === targetLanguage,
  )?.id;
}

/** Returns the installed directed packs needed for a direct or English-pivot route. */
export function requiredBergamotLanguagePacks(
  sourceLanguage: BergamotLanguage,
  targetLanguage: BergamotLanguage,
): BergamotLanguagePackId[] {
  if (sourceLanguage === targetLanguage) return [];
  if (sourceLanguage === "en" || targetLanguage === "en") {
    const direct = bergamotLanguagePackId(sourceLanguage, targetLanguage);
    return direct ? [direct] : [];
  }
  const outbound = bergamotLanguagePackId(sourceLanguage, "en");
  const inbound = bergamotLanguagePackId("en", targetLanguage);
  return outbound && inbound ? [outbound, inbound] : [];
}

/** Checks whether installed directed packs can translate the requested route. */
export function hasInstalledBergamotRoute(
  sourceLanguage: BergamotLanguage,
  targetLanguage: BergamotLanguage,
  installedPackIds: ReadonlySet<BergamotLanguagePackId>,
): boolean {
  if (sourceLanguage === targetLanguage) return false;
  const required = requiredBergamotLanguagePacks(
    sourceLanguage,
    targetLanguage,
  );
  return (
    required.length > 0 && required.every((id) => installedPackIds.has(id))
  );
}
