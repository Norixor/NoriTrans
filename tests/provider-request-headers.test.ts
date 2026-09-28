import { describe, expect, it, vi } from "vitest";

vi.mock("wxt/browser", () => ({
  browser: { runtime: { id: "test-extension-id" } },
}));

const { DEFAULT_SETTINGS } = await import("@/src/shared/settings");
const {
  PROVIDER_ORIGIN_RULE_ID,
  providerOriginRule,
  providerRequestDomains,
  syncProviderOriginRule,
} = await import("@/src/shared/provider-request-headers");

function settingsWithBaseUrl(baseUrl: string) {
  return {
    ...DEFAULT_SETTINGS,
    provider: { ...DEFAULT_SETTINGS.provider, baseUrl },
  };
}

describe("provider Origin header rule", () => {
  it("covers the configured AI host and every fixed machine-translation host", () => {
    expect(
      providerRequestDomains(
        settingsWithBaseUrl("https://gateway.example:8443/v1"),
      ),
    ).toEqual([
      "api-free.deepl.com",
      "api.cognitive.microsofttranslator.com",
      "api.deepl.com",
      "gateway.example",
      "translation.googleapis.com",
    ]);
  });

  it("uses bare IPv6 hosts and ignores an invalid Base URL", () => {
    expect(
      providerRequestDomains(settingsWithBaseUrl("http://[::1]:11434/v1")),
    ).toContain("::1");
    expect(providerRequestDomains(settingsWithBaseUrl("not a url"))).toEqual([
      "api-free.deepl.com",
      "api.cognitive.microsofttranslator.com",
      "api.deepl.com",
      "translation.googleapis.com",
    ]);
  });

  it("only removes Origin from this extension's own requests", () => {
    const rule = providerOriginRule(["gateway.example"], "extension-id");
    expect(rule.action.requestHeaders).toEqual([
      { header: "origin", operation: "remove" },
    ]);
    expect(rule.condition.initiatorDomains).toEqual(["extension-id"]);
    expect(rule.condition.requestDomains).toEqual(["gateway.example"]);
  });

  it("replaces the previous session rule", async () => {
    const updateSessionRules = vi.fn(() => Promise.resolve());
    await expect(
      syncProviderOriginRule(
        settingsWithBaseUrl("https://gateway.example/v1"),
        { updateSessionRules },
        "extension-id",
      ),
    ).resolves.toBe(true);
    expect(updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [PROVIDER_ORIGIN_RULE_ID],
      addRules: [
        providerOriginRule(
          providerRequestDomains(
            settingsWithBaseUrl("https://gateway.example/v1"),
          ),
          "extension-id",
        ),
      ],
    });
  });

  it("never blocks translation when the rule cannot be installed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      syncProviderOriginRule(
        DEFAULT_SETTINGS,
        { updateSessionRules: () => Promise.reject(new Error("quota")) },
        "extension-id",
      ),
    ).resolves.toBe(false);
    await expect(
      syncProviderOriginRule(DEFAULT_SETTINGS, undefined, "extension-id"),
    ).resolves.toBe(false);
    warn.mockRestore();
  });
});
