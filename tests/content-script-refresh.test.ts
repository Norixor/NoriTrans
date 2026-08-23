import { describe, expect, it, vi } from "vitest";
import {
  isFullDocumentNavigationUpdate,
  isRefreshablePageUrl,
  prepareContentFramesForBroadcast,
  refreshExistingContentScripts,
  sendCommandToContentFrames,
  TabManualTranslationIntentStore,
} from "@/src/shared/content-script-refresh";

describe("content script refresh", () => {
  it("sends a command once to each discovered document", async () => {
    const send = vi.fn((target: { documentId: string }) => {
      void target;
      return Promise.resolve({ ok: true });
    });
    const fallback = vi.fn(() => Promise.resolve({ ok: true }));

    await expect(
      sendCommandToContentFrames({
        targets: [
          { frameId: 0, documentId: "top" },
          { frameId: 5, documentId: "player" },
          { frameId: 8, documentId: "player" },
        ],
        send,
        fallback,
      }),
    ).resolves.toEqual({ delivered: 2, failed: 0, usedFallback: false });
    expect(send.mock.calls.map(([target]) => target.documentId)).toEqual([
      "top",
      "player",
    ]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("isolates a stale frame while delivering to current documents", async () => {
    const send = vi.fn((target: { documentId: string }) =>
      target.documentId === "stale"
        ? Promise.reject(new Error("Document navigated"))
        : Promise.resolve({ ok: true }),
    );

    await expect(
      sendCommandToContentFrames({
        targets: [
          { frameId: 0, documentId: "top" },
          { frameId: 4, documentId: "stale" },
        ],
        send,
        fallback: () => Promise.resolve({ ok: true }),
      }),
    ).resolves.toEqual({ delivered: 1, failed: 1, usedFallback: false });
  });

  it("uses a tab-wide fallback only when frame discovery is empty", async () => {
    const fallback = vi.fn(() => Promise.resolve({ ok: true }));
    await expect(
      sendCommandToContentFrames({
        targets: [],
        send: () => Promise.resolve({ ok: true }),
        fallback,
      }),
    ).resolves.toEqual({ delivered: 1, failed: 0, usedFallback: true });
    expect(fallback).toHaveBeenCalledOnce();
  });

  it("targets only frame instances created after a manual tab translation", async () => {
    let stored: unknown;
    const store = new TabManualTranslationIntentStore({
      read: () => Promise.resolve(stored),
      write: (state) => {
        stored = structuredClone(state);
        return Promise.resolve();
      },
    });

    await expect(
      store.frameNeedsTranslation(12, "existing-frame"),
    ).resolves.toBe(false);
    await store.activate(12);
    await expect(
      store.frameNeedsTranslation(12, "existing-frame"),
    ).resolves.toBe(false);
    await expect(
      store.frameNeedsTranslation(12, "dynamic-frame"),
    ).resolves.toBe(true);
    await expect(
      store.frameNeedsTranslation(12, "dynamic-frame"),
    ).resolves.toBe(false);
    await expect(
      store.frameNeedsTranslation(13, "other-tab-frame"),
    ).resolves.toBe(false);
  });

  it("persists tab intent until the owner clears it", async () => {
    let stored: unknown;
    const storage = {
      read: () => Promise.resolve(structuredClone(stored)),
      write: (state: unknown) => {
        stored = structuredClone(state);
        return Promise.resolve();
      },
    };
    const first = new TabManualTranslationIntentStore(storage);
    await first.activate(21);
    await expect(first.frameNeedsTranslation(21, "frame-a")).resolves.toBe(
      true,
    );

    const restarted = new TabManualTranslationIntentStore(storage);
    await expect(restarted.frameNeedsTranslation(21, "frame-a")).resolves.toBe(
      false,
    );
    await expect(restarted.frameNeedsTranslation(21, "frame-b")).resolves.toBe(
      true,
    );
    await restarted.deactivate(21);
    await expect(restarted.frameNeedsTranslation(21, "frame-c")).resolves.toBe(
      false,
    );
  });

  it("clears a manual intent only for a full document navigation", () => {
    expect(isFullDocumentNavigationUpdate({ status: "loading" })).toBe(true);
    expect(isFullDocumentNavigationUpdate({ status: "complete" })).toBe(false);
    expect(isFullDocumentNavigationUpdate({})).toBe(false);
    expect(
      isFullDocumentNavigationUpdate({
        // Same-document history/hash navigation reports a URL without a new
        // document loading cycle, so the active manual translation continues.
        status: undefined,
      }),
    ).toBe(false);
  });

  it("limits reinjection to ordinary web pages", () => {
    expect(isRefreshablePageUrl("https://example.com/watch")).toBe(true);
    expect(isRefreshablePageUrl("http://localhost:4173/test")).toBe(true);
    expect(isRefreshablePageUrl("chrome://extensions/")).toBe(false);
    expect(isRefreshablePageUrl("chrome-extension://id/options.html")).toBe(
      false,
    );
    expect(isRefreshablePageUrl(undefined)).toBe(false);
    expect(isRefreshablePageUrl("not a url")).toBe(false);
  });

  it("refreshes accessible tabs and isolates per-tab permission failures", async () => {
    const active = 0;
    let peak = 0;
    let running = active;
    const inject = vi.fn(async (tabId: number) => {
      running += 1;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running -= 1;
      if (tabId === 2) throw new Error("Missing host permission");
    });

    await expect(
      refreshExistingContentScripts({
        queryTabs: () =>
          Promise.resolve([
            { id: 1, url: "https://example.com/" },
            { id: 2, url: "http://optional.example/" },
            { id: 3, url: "chrome://extensions/" },
            { url: "https://missing-id.example/" },
            { id: 4, url: "https://video.example/" },
          ]),
        inject,
        concurrency: 2,
      }),
    ).resolves.toEqual({ attempted: 3, refreshed: 2, failed: 1 });
    expect(inject.mock.calls.map(([tabId]) => tabId).sort()).toEqual([1, 2, 4]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("does not start workers when no page can be refreshed", async () => {
    const inject = vi.fn();
    await expect(
      refreshExistingContentScripts({
        queryTabs: () => Promise.resolve([{ id: 1, url: "about:blank" }]),
        inject,
      }),
    ).resolves.toEqual({ attempted: 0, refreshed: 0, failed: 0 });
    expect(inject).not.toHaveBeenCalled();
  });

  it("skips current content scripts and reinjects stale or unreachable ones", async () => {
    const inject = vi.fn<(tabId: number) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const isCurrent = vi.fn((tabId: number) => {
      if (tabId === 1) return Promise.resolve(true);
      if (tabId === 2) return Promise.resolve(false);
      return Promise.reject(new Error("No receiving end"));
    });

    await expect(
      refreshExistingContentScripts({
        queryTabs: () =>
          Promise.resolve([
            { id: 1, url: "https://current.example/" },
            { id: 2, url: "https://stale.example/" },
            { id: 3, url: "https://unreachable.example/" },
          ]),
        isCurrent,
        inject,
      }),
    ).resolves.toEqual({ attempted: 3, refreshed: 2, failed: 0 });
    expect(inject.mock.calls.map(([tabId]) => tabId).sort()).toEqual([2, 3]);
  });

  it("recovers a dynamic frame before the caller broadcasts once", async () => {
    const currentDocuments = new Set(["top-document"]);
    const events: string[] = [];
    const inject = vi.fn((target: { documentId: string }) => {
      events.push(`inject:${target.documentId}`);
      currentDocuments.add(target.documentId);
      return Promise.resolve();
    });

    await expect(
      prepareContentFramesForBroadcast({
        discover: () =>
          Promise.resolve([
            { frameId: 0, documentId: "top-document" },
            { frameId: 4, documentId: "dynamic-frame-document" },
          ]),
        isCurrent: (target) =>
          Promise.resolve(currentDocuments.has(target.documentId)),
        inject,
        wait: () => Promise.resolve(),
      }),
    ).resolves.toEqual({
      discovered: 2,
      current: 1,
      recovered: 1,
      failed: 0,
    });
    events.push("broadcast");

    expect(inject).toHaveBeenCalledOnce();
    expect(inject).toHaveBeenCalledWith({
      frameId: 4,
      documentId: "dynamic-frame-document",
    });
    expect(events).toEqual(["inject:dynamic-frame-document", "broadcast"]);
  });

  it("waits for an injected frame runtime and isolates another frame failure", async () => {
    const probes = new Map<string, number>();
    const inject = vi.fn((target: { documentId: string }) => {
      if (target.documentId === "blocked-document") {
        return Promise.reject(new Error("Missing host permission"));
      }
      return Promise.resolve();
    });
    const wait = vi.fn(() => Promise.resolve());

    await expect(
      prepareContentFramesForBroadcast({
        discover: () =>
          Promise.resolve([
            { frameId: 0, documentId: "top-document" },
            { frameId: 7, documentId: "loading-document" },
            { frameId: 8, documentId: "blocked-document" },
          ]),
        isCurrent: (target) => {
          if (target.frameId === 0) return Promise.resolve(true);
          const count = (probes.get(target.documentId) ?? 0) + 1;
          probes.set(target.documentId, count);
          return Promise.resolve(
            target.documentId === "loading-document" && count >= 3,
          );
        },
        inject,
        readinessAttempts: 4,
        wait,
      }),
    ).resolves.toEqual({
      discovered: 3,
      current: 1,
      recovered: 1,
      failed: 1,
    });
    expect(inject).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing broadcast path when frame discovery is unavailable", async () => {
    const inject = vi.fn();
    await expect(
      prepareContentFramesForBroadcast({
        discover: () => Promise.reject(new Error("Tab navigated")),
        isCurrent: () => Promise.resolve(false),
        inject,
      }),
    ).resolves.toEqual({
      discovered: 0,
      current: 0,
      recovered: 0,
      failed: 0,
    });
    expect(inject).not.toHaveBeenCalled();
  });
});
