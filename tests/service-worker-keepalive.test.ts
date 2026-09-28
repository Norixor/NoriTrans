import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceWorkerKeepalive } from "@/src/shared/service-worker-keepalive";

describe("ServiceWorkerKeepalive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings only while at least one hold is active", async () => {
    vi.useFakeTimers();
    const ping = vi.fn(() => Promise.resolve());
    const keepalive = new ServiceWorkerKeepalive(ping, 20_000);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ping).not.toHaveBeenCalled();

    const releaseFirst = keepalive.hold();
    const releaseSecond = keepalive.hold();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(ping).toHaveBeenCalledTimes(2);

    releaseFirst();
    releaseFirst();
    expect(keepalive.activeHolds).toBe(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ping).toHaveBeenCalledTimes(3);

    releaseSecond();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ping).toHaveBeenCalledTimes(3);
    expect(keepalive.activeHolds).toBe(0);
  });

  it("ignores ping failures", async () => {
    vi.useFakeTimers();
    const ping = vi.fn(() => Promise.reject(new Error("context invalidated")));
    const keepalive = new ServiceWorkerKeepalive(ping, 1_000);
    const release = keepalive.hold();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(ping).toHaveBeenCalledTimes(2);
    release();
  });
});
