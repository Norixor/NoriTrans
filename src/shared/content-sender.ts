/** The parts of `runtime.MessageSender` used for sender verification. */
export interface ContentMessageSender {
  id?: string | undefined;
  url?: string | undefined;
  frameId?: number | undefined;
  tab?: { id?: number | undefined; url?: string | undefined } | undefined;
}

/**
 * Hostname of the web frame that sent a runtime message, or undefined when
 * the sender is not a content script in an http(s) tab frame. Without
 * `allowSubframe` only the top frame is accepted, and its origin must match
 * the tab's committed URL so a stale or spoofed frame cannot act for the tab.
 */
export function verifiedContentHostname(
  sender: ContentMessageSender,
  allowSubframe = false,
): string | undefined {
  try {
    if (
      (!allowSubframe && sender.frameId !== 0) ||
      sender.tab?.id === undefined ||
      !sender.url
    ) {
      return undefined;
    }
    const frameUrl = new URL(sender.url);
    if (frameUrl.protocol !== "https:" && frameUrl.protocol !== "http:") {
      return undefined;
    }
    if (!allowSubframe) {
      if (!sender.tab.url) return undefined;
      const tabUrl = new URL(sender.tab.url);
      if (frameUrl.origin !== tabUrl.origin) return undefined;
    }
    return frameUrl.hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return undefined;
  }
}

/**
 * True for this extension's content script running in the top frame of a
 * web tab. Extension pages (options, popup, offscreen) are rejected even
 * though they share the extension ID.
 */
export function isTopFrameContentScriptSender(
  sender: ContentMessageSender,
  extension: { id: string; baseUrl: string },
): boolean {
  if (sender.id !== extension.id) return false;
  if (sender.url?.startsWith(extension.baseUrl)) return false;
  return verifiedContentHostname(sender) !== undefined;
}
