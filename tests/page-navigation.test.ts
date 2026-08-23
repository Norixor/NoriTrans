import { pageRouteKey, pageTranslationScope } from "@/src/page/navigation";
import { beforeEach, describe, expect, it } from "vitest";

describe("page translation navigation", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it.each(["#/settings", "#!/settings", "#settings"])(
    "keeps the SPA route fragment %s",
    (hash) => {
      const url = `https://example.test/app${hash}`;
      expect(pageRouteKey(url, document)).toBe(url);
      expect(pageTranslationScope(url, document)).toBe(url);
    },
  );

  it("ignores an explicit in-document anchor", () => {
    document.body.innerHTML =
      '<a href="#details">Details</a><section id="details">Target</section>';

    expect(pageRouteKey("https://example.test/docs#details", document)).toBe(
      "https://example.test/docs",
    );
  });

  it("treats an unmatched ordinary fragment as an application route", () => {
    document.body.innerHTML = '<main id="content">Current route</main>';

    expect(pageRouteKey("https://example.test/app#account", document)).toBe(
      "https://example.test/app#account",
    );
  });
});
