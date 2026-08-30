import { checkForUpdates, getUpdateStatus } from "@/src/update/checker";
import { beforeEach, describe, expect, it, vi } from "vitest";

const browserState = vi.hoisted(() => ({
  stored: structuredClone<Record<string, unknown>>({}),
  badgeText: vi.fn(),
  badgeColor: vi.fn(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    action: {
      setBadgeText: browserState.badgeText,
      setBadgeBackgroundColor: browserState.badgeColor,
    },
    runtime: {
      getManifest: () => ({ version: "0.1.132" }),
    },
    storage: {
      local: {
        get: vi.fn((keys: string[]) =>
          Promise.resolve(
            Object.fromEntries(
              keys
                .filter((key) => key in browserState.stored)
                .map((key) => [key, browserState.stored[key]]),
            ),
          ),
        ),
        set: vi.fn((values: Record<string, unknown>) => {
          Object.assign(browserState.stored, values);
          return Promise.resolve();
        }),
      },
    },
  },
}));

const canonicalApiUrl =
  "https://api.github.com/repos/Norixor/NoriTrans/releases/latest";

function releaseResponse(): Response {
  return new Response(
    JSON.stringify({
      tag_name: "v0.1.132",
      html_url: "https://github.com/Norixor/NoriTrans/releases/tag/v0.1.132",
      draft: false,
      prerelease: false,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("update checker", () => {
  beforeEach(() => {
    browserState.stored = {};
    browserState.badgeText.mockClear();
    browserState.badgeColor.mockClear();
    vi.restoreAllMocks();
  });

  it("uses the NoriTrans repository", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(releaseResponse());

    await expect(checkForUpdates(true)).resolves.toMatchObject({
      state: "current",
      latestVersion: "0.1.132",
      releaseUrl: "https://github.com/Norixor/NoriTrans/releases/tag/v0.1.132",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(canonicalApiUrl);
  });

  it("reads a cached NoriTrans release", async () => {
    browserState.stored["noritrans:update-state-v1"] = {
      latestVersion: "0.1.133",
      releaseUrl: "https://github.com/Norixor/NoriTrans/releases/tag/v0.1.133",
      checkedAt: Date.now(),
    };
    const request = vi.spyOn(globalThis, "fetch");

    await expect(getUpdateStatus()).resolves.toMatchObject({
      state: "available",
      latestVersion: "0.1.133",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects release URLs outside the exact repository", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          tag_name: "v0.1.132",
          html_url:
            "https://github.com/example/NoriTrans/releases/tag/v0.1.132",
          draft: false,
          prerelease: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(checkForUpdates(true)).resolves.toMatchObject({
      state: "error",
      errorCode: "invalid_response",
    });
  });
});
