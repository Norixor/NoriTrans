import { browser } from "wxt/browser";

/** The tab the popup acts on, resolved once per refresh. */
export interface PopupTab {
  id: number;
  /** Lower-case hostname of an http(s) tab; absent when unknown. */
  hostname?: string;
  /** True when the browser never lets an extension read this tab. */
  restricted: boolean;
}

const WEB_STORE_HOSTS = new Set(["chromewebstore.google.com"]);

/**
 * Whether the browser forbids extensions from reading `url`: anything that
 * is not http(s) (chrome://, about:, other extensions, file:// without
 * access, view-source:) and the Chrome Web Store.
 */
export function isRestrictedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const host = parsed.hostname.toLowerCase();
  if (WEB_STORE_HOSTS.has(host)) return true;
  return (
    host === "chrome.google.com" && parsed.pathname.startsWith("/webstore")
  );
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.hostname.toLowerCase().replace(/\.$/u, "") || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the active tab. A tab without a visible URL is not treated as
 * restricted here; whether its content script answers decides that.
 */
export async function activePopupTab(): Promise<PopupTab | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return null;
  const hostname = hostnameOf(tab.url);
  return {
    id: tab.id,
    ...(hostname ? { hostname } : {}),
    restricted: tab.url !== undefined && isRestrictedUrl(tab.url),
  };
}

function successful(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true
  );
}

/** Injects or refreshes the content scripts; false when the tab refuses. */
export async function ensureTabContent(tabId: number): Promise<boolean> {
  try {
    const response: unknown = await browser.runtime.sendMessage({
      type: "ENSURE_PAGE_CONTENT",
      tabId,
    });
    return successful(response);
  } catch {
    return false;
  }
}

/** Asks the top frame for a status; resolves `undefined` when unreachable. */
export async function queryTopFrame(
  tabId: number,
  type: "PAGE_STATUS" | "SUBTITLE_STATUS",
): Promise<unknown> {
  try {
    return (await browser.tabs.sendMessage(
      tabId,
      { type },
      { frameId: 0 },
    )) as unknown;
  } catch {
    return undefined;
  }
}

export type PopupTabCommand =
  | "PAGE_TRANSLATE"
  | "PAGE_AUTO_TRANSLATE_CURRENT"
  | "PAGE_RETRY_FAILED"
  | "PAGE_CANCEL"
  | "PAGE_RESTORE"
  | "SUBTITLE_START"
  | "SUBTITLE_RETRY_FAILED"
  | "SUBTITLE_CANCEL";

/**
 * Sends a task command to every frame of the tab (the popup is not a content
 * sender, so it cannot use `CONTENT_COMMAND_BROADCAST`). Rejects when no
 * frame answered.
 */
export async function sendTabCommand(
  tabId: number,
  command: PopupTabCommand,
): Promise<void> {
  await browser.tabs.sendMessage(tabId, { type: command });
}
