import {
  BUILT_IN_SITE_PROFILES,
  builtInNativeCaptionSelectorsForLocation,
  builtInSiteProfile,
  parseSiteProfile,
  profileMatchesHostname,
  profileMatchesLocation,
  isUserSiteProfile,
} from "@/src/subtitles/profiles/registry";
import { createSubtitleAdapters } from "@/src/subtitles/adapters";
import { isAllowedSubtitleCaptureUrl } from "@/src/subtitles/adapters/captured";
import { describe, expect, it } from "vitest";

describe("subtitle site profiles", () => {
  it("ships validated default and built-in streaming-site profiles", () => {
    expect(BUILT_IN_SITE_PROFILES.map((profile) => profile.id)).toEqual([
      "default-html5",
      "youtube",
      "netflix",
      "max",
      "disney-plus",
      "prime-video",
      "apple-tv",
      "hulu",
      "paramount-plus",
      "discovery-plus",
      "peacock",
      "fubo-tv",
      "tver",
      "ted",
      "bbc-iplayer",
      "zdf",
      "deutsche-welle",
      "udemy",
      "kanopy",
      "default-dom-heuristic",
    ]);
    expect(
      profileMatchesHostname(
        builtInSiteProfile("youtube"),
        "music.youtube.com",
      ),
    ).toBe(true);
    expect(
      profileMatchesLocation(builtInSiteProfile("prime-video"), {
        hostname: "www.amazon.com",
        pathname: "/gp/video/detail/example",
      }),
    ).toBe(true);
    expect(
      profileMatchesLocation(builtInSiteProfile("prime-video"), {
        hostname: "www.amazon.com",
        pathname: "/s?k=headphones",
      }),
    ).toBe(false);
    expect(
      profileMatchesHostname(builtInSiteProfile("netflix"), "www.netflix.com"),
    ).toBe(true);
    expect(
      profileMatchesHostname(builtInSiteProfile("max"), "play.max.com"),
    ).toBe(true);
    expect(
      profileMatchesHostname(
        builtInSiteProfile("disney-plus"),
        "www.disneyplus.com",
      ),
    ).toBe(true);
    expect(
      profileMatchesHostname(
        builtInSiteProfile("prime-video"),
        "www.primevideo.com",
      ),
    ).toBe(true);
    const matches = (id: string, hostname: string, pathname = "/"): boolean =>
      profileMatchesLocation(builtInSiteProfile(id), {
        hostname,
        pathname,
      });
    expect(matches("apple-tv", "tv.apple.com")).toBe(true);
    expect(matches("hulu", "www.hulu.com")).toBe(true);
    expect(matches("paramount-plus", "www.paramountplus.com")).toBe(true);
    expect(matches("discovery-plus", "www.discoveryplus.com")).toBe(true);
    expect(matches("peacock", "www.peacocktv.com")).toBe(true);
    expect(matches("fubo-tv", "www.fubo.tv")).toBe(true);
    expect(matches("ted", "www.ted.com")).toBe(true);
    expect(
      matches("bbc-iplayer", "www.bbc.co.uk", "/iplayer/episode/one"),
    ).toBe(true);
    expect(matches("bbc-iplayer", "www.bbc.co.uk", "/news")).toBe(false);
    expect(matches("zdf", "www.zdf.de", "/play/serien/example")).toBe(true);
    expect(matches("zdf", "www.zdf.de", "/nachrichten")).toBe(false);
    expect(matches("deutsche-welle", "www.dw.com")).toBe(true);
    expect(matches("udemy", "www.udemy.com", "/course/example/learn")).toBe(
      true,
    );
    expect(matches("kanopy", "university.kanopy.com")).toBe(true);
    expect(matches("tver", "tver.jp")).toBe(true);
    expect(matches("apple-tv", "play.appletv.com")).toBe(true);
    expect(matches("hulu", "www.hulu.jp")).toBe(true);
    expect(builtInSiteProfile("hulu").selectors.nativeCaptions).toContain(
      "img[src*='s2.happyon.jp'][src*='size=']",
    );
  });

  it("uses only the current built-in site's native-caption selectors", () => {
    const youtubeSelectors = builtInNativeCaptionSelectorsForLocation({
      hostname: "www.youtube.com",
      pathname: "/watch",
    });
    expect(youtubeSelectors).toContain(".ytp-caption-window-container");
    expect(youtubeSelectors).not.toContain(".caption-cue");

    const maxSelectors = builtInNativeCaptionSelectorsForLocation({
      hostname: "play.max.com",
      pathname: "/video/example",
    });
    expect(maxSelectors).toContain(".caption-cue");
    expect(maxSelectors).not.toContain(".ytp-caption-segment");
  });

  it("allows only subtitle-shaped network resources from each built-in site allowlist", () => {
    expect(
      isAllowedSubtitleCaptureUrl(
        "max",
        "https://cmaf.fly.eu.hbomaxcdn.com/title/text/en/segment-4.vtt",
      ),
    ).toBe(true);
    expect(
      isAllowedSubtitleCaptureUrl(
        "max",
        "https://cmaf.fly.eu.hbomaxcdn.com/title/text/en/subtitles.m3u8",
      ),
    ).toBe(true);
    expect(
      isAllowedSubtitleCaptureUrl(
        "disney-plus",
        "https://vod.media.dssott.com/title/subtitles/en/segment-7.vtt",
      ),
    ).toBe(true);
    expect(
      isAllowedSubtitleCaptureUrl(
        "prime-video",
        "https://d123.cloudfront.net/title/subtitle/en/segment-8.vtt",
      ),
    ).toBe(true);
    expect(
      isAllowedSubtitleCaptureUrl(
        "max",
        "https://cmaf.fly.eu.hbomaxcdn.com/title/video/segment-4.mp4",
      ),
    ).toBe(false);
    expect(
      isAllowedSubtitleCaptureUrl(
        "udemy",
        "https://cdn.udemycdn.com/captions/lesson-en.vtt",
      ),
    ).toBe(true);
    expect(
      isAllowedSubtitleCaptureUrl(
        "kanopy",
        "https://university.kanopy.com/captioncache/webvtt/example.vtt",
      ),
    ).toBe(true);
    expect(
      isAllowedSubtitleCaptureUrl(
        "udemy",
        "https://attacker.example/captions/lesson-en.vtt",
      ),
    ).toBe(false);
    expect(
      isAllowedSubtitleCaptureUrl(
        "disney-plus",
        "https://attacker.example/title/subtitles/en/segment-7.vtt",
      ),
    ).toBe(false);
  });

  it("installs default network and DOM fallbacks for the new streaming profiles", () => {
    const matchingIds = (hostname: string, pathname = "/") => {
      const location = { hostname, pathname } as Location;
      return createSubtitleAdapters([], location)
        .filter((adapter) => adapter.matches(location))
        .map((adapter) => adapter.id);
    };

    expect(matchingIds("play.max.com")).toEqual([
      "html5-texttrack",
      "profile:max:network",
      "profile:max",
    ]);
    expect(matchingIds("www.disneyplus.com")).toEqual([
      "html5-texttrack",
      "profile:disney-plus:network",
      "profile:disney-plus",
    ]);
    expect(matchingIds("www.primevideo.com")).toEqual([
      "html5-texttrack",
      "profile:prime-video:network",
      "profile:prime-video",
    ]);
    expect(matchingIds("www.amazon.com")).toContain(
      "profile:default-dom-heuristic",
    );
    expect(matchingIds("www.amazon.com", "/gp/video/detail/example")).toEqual([
      "html5-texttrack",
      "profile:prime-video:network",
      "profile:prime-video",
    ]);
    expect(matchingIds("www.udemy.com", "/course/example/learn")).toEqual([
      "html5-texttrack",
      "profile:udemy:network",
      "profile:udemy",
    ]);
    expect(matchingIds("www.zdf.de", "/play/serien/example")).toEqual([
      "html5-texttrack",
      "profile:zdf:network",
      "profile:zdf",
    ]);
    expect(matchingIds("tver.jp")).toEqual(["html5-texttrack", "profile:tver"]);
  });

  it("keeps Tencent OCR-only even when a stale user DOM profile exists", () => {
    const staleUserProfile = {
      ...builtInSiteProfile("default-dom-heuristic"),
      id: "user-v-qq-com",
      name: "v.qq.com",
      priority: 1,
      match: { hostnameSuffixes: ["v.qq.com"] },
      selectors: {
        video: "video",
        captions: ["div.player-shell"],
        nativeCaptions: ["div.player-shell"],
      },
    };
    const adapters = createSubtitleAdapters([staleUserProfile], {
      hostname: "v.qq.com",
    } as Location);
    const matchingAdapterIds = adapters
      .filter((adapter) =>
        adapter.matches({ hostname: "v.qq.com" } as Location),
      )
      .map((adapter) => adapter.id);

    expect(adapters).toEqual([]);
    expect(matchingAdapterIds).toEqual([]);
  });

  it("rejects profiles that request an arbitrary parser", () => {
    expect(() =>
      parseSiteProfile({
        ...builtInSiteProfile("default-html5"),
        parser: "javascript",
      }),
    ).toThrow("$.parser: parser_not_allowed");
  });

  it("accepts only a small hostname-bound user DOM profile", () => {
    const profile = {
      ...builtInSiteProfile("default-dom-heuristic"),
      id: "user-example-com",
      name: "example.com",
      priority: 1,
      match: { hostnameSuffixes: ["example.com"] },
      selectors: {
        video: "video",
        captions: ["div.caption-layer"],
        nativeCaptions: ["div.caption-layer"],
      },
    };
    expect(isUserSiteProfile(profile, "example.com")).toBe(true);
    expect(
      isUserSiteProfile(
        {
          ...profile,
          selectors: {
            ...profile.selectors,
            captions: ["body > section:nth-of-type(2) > div:nth-of-type(1)"],
          },
        },
        "example.com",
      ),
    ).toBe(true);
    expect(
      isUserSiteProfile(
        {
          ...profile,
          selectors: {
            ...profile.selectors,
            captions: ['[aria-live="polite"]'],
          },
        },
        "example.com",
      ),
    ).toBe(false);
    expect(isUserSiteProfile(profile, "other.example.com")).toBe(false);
    for (const unsafeSelector of [
      ".123",
      "#123",
      ".-9foo",
      "body > #123:nth-of-type(1)",
    ]) {
      expect(
        isUserSiteProfile(
          {
            ...profile,
            selectors: {
              ...profile.selectors,
              captions: [unsafeSelector],
            },
          },
          "example.com",
        ),
      ).toBe(false);
    }
    expect(
      isUserSiteProfile(
        {
          ...profile,
          selectors: {
            ...profile.selectors,
            captions: ["div.valid_caption-1"],
          },
        },
        "example.com",
      ),
    ).toBe(true);
    expect(
      isUserSiteProfile(
        {
          ...profile,
          selectors: {
            ...profile.selectors,
            captions: ["body > div:nth-of-type(1), script:nth-of-type(1)"],
          },
        },
        "example.com",
      ),
    ).toBe(false);
    expect(() => parseSiteProfile({ ...profile, unexpected: true })).toThrow(
      "$.unexpected: unknown_field",
    );
  });

  it("keeps the generic DOM fallback behind a user profile", () => {
    const profile = {
      ...builtInSiteProfile("default-dom-heuristic"),
      id: "user-example-com",
      name: "example.com",
      priority: 1,
      match: { hostnameSuffixes: ["example.com"] },
      selectors: {
        video: "video",
        captions: ["div.site-caption"],
        nativeCaptions: ["div.site-caption"],
      },
    };

    const location = { hostname: "example.com" } as Location;
    const matchingAdapters = createSubtitleAdapters([profile], location).filter(
      (adapter) => adapter.matches(location),
    );

    expect(matchingAdapters.map((adapter) => adapter.id)).toEqual([
      "profile:user-example-com",
      "html5-texttrack",
      "profile:default-dom-heuristic",
    ]);
    expect(matchingAdapters.map((adapter) => adapter.priority)).toEqual([
      0, 1, 90,
    ]);
  });
});
