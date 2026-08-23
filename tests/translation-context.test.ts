import {
  contextualizeSegments,
  translationSegmentCacheText,
  translationSegmentReuseIdentity,
} from "@/src/translation/context";
import { describe, expect, it } from "vitest";

describe("translation context", () => {
  it("adds bounded neighboring text while preserving selected stable IDs", () => {
    const all = [
      { id: "a", text: "First" },
      { id: "b", text: "Second" },
      { id: "c", text: "Third" },
      { id: "d", text: "Fourth" },
    ];

    expect(contextualizeSegments(all, [all[1]!, all[2]!], 1)).toEqual([
      {
        id: "b",
        text: "Second",
        contextBefore: ["First"],
        contextAfter: ["Third"],
      },
      {
        id: "c",
        text: "Third",
        contextBefore: ["Second"],
        contextAfter: ["Fourth"],
      },
    ]);
  });

  it("includes context in the cache identity material", () => {
    const plain = translationSegmentCacheText({ id: "same", text: "Run" });
    const noun = translationSegmentCacheText({
      id: "same",
      text: "Run",
      contextBefore: ["A software command"],
    });
    const verb = translationSegmentCacheText({
      id: "same",
      text: "Run",
      contextBefore: ["An athlete"],
    });

    expect(noun).not.toBe(plain);
    expect(verb).not.toBe(noun);
  });

  it("includes text format in reuse and cache identity material", () => {
    const plain = { id: "same", text: "Run", format: "plain-text-v1" as const };
    const protectedSegment = {
      id: "same",
      text: "Run",
      format: "protected-text-v1" as const,
    };

    expect(translationSegmentReuseIdentity(protectedSegment)).not.toBe(
      translationSegmentReuseIdentity(plain),
    );
    expect(translationSegmentCacheText(protectedSegment)).not.toBe(
      translationSegmentCacheText(plain),
    );
  });

  it("reuses normalized same-text segments regardless of source context", () => {
    const initial = translationSegmentReuseIdentity({ id: "a", text: "Café" });
    const adjacentCopy = translationSegmentReuseIdentity({
      id: "b",
      text: "  Café  ",
      contextBefore: ["Café"],
    });
    const noun = translationSegmentReuseIdentity({
      id: "c",
      text: "Run",
      contextBefore: ["A software command"],
    });
    const verb = translationSegmentReuseIdentity({
      id: "d",
      text: "Run",
      contextBefore: ["An athlete"],
    });

    expect(adjacentCopy).toBe(initial);
    expect(verb).toBe(noun);
  });
});
