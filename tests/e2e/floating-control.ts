import {
  expect,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";

/**
 * Locators for the injected floating control (src/ui/floating). The host is a
 * plain `<div>` with an open shadow root; Playwright CSS locators pierce open
 * shadow roots, including the nested `nt-*` component roots.
 */
export const FLOATING_CONTROL_SELECTOR =
  'div[data-noritrans-ui="floating-control"]';
/** Marker of the fullscreen top-layer portal the host moves into. */
export const FLOATING_PORTAL_SURFACE = "floating-control-portal";

export type FloatingTabId = "page" | "video";

const TAB_NAMES: Record<FloatingTabId, RegExp> = {
  page: /^(?:Page|网页)/u,
  video: /^(?:Video|视频)/u,
};

export function floatingControl(scope: Page | FrameLocator): Locator {
  return scope.locator(FLOATING_CONTROL_SELECTOR);
}

/** The real `<button>` inside the collapsed pill button. */
export function floatingLauncher(control: Locator): Locator {
  return control.locator("nt-pill-fab button[part='button']");
}

export function floatingPanel(control: Locator): Locator {
  return control.locator("section.panel");
}

export function floatingTab(control: Locator, tab: FloatingTabId): Locator {
  return control.getByRole("tab", { name: TAB_NAMES[tab] });
}

export function floatingTabBody(control: Locator, tab: FloatingTabId): Locator {
  return control.locator(`.tab-body[data-tab="${tab}"]`);
}

/** A status-card action button (`translate`, `stop`, `disable`, …). */
export function floatingAction(scope: Locator, id: string): Locator {
  return scope.locator(`nt-button[data-action="${id}"] button[part='button']`);
}

export async function openFloatingPanel(control: Locator): Promise<void> {
  const panel = floatingPanel(control);
  if (!(await panel.isVisible())) await floatingLauncher(control).click();
  await expect(panel).toBeVisible();
}

export async function openFloatingTab(
  control: Locator,
  tab: FloatingTabId,
): Promise<Locator> {
  await openFloatingPanel(control);
  const body = floatingTabBody(control, tab);
  if (!(await body.isVisible())) await floatingTab(control, tab).click();
  await expect(body).toBeVisible();
  return body;
}

/** Opens the inline "Change" editor of a tab body and returns it. */
export async function openFloatingEditor(body: Locator): Promise<Locator> {
  const toggle = body.locator("nt-quick-line.summary button[part='action']");
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  const editor = body.locator(".editor");
  await expect(editor).toBeVisible();
  return editor;
}

/** The `role="switch"` button of an `nt-switch` with `data-field`. */
export function floatingSwitch(scope: Locator, field: string): Locator {
  return scope.locator(`nt-switch[data-field="${field}"] [role="switch"]`);
}

/** The native `<select>` of an `nt-select` with `data-field`. */
export function floatingSelect(scope: Locator, field: string): Locator {
  return scope.locator(`nt-select[data-field="${field}"] select`);
}

/** Expands a disclosure section (`ocr`, `image`) of a tab body. */
export async function openFloatingSection(
  body: Locator,
  section: string,
): Promise<Locator> {
  const container = body.locator(`.section[data-section="${section}"]`);
  const head = container.locator(".sec-head");
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  return container;
}

/** `data-noritrans-ui` of the host's parent (portal marker or empty). */
export function floatingParentSurface(control: Locator): Promise<string> {
  return control.evaluate(
    (element) => element.parentElement?.getAttribute("data-noritrans-ui") ?? "",
  );
}
