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
const previousApiUrl =
  "https://api.github.com/repos/Norixor/nTrans/releases/latest";
const originalApiUrl =
  "https://api.github.com/repos/Norixor/NorixorTrans/releases/latest";

function releaseResponse(
  repository: "canonical" | "previous" | "original",
): Response {
  const name =
    repository === "canonical"
      ? "NoriTrans"
      : repository === "previous"
        ? "nTrans"
        : "NorixorTrans";
  return new Response(
    JSON.stringify({
      tag_name: "v0.1.132",
      html_url: `https://github.com/Norixor/${name}/releases/tag/v0.1.132`,
      draft: false,
      prerelease: false,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("update checker repository rename compatibility", () => {
  beforeEach(() => {
    browserState.stored = {};
    browserState.badgeText.mockClear();
    browserState.badgeColor.mockClear();
    vi.restoreAllMocks();
  });

  it("uses the renamed canonical repository", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(releaseResponse("canonical"));

    await expect(checkForUpdates(true)).resolves.toMatchObject({
      state: "current",
      latestVersion: "0.1.132",
      releaseUrl: "https://github.com/Norixor/NoriTrans/releases/tag/v0.1.132",
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe(canonicalApiUrl);
  });

  it("falls back to the previous repository name", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(releaseResponse("previous"));

    await expect(checkForUpdates(true)).resolves.toMatchObject({
      state: "current",
      latestVersion: "0.1.132",
      releaseUrl: "https://github.com/Norixor/nTrans/releases/tag/v0.1.132",
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      canonicalApiUrl,
      previousApiUrl,
    ]);
  });

  it("falls back to the original repository name", async () => {
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(releaseResponse("original"));

    await expect(checkForUpdates(true)).resolves.toMatchObject({
      state: "current",
      latestVersion: "0.1.132",
      releaseUrl:
        "https://github.com/Norixor/NorixorTrans/releases/tag/v0.1.132",
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      canonicalApiUrl,
      previousApiUrl,
      originalApiUrl,
    ]);
  });

  it("keeps a cached release URL from the previous repository", async () => {
    browserState.stored["norixortrans:update-state-v1"] = {
      latestVersion: "0.1.133",
      releaseUrl: "https://github.com/Norixor/nTrans/releases/tag/v0.1.133",
      checkedAt: Date.now(),
    };
    const request = vi.spyOn(globalThis, "fetch");

    await expect(getUpdateStatus()).resolves.toMatchObject({
      state: "available",
      latestVersion: "0.1.133",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a cached release URL from the original repository", async () => {
    browserState.stored["norixortrans:update-state-v1"] = {
      latestVersion: "0.1.133",
      releaseUrl:
        "https://github.com/Norixor/NorixorTrans/releases/tag/v0.1.133",
      checkedAt: Date.now(),
    };
    const request = vi.spyOn(globalThis, "fetch");

    await expect(getUpdateStatus()).resolves.toMatchObject({
      state: "available",
      latestVersion: "0.1.133",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects release URLs outside all exact repositories", async () => {
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
