import { describe, expect, it, vi } from "vitest";
import {
  SiteProfilesController,
  newSiteProfileId,
  validationFailureOf,
  type SiteProfilesDeps,
} from "@/entrypoints/options/site-profiles";
import { DEFAULT_SETTINGS, type AppSettings } from "@/src/shared/settings";
import type { SiteProfileDocument } from "@/src/site-profiles/document";
import type { SiteTranslationProfile } from "@/src/site-profiles/types";
import {
  BUILT_IN_SITE_PROFILES,
  builtInSiteProfile,
} from "@/src/subtitles/profiles/registry";

vi.mock("wxt/browser", () => ({
  browser: { runtime: { sendMessage: vi.fn() } },
}));

type Reply = (message: Record<string, unknown>) => unknown;

function harness(
  replies: Record<string, Reply> = {},
  options: { confirm?: boolean; settings?: AppSettings } = {},
) {
  const sent: Record<string, unknown>[] = [];
  const translation: SiteTranslationProfile = {
    id: "user-example-org",
    version: 1,
    name: "Example",
    match: { hostnameSuffixes: ["example.org"] },
    overrides: {
      subtitles: {
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        mode: "fast",
        fastProvider: "chrome-local",
        modelOverride: "",
      },
    },
  };
  const confirm = vi.fn(() => Promise.resolve(options.confirm ?? true));
  const deps: SiteProfilesDeps = {
    sendMessage: vi.fn((value: unknown) => {
      const message = value as Record<string, unknown>;
      sent.push(message);
      const reply = replies[message.type as string];
      if (reply) return Promise.resolve(reply(message));
      if (message.type === "SITE_PROFILES_GET") {
        return Promise.resolve({
          ok: true,
          builtIns: BUILT_IN_SITE_PROFILES,
          profiles: [],
          overrides: [],
          translationProfiles: [translation],
        });
      }
      if (message.type === "SITE_TRANSLATION_PROFILE_SAVE") {
        return Promise.resolve({ ok: true, profile: message.profile });
      }
      return Promise.resolve({ ok: true });
    }),
    confirm,
    requestRender: vi.fn(),
    settings: () => options.settings ?? structuredClone(DEFAULT_SETTINGS),
    copyText: vi.fn(() => Promise.resolve()),
    download: vi.fn(),
    message: (key: string, subs?: string | string[]) =>
      subs && subs.length > 0 ? `${key}(${[subs].flat().join(",")})` : key,
  };
  return { sites: new SiteProfilesController(deps), confirm, sent };
}

describe("site profiles controller", () => {
  it("lists bundled and user sites and skips the generic fallback", async () => {
    const { sites } = harness();
    await sites.load();
    const { builtIn, custom } = sites.entries();
    expect(sites.status).toBe("ready");
    expect(builtIn.map((entry) => entry.id)).toContain("netflix");
    expect(builtIn.some((entry) => entry.hostnames.includes("*"))).toBe(false);
    expect(custom).toEqual([
      expect.objectContaining({
        id: "user-example-org",
        kind: "site",
        surfaces: ["subtitles"],
      }),
    ]);
  });

  it("overrides one surface of a built-in site starting from the global values", async () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.page.targetLanguage = "ja";
    const { sites, sent } = harness({}, { settings });
    await sites.load();
    sites.open({ id: "netflix", kind: "builtin" });
    expect(sites.view).toBe("detail");
    expect(sites.dirty).toBe(false);
    sites.setSurfaceOverride("page", true);
    expect(sites.doc.overrides.page?.targetLanguage).toBe("ja");
    sites.patchSurface("page", { mode: "ai", modelOverride: "m-1" });
    expect(sites.dirty).toBe(true);
    expect(
      (JSON.parse(sites.jsonText) as SiteProfileDocument).overrides.page?.mode,
    ).toBe("ai");
    await sites.save();
    const saved = sent.find(
      (message) => message.type === "SITE_TRANSLATION_PROFILE_SAVE",
    );
    expect(saved?.profile).toMatchObject({
      id: "netflix",
      overrides: { page: { mode: "ai", modelOverride: "m-1" } },
    });
    // Bundled capture rules stay bundled: no capture profile is written.
    expect(sent.some((m) => m.type === "SITE_PROFILE_EDITOR_SAVE")).toBe(false);
    expect(sites.kind).toBe("builtin");
    expect(sites.dirty).toBe(false);
    expect(sites.feedback?.key).toBe("profileSaved");
  });

  it("creates a new site whose id follows its hostname and reports background validation", async () => {
    const { sites, sent } = harness({
      SITE_TRANSLATION_PROFILE_SAVE: () => ({
        ok: false,
        error: "site_profile_invalid",
        path: "$.match.hostnameSuffixes[0]",
        reason: "unsafe_hostname",
      }),
    });
    await sites.load();
    sites.openNew();
    sites.setName("Docs");
    sites.setHostname("  .Docs.Example.COM. ");
    expect(sites.doc.match).toEqual({ hostnameSuffixes: ["docs.example.com"] });
    expect(sites.doc.id).toBe(newSiteProfileId("docs.example.com"));
    sites.setSurfaceOverride("selection", true);
    await sites.save();
    expect(sent.at(-1)?.type).toBe("SITE_TRANSLATION_PROFILE_SAVE");
    expect(sites.feedback).toEqual({
      key: "profileValidationError",
      tone: "error",
      subs: ["$.match.hostnameSuffixes[0]", "profileValidationUnsafeHostname"],
    });
    expect(sites.dirty).toBe(true);
  });

  it("rejects a non-allowlisted parser from JSON before anything is sent", async () => {
    const { sites, sent } = harness();
    await sites.load();
    sites.open({ id: "user-example-org", kind: "site" });
    const document = JSON.parse(sites.jsonText) as {
      subtitleCapture: { customized: boolean; parser: string };
    };
    document.subtitleCapture.customized = true;
    document.subtitleCapture.parser = "eval";
    expect(sites.applyJson(JSON.stringify(document))).toBe(false);
    expect(sites.jsonError?.key).toBe("profileValidationError");
    expect(sites.doc.subtitleCapture.parser).not.toBe("eval");
    const before = sent.length;
    sites.setCaptureCustomized(true);
    sites.patchCapture({ selectors: { video: "" } });
    await sites.save();
    expect(sent.length).toBe(before);
    expect(sites.feedback?.key).toBe("profileValidationError");
  });

  it("saves customized capture rules as a narrowed built-in override", async () => {
    const netflix = builtInSiteProfile("netflix");
    const { sites, sent } = harness({
      SITE_PROFILE_EDITOR_SAVE: (message) => ({
        ok: true,
        kind: "override",
        profile: message.profile,
      }),
    });
    await sites.load();
    sites.open({ id: "netflix", kind: "builtin" });
    sites.setCaptureCustomized(true);
    sites.patchCapture({ priority: netflix.priority });
    await sites.save();
    expect(sent.map((message) => message.type)).toEqual([
      "SITE_PROFILES_GET",
      "SITE_TRANSLATION_PROFILE_SAVE",
      "SITE_PROFILE_EDITOR_SAVE",
    ]);
    expect(sites.kind).toBe("override");
    expect(sites.entries().builtIn.find((e) => e.id === "netflix")?.kind).toBe(
      "override",
    );
  });

  it("deletes and restores only after confirmation", async () => {
    const declined = harness({}, { confirm: false });
    await declined.sites.load();
    declined.sites.open({ id: "user-example-org", kind: "site" });
    await declined.sites.remove();
    expect(
      declined.sent.some((m) => m.type === "SITE_TRANSLATION_PROFILE_DELETE"),
    ).toBe(false);

    const { sites, sent, confirm } = harness();
    await sites.load();
    sites.open({ id: "user-example-org", kind: "site" });
    await sites.remove();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true }),
    );
    expect(sent.at(-1)).toEqual({
      type: "SITE_TRANSLATION_PROFILE_DELETE",
      id: "user-example-org",
    });
    expect(sites.view).toBe("list");
    expect(sites.entries().custom).toEqual([]);
  });

  it("asks before leaving unsaved edits and restores the snapshot on cancel", async () => {
    const { sites, confirm } = harness({}, { confirm: false });
    await sites.load();
    sites.open({ id: "netflix", kind: "builtin" });
    sites.setName("Renamed");
    await sites.back();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sites.view).toBe("detail");
    sites.cancel();
    expect(sites.dirty).toBe(false);
    await sites.back();
    expect(sites.view).toBe("list");
    expect(sites.focusTarget).toBe("site-entry-netflix");
  });

  it("parses only well-formed validation replies", () => {
    expect(
      validationFailureOf({
        ok: false,
        error: "site_profile_invalid",
        path: "$.parser",
        reason: "parser_not_allowed",
      }),
    ).toEqual({ path: "$.parser", reason: "parser_not_allowed" });
    expect(
      validationFailureOf({
        ok: false,
        error: "site_profile_invalid",
        path: "$",
        reason: "made_up",
      }),
    ).toBeNull();
  });
});
