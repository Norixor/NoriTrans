import { isOptionsPageOpenCommand } from "@/src/messaging/protocol";
import type { ContentMessageSender } from "@/src/shared/content-sender";
import { handleOptionsPageOpen } from "@/src/shared/options-page-open";
import { describe, expect, it, vi } from "vitest";

const EXTENSION = {
  id: "extension-id",
  baseUrl: "chrome-extension://extension-id/",
};
const CONTENT_SENDER: ContentMessageSender = {
  id: EXTENSION.id,
  url: "https://news.example/a",
  frameId: 0,
  tab: { id: 3, url: "https://news.example/a" },
};

function deps() {
  const openTab = vi.fn(() => Promise.resolve());
  return { openTab, deps: { extension: EXTENSION, openTab } };
}

describe("OPTIONS_PAGE_OPEN", () => {
  it("accepts no section or a whitelisted section only", () => {
    expect(isOptionsPageOpenCommand({ type: "OPTIONS_PAGE_OPEN" })).toBe(true);
    for (const section of [
      "providers",
      "visibility",
      "ocr",
      "image",
      "video",
    ]) {
      expect(
        isOptionsPageOpenCommand({ type: "OPTIONS_PAGE_OPEN", section }),
      ).toBe(true);
    }
    for (const value of [
      { type: "OPTIONS_PAGE_OPEN", section: "../popup.html" },
      { type: "OPTIONS_PAGE_OPEN", section: "ocr", url: "https://x.example" },
      { type: "OPTIONS_PAGE_OPEN", section: 1 },
    ]) {
      expect(isOptionsPageOpenCommand(value)).toBe(false);
    }
  });

  it("opens the options page at the requested section", async () => {
    const { deps: d, openTab } = deps();
    await expect(
      handleOptionsPageOpen(
        { type: "OPTIONS_PAGE_OPEN", section: "ocr" },
        CONTENT_SENDER,
        d,
      ),
    ).resolves.toEqual({ ok: true, code: "options_page_opened" });
    expect(openTab).toHaveBeenCalledWith("options.html#ocr", CONTENT_SENDER);
  });

  it("rejects foreign senders and invalid payloads with distinct codes", async () => {
    const { deps: d, openTab } = deps();
    await expect(
      handleOptionsPageOpen(
        { type: "OPTIONS_PAGE_OPEN" },
        { ...CONTENT_SENDER, frameId: 2 },
        d,
      ),
    ).resolves.toEqual({ ok: false, code: "options_page_sender_rejected" });
    await expect(
      handleOptionsPageOpen(
        { type: "OPTIONS_PAGE_OPEN", section: "secrets" },
        CONTENT_SENDER,
        d,
      ),
    ).resolves.toEqual({ ok: false, code: "options_page_invalid_payload" });
    expect(openTab).not.toHaveBeenCalled();
  });

  it("reports a failed tab creation", async () => {
    const openTab = vi.fn(() => Promise.reject(new Error("no window")));
    await expect(
      handleOptionsPageOpen({ type: "OPTIONS_PAGE_OPEN" }, CONTENT_SENDER, {
        extension: EXTENSION,
        openTab,
      }),
    ).resolves.toEqual({ ok: false, code: "options_page_open_failed" });
  });
});
