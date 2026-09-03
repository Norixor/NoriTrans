import en from "@/public/_locales/en/messages.json";
import zhCn from "@/public/_locales/zh_CN/messages.json";
import { configureUiLanguage, message } from "@/src/shared/i18n";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface LocaleMessage {
  message: string;
  placeholders?: Record<string, { content: string }>;
}

function sortedKeys(locale: Record<string, LocaleMessage>): string[] {
  return Object.keys(locale).sort();
}

function validateLocale(locale: Record<string, LocaleMessage>): void {
  for (const [key, entry] of Object.entries(locale)) {
    expect(entry.message.trim(), `${key} must have a message`).not.toBe("");
    for (const [placeholder, definition] of Object.entries(
      entry.placeholders ?? {},
    )) {
      expect(
        entry.message.toLowerCase(),
        `${key} must reference placeholder ${placeholder}`,
      ).toContain(`$${placeholder.toLowerCase()}$`);
      expect(
        /^\$\d+$/u.test(definition.content),
        `${key}.${placeholder} must map to a positional substitution`,
      ).toBe(true);
    }
  }
}

describe("Chrome locale catalogs", () => {
  it("keeps English and Chinese keys exactly aligned", () => {
    expect(sortedKeys(en)).toEqual(sortedKeys(zhCn));
  });

  it("contains valid non-empty messages and placeholder definitions", () => {
    validateLocale(en);
    validateLocale(zhCn);
  });

  it("uses standard BCP 47 document language tags", () => {
    expect(en.documentLanguage.message).toBe("en");
    expect(zhCn.documentLanguage.message).toBe("zh-CN");
    for (const entrypoint of ["popup", "options"]) {
      const html = readFileSync(
        resolve("entrypoints", entrypoint, "index.html"),
        "utf8",
      );
      expect(html).toContain('<html lang="__MSG_documentLanguage__">');
      expect(html).not.toContain("__MSG_@@ui_locale__");
    }
  });

  it("defines concise localized profile wizard step templates", () => {
    expect(en.profileWizardStep).toEqual({
      message: "Step $CURRENT$/$TOTAL$",
      placeholders: {
        current: { content: "$1" },
        total: { content: "$2" },
      },
    });
    expect(zhCn.profileWizardStep).toEqual({
      message: "步骤 $CURRENT$/$TOTAL$",
      placeholders: {
        current: { content: "$1" },
        total: { content: "$2" },
      },
    });
  });

  it("preserves dollar signs inside positional substitutions", () => {
    configureUiLanguage("en");
    expect(message("norixorGiftBalance", "US$1,023.26758")).toBe(
      "US$1,023.26758 gift balance",
    );
    expect(message("norixorUsageDetail", ["30,526", "US$0.13988"])).toBe(
      "30,526 source characters · US$0.13988",
    );

    configureUiLanguage("zh-CN");
    expect(message("norixorGiftBalance", "US$1,023.26758")).toBe(
      "赠送余额 US$1,023.26758",
    );
    expect(message("norixorUsageDetail", ["30,526", "US$0.13988"])).toBe(
      "30,526 个原文字符 · US$0.13988",
    );
  });

  it("localizes every selection translation surface", () => {
    const keys = [
      "selectionTranslationEnabled",
      "selectionTranslationMode",
      "selectionTranslationDescription",
      "selectionTranslate",
      "selectionTranslationTitle",
      "selectionOriginal",
      "selectionTranslation",
      "selectionTranslating",
      "selectionRetry",
      "selectionCopy",
      "selectionCopied",
      "selectionCopyFailed",
      "selectionClose",
    ] as const;
    for (const key of keys) {
      expect(en[key].message.trim()).not.toBe("");
      expect(zhCn[key].message.trim()).not.toBe("");
    }
  });

  it("keeps OCR privacy copy aligned with the local-only implementation", () => {
    const englishPrivacy = [
      en.ocrLocalPrivacyNote.message,
      en.ocrPermissionPrivacy.message,
    ].join(" ");
    const chinesePrivacy = [
      zhCn.ocrLocalPrivacyNote.message,
      zhCn.ocrPermissionPrivacy.message,
    ].join(" ");

    expect(englishPrivacy).toMatch(/stay on this device|local/iu);
    expect(englishPrivacy).toMatch(/never sent to an AI provider/iu);
    expect(chinesePrivacy).toMatch(/本机/u);
    expect(chinesePrivacy).toMatch(/绝不会发送给 AI Provider/u);
    expect(`${englishPrivacy} ${chinesePrivacy}`).not.toMatch(
      /may (?:be )?sent|可能发送/iu,
    );
  });

  it("localizes OCR runtime management and requires an explicit download", () => {
    const runtimeKeys = [
      "settingsTabOcrRuntimes",
      "ocrRuntimesTitle",
      "ocrRuntimeLanguageEnglish",
      "ocrRuntimeLanguageChineseSimplified",
      "ocrRuntimeLanguageChineseTraditional",
      "ocrRuntimeLanguageJapanese",
      "ocrRuntimeLanguageKorean",
      "ocrRuntimeLanguageSpanish",
      "ocrRuntimeLanguageFrench",
      "ocrRuntimeLanguageGerman",
      "ocrRuntimeStateMissing",
      "ocrRuntimeStateDownloading",
      "ocrRuntimeStateInstalled",
      "ocrRuntimeStateError",
      "ocrRuntimeDownload",
      "ocrRuntimeDownloadAll",
      "ocrRuntimeDelete",
      "ocrRuntimeMissing",
    ] as const;
    for (const key of runtimeKeys) {
      expect(en[key].message.trim()).not.toBe("");
      expect(zhCn[key].message.trim()).not.toBe("");
    }

    expect(en.ocrRuntimesLocalNotice.message).toMatch(
      /only after you click|never downloaded automatically/iu,
    );
    expect(zhCn.ocrRuntimesLocalNotice.message).toMatch(
      /点击.*下载|不会自动下载/iu,
    );
    expect(en.ocrExperimentalDescription.message).toMatch(
      /Settings > OCR runtimes/iu,
    );
    expect(zhCn.ocrExperimentalDescription.message).toMatch(
      /设置 > OCR 运行时/iu,
    );
    expect(
      `${en.ocrRuntimesDescription.message} ${en.ocrRuntimesLocalNotice.message} ${en.ocrExperimentalDescription.message}`,
    ).not.toMatch(/PP-OCR|ONNX|SHA-256|physical model/iu);
    expect(
      `${zhCn.ocrRuntimesDescription.message} ${zhCn.ocrRuntimesLocalNotice.message} ${zhCn.ocrExperimentalDescription.message}`,
    ).not.toMatch(/PP-OCR|ONNX|SHA-256|物理模型/iu);
  });
});
