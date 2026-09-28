import type * as Idb from "idb";
import { beforeEach, describe, expect, it, vi } from "vitest";

const idbMocks = vi.hoisted(() => ({
  failNextOpen: false,
  options: [] as Array<{ blocking?: () => void; terminated?: () => void }>,
}));

vi.mock("idb", async (importOriginal: () => Promise<typeof Idb>) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openDB: ((...args: Parameters<typeof actual.openDB>) => {
      idbMocks.options.push(
        (args[2] ?? {}) as { blocking?: () => void; terminated?: () => void },
      );
      if (idbMocks.failNextOpen) {
        idbMocks.failNextOpen = false;
        return Promise.reject(new DOMException("Open failed", "UnknownError"));
      }
      return actual.openDB(...args);
    }) as typeof actual.openDB,
  };
});

describe("translation cache database connection", () => {
  beforeEach(() => {
    vi.resetModules();
    idbMocks.failNextOpen = false;
    idbMocks.options.length = 0;
  });

  it("reopens the database after a failed open instead of caching the rejection", async () => {
    const database = await import("@/src/cache/database");
    idbMocks.failNextOpen = true;

    await expect(database.getCachedTranslation("missing")).rejects.toThrow(
      "Open failed",
    );
    await database.setCachedTranslation("reopened", "重新打开");

    await expect(database.getCachedTranslation("reopened")).resolves.toBe(
      "重新打开",
    );
    expect(idbMocks.options).toHaveLength(2);
  });

  it("reopens the database after the connection is terminated", async () => {
    const database = await import("@/src/cache/database");
    const first = await database.getDatabase();
    expect(await database.getDatabase()).toBe(first);

    idbMocks.options[0]?.terminated?.();
    const second = await database.getDatabase();

    expect(second).not.toBe(first);
    expect(idbMocks.options).toHaveLength(2);
  });

  it("releases the connection when another context needs a version change", async () => {
    const database = await import("@/src/cache/database");
    const first = await database.getDatabase();
    const close = vi.spyOn(first, "close");

    idbMocks.options[0]?.blocking?.();
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());

    expect(await database.getDatabase()).not.toBe(first);
  });
});
