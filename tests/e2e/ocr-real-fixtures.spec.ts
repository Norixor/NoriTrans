import { readFile } from "node:fs/promises";
import { chromium, expect, test } from "@playwright/test";

interface RealOcrFixture {
  path: string;
  expected: string;
}

const extensionPath = new URL("../../.output/chrome-mv3", import.meta.url)
  .pathname;
const fixtures: RealOcrFixture[] = JSON.parse(
  process.env.NORIXORTRANS_OCR_REAL_FIXTURES ?? "[]",
) as RealOcrFixture[];

test("recognizes explicitly supplied real subtitle crops locally", async () => {
  test.skip(fixtures.length === 0, "No external OCR fixtures were supplied");
  test.setTimeout(180_000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const measurements: Array<{ expected: string; elapsedMs: number }> = [];
    let worker = context.serviceWorkers()[0];
    worker ??= await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    const installed: unknown = await page.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "OCR_RUNTIME_DOWNLOAD",
        pack: "zh",
      }),
    );
    expect(installed).toEqual({ ok: true });

    const sessionId = "ocr-session-12345678";
    const prepared: unknown = await page.evaluate(
      (id) =>
        chrome.runtime.sendMessage({
          target: "norixortrans-ocr-background",
          type: "OCR_OFFSCREEN_PREPARE",
          sessionId: id,
          requestId: "ocr-request-12345678",
          sourceLanguage: "zh-CN",
        }),
      sessionId,
    );
    if (
      !prepared ||
      typeof prepared !== "object" ||
      !("ok" in prepared) ||
      prepared.ok !== true
    ) {
      throw new Error(`OCR prepare failed: ${JSON.stringify(prepared)}`);
    }
    expect(prepared).toMatchObject({ ok: true });

    for (const [index, fixture] of fixtures.entries()) {
      const dataUrl = `data:image/png;base64,${(
        await readFile(fixture.path)
      ).toString("base64")}`;
      const result = await page.evaluate(
        async ({ dataUrl: image, index: fixtureIndex, sessionId: id }) => {
          const dimensions = await new Promise<{
            width: number;
            height: number;
          }>((resolve, reject) => {
            const element = new Image();
            element.onload = () =>
              resolve({
                width: element.naturalWidth,
                height: element.naturalHeight,
              });
            element.onerror = () => reject(new Error("fixture decode failed"));
            element.src = image;
          });
          const startedAt = performance.now();
          const response: unknown = await chrome.runtime.sendMessage({
            target: "norixortrans-ocr-background",
            type: "OCR_OFFSCREEN_RECOGNIZE",
            sessionId: id,
            requestId: `ocr-recognize-${String(fixtureIndex).padStart(8, "0")}`,
            image: { dataUrl: image, ...dimensions },
          });
          return { response, elapsedMs: performance.now() - startedAt };
        },
        { dataUrl, index, sessionId },
      );
      expect(result.response).toMatchObject({
        ok: true,
        text: fixture.expected,
      });
      expect(result.elapsedMs).toBeLessThan(1_500);
      measurements.push({
        expected: fixture.expected,
        elapsedMs: Math.round(result.elapsedMs),
      });
    }
    console.log("PP-OCR real fixture timings:", JSON.stringify(measurements));
  } finally {
    await context.close();
  }
});
