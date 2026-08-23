import { describe, expect, it, vi } from "vitest";

import {
  EXTENSION_TRANSLATION_BUCKET,
  TranslationRequestGate,
  translationBucketForTab,
} from "@/src/shared/translation-request-gate";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve?.() };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TranslationRequestGate", () => {
  it("limits one tab to eight active operations", async () => {
    const gate = new TranslationRequestGate(8);
    const releases = Array.from({ length: 9 }, deferred);
    let active = 0;
    let peak = 0;
    const started: number[] = [];

    const operations = releases.map((hold, index) =>
      gate.run("tab:7", `request-${index}`, async () => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(index);
        await hold.promise;
        active -= 1;
      }),
    );

    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(active).toBe(8);
    expect(peak).toBe(8);

    releases[0]?.resolve();
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(peak).toBe(8);

    for (const hold of releases.slice(1)) hold.resolve();
    await Promise.all(operations);
    expect(active).toBe(0);
    expect(gate.bucketCount).toBe(0);
  });

  it("keeps different tabs and trusted extension requests isolated", async () => {
    const gate = new TranslationRequestGate(1);
    const tabHold = deferred();
    const otherTabHold = deferred();
    const extensionHold = deferred();
    const started: string[] = [];

    const operations = [
      gate.run(translationBucketForTab(1), "same-request", async () => {
        started.push("tab-one");
        await tabHold.promise;
      }),
      gate.run(translationBucketForTab(2), "same-request", async () => {
        started.push("tab-two");
        await otherTabHold.promise;
      }),
      gate.run(translationBucketForTab(), "same-request", async () => {
        started.push("extension");
        await extensionHold.promise;
      }),
    ];

    await flushMicrotasks();
    expect(started).toEqual(["tab-one", "tab-two", "extension"]);
    expect(translationBucketForTab()).toBe(EXTENSION_TRANSLATION_BUCKET);

    tabHold.resolve();
    otherTabHold.resolve();
    extensionHold.resolve();
    await Promise.all(operations);
    expect(gate.bucketCount).toBe(0);
  });

  it("cancels a queued request before its operation starts", async () => {
    const gate = new TranslationRequestGate(1);
    const activeHold = deferred();
    const queuedOperation = vi.fn(() => Promise.resolve(undefined));
    const active = gate.run("tab:3", "active", async () => {
      await activeHold.promise;
    });
    const queued = gate.run("tab:3", "queued", queuedOperation);

    await flushMicrotasks();
    gate.cancel("tab:3", "queued");
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(queuedOperation).not.toHaveBeenCalled();

    activeHold.resolve();
    await active;
    expect(gate.bucketCount).toBe(0);
  });

  it("cancels and reclaims a tab bucket when the tab closes", async () => {
    const gate = new TranslationRequestGate(1);
    const active = gate.run(
      "tab:9",
      "active",
      (signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    const queuedOperation = vi.fn(() => Promise.resolve(undefined));
    const queued = gate.run("tab:9", "queued", queuedOperation);

    await flushMicrotasks();
    gate.cancelBucket("tab:9");

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await active;
    expect(queuedOperation).not.toHaveBeenCalled();
    expect(gate.bucketCount).toBe(0);
  });

  it("releases a permit when an operation throws", async () => {
    const gate = new TranslationRequestGate(1);
    const failed = gate.run("tab:4", "failed", () =>
      Promise.reject(new Error("provider failed")),
    );
    const nextOperation = vi.fn(() => Promise.resolve("translated"));
    const next = gate.run("tab:4", "next", nextOperation);

    await expect(failed).rejects.toThrow("provider failed");
    await expect(next).resolves.toBe("translated");
    expect(nextOperation).toHaveBeenCalledOnce();
    expect(gate.bucketCount).toBe(0);
  });
});
