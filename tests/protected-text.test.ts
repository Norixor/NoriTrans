import { NTransError } from "@/src/shared/errors";
import {
  assertValidProtectedTranslation,
  createProtectedText,
  parseProtectedText,
  plainTextFromProtectedText,
  validateProtectedTranslation,
} from "@/src/translation/protected-text";
import { describe, expect, it } from "vitest";

describe("protected-text-v1", () => {
  it("deterministically preserves Text-node order and extracts translated parts", () => {
    const source = createProtectedText(["Hello ", "world", "."]);
    const translated = source
      .replace("Hello ", "你好")
      .replace("world", "世界")
      .replace(".", "。");

    expect(createProtectedText(["Hello ", "world", "."])).toBe(source);
    expect(validateProtectedTranslation(source, translated)).toEqual([
      "你好",
      "世界",
      "。",
    ]);
    expect(parseProtectedText(source, translated)).toEqual([
      "你好",
      "世界",
      "。",
    ]);
    expect(plainTextFromProtectedText(source, translated)).toBe("你好世界。");
  });

  it("selects the first deterministic salt that does not collide with source text", () => {
    const source = createProtectedText([
      "literal \uE000NT1:0:0:open\uE001 marker",
      "tail",
    ]);

    expect(source).toContain("\uE000NT1:1:0:open\uE001");
    expect(() => validateProtectedTranslation(source, source)).not.toThrow();
  });

  it.each([
    [
      "missing",
      (value: string) =>
        value.replace(/\uE000NT1:[0-9a-z]+:1:close\uE001/u, ""),
    ],
    [
      "duplicate",
      (value: string) =>
        value.replace(/(\uE000NT1:[0-9a-z]+:0:open\uE001)/u, "$1$1"),
    ],
    [
      "unknown",
      (value: string) =>
        value.replace(
          /\uE000NT1:([0-9a-z]+):1:open\uE001/u,
          "\uE000NT1:$1:9:open\uE001",
        ),
    ],
    [
      "reordered",
      (value: string) => {
        const matches = [
          ...value.matchAll(/\uE000NT1:[0-9a-z]+:[01]:(?:open|close)\uE001/gu),
        ];
        const first = matches[0]?.[0] ?? "";
        const secondOpen = matches[2]?.[0] ?? "";
        return value
          .replace(first, "__FIRST__")
          .replace(secondOpen, first)
          .replace("__FIRST__", secondOpen);
      },
    ],
    [
      "nested",
      (value: string) => {
        const tokens = [
          ...value.matchAll(/\uE000NT1:[0-9a-z]+:[01]:(?:open|close)\uE001/gu),
        ].map((match) => match[0]);
        return `${tokens[0]}one${tokens[2]}two${tokens[3]}${tokens[1]}`;
      },
    ],
  ])("rejects %s protected markers", (_case, mutate) => {
    const source = createProtectedText(["one", "two"]);
    const invalid = mutate(source);

    expect(() => validateProtectedTranslation(source, invalid)).toThrow(
      NTransError,
    );
    expect(parseProtectedText(source, invalid)).toBeUndefined();
    expect(() =>
      assertValidProtectedTranslation(
        { text: source, format: "protected-text-v1" },
        invalid,
      ),
    ).toThrow(NTransError);
  });

  it("leaves plain text segments outside the protected protocol", () => {
    expect(() =>
      assertValidProtectedTranslation(
        { text: "plain", format: "plain-text-v1" },
        "translated",
      ),
    ).not.toThrow();
  });
});
