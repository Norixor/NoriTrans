import {
  OCR_RUNTIME_LANGUAGES,
  type OcrRuntimeLanguage as OcrRuntimeLanguageCode,
} from "@/src/ocr/languages";

// v2 changes only the logical installation marker. Physical model artifacts
// remain pinned to the same commit and hashes, so an existing local download
// can be reused without another network request.
export const OCR_RUNTIME_PACKAGE_VERSION =
  "ppocr-v5-mobile-2025-08-logical-v2" as const;
export const OCR_RUNTIME_MODEL_COMMIT =
  "3a180da5b1a3bab3371d970f4da42cb9b354a9a7" as const;

export { OCR_RUNTIME_LANGUAGES as OCR_RUNTIME_CODES };
export type { OcrRuntimeLanguageCode };

export type OcrRuntimePack = "zh" | "latin" | "korean";
export type OcrRuntimeArtifactKind = "detection" | "recognition" | "dictionary";

export interface OcrRuntimeArtifact {
  id: string;
  kind: OcrRuntimeArtifactKind;
  url: string;
  bytes: number;
  sha256: string;
  contentTypes: readonly string[];
}

export type OcrRuntimeLanguageLabelKey =
  | "ocrRuntimeLanguageEnglish"
  | "ocrRuntimeLanguageChineseSimplified"
  | "ocrRuntimeLanguageChineseTraditional"
  | "ocrRuntimeLanguageJapanese"
  | "ocrRuntimeLanguageKorean"
  | "ocrRuntimeLanguageSpanish"
  | "ocrRuntimeLanguageFrench"
  | "ocrRuntimeLanguageGerman";

export interface OcrRuntimeLanguage {
  code: OcrRuntimeLanguageCode;
  labelKey: OcrRuntimeLanguageLabelKey;
  translationLanguageCodes: readonly string[];
  pack: OcrRuntimePack;
  version: typeof OCR_RUNTIME_PACKAGE_VERSION;
  artifacts: readonly OcrRuntimeArtifact[];
  source: { name: string; url: string };
  license: { spdx: "Apache-2.0"; url: string };
}

const MEDIA_BASE = `https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/${OCR_RUNTIME_MODEL_COMMIT}`;
const RAW_BASE = `https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/${OCR_RUNTIME_MODEL_COMMIT}`;
const ONNX_TYPES = Object.freeze([
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-onnx",
]);
const TEXT_TYPES = Object.freeze([
  "text/plain",
  "application/octet-stream",
  "binary/octet-stream",
]);

export const OCR_DETECTION_ARTIFACT: OcrRuntimeArtifact = Object.freeze({
  id: "ppocr-v5-mobile-detection",
  kind: "detection",
  url: `${MEDIA_BASE}/detection/PP-OCRv5_mobile_det_infer.onnx`,
  bytes: 4_748_769,
  sha256: "d7fe3ea74652890722c0f4d02458b7261d9f5ae6c92904d05707c9eb155c7924",
  contentTypes: ONNX_TYPES,
});

const PACK_ARTIFACTS: Readonly<
  Record<OcrRuntimePack, readonly OcrRuntimeArtifact[]>
> = Object.freeze({
  zh: Object.freeze([
    Object.freeze({
      id: "ppocr-v5-mobile-zh-recognition",
      kind: "recognition" as const,
      url: `${MEDIA_BASE}/recognition/PP-OCRv5_mobile_rec_infer.onnx`,
      bytes: 16_559_278,
      sha256:
        "d253c3cbee6e507828a5271a30ab0ec8ae7c2a99d0cc8e6f844fe380809d22b3",
      contentTypes: ONNX_TYPES,
    }),
    Object.freeze({
      id: "ppocr-v5-mobile-zh-dictionary",
      kind: "dictionary" as const,
      url: `${RAW_BASE}/recognition/ppocrv5_dict.txt`,
      bytes: 74_014,
      sha256:
        "9dfc80c50b6cb07399a47a7cf25d11db475fb4ad0e1fc96b2eff6467c8166ff3",
      contentTypes: TEXT_TYPES,
    }),
  ]),
  latin: Object.freeze([
    Object.freeze({
      id: "ppocr-v5-mobile-latin-recognition",
      kind: "recognition" as const,
      url: `${MEDIA_BASE}/recognition/multi/latin/v5/latin_PP-OCRv5_mobile_rec_infer.onnx`,
      bytes: 8_066_518,
      sha256:
        "497dbed20b7fd86334c9deb5082c2958982a316bb16e3589ebc6502cd85cae79",
      contentTypes: ONNX_TYPES,
    }),
    Object.freeze({
      id: "ppocr-v5-mobile-latin-dictionary",
      kind: "dictionary" as const,
      url: `${RAW_BASE}/recognition/multi/latin/v5/ppocrv5_latin_dict.txt`,
      bytes: 2_617,
      sha256:
        "7274e68c7675355e45dd75c360c83faa0d0624de33a704c799a7da8897662201",
      contentTypes: TEXT_TYPES,
    }),
  ]),
  korean: Object.freeze([
    Object.freeze({
      id: "ppocr-v5-mobile-korean-recognition",
      kind: "recognition" as const,
      url: `${MEDIA_BASE}/recognition/multi/korean/v5/korean_PP-OCRv5_mobile_rec_infer.onnx`,
      bytes: 13_443_278,
      sha256:
        "ee0dfde503d787c91fd0455daae2eb85311b4b5bdcddf85a54d8c1e0adc157de",
      contentTypes: ONNX_TYPES,
    }),
    Object.freeze({
      id: "ppocr-v5-mobile-korean-dictionary",
      kind: "dictionary" as const,
      url: `${RAW_BASE}/recognition/multi/korean/v5/ppocrv5_korean_dict.txt`,
      bytes: 47_452,
      sha256:
        "a3792cbb41215a43e555e16ff4a7f7b18db5dd80cd058637098f0d872f2dd9d6",
      contentTypes: TEXT_TYPES,
    }),
  ]),
});

const SOURCE = Object.freeze({
  name: "PP-OCRv5 mobile models",
  url: "https://github.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models",
});
const LICENSE = Object.freeze({
  spdx: "Apache-2.0" as const,
  url: "https://www.apache.org/licenses/LICENSE-2.0",
});

function runtimeLanguage(
  code: OcrRuntimeLanguageCode,
  labelKey: OcrRuntimeLanguageLabelKey,
  translationLanguageCodes: readonly string[],
  pack: OcrRuntimePack,
): OcrRuntimeLanguage {
  return Object.freeze({
    code,
    labelKey,
    translationLanguageCodes,
    pack,
    version: OCR_RUNTIME_PACKAGE_VERSION,
    artifacts: Object.freeze([OCR_DETECTION_ARTIFACT, ...PACK_ARTIFACTS[pack]]),
    source: SOURCE,
    license: LICENSE,
  });
}

export const OCR_RUNTIME_CATALOG: readonly OcrRuntimeLanguage[] = Object.freeze(
  [
    // The official zh recognizer explicitly covers Chinese, English and Japanese.
    runtimeLanguage("eng", "ocrRuntimeLanguageEnglish", ["en"], "zh"),
    runtimeLanguage(
      "chi_sim",
      "ocrRuntimeLanguageChineseSimplified",
      ["zh-CN"],
      "zh",
    ),
    runtimeLanguage(
      "chi_tra",
      "ocrRuntimeLanguageChineseTraditional",
      ["zh-Hant"],
      "zh",
    ),
    runtimeLanguage("jpn", "ocrRuntimeLanguageJapanese", ["ja"], "zh"),
    runtimeLanguage("kor", "ocrRuntimeLanguageKorean", ["ko"], "korean"),
    runtimeLanguage("spa", "ocrRuntimeLanguageSpanish", ["es"], "latin"),
    runtimeLanguage("fra", "ocrRuntimeLanguageFrench", ["fr"], "latin"),
    runtimeLanguage("deu", "ocrRuntimeLanguageGerman", ["de"], "latin"),
  ],
);

const CATALOG_BY_CODE = new Map(
  OCR_RUNTIME_CATALOG.map((item) => [item.code, item]),
);

export function isOcrRuntimeLanguageCode(
  value: unknown,
): value is OcrRuntimeLanguageCode {
  return typeof value === "string" && CATALOG_BY_CODE.has(value as never);
}

export function getOcrRuntimeLanguage(
  code: OcrRuntimeLanguageCode,
): OcrRuntimeLanguage {
  const language = CATALOG_BY_CODE.get(code);
  if (!language) throw new RangeError(`Unsupported OCR language: ${code}`);
  return language;
}

export function getOcrRuntimePack(
  pack: OcrRuntimePack,
): readonly OcrRuntimeArtifact[] {
  return Object.freeze([OCR_DETECTION_ARTIFACT, ...PACK_ARTIFACTS[pack]]);
}

export function ocrRuntimeCodesForPack(
  pack: OcrRuntimePack,
): OcrRuntimeLanguageCode[] {
  return OCR_RUNTIME_CATALOG.filter((item) => item.pack === pack).map(
    (item) => item.code,
  );
}

export function ocrRuntimeCodeForTranslationLanguage(
  translationLanguage: string,
): OcrRuntimeLanguageCode | undefined {
  const normalized = translationLanguage
    .trim()
    .toLowerCase()
    .replaceAll("_", "-");
  return OCR_RUNTIME_CATALOG.find((language) =>
    language.translationLanguageCodes.some(
      (candidate) => candidate.toLowerCase() === normalized,
    ),
  )?.code;
}
