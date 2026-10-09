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
import {
  FLOATING_CONTROL_SELECTOR,
  FLOATING_PORTAL_SURFACE,
  floatingAction,
  floatingControl,
  floatingLauncher,
  floatingPanel,
  floatingParentSurface,
  floatingSelect,
  floatingSwitch,
  floatingTab,
  floatingTabBody,
  launcherRing,
  openFloatingEditor,
  openFloatingPanel,
  openFloatingSection,
  openFloatingTab,
} from "./floating-control";

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
const ocrRuntimeDirectory = process.env.NORITRANS_OCR_RUNTIME_DIR?.trim();
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
  process.env.NORITRANS_OCR_CAPTURE_E2E === "1" && hasLocalOcrRuntime;
let context: BrowserContext;
let controlPage: Page;
const partialJsonRequestSegmentCounts: number[] = [];
const smoothingProviderRequests: Array<{
  system: string;
  segments: unknown[];
}> = [];
const partialStreamRequestSegmentCounts: number[] = [];
const selectionProviderTexts: string[] = [];
const dynamicDuplicateProviderTexts: string[] = [];
const emptyStreamFallbackModes: boolean[] = [];
let retryBlockFailuresRemaining = 0;
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

/**
 * Shows an options group or deep link by hash, the way the navigation links
 * and `OPTIONS_PAGE_OPEN` do.
 */
async function openOptionsSection(page: Page, hash: string): Promise<void> {
  await page.evaluate((value) => {
    if (window.location.hash === `#${value}`) {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      window.location.hash = value;
    }
  }, hash);
  await expect(page.locator(".opt-group:not([hidden])")).toHaveCount(1);
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
  command:
    "PAGE_TRANSLATE" | "PAGE_RESTORE" | "PAGE_RETRY_FAILED" | "PAGE_CANCEL",
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
        if (texts.some((text) => text.includes("SLOW_BLOCK_E2E"))) {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
        if (
          retryBlockFailuresRemaining > 0 &&
          texts.some((text) => text.includes("RETRY_BLOCK_E2E"))
        ) {
          retryBlockFailuresRemaining -= 1;
          await route.fulfill({ status: 503, body: '{"error":"upstream"}' });
          return;
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
      if (sourceText.includes("SMOOTH_E2E")) {
        const system = messages.find(
          (candidate: unknown) =>
            isRecord(candidate) &&
            candidate.role === "system" &&
            typeof candidate.content === "string",
        );
        smoothingProviderRequests.push({
          system:
            isRecord(system) && typeof system.content === "string"
              ? system.content
              : "",
          segments: requestBody.segments as unknown[],
        });
      }
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

test("popup keeps the title bar icon centered and the shell at 360px", async () => {
  const extensionId = new URL(controlPage.url()).host;
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(page.locator("nt-icon-button#open-options")).toHaveCount(1);
    const geometry = await page.evaluate(() => {
      const rect = (element: Element) => {
        const value = element.getBoundingClientRect();
        return {
          centerX: value.left + value.width / 2,
          centerY: value.top + value.height / 2,
        };
      };
      const host = document.querySelector("nt-icon-button#open-options")!;
      const button = host.shadowRoot!.querySelector("button")!;
      const icon = button.querySelector("svg")!;
      return {
        popupWidth: document.querySelector("main")!.getBoundingClientRect()
          .width,
        unresolvedMessages:
          document.documentElement.outerHTML.includes("__MSG_"),
        subtitleTaskControls: document.querySelectorAll(
          "#retry-subtitles, #cancel-subtitles, #subtitle-task-panel",
        ).length,
        bodyWidth: document.body.getBoundingClientRect().width,
        buttonSize: button.getBoundingClientRect().width,
        shellRightInset:
          document.querySelector("main")!.getBoundingClientRect().right -
          host.getBoundingClientRect().right,
        gearDeltaX: rect(icon).centerX - rect(button).centerX,
        gearDeltaY: rect(icon).centerY - rect(button).centerY,
      };
    });

    expect(geometry.popupWidth).toBe(360);
    expect(geometry.unresolvedMessages).toBe(false);
    expect(geometry.subtitleTaskControls).toBe(0);
    expect(geometry.bodyWidth).toBe(360);
    expect(geometry.buttonSize).toBeGreaterThanOrEqual(40);
    // The title bar pads the settings button by 8px from the shell edge.
    expect(geometry.shellRightInset).toBeGreaterThanOrEqual(7.5);
    expect(geometry.shellRightInset).toBeLessThanOrEqual(8.5);
    expect(Math.abs(geometry.gearDeltaX)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(geometry.gearDeltaY)).toBeLessThanOrEqual(0.5);

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
      "declarativeNetRequestWithHostAccess",
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
  const fixtureUrl = "https://popup-theme.example.net/";
  await context.route(fixtureUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Popup theme</title><main><p>Popup theme fixture.</p></main>",
    }),
  );
  const target = await context.newPage();
  await target.goto(fixtureUrl);
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
    // The popup acts on the active tab; a web page there gives its card a
    // primary action ("Translate") to inspect.
    await target.bringToFront();
    await expect(page.locator('nt-button[data-primary="true"]')).toBeVisible({
      timeout: 15_000,
    });
    const popupDark = await page.evaluate(() => {
      const host = document.querySelector("nt-icon-button")!;
      const button = host.shadowRoot!.querySelector("button")!;
      const primary = document
        .querySelector('nt-button[data-primary="true"]')!
        .shadowRoot!.querySelector("button")!;
      return {
        background: getComputedStyle(document.body).backgroundColor,
        overflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        buttonHeight: button.getBoundingClientRect().height,
        transitionDuration: getComputedStyle(button).transitionDuration,
        primaryBackground: getComputedStyle(primary).backgroundColor,
        primaryBackgroundImage: getComputedStyle(primary).backgroundImage,
        primaryColor: getComputedStyle(primary).color,
      };
    });
    expect(lightBackground).toBe("rgb(255, 255, 255)");
    expect(popupDark.background).toBe("rgb(24, 22, 48)");
    expect(popupDark.overflow).toBe(false);
    expect(popupDark.buttonHeight).toBeGreaterThanOrEqual(40);
    expect(Number.parseFloat(popupDark.transitionDuration)).toBeLessThanOrEqual(
      0.001,
    );
    // Dark tokens: accent #a08cff with on-accent #120f2a text.
    expect(popupDark.primaryBackground).toBe("rgb(160, 140, 255)");
    expect(popupDark.primaryBackgroundImage).toBe("none");
    expect(popupDark.primaryColor).toBe("rgb(18, 15, 42)");

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
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(2);
    const groupLinks = page.locator(".opt-nav a[data-group]");
    await expect(groupLinks).toHaveCount(6);
    await expect(groupLinks.first()).toHaveAttribute("aria-current", "page");
    await page.goto(
      `chrome-extension://${extensionId}/options.html#visibility`,
    );
    await expect(page.locator("#group-general")).toBeVisible();
    await expect(
      page.locator("#floating-control-enabled button"),
    ).toHaveAccessibleName(/floating control|浮动控制|浮窗/iu);
    await expect(page.locator("#restore-session-floating")).toBeVisible();
    await page.locator('.opt-nav a[data-group="page"]').click();
    await expect(page).toHaveURL(/#page$/u);
    await page.locator("#selection-translation > summary").click();
    await expect(
      page.locator("#selection-translation-enabled button"),
    ).toHaveAccessibleName(/selection translation|划词翻译/iu);
    await page.locator('.opt-nav a[data-group="sites"]').click();
    await expect(page.locator("#clear-cache")).toBeHidden();
    const builtInProfiles = page.locator(
      '#site-list-builtin .site-entry[data-kind="builtin"]',
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
    await expect(page.locator("#site-list-builtin-title .count")).toHaveText(
      "18",
    );
    await page.locator('.opt-nav a[data-group="privacy"]').click();
    await expect(page.locator("#clear-cache")).toBeVisible();
    await expect(page.locator("#host-permission-note")).toContainText(
      "https://*/*",
    );
    // Group links are one plain tab sequence.
    await page.locator('.opt-nav a[data-group="privacy"]').focus();
    await page.keyboard.press("Tab");
    await expect(
      page.locator('.opt-nav a[data-group="general"]'),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#group-general")).toBeVisible();
    await expect(page.locator("#clear-cache")).toBeHidden();
    await page.goto(`chrome-extension://${extensionId}/options.html#ocr`);
    await expect(page.locator("#image-recognition")).toHaveAttribute(
      "open",
      "",
    );
    await expect(page.locator("#ocr-runtimes-panel")).toContainText(
      /device|设备/iu,
    );
    await expect(page.locator("#group-video")).not.toContainText(
      /PP-OCR|ONNX|SHA-256|物理模型|physical model/iu,
    );
    await page.goto(`chrome-extension://${extensionId}/options.html#page`);
    await expect(page.locator("#page-source-language select")).toBeVisible();
    const optionsGeometry = await page.evaluate(() => {
      const select = document
        .querySelector("#page-source-language")!
        .shadowRoot!.querySelector("select")!;
      return {
        controlHeight: select.getBoundingClientRect().height,
        overflow:
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth,
        navHeight: document
          .querySelector<HTMLElement>(".opt-nav a")!
          .getBoundingClientRect().height,
        navPosition: getComputedStyle(
          document.querySelector<HTMLElement>(".opt-nav")!,
        ).overflowX,
        transitionDuration: getComputedStyle(
          document.querySelector("#group-page details.adv > summary .chev")!,
        ).transitionDuration,
        unresolvedMessages:
          document.documentElement.outerHTML.includes("__MSG_"),
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        selectBackground: getComputedStyle(select).backgroundColor,
        selectColor: getComputedStyle(select).color,
      };
    });
    // Narrow layouts retain a 44px touch target; desktop settings use 40px.
    expect(optionsGeometry.controlHeight).toBe(44);
    expect(optionsGeometry.overflow).toBe(false);
    expect(optionsGeometry.navHeight).toBeGreaterThanOrEqual(44);
    expect(optionsGeometry.navPosition).toBe("auto");
    expect(
      Number.parseFloat(optionsGeometry.transitionDuration),
    ).toBeLessThanOrEqual(0.001);
    expect(optionsGeometry.unresolvedMessages).toBe(false);
    // Dark tokens of src/ui/tokens/tokens.ts: bg #0e0d1a, surface #181630.
    expect(optionsGeometry.bodyBackground).toBe("rgb(14, 13, 26)");
    expect(optionsGeometry.selectBackground).toBe("rgb(24, 22, 48)");
    expect(optionsGeometry.selectColor).toBe("rgb(241, 239, 255)");

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

    const darkFloatingPageUrl = "https://example.com/noritrans-dark-selects";
    await context.route(darkFloatingPageUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><html><body><main>Dark select fixture</main></body></html>",
      }),
    );
    await page.goto(darkFloatingPageUrl);
    const darkControl = floatingControl(page);
    await expect(darkControl).toBeAttached();
    const darkEditor = await openFloatingEditor(
      await openFloatingTab(darkControl, "page"),
    );
    const darkSelect = floatingSelect(darkEditor, "source");
    await expect(darkSelect).toBeVisible();
    const floatingSelectPalette = await darkSelect.evaluate((element) => {
      const select = element as HTMLSelectElement;
      const option = select.options[0];
      if (!option) return null;
      return {
        colorScheme: getComputedStyle(select).colorScheme,
        selectBackground: getComputedStyle(select).backgroundColor,
        optionColor: getComputedStyle(option).color,
      };
    });
    // Dark tokens of src/ui/tokens/tokens.ts: surface #181630, fg #f1efff.
    expect(floatingSelectPalette).toEqual({
      colorScheme: "dark",
      selectBackground: "rgb(24, 22, 48)",
      optionColor: "rgb(241, 239, 255)",
    });
  } finally {
    await page.close();
    await target.close();
    await context.unroute(fixtureUrl);
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
    await openOptionsSection(controlPage, "ocr");
    await expect(controlPage.locator("#ocr-runtime-list")).toBeVisible();
    await expect(controlPage.locator("#ocr-runtime-list")).not.toHaveAttribute(
      "aria-live",
      /.+/u,
    );
    await expect(controlPage.locator("#ocr-runtime-message")).toHaveAttribute(
      "role",
      "status",
    );
    await expect(controlPage.locator("#ocr-runtime-list .rt-item")).toHaveCount(
      3,
    );
    await openOptionsSection(controlPage, "sites");
    const builtInProfiles = controlPage.locator(
      '.site-entry[data-kind="builtin"]',
    );
    await expect(builtInProfiles).toHaveCount(18);
    const builtInList = controlPage.locator("#site-list-builtin");
    await expect(builtInList).toContainText("Max / HBO Max");
    await expect(builtInList).toContainText("Disney+");
    await expect(builtInList).toContainText("Prime Video");
    await expect(builtInList).toContainText("TVer");
    await expect(
      controlPage.locator('#ocr-runtime-list .rt-item[data-state="missing"]'),
    ).toHaveCount(3);
    await expect(
      controlPage.locator("#ocr-runtime-download-all"),
    ).toBeEnabled();
    expect(modelRequests).toEqual([]);
    await openOptionsSection(controlPage, "ocr");
    const focusedRuntimeAction = await controlPage.evaluate(() => {
      const host = document.querySelector<HTMLElement>(
        '#ocr-runtime-list nt-button[data-runtime-action="download"]',
      );
      const button = host?.shadowRoot?.querySelector("button");
      if (!host || !button) {
        throw new Error("Missing OCR runtime download action");
      }
      const identity = { pack: host.dataset.runtimePack };
      button.focus();
      // The explicit action may start a download when the optional origin is
      // already granted. Its synchronous and polled rerenders must keep focus.
      button.click();
      const active = document.activeElement as HTMLElement | null;
      return {
        expected: identity,
        actual: { pack: active?.dataset.runtimePack },
      };
    });
    expect(focusedRuntimeAction.actual).toEqual(focusedRuntimeAction.expected);
    await controlPage.waitForTimeout(300);
    await expect
      .poll(() =>
        controlPage.evaluate(() => {
          const active = document.activeElement as HTMLElement | null;
          return { pack: active?.dataset.runtimePack };
        }),
      )
      .toEqual(focusedRuntimeAction.expected);
  } finally {
    await context.unroute(modelUrl, blockExplicitModelDownload);
    context.off("request", captureModelRequest);
  }
});

test("site Profile synchronizes visual and developer management", async () => {
  await openOptionsSection(controlPage, "sites");
  const builtIn = controlPage.locator('.site-entry[data-kind="builtin"]');
  await expect(builtIn.first()).toBeVisible();
  await expect(
    controlPage.locator(".site-entry", {
      hasText: "Standard HTML5 TextTrack",
    }),
  ).toHaveCount(0);
  const entryLayout = await builtIn.first().evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
    parentWidth: element.parentElement?.getBoundingClientRect().width ?? 0,
  }));
  expect(entryLayout.width).toBeGreaterThan(entryLayout.parentWidth - 2);
  expect(entryLayout.height).toBeGreaterThanOrEqual(44);

  // List -> detail: focus moves to the site's heading.
  await controlPage.locator("#site-entry-youtube").click();
  await expect(controlPage.locator("#site-detail-title")).toBeFocused();
  await expect(controlPage.locator("#site-detail-title")).toHaveText("YouTube");
  // Advanced capture rules and the developer Profile start collapsed.
  await expect(controlPage.locator("#site-capture-parser")).toBeHidden();
  await expect(controlPage.locator("#site-profile-json")).toBeHidden();
  await controlPage.locator("#site-developer > summary").click();
  const json = controlPage.locator("#site-profile-json textarea");
  await expect(json).toBeVisible();
  const profileText = await json.inputValue();
  await controlPage.locator("#site-profile-file").setInputFiles({
    name: "youtube.profile.json",
    mimeType: "application/json",
    buffer: Buffer.from(profileText),
  });
  await expect(controlPage.locator("#site-profile-message")).toContainText(
    /imported|已导入/iu,
  );
  const downloadPromise = controlPage.waitForEvent("download");
  await controlPage.locator("#site-profile-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("youtube.profile.json");

  // Surface fields appear only after "set separately for this site".
  await expect(controlPage.locator("#site-page-auto-translate")).toHaveCount(0);
  await controlPage.locator("#site-page-override button").click();
  await controlPage.locator("#site-page-auto-translate button").click();
  await controlPage.locator("#site-page-floating-button button").click();
  await expect(json).toHaveValue(
    /"autoTranslate": true[\s\S]*"floatingButtonEnabled": false/u,
  );

  await controlPage.locator("#site-capture > summary").click();
  await expect(
    controlPage.locator("#site-capture-customized button"),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    controlPage.locator("#site-capture-parser select"),
  ).toBeDisabled();
  await controlPage.locator("#site-capture-customized button").click();
  await expect(
    controlPage.locator("#site-capture-parser select"),
  ).toBeEnabled();
  await expect(json).toHaveValue(
    /"subtitleCapture": \{[\s\S]*"customized": true/u,
  );
  await controlPage.locator("#site-profile-save").click();
  const kind = controlPage.locator(".site-detail nt-chip[data-kind]");
  await expect(kind).toHaveAttribute("data-kind", "override");
  await controlPage.locator("#site-profile-restore").click();
  await expect(controlPage.locator("#opt-confirm")).toBeVisible();
  await controlPage.locator("#opt-confirm-accept").click();
  await expect(kind).toHaveAttribute("data-kind", "builtin");
  await controlPage.locator("#site-profile-back").click();
  await expect(controlPage.locator("#site-entry-youtube")).toBeFocused();
});

test("strips the browser Origin from extension Provider requests only", async () => {
  // Playwright's request interception runs before declarativeNetRequest
  // header edits, so it still reports the Origin. Chrome's own matcher is the
  // reliable in-browser check; a live echo server confirmed that the header
  // is absent on the wire when this rule matches.
  const extensionId = new URL(controlPage.url()).host;
  const setBaseUrl = (baseUrl: string) =>
    controlPage.evaluate(async (url) => {
      const stored: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (
        typeof stored !== "object" ||
        stored === null ||
        !("provider" in stored) ||
        typeof stored.provider !== "object" ||
        stored.provider === null ||
        !("baseUrl" in stored.provider) ||
        typeof stored.provider.baseUrl !== "string"
      ) {
        throw new Error("Missing Provider settings");
      }
      const previous = stored.provider.baseUrl;
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: { ...stored, provider: { ...stored.provider, baseUrl: url } },
      });
      return previous;
    }, baseUrl);
  const matchedRuleIds = (url: string, initiator: string) =>
    controlPage.evaluate(
      async ({ requestUrl, requestInitiator }) => {
        const outcome = await chrome.declarativeNetRequest.testMatchOutcome({
          url: requestUrl,
          type: "xmlhttprequest",
          method: "post",
          initiator: requestInitiator,
        });
        return outcome.matchedRules.map((rule) => rule.ruleId);
      },
      { requestUrl: url, requestInitiator: initiator },
    );
  const extensionOrigin = `chrome-extension://${extensionId}`;
  const previousBaseUrl = await setBaseUrl("https://origin-gateway.example/v1");
  try {
    await expect
      .poll(() =>
        matchedRuleIds(
          "https://origin-gateway.example/v1/chat/completions",
          extensionOrigin,
        ),
      )
      .toEqual([1]);
    expect(
      await matchedRuleIds(
        "https://translation.googleapis.com/language/translate/v2",
        extensionOrigin,
      ),
    ).toEqual([1]);
    // Pages calling the same host keep their Origin.
    expect(
      await matchedRuleIds(
        "https://origin-gateway.example/v1/chat/completions",
        "https://origin-page.example",
      ),
    ).toEqual([]);
    // Unrelated hosts are untouched.
    expect(
      await matchedRuleIds("https://unrelated.example/api", extensionOrigin),
    ).toEqual([]);

    await setBaseUrl("https://moved-gateway.example/v1");
    await expect
      .poll(() =>
        matchedRuleIds(
          "https://moved-gateway.example/v1/chat/completions",
          extensionOrigin,
        ),
      )
      .toEqual([1]);
    expect(
      await matchedRuleIds(
        "https://origin-gateway.example/v1/chat/completions",
        extensionOrigin,
      ),
    ).toEqual([]);
  } finally {
    await setBaseUrl(previousBaseUrl);
  }
});

test("options saves a valid provider through the background settings boundary", async () => {
  await expect
    .poll(() =>
      controlPage.evaluate(() =>
        document.documentElement.outerHTML.includes("__MSG_"),
      ),
    )
    .toBe(false);
  await openOptionsSection(controlPage, "sites");
  const siteEntries = controlPage.locator(".site-entry");
  await expect(siteEntries.first()).toBeVisible();
  await expect(
    controlPage.locator(".site-entry", { hasText: "Standard HTML5 TextTrack" }),
  ).toHaveCount(0);
  await openOptionsSection(controlPage, "providers");
  await expect(
    controlPage.locator('#fast-provider option[value="openai-compatible"]'),
  ).toHaveCount(0);
  await expect(controlPage.locator("#ai-provider option")).toHaveCount(2);
  await controlPage.locator("#base-url input").fill(providerBaseUrl);
  await controlPage.locator("#api-key input").fill("e2e-options-key");
  await controlPage.locator("#model input").fill("e2e-options-model");
  if (!(await controlPage.locator("#ai-advanced").getAttribute("open"))) {
    await controlPage.locator("#ai-advanced > summary").click();
  }
  await controlPage.locator('#timeout [role="spinbutton"]').press("End");
  // Credentials are never autosaved: nothing is written before "Save".
  await expect(controlPage.locator("#test-message")).not.toBeEmpty();
  await controlPage.locator("#save-provider").click();
  await expect(controlPage.locator("#test-message")).toHaveAttribute(
    "data-tone",
    "success",
  );
  const translationMethodValues = TRANSLATION_METHODS.map(
    (method) => method.value,
  );
  expect(translationMethodValues).not.toContain("norixor");
  await expect(controlPage.locator("#norixor-settings-tab")).toHaveCount(0);

  // Everything else autosaves field by field.
  const segment = (id: string, value: string) =>
    controlPage.locator(`#${id} .seg[data-value="${value}"]`);
  await openOptionsSection(controlPage, "page");
  for (const selector of ["#page-mode", "#image-mode"]) {
    await expect
      .poll(() =>
        controlPage
          .locator(`${selector} .seg`)
          .evaluateAll((buttons) =>
            buttons.map((button) => (button as HTMLElement).dataset.value),
          ),
      )
      .toEqual(["ai", "fast"]);
  }
  await segment("page-mode", "ai").click();
  await segment("page-response-mode", "batch").click();
  await openOptionsSection(controlPage, "selection");
  await segment("selection-translation-mode", "fast").click();
  await openOptionsSection(controlPage, "video");
  await segment("subtitle-response-mode", "stream").click();
  await controlPage
    .locator("#subtitle-target-language select")
    .selectOption("ja");
  await segment("subtitle-display-mode", "translated").click();
  await segment("subtitle-position", "top").click();
  await controlPage.locator("#subtitle-hide-native button").focus();
  await controlPage.locator("#subtitle-hide-native button").press("Space");
  const fontScale = controlPage.locator(
    '#subtitle-font-scale [role="spinbutton"]',
  );
  await fontScale.focus();
  await fontScale.press("Home");
  await fontScale.press("Enter");
  for (let step = 0; step < 10; step += 1) {
    await fontScale.press("ArrowUp");
  }
  await fontScale.press("Enter");
  const readStored = () =>
    controlPage.evaluate(async () => {
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
  await expect.poll(readStored).toMatchObject({
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
  const pageUrl = "https://example.com/noritrans-selection-translation";
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
    const host = page.locator("noritrans-selection-translation");
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
  await openOptionsSection(controlPage, "privacy");
  const dialog = controlPage.locator("#opt-confirm");
  for (const selector of ["#clear-cache", "#clear-credentials"]) {
    await controlPage.locator(selector).click();
    await expect(dialog).toBeVisible();
    await expect(controlPage.locator("#opt-confirm-title")).not.toBeEmpty();
    await expect(controlPage.locator("#opt-confirm-body")).not.toBeEmpty();
    await expect(controlPage.locator("#opt-confirm-cancel")).toBeFocused();
    await controlPage.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(controlPage.locator(selector)).toBeFocused();
    await expect(controlPage.locator(selector)).toBeEnabled();
  }
  // Cancelling kept the stored credentials.
  const apiKey = await controlPage.evaluate(async () => {
    const value: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    return typeof value === "object" &&
      value !== null &&
      "provider" in value &&
      typeof value.provider === "object" &&
      value.provider !== null &&
      "apiKey" in value.provider
      ? value.provider.apiKey
      : undefined;
  });
  expect(apiKey).toBeTruthy();
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

test("popup follows external floating-control settings and preserves them on its next edit", async () => {
  const extensionId = await extensionIdFor(context);
  const pageUrl = "https://popup-sync.example.net/";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Popup sync</title><main><p>Popup sync fixture.</p></main>",
    }),
  );
  const original = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!settings || typeof settings !== "object") {
      throw new Error("Missing settings for popup synchronization test");
    }
    return settings;
  });
  // Applies an external edit the way the options page does (read-modify-write).
  const editExternally = (floating: boolean, targetLanguage: string) =>
    controlPage.evaluate(
      async ({ floating, targetLanguage }) => {
        const settings: unknown = await chrome.runtime.sendMessage({
          type: "SETTINGS_GET",
        });
        if (
          typeof settings !== "object" ||
          settings === null ||
          !("page" in settings) ||
          typeof settings.page !== "object" ||
          settings.page === null ||
          !("subtitles" in settings) ||
          typeof settings.subtitles !== "object" ||
          settings.subtitles === null
        ) {
          throw new Error("Missing settings for external popup edit");
        }
        await chrome.runtime.sendMessage({
          type: "SETTINGS_SET",
          settings: {
            ...settings,
            page: {
              ...settings.page,
              floatingButtonEnabled: floating,
              targetLanguage,
            },
            subtitles: {
              ...settings.subtitles,
              floatingButtonEnabled: floating,
            },
          },
        });
      },
      { floating, targetLanguage },
    );
  const storedPage = () =>
    controlPage.evaluate(async () => {
      const settings: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      return typeof settings === "object" &&
        settings !== null &&
        "page" in settings
        ? settings.page
        : null;
    });
  const target = await context.newPage();
  const popup = await context.newPage();
  try {
    await editExternally(true, "zh-CN");
    await target.goto(pageUrl);
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    // The popup acts on the active tab; make the fixture page the active one
    // so the popup leaves its restricted (extension page) state.
    await target.bringToFront();
    const floating = popup.locator('nt-switch[data-switch="floating"] button');
    await expect(floating).toHaveAttribute("aria-checked", "true", {
      timeout: 15_000,
    });

    await editExternally(false, "es");
    await expect(floating).toHaveAttribute("aria-checked", "false");

    await editExternally(true, "es");
    await expect(floating).toHaveAttribute("aria-checked", "true");

    await floating.click();
    await expect(floating).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(storedPage)
      .toMatchObject({ floatingButtonEnabled: false, targetLanguage: "es" });
  } finally {
    await popup.close();
    await target.close();
    await context.unroute(pageUrl);
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
  await openOptionsSection(controlPage, "providers");
  await controlPage.locator("#base-url input").fill("http://remote.example/v1");
  await controlPage.locator("#save-provider").click();

  await expect(controlPage.locator("#test-message")).toHaveAttribute(
    "data-tone",
    "error",
  );
  await expect(controlPage.locator("#test-message")).toContainText("HTTPS");
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
  const pageUrl = "https://example.com/noritrans-unified-control";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html>
        <style>
          div[data-noritrans-ui="floating-control"] {
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
    const control = floatingControl(page);
    await expect(control).toBeVisible();
    await expect(floatingPanel(control)).toBeHidden();
    await floatingLauncher(control).click();
    await expect(floatingPanel(control)).toBeVisible();
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
      (await floatingPanel(control).boundingBox())?.width,
    ).toBeGreaterThanOrEqual(280);
    await expect(floatingTab(control, "page")).toBeFocused();
    // Image translation is a collapsible section of the page tab now, so
    // only the page and video tabs remain.
    await expect(control.locator('[role="tab"]')).toHaveCount(2);
    await expect(floatingTabBody(control, "page")).toBeVisible();
    await floatingTab(control, "video").click();
    await expect(floatingTabBody(control, "video")).toBeVisible();
    const launcher = floatingLauncher(control);
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
    await expect(floatingPanel(control)).toBeHidden();
    await page.mouse.move(400, 400);
    await expect(control).toHaveAttribute("data-edge-hidden", "true", {
      timeout: 2_000,
    });
    await expect
      .poll(() => control.evaluate((host) => getComputedStyle(host).transform))
      .toContain("-34");
    const hiddenLauncherBox = await launcher.boundingBox();
    if (!hiddenLauncherBox) throw new Error("Missing docked launcher geometry");
    // Exactly half of the 48px launcher (a half circle) stays visible.
    const visibleHalf = hiddenLauncherBox.x + hiddenLauncherBox.width;
    expect(visibleHalf).toBeGreaterThanOrEqual(23.5);
    expect(visibleHalf).toBeLessThanOrEqual(24.5);
    await expect
      .poll(() => launcherRing(control))
      .toMatchObject({ edge: "left" });
    await page.mouse.move(
      2,
      hiddenLauncherBox.y + hiddenLauncherBox.height / 2,
    );
    await expect(control).toHaveAttribute("data-edge-hidden", "true");
    await page.mouse.down();
    await page.mouse.up();
    await expect(control).toHaveAttribute("data-edge-hidden", "false");
    await expect(floatingPanel(control)).toBeVisible();
    await expect
      .poll(() => launcherRing(control))
      .toMatchObject({ edge: null });
    const reopenedPanel = await floatingPanel(control).boundingBox();
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
    const restoredControl = floatingControl(page);
    await expect(restoredControl).toHaveAttribute("data-docked-edge", "left");
    await expect(restoredControl).toHaveAttribute("data-edge-hidden", "true");
    const restoredLauncher = floatingLauncher(restoredControl);
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
    await expect(floatingControl(page)).toHaveCount(1);
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
    await expect(floatingControl(page)).toHaveCount(0);
    // Leftovers of an older build: the legacy control and overlay markers.
    await page.evaluate(() => {
      const staleControl = document.createElement("noritrans-floating-control");
      staleControl.dataset.noritransUi = "unified-floating-control";
      const staleOverlay = document.createElement("div");
      staleOverlay.dataset.noritransUi = "subtitle-overlay";
      staleOverlay.attachShadow({ mode: "open" }).innerHTML =
        '<button class="stop-button">Old cancel</button>';
      const staleVisibility = document.createElement("style");
      staleVisibility.dataset.noritransUi = "native-subtitle-visibility";
      const preservedTranslation = document.createElement(
        "noritrans-translation",
      );
      preservedTranslation.dataset.noritransTranslated = "stale-e2e-copy";
      preservedTranslation.textContent = "Preserved translation";
      document.documentElement.append(
        staleControl,
        staleOverlay,
        staleVisibility,
        preservedTranslation,
      );
    });
    await expect(page.locator("noritrans-floating-control")).toHaveCount(1);

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

    await expect(floatingControl(page)).toHaveCount(1, {
      timeout: 12_000,
    });
    await expect(page.locator("noritrans-floating-control")).toHaveCount(0);
    await expect(
      page.locator('[data-noritrans-ui="subtitle-overlay"]'),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-noritrans-ui="subtitle-overlay"] .stop-button'),
    ).toHaveCount(0);
    await expect(page.locator("noritrans-translation")).toContainText(
      "Preserved translation",
    );
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("unified page and selection modes persist independently", async () => {
  const pageUrl = "https://example.com/noritrans-page-mode-control";
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
    const control = floatingControl(page);
    const pagePanel = await openFloatingEditor(
      await openFloatingTab(control, "page"),
    );
    const sourceLanguage = floatingSelect(pagePanel, "source");
    const targetLanguage = floatingSelect(pagePanel, "target");
    const pageMode = floatingSelect(pagePanel, "method");
    const responseMode = floatingSelect(pagePanel, "response");
    const displayMode = pagePanel.locator('nt-segmented[data-field="display"]');
    // Selection translation is edited on the options page only; the floating
    // editor must keep its saved values untouched.
    await expect(pagePanel.locator('[data-field^="selection"]')).toHaveCount(0);
    await expect(pageMode).toHaveValue("fast:chrome-local");
    // The response mode only applies to AI and is not rendered for fast.
    await expect(responseMode).toHaveCount(0);
    await pageMode.selectOption("fast:bergamot-local");
    await expect(sourceLanguage).toHaveValue("auto");
    await expect(sourceLanguage.locator('option[value="auto"]')).toBeEnabled();
    await expect(
      sourceLanguage.locator('option[value="auto"]'),
    ).not.toContainText(/current method unavailable|当前方式不可用/iu);
    await pageMode.selectOption("fast:chrome-local");
    await expect(pageMode).toHaveValue("fast:chrome-local");
    await sourceLanguage.selectOption("en");
    await expect(sourceLanguage).toHaveValue("en");
    await targetLanguage.selectOption("ja");
    await expect(targetLanguage).toHaveValue("ja");
    await displayMode
      .locator('[role="radio"][data-value="translated"]')
      .click();
    await expect(
      displayMode.locator('[role="radio"][data-value="translated"]'),
    ).toHaveAttribute("aria-checked", "true");
    await pageMode.selectOption("ai");
    await expect(responseMode).toBeEnabled();
    await responseMode.selectOption("batch");
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
        selectionTranslationEnabled: true,
        selectionTranslationMode: "fast",
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
    const control = floatingControl(currentPage);
    // "Auto-translate this site" moved into the page tab's "Change" editor.
    const autoTranslate = floatingSwitch(
      await openFloatingEditor(await openFloatingTab(control, "page")),
      "auto",
    );
    await expect(autoTranslate).toHaveAccessibleName(
      /auto[- ]?translate|自动翻译/iu,
    );
    await expect(autoTranslate).toHaveAttribute("aria-checked", "false");
    await autoTranslate.click();
    await expect(autoTranslate).toHaveAttribute("aria-checked", "true");
    await expect(currentPage.locator("noritrans-translation")).toHaveCount(1);
    await expect(
      currentPage
        .frameLocator(`iframe[src="${currentFrameUrl}"]`)
        .locator("noritrans-translation"),
    ).toHaveCount(1);
    await backgroundPage.waitForTimeout(600);
    await expect(backgroundPage.locator("noritrans-translation")).toHaveCount(
      0,
    );

    await backgroundPage.goto(pageBNextUrl);
    await expect(backgroundPage.locator("noritrans-translation")).toHaveCount(
      1,
    );

    await currentPage.bringToFront();
    await openFloatingEditor(await openFloatingTab(control, "page"));
    await autoTranslate.click();
    await expect(autoTranslate).toHaveAttribute("aria-checked", "false");
    await backgroundPage.evaluate(() => {
      history.pushState({}, "", "/auto-scope-background-disabled");
      const main = document.querySelector("main");
      if (main) main.innerHTML = "<p>Auto translation is disabled.</p>";
    });
    await backgroundPage.waitForTimeout(900);
    await expect(backgroundPage.locator("noritrans-translation")).toHaveCount(
      0,
    );
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
  const pageUrl = "https://plain-http.example/noritrans-e2e";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>HTTPS fixture</title><main><p>Plain HTTPS page.</p></main>",
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const control = floatingControl(page);
    await expect(control).toHaveCount(1);
    await expect(control).toBeVisible();
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("restores a control hidden for the current browsing session", async () => {
  const pageUrl = "https://example.com/noritrans-session-hidden-control";
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
    let control = floatingControl(page);
    await expect(control).toBeVisible();
    await openFloatingPanel(control);
    await control.locator(".hd nt-icon-button.more").click();
    await control
      .locator('nt-menu [role="menuitem"][data-danger="false"]')
      .first()
      .click();
    await expect(control).toBeHidden();

    await page.reload();
    control = floatingControl(page);
    await expect(control).toBeAttached();
    await expect(control).toBeHidden();
    await openOptionsSection(controlPage, "visibility");
    await controlPage.locator("#restore-session-floating").click();
    await expect(control).toBeVisible();
    await expect(
      controlPage.locator("#restore-session-floating-message"),
    ).toHaveAttribute("data-tone", "success");
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("re-enables a permanently hidden control from Options on an already open page", async () => {
  const pageUrl = "https://example.com/noritrans-permanently-hidden-control";
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
    const control = floatingControl(page);
    await expect(control).toBeVisible();
    await openOptionsSection(controlPage, "visibility");
    const enabled = controlPage.locator("#floating-control-enabled button");
    await expect(enabled).toBeChecked();
    // The general group autosaves through SETTINGS_PATCH.
    await enabled.click();
    await expect(enabled).not.toBeChecked();
    await expect(control).toBeHidden();

    await enabled.click();
    await expect(enabled).toBeChecked();
    await expect(enabled).toBeEnabled();
    await expect(control).toBeVisible();

    // Pill announcements follow the setting on an already open page.
    const fab = control.locator("nt-pill-fab");
    await expect(fab).not.toHaveAttribute("silent", /.*/u);
    const announcements = controlPage.locator("#floating-announcements button");
    await announcements.click();
    await expect(announcements).not.toBeChecked();
    await expect(fab).toHaveAttribute("silent", "");
    await announcements.click();
    await expect(announcements).toBeChecked();
    await expect(fab).not.toHaveAttribute("silent", /.*/u);
  } finally {
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, previousSettings);
    await controlPage.reload();
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("shows skipped marks on a real page only while the setting is on", async () => {
  const pageUrl = "https://example.com/noritrans-skipped-marks";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>
        <p id="already">这是一段已经使用简体中文书写的网页内容，不需要再翻译。</p>
      </main>`,
    }),
  );
  // Automatic on-device source selection is what skips target-language text.
  const previous = await controlPage.evaluate(async () => {
    const raw: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    const stored = raw as {
      provider: Record<string, unknown>;
      page: Record<string, unknown>;
    };
    const previousSettings = structuredClone(stored);
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...stored,
        provider: { ...stored.provider, fastProvider: "chrome-local" },
        page: {
          ...stored.page,
          mode: "fast",
          sourceLanguage: "auto",
          targetLanguage: "zh-CN",
          showSkippedMarks: false,
        },
      },
    });
    return previousSettings;
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const marks = page.locator("noritrans-translation-pending");
    await sendContentCommand(pageUrl, "PAGE_TRANSLATE");
    await page.waitForTimeout(500);
    await expect(marks).toHaveCount(0);
    await sendContentCommand(pageUrl, "PAGE_RESTORE");

    await openOptionsSection(controlPage, "marks");
    const toggle = controlPage.locator("#page-show-skipped-marks button");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toBeChecked();
    await expect
      .poll(() =>
        controlPage.evaluate(async () => {
          const raw: unknown = await chrome.runtime.sendMessage({
            type: "SETTINGS_GET",
          });
          return (raw as { page: { showSkippedMarks: boolean } }).page
            .showSkippedMarks;
        }),
      )
      .toBe(true);
    await sendContentCommand(pageUrl, "PAGE_TRANSLATE");
    await expect(marks).toHaveCount(1);

    // Turning it off removes the marks already shown on the open page.
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(marks).toHaveCount(0);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, previous);
  }
});

test("shows the update banner in General and ignores the version", async () => {
  const extensionId = await extensionIdFor(context);
  await controlPage.evaluate(async () => {
    await chrome.storage.local.set({
      "noritrans:update-state-v1": {
        latestVersion: "99.0.0",
        releaseUrl: "https://github.com/Norixor/NoriTrans/releases/tag/v99.0.0",
        checkedAt: Date.now(),
      },
    });
  });
  try {
    await controlPage.goto(
      `chrome-extension://${extensionId}/options.html#general`,
    );
    // A hash-only navigation keeps the document; reload to read the status.
    await controlPage.reload();
    const banner = controlPage.locator("#update-banner");
    await expect(banner).toContainText("99.0.0");
    await expect(controlPage.locator("#update-status")).toContainText("99.0.0");
    await expect(controlPage.locator("#extension-version")).toHaveText(
      /\d+\.\d+\.\d+/u,
    );
    await expect(
      controlPage.locator("#third-party-notices a").first(),
    ).toHaveAttribute("href", /THIRD_PARTY_NOTICES\.txt$/u);
    await controlPage.locator("#update-banner-ignore").click();
    await expect(banner).toHaveCount(0);
    await expect(controlPage.locator("#update-status")).toContainText(
      /ignored|忽略/iu,
    );
  } finally {
    await controlPage.evaluate(async () => {
      await chrome.storage.local.remove([
        "noritrans:update-state-v1",
        "noritrans:update-preferences-v1",
      ]);
    });
    await controlPage.goto(`chrome-extension://${extensionId}/options.html`);
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
    const control = floatingControl(page);
    const ocrSection = await openFloatingSection(
      await openFloatingTab(control, "video"),
      "ocr",
    );
    const ocrToggle = floatingSwitch(ocrSection, "ocr-enabled");
    await expect(ocrToggle).toHaveAttribute("aria-checked", "false");
    const permissionWindow = permissionContext.waitForEvent("page");
    await ocrToggle.click();
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
    await expect(ocrToggle).toHaveAttribute("aria-checked", "false");
    await expect(ocrSection.locator('[data-ocr="notice"]')).toContainText(
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
    await expect(ocrToggle).toHaveAttribute("aria-checked", "false");
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
          noritrans-subtitle-profile-wizard { position:static !important; z-index:-1 !important; pointer-events:none !important }
        </style>
        <video></video>
        <div data-test-caption>Visible subtitle candidate</div>
        <button id="page-button" onclick="window.__pageClicks=(window.__pageClicks||0)+1">Page action</button>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const control = floatingControl(page);
    // "Create site profile" moved into the video tab's "Change" editor.
    const videoEditor = await openFloatingEditor(
      await openFloatingTab(control, "video"),
    );
    await videoEditor.locator('nt-button[data-field="profile"] button').click();

    const wizard = page.locator("noritrans-subtitle-profile-wizard");
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
    await expect(floatingLauncher(control)).toBeFocused();
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
    const overlay = page.locator('[data-noritrans-ui="subtitle-overlay"]');
    await expect(overlay.locator(".cue-card")).toBeHidden();

    const control = floatingControl(page);
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
    const videoBody = await openFloatingTab(control, "video");
    await page.locator(".txp_subtitle_line").evaluate((element) => {
      element.textContent = "Caption after stop";
    });
    // While discovery waits, the card offers "turn subtitle translation off"
    // (the previous control offered "stop").
    await floatingAction(videoBody, "disable").click();
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

    const pageWidget = floatingControl(page);
    await expect(pageWidget).toBeVisible();
    await expect(floatingPanel(pageWidget)).toBeHidden();
    await floatingLauncher(pageWidget).click();
    await expect(floatingPanel(pageWidget)).toBeVisible();

    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.querySelectorAll("noritrans-translation")].map(
            (host) => host.shadowRoot?.querySelector("span")?.textContent,
          ),
        ),
      )
      .toContain("已译 Hello page.");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const documentTranslations = [
            ...document.querySelectorAll("noritrans-translation"),
          ].map((host) => host.shadowRoot?.querySelector("span")?.textContent);
          const shadowTranslations = [
            ...(document
              .querySelector("#shadow-host")
              ?.shadowRoot?.querySelectorAll("noritrans-translation") ?? []),
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
      page.locator("#save-action > noritrans-translation"),
    ).toHaveAttribute("data-compact-interactive", "");
    await expect(
      page.locator("#docs-link > noritrans-translation"),
    ).toHaveAttribute("data-compact-interactive", "");
    await expect(
      page.locator("#save-action + noritrans-translation"),
    ).toHaveCount(0);
    await expect(
      page.locator("#docs-link + noritrans-translation"),
    ).toHaveCount(0);
    await expect(page.locator(".ytp-caption-segment")).toHaveText(
      "Native video caption",
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector("#cache-source + noritrans-translation")
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
              .querySelector("#cache-duplicate + noritrans-translation")
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
          [...document.querySelectorAll("noritrans-translation")].map(
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
              .querySelector("#click-detail + noritrans-translation")
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
              .querySelector("#hover-detail + noritrans-translation")
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
          [...document.querySelectorAll("noritrans-translation")].map(
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
          [...document.querySelectorAll("noritrans-translation")].map(
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
          [...document.querySelectorAll("noritrans-translation")].map(
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
    await expect(page.locator("noritrans-translation")).toHaveCount(0);
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
          link.__noritransIdentity = "preserved";
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
            (element) => Reflect.get(element, "__noritransIdentity") as unknown,
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
    await expect(floatingControl(page)).toHaveCount(1);
    await expect(floatingControl(embedded)).toHaveCount(0);
    await expect(floatingControl(secondEmbedded)).toHaveCount(0);

    await sendContentCommand(pageUrl, "PAGE_TRANSLATE");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document
            .querySelector("noritrans-translation")
            ?.shadowRoot?.querySelector("span")
            ?.textContent?.trim(),
        ),
      )
      .toBe("已译 Top frame copy.");
    await expect
      .poll(() =>
        embedded.locator("noritrans-translation span").first().textContent(),
      )
      .toBe("已译 Embedded frame copy.");
    await expect
      .poll(() =>
        secondEmbedded
          .locator("noritrans-translation span")
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
        '[data-noritrans-ui="subtitle-overlay"] .cue.translated',
      ),
    ).toContainText("已译 Embedded subtitle.");
    await expect(
      secondEmbedded.locator(
        '[data-noritrans-ui="subtitle-overlay"] .cue.translated',
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
      embedded.locator('[data-noritrans-ui="subtitle-overlay"] .cue.original'),
    ).toBeHidden();
    await expect(
      embedded.locator(
        '[data-noritrans-ui="subtitle-overlay"] .cue.translated',
      ),
    ).toBeVisible();

    const topControl = floatingControl(page);
    const videoBody = await openFloatingTab(topControl, "video");
    // A finished track offers "turn subtitle translation off" (the previous
    // control offered "stop"); it must reach every frame's overlay.
    await floatingAction(videoBody, "disable").click();
    await expect
      .poll(() => subtitleStatus(pageUrl))
      .toMatchObject({ state: "disabled" });
    await expect(
      embedded.locator('[data-noritrans-ui="subtitle-overlay"] .cue-card'),
    ).toBeHidden();
    await expect(
      secondEmbedded.locator(
        '[data-noritrans-ui="subtitle-overlay"] .cue-card',
      ),
    ).toBeHidden();
    await floatingAction(videoBody, "enable").click();
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
        '[data-noritrans-ui="subtitle-overlay"] .cue.translated',
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
        '[data-noritrans-ui="subtitle-overlay"] .cue.translated',
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
    await expect(page.locator("noritrans-translation")).toHaveCount(
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
        details: expect.stringContaining("Unknown result IDs: unexpected-id"),
      });

    const control = floatingControl(page);
    const pageBody = await openFloatingTab(control, "page");
    const diagnostic = pageBody.locator("nt-status-card.status details.diag");
    await expect(diagnostic).toBeVisible();
    // The error is spelled out by the card state, not only by color.
    await expect(pageBody.locator("nt-status-card.status")).toHaveAttribute(
      "state",
      "error",
    );
    await diagnostic.locator("summary").click();
    await expect(diagnostic.locator("pre")).toContainText(
      "Unknown result IDs: unexpected-id",
    );
    const diagnosticText = await diagnostic.locator("pre").textContent();
    expect(diagnosticText).not.toContain("INVALID_RESPONSE_DETAILS");
    expect(diagnosticText).not.toContain("e2e-only-key");
    await page.keyboard.press("Escape");
    await expect(diagnostic).not.toHaveAttribute("open", "");
    await expect(floatingPanel(control)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(floatingPanel(control)).toBeHidden();
    await expect(page.locator("noritrans-translation")).toHaveCount(0);
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

    const control = floatingControl(page);
    const pageBody = await openFloatingTab(control, "page");
    await expect(pageBody.locator("nt-status-card.status")).toBeVisible();
    await expect(pageBody.locator("details.diag")).toHaveCount(0);
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
    const previousSettings = await controlPage.evaluate(async () => {
      const settings: unknown = await chrome.runtime.sendMessage({
        type: "SETTINGS_GET",
      });
      if (
        !settings ||
        typeof settings !== "object" ||
        !("page" in settings) ||
        !settings.page ||
        typeof settings.page !== "object"
      ) {
        throw new Error("Missing page settings");
      }
      await chrome.runtime.sendMessage({
        type: "SETTINGS_SET",
        settings: {
          ...settings,
          page: { ...settings.page, mode: "ai" },
        },
      });
      return settings;
    });
    const page = await context.newPage();
    try {
      await page.goto(pageUrl);
      await sendContentCommand(pageUrl, "PAGE_TRANSLATE");
      await expect
        .poll(async () => await pageStatus(pageUrl))
        .toMatchObject({ state: "error", completed: 0, failed: 1 });
      await expect(page.locator("noritrans-translation")).toHaveCount(0);
    } finally {
      await controlPage.evaluate(async (settings) => {
        await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
      }, previousSettings);
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
    await expect(page.locator("noritrans-translation")).toHaveCount(0);
    expect(await pageStatus(pageUrl)).toMatchObject({
      state: "idle",
      completed: 0,
    });
  } finally {
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("marks a failed block in-page and retries only that block from the marker", async () => {
  const pageUrl = "https://www.youtube.com/page-retry-block";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main style="max-width:600px;margin:40px auto">${Array.from(
        { length: 21 },
        (_, index) =>
          `<p id="block-${index + 1}">${index === 20 ? "RETRY_BLOCK_E2E" : "Stable"} paragraph ${index + 1}.</p>`,
      ).join("")}</main>`,
    }),
  );
  const previousSettings = await controlPage.evaluate(async () => {
    const settings: unknown = await chrome.runtime.sendMessage({
      type: "SETTINGS_GET",
    });
    if (!isRecordLike(settings) || !isRecordLike(settings.page)) {
      throw new Error("Missing page settings");
    }
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...settings,
        page: { ...settings.page, mode: "fast", displayMode: "bilingual" },
      },
    });
    return settings;
    function isRecordLike(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null;
    }
  });
  retryBlockFailuresRemaining = 1;
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await sendContentCommand(pageUrl, "PAGE_TRANSLATE");
    await expect
      .poll(async () => await pageStatus(pageUrl))
      .toMatchObject({ state: "partial", total: 21, completed: 20, failed: 1 });
    // Server errors carry their own reason and message, not "check settings".
    expect((await pageStatus(pageUrl))?.message).toMatch(/server error/iu);
    const overlay = page.locator("noritrans-translation-pending");
    await expect(overlay).toHaveCount(1);
    await expect(page.locator("noritrans-translation")).toHaveCount(20);

    // The retry marker is a keyboard-focusable button in the pending layer.
    await page.locator("#block-21").scrollIntoViewIfNeeded();
    // Marker positions are re-measured on the next animation frame.
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    // The pending layer uses a closed shadow root, so Playwright cannot query
    // the marker. It is keyboard-focusable: Tab until focus lands inside the
    // layer (document.activeElement is then the layer host) and press Enter.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    let markerFocused = false;
    for (let presses = 0; presses < 12 && !markerFocused; presses += 1) {
      await page.keyboard.press("Tab");
      markerFocused = await page.evaluate(
        () =>
          document.activeElement?.tagName.toLowerCase() ===
          "noritrans-translation-pending",
      );
    }
    expect(markerFocused).toBe(true);
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => await pageStatus(pageUrl))
      .toMatchObject({
        state: "translated",
        total: 21,
        completed: 21,
        failed: 0,
      });
    await expect(page.locator("noritrans-translation")).toHaveCount(21);
    await expect(overlay).toHaveCount(0);
    await expect(
      page.getByText("已译 RETRY_BLOCK_E2E paragraph 21.", { exact: true }),
    ).toBeVisible();
  } finally {
    retryBlockFailuresRemaining = 0;
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, previousSettings);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("cancels a page task while keeping translated blocks and lets the rest retry", async () => {
  const pageUrl = "https://www.youtube.com/page-cancel-keep";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><main>${Array.from(
        { length: 21 },
        (_, index) =>
          `<p id="keep-${index + 1}">${index === 20 ? "SLOW_BLOCK_E2E" : "Kept"} cancel paragraph ${index + 1}.</p>`,
      ).join("")}</main>`,
    }),
  );
  const previousSettings = await controlPage.evaluate(async () => {
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
      throw new Error("Missing page settings");
    }
    await chrome.runtime.sendMessage({
      type: "SETTINGS_SET",
      settings: {
        ...settings,
        page: { ...settings.page, mode: "fast", displayMode: "translated" },
      },
    });
    return settings;
  });
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await sendContentCommand(pageUrl, "PAGE_TRANSLATE");
    await expect
      .poll(async () => (await pageStatus(pageUrl))?.completed)
      .toBe(20);
    // The slow batch is still in flight: cancelling keeps the twenty
    // translated blocks and reports the remainder as retryable.
    await sendContentCommand(pageUrl, "PAGE_CANCEL");
    await expect
      .poll(async () => await pageStatus(pageUrl))
      .toMatchObject({
        state: "cancelled",
        total: 21,
        completed: 20,
        failed: 1,
      });
    await expect(page.locator("#keep-1")).toHaveText(
      "已译 Kept cancel paragraph 1.",
    );
    await page.waitForTimeout(1_700);
    await expect(page.locator("#keep-21")).toHaveText(
      "SLOW_BLOCK_E2E cancel paragraph 21.",
    );
    expect(await pageStatus(pageUrl)).toMatchObject({ state: "cancelled" });

    await sendContentCommand(pageUrl, "PAGE_RETRY_FAILED");
    await expect
      .poll(async () => await pageStatus(pageUrl))
      .toMatchObject({ state: "translated", completed: 21, failed: 0 });
    await expect(page.locator("#keep-21")).toHaveText(
      "已译 SLOW_BLOCK_E2E cancel paragraph 21.",
    );
  } finally {
    await controlPage.evaluate(async (settings) => {
      await chrome.runtime.sendMessage({ type: "SETTINGS_SET", settings });
    }, previousSettings);
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

    await expect(page.locator("noritrans-translation")).toHaveCount(0);
    await expect(page.locator("main > p").first()).toHaveText(
      "SLOW_TRANSLATION cache fixture 1.",
    );
    // Cache clearing interrupts the task: it is reported as cancelled with a
    // retryable remainder, not as a Provider error.
    expect(await pageStatus(pageUrl)).toMatchObject({
      state: "cancelled",
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
    // Sentence smoothing (on by default) keeps each cue as its own unit.
    expect(status.total).toBe(2);
    expect(status.completed).toBe(2);
  } finally {
    await page.close();
    await context.unroute(pageUrl);
    await context.unroute(trackUrl);
  }
});

test("smooths a split sentence per cue and restores sentence groups when turned off", async () => {
  const pageUrl = "https://www.youtube.com/sentence-smoothing-e2e";
  const trackUrl = "https://www.youtube.com/sentence-smoothing-fixture.vtt";
  // Synthetic, self-written lines; one sentence split across two cues.
  const first = "SMOOTH_E2E it always makes me so";
  const second = "sad, but I don't care.";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<html><head><title>Smoothing fixture</title></head><body><video><track kind="subtitles" srclang="en" default src="${trackUrl}"></video></body></html>`,
    }),
  );
  await context.route(trackUrl, (route) =>
    route.fulfill({
      contentType: "text/vtt",
      body: `WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${first}\n\n00:00:01.050 --> 00:00:02.000\n${second}\n`,
    }),
  );
  smoothingProviderRequests.length = 0;
  const overlay = (page: Page) =>
    page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.translated');
  const page = await context.newPage();
  let previous: Record<string, unknown> | undefined;
  try {
    await page.goto(pageUrl);
    const status = await waitForReadyTrack(pageUrl, {
      source: "texttrack",
      completeness: "full",
    });
    expect(status).toMatchObject({ total: 2, completed: 2, failed: 0 });
    // At 0s only the first cue is visible, with only its own translation.
    await expect(overlay(page)).toHaveText(`已译 ${first}`);
    expect(smoothingProviderRequests).toHaveLength(1);
    const smoothed = smoothingProviderRequests[0];
    expect(smoothed?.system).toContain("Subtitle fragments:");
    expect(smoothed?.segments).toHaveLength(2);
    const [firstSegment, secondSegment] = (smoothed?.segments ?? []) as Array<
      [string, string, string[], string[]]
    >;
    expect(firstSegment?.[1]).toBe(first);
    expect(firstSegment?.[3]).toEqual([second]);
    expect(secondSegment?.[1]).toBe(second);
    expect(secondSegment?.[2]).toEqual([first]);

    previous = await updateSubtitlePreferences({ sentenceSmoothing: false });
    expect(previous.sentenceSmoothing).toBe(true);
    await expect
      .poll(async () => {
        const current = await subtitleStatus(pageUrl);
        return current ? { state: current.state, total: current.total } : null;
      })
      .toEqual({ state: "ready", total: 1 });
    await expect(overlay(page)).toHaveText(`已译 ${first} ${second}`);
    expect(smoothingProviderRequests).toHaveLength(2);
    expect(smoothingProviderRequests[1]?.system).not.toContain(
      "Subtitle fragments:",
    );
  } finally {
    if (previous) await updateSubtitlePreferences(previous);
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

    const control = floatingControl(page);
    const videoBody = await openFloatingTab(control, "video");
    // The expanded launcher exposes the panel it controls (Chrome supports
    // ARIA element reflection across the shadow boundary).
    expect(
      await floatingLauncher(control).evaluate((button) => {
        const reflected = (
          button as HTMLButtonElement & { ariaControlsElements?: Element[] }
        ).ariaControlsElements;
        return reflected?.[0]?.id ?? button.getAttribute("aria-controls");
      }),
    ).toBe("nt-floating-panel");
    // Manual rescan restarts discovery through the card's "rescan" action;
    // "Try image recognition" alone does not rescan for a track, and the
    // card never offers to "enable" a feature that is already on.
    await expect(floatingAction(videoBody, "enable")).toHaveCount(0);
    const rescan = floatingAction(videoBody, "rescan");
    await expect(rescan).toBeEnabled();
    await rescan.click();
    await expect
      .poll(() => subtitleStatus(pageUrl))
      .toMatchObject({
        state: "waiting",
        total: 0,
      });
    // Discovery ends empty again, so the same action comes back.
    await expect(floatingAction(videoBody, "rescan")).toBeEnabled({
      timeout: 15_000,
    });
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
        details: expect.stringContaining("Unknown result IDs: unexpected-id"),
      });

    const control = floatingControl(page);
    const videoBody = await openFloatingTab(control, "video");
    const diagnostic = videoBody.locator("nt-status-card.status details.diag");
    await expect(diagnostic).toBeVisible();
    await diagnostic.locator("summary").click();
    await expect(diagnostic.locator("pre")).toContainText(
      "Unknown result IDs: unexpected-id",
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
      // Sentence smoothing (on by default) keeps each cue as its own unit.
      expect(status.total).toBe(2);
      expect(status.completed).toBe(2);
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
        window.addEventListener('noritrans:subtitle-response', () => {
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
      '[data-noritrans-ui="subtitle-overlay"] .cue-card',
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

test("keeps long subtitles scrolling inside the player width", async () => {
  const pageUrl = "https://www.youtube.com/watch?v=subtitle-scroll-e2e";
  const previous = await updateSubtitlePreferences({
    displayMode: "bilingual",
    position: "bottom",
  });
  const longCaption =
    "A long subtitle should stay inside the player window. ".repeat(12);
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>video{position:fixed;left:80px;top:80px;width:480px;height:270px}</style><button id="fullscreen" onclick="document.querySelector('video').requestFullscreen()">Fullscreen</button><video></video><div class="ytp-caption-window-container"><div class="ytp-caption-segment">${longCaption}</div></div>`,
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await waitForReadyTrack(pageUrl, { source: "dom", completeness: "stream" });
    const overlay = page.locator('[data-noritrans-ui="subtitle-overlay"]');
    const card = overlay.locator(".cue-card");
    const original = overlay.locator(".cue.original");
    await expect(original).toBeVisible();
    const assertContained = async (): Promise<void> => {
      const bounds = await card.boundingBox();
      const video = await page.locator("video").boundingBox();
      if (!bounds || !video) throw new Error("Missing subtitle geometry");
      expect(bounds.x).toBeGreaterThanOrEqual(Math.max(0, video.x));
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        video.x + video.width + 1,
      );
      expect(bounds.height).toBeLessThan(100);
    };
    await assertContained();
    await page.screenshot({
      path: test.info().outputPath("subtitle-scroll.png"),
    });
    await expect
      .poll(() =>
        original.evaluate((el) =>
          el
            .getAnimations({ subtree: true })
            .some((animation) => Number(animation.currentTime) > 900),
        ),
      )
      .toBe(true);
    await page.locator("#fullscreen").click();
    await expect
      .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
      .toBe(true);
    await expect(card).toBeVisible();
    await assertContained();
    await page.evaluate(() => document.exitFullscreen());
    await page.evaluate(() => {
      document.querySelector(".ytp-caption-segment")!.textContent =
        "Short caption";
    });
    await expect(original).toHaveText("Short caption");
    await expect
      .poll(() =>
        original.evaluate((el) => el.getAnimations({ subtree: true }).length),
      )
      .toBe(0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate((caption) => {
      document.querySelector(".ytp-caption-segment")!.textContent = caption;
    }, longCaption);
    await expect(original).toHaveText(longCaption.trim());
    await assertContained();
    await expect
      .poll(() =>
        original.evaluate((el) => el.getAnimations({ subtree: true }).length),
      )
      .toBe(0);
  } finally {
    await updateSubtitlePreferences(previous);
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
      page.locator('[data-noritrans-ui="subtitle-overlay"]'),
    ).toHaveAttribute("data-position", "top");
    const subtitleOverlay = page.locator(
      '[data-noritrans-ui="subtitle-overlay"]',
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
      .locator('[data-noritrans-ui="subtitle-overlay"]')
      .evaluate((host: HTMLElement) => ({
        x: host.style.getPropertyValue("--noritrans-anchor-x"),
        maxWidth: host.style.getPropertyValue("--noritrans-max-width"),
      }));
    expect(videoAnchoring).toEqual({ x: "440px", maxWidth: "512px" });
    const quickControl = floatingControl(page);
    await page.locator("#fullscreen").click();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.fullscreenElement instanceof HTMLVideoElement,
        ),
      )
      .toBe(true);
    await expect(
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue-card'),
    ).toBeVisible();
    await expect(floatingLauncher(quickControl)).toBeVisible();
    await expect(floatingPanel(quickControl)).toBeHidden();
    await expect
      .poll(() => floatingParentSurface(quickControl))
      .toBe(FLOATING_PORTAL_SURFACE);
    // A fullscreen <video> cannot host children, so the root-level portal is
    // inert and the button only shows status.
    await expect(quickControl.locator(".launcher")).toHaveAttribute(
      "data-status-only",
      "",
    );
    await page.evaluate(() => document.exitFullscreen());
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
    await expect(floatingLauncher(quickControl)).toBeVisible();
    await expect
      .poll(() =>
        quickControl.evaluate(
          (element) => element.parentElement === document.documentElement,
        ),
      )
      .toBe(true);
    await expect(quickControl.locator(".launcher")).not.toHaveAttribute(
      "data-status-only",
      /.*/u,
    );
    await expect(floatingPanel(quickControl)).toBeHidden();
    await floatingLauncher(quickControl).click();
    await expect(floatingPanel(quickControl)).toBeVisible();
    await floatingTab(quickControl, "video").click();
    await expect(floatingTabBody(quickControl, "video")).toBeVisible();
    await quickControl.locator(".hd nt-icon-button.close").click();
    await expect(floatingPanel(quickControl)).toBeHidden();

    await updateSubtitlePreferences({
      hideNativeSubtitles: false,
      position: "bottom",
    });
    await expect(page.locator(".ytp-caption-segment")).toHaveCSS(
      "visibility",
      "visible",
    );
    await expect(
      page.locator('[data-noritrans-ui="subtitle-overlay"]'),
    ).toHaveAttribute("data-position", "bottom");

    const dragHandle = page.locator(
      '[data-noritrans-ui="subtitle-overlay"] .cue-card',
    );
    await page
      .locator('[data-noritrans-ui="subtitle-overlay"] .cue-card')
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
      page.locator('[data-noritrans-ui="subtitle-overlay"]'),
    ).toHaveAttribute("data-position", "custom");

    await updateSubtitlePreferences({ hideNativeSubtitles: true });
    await expect(page.locator(".ytp-caption-segment")).toHaveCSS(
      "visibility",
      "hidden",
    );
    // A ready track offers "turn subtitle translation off" as its primary
    // action (the previous control offered "stop"); native captions return.
    await floatingAction(
      await openFloatingTab(quickControl, "video"),
      "disable",
    ).click();
    await expect(page.locator(".ytp-caption-segment")).toHaveCSS(
      "visibility",
      "visible",
    );
    await expect(
      page.locator('[data-noritrans-ui="subtitle-overlay"] .stop-button'),
    ).toHaveCount(0);
  } finally {
    await updateSubtitlePreferences(previous);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("keeps the subtitle overlay draggable inside a fullscreen container", async () => {
  const pageUrl =
    "https://www.youtube.com/watch?v=subtitle-fullscreen-drag-e2e";
  const previous = await updateSubtitlePreferences({
    displayMode: "translated",
    hideNativeSubtitles: false,
    position: "bottom",
  });
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><style>#stage{position:fixed;left:120px;top:80px;width:640px;height:360px;background:#000}video{display:block;width:100%;height:100%}</style><button id="fullscreen" onclick="document.querySelector(\'#stage\').requestFullscreen()">Fullscreen</button><div id="stage"><video></video></div><div class="ytp-caption-window-container"><div class="ytp-caption-segment">Native caption</div></div>',
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    await waitForReadyTrack(pageUrl, {
      source: "dom",
      completeness: "stream",
    });
    const overlay = page.locator('[data-noritrans-ui="subtitle-overlay"]');
    const card = overlay.locator(".cue-card");
    await expect(card).toBeVisible();

    await page.locator("#fullscreen").click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.id))
      .toBe("stage");
    // Chromium keeps pointer input only inside the fullscreen element's
    // subtree, so the overlay's portal has to live inside the container; a
    // root-level popover is painted but cannot be dragged.
    await expect
      .poll(() =>
        overlay.evaluate(
          (host: HTMLElement) => host.parentElement?.parentElement?.id,
        ),
      )
      .toBe("stage");
    await expect(card).toBeVisible();

    const before = await card.boundingBox();
    if (!before) throw new Error("Missing subtitle card geometry");
    await page.mouse.move(
      before.x + before.width / 2,
      before.y + before.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      before.x + before.width / 2 + 60,
      before.y + before.height / 2 - 80,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect(overlay).toHaveAttribute("data-position", "custom");
    const after = await card.boundingBox();
    if (!after) throw new Error("Missing moved subtitle card geometry");
    expect(after.y).toBeLessThan(before.y - 20);

    await page.evaluate(() => document.exitFullscreen());
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
    await expect
      .poll(() =>
        overlay.evaluate(
          (host: HTMLElement) =>
            host.parentElement === document.documentElement,
        ),
      )
      .toBe(true);
  } finally {
    await updateSubtitlePreferences(previous);
    await page.close();
    await context.unroute(pageUrl);
  }
});

test("keeps the floating control interactive inside a fullscreen container", async () => {
  const pageUrl = "https://www.youtube.com/fullscreen-container-control-e2e";
  await context.route(pageUrl, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><style>#stage{width:640px;height:360px;background:#18202b;color:#fff}#stage:fullscreen{width:100vw;height:100vh}</style><div id="stage"><p id="stage-text">Fullscreen stage paragraph.</p></div><button id="fullscreen" onclick="document.querySelector(\'#stage\').requestFullscreen()">Fullscreen</button>',
    }),
  );
  const page = await context.newPage();
  try {
    await page.goto(pageUrl);
    const control = floatingControl(page);
    await openFloatingPanel(control);
    // Keyboard activation keeps the panel open, so the expanded state from
    // before fullscreen can be checked after leaving it.
    await page.locator("#fullscreen").focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? ""))
      .toBe("stage");
    await expect
      .poll(() => floatingParentSurface(control))
      .toBe(FLOATING_PORTAL_SURFACE);
    expect(
      await control.evaluate(
        (host) => host.parentElement?.parentElement?.id ?? "",
      ),
    ).toBe("stage");
    // Entering fullscreen collapses the panel; the button stays interactive.
    await expect(floatingPanel(control)).toBeHidden();
    await expect(control.locator(".launcher")).not.toHaveAttribute(
      "data-status-only",
      /.*/u,
    );

    // Real pointer input (no synthetic dispatch): the click must reach the
    // button through the fullscreen top layer.
    const launcherBox = await floatingLauncher(control).boundingBox();
    if (!launcherBox) throw new Error("Missing fullscreen launcher geometry");
    await page.mouse.click(
      launcherBox.x + launcherBox.width / 2,
      launcherBox.y + launcherBox.height / 2,
    );
    await expect(floatingPanel(control)).toBeVisible();
    const pageBody = await openFloatingTab(control, "page");
    await floatingAction(pageBody, "translate").click();
    await expect
      .poll(() => pageStatus(pageUrl))
      .toMatchObject({ state: "translated", failed: 0 });
    expect((await pageStatus(pageUrl))?.completed).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? ""))
      .toBe("stage");
    await control.locator(".hd nt-icon-button.close").click();
    await expect(floatingPanel(control)).toBeHidden();
    // The finished state is a solid status arc that lies fully inside the
    // button: the pill clips its overflow for the announcement animation.
    await expect
      .poll(() => launcherRing(control), { timeout: 10_000 })
      .toEqual({ ring: "solid", edge: null, inside: true });

    await page.evaluate(() => document.exitFullscreen());
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === null))
      .toBe(true);
    await expect
      .poll(() =>
        control.evaluate(
          (host) => host.parentElement === document.documentElement,
        ),
      )
      .toBe(true);
    // Leaving fullscreen restores the panel that was open before.
    await expect(floatingPanel(control)).toBeVisible();
  } finally {
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
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.translated'),
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
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.translated'),
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
        page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.translated'),
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
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.translated'),
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
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.translated'),
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
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.translated'),
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
    await openOptionsSection(controlPage, "ocr");
    await controlPage.locator("#ocr-self-test").click();
    const message = controlPage.locator("#ocr-test-message");
    await expect(message).toHaveAttribute("data-tone", "error");
    await expect(message).toHaveText(
      /^(?:The language pack for the selected recognition language is not installed\. Download it above, then test again\.|所选识别语言的语言包尚未安装。请先在上方下载，再重新测试。)$/u,
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

/** OCR state and visible text: the OCR status card, else the section. */
function readOcrCard(page: Page): Promise<{ state: string; text: string }> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector)?.shadowRoot;
    const card = root?.querySelector("nt-status-card[data-ocr-card]");
    const section = root?.querySelector('[data-section="ocr"]');
    const text = card
      ? [card.getAttribute("heading"), card.getAttribute("description")]
          .filter(Boolean)
          .join(" ")
      : (section?.textContent ?? "");
    return {
      state: card?.getAttribute("data-ocr-card") ?? "",
      text: text.replace(/\s+/gu, " ").trim(),
    };
  }, FLOATING_CONTROL_SELECTOR);
}

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
              noritrans-ocr-region-selector,
              [data-noritrans-ui="subtitle-overlay"] { position:static !important; z-index:-1 !important; pointer-events:none !important; }
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
    const ocrControl = floatingControl(page);
    const ocrSection = await openFloatingSection(
      await openFloatingTab(ocrControl, "video"),
      "ocr",
    );
    const ocrToggle = floatingSwitch(ocrSection, "ocr-enabled");
    if ((await ocrToggle.getAttribute("aria-checked")) !== "true") {
      await ocrToggle.click();
    }
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
    await ocrSection
      .locator('nt-button[data-ocr-action="start"] button')
      .click();
    await page.bringToFront();
    const selector = page.locator("noritrans-ocr-region-selector");
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
          .locator('[data-noritrans-ui="subtitle-overlay"]')
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
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.original'),
    ).toContainText(/HELLO ?OCR 123/u);
    await expect(
      page.locator('[data-noritrans-ui="subtitle-overlay"] .notice'),
    ).toContainText(/local translation|本地翻译/iu);
    await expect(
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.original'),
    ).not.toContainText("IGNORE OUTSIDE REGION");
    const subtitleOverlay = page.locator(
      '[data-noritrans-ui="subtitle-overlay"]',
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
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue.original'),
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
      .poll(() => readOcrCard(page).then((card) => card.text))
      .toMatch(/paused|已暂停/iu);
    await page.bringToFront();
    await expect
      .poll(() => readOcrCard(page).then((card) => card.text))
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
    await expect(ocrControl).toBeVisible();
    await expect(floatingLauncher(ocrControl)).toBeVisible();
    await expect
      .poll(() => floatingParentSurface(ocrControl))
      .toBe(FLOATING_PORTAL_SURFACE);
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
      .poll(() => readOcrCard(page), { timeout: 25_000 })
      .toMatchObject({
        state: "unavailable",
        text: expect.stringMatching(/protected|受.*保护|DRM/iu),
      });
    await expect(
      page.locator('[data-noritrans-ui="subtitle-overlay"] .notice'),
    ).toContainText(/protected|受.*保护|DRM/iu);
    await expect(
      page.locator('[data-noritrans-ui="subtitle-overlay"] .cue-card'),
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
