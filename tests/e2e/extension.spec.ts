import {
  expect,
  test,
  chromium,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getOcrRuntimeLanguage } from "@/src/ocr/runtime-catalog";
import { TRANSLATION_METHODS } from "@/src/shared/translation-methods";

interface SubtitleStatus {
  state: string;
  source?: string;
  completeness?: string;
  total: number;
  completed: number;
  failed: number;
}

interface PageStatus {
  state: string;
  total: number;
  completed: number;
  failed: number;
  message?: string;
  details?: string;
}

const extensionPath = new URL("../../.output/chrome-mv3", import.meta.url)
  .pathname;
const packageVersion = (
  JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;
const providerBaseUrl = "https://provider.youtube.com/v1";
const ocrRuntimeDirectory = process.env.NTRANS_OCR_RUNTIME_DIR?.trim();
const ocrRuntimeArtifacts = getOcrRuntimeLanguage("eng").artifacts;
const localOcrRuntimeFiles = ocrRuntimeDirectory
  ? ocrRuntimeArtifacts.map((artifact) => ({
      artifact,
      path: join(ocrRuntimeDirectory, basename(new URL(artifact.url).pathname)),
    }))
  : [];
const hasLocalOcrRuntime =
  localOcrRuntimeFiles.length === ocrRuntimeArtifacts.length &&
  localOcrRuntimeFiles.every(({ path }) => existsSync(path));
const runHeadedOcrCapture =
  process.env.NTRANS_OCR_CAPTURE_E2E === "1" && hasLocalOcrRuntime;
let context: BrowserContext;
let controlPage: Page;
const partialJsonRequestSegmentCounts: number[] = [];
const partialStreamRequestSegmentCounts: number[] = [];
const selectionProviderTexts: string[] = [];
const dynamicDuplicateProviderTexts: string[] = [];
const emptyStreamFallbackModes: boolean[] = [];
const protectedPageRequests: Array<{
  id: string;
  text: string;
  format?: unknown;
}> = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ProviderFixtureSegment {
  id: string;
  text: string;
  format?: "protected-text-v1";
}

function providerFixtureSegments(value: unknown): ProviderFixtureSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((segment): ProviderFixtureSegment[] => {
    if (
      Array.isArray(segment) &&
      typeof segment[0] === "string" &&
      typeof segment[1] === "string"
    ) {
      return [
        {
          id: segment[0],
          text: segment[1],
          ...(segment[4] === "p" ? { format: "protected-text-v1" } : {}),
        },
      ];
    }
    if (
      isRecord(segment) &&
      typeof segment.id === "string" &&
      typeof segment.text === "string"
    ) {
      return [
        {
          id: segment.id,
          text: segment.text,
          ...(segment.format === "protected-text-v1"
            ? { format: "protected-text-v1" }
            : {}),
        },
      ];
    }
    return [];
  });
}

async function extensionIdFor(browserContext: BrowserContext): Promise<string> {
  let worker = browserContext.serviceWorkers()[0];
  worker ??= await browserContext.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  if (!extensionId) throw new Error("Extension service worker has no ID");
  return extensionId;
}

async function configureProvider(page: Page): Promise<void> {
  await page.evaluate(async (baseUrl) => {
    const stored: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      typeof stored !== "object" ||
      stored === null ||
      !("provider" in stored) ||
      !("subtitles" in stored)
    ) {
      throw new Error("Could not read E2E settings");
    }
    const settings = stored as {
      provider: Record<string, unknown>;
      subtitles: Record<string, unknown>;
    };
    settings.provider = {
      ...settings.provider,
      fastProvider: "google-translate",
      aiProvider: "openai-compatible",
      baseUrl,
      apiKey: "e2e-only-key",
      googleApiKey: "e2e-google-key",
      model: "e2e-model",
    };
    settings.subtitles = {
      ...settings.subtitles,
      enabled: true,
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      mode: "ai",
      displayMode: "bilingual",
    };
    const response: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings,
    });
    if (
      typeof response !== "object" ||
      response === null ||
      !("ok" in response) ||
      response.ok !== true
    ) {
      throw new Error("Could not save E2E settings");
    }
  }, providerBaseUrl);
}

async function updateSubtitlePreferences(
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return controlPage.evaluate(async (subtitlePatch) => {
    const stored: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      typeof stored !== "object" ||
      stored === null ||
      !("subtitles" in stored) ||
      typeof stored.subtitles !== "object" ||
      stored.subtitles === null
    ) {
      throw new Error("Missing subtitle settings");
    }
    const previous = { ...stored.subtitles };
    const settings = {
      ...stored,
      subtitles: { ...stored.subtitles, ...subtitlePatch },
    };
    const response: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings,
    });
    if (
      typeof response !== "object" ||
      response === null ||
      !("ok" in response) ||
      response.ok !== true
    ) {
      throw new Error("Could not update subtitle settings");
    }
    return previous;
  }, patch);
}

async function subtitleStatus(pageUrl: string): Promise<SubtitleStatus | null> {
  return controlPage.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === targetUrl);
    if (tab?.id === undefined) return null;
    try {
      const response: unknown = await chrome.tabs.sendMessage(
        tab.id,
        { type: "SUBTITLE_STATUS" },
        { frameId: 0 },
      );
      if (
        typeof response !== "object" ||
        response === null ||
        !("state" in response) ||
        typeof response.state !== "string" ||
        !("total" in response) ||
        typeof response.total !== "number" ||
        !("completed" in response) ||
        typeof response.completed !== "number" ||
        !("failed" in response) ||
        typeof response.failed !== "number"
      ) {
        return null;
      }
      return {
        state: response.state,
        ...("source" in response && typeof response.source === "string"
          ? { source: response.source }
          : {}),
        ...("completeness" in response &&
        typeof response.completeness === "string"
          ? { completeness: response.completeness }
          : {}),
        total: response.total,
        completed: response.completed,
        failed: response.failed,
        ...("details" in response && typeof response.details === "string"
          ? { details: response.details }
          : {}),
      };
    } catch {
      return null;
    }
  }, pageUrl);
}

async function pageStatus(pageUrl: string): Promise<PageStatus | null> {
  return controlPage.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === targetUrl);
    if (tab?.id === undefined) return null;
    try {
      const response: unknown = await chrome.tabs.sendMessage(
        tab.id,
        { type: "PAGE_STATUS" },
        { frameId: 0 },
      );
      if (
        typeof response !== "object" ||
        response === null ||
        !("state" in response) ||
        typeof response.state !== "string" ||
        !("total" in response) ||
        typeof response.total !== "number" ||
        !("completed" in response) ||
        typeof response.completed !== "number" ||
        !("failed" in response) ||
        typeof response.failed !== "number"
      ) {
        return null;
      }
      return {
        state: response.state,
        total: response.total,
        completed: response.completed,
        failed: response.failed,
        ...("message" in response && typeof response.message === "string"
          ? { message: response.message }
          : {}),
        ...("details" in response && typeof response.details === "string"
          ? { details: response.details }
          : {}),
      };
    } catch {
      return null;
    }
  }, pageUrl);
}

async function waitForReadyTrack(
  pageUrl: string,
  expected: Pick<SubtitleStatus, "source" | "completeness">,
): Promise<SubtitleStatus> {
  await expect
    .poll(async () => {
      const status = await subtitleStatus(pageUrl);
      return status
        ? {
            state: status.state,
            source: status.source,
            completeness: status.completeness,
            failed: status.failed,
          }
        : null;
    })
    .toEqual({ state: "ready", ...expected, failed: 0 });
  const status = await subtitleStatus(pageUrl);
  if (!status) throw new Error("Subtitle status disappeared");
  return status;
}

async function sendContentCommand(
  pageUrl: string,
  command: "PAGE_TRANSLATE" | "PAGE_RESTORE",
): Promise<void> {
  const result = await controlPage.evaluate(
    async ({ targetUrl, contentCommand }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url === targetUrl);
      if (tab?.id === undefined)
        return {
          ok: false,
          error: "tab_not_found",
        };
      const ready: unknown = await chrome.runtime.sendMessage({
        type: "ENSURE_PAGE_CONTENT",
        tabId: tab.id,
      });
      if (
        typeof ready !== "object" ||
        ready === null ||
        !("ok" in ready) ||
        ready.ok !== true
      ) {
        return { ok: false, error: JSON.stringify(ready) };
      }
      await chrome.tabs.sendMessage(tab.id, { type: contentCommand });
      return { ok: true };
    },
    { targetUrl: pageUrl, contentCommand: command },
  );
  expect(result, result.error).toEqual({ ok: true });
}

async function beginPageTranslation(pageUrl: string): Promise<void> {
  const started = await controlPage.evaluate(async (targetUrl) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((candidate) => candidate.url === targetUrl);
    if (tab?.id === undefined) return false;
    const ready: unknown = await chrome.runtime.sendMessage({
      type: "ENSURE_PAGE_CONTENT",
      tabId: tab.id,
    });
    if (
      typeof ready !== "object" ||
      ready === null ||
      !("ok" in ready) ||
      ready.ok !== true
    ) {
      return false;
    }
    void chrome.tabs.sendMessage(tab.id, { type: "PAGE_TRANSLATE" });
    return true;
  }, pageUrl);
  expect(started).toBe(true);
}

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !runHeadedOcrCapture,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  for (const { artifact, path } of localOcrRuntimeFiles) {
    await context.route(artifact.url, (route) =>
      route.fulfill({
        path,
        contentType: artifact.contentTypes.at(0) ?? "application/octet-stream",
      }),
    );
  }
  await context.route(
    "https://translation.googleapis.com/**",
    async (route) => {
      try {
        const payload: unknown = JSON.parse(
          route.request().postData() ?? "null",
        );
        if (!isRecord(payload) || !Array.isArray(payload.q)) {
          throw new Error("Invalid Google translation fixture payload");
        }
        const texts = payload.q.filter(
          (value): value is string => typeof value === "string",
        );
        if (texts.length !== payload.q.length) {
          throw new Error("Invalid Google translation fixture text");
        }
        for (const text of texts) {
          if (text.includes("SELECTION_E2E")) selectionProviderTexts.push(text);
          if (text.includes("CACHE_DUPLICATE_E2E")) {
            dynamicDuplicateProviderTexts.push(text);
          }
        }
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            data: {
              translations: texts.map((text) => ({
                translatedText: `已译 ${text}`,
              })),
            },
          }),
        });
      } catch {
        await route.fulfill({ status: 400, body: "invalid fixture request" });
      }
    },
  );
  await context.route("https://provider.youtube.com/**", async (route) => {
    try {
      const rawPayload = route.request().postData();
      const payload: unknown = rawPayload ? JSON.parse(rawPayload) : undefined;
      if (!isRecord(payload) || !Array.isArray(payload.messages)) {
        throw new Error("Invalid E2E provider payload");
      }
      const messages = payload.messages as unknown[];
      const message = messages.find(
        (candidate: unknown) =>
          isRecord(candidate) &&
          candidate.role === "user" &&
          typeof candidate.content === "string",
      );
      const requestBody: unknown =
        isRecord(message) && typeof message.content === "string"
          ? JSON.parse(message.content)
          : undefined;
      if (!isRecord(requestBody) || !Array.isArray(requestBody.segments)) {
        throw new Error("Invalid E2E translation segments");
      }
      const segments = providerFixtureSegments(requestBody.segments);
      if (segments.length !== requestBody.segments.length) {
        throw new Error("Invalid E2E translation segment");
      }
      const sourceText = segments.map((segment) => segment.text).join("\n");
      if (sourceText.includes("SELECTION_E2E")) {
        selectionProviderTexts.push(sourceText);
      }
      if (sourceText.includes("CACHE_DUPLICATE_E2E")) {
        dynamicDuplicateProviderTexts.push(sourceText);
      }
      if (sourceText.includes("EMPTY_STREAM_FALLBACK")) {
        emptyStreamFallbackModes.push(payload.stream === true);
        if (payload.stream === true) {
          await route.fulfill({
            contentType: "text/event-stream",
            body: "data: [DONE]\n\n",
          });
          return;
        }
      }
      if (sourceText.includes("RATE_LIMIT")) {
        await route.fulfill({ status: 429, body: '{"error":"rate limit"}' });
        return;
      }
      if (sourceText.includes("SERVER_ERROR")) {
        await route.fulfill({ status: 500, body: '{"error":"server error"}' });
        return;
      }
      if (sourceText.includes("INVALID_RESPONSE_DETAILS")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    results: [
                      {
                        id: "unexpected-id",
                        translatedText: "不应写入页面",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        });
        return;
      }
      if (sourceText.includes("PARTIAL_STREAM_DETAILS")) {
        partialStreamRequestSegmentCounts.push(segments.length);
        const first = segments[0];
        if (partialStreamRequestSegmentCounts.length === 1) {
          if (!first || segments.length < 2) {
            throw new Error("Partial stream fixture requires two segments");
          }
          const event = (content: string) =>
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
          await route.fulfill({
            contentType: "text/event-stream",
            body: `${event(`{"results":[${JSON.stringify([first.id, "第一条已译"])},`)}${event("BROKEN]}")}data: [DONE]\n\n`,
          });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (sourceText.includes("SLOW_TRANSLATION")) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }
      if (sourceText.includes("AI_PROGRESSIVE")) {
        await new Promise((resolve) =>
          setTimeout(resolve, sourceText.includes("paragraph 61") ? 750 : 250),
        );
      }
      const results = segments.map((segment) => {
        if (segment.format === "protected-text-v1") {
          protectedPageRequests.push({
            id: segment.id,
            text: segment.text,
            format: segment.format,
          });
          const firstMarkerEnd = segment.text.indexOf("\uE001");
          if (firstMarkerEnd < 0) {
            throw new Error("Protected E2E segment has no opening marker");
          }
          return {
            id: segment.id,
            translatedText: `${segment.text.slice(0, firstMarkerEnd + 1)}已译 ${segment.text.slice(firstMarkerEnd + 1)}`,
          };
        }
        return { id: segment.id, translatedText: `译:已译 ${segment.text}` };
      });
      let responseResults = results;
      if (sourceText.includes("PARTIAL_JSON")) {
        partialJsonRequestSegmentCounts.push(results.length);
        if (results.length > 1) responseResults = results.slice(0, -1);
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ results: responseResults }),
              },
            },
          ],
        }),
      });
    } catch {
      await route.fulfill({ status: 400, body: "invalid fixture request" });
    }
  });
  const extensionId = await extensionIdFor(context);
  controlPage = await context.newPage();
  await controlPage.goto(`chrome-extension://${extensionId}/options.html`);
  await configureProvider(controlPage);
});

test.afterAll(async () => {
  await context?.close();
});

test("popup keeps icons and custom select arrows geometrically aligned", async () => {
  const extensionId = new URL(controlPage.url()).host;
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const geometry = await page.evaluate(() => {
      const rect = (element: Element) => {
        const value = element.getBoundingClientRect();
        return {
          centerX: value.left + value.width / 2,
          centerY: value.top + value.height / 2,
        };
      };
      const button = document.querySelector(".icon-button")!;
      const icon = button.querySelector("svg")!;
      const controls = [...document.querySelectorAll(".select-control")].filter(
        (control) => control.getBoundingClientRect().height > 0,
      );
      return {
        popupWidth: document.querySelector("main")!.getBoundingClientRect()
          .width,
        unresolvedMessages:
          document.documentElement.outerHTML.includes("__MSG_"),
        subtitleTaskControls: document.querySelectorAll(
          "#retry-subtitles, #cancel-subtitles, #subtitle-task-panel",
        ).length,
        bodyWidth: document.body.getBoundingClientRect().width,
        shellRightInset:
          document.querySelector("main")!.getBoundingClientRect().right -
          button.getBoundingClientRect().right,
        gearDeltaX: rect(icon).centerX - rect(button).centerX,
        gearDeltaY: rect(icon).centerY - rect(button).centerY,
        arrows: controls.map((control) => {
          const style = getComputedStyle(control, "::after");
          const select = control.querySelector("select")!;
          return {
            right: style.right,
            top: style.top,
            width: style.width,
            controlHeight: control.getBoundingClientRect().height,
            selectHeight: select.getBoundingClientRect().height,
            mask: style.maskImage,
          };
        }),
      };
    });

    expect(geometry.popupWidth).toBe(360);
    expect(geometry.unresolvedMessages).toBe(false);
    expect(geometry.subtitleTaskControls).toBe(0);
    expect(geometry.bodyWidth).toBe(360);
    expect(geometry.shellRightInset).toBeGreaterThanOrEqual(15);
    expect(geometry.shellRightInset).toBeLessThanOrEqual(16);
    expect(geometry.gearDeltaX).toBe(0);
    expect(geometry.gearDeltaY).toBe(0);
    expect(geometry.arrows).toHaveLength(3);
    expect(geometry.arrows.every((arrow) => arrow.right === "14px")).toBe(true);
    expect(
      geometry.arrows.every(
        (arrow) =>
          Math.abs(Number.parseFloat(arrow.top) - arrow.controlHeight / 2) <= 1,
      ),
    ).toBe(true);
    expect(geometry.arrows.every((arrow) => arrow.width === "14px")).toBe(true);
    expect(geometry.arrows.every((arrow) => arrow.controlHeight === 44)).toBe(
      true,
    );
    expect(geometry.arrows.every((arrow) => arrow.selectHeight === 44)).toBe(
      true,
    );
    expect(geometry.arrows.every((arrow) => arrow.mask !== "none")).toBe(true);

    const manifest = await page.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe(packageVersion);
    expect(manifest.default_locale).toBe("en");
    expect(manifest.options_ui).toEqual({
      page: "options.html",
      open_in_tab: true,
    });
    expect(manifest.permissions).toEqual([
      "storage",
      "unlimitedStorage",
      "activeTab",
      "scripting",
      "offscreen",
    ]);
    expect(manifest.host_permissions).toEqual(["https://*/*"]);
    expect(manifest.host_permissions).not.toContain("<all_urls>");
    expect(manifest.optional_host_permissions).toContain("<all_urls>");
    expect(manifest.content_scripts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          all_frames: true,
          match_about_blank: true,
          match_origin_as_fallback: true,
        }),
      ]),
    );
    expect(
      manifest.web_accessible_resources?.some(
        (resource) =>
          typeof resource === "object" &&
          resource !== null &&
          resource.matches?.includes("https://*.youtube-nocookie.com/*"),
      ),
    ).toBe(true);
    const mainWorldResource = manifest.web_accessible_resources?.find(
      (resource) =>
        typeof resource === "object" &&
        resource !== null &&
        resource.resources?.includes("video-main-world.js"),
    );
    expect(mainWorldResource).toEqual(
      expect.objectContaining({
        matches: expect.arrayContaining([
          "https://*.netflix.com/*",
          "https://*.max.com/*",
          "https://*.hbomax.com/*",
          "https://*.disneyplus.com/*",
          "https://*.primevideo.com/*",
          "https://*.amazon.com/*",
          "https://*.amazon.co.uk/*",
          "https://*.amazon.co.jp/*",
        ]),
      }),
    );

    // Chrome derives an action popup's initial viewport from intrinsic
    // content size. A tiny provisional viewport must not collapse it into the
    // narrow vertical strip seen in real toolbar usage.
    await page.setViewportSize({ width: 48, height: 900 });
    await page.reload();
    const intrinsicPopup = await page.evaluate(() => ({
      bodyWidth: document.body.getBoundingClientRect().width,
      rootMinWidth: getComputedStyle(document.documentElement).minWidth,
      writingMode: getComputedStyle(document.body).writingMode,
    }));
    expect(intrinsicPopup).toEqual({
      bodyWidth: 360,
      rootMinWidth: "360px",
      writingMode: "horizontal-tb",
    });
  } finally {
    await page.close();
  }
});

test("popup and options honor dark mode, reduced motion, and narrow widths", async () => {
  const extensionId = new URL(controlPage.url()).host;
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 380, height: 900 });
    await page.emulateMedia({
      colorScheme: "light",
      reducedMotion: "no-preference",
    });
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    const lightBackground = await page.evaluate(
      () => getComputedStyle(document.body).backgroundColor,
    );

    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.reload();
    const popupDark = await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(".icon-button")!;
      const primary =
        document.querySelector<HTMLButtonElement>(".button-primary")!;
      const select = document.querySelector<HTMLSelectElement>("select")!;
      const option = select.options[0]!;
      return {
        background: getComputedStyle(document.body).backgroundColor,
        overflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        buttonHeight: button.getBoundingClientRect().height,
        transitionDuration: getComputedStyle(button).transitionDuration,
        primaryBackgroundImage: getComputedStyle(primary).backgroundImage,
        primaryColor: getComputedStyle(primary).color,
        selectColorScheme: getComputedStyle(select).colorScheme,
        optionBackground: getComputedStyle(option).backgroundColor,
        optionColor: getComputedStyle(option).color,
      };
    });
    expect(popupDark.background).not.toBe(lightBackground);
    expect(popupDark.overflow).toBe(false);
    expect(popupDark.buttonHeight).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(popupDark.transitionDuration)).toBeLessThanOrEqual(
      0.001,
    );
    expect(popupDark.primaryBackgroundImage).toBe("none");
    expect(popupDark.primaryColor).toBe("rgb(33, 31, 27)");
    expect(popupDark.selectColorScheme).toBe("dark");
    expect(popupDark.optionBackground).toBe("rgb(33, 31, 27)");
    expect(popupDark.optionColor).toBe("rgb(246, 241, 231)");

    await page.setViewportSize({ width: 380, height: 900 });
    await page.reload();
    const narrowPopup = await page.evaluate(() => ({
      bodyWidth: document.body.getBoundingClientRect().width,
      overflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
    }));
    expect(narrowPopup.bodyWidth).toBe(360);
    expect(narrowPopup.overflow).toBe(false);
    await expect(
      page.locator(
        "form input:not([name]), form select:not([name]), form textarea:not([name])",
      ),
    ).toHaveCount(0);
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);

    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await expect(
      page.locator(
        "form input:not([name]), form select:not([name]), form textarea:not([name])",
      ),
    ).toHaveCount(0);
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
    await expect(page.locator(".settings-tab")).toHaveCount(9);
    await page.locator("#visibility-settings-tab").click();
    await expect(
      page.locator("#floating-control-enabled"),
    ).toHaveAccessibleName(/floating control|浮动控制|浮窗/iu);
    await page.locator("#selection-settings-tab").click();
    await expect(
      page.locator("#selection-translation-enabled"),
    ).toHaveAccessibleName(/selection translation|划词翻译/iu);
    await page.locator("#profiles-settings-tab").click();
    await expect(page.locator(".data-section")).toBeHidden();
    const builtInProfiles = page.locator(
      '.profile-catalog-item[data-kind="builtin"]',
    );
    await expect(builtInProfiles).toHaveCount(18);
    const builtInProfileText = (await builtInProfiles.allTextContents()).join(
      " ",
    );
    expect(builtInProfileText).toContain("YouTube");
    expect(builtInProfileText).toContain("Netflix");
    expect(builtInProfileText).not.toMatch(/Tencent|腾讯/u);
    expect(builtInProfileText).toMatch(/Max|HBO/u);
    expect(builtInProfileText).toContain("Disney+");
    expect(builtInProfileText).toContain("Prime Video");
    expect(builtInProfileText).toContain("Apple TV+");
    expect(builtInProfileText).toContain("Udemy");
    expect(builtInProfileText).toContain("Kanopy");
    expect(builtInProfileText).toContain("TVer");
    expect(builtInProfileText).not.toContain("Standard HTML5 TextTrack");
    await expect(page.locator("#profile-total-count")).toHaveText("18");
    await page.locator("#provider-settings-tab").click();
    await expect(page.locator(".data-section")).toBeVisible();
    await page.locator("#provider-settings-tab").press("ArrowLeft");
    await expect(page.locator("#visibility-settings-tab")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#visibility-settings-tab")).toBeFocused();
    await expect(page.locator(".data-section")).toBeHidden();
    await page.locator("#ocr-runtimes-tab").click();
    await expect(page.locator("#ocr-runtimes-panel")).toBeVisible();
    await expect(
      page.locator("#ocr-runtimes-panel .runtime-local-note"),
    ).toContainText(/device|设备/iu);
    await expect(page.locator("#ocr-runtimes-panel")).not.toContainText(
      /PP-OCR|ONNX|SHA-256|物理模型|physical model/iu,
    );
    await page.locator("#visibility-settings-tab").click();
    await expect(page.locator("#visibility-settings-panel")).toBeVisible();
    await expect(page.locator("#floating-control-enabled")).toBeVisible();
    await expect(page.locator("#restore-session-floating")).toBeVisible();
    await page.locator("#page-settings-tab").click();
    const denseSettingsGeometry = await page.evaluate(() => {
      const control = document.querySelector<HTMLSelectElement>(
        "#page-source-language",
      )!;
      const panel = document.querySelector<HTMLElement>(
        "#page-settings-panel",
      )!;
      const panelStyle = getComputedStyle(panel);
      return {
        controlHeight: control.getBoundingClientRect().height,
        panelBackground: panelStyle.backgroundColor,
        panelBorderTop: panelStyle.borderTopWidth,
      };
    });
    // Narrow layouts retain a 44px touch target; desktop settings use 40px.
    expect(denseSettingsGeometry.controlHeight).toBe(44);
    expect(denseSettingsGeometry.panelBackground).toBe("rgba(0, 0, 0, 0)");
    expect(denseSettingsGeometry.panelBorderTop).toBe("0px");
    await page.locator("#ocr-runtimes-tab").click();
    const optionsGeometry = await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>(
        "#page-source-language",
      )!;
      const option = select.options[0]!;
      return {
        overflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        saveHeight: document
          .querySelector<HTMLButtonElement>("#save-settings")!
          .getBoundingClientRect().height,
        transitionDuration: getComputedStyle(
          document.querySelector<HTMLButtonElement>("#save-settings")!,
        ).transitionDuration,
        unresolvedMessages:
          document.documentElement.outerHTML.includes("__MSG_"),
        primaryBackgroundImage: getComputedStyle(
          document.querySelector<HTMLButtonElement>("#save-settings")!,
        ).backgroundImage,
        runtimeActionHeight: document
          .querySelector<HTMLButtonElement>("#ocr-runtime-download-all")!
          .getBoundingClientRect().height,
        selectColorScheme: getComputedStyle(select).colorScheme,
        optionBackground: getComputedStyle(option).backgroundColor,
        optionColor: getComputedStyle(option).color,
      };
    });
    expect(optionsGeometry.overflow).toBe(false);
    expect(optionsGeometry.saveHeight).toBeGreaterThanOrEqual(44);
    expect(optionsGeometry.runtimeActionHeight).toBeGreaterThanOrEqual(44);
    expect(
      Number.parseFloat(optionsGeometry.transitionDuration),
    ).toBeLessThanOrEqual(0.001);
    expect(optionsGeometry.unresolvedMessages).toBe(false);
    expect(optionsGeometry.primaryBackgroundImage).toBe("none");
    expect(optionsGeometry.selectColorScheme).toBe("dark");
    expect(optionsGeometry.optionBackground).toBe("rgb(37, 34, 30)");
    expect(optionsGeometry.optionColor).toBe("rgb(243, 238, 229)");

    await page.goto(`chrome-extension://${extensionId}/ocr-permission.html`);
    await page.setViewportSize({ width: 520, height: 340 });
    await expect(page.locator("#allow")).toHaveCSS("background-image", "none");
    await expect(page.locator(".instruction")).toBeVisible();
    const permissionGeometry = await page.evaluate(() => {
      const allow = document
        .querySelector<HTMLButtonElement>("#allow")!
        .getBoundingClientRect();
      return {
        allowTop: allow.top,
        allowBottom: allow.bottom,
        viewportHeight: window.innerHeight,
        horizontalOverflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        unresolvedMessages:
          document.documentElement.outerHTML.includes("__MSG_"),
      };
    });
    expect(permissionGeometry.allowTop).toBeGreaterThanOrEqual(0);
    expect(permissionGeometry.allowBottom).toBeLessThanOrEqual(
      permissionGeometry.viewportHeight,
    );
    expect(permissionGeometry.horizontalOverflow).toBe(false);
    expect(permissionGeometry.unresolvedMessages).toBe(false);

    const darkFloatingPageUrl = "https://example.com/norixortrans-dark-selects";
    await context.route(darkFloatingPageUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body><main>Dark select fixture</main></body></html>",
      }),
    );
    await page.goto(darkFloatingPageUrl);
    await expect(page.locator("norixor-floating-control")).toBeAttached();
    const floatingSelectPalette = await page.evaluate(() => {
      const root = document.querySelector(
        "norixor-floating-control",
      )?.shadowRoot;
      const select = root?.querySelector<HTMLSelectElement>("select");
      const option = select?.options[0];
      if (!select || !option) return null;
      return {
        colorScheme: getComputedStyle(select).colorScheme,
        optionBackground: getComputedStyle(option).backgroundColor,
        optionColor: getComputedStyle(option).color,
      };
    });
    expect(floatingSelectPalette).toEqual({
      colorScheme: "dark",
      optionBackground: "rgb(33, 31, 27)",
      optionColor: "rgb(245, 239, 229)",
    });
  } finally {
    await page.close();
  }
});

test("options lists missing OCR runtimes without automatic downloads and preserves action focus", async () => {
  const extensionId = await extensionIdFor(context);
  const modelRequests: string[] = [];
  const modelUrl =
    /https:\/\/(?:media\.githubusercontent\.com|raw\.githubusercontent\.com)\//u;
  const captureModelRequest = (request: Request): void => {
    if (
      request.url().startsWith("https://media.githubusercontent.com/") ||
      request.url().startsWith("https://raw.githubusercontent.com/")
    ) {
      modelRequests.push(request.url());
    }
  };
  const blockExplicitModelDownload = (route: Route): Promise<void> =>
    route.abort();
  context.on("request", captureModelRequest);
  await context.route(modelUrl, blockExplicitModelDownload);
  try {
    await controlPage.goto(`chrome-extension://${extensionId}/options.html`);
    await controlPage.locator("#ocr-runtimes-tab").click();
    await expect(controlPage.locator("#ocr-runtime-list")).toBeVisible();
    await expect(controlPage.locator("#ocr-runtime-list")).not.toHaveAttribute(
      "aria-live",
      /.+/u,
    );
    await expect(controlPage.locator("#ocr-runtime-message")).toHaveAttribute(
      "role",
      "status",
    );
    await expect(
      controlPage.locator("#ocr-runtime-list .runtime-item"),
    ).toHaveCount(3);
    await expect(
      controlPage.locator("#ocr-runtime-list .runtime-group"),
    ).toHaveCount(3);
    await controlPage.locator("#profiles-settings-tab").click();
    const builtInProfiles = controlPage.locator(
      '.profile-catalog-item[data-kind="builtin"]',
    );
    await expect(builtInProfiles).toHaveCount(18);
    await expect(controlPage.locator("#profile-catalog-list")).toContainText(
      "Max / HBO Max",
    );
    await expect(controlPage.locator("#profile-catalog-list")).toContainText(
      "Disney+",
    );
    await expect(controlPage.locator("#profile-catalog-list")).toContainText(
      "Prime Video",
    );
    await expect(controlPage.locator("#profile-catalog-list")).toContainText(
      "TVer",
    );
    await expect(
      controlPage.locator(
        '#ocr-runtime-list .runtime-status-badge[data-state="missing"]',
      ),
    ).toHaveCount(3);
    await expect(
      controlPage.locator("#ocr-runtime-download-all"),
    ).toBeEnabled();
    expect(modelRequests).toEqual([]);
    await controlPage.locator("#ocr-runtimes-tab").click();
    const focusedRuntimeAction = await controlPage.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '#ocr-runtime-list button[data-runtime-action="download"]',
      );
      if (!button) throw new Error("Missing OCR runtime download action");
      const identity = {
        language: button.dataset.runtimeLanguage,
        action: button.dataset.runtimeAction,
      };
      button.focus();
      // The explicit action may start a download when the optional origin is
      // already granted. Its synchronous and polled rerenders must keep focus.
      button.click();
      const active = document.activeElement as HTMLElement | null;
      return {
        expected: identity,
        actual: {
          language: active?.dataset.runtimeLanguage,
          action: active?.dataset.runtimeAction,
        },
      };
    });
    expect(focusedRuntimeAction.actual).toEqual(focusedRuntimeAction.expected);
    await controlPage.waitForTimeout(300);
    await expect
      .poll(() =>
        controlPage.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return {
            language: active?.dataset.runtimeLanguage,
            action: active?.dataset.runtimeAction,
          };
        }),
      )
      .toEqual(focusedRuntimeAction.expected);
  } finally {
    await context.unroute(modelUrl, blockExplicitModelDownload);
    context.off("request", captureModelRequest);
  }
});

test("site Profile synchronizes visual and developer management", async () => {
  await controlPage.locator("#profiles-settings-tab").click();
  const profileItems = controlPage.locator(".profile-catalog-item");
  await expect(profileItems.first()).toBeVisible();
  const profileGroups = controlPage.locator(".profile-catalog-section");
  await expect(profileGroups).toHaveCount(2);
  await profileGroups.nth(1).locator("summary").click();
  await expect(profileGroups.nth(1)).not.toHaveAttribute("open", "");
  await profileItems.first().click();
  await expect(profileGroups.nth(1)).not.toHaveAttribute("open", "");
  await profileGroups.nth(1).locator("summary").click();
  await expect(profileGroups.nth(1)).toHaveAttribute("open", "");
  await expect(
    controlPage.locator(".profile-catalog-item", {
      hasText: "Standard HTML5 TextTrack",
    }),
  ).toHaveCount(0);
  const profileLayout = await profileItems.first().evaluate((element) => {
    const style = getComputedStyle(element);
    const name = element.querySelector("strong");
    const meta = element.querySelector(":scope > span");
    return {
      display: style.display,
      width: element.getBoundingClientRect().width,
      parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
      nameDisplay: name ? getComputedStyle(name).display : "missing",
      metaDisplay: meta ? getComputedStyle(meta).display : "missing",
    };
  });
  expect(profileLayout).toMatchObject({
    display: "grid",
    nameDisplay: "block",
    metaDisplay: "block",
  });
  expect(profileLayout.width).toBeGreaterThan(profileLayout.parentWidth - 16);
  const workspaceColumns = await controlPage
    .locator(".profile-editor-workspace")
    .evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/u),
    );
  expect(workspaceColumns).toHaveLength(2);
  await expect(controlPage.locator("#profile-capture-details")).toBeVisible();
  await expect(
    controlPage.locator("#profile-capture-parser"),
  ).not.toBeVisible();
  await expect(controlPage.locator("#profile-json")).not.toBeVisible();
  await expect(controlPage.locator("#profile-file-dialog")).not.toBeVisible();
  await controlPage.locator("#profile-file-open").click();
  await expect(controlPage.locator("#profile-file-dialog")).toBeVisible();
  await expect(controlPage.locator("#profile-json")).toBeVisible();
  await expect(controlPage.locator("#profile-file-import")).toBeVisible();
  await expect(controlPage.locator("#profile-file-export")).toBeVisible();
  const profileText = await controlPage.locator("#profile-json").inputValue();
  await controlPage.locator("#profile-file-input").setInputFiles({
    name: "youtube.profile.json",
    mimeType: "application/json",
    buffer: Buffer.from(profileText),
  });
  await expect(controlPage.locator("#profile-message")).toContainText(
    /imported|已导入/iu,
  );
  const downloadPromise = controlPage.waitForEvent("download");
  await controlPage.locator("#profile-file-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("youtube.profile.json");
  await controlPage.locator("#profile-file-close").click();
  await expect(controlPage.locator("#profile-file-dialog")).not.toBeVisible();
  await expect(
    controlPage.locator("#profile-page-auto-translate"),
  ).toBeDisabled();
  await controlPage.locator("#profile-page-override").check();
  await expect(
    controlPage.locator("#profile-page-auto-translate"),
  ).toBeEnabled();
  await controlPage.locator("#profile-page-auto-translate").check();
  await controlPage.locator("#profile-page-floating-button").uncheck();
  await expect(controlPage.locator("#profile-json")).toHaveValue(
    /"autoTranslate": true[\s\S]*"floatingButtonEnabled": false/u,
  );
  await expect(
    controlPage.locator("#profile-capture-override"),
  ).not.toBeChecked();
  await expect(controlPage.locator("#profile-capture-parser")).toBeDisabled();
  await controlPage.locator("#profile-capture-override").check();
  await expect(controlPage.locator("#profile-capture-parser")).toBeVisible();
  await expect(controlPage.locator("#profile-capture-parser")).toBeEnabled();
  await expect(controlPage.locator("#profile-json")).toHaveValue(
    /"subtitleCapture": \{[\s\S]*"customized": true/u,
  );
  await controlPage.locator("#profile-save").click();
  await expect(controlPage.locator("#profile-editor-kind")).toHaveAttribute(
    "data-kind",
    "override",
  );
  controlPage.once("dialog", (dialog) => dialog.accept());
  await controlPage.locator("#profile-restore").click();
  await expect(controlPage.locator("#profile-editor-kind")).toHaveAttribute(
    "data-kind",
    "builtin",
  );
});

test("options saves a valid provider through the background settings boundary", async () => {
  await expect
    .poll(() =>
      controlPage.evaluate(() =>
        document.documentElement.outerHTML.includes("__MSG_"),
      ),
    )
    .toBe(false);
  await controlPage.locator("#profiles-settings-tab").click();
  const profileItems = controlPage.locator(".profile-catalog-item");
  await expect(profileItems.first()).toBeVisible();
  await expect(
    controlPage.locator(".profile-catalog-item", {
      hasText: "Standard HTML5 TextTrack",
    }),
  ).toHaveCount(0);
  const profileLayout = await profileItems.first().evaluate((element) => {
    const style = getComputedStyle(element);
    const name = element.querySelector("strong");
    const meta = element.querySelector(":scope > span");
    return {
      display: style.display,
      width: element.getBoundingClientRect().width,
      parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
      nameDisplay: name ? getComputedStyle(name).display : "missing",
      metaDisplay: meta ? getComputedStyle(meta).display : "missing",
    };
  });
  expect(profileLayout).toMatchObject({
    display: "grid",
    nameDisplay: "block",
    metaDisplay: "block",
  });
  expect(profileLayout.width).toBeGreaterThan(profileLayout.parentWidth - 16);
  await controlPage.locator("#provider-settings-tab").click();
  await expect(
    controlPage.locator('#fast-provider option[value="openai-compatible"]'),
  ).toHaveCount(0);
  await expect(controlPage.locator("#ai-provider option")).toHaveCount(2);
  await controlPage.locator("#base-url").fill(providerBaseUrl);
  await controlPage.locator("#api-key").fill("e2e-options-key");
  await controlPage.locator("#model").fill("e2e-options-model");
  await controlPage.locator("#timeout").fill("180");
  const translationMethodValues = TRANSLATION_METHODS.map(
    (method) => method.value,
  );
  for (const selector of [
    "#page-mode",
    "#selection-translation-mode",
    "#subtitle-mode",
    "#image-mode",
  ]) {
    await expect
      .poll(() =>
        controlPage
          .locator(`${selector} option`)
          .evaluateAll((options) =>
            options.map((option) => (option as HTMLOptionElement).value),
          ),
      )
      .toEqual(translationMethodValues);
  }
  await controlPage.locator("#page-settings-tab").click();
  await controlPage.locator("#page-mode").selectOption("ai");
  await controlPage.locator("#page-response-mode").selectOption("batch");
  await controlPage.locator("#selection-settings-tab").click();
  await controlPage
    .locator("#selection-translation-mode")
    .selectOption("fast:google-translate");
  await controlPage.locator("#video-settings-tab").click();
  await controlPage.locator("#subtitle-response-mode").selectOption("stream");
  await controlPage.locator("#subtitle-target-language").selectOption("ja");
  await controlPage
    .locator("#subtitle-display-mode")
    .selectOption("translated");
  await controlPage.locator("#subtitle-position").selectOption("top");
  await controlPage.locator("#subtitle-hide-native").focus();
  await controlPage.locator("#subtitle-hide-native").press("Space");
  await controlPage.locator("#subtitle-font-scale").fill("1.25");
  await controlPage.locator("#save-settings").click();

  await expect(controlPage.locator("#save-message")).toHaveAttribute(
    "data-tone",
    "success",
  );
  const stored = await controlPage.evaluate(async () => {
    const value: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      typeof value !== "object" ||
      value === null ||
      !("provider" in value) ||
      typeof value.provider !== "object" ||
      value.provider === null ||
      !("timeoutMs" in value.provider) ||
      !("subtitles" in value) ||
      !("page" in value)
    ) {
      return null;
    }
    return {
      timeoutMs: value.provider.timeoutMs,
      page: value.page,
      subtitles: value.subtitles,
    };
  });
  expect(stored).toMatchObject({
    timeoutMs: 180_000,
    page: {
      mode: "ai",
      aiResponseMode: "batch",
      floatingButtonEnabled: true,
      selectionTranslationEnabled: true,
      selectionTranslationMode: "fast",
    },
    subtitles: {
      aiResponseMode: "stream",
      targetLanguage: "ja",
      displayMode: "translated",
      hideNativeSubtitles: true,
      position: "top",
      fontScale: 1.25,
      floatingButtonEnabled: true,
    },
  });

  const contentSettings: unknown = await controlPage.evaluate(
    async (): Promise<unknown> => {
      const value: unknown = await chrome.runtime.sendMessage({
        type: "CONTENT_SETTINGS_GET",
      });
      return value;
    },
  );
  expect(contentSettings).toMatchObject({
    provider: {
      baseUrl: providerBaseUrl,
      model: "e2e-options-model",
    },
  });
  expect(
    isRecord(contentSettings) &&
      isRecord(contentSettings.provider) &&
      "apiKey" in contentSettings.provider,
  ).toBe(false);
});

test("selection translation sends text only after its compact trigger is clicked", async () => {
  const pageUrl = "https://example.com/norixortrans-selection-translation";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main><p id='selection-source'>SELECTION_E2E ordinary page text</p></main>",
    }),
  );
  selectionProviderTexts.length = 0;
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await page.locator("#selection-source").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const host = page.locator("norixor-selection-translation");
    const trigger = host.locator(".translate-trigger");
    await expect(trigger).toBeVisible();
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox?.width).toBe(44);
    expect(triggerBox?.height).toBe(44);
    expect(selectionProviderTexts).toHaveLength(0);

    await trigger.click();
    await expect(host.locator(".translated-text")).toHaveText(
      "已译 SELECTION_E2E ordinary page text",
    );
    await expect(host.locator(".loading")).toBeHidden();
    await expect(host.locator(".copy-button")).toBeVisible();
    expect(selectionProviderTexts).toEqual([
      "SELECTION_E2E ordinary page text",
    ]);
    const geometry = await host.locator(".card").evaluate((card) => ({
      right: card.getBoundingClientRect().right,
      bottom: card.getBoundingClientRect().bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    }));
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("options confirms destructive cache and credential clearing", async () => {
  await controlPage.locator("#provider-settings-tab").click();
  for (const selector of ["#clear-cache", "#clear-credentials"]) {
    const dialogPromise = controlPage.waitForEvent("dialog");
    const clickPromise = controlPage.locator(selector).click();
    const dialog = await dialogPromise;
    expect(dialog.type()).toBe("confirm");
    expect(dialog.message().trim().length).toBeGreaterThan(0);
    await dialog.dismiss();
    await clickPromise;
    await expect(controlPage.locator(selector)).toBeEnabled();
  }
});

test("required all-site permission covers configured HTTPS providers", async () => {
  const result: unknown = await controlPage.evaluate(
    async (): Promise<unknown> => {
      const original: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (
        typeof original !== "object" ||
        original === null ||
        !("provider" in original) ||
        typeof original.provider !== "object" ||
        original.provider === null
      ) {
        throw new Error("Missing original settings");
      }
      const settings = {
        ...original,
        provider: {
          ...original.provider,
          aiProvider: "openai-compatible",
          baseUrl: "https://ungranted-provider.invalid/v1",
          apiKey: "permission-test-key",
        },
      };
      try {
        await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
        const response: unknown = await chrome.runtime.sendMessage({
          type: "TRANSLATE",
          requestId: "permission-boundary-test",
          request: {
            sourceLanguage: "en",
            targetLanguage: "zh-CN",
            mode: "ai",
            segments: [{ id: "only", text: "Hello" }],
          },
        });
        return response;
      } finally {
        await chrome.runtime.sendMessage({
          type: "SETTINGS_SET",
          settings: original,
        });
      }
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: { code: "request_failed" },
  });
});

test("serializes concurrent page and subtitle quick-setting writes", async () => {
  const original = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!settings || typeof settings !== "object") {
      throw new Error("Missing settings for concurrent write test");
    }
    return settings;
  });
  try {
    const stored: unknown = await controlPage.evaluate(async () => {
      await Promise.all([
        chrome.runtime.sendMessage({
          type: "PAGE_AUTO_TRANSLATE_SET",
          enabled: true,
        }),
        chrome.runtime.sendMessage({
          type: "SUBTITLE_QUICK_SETTINGS_SET",
          sourceLanguage: "auto",
          targetLanguage: "zh-CN",
          mode: "fast",
          displayMode: "original",
          hideNativeSubtitles: true,
        }),
      ]);
      const settings: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      return settings;
    });
    expect(stored).toMatchObject({
      page: { autoTranslate: true },
      subtitles: {
        mode: "fast",
        displayMode: "original",
        hideNativeSubtitles: true,
      },
    });
  } finally {
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings,
      });
    }, original);
  }
});

test("popup follows external page settings and preserves them on its next edit", async () => {
  const extensionId = await extensionIdFor(context);
  const original = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!settings || typeof settings !== "object") {
      throw new Error("Missing settings for popup synchronization test");
    }
    return settings;
  });
  const popup = await context.newPage();
  try {
    await controlPage.evaluate(async () => {
      const settings: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (
        typeof settings !== "object" ||
        settings === null ||
        !("page" in settings) ||
        typeof settings.page !== "object" ||
        settings.page === null
      ) {
        throw new Error("Missing initial popup page settings");
      }
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: {
          ...settings,
          page: {
            ...settings.page,
            sourceLanguage: "auto",
            targetLanguage: "zh-CN",
            mode: "fast",
            aiResponseMode: "stream",
            displayMode: "bilingual",
          },
        },
      });
    });
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(popup.locator("#target-language")).toHaveValue("zh-CN");

    await controlPage.evaluate(async () => {
      const settings: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (
        typeof settings !== "object" ||
        settings === null ||
        !("page" in settings) ||
        typeof settings.page !== "object" ||
        settings.page === null
      ) {
        throw new Error("Missing externally updated popup page settings");
      }
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: {
          ...settings,
          page: {
            ...settings.page,
            targetLanguage: "es",
            mode: "ai",
            aiResponseMode: "batch",
            displayMode: "translated",
          },
        },
      });
    });

    await expect(popup.locator("#target-language")).toHaveValue("es");
    await expect(popup.locator("#translation-method")).toHaveValue("ai");
    await expect(popup.locator("#response-mode")).toHaveValue("batch");
    await expect(
      popup.locator('input[name="display-mode"][value="translated"]'),
    ).toBeChecked();

    await popup.locator("#source-language").selectOption("en");
    await expect
      .poll(() =>
        controlPage.evaluate(async () => {
          const settings: unknown = await chrome.runtime.sendMessage({
            type: "SETTINGS_GET",
          });
          return typeof settings === "object" &&
            settings !== null &&
            "page" in settings
            ? settings.page
            : null;
        }),
      )
      .toMatchObject({
        sourceLanguage: "en",
        targetLanguage: "es",
        mode: "ai",
        aiResponseMode: "batch",
        displayMode: "translated",
      });
  } finally {
    await popup.close();
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, original);
  }
});

test("content-script context cannot read private settings", async () => {
  const pageUrl = "https://www.youtube.com/private-settings-boundary-e2e";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Private settings boundary</title>",
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const response: unknown = await controlPage.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.url === targetUrl);
      if (tab?.id === undefined) throw new Error("Missing target tab");
      const [execution] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          const value: unknown = await chrome.runtime.sendMessage({
            type: "SETTINGS_GET",
          });
          return value;
        },
      });
      return execution?.result;
    }, pageUrl);

    expect(response).toMatchObject({ ok: false });
    expect(isRecord(response) && "provider" in response).toBe(false);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("options rejects an insecure remote HTTP provider without changing settings", async () => {
  await controlPage.locator("#provider-settings-tab").click();
  await controlPage.locator("#base-url").fill("http://remote.example/v1");
  await controlPage.locator("#save-settings").click();

  await expect(controlPage.locator("#save-message")).toHaveAttribute(
    "data-tone",
    "error",
  );
  await expect(controlPage.locator("#save-message")).toContainText("HTTPS");
  const storedBaseUrl = await controlPage.evaluate(async () => {
    const value: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      typeof value !== "object" ||
      value === null ||
      !("provider" in value) ||
      typeof value.provider !== "object" ||
      value.provider === null ||
      !("baseUrl" in value.provider)
    ) {
      return null;
    }
    return value.provider.baseUrl;
  });
  expect(storedBaseUrl).toBe(providerBaseUrl);
});

test("automatically mounts one unified page and video control", async () => {
  const pageUrl = "https://example.com/norixortrans-unified-control";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <style>
          norixor-floating-control {
            width: 48px;
            max-width: 48px;
            overflow: hidden;
            writing-mode: vertical-rl;
            position: static !important;
            z-index: -1 !important;
            pointer-events: none !important;
          }
        </style>
        <main><h1>Unified control fixture</h1></main>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const control = page.locator("norixor-floating-control");
    await expect(control).toHaveAttribute("data-hidden", "false");
    await expect(control.locator(".panel")).toBeHidden();
    await control.locator(".launcher").click();
    await expect(control.locator(".panel")).toBeVisible();
    await expect
      .poll(() =>
        control.evaluate((host) => ({
          overflow: getComputedStyle(host).overflow,
          writingMode: getComputedStyle(host).writingMode,
          position: getComputedStyle(host).position,
          zIndex: getComputedStyle(host).zIndex,
          pointerEvents: getComputedStyle(host).pointerEvents,
        })),
      )
      .toEqual({
        overflow: "visible",
        writingMode: "horizontal-tb",
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "auto",
      });
    expect(
      (await control.locator(".panel").boundingBox())?.width,
    ).toBeGreaterThanOrEqual(280);
    await expect(control.locator("#norixortrans-page-panel-tab")).toBeFocused();
    await expect(control.locator('[role="tab"]')).toHaveCount(3);
    await expect(control.locator("#norixortrans-page-panel")).toBeVisible();
    await control.locator("#norixortrans-video-panel-tab").click();
    await expect(control.locator("#norixortrans-video-panel")).toBeVisible();
    const launcher = control.locator(".launcher");
    const launcherBox = await launcher.boundingBox();
    if (!launcherBox) throw new Error("Missing floating launcher geometry");
    await page.mouse.move(
      launcherBox.x + launcherBox.width / 2,
      launcherBox.y + launcherBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(4, launcherBox.y + launcherBox.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    await expect(control).toHaveAttribute("data-docked-edge", "left");
    await expect(control).toHaveAttribute("data-edge-hidden", "true");
    await expect(control.locator(".panel")).toBeHidden();
    await page.mouse.move(400, 400);
    await expect(control).toHaveAttribute("data-edge-hidden", "true", {
      timeout: 2_000,
    });
    await expect
      .poll(() => control.evaluate((host) => getComputedStyle(host).transform))
      .toContain("-38");
    const hiddenLauncherBox = await launcher.boundingBox();
    if (!hiddenLauncherBox) throw new Error("Missing docked launcher geometry");
    const visibleWakeStrip = hiddenLauncherBox.x + hiddenLauncherBox.width;
    expect(visibleWakeStrip).toBeGreaterThanOrEqual(19);
    expect(visibleWakeStrip).toBeLessThanOrEqual(20.5);
    await page.mouse.move(
      2,
      hiddenLauncherBox.y + hiddenLauncherBox.height / 2,
    );
    await expect(control).toHaveAttribute("data-edge-hidden", "true");
    await page.mouse.down();
    await page.mouse.up();
    await expect(control).toHaveAttribute("data-edge-hidden", "false");
    await expect(control.locator(".panel")).toBeVisible();
    const reopenedPanel = await control.locator(".panel").boundingBox();
    expect(reopenedPanel?.width).toBeGreaterThanOrEqual(280);
    await expect
      .poll(() =>
        controlPage.evaluate(async () => {
          const response: unknown = await chrome.runtime.sendMessage({
            type: "FLOATING_POSITION_GET",
          });
          return typeof response === "object" &&
            response !== null &&
            "position" in response &&
            typeof response.position === "object" &&
            response.position !== null &&
            "x" in response.position &&
            typeof response.position.x === "number"
            ? response.position.x
            : null;
        }),
      )
      .toBe(0);
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    const restoredControl = page.locator("norixor-floating-control");
    await expect(restoredControl).toHaveAttribute("data-docked-edge", "left");
    await expect(restoredControl).toHaveAttribute("data-edge-hidden", "true");
    const restoredLauncher = restoredControl.locator(".launcher");
    await restoredLauncher.focus();
    await restoredLauncher.press("ArrowRight");
    await expect(restoredControl).toHaveAttribute("data-edge-hidden", "false");
    await expect(restoredControl).not.toHaveAttribute(
      "data-docked-edge",
      /.+/u,
    );
    await restoredLauncher.press("Shift+ArrowRight");
    await expect
      .poll(() =>
        controlPage.evaluate(async () => {
          const response: unknown = await chrome.runtime.sendMessage({
            type: "FLOATING_POSITION_GET",
          });
          return typeof response === "object" &&
            response !== null &&
            "position" in response &&
            typeof response.position === "object" &&
            response.position !== null &&
            "x" in response.position &&
            typeof response.position.x === "number"
            ? response.position.x
            : null;
        }),
      )
      .toBeGreaterThan(0);
  } finally {
    await controlPage.evaluate(() =>
      chrome.runtime.sendMessage({
        type: "FLOATING_POSITION_SET",
        x: 1,
        y: 1,
      }),
    );
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("reinjects an invalidated content script through the runtime handshake", async () => {
  const pageUrl = "https://www.youtube.com/content-runtime-handshake-e2e";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main><p>Content handshake fixture</p></main>",
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await expect(page.locator("norixor-floating-control")).toHaveCount(1);
    const invalidated = await controlPage.evaluate(async (targetUrl) => {
      const [target] = await chrome.tabs.query({ url: targetUrl });
      if (target?.id === undefined) return false;
      await chrome.scripting.executeScript({
        target: { tabId: target.id },
        world: "ISOLATED",
        func: (runtimeId: string) => {
          document.dispatchEvent(
            new CustomEvent(`${runtimeId}:video:wxt:content-script-started`, {
              detail: {
                contentScriptName: "video",
                messageId: "stale-e2e-script",
              },
            }),
          );
        },
        args: [chrome.runtime.id],
      });
      return true;
    }, pageUrl);
    expect(invalidated).toBe(true);
    await expect(page.locator("norixor-floating-control")).toHaveCount(0);
    await page.evaluate(() => {
      const staleControl = document.createElement("norixor-floating-control");
      staleControl.dataset.norixortransUi = "unified-floating-control";
      const staleOverlay = document.createElement("div");
      staleOverlay.dataset.norixortransUi = "subtitle-overlay";
      staleOverlay.attachShadow({ mode: "open" }).innerHTML =
        '<button class="stop-button">Old cancel</button>';
      const staleVisibility = document.createElement("style");
      staleVisibility.dataset.norixortransUi = "native-subtitle-visibility";
      const preservedTranslation = document.createElement(
        "norixor-translation",
      );
      preservedTranslation.dataset.norixorTranslated = "stale-e2e-copy";
      preservedTranslation.textContent = "Preserved translation";
      document.documentElement.append(
        staleControl,
        staleOverlay,
        staleVisibility,
        preservedTranslation,
      );
    });
    await expect(page.locator("norixor-floating-control")).toHaveCount(1);

    const ensured: unknown = await controlPage.evaluate(async (targetUrl) => {
      const [target] = await chrome.tabs.query({ url: targetUrl });
      if (target?.id === undefined) return { ok: false };
      const response: unknown = await chrome.runtime.sendMessage({
        type: "ENSURE_PAGE_CONTENT",
        tabId: target.id,
      });
      return response;
    }, pageUrl);
    expect(ensured).toMatchObject({ ok: true });

    await expect(page.locator("norixor-floating-control")).toHaveCount(1, {
      timeout: 12_000,
    });
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .stop-button'),
    ).toHaveCount(0);
    await expect(page.locator("norixor-translation")).toContainText(
      "Preserved translation",
    );
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("unified page and selection modes persist independently", async () => {
  const pageUrl = "https://example.com/norixortrans-page-mode-control";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main><p>Page mode control fixture</p></main>",
    }),
  );
  const original = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      !settings ||
      typeof settings !== "object" ||
      !("provider" in settings) ||
      !("page" in settings) ||
      !("subtitles" in settings) ||
      typeof settings.provider !== "object" ||
      settings.provider === null ||
      typeof settings.page !== "object" ||
      settings.page === null ||
      typeof settings.subtitles !== "object" ||
      settings.subtitles === null
    ) {
      throw new Error("Missing settings for page mode test");
    }
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...settings,
        provider: {
          ...settings.provider,
          fastProvider: "chrome-local",
        },
        page: {
          ...settings.page,
          mode: "fast",
          aiResponseMode: "stream",
          selectionTranslationEnabled: true,
          selectionTranslationMode: "fast",
        },
      },
    });
    return settings;
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const control = page.locator("norixor-floating-control");
    await control.locator(".launcher").click();
    const pagePanel = control.locator("#norixortrans-page-panel");
    const sourceLanguage = pagePanel.locator(
      'select:has(option[value="auto"])',
    );
    const targetLanguage = pagePanel.locator(
      'select:not(:has(option[value="auto"])):has(option[value="ja"]):has(option[value="zh-CN"])',
    );
    const pageMode = pagePanel
      .locator(
        'select:has(option[value="fast:chrome-local"]):has(option[value="ai"])',
      )
      .nth(0);
    const selectionMode = pagePanel
      .locator(
        'select:has(option[value="fast:chrome-local"]):has(option[value="ai"])',
      )
      .nth(1);
    const selectionEnabled = pagePanel.locator('input[type="checkbox"]').nth(1);
    const responseMode = pagePanel.locator(
      'select:has(option[value="stream"]):has(option[value="batch"])',
    );
    const displayMode = pagePanel.locator(
      'select:has(option[value="translated"]):has(option[value="bilingual"])',
    );
    await expect(pageMode).toHaveValue("fast:chrome-local");
    await expect(selectionMode).toHaveValue("fast:chrome-local");
    await expect(selectionEnabled).toBeChecked();
    await expect(responseMode).toBeDisabled();
    await sourceLanguage.selectOption("en");
    await targetLanguage.selectOption("ja");
    await displayMode.selectOption("translated");
    await pageMode.selectOption("ai");
    await expect(responseMode).toBeEnabled();
    await responseMode.selectOption("batch");
    await selectionMode.selectOption("ai");
    await selectionEnabled.uncheck();
    await expect
      .poll(() =>
        controlPage.evaluate(async () => {
          const settings: unknown = await chrome.runtime.sendMessage({
            type: "SETTINGS_GET",
          });
          if (
            !settings ||
            typeof settings !== "object" ||
            !("page" in settings) ||
            !("subtitles" in settings) ||
            typeof settings.page !== "object" ||
            settings.page === null ||
            typeof settings.subtitles !== "object" ||
            settings.subtitles === null ||
            !("sourceLanguage" in settings.page) ||
            !("targetLanguage" in settings.page) ||
            !("mode" in settings.page) ||
            !("aiResponseMode" in settings.page) ||
            !("displayMode" in settings.page) ||
            !("selectionTranslationEnabled" in settings.page) ||
            !("selectionTranslationMode" in settings.page) ||
            !("mode" in settings.subtitles)
          ) {
            return null;
          }
          return {
            pageSourceLanguage: settings.page.sourceLanguage,
            pageTargetLanguage: settings.page.targetLanguage,
            pageMode: settings.page.mode,
            pageResponseMode: settings.page.aiResponseMode,
            pageDisplayMode: settings.page.displayMode,
            selectionTranslationEnabled:
              settings.page.selectionTranslationEnabled,
            selectionTranslationMode: settings.page.selectionTranslationMode,
            subtitleMode: settings.subtitles.mode,
          };
        }),
      )
      .toEqual({
        pageSourceLanguage: "en",
        pageTargetLanguage: "ja",
        pageMode: "ai",
        pageResponseMode: "batch",
        pageDisplayMode: "translated",
        selectionTranslationEnabled: false,
        selectionTranslationMode: "ai",
        subtitleMode:
          typeof original.subtitles === "object" &&
          original.subtitles !== null &&
          "mode" in original.subtitles
            ? original.subtitles.mode
            : undefined,
      });
  } finally {
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, original);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("enables global auto-translate without starting every existing background tab", async () => {
  const routePattern = "https://www.youtube.com/auto-scope-*";
  const pageAUrl = "https://www.youtube.com/auto-scope-current";
  const pageBUrl = "https://www.youtube.com/auto-scope-background";
  const pageBNextUrl = "https://www.youtube.com/auto-scope-background-next";
  const currentFrameUrl = "https://auto-frame.example/current";
  await context.route(routePattern, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main><p>${new URL(route.request().url()).pathname}</p>${route.request().url() === pageAUrl ? `<iframe src="${currentFrameUrl}"></iframe>` : ""}</main>`,
    }),
  );
  await context.route(currentFrameUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main><p>Existing auto-translate frame.</p></main>",
    }),
  );
  const previous = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!settings || typeof settings !== "object" || !("page" in settings)) {
      throw new Error("Missing page settings");
    }
    const current = settings as Record<string, unknown> & {
      page: Record<string, unknown>;
    };
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...current,
        page: {
          ...current.page,
          autoTranslate: false,
          mode: "ai",
          displayMode: "bilingual",
        },
      },
    });
    return settings;
  });
  const backgroundPage = await context.newPage();
  const currentPage = await context.newPage();
  try {
    await backgroundPage.goto(pageBUrl);
    await currentPage.goto(pageAUrl);
    await currentPage.bringToFront();
    const control = currentPage.locator("norixor-floating-control");
    await control.locator(".launcher").click();
    await control
      .getByRole("checkbox", { name: /auto translate|自动翻译/iu })
      .check();
    await expect(currentPage.locator("norixor-translation")).toHaveCount(1);
    await expect(
      currentPage
        .frameLocator(`iframe[src="${currentFrameUrl}"]`)
        .locator("norixor-translation"),
    ).toHaveCount(1);
    await backgroundPage.waitForTimeout(600);
    await expect(backgroundPage.locator("norixor-translation")).toHaveCount(0);

    await backgroundPage.goto(pageBNextUrl);
    await expect(backgroundPage.locator("norixor-translation")).toHaveCount(1);

    await currentPage.bringToFront();
    await control
      .getByRole("checkbox", { name: /auto translate|自动翻译/iu })
      .uncheck();
    await backgroundPage.evaluate(() => {
      history.pushState({}, "", "/auto-scope-background-disabled");
      const main = document.querySelector("main");
      if (main) main.innerHTML = "<p>Auto translation is disabled.</p>";
    });
    await backgroundPage.waitForTimeout(900);
    await expect(backgroundPage.locator("norixor-translation")).toHaveCount(0);
    await expect(backgroundPage.locator("main > p")).toHaveText(
      "Auto translation is disabled.",
    );
  } finally {
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, previous);
    await currentPage.close();
    await backgroundPage.close();
    await context.unroute(routePattern);
    await context.unroute(currentFrameUrl);
  }
});

test("mounts the unified translation control on an ordinary HTTPS page", async () => {
  const pageUrl = "https://plain-http.example/norixortrans-e2e";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>HTTPS fixture</title><main><p>Plain HTTPS page.</p></main>",
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const control = page.locator("norixor-floating-control");
    await expect(control).toHaveCount(1);
    await expect(control).toHaveAttribute("data-hidden", "false");
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("restores a control hidden for the current browsing session", async () => {
  const pageUrl = "https://example.com/norixortrans-session-hidden-control";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main><h1>Session hidden control</h1></main>",
    }),
  );
  await controlPage.evaluate(async () => {
    await chrome.runtime.sendMessage({
      type: "FLOATING_BUTTON_SET",
      surface: "all",
      enabled: true,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    let control = page.locator("norixor-floating-control");
    await expect(control).toHaveAttribute("data-hidden", "false");
    await control.locator(".launcher").click();
    await control.locator(".panel-menu > summary").click();
    await control.locator(".panel-menu-popover button:not(.danger)").click();
    await expect(control).toHaveAttribute("data-hidden", "true");

    await page.reload();
    control = page.locator("norixor-floating-control");
    await expect(control).toHaveAttribute("data-hidden", "true");
    await controlPage.locator("#visibility-settings-tab").click();
    await controlPage.locator("#restore-session-floating").click();
    await expect(control).toHaveAttribute("data-hidden", "false");
    await expect(
      controlPage.locator("#restore-session-floating-message"),
    ).toHaveAttribute("data-tone", "success");
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("re-enables a permanently hidden control from Options on an already open page", async () => {
  const pageUrl = "https://example.com/norixortrans-permanently-hidden-control";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main><h1>Permanently hidden control</h1></main>",
    }),
  );
  await controlPage.reload();
  const previousSettings = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!settings || typeof settings !== "object") {
      throw new Error("Missing settings for floating control restore test");
    }
    await chrome.runtime.sendMessage({
      type: "FLOATING_BUTTON_SET",
      surface: "all",
      enabled: true,
    });
    return settings;
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const control = page.locator("norixor-floating-control");
    await expect(control).toHaveAttribute("data-hidden", "false");
    await controlPage.locator("#visibility-settings-tab").click();
    const enabled = controlPage.locator("#floating-control-enabled");
    await expect(enabled).toBeChecked();
    await controlPage.locator('label[for="floating-control-enabled"]').click();
    await expect(enabled).not.toBeChecked();
    await controlPage.locator("#save-settings").click();
    await expect(control).toHaveAttribute("data-hidden", "true");

    await controlPage.locator('label[for="floating-control-enabled"]').click();
    await expect(enabled).toBeChecked();
    await controlPage.locator("#save-settings").click();
    await expect(controlPage.locator("#save-message")).toHaveAttribute(
      "data-tone",
      "success",
    );
    await expect(control).toHaveAttribute("data-hidden", "false");
  } finally {
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, previousSettings);
    await controlPage.reload();
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("requests optional OCR capture permission without enabling it before consent", async () => {
  const pageUrl = "https://www.youtube.com/ocr-permission-e2e";
  const permissionContext = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  await permissionContext.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><video style='width:720px;height:405px'></video>",
    }),
  );
  const permissionExtensionId = await extensionIdFor(permissionContext);
  const permissionControlPage = await permissionContext.newPage();
  await permissionControlPage.goto(
    `chrome-extension://${permissionExtensionId}/options.html`,
  );
  await permissionControlPage.evaluate(async () => {
    await chrome.permissions.remove({ origins: ["<all_urls>"] });
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!settings || typeof settings !== "object" || !("ocr" in settings)) {
      throw new Error("Missing OCR settings");
    }
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: { ...settings, ocr: { enabled: false } },
    });
  });
  const page = await permissionContext.newPage();
  let permissionPage: Page | undefined;
  try {
    await page.goto(pageUrl);
    const control = page.locator("norixor-floating-control");
    await control.locator(".launcher").click();
    await control.locator("#norixortrans-video-panel-tab").click();
    await control.locator(".ocr-section > summary").click();
    const permissionWindow = permissionContext.waitForEvent("page");
    await control.locator('.ocr-section input[type="checkbox"]').check();
    permissionPage = await permissionWindow;
    await permissionPage.waitForLoadState();

    expect(permissionPage.url()).toContain("/ocr-permission.html");
    await expect(permissionPage.locator("#allow")).toBeVisible();
    await expect(permissionPage.locator(".instruction")).toBeVisible();
    await expect(permissionPage.locator(".privacy-note")).toBeVisible();
    await expect(permissionPage.locator(".privacy-note")).toContainText(
      /never sent to an AI provider|绝不会发送给 AI Provider/iu,
    );
    await expect(permissionPage.locator(".privacy-note")).not.toContainText(
      /may (?:be )?sent|可能发送/iu,
    );
    await expect(permissionPage.locator("html")).toHaveAttribute(
      "data-localized",
      "true",
    );
    await expect(
      control.locator('.ocr-section input[type="checkbox"]'),
    ).not.toBeChecked();
    await expect(control.locator(".ocr-section .status-row")).toContainText(
      /permission|权限/iu,
    );
    await expect
      .poll(() =>
        permissionControlPage.evaluate(async () => {
          const stored = await chrome.storage.session.get(
            "ocrPermissionRequestTabId",
          );
          const pending = stored.ocrPermissionRequestTabId;
          if (typeof pending !== "number") return false;
          try {
            const response: unknown = await chrome.tabs.sendMessage(
              pending,
              { type: "OCR_STATUS" },
              { frameId: 0 },
            );
            return (
              typeof response === "object" &&
              response !== null &&
              "state" in response
            );
          } catch {
            return false;
          }
        }),
      )
      .toBe(true);
    await permissionPage.locator("#cancel").click();
    await expect(
      control.locator('.ocr-section input[type="checkbox"]'),
    ).not.toBeChecked();
    await expect.poll(() => permissionPage?.isClosed()).toBe(true);
    await expect
      .poll(() =>
        permissionControlPage.evaluate(async () => {
          const stored = await chrome.storage.session.get(
            "ocrPermissionRequestTabId",
          );
          return stored.ocrPermissionRequestTabId;
        }),
      )
      .toBeUndefined();
  } finally {
    if (permissionPage && !permissionPage.isClosed())
      await permissionPage.close();
    await page.close();
    await permissionContext.unroute(pageUrl);
    await permissionContext.close();
  }
});

test("advanced subtitle picking releases the page after selecting a DOM region", async () => {
  const pageUrl = "https://video.example.com/profile-wizard-e2e.html";
  const profileHostname = "video.example.com";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <style>
          video { display:block; width:720px; height:405px; background:#18202b }
          [data-test-caption] { position:absolute; left:180px; top:330px; width:520px; height:48px; color:white }
          norixor-subtitle-profile-wizard { position:static !important; z-index:-1 !important; pointer-events:none !important }
        </style>
        <video></video>
        <div data-test-caption>Visible subtitle candidate</div>
        <button id="page-button" onclick="window.__pageClicks=(window.__pageClicks||0)+1">Page action</button>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const control = page.locator("norixor-floating-control");
    await control.locator(".launcher").click();
    await control.locator("#norixortrans-video-panel-tab").click();
    await control
      .locator("#norixortrans-video-panel > button.profile-action")
      .click();

    const wizard = page.locator("norixor-subtitle-profile-wizard");
    await expect(wizard).toBeVisible();
    await expect
      .poll(() =>
        wizard.evaluate((host) => ({
          position: getComputedStyle(host).position,
          zIndex: getComputedStyle(host).zIndex,
          pointerEvents: getComputedStyle(host).pointerEvents,
        })),
      )
      .toEqual({
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "auto",
      });
    await wizard.locator("button.advanced").click();
    await page.locator("[data-test-caption]").click();
    await expect(wizard.locator('input[type="radio"]:checked')).toHaveValue(
      /nth-of-type/iu,
    );
    await wizard.locator("button.primary").click();
    await expect(wizard.locator(".status")).toContainText(/saved|已保存/iu);
    await expect
      .poll(() =>
        controlPage.evaluate(async (hostname) => {
          const response: unknown = await chrome.runtime.sendMessage({
            type: "SITE_PROFILES_GET",
          });
          if (
            !response ||
            typeof response !== "object" ||
            !("profiles" in response) ||
            !Array.isArray(response.profiles)
          ) {
            return false;
          }
          return (response.profiles as unknown[]).some((profile: unknown) => {
            if (
              !profile ||
              typeof profile !== "object" ||
              !("match" in profile)
            ) {
              return false;
            }
            const match: unknown = profile.match;
            return Boolean(
              match &&
              typeof match === "object" &&
              "hostnameSuffixes" in match &&
              Array.isArray(match.hostnameSuffixes) &&
              (match.hostnameSuffixes as unknown[]).includes(hostname),
            );
          });
        }, profileHostname),
      )
      .toBe(true);

    await page.locator("#page-button").click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const value: unknown = Reflect.get(window, "__pageClicks");
          return typeof value === "number" ? value : 0;
        }),
      )
      .toBe(1);
    await wizard.locator("button.close").click();
    await expect(wizard).toHaveCount(0);
    await expect(control.locator(".launcher")).toBeFocused();
  } finally {
    await controlPage.evaluate(async (hostname) => {
      const response: unknown = await chrome.runtime.sendMessage({
        type: "SITE_PROFILES_GET",
      });
      if (
        !response ||
        typeof response !== "object" ||
        !("profiles" in response) ||
        !Array.isArray(response.profiles)
      ) {
        return;
      }
      for (const profile of response.profiles as unknown[]) {
        if (
          profile &&
          typeof profile === "object" &&
          "id" in profile &&
          typeof profile.id === "string" &&
          "match" in profile
        ) {
          const match: unknown = profile.match;
          if (
            !match ||
            typeof match !== "object" ||
            !("hostnameSuffixes" in match) ||
            !Array.isArray(match.hostnameSuffixes) ||
            !(match.hostnameSuffixes as unknown[]).includes(hostname)
          ) {
            continue;
          }
          await chrome.runtime.sendMessage({
            type: "SITE_PROFILE_DELETE",
            id: profile.id,
          });
        }
      }
    }, profileHostname);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("Tencent remains OCR-only and ignores page DOM caption candidates", async () => {
  const pageUrl = "https://v.qq.com/x/cover/tencent-caption-filter-e2e.html";
  const previous = await updateSubtitlePreferences({
    enabled: true,
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    mode: "ai",
    displayMode: "bilingual",
    hideNativeSubtitles: false,
  });
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <style>
          html { scrollbar-gutter: stable; }
          body { min-height: 1200px; }
          #player { position:relative; width:960px; height:540px; background:#111 }
          video { display:block; width:960px; height:540px }
          .txp_subtitle_line { position:absolute; left:220px; bottom:48px; width:520px; height:42px; color:white }
          .txp_subtitle_settings_panel { position:absolute; inset:0; color:white }
        </style>
        <div id="player">
          <video></video>
          <div class="txp_subtitle_line">Real Tencent caption</div>
          <div class="txp_subtitle_settings_panel" role="dialog">
            <button>Language</button>
            Subtitle settings restore defaults language Chinese no subtitles position font size
          </div>
        </div>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const overlay = page.locator('[data-norixortrans-ui="subtitle-overlay"]');
    await expect(overlay.locator(".cue-card")).toBeHidden();

    const control = page.locator("norixor-floating-control");
    await page.evaluate(() => {
      const clientWidth = window.innerWidth - 8;
      Object.defineProperty(document.documentElement, "clientWidth", {
        configurable: true,
        value: clientWidth,
      });
      window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(50);
    const edgeVisibility = await control.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const clientWidth = document.documentElement.clientWidth;
      return {
        scrollbarWidth: window.innerWidth - clientWidth,
        visibleWidth: Math.max(
          0,
          Math.min(rect.right, clientWidth) - Math.max(rect.left, 0),
        ),
      };
    });
    expect(edgeVisibility.scrollbarWidth).toBe(8);
    expect(edgeVisibility.visibleWidth).toBeGreaterThanOrEqual(12);
    await control.locator(".launcher").click();
    await control.locator("#norixortrans-video-panel-tab").click();
    await page.locator(".txp_subtitle_line").evaluate((element) => {
      element.textContent = "Caption after stop";
    });
    await control.locator(".subtitle-actions .primary").click();
    await page.waitForTimeout(300);
    await expect(overlay.locator(".cue-card")).toBeHidden();
  } finally {
    await updateSubtitlePreferences(previous);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("translates, follows dynamic and SPA content, and restores in a real content script", async () => {
  const pageUrl = "https://www.youtube.com/page-translation-e2e";
  dynamicDuplicateProviderTexts.length = 0;
  const previousSettings = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      !settings ||
      typeof settings !== "object" ||
      !("page" in settings) ||
      typeof settings.page !== "object" ||
      settings.page === null
    ) {
      throw new Error("Missing page settings for dynamic translation test");
    }
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...settings,
        page: {
          ...settings.page,
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "fast",
          aiResponseMode: "stream",
          displayMode: "bilingual",
          autoTranslate: false,
        },
      },
    });
    return settings;
  });
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Page fixture</title><style>.hover-copy{display:none}#hover-trigger:hover + #hover-detail,#hover-trigger:focus + #hover-detail{display:block}</style><main><p id="static">Hello page.</p><p id="cache-source">CACHE_DUPLICATE_E2E</p><p class="subtitle">Product subtitle.</p><button id="action">Start action</button><button id="add-detail">Show click detail</button><button id="hover-trigger">Show hover detail</button><p id="hover-detail" class="hover-copy">Hover-created detail.</p><nav>Browse docs</nav><div id="controls"><button id="save-action">Save draft</button><button id="cancel-action">Cancel editing</button><a id="docs-link" href="/docs">Documentation</a></div><div class="ytp-caption-segment">Native video caption</div><article id="shadow-host"></article></main><script>document.querySelector("#add-detail").addEventListener("click",()=>{const p=document.createElement("p");p.id="click-detail";p.textContent="Click-created detail.";document.querySelector("main").append(p)});const root=document.querySelector("#shadow-host").attachShadow({mode:"open"});root.innerHTML="<p>Shadow content.</p>";root.append(document.createTextNode("Direct shadow text."))</script>',
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await sendContentCommand(pageUrl, "PAGE_TRANSLATE");

    const pageWidget = page.locator("norixor-floating-control");
    await expect(pageWidget).toHaveAttribute("data-hidden", "false");
    await expect(pageWidget.locator(".panel")).toBeHidden();
    await pageWidget.locator(".launcher").click();
    await expect(pageWidget.locator(".panel")).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll("norixor-translation")].map(
            (host) => host.shadowRoot?.querySelector("span")?.textContent,
          ),
        ),
      )
      .toContain("已译 Hello page.");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const documentTranslations = [
            ...document.querySelectorAll("norixor-translation"),
          ].map((host) => host.shadowRoot?.querySelector("span")?.textContent);
          const shadowTranslations = [
            ...(document
              .querySelector("#shadow-host")
              ?.shadowRoot?.querySelectorAll("norixor-translation") ?? []),
          ].map((host) => host.shadowRoot?.querySelector("span")?.textContent);
          return [...documentTranslations, ...shadowTranslations];
        }),
      )
      .toEqual(
        expect.arrayContaining([
          "已译 Start action",
          "已译 Browse docs",
          "已译 Product subtitle.",
          "已译 Shadow content.",
          "已译 Direct shadow text.",
          "已译 Save draft",
          "已译 Cancel editing",
          "已译 Documentation",
        ]),
      );
    await expect(page.locator("#controls > button")).toHaveCount(2);
    await expect
      .poll(() =>
        page.locator("#save-action").evaluate((element) => {
          const firstChild = element.firstChild;
          return firstChild instanceof Text ? firstChild.textContent : null;
        }),
      )
      .toBe("Save draft");
    await expect
      .poll(() =>
        page.locator("#cancel-action").evaluate((element) => {
          const firstChild = element.firstChild;
          return firstChild instanceof Text ? firstChild.textContent : null;
        }),
      )
      .toBe("Cancel editing");
    await expect(page.locator("#docs-link")).toHaveAttribute("href", "/docs");
    await expect(
      page.locator("#save-action > norixor-translation"),
    ).toHaveAttribute("data-compact-interactive", "");
    await expect(
      page.locator("#docs-link > norixor-translation"),
    ).toHaveAttribute("data-compact-interactive", "");
    await expect(
      page.locator("#save-action + norixor-translation"),
    ).toHaveCount(0);
    await expect(page.locator("#docs-link + norixor-translation")).toHaveCount(
      0,
    );
    await expect(page.locator(".ytp-caption-segment")).toHaveText(
      "Native video caption",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector("#cache-source + norixor-translation")
              ?.shadowRoot?.querySelector("span")?.textContent,
        ),
      )
      .toBe("已译 CACHE_DUPLICATE_E2E");

    await page.locator("main").evaluate((main) => {
      const paragraph = document.createElement("p");
      paragraph.id = "cache-duplicate";
      paragraph.textContent = "  CACHE_DUPLICATE_E2E  ";
      main.append(paragraph);
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector("#cache-duplicate + norixor-translation")
              ?.shadowRoot?.querySelector("span")?.textContent,
        ),
      )
      .toBe("已译 CACHE_DUPLICATE_E2E");
    expect(dynamicDuplicateProviderTexts).toHaveLength(1);

    await page.locator("main").evaluate((main) => {
      const paragraph = document.createElement("p");
      paragraph.id = "dynamic";
      paragraph.textContent = "Dynamic page content.";
      main.append(paragraph);
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll("norixor-translation")].map(
            (host) => host.shadowRoot?.querySelector("span")?.textContent,
          ),
        ),
      )
      .toContain("已译 Dynamic page content.");

    await page.locator("#add-detail").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector("#click-detail + norixor-translation")
              ?.shadowRoot?.querySelector("span")?.textContent,
        ),
      )
      .toBe("已译 Click-created detail.");

    await page.locator("#hover-trigger").hover();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector("#hover-detail + norixor-translation")
              ?.shadowRoot?.querySelector("span")?.textContent,
        ),
      )
      .toBe("已译 Hover-created detail.");

    await page.evaluate(() => {
      history.pushState({}, "", "/e2e-page/next");
      const main = document.querySelector("main");
      if (main) main.innerHTML = '<p id="spa">SPA destination.</p>';
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll("norixor-translation")].map(
            (host) => host.shadowRoot?.querySelector("span")?.textContent,
          ),
        ),
      )
      .toEqual(["已译 SPA destination."]);

    await page.evaluate(() => {
      location.hash = "/hash-destination";
      const main = document.querySelector("main");
      if (main) main.innerHTML = '<p id="hash-spa">Hash SPA destination.</p>';
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll("norixor-translation")].map(
            (host) => host.shadowRoot?.querySelector("span")?.textContent,
          ),
        ),
      )
      .toEqual(["已译 Hash SPA destination."]);

    await page.evaluate(() => {
      location.hash = "account-route";
      const main = document.querySelector("main");
      if (main) {
        main.innerHTML =
          '<p id="ordinary-hash-spa">Ordinary hash SPA destination.</p>';
      }
    });
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll("norixor-translation")].map(
            (host) => host.shadowRoot?.querySelector("span")?.textContent,
          ),
        ),
      )
      .toEqual(["已译 Ordinary hash SPA destination."]);

    await controlPage.evaluate(async () => {
      const stored: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (
        typeof stored !== "object" ||
        stored === null ||
        !("page" in stored) ||
        typeof stored.page !== "object" ||
        stored.page === null
      ) {
        throw new Error("Missing page settings");
      }
      const settings = stored as {
        page: Record<string, unknown>;
        provider: Record<string, unknown>;
        subtitles: Record<string, unknown>;
      };
      settings.page = { ...settings.page, displayMode: "translated" };
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    });
    await expect(page.locator("#ordinary-hash-spa")).toHaveText(
      "已译 Ordinary hash SPA destination.",
    );
    await expect(page.locator("norixor-translation")).toHaveCount(0);
    await sendContentCommand(page.url(), "PAGE_RESTORE");
    await expect(page.locator("#ordinary-hash-spa")).toHaveText(
      "Ordinary hash SPA destination.",
    );
  } finally {
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, previousSettings);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("translates across an inline link without replacing its DOM or click behavior", async () => {
  const pageUrl = "https://www.youtube.com/inline-link-translation-e2e";
  protectedPageRequests.length = 0;
  const previousSettings = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      !settings ||
      typeof settings !== "object" ||
      !("page" in settings) ||
      typeof settings.page !== "object" ||
      settings.page === null
    ) {
      throw new Error("Missing page settings for protected link test");
    }
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...settings,
        page: {
          ...settings.page,
          sourceLanguage: "en",
          targetLanguage: "zh-CN",
          mode: "ai",
          aiResponseMode: "stream",
          displayMode: "translated",
          autoTranslate: false,
        },
      },
    });
    return settings;
  });
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <main><p id="sentence">Read <a id="inline-link" href="/docs">documentation</a> now.</p></main>
        <script>
          window.__inlineLinkClicks = 0;
          const link = document.querySelector("#inline-link");
          link.__norixorIdentity = "preserved";
          link.addEventListener("click", (event) => {
            event.preventDefault();
            window.__inlineLinkClicks += 1;
          });
        </script>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await sendContentCommand(pageUrl, "PAGE_TRANSLATE");

    await expect(page.locator("#sentence")).toHaveText(
      "已译 Read documentation now.",
    );
    await expect(page.locator("#inline-link")).toHaveAttribute("href", "/docs");
    await expect
      .poll(() =>
        page
          .locator("#inline-link")
          .evaluate(
            (element) => Reflect.get(element, "__norixorIdentity") as unknown,
          ),
      )
      .toBe("preserved");
    await page.locator("#inline-link").click();
    await expect
      .poll(() =>
        page.evaluate(
          () => Reflect.get(window, "__inlineLinkClicks") as unknown,
        ),
      )
      .toBe(1);
    expect(protectedPageRequests).toHaveLength(1);
    expect(protectedPageRequests[0]?.format).toBe("protected-text-v1");

    await sendContentCommand(pageUrl, "PAGE_RESTORE");
    await expect(page.locator("#sentence")).toHaveText(
      "Read documentation now.",
    );
    await expect(page.locator("#inline-link")).toHaveText("documentation");
  } finally {
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, previousSettings);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("translates cross-origin iframe text and TextTrack with one top-level control", async () => {
  const pageUrl = "https://www.youtube.com/iframe-translation-e2e";
  const frameUrl = "https://frame.example.test/embedded-translation";
  const secondFrameUrl =
    "https://second-frame.example.test/embedded-translation";
  const trackUrl = "https://frame.example.test/embedded-track.vtt";
  const secondTrackUrl = "https://second-frame.example.test/embedded-track.vtt";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main><p>Top frame copy.</p><iframe id="embedded" src="${frameUrl}"></iframe><iframe id="secondary" src="${secondFrameUrl}"></iframe></main>`,
    }),
  );
  await context.route(frameUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main><p>Embedded frame copy.</p><video style="width:640px;height:360px"><track kind="subtitles" srclang="en" default src="${trackUrl}"></video></main>`,
    }),
  );
  await context.route(trackUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nEmbedded subtitle.\n",
    }),
  );
  await context.route(secondFrameUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main><p>Second embedded frame copy.</p><video style="width:640px;height:360px"><track kind="subtitles" srclang="en" default src="${secondTrackUrl}"></video></main>`,
    }),
  );
  await context.route(secondTrackUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nSecond embedded subtitle.\n",
    }),
  );
  const previousSettings = await controlPage.evaluate(async () => {
    const stored: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!stored || typeof stored !== "object" || !("page" in stored)) {
      throw new Error("Missing iframe E2E settings");
    }
    const current = stored as Record<string, unknown> & {
      page: Record<string, unknown>;
      subtitles: Record<string, unknown>;
    };
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...current,
        page: {
          ...current.page,
          autoTranslate: false,
          mode: "ai",
          displayMode: "bilingual",
        },
        subtitles: {
          ...current.subtitles,
          enabled: true,
          sourceLanguage: "auto",
          targetLanguage: "zh-CN",
          mode: "ai",
          displayMode: "bilingual",
        },
      },
    });
    return stored;
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const embedded = page.frameLocator("#embedded");
    const secondEmbedded = page.frameLocator("#secondary");
    await expect(page.locator("norixor-floating-control")).toHaveCount(1);
    await expect(embedded.locator("norixor-floating-control")).toHaveCount(0);
    await expect(
      secondEmbedded.locator("norixor-floating-control"),
    ).toHaveCount(0);

    await sendContentCommand(pageUrl, "PAGE_TRANSLATE");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector("norixor-translation")
            ?.shadowRoot?.querySelector("span")
            ?.textContent?.trim(),
        ),
      )
      .toBe("已译 Top frame copy.");
    await expect
      .poll(() =>
        embedded.locator("norixor-translation span").first().textContent(),
      )
      .toBe("已译 Embedded frame copy.");
    await expect
      .poll(() =>
        secondEmbedded
          .locator("norixor-translation span")
          .first()
          .textContent(),
      )
      .toBe("已译 Second embedded frame copy.");
    await expect
      .poll(() => pageStatus(pageUrl))
      .toMatchObject({
        state: "translated",
        total: 3,
        completed: 3,
        failed: 0,
      });

    await expect
      .poll(() => subtitleStatus(pageUrl))
      .toMatchObject({
        state: "ready",
        source: "texttrack",
        completeness: "full",
        total: 2,
        completed: 2,
        failed: 0,
      });
    await expect(
      embedded.locator(
        '[data-norixortrans-ui="subtitle-overlay"] .cue.translated',
      ),
    ).toContainText("已译 Embedded subtitle.");
    await expect(
      secondEmbedded.locator(
        '[data-norixortrans-ui="subtitle-overlay"] .cue.translated',
      ),
    ).toContainText("已译 Second embedded subtitle.");

    await controlPage.evaluate(async () => {
      const stored: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (
        !stored ||
        typeof stored !== "object" ||
        !("page" in stored) ||
        !("subtitles" in stored)
      ) {
        throw new Error("Missing iframe runtime settings");
      }
      const current = stored as Record<string, unknown> & {
        page: Record<string, unknown>;
        subtitles: Record<string, unknown>;
      };
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: {
          ...current,
          page: { ...current.page, displayMode: "translated" },
          subtitles: {
            ...current.subtitles,
            displayMode: "translated",
          },
        },
      });
    });
    await expect(page.locator("main > p")).toHaveText("已译 Top frame copy.");
    await expect(embedded.locator("main > p")).toHaveText(
      "已译 Embedded frame copy.",
    );
    await expect(secondEmbedded.locator("main > p")).toHaveText(
      "已译 Second embedded frame copy.",
    );
    await expect(
      embedded.locator(
        '[data-norixortrans-ui="subtitle-overlay"] .cue.original',
      ),
    ).toBeHidden();
    await expect(
      embedded.locator(
        '[data-norixortrans-ui="subtitle-overlay"] .cue.translated',
      ),
    ).toBeVisible();

    const floatingControl = page.locator("norixor-floating-control");
    await floatingControl.locator(".launcher").click();
    await floatingControl.locator("#norixortrans-video-panel-tab").click();
    await floatingControl
      .locator(".subtitle-actions button:not(.primary)")
      .click();
    await expect
      .poll(() => subtitleStatus(pageUrl))
      .toMatchObject({
        state: "cancelled",
        total: 2,
      });
    await expect(
      embedded.locator('[data-norixortrans-ui="subtitle-overlay"] .cue-card'),
    ).toBeHidden();
    await expect(
      secondEmbedded.locator(
        '[data-norixortrans-ui="subtitle-overlay"] .cue-card',
      ),
    ).toBeHidden();
    await floatingControl.locator(".subtitle-actions .primary").click();
    await expect
      .poll(() => subtitleStatus(pageUrl))
      .toMatchObject({
        state: "ready",
        total: 2,
        completed: 2,
        failed: 0,
      });
    await expect(
      embedded.locator(
        '[data-norixortrans-ui="subtitle-overlay"] .cue.translated',
      ),
    ).toBeVisible();

    await page.locator("#embedded").evaluate((frame) => frame.remove());
    await expect
      .poll(() => pageStatus(pageUrl), { timeout: 1_500 })
      .toMatchObject({
        state: "translated",
        total: 2,
        completed: 2,
        failed: 0,
      });
    await expect
      .poll(() => subtitleStatus(pageUrl), { timeout: 1_500 })
      .toMatchObject({
        state: "ready",
        source: "texttrack",
        completeness: "full",
        total: 1,
        completed: 1,
        failed: 0,
      });
    await expect(secondEmbedded.locator("main > p")).toHaveText(
      "已译 Second embedded frame copy.",
    );
    await expect(
      secondEmbedded.locator(
        '[data-norixortrans-ui="subtitle-overlay"] .cue.translated',
      ),
    ).toContainText("已译 Second embedded subtitle.");
  } finally {
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, previousSettings);
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(frameUrl);
    await context.unroute(trackUrl);
    await context.unroute(secondFrameUrl);
    await context.unroute(secondTrackUrl);
  }
});

test("renders a large AI page progressively instead of waiting for every batch", async () => {
  const pageUrl = "https://www.youtube.com/page-ai-progressive";
  const paragraphCount = 82;
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>${Array.from(
        { length: paragraphCount },
        (_, index) => `<p>AI_PROGRESSIVE paragraph ${index + 1}.</p>`,
      ).join("")}</main>`,
    }),
  );
  const previousSettings = await controlPage.evaluate(async () => {
    const isObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null;
    const stored: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      !isObject(stored) ||
      !isObject(stored.page) ||
      !isObject(stored.provider)
    ) {
      throw new Error("Missing page settings");
    }
    const previous = { ...stored.page };
    const response: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...stored,
        page: {
          ...stored.page,
          mode: "ai",
          displayMode: "bilingual",
        },
      },
    });
    if (!isObject(response) || response.ok !== true) {
      throw new Error("Could not enable page AI mode");
    }
    return previous;
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await beginPageTranslation(pageUrl);
    await expect
      .poll(async () => {
        const status = await pageStatus(pageUrl);
        return (
          status && status.completed > 0 && status.completed < status.total
        );
      })
      .toBe(true);
    await expect
      .poll(async () => await pageStatus(pageUrl), { timeout: 30_000 })
      .toMatchObject({
        state: "translated",
        total: paragraphCount,
        completed: paragraphCount,
        failed: 0,
      });
    await expect(page.locator("norixor-translation")).toHaveCount(
      paragraphCount,
    );
  } finally {
    await controlPage.evaluate(async (previous) => {
      const isObject = (value: unknown): value is Record<string, unknown> =>
        typeof value === "object" && value !== null;
      const stored: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (!isObject(stored)) throw new Error("Missing settings");
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: { ...stored, page: previous },
      });
    }, previousSettings);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("retries an empty AI stream once without streaming and applies the result", async () => {
  const pageUrl = "https://www.youtube.com/page-empty-stream-fallback";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main><p>EMPTY_STREAM_FALLBACK content.</p></main>",
    }),
  );
  const previousPageSettings = await controlPage.evaluate(async () => {
    const stored: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      !stored ||
      typeof stored !== "object" ||
      !("page" in stored) ||
      !stored.page ||
      typeof stored.page !== "object" ||
      !("provider" in stored) ||
      !stored.provider ||
      typeof stored.provider !== "object"
    ) {
      throw new Error("Missing page settings");
    }
    const previous = {
      page: { ...stored.page },
      provider: { ...stored.provider },
    };
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...stored,
        provider: {
          ...stored.provider,
          model: "e2e-empty-stream-fallback-model",
        },
        page: {
          ...stored.page,
          mode: "ai",
          aiResponseMode: "stream",
          displayMode: "translated",
        },
      },
    });
    return previous;
  });
  const page = await context.newPage();
  emptyStreamFallbackModes.length = 0;
  try {
    await page.goto(pageUrl);
    await beginPageTranslation(pageUrl);
    await expect
      .poll(() => pageStatus(pageUrl))
      .toMatchObject({
        state: "translated",
        total: 1,
        completed: 1,
        failed: 0,
      });
    await expect(page.locator("main > p")).toHaveText(
      "已译 EMPTY_STREAM_FALLBACK content.",
    );
    expect(emptyStreamFallbackModes).toEqual([true, false]);
  } finally {
    await controlPage.evaluate(async (previous) => {
      const stored: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (!stored || typeof stored !== "object") return;
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: {
          ...stored,
          page: previous.page,
          provider: previous.provider,
        },
      });
    }, previousPageSettings);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("recovers only missing IDs from a partial AI JSON batch", async () => {
  const pageUrl = "https://www.youtube.com/page-ai-partial-json";
  const paragraphCount = 12;
  partialJsonRequestSegmentCounts.length = 0;
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>${Array.from(
        { length: paragraphCount },
        (_, index) => `<p>PARTIAL_JSON paragraph ${index + 1}.</p>`,
      ).join("")}</main>`,
    }),
  );
  const previousPageSettings = await controlPage.evaluate(async () => {
    const stored: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!stored || typeof stored !== "object" || !("page" in stored)) {
      throw new Error("Missing page settings");
    }
    const current = stored as Record<string, unknown> & {
      page: Record<string, unknown>;
    };
    const previous = { ...current.page };
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...current,
        page: { ...current.page, mode: "ai", displayMode: "translated" },
      },
    });
    return previous;
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await beginPageTranslation(pageUrl);
    await expect
      .poll(async () => pageStatus(pageUrl))
      .toMatchObject({
        state: "translated",
        total: paragraphCount,
        completed: paragraphCount,
        failed: 0,
      });
    const paragraphs = page.locator("body > main > p");
    await expect(paragraphs).toHaveCount(paragraphCount);
    await expect(paragraphs.last()).toHaveText(
      `已译 PARTIAL_JSON paragraph ${paragraphCount}.`,
    );
    expect(partialJsonRequestSegmentCounts.some((count) => count > 1)).toBe(
      true,
    );
    expect(partialJsonRequestSegmentCounts).toContain(1);
  } finally {
    await controlPage.evaluate(async (previous) => {
      const stored: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (!stored || typeof stored !== "object") return;
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: { ...stored, page: previous },
      });
    }, previousPageSettings);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("shows a safe clickable diagnostic for an invalid Provider response", async () => {
  const pageUrl = "https://www.youtube.com/page-invalid-response-details";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main><p>INVALID_RESPONSE_DETAILS fixture.</p></main>",
    }),
  );
  const previousPageSettings = await controlPage.evaluate(async () => {
    const stored: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!stored || typeof stored !== "object" || !("page" in stored)) {
      throw new Error("Missing page settings");
    }
    const current = stored as Record<string, unknown> & {
      page: Record<string, unknown>;
    };
    const previous = { ...current.page };
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...current,
        page: {
          ...current.page,
          mode: "ai",
          aiResponseMode: "batch",
          displayMode: "translated",
        },
      },
    });
    return previous;
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await beginPageTranslation(pageUrl);
    await expect
      .poll(async () => pageStatus(pageUrl))
      .toMatchObject({
        state: "error",
        completed: 0,
        failed: 1,
        details: expect.stringContaining(
          "Unknown compact result ID: unexpected-id",
        ),
      });

    const control = page.locator("norixor-floating-control");
    await control.locator(".launcher").click();
    const diagnostic = control.locator("#norixortrans-page-panel .diagnostic");
    await expect(diagnostic).toBeVisible();
    await diagnostic.locator("summary").click();
    await expect(diagnostic.locator("pre")).toContainText(
      "Unknown compact result ID: unexpected-id",
    );
    const diagnosticText = await diagnostic.locator("pre").textContent();
    expect(diagnosticText).not.toContain("INVALID_RESPONSE_DETAILS");
    expect(diagnosticText).not.toContain("e2e-only-key");
    expect(
      await diagnostic
        .locator("summary")
        .evaluate((summary) =>
          getComputedStyle(summary, "::before").content.replaceAll('"', ""),
        ),
    ).toBe("!");
    await page.keyboard.press("Escape");
    await expect(diagnostic).not.toHaveAttribute("open", "");
    await expect(control.locator(".panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(control.locator(".panel")).toBeHidden();
    await expect(page.locator("norixor-translation")).toHaveCount(0);
  } finally {
    await controlPage.evaluate(async (previous) => {
      const stored: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (!stored || typeof stored !== "object") return;
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: { ...stored, page: previous },
      });
    }, previousPageSettings);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("keeps partial stream progress and recovers only its missing IDs", async () => {
  const pageUrl = "https://www.youtube.com/page-partial-stream-details";
  partialStreamRequestSegmentCounts.length = 0;
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><main><p>PARTIAL_STREAM_DETAILS first.</p><p>PARTIAL_STREAM_DETAILS second.</p></main>",
    }),
  );
  const previousSettings = await controlPage.evaluate(async () => {
    const stored: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!stored || typeof stored !== "object" || !("page" in stored)) {
      throw new Error("Missing page settings");
    }
    const current = stored as Record<string, unknown> & {
      page: Record<string, unknown>;
      provider: Record<string, unknown>;
    };
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...current,
        provider: {
          ...current.provider,
          model: "e2e-partial-stream-model",
        },
        page: {
          ...current.page,
          mode: "ai",
          aiResponseMode: "stream",
          displayMode: "translated",
        },
      },
    });
    return current;
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await beginPageTranslation(pageUrl);
    await expect(page.getByText("第一条已译", { exact: true })).toBeVisible();
    await expect
      .poll(async () => pageStatus(pageUrl))
      .toMatchObject({
        state: "translated",
        completed: 2,
        failed: 0,
      });

    const control = page.locator("norixor-floating-control");
    await control.locator(".launcher").click();
    const diagnostic = control.locator("#norixortrans-page-panel .diagnostic");
    await expect(diagnostic).toBeHidden();
    await expect(
      page.getByText("已译 PARTIAL_STREAM_DETAILS second.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(partialStreamRequestSegmentCounts).toEqual([2, 1]);
  } finally {
    await controlPage.evaluate(async (previous) => {
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: previous,
      });
    }, previousSettings);
    await page.close();
    await context.unroute(pageUrl);
  }
});

for (const failure of [
  { marker: "RATE_LIMIT", label: "rate limit" },
  { marker: "SERVER_ERROR", label: "server failure" },
] as const) {
  test(`reports a page translation error after a provider ${failure.label}`, async () => {
    const pageUrl = `https://www.youtube.com/page-${failure.marker.toLowerCase()}`;
    await context.route(pageUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><main><p>${failure.marker} fixture.</p></main>`,
      }),
    );
    const page = await context.newPage();
    try {
      await page.goto(pageUrl);
      await sendContentCommand(pageUrl, "PAGE_TRANSLATE");
      await expect
        .poll(async () => await pageStatus(pageUrl))
        .toMatchObject({ state: "error", completed: 0, failed: 1 });
      await expect(page.locator("norixor-translation")).toHaveCount(0);
    } finally {
      await page.close();
      await context.unroute(pageUrl);
    }
  });
}

test("cancels a slow page translation without applying the late response", async () => {
  const pageUrl = "https://www.youtube.com/page-cancel";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><main><p id="source">SLOW_TRANSLATION fixture.</p></main>',
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await beginPageTranslation(pageUrl);
    await expect
      .poll(async () => (await pageStatus(pageUrl))?.state)
      .toBe("translating");
    await sendContentCommand(pageUrl, "PAGE_RESTORE");
    await page.waitForTimeout(1_700);

    await expect(page.locator("#source")).toHaveText(
      "SLOW_TRANSLATION fixture.",
    );
    await expect(page.locator("norixor-translation")).toHaveCount(0);
    expect(await pageStatus(pageUrl)).toMatchObject({
      state: "idle",
      completed: 0,
    });
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("cache clearing cancels active page workers before emptying background storage", async () => {
  const pageUrl = "https://www.youtube.com/page-cache-clear-active";
  const previousPage = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      !settings ||
      typeof settings !== "object" ||
      !("page" in settings) ||
      typeof settings.page !== "object" ||
      settings.page === null
    ) {
      throw new Error("Missing page settings");
    }
    const page = { ...settings.page };
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...settings,
        page: { ...settings.page, mode: "ai", displayMode: "translated" },
      },
    });
    return page;
  });
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>${Array.from(
        { length: 18 },
        (_, index) => `<p>SLOW_TRANSLATION cache fixture ${index + 1}.</p>`,
      ).join("")}</main>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await beginPageTranslation(pageUrl);
    await expect
      .poll(async () => (await pageStatus(pageUrl))?.state)
      .toBe("translating");
    const cleared: unknown = await controlPage.evaluate(async () => {
      const result: unknown = await chrome.runtime.sendMessage({
        type: "CACHE_CLEAR",
      });
      return result;
    });
    expect(cleared).toEqual({ ok: true });
    await page.waitForTimeout(1_700);

    await expect(page.locator("norixor-translation")).toHaveCount(0);
    await expect(page.locator("main > p").first()).toHaveText(
      "SLOW_TRANSLATION cache fixture 1.",
    );
    expect(await pageStatus(pageUrl)).toMatchObject({
      state: "error",
      completed: 0,
      failed: 18,
    });
    const stats: unknown = await controlPage.evaluate(async () => {
      const value: unknown = await chrome.runtime.sendMessage({
        type: "CACHE_STATS",
      });
      return value;
    });
    expect(stats).toEqual({ translations: 0, subtitleTracks: 0, jobs: 0 });

    await page.locator("main").evaluate((main) => {
      const paragraph = document.createElement("p");
      paragraph.id = "after-active-cache-clear";
      paragraph.textContent = "Fresh content after active cache clear.";
      main.append(paragraph);
    });
    await expect(page.locator("#after-active-cache-clear")).toHaveText(
      "已译 Fresh content after active cache clear.",
    );
  } finally {
    await controlPage.evaluate(async (pageSettings) => {
      const settings: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (!settings || typeof settings !== "object") return;
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: { ...settings, page: pageSettings },
      });
    }, previousPage);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("rejects stale translation and subtitle-track writes after cache clearing", async () => {
  const result = await controlPage.evaluate(async () => {
    const key = "b".repeat(64);
    const epochResponse: unknown = await chrome.runtime.sendMessage({
      type: "CACHE_EPOCH_GET",
    });
    if (
      !epochResponse ||
      typeof epochResponse !== "object" ||
      !("epoch" in epochResponse) ||
      typeof epochResponse.epoch !== "number"
    ) {
      throw new Error("Missing cache epoch");
    }
    const staleEpoch = epochResponse.epoch;
    await chrome.runtime.sendMessage({
      type: "TRANSLATION_CACHE_SET",
      key,
      translatedText: "before clear",
      epoch: staleEpoch,
    });
    await chrome.runtime.sendMessage({ type: "CACHE_CLEAR" });
    const staleTranslationWrite: unknown = await chrome.runtime.sendMessage({
      type: "TRANSLATION_CACHE_SET",
      key,
      translatedText: "late translation",
      epoch: staleEpoch,
    });
    const staleTrackWrite: unknown = await chrome.runtime.sendMessage({
      type: "SUBTITLE_TRACK_SET",
      key,
      epoch: staleEpoch,
      track: {
        source: "youtube-timedtext",
        completeness: "full",
        language: "en",
        cues: [
          {
            id: "late-cue",
            startMs: 0,
            endMs: 1_000,
            originalText: "Late cue",
          },
        ],
      },
    });
    const stats: unknown = await chrome.runtime.sendMessage({
      type: "CACHE_STATS",
    });
    return { staleTranslationWrite, staleTrackWrite, stats };
  });

  expect(result).toEqual({
    staleTranslationWrite: {
      ok: true,
      stored: false,
      epoch: expect.any(Number),
    },
    staleTrackWrite: { ok: true, stored: false, epoch: expect.any(Number) },
    stats: { translations: 0, subtitleTracks: 0, jobs: 0 },
  });
});

test("reads and translates a complete HTML5 TextTrack", async () => {
  const pageUrl = "https://www.youtube.com/html5-track-e2e";
  const trackUrl = "https://www.youtube.com/html5-track-fixture.vtt";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><title>HTML5 fixture</title></head><body><video><track kind="subtitles" srclang="en" default src="${trackUrl}"></video></body></html>`,
    }),
  );
  await context.route(trackUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n\n00:00:01.050 --> 00:00:02.000\nHTML5.\n",
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "texttrack",
      completeness: "full",
    });
    expect(status.total).toBe(1);
    expect(status.completed).toBe(1);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(trackUrl);
  }
});

test("ends empty subtitle discovery and exposes a manual rescan action", async () => {
  const pageUrl = "https://www.youtube.com/no-subtitle-manual-rescan";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><video style='width:640px;height:360px'></video>",
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await expect
      .poll(() => subtitleStatus(pageUrl), { timeout: 12_000 })
      .toMatchObject({
        state: "unavailable",
        total: 0,
        completed: 0,
        failed: 0,
      });

    const control = page.locator("norixor-floating-control");
    await control.locator(".launcher").click();
    await control.locator("#norixortrans-video-panel-tab").click();
    const start = control.locator(".subtitle-actions .primary");
    await expect(start).toBeEnabled();
    await start.click();
    await expect
      .poll(() => subtitleStatus(pageUrl))
      .toMatchObject({
        state: "waiting",
        total: 0,
      });
    await expect(start).toBeEnabled();
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("shows a clickable diagnostic for an invalid subtitle Provider response", async () => {
  const pageUrl = "https://www.youtube.com/subtitle-invalid-response-details";
  const trackUrl =
    "https://www.youtube.com/subtitle-invalid-response-details.vtt";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><body><video><track kind="subtitles" srclang="en" default src="${trackUrl}"></video></body></html>`,
    }),
  );
  await context.route(trackUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nINVALID_RESPONSE_DETAILS subtitle.\n",
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await expect
      .poll(() => subtitleStatus(pageUrl))
      .toMatchObject({
        state: "error",
        source: "texttrack",
        completeness: "full",
        total: 1,
        completed: 0,
        failed: 1,
        details: expect.stringContaining(
          "Unknown compact result ID: unexpected-id",
        ),
      });

    const control = page.locator("norixor-floating-control");
    await control.locator(".launcher").click();
    await control.locator("#norixortrans-video-panel-tab").click();
    const diagnostic = control.locator(
      "#norixortrans-video-panel .diagnostic:not([hidden])",
    );
    await expect(diagnostic).toBeVisible();
    await diagnostic.locator("summary").click();
    await expect(diagnostic.locator("pre")).toContainText(
      "Unknown compact result ID: unexpected-id",
    );
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(trackUrl);
  }
});

for (const captionKind of ["manual", "asr"] as const) {
  test(`captures YouTube ${captionKind} timedtext through the MAIN-world fetch hook`, async () => {
    const pageUrl = `https://www.youtube.com/watch?v=e2e-${captionKind}`;
    const timedTextUrl = `https://www.youtube.com/api/timedtext?fmt=json3&lang=en${captionKind === "asr" ? "&kind=asr" : ""}`;
    await context.route("https://www.youtube.com/**", async (route) => {
      const url = route.request().url();
      if (url.startsWith("https://www.youtube.com/api/timedtext")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            events: [
              { tStartMs: 0, dDurationMs: 900, segs: [{ utf8: "Hello" }] },
              {
                tStartMs: 950,
                dDurationMs: 900,
                segs: [{ utf8: "world." }],
              },
            ],
          }),
        });
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><video></video><script>window.ytInitialPlayerResponse={captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:${JSON.stringify(timedTextUrl)},languageCode:"en"${captionKind === "asr" ? ',kind:"asr"' : ""}}]}}}</script>`,
      });
    });
    const page = await context.newPage();
    try {
      await page.goto(pageUrl);
      const status = await waitForReadyTrack(pageUrl, {
        source: "youtube-timedtext",
        completeness: "full",
      });
      expect(status.total).toBe(1);
      expect(status.completed).toBe(1);
    } finally {
      await page.close();
      await context.unroute("https://www.youtube.com/**");
    }
  });
}

test("restores a persisted YouTube full track without recapturing after refresh", async () => {
  const pageUrl = "https://www.youtube.com/watch?v=e2e-persisted-track";
  const timedTextUrl =
    "https://www.youtube.com/api/timedtext?fmt=json3&lang=en&persist=e2e";
  let exposeTrack = true;
  let timedTextRequests = 0;
  await controlPage.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: "CACHE_CLEAR" });
  });
  await context.route("https://www.youtube.com/**", async (route) => {
    const url = route.request().url();
    if (url.startsWith(timedTextUrl)) {
      timedTextRequests += 1;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              tStartMs: 0,
              dDurationMs: 1_000,
              segs: [{ utf8: "Persisted caption." }],
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: exposeTrack
        ? `<!doctype html><video></video><script>window.ytInitialPlayerResponse={captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:${JSON.stringify(timedTextUrl)},languageCode:"en"}]}}}</script>`
        : "<!doctype html><video></video>",
    });
  });

  let page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await waitForReadyTrack(pageUrl, {
      source: "youtube-timedtext",
      completeness: "full",
    });
    await expect
      .poll(() =>
        controlPage.evaluate(async () => {
          const stats: unknown = await chrome.runtime.sendMessage({
            type: "CACHE_STATS",
          });
          return typeof stats === "object" &&
            stats !== null &&
            "subtitleTracks" in stats &&
            typeof stats.subtitleTracks === "number"
            ? stats.subtitleTracks
            : 0;
        }),
      )
      .toBeGreaterThan(0);
    expect(timedTextRequests).toBe(1);

    await page.close();
    exposeTrack = false;
    page = await context.newPage();
    await page.goto(pageUrl);
    const restored = await waitForReadyTrack(pageUrl, {
      source: "youtube-timedtext",
      completeness: "full",
    });
    expect(restored).toMatchObject({ total: 1, completed: 1, failed: 0 });
    expect(timedTextRequests).toBe(1);

    await page.close();
    await controlPage.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: "CACHE_CLEAR" });
    });
    const clearedStats: unknown = await controlPage.evaluate(async () => {
      const value: unknown = await chrome.runtime.sendMessage({
        type: "CACHE_STATS",
      });
      return value;
    });
    expect(clearedStats).toEqual({
      translations: 0,
      subtitleTracks: 0,
      jobs: 0,
    });
    page = await context.newPage();
    await page.goto(pageUrl);
    await expect
      .poll(() => subtitleStatus(pageUrl))
      .toMatchObject({ state: "waiting", total: 0, completed: 0, failed: 0 });
    expect(timedTextRequests).toBe(1);
  } finally {
    if (!page.isClosed()) await page.close();
    await context.unroute("https://www.youtube.com/**");
    await controlPage.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: "CACHE_CLEAR" });
    });
  }
});

test("selects the configured YouTube source-language track", async () => {
  const pageUrl = "https://www.youtube.com/watch?v=e2e-source-language";
  const englishUrl = "https://www.youtube.com/api/timedtext?fmt=json3&lang=en";
  const frenchUrl =
    "https://www.youtube.com/api/timedtext?fmt=json3&lang=fr&kind=asr";
  const requestedLanguages: Array<string | null> = [];
  const previous = await updateSubtitlePreferences({ sourceLanguage: "fr" });
  await context.route("https://www.youtube.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/timedtext") {
      requestedLanguages.push(url.searchParams.get("lang"));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              tStartMs: 0,
              dDurationMs: 1_000,
              segs: [{ utf8: "Bonjour." }],
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>window.ytInitialPlayerResponse={captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:${JSON.stringify(englishUrl)},languageCode:"en"},{baseUrl:${JSON.stringify(frenchUrl)},languageCode:"fr",kind:"asr"}]}}}</script>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await waitForReadyTrack(pageUrl, {
      source: "youtube-timedtext",
      completeness: "full",
    });
    expect(requestedLanguages).toContain("fr");
    expect(requestedLanguages).not.toContain("en");
  } finally {
    await page.close();
    await context.unroute("https://www.youtube.com/**");
    await updateSubtitlePreferences(previous);
  }
});

test("captures YouTube nocookie embed timedtext through the MAIN-world hook", async () => {
  const pageUrl = "https://www.youtube-nocookie.com/embed/e2e-nocookie";
  const timedTextUrl =
    "https://www.youtube-nocookie.com/api/timedtext?fmt=json3&lang=en";
  await context.route("https://www.youtube-nocookie.com/**", async (route) => {
    if (route.request().url().startsWith(timedTextUrl)) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              tStartMs: 0,
              dDurationMs: 1_000,
              segs: [{ utf8: "Embedded caption." }],
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>window.ytInitialPlayerResponse={captions:{playerCaptionsTracklistRenderer:{captionTracks:[{baseUrl:${JSON.stringify(timedTextUrl)},languageCode:"en"}]}}}</script>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "youtube-timedtext",
      completeness: "full",
    });
    expect(status.total).toBe(1);
    expect(status.completed).toBe(1);
  } finally {
    await page.close();
    await context.unroute("https://www.youtube-nocookie.com/**");
  }
});

test("captures an arraybuffer YouTube timedtext XHR without changing the page response", async () => {
  const pageUrl = "https://www.youtube.com/xhr-arraybuffer-e2e";
  const timedTextUrl =
    "https://www.youtube.com/api/timedtext?fmt=json3&lang=en&xhr=e2e";
  await context.route("https://www.youtube.com/**", async (route) => {
    if (
      route.request().url().startsWith("https://www.youtube.com/api/timedtext")
    ) {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              tStartMs: 0,
              dDurationMs: 1_000,
              segs: [{ utf8: "XHR caption." }],
            },
          ],
        }),
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>setTimeout(()=>{const request=new XMLHttpRequest();request.open("GET",${JSON.stringify(timedTextUrl)});request.responseType="arraybuffer";request.send()},150)</script>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "youtube-timedtext",
      completeness: "full",
    });
    expect(status.total).toBe(1);
  } finally {
    await page.close();
    await context.unroute("https://www.youtube.com/**");
  }
});

test("leaves ordinary YouTube media fetch responses untouched", async () => {
  const pageUrl = "https://www.youtube.com/watch?v=media-passthrough-e2e";
  const mediaUrl =
    "https://www.youtube.com/videoplayback?id=media-passthrough-e2e&range=0-20";
  let mediaRequests = 0;
  await context.route("https://www.youtube.com/**", async (route) => {
    if (route.request().url() === mediaUrl) {
      mediaRequests += 1;
      await route.fulfill({
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "X-Media-Fixture": "preserved",
        },
        body: "synthetic-media-chunk",
      });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>
        window.__captureEvents = 0;
        window.addEventListener('norixortrans:subtitle-response', () => {
          window.__captureEvents += 1;
        });
        setTimeout(async () => {
          const response = await fetch(${JSON.stringify(mediaUrl)});
          window.__mediaFetchResult = {
            status: response.status,
            contentType: response.headers.get('content-type'),
            fixtureHeader: response.headers.get('x-media-fixture'),
            body: await response.text(),
          };
        }, 150);
      </script>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await expect
      .poll(() =>
        page.evaluate((): unknown => {
          const result: unknown = Reflect.get(window, "__mediaFetchResult");
          return result;
        }),
      )
      .toEqual({
        status: 206,
        contentType: "video/mp4",
        fixtureHeader: "preserved",
        body: "synthetic-media-chunk",
      });
    expect(mediaRequests).toBe(1);
    expect(
      await page.evaluate((): unknown => {
        const count: unknown = Reflect.get(window, "__captureEvents");
        return count;
      }),
    ).toBe(0);
  } finally {
    await page.close();
    await context.unroute("https://www.youtube.com/**");
  }
});

test("uses YouTube rendered captions when a full timedtext body is unavailable", async () => {
  const pageUrl = "https://www.youtube.com/watch?v=dom-fallback-e2e";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>YouTube DOM fallback</title><video></video><div class="ytp-caption-segment">Rendered caption</div>',
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await expect
      .poll(() => subtitleStatus(pageUrl))
      .toMatchObject({
        state: "ready",
        source: "dom",
        completeness: "stream",
        total: 1,
        completed: 1,
      });
    const cueCard = page.locator(
      '[data-norixortrans-ui="subtitle-overlay"] .cue-card',
    );
    await expect(cueCard).toBeVisible();
    await page.locator(".ytp-caption-segment").evaluate((element) => {
      element.setAttribute("aria-hidden", "true");
    });
    await expect(cueCard).toBeHidden();
    await page.locator(".ytp-caption-segment").evaluate((element) => {
      element.removeAttribute("aria-hidden");
      element.textContent = "Next rendered caption";
    });
    await expect(cueCard).toContainText("Next rendered caption");
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("applies native caption visibility and overlay position at runtime", async () => {
  const pageUrl = "https://www.youtube.com/watch?v=subtitle-display-e2e";
  const previous = await updateSubtitlePreferences({
    displayMode: "translated",
    hideNativeSubtitles: true,
    position: "top",
  });
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><style>video{position:fixed;left:120px;top:80px;width:640px;height:360px}</style><button id="fullscreen" onclick="document.querySelector(\'video\').requestFullscreen()">Fullscreen</button><video></video><div class="ytp-caption-window-container"><div class="ytp-caption-segment">Native caption</div></div>',
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await waitForReadyTrack(pageUrl, {
      source: "dom",
      completeness: "stream",
    });
    await expect(page.locator(".ytp-caption-segment")).toHaveCSS(
      "visibility",
      "hidden",
    );
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"]'),
    ).toHaveAttribute("data-position", "top");
    const subtitleOverlay = page.locator(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const originalCue = subtitleOverlay.locator(".cue.original");
    const translatedCue = subtitleOverlay.locator(".cue.translated");
    await expect(originalCue).toBeHidden();
    await expect(translatedCue).toBeVisible();

    await updateSubtitlePreferences({ displayMode: "bilingual" });
    await expect(originalCue).toBeVisible();
    await expect(translatedCue).toBeVisible();
    await expect(subtitleOverlay.locator(".cue-card")).toHaveCount(1);

    await updateSubtitlePreferences({ displayMode: "original" });
    await expect(originalCue).toBeVisible();
    await expect(translatedCue).toBeHidden();

    await updateSubtitlePreferences({ displayMode: "translated" });
    await expect(originalCue).toBeHidden();
    await expect(translatedCue).toBeVisible();
    const videoAnchoring = await page
      .locator('[data-norixortrans-ui="subtitle-overlay"]')
      .evaluate((host: HTMLElement) => ({
        x: host.style.getPropertyValue("--norixortrans-anchor-x"),
        maxWidth: host.style.getPropertyValue("--norixortrans-max-width"),
      }));
    expect(videoAnchoring).toEqual({ x: "440px", maxWidth: "512px" });
    const quickControl = page.locator("norixor-floating-control");
    await page.locator("#fullscreen").click();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.fullscreenElement instanceof HTMLVideoElement,
        ),
      )
      .toBe(true);
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue-card'),
    ).toBeVisible();
    await expect(quickControl.locator(".launcher")).toBeVisible();
    await expect(quickControl.locator(".panel")).toBeHidden();
    await expect
      .poll(() =>
        quickControl.evaluate(
          (element) =>
            element.parentElement?.getAttribute("data-norixortrans-ui") ?? "",
        ),
      )
      .toBe("floating-control-fullscreen-portal");
    await page.evaluate(() => document.exitFullscreen());
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
    await expect(quickControl.locator(".launcher")).toBeVisible();
    await expect
      .poll(() =>
        quickControl.evaluate(
          (element) => element.parentElement === document.documentElement,
        ),
      )
      .toBe(true);
    await expect(quickControl.locator(".panel")).toBeHidden();
    await quickControl.locator(".launcher").click();
    await expect(quickControl.locator(".panel")).toBeVisible();
    await quickControl.locator("#norixortrans-video-panel-tab").click();
    await expect(
      quickControl.locator("#norixortrans-video-panel"),
    ).toBeVisible();
    await quickControl.locator(".header .icon-button").click();
    await expect(quickControl.locator(".panel")).toBeHidden();

    await updateSubtitlePreferences({
      hideNativeSubtitles: false,
      position: "bottom",
    });
    await expect(page.locator(".ytp-caption-segment")).toHaveCSS(
      "visibility",
      "visible",
    );
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"]'),
    ).toHaveAttribute("data-position", "bottom");

    const dragHandle = page.locator(
      '[data-norixortrans-ui="subtitle-overlay"] .cue-card',
    );
    await page
      .locator('[data-norixortrans-ui="subtitle-overlay"] .cue-card')
      .hover();
    const dragBox = await dragHandle.boundingBox();
    if (!dragBox) throw new Error("Missing subtitle drag handle geometry");
    await page.mouse.move(
      dragBox.x + dragBox.width / 2,
      dragBox.y + dragBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      dragBox.x + dragBox.width / 2 + 70,
      dragBox.y + dragBox.height / 2 - 50,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"]'),
    ).toHaveAttribute("data-position", "custom");

    await updateSubtitlePreferences({ hideNativeSubtitles: true });
    await expect(page.locator(".ytp-caption-segment")).toHaveCSS(
      "visibility",
      "hidden",
    );
    await quickControl.locator(".launcher").click();
    await quickControl.locator("#norixortrans-video-panel-tab").click();
    await quickControl
      .locator(".subtitle-actions button:not(.primary)")
      .click();
    await expect(page.locator(".ytp-caption-segment")).toHaveCSS(
      "visibility",
      "visible",
    );
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .stop-button'),
    ).toHaveCount(0);
  } finally {
    await updateSubtitlePreferences(previous);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("captures Netflix CDN TTML requested before the video element mounts as streaming", async () => {
  const pageUrl = "https://www.netflix.com/watch/e2e-full";
  const timedTextUrl =
    "https://ipv4-c001.nflxvideo.net/?o=e2e&v=2&e=3&t=bootstrap";
  await context.route(timedTextUrl, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({
      contentType: "text/xml",
      body: '<tt xml:lang="en"><body><div><p begin="0s" end="1s">Hello</p><p begin="1.05s" end="2s">Netflix.</p></div></body></tt>',
    });
  });
  await context.route(pageUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><script>setTimeout(() => fetch(${JSON.stringify(timedTextUrl)}), 250);setTimeout(() => document.body.append(document.createElement("video")), 350)</script>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "netflix-manifest",
      completeness: "stream",
    });
    expect(status.total).toBe(2);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(timedTextUrl);
  }
});

test("prefetches a finite Max DASH track and displays its AI translation", async () => {
  const pageUrl = "https://play.max.com/video/e2e-finite-dash";
  const manifestUrl = "https://cmaf.fly.eu.hbomaxcdn.com/e2e/manifest/main.mpd";
  const firstSegmentUrl =
    "https://cmaf.fly.eu.hbomaxcdn.com/e2e/subtitle-1.vtt";
  const secondSegmentUrl =
    "https://cmaf.fly.eu.hbomaxcdn.com/e2e/subtitle-2.vtt";
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>
    <MPD type="static">
      <BaseURL>https://cmaf.fly.eu.hbomaxcdn.com/e2e/</BaseURL>
      <Period>
        <AdaptationSet contentType="text" lang="en">
          <SegmentTemplate media="subtitle-$Number$.vtt" startNumber="1" timescale="1000">
            <SegmentTimeline><S t="0" d="1000" r="1" /></SegmentTimeline>
          </SegmentTemplate>
          <Representation id="en" bandwidth="256" mimeType="text/vtt" />
        </AdaptationSet>
      </Period>
    </MPD>`;
  await context.route(manifestUrl, (route) =>
    route.fulfill({
      contentType: "application/dash+xml",
      headers: { "access-control-allow-origin": "*" },
      body: manifest,
    }),
  );
  await context.route(firstSegmentUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      headers: { "access-control-allow-origin": "*" },
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nMax first subtitle.",
    }),
  );
  await context.route(secondSegmentUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      headers: { "access-control-allow-origin": "*" },
      body: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nMax second subtitle.",
    }),
  );
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>setTimeout(() => fetch(${JSON.stringify(manifestUrl)}).then((response) => response.text()), 250)</script>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "network",
      completeness: "full",
    });
    expect(status).toMatchObject({ total: 2, completed: 2, failed: 0 });
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue.translated'),
    ).toContainText("已译 Max first subtitle.");
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(manifestUrl);
    await context.unroute(firstSegmentUrl);
    await context.unroute(secondSegmentUrl);
  }
});

test("prefetches a finite Max HLS WebVTT track from the built-in profile", async () => {
  const pageUrl = "https://play.max.com/video/e2e-finite-hls";
  const playlistUrl =
    "https://cmaf.fly.eu.hbomaxcdn.com/e2e/subtitles/english/full.m3u8?lang=en";
  const segmentUrl =
    "https://cmaf.fly.eu.hbomaxcdn.com/e2e/subtitles/english/one.vtt";
  await context.route(playlistUrl, (route) =>
    route.fulfill({
      contentType: "application/vnd.apple.mpegurl",
      headers: { "access-control-allow-origin": "*" },
      body: [
        "#EXTM3U",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXTINF:4,",
        "one.vtt",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    }),
  );
  await context.route(segmentUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      headers: { "access-control-allow-origin": "*" },
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nMax HLS built-in subtitle.",
    }),
  );
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>setTimeout(() => fetch(${JSON.stringify(playlistUrl)}).then((response) => response.text()), 250)</script>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "network",
      completeness: "full",
    });
    expect(status).toMatchObject({ total: 1, completed: 1, failed: 0 });
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue.translated'),
    ).toContainText("已译 Max HLS built-in subtitle.");
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(playlistUrl);
    await context.unroute(segmentUrl);
  }
});

test("captures the built-in Disney+ and Amazon Prime Video subtitle profiles", async () => {
  const cases = [
    {
      name: "Disney+",
      pageUrl: "https://www.disneyplus.com/video/e2e-built-in-profile",
      subtitleUrl:
        "https://vod.media.dssott.com/e2e/subtitles/english/segment-1.vtt",
      contentType: "text/vtt",
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nDisney built-in subtitle.",
      translatedText: "已译 Disney built-in subtitle.",
    },
    {
      name: "Amazon Prime Video",
      pageUrl: "https://www.amazon.com/gp/video/detail/e2e-built-in-profile",
      subtitleUrl:
        "https://cdn.media-amazon.com/e2e/subtitle/english/episode.ttml",
      contentType: "application/ttml+xml",
      body: '<tt xml:lang="en"><body><div><p begin="0s" end="5s">Prime built-in subtitle.</p></div></body></tt>',
      translatedText: "已译 Prime built-in subtitle.",
    },
  ] as const;

  for (const fixture of cases) {
    await context.route(fixture.subtitleUrl, (route) =>
      route.fulfill({
        contentType: fixture.contentType,
        headers: { "access-control-allow-origin": "*" },
        body: fixture.body,
      }),
    );
    await context.route(fixture.pageUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>${fixture.name}</title><video></video><script>setTimeout(() => fetch(${JSON.stringify(fixture.subtitleUrl)}).then((response) => response.text()), 250)</script>`,
      }),
    );
    const page = await context.newPage();
    try {
      await page.goto(fixture.pageUrl);
      const status = await waitForReadyTrack(fixture.pageUrl, {
        source: "network",
        completeness: "stream",
      });
      expect(status).toMatchObject({ total: 1, completed: 1, failed: 0 });
      await expect(
        page.locator(
          '[data-norixortrans-ui="subtitle-overlay"] .cue.translated',
        ),
      ).toContainText(fixture.translatedText);
    } finally {
      await page.close();
      await context.unroute(fixture.pageUrl);
      await context.unroute(fixture.subtitleUrl);
    }
  }
});

test("promotes a complete Udemy WebVTT response from the built-in profile", async () => {
  const pageUrl =
    "https://www.udemy.com/course/e2e-profile/learn/lecture/10000001";
  const subtitleUrl =
    "https://cdn.udemycdn.com/captions/e2e-profile-en.vtt?lang=en";
  await context.route(subtitleUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      headers: { "access-control-allow-origin": "*" },
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nUdemy complete subtitle.",
    }),
  );
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Udemy</title><video></video><script>setTimeout(() => fetch(${JSON.stringify(subtitleUrl)}).then((response) => response.text()), 250)</script>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "network",
      completeness: "full",
    });
    expect(status).toMatchObject({ total: 1, completed: 1, failed: 0 });
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue.translated'),
    ).toContainText("已译 Udemy complete subtitle.");
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(subtitleUrl);
  }
});

test("prefetches a finite Disney+ HLS WebVTT track as complete", async () => {
  const pageUrl = "https://www.disneyplus.com/video/e2e-finite-hls";
  const playlistUrl =
    "https://vod.media.dssott.com/e2e/subtitles/english/full.m3u8?lang=en";
  const firstSegmentUrl =
    "https://vod.media.dssott.com/e2e/subtitles/english/one.vtt";
  const secondSegmentUrl =
    "https://vod.media.dssott.com/e2e/subtitles/english/two.vtt";
  await context.route(playlistUrl, (route) =>
    route.fulfill({
      contentType: "application/vnd.apple.mpegurl",
      headers: { "access-control-allow-origin": "*" },
      body: [
        "#EXTM3U",
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXTINF:2,",
        "one.vtt",
        "#EXTINF:2,",
        "two.vtt",
        "#EXT-X-ENDLIST",
      ].join("\n"),
    }),
  );
  await context.route(firstSegmentUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      headers: { "access-control-allow-origin": "*" },
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nDisney first HLS subtitle.",
    }),
  );
  await context.route(secondSegmentUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      headers: { "access-control-allow-origin": "*" },
      body: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nDisney second HLS subtitle.",
    }),
  );
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>setTimeout(() => fetch(${JSON.stringify(playlistUrl)}).then((response) => response.text()), 250)</script>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "network",
      completeness: "full",
    });
    expect(status).toMatchObject({ total: 2, completed: 2, failed: 0 });
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue.translated'),
    ).toContainText("已译 Disney first HLS subtitle.");
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(playlistUrl);
    await context.unroute(firstSegmentUrl);
    await context.unroute(secondSegmentUrl);
  }
});

test("captures an explicit Netflix timed-text endpoint as a full track", async () => {
  const pageUrl = "https://www.netflix.com/watch/e2e-explicit-full";
  const timedTextUrl =
    "https://www.netflix.com/timedtexttracks?id=e2e-explicit-full";
  await context.route(timedTextUrl, async (route) => {
    await route.fulfill({
      contentType: "application/ttml+xml",
      body: '<tt xml:lang="en"><body><div><p begin="0s" end="1s">Complete Netflix subtitle.</p></div></body></tt>',
    });
  });
  await context.route(pageUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>setTimeout(() => fetch(${JSON.stringify(timedTextUrl)}), 250)</script>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "netflix-manifest",
      completeness: "full",
    });
    expect(status).toMatchObject({ total: 1, completed: 1, failed: 0 });
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue.translated'),
    ).toContainText("已译 Complete Netflix subtitle.");
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(timedTextUrl);
  }
});

test("keeps an HTTP partial Netflix timed-text response streaming", async () => {
  const pageUrl = "https://www.netflix.com/watch/e2e-http-partial";
  const timedTextUrl =
    "https://www.netflix.com/timedtexttracks?id=e2e-http-partial";
  await context.route(timedTextUrl, async (route) => {
    await route.fulfill({
      status: 206,
      contentType: "application/ttml+xml",
      headers: { "content-range": "bytes 0-199/800" },
      body: '<tt xml:lang="en"><body><div><p begin="0s" end="1s">Partial Netflix subtitle.</p></div></body></tt>',
    });
  });
  await context.route(pageUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>setTimeout(() => fetch(${JSON.stringify(timedTextUrl)}), 250)</script>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "netflix-manifest",
      completeness: "stream",
    });
    expect(status).toMatchObject({ total: 1, completed: 1, failed: 0 });
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(timedTextUrl);
  }
});

test("recovers a buffered Netflix subtitle resource after the player request already finished", async () => {
  const pageUrl = "https://www.netflix.com/watch/e2e-buffered-resource";
  const timedTextUrl =
    "https://ipv4-c001.nflxvideo.net/?o=buffered-e2e&v=2&e=3&t=bootstrap";
  let resourceRequests = 0;
  await context.route(timedTextUrl, async (route) => {
    resourceRequests += 1;
    await route.fulfill({
      contentType: "text/xml",
      headers: { "access-control-allow-origin": "*" },
      body: '<tt xml:lang="en"><body><div><p begin="0s" end="1s">Buffered Netflix subtitle.</p></div></body></tt>',
    });
  });
  await context.route(pageUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><head><link rel="preload" as="fetch" crossorigin href=${JSON.stringify(timedTextUrl)}></head><body><video></video></body>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "netflix-manifest",
      completeness: "stream",
    });
    expect(status).toMatchObject({ total: 1, completed: 1, failed: 0 });
    expect(resourceRequests).toBeGreaterThan(0);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(timedTextUrl);
  }
});

test("promotes Netflix manifest candidates consumed through Response.json", async () => {
  const pageUrl = "https://www.netflix.com/watch/e2e-response-json-manifest";
  const manifestUrl = "https://www.netflix.com/api/shakti/mre/e2e-manifest";
  const timedTextUrl =
    "https://ipv4-c001.nflxvideo.net/?o=response-json&v=2&e=3&t=manifest";
  let timedTextRequests = 0;
  await context.route(timedTextUrl, async (route) => {
    timedTextRequests += 1;
    await route.fulfill({
      contentType: "application/ttml+xml",
      headers: { "access-control-allow-origin": "*" },
      body: '<tt xml:lang="en"><body><div><p begin="0s" end="1s">Response JSON subtitle.</p></div></body></tt>',
    });
  });
  await context.route(manifestUrl, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          timedtexttracks: [
            {
              trackId: "en-response-json",
              bcp47: "en-US",
              ttDownloadables: {
                "imsc1.1": { urls: [{ url: timedTextUrl }] },
              },
            },
          ],
        },
      }),
    });
  });
  await context.route(pageUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>setTimeout(() => fetch(${JSON.stringify(manifestUrl)}).then((response) => response.json()), 250)</script>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "netflix-manifest",
      completeness: "full",
    });
    expect(status).toMatchObject({ total: 1, completed: 1, failed: 0 });
    expect(timedTextRequests).toBeGreaterThan(0);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(manifestUrl);
    await context.unroute(timedTextUrl);
  }
});

test("upgrades a buffered Netflix CDN URL after later manifest confirmation", async () => {
  const pageUrl = "https://www.netflix.com/watch/e2e-manifest-upgrade";
  const manifestUrl = "https://www.netflix.com/api/shakti/mre/e2e-upgrade";
  const timedTextUrl =
    "https://ipv4-c001.nflxvideo.net/?o=upgrade&v=2&e=3&t=manifest";
  let timedTextRequests = 0;
  await context.route(timedTextUrl, async (route) => {
    timedTextRequests += 1;
    await route.fulfill({
      contentType: "application/ttml+xml",
      headers: { "access-control-allow-origin": "*" },
      body: '<tt xml:lang="en"><body><div><p begin="0s" end="1s">Upgraded full subtitle.</p></div></body></tt>',
    });
  });
  await context.route(manifestUrl, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          timedtexttracks: [
            {
              trackId: "en-upgrade",
              bcp47: "en-US",
              ttDownloadables: {
                "imsc1.1": { urls: [{ url: timedTextUrl }] },
              },
            },
          ],
        },
      }),
    });
  });
  await context.route(pageUrl, async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><video></video><script>setTimeout(() => fetch(${JSON.stringify(timedTextUrl)}), 150);setTimeout(() => fetch(${JSON.stringify(manifestUrl)}).then((response) => response.json()), 650)</script>`,
    });
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "netflix-manifest",
      completeness: "full",
    });
    expect(status).toMatchObject({ total: 1, completed: 1, failed: 0 });
    expect(timedTextRequests).toBeGreaterThanOrEqual(2);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(manifestUrl);
    await context.unroute(timedTextUrl);
  }
});

test("uses Netflix DOM fallback for the watched portion", async () => {
  const pageUrl = "https://www.netflix.com/watch/e2e-stream";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Stream fixture</title><video></video><div class="player-timedtext">First line.</div>',
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const firstStatus = await waitForReadyTrack(pageUrl, {
      source: "dom",
      completeness: "stream",
    });
    expect(firstStatus.total).toBe(1);
    await page.locator(".player-timedtext").evaluate((element) => {
      element.textContent = "Second line.";
    });
    await expect
      .poll(async () => (await subtitleStatus(pageUrl))?.completed)
      .toBe(2);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("does not download a missing OCR model during the local self-test", async () => {
  test.setTimeout(120_000);
  const requests: string[] = [];
  const recordRequest = (request: { url(): string }): void => {
    requests.push(request.url());
  };
  context.on("request", recordRequest);
  try {
    await controlPage.bringToFront();
    await controlPage.locator("#ocr-runtimes-tab").click();
    await controlPage.locator("#ocr-self-test").click();
    const message = controlPage.locator("#ocr-test-message");
    await expect(message).toHaveAttribute("data-tone", "error");
    await expect(message).toHaveText(
      /^(?:The required local OCR language pack is not installed\. Open Settings > OCR runtimes to download it\.|所需的本地 OCR 语言包尚未安装。请打开“设置 > OCR 运行时”下载。)$/u,
    );
    await expect(message).not.toContainText(/ocr_runtime_missing/iu);
    expect(
      requests.filter((url) =>
        /(?:media|raw)\.githubusercontent\.com/iu.test(url),
      ),
    ).toEqual([]);
  } finally {
    context.off("request", recordRequest);
  }
});

test("recognizes burned-in subtitles inside a canvas-player iframe", async () => {
  test.skip(
    !runHeadedOcrCapture,
    "captureVisibleTab requires a headed active tab",
  );
  test.setTimeout(120_000);
  const pageUrl = "https://www.youtube.com/ocr-burned-in-e2e";
  const playerUrl = "https://player.example.test/ocr-canvas-frame";
  let providerRequests = 0;
  const recordProviderRequest = (request: Request): void => {
    if (request.url().startsWith(providerBaseUrl)) providerRequests += 1;
  };
  context.on("request", recordProviderRequest);
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "Content-Security-Policy":
          "default-src 'none'; frame-src https://player.example.test; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; worker-src 'none'",
      },
      body: `<!doctype html>
        <html lang="en">
          <head>
            <style>
              body { margin: 0; min-height: 100vh; background: #fff; }
              iframe { display: block; width: 720px; height: 405px; margin: 40px; border: 0; }
              .outside { position: fixed; top: 4px; right: 8px; color: #111; font: 700 24px Arial, sans-serif; }
              #fullscreen { position:fixed; bottom:8px; left:8px; min-width:44px; min-height:44px; }
              norixor-ocr-region-selector,
              [data-norixortrans-ui="subtitle-overlay"] { position:static !important; z-index:-1 !important; pointer-events:none !important; }
            </style>
          </head>
          <body>
            <div class="outside">IGNORE OUTSIDE REGION</div>
            <iframe id="player" src="${playerUrl}" title="Canvas video player"></iframe>
            <button id="fullscreen">Fullscreen</button>
            <script>document.querySelector('#fullscreen').addEventListener('click',()=>document.querySelector('#player').requestFullscreen())</script>
          </body>
        </html>`,
    }),
  );
  await context.route(playerUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; worker-src 'none'",
      },
      body: `<!doctype html>
        <style>
          html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #18202b; }
          canvas { display:block; width: 100%; height: 100%; }
        </style>
        <canvas width="720" height="405"></canvas>
        <script>
          const canvas = document.querySelector('canvas');
          const context = canvas.getContext('2d');
          const background = context.createLinearGradient(0, 0, canvas.width, canvas.height);
          background.addColorStop(0, '#172434');
          background.addColorStop(0.55, '#476451');
          background.addColorStop(1, '#94704b');
          globalThis.drawSubtitle = (subtitle) => {
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = background;
            context.fillRect(0, 0, canvas.width, canvas.height);
            for (let index = 0; index < 160; index += 1) {
              const red = (index * 73) % 255;
              const green = (index * 137) % 255;
              const blue = (index * 199) % 255;
              context.fillStyle = 'rgba(' + red + ',' + green + ',' + blue + ',.24)';
              context.fillRect((index * 83) % 720, (index * 47) % 405, 18 + (index % 7) * 13, 6 + (index % 5) * 8);
            }
            for (let index = 0; index < 96; index += 1) {
              context.beginPath();
              context.moveTo((index * 29) % 720, (index * 67) % 405);
              context.lineTo((index * 113 + 210) % 720, (index * 41 + 170) % 405);
              context.strokeStyle = index % 2 ? 'rgba(255,255,255,.24)' : 'rgba(0,0,0,.3)';
              context.lineWidth = 1 + (index % 4);
              context.stroke();
            }
            for (let index = 0; index < 44; index += 1) {
              context.beginPath();
              context.arc((index * 97) % 720, (index * 59) % 405, 4 + (index % 8) * 3, 0, Math.PI * 2);
              context.fillStyle = index % 3 === 0 ? 'rgba(255,245,170,.34)' : 'rgba(5,15,25,.34)';
              context.fill();
            }
            context.fillStyle = '#fff';
            context.textAlign = 'center';
            context.font = '700 32px Arial, sans-serif';
            context.fillText(subtitle, 360, 350);
          };
          globalThis.drawSubtitle('HELLO OCR 123');
        </script>`,
    }),
  );
  const previousOcr = await controlPage.evaluate(async () => {
    const rawSettings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (
      typeof rawSettings !== "object" ||
      rawSettings === null ||
      !("ocr" in rawSettings) ||
      typeof rawSettings.ocr !== "object" ||
      rawSettings.ocr === null ||
      !("enabled" in rawSettings.ocr) ||
      typeof rawSettings.ocr.enabled !== "boolean" ||
      !("provider" in rawSettings) ||
      typeof rawSettings.provider !== "object" ||
      rawSettings.provider === null ||
      !("timeoutMs" in rawSettings.provider) ||
      typeof rawSettings.provider.timeoutMs !== "number"
    ) {
      throw new Error("Missing OCR settings");
    }
    const settings = rawSettings as Record<string, unknown> & {
      ocr: { enabled: boolean };
      provider: Record<string, unknown> & { timeoutMs: number };
    };
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...settings,
        provider: { ...settings.provider, timeoutMs: 5_000 },
      },
    });
    return {
      ocr: { ...settings.ocr },
      providerTimeoutMs: settings.provider.timeoutMs,
    };
  });
  const runtimeInstalled = await controlPage.evaluate(async () => {
    const listed: unknown = await chrome.runtime.sendMessage({
      type: "OCR_RUNTIME_LIST",
    });
    const alreadyInstalled =
      typeof listed === "object" &&
      listed !== null &&
      "runtimes" in listed &&
      Array.isArray(listed.runtimes) &&
      listed.runtimes.some(
        (runtime: unknown) =>
          typeof runtime === "object" &&
          runtime !== null &&
          "pack" in runtime &&
          runtime.pack === "zh" &&
          "state" in runtime &&
          runtime.state === "installed",
      );
    if (alreadyInstalled) return true;
    const installed: unknown = await chrome.runtime.sendMessage({
      type: "OCR_RUNTIME_DOWNLOAD",
      pack: "zh",
    });
    return Boolean(
      installed &&
      typeof installed === "object" &&
      "ok" in installed &&
      installed.ok === true,
    );
  });
  expect(runtimeInstalled).toBe(true);
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await page.bringToFront();
    const floatingControl = page.locator("norixor-floating-control");
    await floatingControl.locator(".launcher").click();
    await floatingControl.locator("#norixortrans-video-panel-tab").click();
    await floatingControl.locator(".ocr-section > summary").click();
    const ocrToggle = floatingControl.locator(
      '.ocr-section input[type="checkbox"]',
    );
    if (!(await ocrToggle.isChecked())) await ocrToggle.check();
    await expect
      .poll(() =>
        controlPage.evaluate(async () => {
          const settings: unknown = await chrome.runtime.sendMessage({
            type: "SETTINGS_GET",
          });
          return Boolean(
            settings &&
            typeof settings === "object" &&
            "ocr" in settings &&
            settings.ocr &&
            typeof settings.ocr === "object" &&
            "enabled" in settings.ocr &&
            settings.ocr.enabled === true,
          );
        }),
      )
      .toBe(true);
    await floatingControl
      .locator(".ocr-section .actions button.primary")
      .click();
    await page.bringToFront();
    const selector = page.locator("norixor-ocr-region-selector");
    await expect(selector).toBeVisible();
    await expect(selector).toHaveAttribute("data-ready", "true");
    await expect
      .poll(() =>
        selector.evaluate((host) => ({
          position: getComputedStyle(host).position,
          zIndex: getComputedStyle(host).zIndex,
          pointerEvents: getComputedStyle(host).pointerEvents,
        })),
      )
      .toEqual({
        position: "fixed",
        zIndex: "2147483647",
        pointerEvents: "auto",
      });
    const playerBox = await selector.locator(".video-guide").boundingBox();
    if (!playerBox) throw new Error("Missing OCR video-guide geometry");
    const selectionStart = {
      x: playerBox.x + playerBox.width * 0.1,
      y: playerBox.y + playerBox.height * 0.75,
    };
    const selectionEnd = {
      x: playerBox.x + playerBox.width * 0.9,
      y: playerBox.y + playerBox.height * 0.93,
    };
    await page.mouse.move(selectionStart.x, selectionStart.y);
    await page.mouse.down();
    await page.mouse.move(selectionEnd.x, selectionEnd.y, { steps: 4 });
    await page.mouse.up();
    await expect(selector).toHaveCount(0);

    await expect
      .poll(
        async () => {
          return controlPage.evaluate(async (targetUrl) => {
            const tabs = await chrome.tabs.query({});
            const tab = tabs.find((candidate) => candidate.url === targetUrl);
            if (tab?.id === undefined) return 0;
            const status: unknown = await chrome.tabs.sendMessage(
              tab.id,
              { type: "OCR_STATUS" },
              { frameId: 0 },
            );
            if (
              typeof status === "object" &&
              status !== null &&
              "state" in status &&
              (status.state === "error" || status.state === "unavailable")
            ) {
              throw new Error(
                "message" in status && typeof status.message === "string"
                  ? status.message
                  : "OCR stopped before recognition",
              );
            }
            return typeof status === "object" &&
              status !== null &&
              "recognized" in status &&
              typeof status.recognized === "number"
              ? status.recognized
              : 0;
          }, pageUrl);
        },
        { timeout: 90_000 },
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() =>
        page
          .locator('[data-norixortrans-ui="subtitle-overlay"]')
          .evaluate((host) => ({
            position: getComputedStyle(host).position,
            zIndex: getComputedStyle(host).zIndex,
            pointerEvents: getComputedStyle(host).pointerEvents,
          })),
      )
      .toEqual({
        position: "fixed",
        zIndex: "2147483646",
        pointerEvents: "none",
      });
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue.original'),
    ).toContainText(/HELLO ?OCR 123/u);
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .notice'),
    ).toContainText(/local translation|本地翻译/iu);
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue.original'),
    ).not.toContainText("IGNORE OUTSIDE REGION");
    const subtitleOverlay = page.locator(
      '[data-norixortrans-ui="subtitle-overlay"]',
    );
    const cueCard = subtitleOverlay.locator(".cue-card");
    const dragHandle = subtitleOverlay.locator(".drag-handle");
    await cueCard.hover();
    const dragHandleBox = await dragHandle.boundingBox();
    if (!dragHandleBox) throw new Error("Missing OCR subtitle drag handle");
    await page.mouse.move(
      dragHandleBox.x + dragHandleBox.width / 2,
      dragHandleBox.y + dragHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      (selectionStart.x + selectionEnd.x) / 2,
      (selectionStart.y + selectionEnd.y) / 2,
      { steps: 4 },
    );
    await page.mouse.up();
    await expect(subtitleOverlay).toHaveAttribute("data-position", "custom");
    await expect(subtitleOverlay).toHaveAttribute(
      "data-ocr-safe-side",
      /above|below/u,
    );
    const cueCardBox = await cueCard.boundingBox();
    if (!cueCardBox) throw new Error("Missing OCR subtitle cue card");
    const selectedBounds = {
      left: Math.min(selectionStart.x, selectionEnd.x),
      top: Math.min(selectionStart.y, selectionEnd.y),
      right: Math.max(selectionStart.x, selectionEnd.x),
      bottom: Math.max(selectionStart.y, selectionEnd.y),
    };
    expect(
      cueCardBox.x + cueCardBox.width <= selectedBounds.left ||
        cueCardBox.x >= selectedBounds.right ||
        cueCardBox.y + cueCardBox.height <= selectedBounds.top ||
        cueCardBox.y >= selectedBounds.bottom,
    ).toBe(true);
    const playerFrame = page
      .frames()
      .find((frame) => frame.url() === playerUrl);
    if (!playerFrame) throw new Error("Missing OCR canvas-player frame");
    const warmedCueStartedAt = Date.now();
    await playerFrame.evaluate(() => {
      const drawSubtitle = (
        globalThis as typeof globalThis & {
          drawSubtitle?: (subtitle: string) => void;
        }
      ).drawSubtitle;
      if (!drawSubtitle) throw new Error("Missing OCR subtitle redraw helper");
      drawSubtitle("SECOND OCR LINE");
    });
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue.original'),
    ).toHaveText(/^SECOND ?OCR ?LINE$/u, { timeout: 2_500 });
    const warmedCueLatencyMs = Date.now() - warmedCueStartedAt;
    expect(
      warmedCueLatencyMs,
      `warmed OCR cue latency was ${warmedCueLatencyMs}ms`,
    ).toBeLessThan(2_500);
    await expect
      .poll(async () => {
        const status = await subtitleStatus(pageUrl);
        return status
          ? {
              source: status.source,
              completeness: status.completeness,
              completed: status.completed,
              failed: status.failed,
            }
          : null;
      })
      .toMatchObject({
        source: "ocr",
        completeness: "stream",
        completed: 0,
        failed: 2,
      });
    expect(providerRequests).toBe(0);
    await controlPage.bringToFront();
    await page.waitForTimeout(1_200);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector("norixor-floating-control")
              ?.shadowRoot?.querySelector(".ocr-section .status-row")
              ?.textContent?.replace(/\s+/gu, " ")
              .trim() ?? "",
        ),
      )
      .toMatch(/paused|已暂停/iu);
    await page.bringToFront();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector("norixor-floating-control")
              ?.shadowRoot?.querySelector(".ocr-section .status-row")
              ?.textContent?.replace(/\s+/gu, " ")
              .trim() ?? "",
        ),
      )
      .not.toMatch(/paused|已暂停/iu);
    await page.locator("#fullscreen").click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.fullscreenElement instanceof HTMLIFrameElement &&
            document.fullscreenElement.id === "player",
        ),
      )
      .toBe(true);
    await expect(floatingControl).toHaveAttribute(
      "data-fullscreen-hidden",
      "false",
    );
    await expect(floatingControl.locator(".launcher")).toBeVisible();
    await expect
      .poll(() =>
        floatingControl.evaluate(
          (element) =>
            element.parentElement?.getAttribute("data-norixortrans-ui") ?? "",
        ),
      )
      .toBe("floating-control-fullscreen-portal");
    await page
      .frameLocator("#player")
      .locator("canvas")
      .evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext("2d");
        if (context) {
          context.fillStyle = "#000";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
      });
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const row = document
              .querySelector("norixor-floating-control")
              ?.shadowRoot?.querySelector(".ocr-section .status-row");
            return {
              state: row?.getAttribute("data-state") ?? "",
              text: row?.textContent?.replace(/\s+/gu, " ").trim() ?? "",
            };
          }),
        { timeout: 25_000 },
      )
      .toMatchObject({
        state: "unavailable",
        text: expect.stringMatching(/protected|受.*保护|DRM/iu),
      });
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .notice'),
    ).toContainText(/protected|受.*保护|DRM/iu);
    await expect(
      page.locator('[data-norixortrans-ui="subtitle-overlay"] .cue-card'),
    ).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement !== null))
      .toBe(true);
    await page.keyboard.press("Escape");
  } finally {
    context.off("request", recordProviderRequest);
    await controlPage.evaluate(
      async ({ targetUrl, previous }) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((candidate) => candidate.url === targetUrl);
        if (tab?.id !== undefined) {
          await chrome.tabs
            .sendMessage(tab.id, { type: "OCR_STOP" }, { frameId: 0 })
            .catch(() => undefined);
        }
        const rawSettings: unknown = await chrome.runtime.sendMessage({
          type: "SETTINGS_GET",
        });
        if (
          typeof rawSettings !== "object" ||
          rawSettings === null ||
          !("ocr" in rawSettings)
        ) {
          throw new Error("Missing OCR settings");
        }
        const settings = rawSettings as Record<string, unknown> & {
          ocr: { enabled: boolean };
          provider?: Record<string, unknown>;
        };
        await chrome.runtime.sendMessage({
          type: "SETTINGS_SET",
          settings: {
            ...settings,
            ...(settings.provider
              ? {
                  provider: {
                    ...settings.provider,
                    timeoutMs: previous.providerTimeoutMs,
                  },
                }
              : {}),
            ocr: previous.ocr,
          },
        });
      },
      { targetUrl: pageUrl, previous: previousOcr },
    );
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(playerUrl);
  }
});
