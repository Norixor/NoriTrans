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

/**
 * The launcher's status arc: its style (`data-ring`), the edge it is tucked
 * into, and whether the stroked arc lies fully inside the button box (the
 * pill clips its overflow, so anything outside would be cut off; null when
 * no arc is drawn).
 */
export function launcherRing(control: Locator): Promise<{
  ring: string | null;
  edge: string | null;
  inside: boolean | null;
}> {
  return control.locator("nt-pill-fab").evaluate((fab) => {
    const root = fab.shadowRoot;
    const button = root?.querySelector("button");
    const arc = root?.querySelector<SVGGeometryElement>(".dial .arc");
    // Null when no arc is drawn (idle).
    let inside: boolean | null = arc ? false : null;
    const matrix = arc?.getScreenCTM();
    if (button && arc && matrix) {
      const box = arc.getBBox();
      const half = Number(arc.getAttribute("stroke-width") ?? "0") / 2;
      const corners = [
        new DOMPoint(box.x - half, box.y - half),
        new DOMPoint(box.x + box.width + half, box.y + box.height + half),
      ].map((point) => point.matrixTransform(matrix));
      const rect = button.getBoundingClientRect();
      inside = corners.every(
        (point) =>
          point.x >= rect.left - 0.01 &&
          point.x <= rect.right + 0.01 &&
          point.y >= rect.top - 0.01 &&
          point.y <= rect.bottom + 0.01,
      );
    }
    return {
      ring: fab.getAttribute("data-ring"),
      edge: fab.getAttribute("edge"),
      inside,
    };
  });
}

/** `data-noritrans-ui` of the host's parent (portal marker or empty). */
export function floatingParentSurface(control: Locator): Promise<string> {
  return control.evaluate(
    (element) => element.parentElement?.getAttribute("data-noritrans-ui") ?? "",
  );
}
