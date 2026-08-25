import type { LocalTranslationRuntimeInfo } from "@/src/messaging/protocol";
import { browser } from "wxt/browser";
import {
  hasInstalledBergamotRoute,
  isBergamotLanguagePackId,
  type BergamotLanguagePackId,
} from "@/src/local-translation/languages";
import { normalizeBergamotLanguage } from "@/src/local-translation/types";
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from "@/src/shared/languages";
import type { AiProviderId, FastProviderId } from "@/src/shared/settings";

export type LanguageCapabilityProviderId = FastProviderId | AiProviderId;
import {
  chromeTranslatorLanguage,
  chromeTranslatorSourceLanguageCandidates,
  type ChromeTranslatorAvailability,
  translatorAvailabilityFactory,
} from "@/src/translation/providers/chrome-local";

const PAIR_SEPARATOR = "\u001f";

export interface TranslationCapabilities {
  chromePairs: string[];
  installedBergamotPackIds: BergamotLanguagePackId[];
}

function pairKey(sourceLanguage: string, targetLanguage: string): string {
  return `${sourceLanguage}${PAIR_SEPARATOR}${targetLanguage}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLocalTranslationRuntimeInfo(
  value: unknown,
): value is LocalTranslationRuntimeInfo {
  return (
    isRecord(value) &&
    isBergamotLanguagePackId(value.packId) &&
    (value.state === "missing" ||
      value.state === "downloading" ||
      value.state === "installed" ||
      value.state === "error")
  );
}

export async function queryChromeTranslationPairs(): Promise<string[]> {
  const factory = translatorAvailabilityFactory();
  if (!factory) return [];
  const supported = new Set<string>();
  await Promise.all(
    SOURCE_LANGUAGES.filter(({ code }) => code !== "auto").flatMap(
      ({ code: sourceLanguage }) =>
        TARGET_LANGUAGES.filter(({ code }) => code !== sourceLanguage).map(
          async ({ code: targetLanguage }) => {
            const target = chromeTranslatorLanguage(targetLanguage);
            let state: ChromeTranslatorAvailability = "unavailable";
            for (const source of chromeTranslatorSourceLanguageCandidates(
              sourceLanguage,
            )) {
              try {
                state = await factory.availability({
                  sourceLanguage: source,
                  targetLanguage: target,
                });
              } catch {
                state = "unavailable";
              }
              if (state !== "unavailable") break;
            }
            if (state !== "unavailable") {
              supported.add(pairKey(sourceLanguage, targetLanguage));
            }
          },
        ),
    ),
  );
  return [...supported].sort();
}

export function installedBergamotPackIds(
  runtimes: readonly LocalTranslationRuntimeInfo[],
): BergamotLanguagePackId[] {
  return runtimes
    .filter((runtime) => runtime.state === "installed")
    .map((runtime) => runtime.packId);
}

export async function queryDocumentTranslationCapabilities(): Promise<TranslationCapabilities> {
  const chromePairsPromise = queryChromeTranslationPairs();
  const runtimeResponsePromise = Promise.resolve<unknown>(
    browser.runtime.sendMessage({ type: "LOCAL_TRANSLATION_RUNTIME_LIST" }),
  ).catch(() => undefined);
  const chromePairs = await chromePairsPromise;
  const runtimeResponse = await runtimeResponsePromise;
  const runtimes =
    isRecord(runtimeResponse) && Array.isArray(runtimeResponse.runtimes)
      ? runtimeResponse.runtimes.filter(isLocalTranslationRuntimeInfo)
      : [];
  return {
    chromePairs,
    installedBergamotPackIds: installedBergamotPackIds(runtimes),
  };
}

export function providerLanguagePairAvailable(
  provider: LanguageCapabilityProviderId,
  sourceLanguage: string,
  targetLanguage: string,
  capabilities: TranslationCapabilities,
): boolean {
  if (sourceLanguage !== "auto" && sourceLanguage === targetLanguage) {
    return false;
  }
  if (provider !== "chrome-local" && provider !== "bergamot-local") {
    return true;
  }
  const concreteSources =
    sourceLanguage === "auto"
      ? SOURCE_LANGUAGES.map(({ code }) => code).filter(
          (code) => code !== "auto" && code !== targetLanguage,
        )
      : [sourceLanguage];
  if (provider === "chrome-local") {
    const pairs = new Set(capabilities.chromePairs);
    return concreteSources.some((source) =>
      pairs.has(pairKey(source, targetLanguage)),
    );
  }
  const installed = new Set(capabilities.installedBergamotPackIds);
  const target = normalizeBergamotLanguage(targetLanguage);
  if (!target) return false;
  return concreteSources.some((sourceLanguageCandidate) => {
    const source = normalizeBergamotLanguage(sourceLanguageCandidate);
    return source
      ? hasInstalledBergamotRoute(source, target, installed)
      : false;
  });
}

export function providerSourceLanguageAvailable(
  provider: LanguageCapabilityProviderId,
  sourceLanguage: string,
  capabilities: TranslationCapabilities,
): boolean {
  return TARGET_LANGUAGES.some(({ code: targetLanguage }) =>
    providerLanguagePairAvailable(
      provider,
      sourceLanguage,
      targetLanguage,
      capabilities,
    ),
  );
}

export function providerTargetLanguageAvailable(
  provider: LanguageCapabilityProviderId,
  targetLanguage: string,
  capabilities: TranslationCapabilities,
): boolean {
  return SOURCE_LANGUAGES.some(
    ({ code: sourceLanguage }) =>
      sourceLanguage !== "auto" &&
      providerLanguagePairAvailable(
        provider,
        sourceLanguage,
        targetLanguage,
        capabilities,
      ),
  );
}
