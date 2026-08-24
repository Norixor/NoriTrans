import {
  hasInstalledBergamotRoute,
  requiredBergamotLanguagePacks,
  type BergamotLanguagePackId,
} from "@/src/local-translation/languages";
import {
  parseTranslationMethod,
  translationMethodValue,
} from "@/src/shared/translation-methods";
import {
  providerLanguagePairAvailable,
  providerSourceLanguageAvailable,
  providerTargetLanguageAvailable,
} from "@/src/translation/provider-capabilities";
import { describe, expect, it } from "vitest";

describe("translation method and local language capabilities", () => {
  it("derives concrete methods without replacing the saved fast provider in AI mode", () => {
    expect(translationMethodValue("fast", "deepl")).toBe("fast:deepl");
    expect(translationMethodValue("ai", "deepl")).toBe("ai:openai-compatible");
    expect(parseTranslationMethod("fast:bergamot-local")).toEqual({
      mode: "fast",
      fastProvider: "bergamot-local",
    });
    expect(parseTranslationMethod("ai:openai-compatible")).toEqual({
      mode: "ai",
    });
  });

  it("requires directed packs and both English pivot legs", () => {
    expect(requiredBergamotLanguagePacks("zh-Hans", "en")).toEqual([
      "zh-Hans-en",
    ]);
    expect(requiredBergamotLanguagePacks("zh-Hans", "ko")).toEqual([
      "zh-Hans-en",
      "en-ko",
    ]);
    const installed = new Set<BergamotLanguagePackId>(["zh-Hans-en", "en-ko"]);
    expect(hasInstalledBergamotRoute("zh-Hans", "ko", installed)).toBe(true);
    installed.delete("en-ko");
    expect(hasInstalledBergamotRoute("zh-Hans", "ko", installed)).toBe(false);
  });

  it("limits Chrome and Bergamot pairs while keeping cloud providers unrestricted", () => {
    const capabilities = {
      chromePairs: ["zh-CN\u001fko"],
      installedBergamotPackIds: [
        "zh-Hans-en",
        "en-ko",
      ] as BergamotLanguagePackId[],
    };
    expect(
      providerLanguagePairAvailable(
        "chrome-local",
        "zh-CN",
        "ko",
        capabilities,
      ),
    ).toBe(true);
    expect(
      providerLanguagePairAvailable(
        "chrome-local",
        "zh-Hant",
        "ko",
        capabilities,
      ),
    ).toBe(false);
    expect(
      providerLanguagePairAvailable(
        "bergamot-local",
        "zh-CN",
        "ko",
        capabilities,
      ),
    ).toBe(true);
    expect(
      providerLanguagePairAvailable(
        "google-translate",
        "zh-Hant",
        "ko",
        capabilities,
      ),
    ).toBe(true);
  });

  it("keeps both ends of installed bidirectional packs selectable", () => {
    const capabilities = {
      chromePairs: [],
      installedBergamotPackIds: [
        "zh-Hans-en",
        "en-zh-Hans",
        "es-en",
        "en-es",
      ] as BergamotLanguagePackId[],
    };

    expect(
      providerSourceLanguageAvailable("bergamot-local", "en", capabilities),
    ).toBe(true);
    expect(
      providerTargetLanguageAvailable("bergamot-local", "zh-CN", capabilities),
    ).toBe(true);
    expect(
      providerTargetLanguageAvailable(
        "bergamot-local",
        "zh-Hant",
        capabilities,
      ),
    ).toBe(false);
    expect(
      providerLanguagePairAvailable(
        "bergamot-local",
        "en",
        "zh-CN",
        capabilities,
      ),
    ).toBe(true);
  });
});
