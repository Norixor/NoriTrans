import { describe, expect, it, vi } from "vitest";
import {
  saveProviderFields,
  testProviderConnection,
  validateAiDraft,
  type CredentialDeps,
} from "@/entrypoints/options/credentials";
import { resolveOptionsRoute } from "@/entrypoints/options/router";
import { OPTIONS_PAGE_SECTIONS } from "@/src/messaging/protocol";
import { DEFAULT_SETTINGS, type AppSettings } from "@/src/shared/settings";

describe("resolveOptionsRoute", () => {
  it("opens every group by its own anchor", () => {
    for (const group of [
      "services",
      "page",
      "video",
      "sites",
      "privacy",
      "general",
    ]) {
      expect(resolveOptionsRoute(`#${group}`)).toEqual({
        group,
        fallback: false,
      });
    }
  });

  it("keeps the deep links sent through OPTIONS_PAGE_OPEN working", () => {
    const routes = Object.fromEntries(
      OPTIONS_PAGE_SECTIONS.map((section) => [
        section,
        resolveOptionsRoute(`#${section}`),
      ]),
    );
    expect(routes).toEqual({
      providers: { group: "services", fallback: false },
      visibility: { group: "general", fallback: false },
      ocr: { group: "video", anchor: "image-recognition", fallback: false },
      image: { group: "page", anchor: "image-translation", fallback: false },
      video: { group: "video", fallback: false },
    });
  });

  it("resolves the step-two aliases", () => {
    expect(resolveOptionsRoute("#marks")).toEqual({
      group: "page",
      anchor: "page-marks",
      fallback: false,
    });
    expect(resolveOptionsRoute("#profiles")).toEqual({
      group: "sites",
      fallback: false,
    });
    expect(resolveOptionsRoute("#updates")).toEqual({
      group: "general",
      fallback: false,
    });
  });

  it("falls back to the first group for empty or unknown hashes", () => {
    expect(resolveOptionsRoute("")).toEqual({
      group: "services",
      fallback: false,
    });
    for (const hash of ["#nope", "#../popup.html", "#__proto__", "#toString"]) {
      expect(resolveOptionsRoute(hash)).toEqual({
        group: "services",
        fallback: true,
      });
    }
  });
});

function credentialDeps(stored: AppSettings, granted = true) {
  const calls: string[] = [];
  const sendMessage = vi.fn((message: unknown) => {
    calls.push((message as { type: string }).type);
    return Promise.resolve({ ok: true });
  });
  const deps: CredentialDeps = {
    flushAutosave: vi.fn(() => {
      calls.push("flush");
      return Promise.resolve();
    }),
    loadSettings: vi.fn(() => {
      calls.push("load");
      return Promise.resolve(structuredClone(stored));
    }),
    requestPermission: vi.fn(() => Promise.resolve(granted)),
    sendMessage,
  };
  return { deps, calls, sendMessage };
}

describe("explicit provider save", () => {
  it("flushes autosave, re-reads storage and replaces only provider fields", async () => {
    const stored = structuredClone(DEFAULT_SETTINGS);
    // Written by another page after this one loaded.
    stored.page.mode = "ai";
    const { deps, calls, sendMessage } = credentialDeps(stored);
    const result = await saveProviderFields(
      {
        baseUrl: "https://gateway.example/v1",
        apiKey: "new-key",
        model: "m",
      },
      deps,
    );
    expect(result).toMatchObject({ ok: true, code: "provider_saved" });
    expect(calls).toEqual(["flush", "load", "SETTINGS_SET"]);
    const written = (
      sendMessage.mock.calls[0]?.[0] as { settings: AppSettings }
    ).settings;
    expect(written.page.mode).toBe("ai");
    expect(written.provider).toMatchObject({
      baseUrl: "https://gateway.example/v1",
      apiKey: "new-key",
      model: "m",
    });
  });

  it("does not write when the URL is invalid or permission is refused", async () => {
    const invalid = credentialDeps(DEFAULT_SETTINGS);
    await expect(
      saveProviderFields({ baseUrl: "http://remote.example/v1" }, invalid.deps),
    ).resolves.toEqual({ ok: false, code: "provider_url_invalid" });
    expect(invalid.sendMessage).not.toHaveBeenCalled();

    const denied = credentialDeps(DEFAULT_SETTINGS, false);
    await expect(
      saveProviderFields({ baseUrl: "http://localhost:8080/v1" }, denied.deps),
    ).resolves.toEqual({ ok: false, code: "provider_permission_denied" });
    expect(denied.sendMessage).not.toHaveBeenCalled();
  });

  it("maps a rejected write to a save failure", async () => {
    const { deps } = credentialDeps(DEFAULT_SETTINGS);
    deps.sendMessage = () => Promise.resolve({ ok: false, error: "x" });
    await expect(saveProviderFields({ model: "m" }, deps)).resolves.toEqual({
      ok: false,
      code: "provider_save_failed",
    });
  });

  it("validates the AI form before saving", () => {
    const draft = {
      aiProvider: "openai-compatible" as const,
      baseUrl: "https://api.example/v1",
      apiKey: "",
      model: "m",
      systemPrompt: "p",
      timeoutMs: 30_000,
    };
    expect(validateAiDraft(draft)).toBeUndefined();
    expect(validateAiDraft({ ...draft, model: " " })).toBe(
      "provider_model_missing",
    );
    expect(validateAiDraft({ ...draft, timeoutMs: 1_000 })).toBe(
      "provider_timeout_invalid",
    );
    expect(validateAiDraft({ ...draft, systemPrompt: "" })).toBe(
      "provider_prompt_missing",
    );
    expect(validateAiDraft({ ...draft, baseUrl: "ftp://x" })).toBe(
      "provider_url_invalid",
    );
  });

  it("maps connection test replies to stable codes", async () => {
    await expect(
      testProviderConnection({
        sendMessage: () => Promise.resolve({ ok: true }),
      }),
    ).resolves.toEqual({ ok: true, code: "connection_succeeded" });
    await expect(
      testProviderConnection({
        sendMessage: () =>
          Promise.resolve({ ok: false, message: "HTTP 401. details" }),
      }),
    ).resolves.toEqual({
      ok: false,
      code: "connection_failed",
      diagnostic: "HTTP 401. details",
    });
    await expect(
      testProviderConnection({
        sendMessage: () => Promise.reject(new Error("gone")),
      }),
    ).resolves.toEqual({ ok: false, code: "connection_unreachable" });
  });
});
