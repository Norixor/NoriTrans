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

  it("keeps a reserved permit for urgent requests while normal work saturates the tab", async () => {
    const gate = new TranslationRequestGate(3, 1);
    const holds = Array.from({ length: 4 }, deferred);
    const started: string[] = [];
    const run = (
      name: string,
      hold: { promise: Promise<void> },
      priority: "urgent" | "normal",
    ): Promise<void> =>
      gate.run(
        "tab:5",
        name,
        async () => {
          started.push(name);
          await hold.promise;
        },
        priority,
      );

    const normal = [0, 1, 2].map((index) =>
      run(`normal-${index}`, holds[index] ?? deferred(), "normal"),
    );
    await flushMicrotasks();
    expect(started).toEqual(["normal-0", "normal-1"]);

    const urgent = run("urgent", holds[3] ?? deferred(), "urgent");
    await flushMicrotasks();
    expect(started).toEqual(["normal-0", "normal-1", "urgent"]);

    holds[3]?.resolve();
    await urgent;
    await flushMicrotasks();
    // The reserved permit is not handed to queued normal work.
    expect(started).toEqual(["normal-0", "normal-1", "urgent"]);

    holds[0]?.resolve();
    await flushMicrotasks();
    expect(started).toContain("normal-2");
    for (const hold of holds) hold.resolve();
    await Promise.all(normal);
    expect(gate.bucketCount).toBe(0);
  });

  it("grants queued urgent requests before earlier queued normal requests", async () => {
    const gate = new TranslationRequestGate(3, 1);
    const holds = Array.from({ length: 3 }, deferred);
    const started: string[] = [];
    const hold = (name: string, index: number) => async (): Promise<void> => {
      started.push(name);
      await holds[index]?.promise;
    };
    const active = [
      gate.run("tab:6", "normal-a", hold("normal-a", 0)),
      gate.run("tab:6", "normal-b", hold("normal-b", 1)),
      gate.run("tab:6", "urgent-a", hold("urgent-a", 2), "urgent"),
    ];
    const queuedNormal = gate.run("tab:6", "queued-normal", () => {
      started.push("queued-normal");
      return Promise.resolve();
    });
    const queuedUrgent = gate.run(
      "tab:6",
      "queued-urgent",
      () => {
        started.push("queued-urgent");
        return Promise.resolve();
      },
      "urgent",
    );
    await flushMicrotasks();
    expect(started).toEqual(["normal-a", "normal-b", "urgent-a"]);

    holds[0]?.resolve();
    await queuedUrgent;
    expect(started).toEqual([
      "normal-a",
      "normal-b",
      "urgent-a",
      "queued-urgent",
    ]);
    for (const pending of holds) pending.resolve();
    await Promise.all([...active, queuedNormal]);
    expect(started.at(-1)).toBe("queued-normal");
    expect(gate.bucketCount).toBe(0);
  });

  it("rejects a reservation that leaves no permit for normal requests", () => {
    expect(() => new TranslationRequestGate(2, 2)).toThrow(RangeError);
  });
});
