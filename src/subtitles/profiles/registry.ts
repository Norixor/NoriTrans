import appleTvJson from "./builtin/apple-tv.json";
import bbcIplayerJson from "./builtin/bbc-iplayer.json";
import defaultDomJson from "./builtin/default-dom-heuristic.json";
import defaultHtml5Json from "./builtin/default-html5.json";
import deutscheWelleJson from "./builtin/deutsche-welle.json";
import disneyPlusJson from "./builtin/disney-plus.json";
import discoveryPlusJson from "./builtin/discovery-plus.json";
import fuboTvJson from "./builtin/fubo-tv.json";
import huluJson from "./builtin/hulu.json";
import kanopyJson from "./builtin/kanopy.json";
import maxJson from "./builtin/max.json";
import netflixJson from "./builtin/netflix.json";
import paramountPlusJson from "./builtin/paramount-plus.json";
import peacockJson from "./builtin/peacock.json";
import primeVideoJson from "./builtin/prime-video.json";
import tedJson from "./builtin/ted.json";
import tverJson from "./builtin/tver.json";
import udemyJson from "./builtin/udemy.json";
import youtubeJson from "./builtin/youtube.json";
import zdfJson from "./builtin/zdf.json";
import type { BuiltInSubtitleParser, SubtitleSiteProfile } from "./types";

export const SITE_PROFILE_PARSER_ALLOWLIST = [
  "html5",
  "youtube",
  "netflix",
  "dom",
] as const satisfies readonly BuiltInSubtitleParser[];

const PARSERS = new Set<BuiltInSubtitleParser>(SITE_PROFILE_PARSER_ALLOWLIST);

export type SiteProfileValidationReason =
  | "type"
  | "unknown_field"
  | "required"
  | "format"
  | "range"
  | "unsafe_selector"
  | "unsafe_hostname"
  | "unsafe_url_pattern"
  | "parser_not_allowed"
  | "tencent_ocr_only"
  | "override_not_supported";

export class SiteProfileValidationError extends Error {
  readonly path: string;
  readonly reason: SiteProfileValidationReason;

  constructor(path: string, reason: SiteProfileValidationReason) {
    super(`${path.slice(0, 160)}: ${reason}`);
    this.name = "SiteProfileValidationError";
    this.path = path.slice(0, 160);
    this.reason = reason;
  }
}

function invalid(path: string, reason: SiteProfileValidationReason): never {
  throw new SiteProfileValidationError(path, reason);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isUrlRuleArray(
  value: unknown,
): value is NonNullable<SubtitleSiteProfile["match"]["urlRules"]> {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((candidate: unknown) => {
      if (typeof candidate !== "object" || candidate === null) return false;
      const rule = candidate as Record<string, unknown>;
      if (!hasOnlyKeys(rule, ["hostnameSuffixes", "pathnamePrefixes"])) {
        return false;
      }
      const hostnameSuffixes = rule.hostnameSuffixes;
      const pathnamePrefixes = rule.pathnamePrefixes;
      return (
        isStringArray(hostnameSuffixes) &&
        hostnameSuffixes.length > 0 &&
        hostnameSuffixes.length <= 32 &&
        hostnameSuffixes.every(
          (hostname) => hostname.length > 0 && hostname.length <= 253,
        ) &&
        isStringArray(pathnamePrefixes) &&
        pathnamePrefixes.length > 0 &&
        pathnamePrefixes.length <= 32 &&
        pathnamePrefixes.every(
          (pathname) =>
            pathname.startsWith("/") &&
            pathname.length <= 500 &&
            !/[?#\r\n]/u.test(pathname),
        )
      );
    })
  );
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

export function parseSiteProfile(value: unknown): SubtitleSiteProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid("$", "type");
  }
  const profile = value as Partial<SubtitleSiteProfile>;
  const allowedRootKeys = [
    "id",
    "version",
    "name",
    "parser",
    "priority",
    "match",
    "selectors",
    "capture",
  ] as const;
  const unknownRootKey = Object.keys(value).find(
    (key) => !allowedRootKeys.includes(key as (typeof allowedRootKeys)[number]),
  );
  if (unknownRootKey) invalid(`$.${unknownRootKey}`, "unknown_field");
  if (typeof profile.id !== "string") invalid("$.id", "required");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(profile.id)) invalid("$.id", "format");
  if (profile.version !== 1) invalid("$.version", "format");
  if (typeof profile.name !== "string") invalid("$.name", "required");
  if (profile.name.trim().length === 0 || profile.name.length > 100)
    invalid("$.name", "range");
  if (!PARSERS.has(profile.parser as BuiltInSubtitleParser))
    invalid("$.parser", "parser_not_allowed");
  if (
    typeof profile.priority !== "number" ||
    !Number.isInteger(profile.priority) ||
    profile.priority < 0 ||
    profile.priority > 1_000
  )
    invalid("$.priority", "range");

  if (!profile.match || typeof profile.match !== "object")
    invalid("$.match", "required");
  const unknownMatchKey = Object.keys(profile.match).find(
    (key) => key !== "hostnameSuffixes" && key !== "urlRules",
  );
  if (unknownMatchKey) invalid(`$.match.${unknownMatchKey}`, "unknown_field");
  validateHostnameSuffixes(
    profile.match.hostnameSuffixes,
    "$.match.hostnameSuffixes",
    true,
  );
  if (profile.match.urlRules !== undefined) {
    if (!isUrlRuleArray(profile.match.urlRules))
      invalid("$.match.urlRules", "format");
    profile.match.urlRules.forEach((rule, ruleIndex) => {
      validateHostnameSuffixes(
        rule.hostnameSuffixes,
        `$.match.urlRules[${ruleIndex}].hostnameSuffixes`,
        false,
      );
    });
  }

  if (!profile.selectors || typeof profile.selectors !== "object")
    invalid("$.selectors", "required");
  const unknownSelectorKey = Object.keys(profile.selectors).find(
    (key) => key !== "video" && key !== "captions" && key !== "nativeCaptions",
  );
  if (unknownSelectorKey)
    invalid(`$.selectors.${unknownSelectorKey}`, "unknown_field");
  validateSelector(profile.selectors.video, "$.selectors.video");
  validateSelectorArray(profile.selectors.captions, "$.selectors.captions");
  validateSelectorArray(
    profile.selectors.nativeCaptions,
    "$.selectors.nativeCaptions",
  );

  if (!profile.capture || typeof profile.capture !== "object")
    invalid("$.capture", "required");
  const allowedCaptureKeys = [
    "formats",
    "allowedHostnameSuffixes",
    "urlPatterns",
    "completeFilePatterns",
  ] as const;
  const unknownCaptureKey = Object.keys(profile.capture).find(
    (key) =>
      !allowedCaptureKeys.includes(key as (typeof allowedCaptureKeys)[number]),
  );
  if (unknownCaptureKey)
    invalid(`$.capture.${unknownCaptureKey}`, "unknown_field");
  if (
    !Array.isArray(profile.capture.formats) ||
    profile.capture.formats.length > 8
  )
    invalid("$.capture.formats", "range");
  profile.capture.formats.forEach((format, index) => {
    if (format !== "vtt" && format !== "ttml" && format !== "json3")
      invalid(`$.capture.formats[${index}]`, "format");
  });
  validateHostnameSuffixes(
    profile.capture.allowedHostnameSuffixes,
    "$.capture.allowedHostnameSuffixes",
    false,
    true,
  );
  validateUrlPatterns(profile.capture.urlPatterns, "$.capture.urlPatterns");
  if (profile.capture.completeFilePatterns !== undefined) {
    validateUrlPatterns(
      profile.capture.completeFilePatterns,
      "$.capture.completeFilePatterns",
    );
  }
  return profile as SubtitleSiteProfile;
}

const SAFE_HOSTNAME_SUFFIX =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function validateHostnameSuffixes(
  value: unknown,
  path: string,
  allowWildcard: boolean,
  allowEmpty = false,
): asserts value is string[] {
  if (!Array.isArray(value)) invalid(path, "type");
  if ((!allowEmpty && value.length === 0) || value.length > 32)
    invalid(path, "range");
  value.forEach((hostname, index) => {
    if (
      typeof hostname !== "string" ||
      (hostname !== "*" &&
        (hostname !== hostname.toLowerCase() ||
          !SAFE_HOSTNAME_SUFFIX.test(hostname))) ||
      (hostname === "*" && !allowWildcard)
    ) {
      invalid(`${path}[${index}]`, "unsafe_hostname");
    }
  });
}

function validateSelector(
  value: unknown,
  path: string,
): asserts value is string {
  if (typeof value !== "string") invalid(path, "type");
  const normalized = value.trim().toLowerCase();
  if (
    value.trim().length === 0 ||
    value.length > 500 ||
    normalized === "*" ||
    normalized === "html" ||
    normalized === "body" ||
    normalized === ":root" ||
    /[,{};\r\n\0]/u.test(value) ||
    /(?:javascript|data)\s*:/iu.test(value)
  )
    invalid(path, "unsafe_selector");
}

function validateSelectorArray(
  value: unknown,
  path: string,
): asserts value is string[] {
  if (!Array.isArray(value)) invalid(path, "type");
  if (value.length > 32) invalid(path, "range");
  value.forEach((selector, index) =>
    validateSelector(selector, `${path}[${index}]`),
  );
}

function validateUrlPatterns(
  value: unknown,
  path: string,
): asserts value is string[] {
  if (!Array.isArray(value)) invalid(path, "type");
  if (value.length > 32) invalid(path, "range");
  value.forEach((pattern, index) => {
    if (
      typeof pattern !== "string" ||
      pattern.trim().length === 0 ||
      pattern.length > 500 ||
      /[\r\n\0\\]/u.test(pattern) ||
      /^(?:javascript|data|file):/iu.test(pattern) ||
      /@/u.test(pattern)
    )
      invalid(`${path}[${index}]`, "unsafe_url_pattern");
  });
}

export function isSafeProfileSelector(value: string): boolean {
  if (value.length === 0 || value.length > 240) return false;
  if (
    /^(?:body|#(?:[a-zA-Z_][a-zA-Z0-9_-]*|-[a-zA-Z_-][a-zA-Z0-9_-]*))(?: > [a-z][a-z0-9-]*:nth-of-type\([1-9][0-9]{0,3}\)){1,10}$/u.test(
      value,
    )
  )
    return true;
  if (/[,>+~:*{}();\r\n]/u.test(value)) return false;
  return /^(?:[a-z][a-z0-9-]*)?(?:(?:#(?:[a-zA-Z_][a-zA-Z0-9_-]*|-[a-zA-Z_-][a-zA-Z0-9_-]*))|(?:\.(?:[a-zA-Z_][a-zA-Z0-9_-]*|-[a-zA-Z_-][a-zA-Z0-9_-]*)))+$/u.test(
    value,
  );
}

export function isUserSiteProfile(
  value: unknown,
  expectedHostname?: string,
): value is SubtitleSiteProfile {
  try {
    const profile = parseSiteProfile(value);
    const hostname = profile.match.hostnameSuffixes[0];
    return (
      profile.id.startsWith("user-") &&
      profile.id.length <= 64 &&
      profile.parser === "dom" &&
      profile.priority >= 0 &&
      profile.priority < 10 &&
      profile.match.hostnameSuffixes.length === 1 &&
      profile.match.urlRules === undefined &&
      typeof hostname === "string" &&
      hostname !== "*" &&
      hostname === hostname.toLowerCase() &&
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
          hostname,
        )) &&
      (!expectedHostname || hostname === expectedHostname.toLowerCase()) &&
      profile.selectors.video === "video" &&
      profile.selectors.captions.length === 1 &&
      profile.selectors.captions.every(isSafeProfileSelector) &&
      profile.selectors.nativeCaptions.length <= 1 &&
      profile.selectors.nativeCaptions.every(isSafeProfileSelector) &&
      profile.capture.formats.length === 0 &&
      profile.capture.allowedHostnameSuffixes.length === 0 &&
      profile.capture.urlPatterns.length === 0 &&
      (profile.capture.completeFilePatterns === undefined ||
        profile.capture.completeFilePatterns.length === 0)
    );
  } catch {
    return false;
  }
}

export const BUILT_IN_SITE_PROFILES = [
  parseSiteProfile(youtubeJson),
  parseSiteProfile(netflixJson),
  parseSiteProfile(maxJson),
  parseSiteProfile(disneyPlusJson),
  parseSiteProfile(primeVideoJson),
  parseSiteProfile(appleTvJson),
  parseSiteProfile(huluJson),
  parseSiteProfile(paramountPlusJson),
  parseSiteProfile(discoveryPlusJson),
  parseSiteProfile(peacockJson),
  parseSiteProfile(fuboTvJson),
  parseSiteProfile(tedJson),
  parseSiteProfile(bbcIplayerJson),
  parseSiteProfile(zdfJson),
  parseSiteProfile(deutscheWelleJson),
  parseSiteProfile(udemyJson),
  parseSiteProfile(kanopyJson),
  parseSiteProfile(tverJson),
  parseSiteProfile(defaultHtml5Json),
  parseSiteProfile(defaultDomJson),
].sort((left, right) => left.priority - right.priority);

function arrayIsSubset<T>(
  candidate: readonly T[],
  allowed: readonly T[],
): boolean {
  const allowedValues = new Set(allowed);
  return candidate.every((value) => allowedValues.has(value));
}

function hostnameIsWithinBuiltIn(
  hostname: string,
  builtInSuffixes: readonly string[],
): boolean {
  return builtInSuffixes.some(
    (suffix) =>
      suffix === "*" || hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

function assertOverrideMatchIsNarrower(
  profile: SubtitleSiteProfile,
  builtIn: SubtitleSiteProfile,
): void {
  profile.match.hostnameSuffixes.forEach((hostname, index) => {
    if (!hostnameIsWithinBuiltIn(hostname, builtIn.match.hostnameSuffixes)) {
      invalid(`$.match.hostnameSuffixes[${index}]`, "override_not_supported");
    }
  });
  const builtInRules = builtIn.match.urlRules;
  const overrideRules = profile.match.urlRules;
  if (!builtInRules || builtInRules.length === 0) return;
  if (!overrideRules || overrideRules.length === 0)
    invalid("$.match.urlRules", "override_not_supported");
  overrideRules.forEach((rule, ruleIndex) => {
    const isNarrower = rule.hostnameSuffixes.every((hostname) =>
      rule.pathnamePrefixes.every((pathname) =>
        builtInRules.some(
          (builtInRule) =>
            hostnameIsWithinBuiltIn(hostname, builtInRule.hostnameSuffixes) &&
            builtInRule.pathnamePrefixes.some(
              (prefix) => prefix === "/" || pathname.startsWith(prefix),
            ),
        ),
      ),
    );
    if (!isNarrower)
      invalid(`$.match.urlRules[${ruleIndex}]`, "override_not_supported");
  });
}

function assertOverrideCaptureIsNarrower(
  profile: SubtitleSiteProfile,
  builtIn: SubtitleSiteProfile,
): void {
  const checks: Array<{
    path: string;
    candidate: readonly string[];
    allowed: readonly string[];
  }> = [
    {
      path: "$.capture.formats",
      candidate: profile.capture.formats,
      allowed: builtIn.capture.formats,
    },
    {
      path: "$.capture.urlPatterns",
      candidate: profile.capture.urlPatterns,
      allowed: builtIn.capture.urlPatterns,
    },
    {
      path: "$.capture.completeFilePatterns",
      candidate: profile.capture.completeFilePatterns ?? [],
      allowed: builtIn.capture.completeFilePatterns ?? [],
    },
  ];
  for (const check of checks) {
    if (!arrayIsSubset(check.candidate, check.allowed))
      invalid(check.path, "override_not_supported");
  }
  profile.capture.allowedHostnameSuffixes.forEach((hostname, index) => {
    if (
      !hostnameIsWithinBuiltIn(
        hostname,
        builtIn.capture.allowedHostnameSuffixes,
      )
    ) {
      invalid(
        `$.capture.allowedHostnameSuffixes[${index}]`,
        "override_not_supported",
      );
    }
  });
}

function assertNotTencentProfile(profile: SubtitleSiteProfile): void {
  const hostnameGroups = [
    profile.match.hostnameSuffixes,
    ...(profile.match.urlRules?.map((rule) => rule.hostnameSuffixes) ?? []),
  ];
  if (
    hostnameGroups.some((suffixes) =>
      hostnameMatchesSuffixes("v.qq.com", suffixes),
    )
  )
    invalid("$.match", "tencent_ocr_only");
}

/** Parse a text-editor Profile using the same production schema and allowlists. */
export function parseEditableSiteProfile(value: unknown): SubtitleSiteProfile {
  const profile = parseSiteProfile(value);
  assertNotTencentProfile(profile);
  if (profile.id.startsWith("user-")) {
    if (!isUserSiteProfile(profile)) invalid("$", "override_not_supported");
    return profile;
  }
  const builtIn = BUILT_IN_SITE_PROFILES.find(
    (candidate) => candidate.id === profile.id,
  );
  if (!builtIn || profile.parser !== builtIn.parser)
    invalid("$.id", "override_not_supported");
  // Runtime gives the current-site user Profile priority 0.
  if (profile.priority < 1) invalid("$.priority", "override_not_supported");
  assertOverrideMatchIsNarrower(profile, builtIn);
  assertOverrideCaptureIsNarrower(profile, builtIn);
  return profile;
}

export function isEditableSiteProfile(
  value: unknown,
): value is SubtitleSiteProfile {
  try {
    parseEditableSiteProfile(value);
    return true;
  } catch {
    return false;
  }
}

export function isBuiltInProfileOverride(
  value: unknown,
): value is SubtitleSiteProfile {
  try {
    const profile = parseEditableSiteProfile(value);
    return !profile.id.startsWith("user-");
  } catch {
    return false;
  }
}

export function effectiveBuiltInSiteProfiles(
  overrides: readonly SubtitleSiteProfile[],
): SubtitleSiteProfile[] {
  const overrideById = new Map(
    overrides
      .filter(isBuiltInProfileOverride)
      .map((profile) => [profile.id, profile] as const),
  );
  return BUILT_IN_SITE_PROFILES.map(
    (profile) => overrideById.get(profile.id) ?? profile,
  ).sort((left, right) => left.priority - right.priority);
}

export const MINIMAL_USER_SITE_PROFILE_TEMPLATE: SubtitleSiteProfile =
  parseEditableSiteProfile({
    id: "user-example-com",
    version: 1,
    name: "Example.com subtitles",
    parser: "dom",
    priority: 5,
    match: { hostnameSuffixes: ["example.com"] },
    selectors: {
      video: "video",
      captions: [".subtitle"],
      nativeCaptions: [".subtitle"],
    },
    capture: {
      formats: [],
      allowedHostnameSuffixes: [],
      urlPatterns: [],
    },
  });

export function builtInSiteProfile(id: string): SubtitleSiteProfile {
  const profile = BUILT_IN_SITE_PROFILES.find(
    (candidate) => candidate.id === id,
  );
  if (!profile) throw new Error(`Missing built-in subtitle profile: ${id}`);
  return profile;
}

export function profileMatchesHostname(
  profile: SubtitleSiteProfile,
  hostname: string,
): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
  return profile.match.hostnameSuffixes.some(
    (suffix) =>
      suffix === "*" ||
      normalizedHostname === suffix ||
      normalizedHostname.endsWith(`.${suffix}`),
  );
}

function hostnameMatchesSuffixes(
  hostname: string,
  suffixes: readonly string[],
): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/u, "");
  return suffixes.some(
    (suffix) =>
      suffix === "*" ||
      normalizedHostname === suffix ||
      normalizedHostname.endsWith(`.${suffix}`),
  );
}

/** Tencent Video is intentionally limited to user-initiated local OCR. */
export function isOcrOnlySubtitleLocation(
  locationValue: Pick<Location, "hostname">,
): boolean {
  return hostnameMatchesSuffixes(locationValue.hostname, ["v.qq.com"]);
}

/** Match a profile against both host and route when a built-in profile opts in. */
export function profileMatchesLocation(
  profile: SubtitleSiteProfile,
  locationValue: Pick<Location, "hostname"> &
    Partial<Pick<Location, "pathname">>,
): boolean {
  const rules = profile.match.urlRules;
  if (!rules || rules.length === 0) {
    return profileMatchesHostname(profile, locationValue.hostname);
  }
  const pathname = locationValue.pathname || "/";
  return rules.some(
    (rule) =>
      hostnameMatchesSuffixes(locationValue.hostname, rule.hostnameSuffixes) &&
      rule.pathnamePrefixes.some(
        (prefix) => prefix === "/" || pathname.startsWith(prefix),
      ),
  );
}

export function profileCaptionSelector(profile: SubtitleSiteProfile): string {
  return profile.selectors.captions.join(",");
}

/** Return only the native-caption selectors declared by built-ins for this route. */
export function builtInNativeCaptionSelectorsForLocation(
  locationValue: Pick<Location, "hostname"> &
    Partial<Pick<Location, "pathname">>,
): string[] {
  return [
    ...new Set(
      BUILT_IN_SITE_PROFILES.filter((profile) =>
        profileMatchesLocation(profile, locationValue),
      ).flatMap((profile) => profile.selectors.nativeCaptions),
    ),
  ];
}
