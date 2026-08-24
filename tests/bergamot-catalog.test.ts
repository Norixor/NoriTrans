import { describe, expect, it } from "vitest";
import {
  parseBergamotCatalog,
  pinnedBergamotCatalog,
} from "@/src/local-translation/catalog";

const SHA256 = "a".repeat(64);

function record(
  sourceLanguage: string,
  targetLanguage: string,
  fileType: "model" | "lex" | "vocab",
  filterExpression: string,
  index: number,
): Record<string, unknown> {
  const pair = `${sourceLanguage.replace("-", "")}${targetLanguage.replace("-", "")}`;
  return {
    sourceLanguage,
    targetLanguage,
    fileType,
    filter_expression: filterExpression,
    architecture: "base",
    version: "3.0",
    id: `artifact-${index}`,
    name: `${fileType}.${pair}.bin`,
    decompressedHash: SHA256,
    decompressedSize: 200,
    schema: 1,
    last_modified: 1,
    attachment: {
      hash: SHA256,
      size: 100,
      filename: `${fileType}.${pair}.bin.zst`,
      location: `main-workspace/translations-models-v2/artifact-${index}.zst`,
      mimetype: "application/zstd",
    },
  };
}

describe("Bergamot model catalog", () => {
  it("loads both fixed directions for every displayed language pair", () => {
    const catalog = pinnedBergamotCatalog();

    expect(catalog.size).toBe(7);
    for (const [language, packageValue] of catalog) {
      expect(packageValue.directions.map(({ from, to }) => [from, to])).toEqual(
        [
          ["en", language],
          [language, "en"],
        ],
      );
      for (const direction of packageValue.directions) {
        expect(direction.artifacts.length).toBeGreaterThanOrEqual(3);
        expect(
          direction.artifacts.every(
            ({ url }) =>
              url.startsWith(
                "https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/models/",
              ) && url.endsWith(".gz"),
          ),
        ).toBe(true);
      }
    }
  });

  it("accepts desktop records while excluding Android-only records", () => {
    const universal = ["model", "lex", "vocab"] as const;
    const desktop = "env.appinfo.OS != 'Android'";
    const android = "env.appinfo.OS == 'Android'";
    const data = [
      ...universal.map((kind, index) =>
        record("en", "zh-Hans", kind, "", index + 1),
      ),
      ...universal.map((kind, index) =>
        record("zh-Hans", "en", kind, desktop, index + 4),
      ),
      ...universal.map((kind, index) =>
        record("zh-Hans", "en", kind, android, index + 7),
      ),
    ];

    const catalog = parseBergamotCatalog({ data });
    const simplifiedChinese = catalog.get("zh-Hans");

    expect(simplifiedChinese?.directions).toHaveLength(2);
    expect(simplifiedChinese?.directions[0]?.from).toBe("en");
    expect(simplifiedChinese?.directions[1]?.from).toBe("zh-Hans");
    expect(
      simplifiedChinese?.directions[1]?.artifacts.map(({ id }) => id),
    ).toEqual(["artifact-4", "artifact-5", "artifact-6"]);
  });
});
