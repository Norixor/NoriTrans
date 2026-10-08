import {
  isOptionsPageOpenCommand,
  type OptionsPageOpenResponse,
} from "@/src/messaging/protocol";
import {
  isTopFrameContentScriptSender,
  type ContentMessageSender,
} from "@/src/shared/content-sender";

export interface OptionsPageOpenDeps {
  extension: { id: string; baseUrl: string };
  /** Opens `path` (relative to the extension root) next to the sender's tab. */
  openTab(path: string, sender: ContentMessageSender): Promise<void>;
}

/**
 * Handles `OPTIONS_PAGE_OPEN`. Only the fixed options page and a whitelisted
 * hash can be opened, so a page cannot use this to open arbitrary extension
 * URLs.
 */
export async function handleOptionsPageOpen(
  message: unknown,
  sender: ContentMessageSender,
  deps: OptionsPageOpenDeps,
): Promise<OptionsPageOpenResponse> {
  if (!isTopFrameContentScriptSender(sender, deps.extension)) {
    return { ok: false, code: "options_page_sender_rejected" };
  }
  if (!isOptionsPageOpenCommand(message)) {
    return { ok: false, code: "options_page_invalid_payload" };
  }
  try {
    await deps.openTab(
      `options.html${message.section ? `#${message.section}` : ""}`,
      sender,
    );
    return { ok: true, code: "options_page_opened" };
  } catch {
    return { ok: false, code: "options_page_open_failed" };
  }
}
