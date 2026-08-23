import { mutationTouchesCaptionSelector } from "@/src/subtitles/adapters/dom-visibility";
import { describe, expect, it } from "vitest";

async function mutationRecords(action: () => void): Promise<MutationRecord[]> {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((mutations) =>
    records.push(...mutations),
  );
  observer.observe(document.body, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  action();
  await Promise.resolve();
  observer.disconnect();
  return records;
}

describe("mutationTouchesCaptionSelector", () => {
  it("ignores unrelated page churn that would otherwise starve caption debounce", async () => {
    document.body.innerHTML =
      '<div id="captions">Caption</div><div id="chat"></div>';
    const records = await mutationRecords(() => {
      document.querySelector("#chat")?.append(document.createElement("span"));
    });

    expect(mutationTouchesCaptionSelector(records, "#captions")).toBe(false);
  });

  it("detects text and child changes inside the caption subtree", async () => {
    document.body.innerHTML = '<div id="captions">Caption</div>';
    const records = await mutationRecords(() => {
      const captions = document.querySelector("#captions");
      if (captions) captions.textContent = "Next caption";
    });

    expect(mutationTouchesCaptionSelector(records, "#captions")).toBe(true);
    expect(mutationTouchesCaptionSelector(records, ".123")).toBe(false);
  });
});
