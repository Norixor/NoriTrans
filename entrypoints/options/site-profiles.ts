import type { AppSettings } from "@/src/shared/settings";
import {
  createSiteProfileDocument,
  parseSiteProfileDocument,
  type SiteProfileDocument,
} from "@/src/site-profiles/document";
import type {
  SitePageTranslationOverride,
  SiteSelectionTranslationOverride,
  SiteSubtitleTranslationOverride,
  SiteTranslationProfile,
} from "@/src/site-profiles/types";
import { isSiteTranslationProfile } from "@/src/site-profiles/validation";
import {
  isBuiltInProfileOverride,
  isUserSiteProfile,
  MINIMAL_USER_SITE_PROFILE_TEMPLATE,
  parseEditableSiteProfile,
  parseSiteProfile,
  SiteProfileValidationError,
  type SiteProfileValidationReason,
} from "@/src/subtitles/profiles/registry";
import type { SubtitleSiteProfile } from "@/src/subtitles/profiles/types";
import type { ConfirmRequest } from "./app";

/**
 * Where an editor document came from. `builtin` and `override` are bundled
 * capture profiles (an override is the local replacement of one), `user` is
 * a user capture profile, `site` a translation-only site profile and `new`
 * an unsaved document.
 */
export type SiteProfileKind = "builtin" | "override" | "user" | "site" | "new";
export type SiteSurface = "page" | "selection" | "subtitles";

export interface SiteProfileEntry {
  id: string;
  name: string;
  hostnames: string[];
  kind: Exclude<SiteProfileKind, "new">;
  /** Surfaces this site overrides (from its translation profile). */
  surfaces: SiteSurface[];
}

export interface SiteFeedback {
  key: string;
  tone: "" | "success" | "error";
  subs?: string[];
}

export interface SiteProfilesDeps {
  sendMessage(message: unknown): Promise<unknown>;
  confirm(request: ConfirmRequest): Promise<boolean>;
  requestRender(): void;
  settings(): AppSettings;
  copyText(text: string): Promise<void>;
  /** Offers `text` as a file download named `fileName`. */
  download(fileName: string, text: string): void;
  message(key: string, subs?: string | string[]): string;
}

/** Imported documents are tiny; anything larger is not a profile. */
export const SITE_PROFILE_FILE_LIMIT = 50_000;

const VALIDATION_REASONS: Readonly<
  Record<SiteProfileValidationReason, string>
> = {
  type: "profileValidationType",
  unknown_field: "profileValidationUnknownField",
  required: "profileValidationRequired",
  format: "profileValidationFormat",
  range: "profileValidationRange",
  unsafe_selector: "profileValidationUnsafeSelector",
  unsafe_hostname: "profileValidationUnsafeHostname",
  unsafe_url_pattern: "profileValidationUnsafeUrlPattern",
  parser_not_allowed: "profileValidationParser",
  tencent_ocr_only: "profileValidationTencentOcrOnly",
  override_not_supported: "profileValidationOverrideNarrowOnly",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOk(value: unknown): boolean {
  return isRecord(value) && value.ok === true;
}

function isProfilesResponse(value: unknown): value is {
  ok: true;
  builtIns: SubtitleSiteProfile[];
  profiles: SubtitleSiteProfile[];
  overrides: SubtitleSiteProfile[];
  translationProfiles: SiteTranslationProfile[];
} {
  if (!isOk(value)) return false;
  const record = value as Record<string, unknown>;
  const { builtIns, profiles, overrides, translationProfiles } = record;
  return (
    Array.isArray(builtIns) &&
    builtIns.every((profile) => {
      try {
        parseSiteProfile(profile);
        return true;
      } catch {
        return false;
      }
    }) &&
    Array.isArray(profiles) &&
    profiles.every((profile) => isUserSiteProfile(profile)) &&
    Array.isArray(overrides) &&
    overrides.every((profile) => isBuiltInProfileOverride(profile)) &&
    Array.isArray(translationProfiles) &&
    translationProfiles.every(isSiteTranslationProfile)
  );
}

function isTranslationSaveResponse(
  value: unknown,
): value is { ok: true; profile: SiteTranslationProfile } {
  return (
    isOk(value) &&
    isSiteTranslationProfile((value as { profile?: unknown }).profile)
  );
}

function isCaptureSaveResponse(value: unknown): value is {
  ok: true;
  kind: "user" | "override";
  profile: SubtitleSiteProfile;
} {
  if (!isOk(value)) return false;
  const { kind, profile } = value as { kind?: unknown; profile?: unknown };
  return kind === "user"
    ? isUserSiteProfile(profile)
    : kind === "override" && isBuiltInProfileOverride(profile);
}

/** A background `site_profile_invalid` reply, or null. */
export function validationFailureOf(
  value: unknown,
): { path: string; reason: SiteProfileValidationReason } | null {
  if (!isRecord(value) || value.ok !== false) return null;
  if (value.error !== "site_profile_invalid") return null;
  if (typeof value.path !== "string" || value.path.length > 160) return null;
  return typeof value.reason === "string" &&
    Object.hasOwn(VALIDATION_REASONS, value.reason)
    ? {
        path: value.path,
        reason: value.reason as SiteProfileValidationReason,
      }
    : null;
}

export function normalizeHostnameInput(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/gu, "");
}

/** Stable id for a new translation profile, derived from its hostname. */
export function newSiteProfileId(hostname: string): string {
  const base = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 56);
  return `user-${base || "custom"}`;
}

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/gu)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Global values a newly enabled surface override starts from. */
export function inheritedSurface(
  settings: AppSettings,
  surface: SiteSurface,
):
  | SitePageTranslationOverride
  | SiteSelectionTranslationOverride
  | SiteSubtitleTranslationOverride {
  const { page, subtitles, provider } = settings;
  if (surface === "selection") {
    return {
      sourceLanguage: page.selectionTranslationSourceLanguage,
      targetLanguage: page.selectionTranslationTargetLanguage,
      mode: page.selectionTranslationMode,
      fastProvider: provider.fastProvider,
      modelOverride: page.selectionTranslationModelOverride,
      enabled: page.selectionTranslationEnabled,
      aiResponseMode: page.selectionTranslationAiResponseMode,
      displayMode: page.selectionTranslationDisplayMode,
    };
  }
  if (surface === "page") {
    return {
      sourceLanguage: page.sourceLanguage,
      targetLanguage: page.targetLanguage,
      mode: page.mode,
      fastProvider: provider.fastProvider,
      modelOverride: "",
      aiResponseMode: page.aiResponseMode,
      displayMode: page.displayMode,
      autoTranslate: page.autoTranslate,
      floatingButtonEnabled: page.floatingButtonEnabled,
    };
  }
  return {
    sourceLanguage: subtitles.sourceLanguage,
    targetLanguage: subtitles.targetLanguage,
    mode: subtitles.mode,
    fastProvider: provider.fastProvider,
    modelOverride: "",
    enabled: subtitles.enabled,
    floatingButtonEnabled: subtitles.floatingButtonEnabled,
    aiResponseMode: subtitles.aiResponseMode,
    displayMode: subtitles.displayMode,
    hideNativeSubtitles: subtitles.hideNativeSubtitles,
    position: subtitles.position,
    customPosition: structuredClone(subtitles.customPosition),
    fontScale: subtitles.fontScale,
    backgroundOpacity: subtitles.backgroundOpacity,
  };
}

function json(document: SiteProfileDocument): string {
  return JSON.stringify(document, null, 2);
}

function byName<T extends { name: string }>(left: T, right: T): number {
  return left.name.localeCompare(right.name);
}

/** The JSON template shown in the developer reference. */
export function siteProfileTemplate(): string {
  const template = MINIMAL_USER_SITE_PROFILE_TEMPLATE;
  return json(
    createSiteProfileDocument(
      {
        id: template.id,
        version: 1,
        name: template.name,
        match: template.match,
        overrides: {},
      },
      template,
      true,
    ),
  );
}

/**
 * State and actions of the "Sites" group: the profile catalog (list) and one
 * editor document (detail). Site profiles are schema-validated documents, so
 * edits stay local until "Save" sends them through the existing
 * `SITE_TRANSLATION_PROFILE_*` / `SITE_PROFILE_*` messages; the background
 * validates again and only accepts allowlisted parsers and declarative rules.
 */
export class SiteProfilesController {
  status: "loading" | "ready" | "failed" = "loading";
  view: "list" | "detail" = "list";
  builtIns: SubtitleSiteProfile[] = [];
  userProfiles: SubtitleSiteProfile[] = [];
  overrides: SubtitleSiteProfile[] = [];
  translations: SiteTranslationProfile[] = [];

  kind: SiteProfileKind = "new";
  /** Id of the stored profile being edited; empty for a new document. */
  activeId = "";
  doc: SiteProfileDocument = this.documentFor(
    MINIMAL_USER_SITE_PROFILE_TEMPLATE,
    false,
  );
  jsonText = json(this.doc);
  jsonError: SiteFeedback | undefined;
  feedback: SiteFeedback | undefined;
  busy: "" | "save" | "delete" | "restore" = "";
  /** Element id the view should focus after the next render. */
  focusTarget: string | undefined;
  private snapshot = this.jsonText;
  private originalMatch: SiteTranslationProfile["match"] = structuredClone(
    this.doc.match,
  );

  constructor(private readonly deps: SiteProfilesDeps) {}

  get dirty(): boolean {
    return this.view === "detail" && json(this.doc) !== this.snapshot;
  }

  async load(): Promise<void> {
    this.status = "loading";
    this.deps.requestRender();
    try {
      const response = await this.deps.sendMessage({
        type: "SITE_PROFILES_GET",
      });
      if (!isProfilesResponse(response)) {
        throw new Error("site_profiles_load_failed");
      }
      // The generic fallback profile (`*`) is not a site and is not edited.
      this.builtIns = response.builtIns.filter(
        (profile) => !profile.match.hostnameSuffixes.includes("*"),
      );
      this.userProfiles = response.profiles;
      this.overrides = response.overrides;
      this.translations = response.translationProfiles;
      this.status = "ready";
    } catch {
      this.status = "failed";
      this.feedback = { key: "profileLoadFailed", tone: "error" };
    }
    this.deps.requestRender();
  }

  /** Catalog entries: bundled sites, then the user's own sites. */
  entries(): { builtIn: SiteProfileEntry[]; custom: SiteProfileEntry[] } {
    const surfaces = (id: string): SiteSurface[] => {
      const overrides = this.translations.find(
        (item) => item.id === id,
      )?.overrides;
      return overrides
        ? (["page", "selection", "subtitles"] as const).filter(
            (surface) => overrides[surface] !== undefined,
          )
        : [];
    };
    const entry = (
      profile: {
        id: string;
        name: string;
        match: { hostnameSuffixes: string[] };
      },
      kind: SiteProfileEntry["kind"],
    ): SiteProfileEntry => ({
      id: profile.id,
      name:
        this.translations.find((item) => item.id === profile.id)?.name ??
        profile.name,
      hostnames: profile.match.hostnameSuffixes.filter((host) => host !== "*"),
      kind,
      surfaces: surfaces(profile.id),
    });
    const builtIn = this.builtIns.map((profile) => {
      const override = this.overrides.find((item) => item.id === profile.id);
      return entry(override ?? profile, override ? "override" : "builtin");
    });
    const captureIds = new Set([
      ...this.builtIns.map((profile) => profile.id),
      ...this.userProfiles.map((profile) => profile.id),
    ]);
    const custom = [
      ...this.userProfiles.map((profile) => entry(profile, "user")),
      ...this.translations
        .filter((profile) => !captureIds.has(profile.id))
        .map((profile) => entry(profile, "site")),
    ].sort(byName);
    return { builtIn, custom };
  }

  private documentFor(
    capture: SubtitleSiteProfile,
    customized: boolean,
  ): SiteProfileDocument {
    const translation = this.translations.find(
      (item) => item.id === capture.id,
    );
    return createSiteProfileDocument(
      translation ?? {
        id: capture.id,
        version: 1,
        name: capture.name,
        match: capture.match,
        overrides: {},
      },
      capture,
      customized,
    );
  }

  private edit(
    capture: SubtitleSiteProfile,
    kind: SiteProfileKind,
    feedback?: SiteFeedback,
  ): void {
    this.kind = kind;
    this.activeId = kind === "new" ? "" : capture.id;
    this.doc = this.documentFor(
      capture,
      kind === "override" || kind === "user",
    );
    this.originalMatch = structuredClone(this.doc.match);
    this.jsonText = json(this.doc);
    this.snapshot = this.jsonText;
    this.jsonError = undefined;
    this.feedback = feedback;
    this.view = "detail";
    this.focusTarget = "site-detail-title";
    this.deps.requestRender();
  }

  open(entry: Pick<SiteProfileEntry, "id" | "kind">): void {
    if (entry.kind === "user") {
      const profile = this.userProfiles.find((item) => item.id === entry.id);
      if (profile) this.edit(profile, "user");
      return;
    }
    if (entry.kind === "site") {
      const profile = this.translations.find((item) => item.id === entry.id);
      if (!profile) return;
      this.edit(
        {
          ...MINIMAL_USER_SITE_PROFILE_TEMPLATE,
          id: profile.id,
          name: profile.name,
          match: profile.match,
        },
        "site",
      );
      return;
    }
    const builtIn = this.builtIns.find((item) => item.id === entry.id);
    if (!builtIn) return;
    const override = this.overrides.find((item) => item.id === entry.id);
    this.edit(override ?? builtIn, override ? "override" : "builtin");
  }

  openNew(): void {
    this.edit(MINIMAL_USER_SITE_PROFILE_TEMPLATE, "new");
    this.doc.name = "";
    this.doc.match = { hostnameSuffixes: [""] };
    this.originalMatch = structuredClone(this.doc.match);
    this.syncJson();
    this.snapshot = this.jsonText;
    this.focusTarget = "site-profile-name";
  }

  /** Back to the list; unsaved edits are only dropped after confirming. */
  async back(): Promise<void> {
    if (this.dirty) {
      const discard = await this.deps.confirm({
        title: this.deps.message("optSiteDiscardTitle"),
        body: this.deps.message("optSiteDiscardBody"),
        confirmLabel: this.deps.message("optSiteDiscard"),
        danger: true,
      });
      if (!discard) return;
    }
    const id = this.activeId;
    this.view = "list";
    this.feedback = undefined;
    this.focusTarget = id ? `site-entry-${id}` : "site-profile-new";
    this.deps.requestRender();
  }

  private syncJson(): void {
    this.jsonText = json(this.doc);
    this.jsonError = undefined;
  }

  private changed(): void {
    this.feedback = undefined;
    this.syncJson();
    this.deps.requestRender();
  }

  setName(value: string): void {
    this.doc.name = value.trim();
    this.changed();
  }

  /** Keeps the stored match (URL rules included) while the host is unchanged. */
  setHostname(value: string): void {
    const hostname = normalizeHostnameInput(value);
    this.doc.match =
      hostname === (this.originalMatch.hostnameSuffixes[0] ?? "")
        ? structuredClone(this.originalMatch)
        : { hostnameSuffixes: [hostname] };
    if (!this.activeId) this.doc.id = newSiteProfileId(hostname);
    this.changed();
  }

  setSurfaceOverride(surface: SiteSurface, enabled: boolean): void {
    if (enabled) {
      (this.doc.overrides as Record<SiteSurface, unknown>)[surface] =
        inheritedSurface(this.deps.settings(), surface);
    } else {
      delete this.doc.overrides[surface];
    }
    this.changed();
  }

  patchSurface<S extends SiteSurface>(
    surface: S,
    fields: Partial<NonNullable<SiteProfileDocument["overrides"][S]>>,
  ): void {
    const current = this.doc.overrides[surface];
    if (!current) return;
    (this.doc.overrides as Record<SiteSurface, unknown>)[surface] = {
      ...current,
      ...fields,
    };
    this.changed();
  }

  setCaptureCustomized(customized: boolean): void {
    this.doc.subtitleCapture.customized = customized;
    this.changed();
  }

  patchCapture(
    fields: Partial<
      Pick<SiteProfileDocument["subtitleCapture"], "parser" | "priority">
    > & {
      selectors?: Partial<SiteProfileDocument["subtitleCapture"]["selectors"]>;
      capture?: Partial<SiteProfileDocument["subtitleCapture"]["capture"]>;
    },
  ): void {
    const current = this.doc.subtitleCapture;
    const capture = { ...current.capture, ...fields.capture };
    if (capture.completeFilePatterns?.length === 0) {
      delete capture.completeFilePatterns;
    }
    this.doc.subtitleCapture = {
      ...current,
      ...(fields.parser ? { parser: fields.parser } : {}),
      ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
      selectors: { ...current.selectors, ...fields.selectors },
      capture,
    };
    this.changed();
  }

  private validationFeedback(failure: {
    path: string;
    reason: SiteProfileValidationReason;
  }): SiteFeedback {
    return {
      key: "profileValidationError",
      tone: "error",
      subs: [
        failure.path,
        this.deps.message(VALIDATION_REASONS[failure.reason]),
      ],
    };
  }

  private parseFailure(error: unknown): SiteFeedback {
    return this.validationFeedback(
      error instanceof SiteProfileValidationError
        ? error
        : { path: "$", reason: "format" },
    );
  }

  /** Applies edited JSON to the form; invalid JSON keeps the form as is. */
  applyJson(text: string, options: { reformat?: boolean } = {}): boolean {
    this.jsonText = text;
    try {
      const parsed = parseSiteProfileDocument(JSON.parse(text));
      this.adopt(parsed.document);
      if (options.reformat) {
        this.feedback = { key: "profileJsonFormatted", tone: "success" };
      }
      this.deps.requestRender();
      return true;
    } catch (error) {
      this.jsonError = this.parseFailure(error);
      this.deps.requestRender();
      return false;
    }
  }

  private adopt(document: SiteProfileDocument): void {
    this.doc = structuredClone(document);
    this.originalMatch = structuredClone(document.match);
    this.jsonText = json(document);
    this.jsonError = undefined;
  }

  async importFile(file: File | undefined): Promise<void> {
    if (!file || file.size > SITE_PROFILE_FILE_LIMIT) {
      this.feedback = { key: "profileFileImportFailed", tone: "error" };
      this.deps.requestRender();
      return;
    }
    try {
      const parsed = parseSiteProfileDocument(JSON.parse(await file.text()));
      // A file for another site becomes a new document, never a rename.
      if (this.activeId && parsed.translation.id !== this.activeId) {
        this.activeId = "";
        this.kind = "new";
      }
      this.adopt(parsed.document);
      this.feedback = { key: "profileFileImported", tone: "success" };
    } catch (error) {
      this.feedback =
        error instanceof SiteProfileValidationError
          ? this.parseFailure(error)
          : { key: "profileFileImportFailed", tone: "error" };
    }
    this.deps.requestRender();
  }

  exportFile(): void {
    try {
      const parsed = parseSiteProfileDocument(JSON.parse(this.jsonText));
      this.deps.download(
        `${parsed.document.id}.profile.json`,
        `${json(parsed.document)}\n`,
      );
      this.feedback = { key: "profileFileExported", tone: "success" };
    } catch {
      this.feedback = { key: "profileFileExportFailed", tone: "error" };
    }
    this.deps.requestRender();
  }

  async copy(text: string): Promise<void> {
    try {
      await this.deps.copyText(text);
      this.feedback = { key: "profileJsonCopied", tone: "success" };
    } catch {
      this.feedback = { key: "profileCopyFailed", tone: "error" };
    }
    this.deps.requestRender();
  }

  cancel(): void {
    const parsed = parseSiteProfileDocument(JSON.parse(this.snapshot));
    this.adopt(parsed.document);
    this.feedback = { key: "profileChangesCancelled", tone: "" };
    this.deps.requestRender();
  }

  private upsert<T extends { id: string; name: string }>(
    list: T[],
    item: T,
    sort: boolean,
  ): T[] {
    const next = [
      item,
      ...list.filter((candidate) => candidate.id !== item.id),
    ];
    return sort ? next.sort(byName) : next;
  }

  async save(): Promise<void> {
    if (this.busy) return;
    let parsed: ReturnType<typeof parseSiteProfileDocument>;
    try {
      parsed = parseSiteProfileDocument(JSON.parse(json(this.doc)));
      if (this.activeId && parsed.translation.id !== this.activeId) {
        throw new Error("existing_site_profile_id_changed");
      }
      if (parsed.document.subtitleCapture.customized) {
        parseEditableSiteProfile(parsed.capture);
      }
    } catch (error) {
      this.feedback = this.parseFailure(error);
      this.deps.requestRender();
      return;
    }
    this.busy = "save";
    this.feedback = undefined;
    this.deps.requestRender();
    try {
      const saved = await this.deps.sendMessage({
        type: "SITE_TRANSLATION_PROFILE_SAVE",
        profile: parsed.translation,
      });
      const failure = validationFailureOf(saved);
      if (failure) {
        this.feedback = this.validationFeedback(failure);
        return;
      }
      if (!isTranslationSaveResponse(saved)) throw new Error("save_failed");
      this.translations = this.upsert(this.translations, saved.profile, true);

      let capture: SubtitleSiteProfile = {
        ...MINIMAL_USER_SITE_PROFILE_TEMPLATE,
        id: saved.profile.id,
        name: saved.profile.name,
        match: saved.profile.match,
      };
      let kind: SiteProfileKind = "site";
      if (parsed.document.subtitleCapture.customized) {
        const response = await this.deps.sendMessage({
          type: "SITE_PROFILE_EDITOR_SAVE",
          profile: parsed.capture,
        });
        const captureFailure = validationFailureOf(response);
        if (captureFailure) {
          this.feedback = this.validationFeedback(captureFailure);
          return;
        }
        if (!isCaptureSaveResponse(response)) throw new Error("save_failed");
        capture = response.profile;
        kind = response.kind;
        if (response.kind === "user") {
          this.userProfiles = this.upsert(
            this.userProfiles,
            response.profile,
            true,
          );
        } else {
          this.overrides = this.upsert(this.overrides, response.profile, false);
        }
      } else {
        // Capture rules went back to the bundled ones: drop local copies.
        const id = this.activeId;
        if (this.overrides.some((item) => item.id === id)) {
          const response = await this.deps.sendMessage({
            type: "SITE_PROFILE_OVERRIDE_RESTORE",
            id,
          });
          if (!isOk(response)) throw new Error("restore_failed");
          this.overrides = this.overrides.filter((item) => item.id !== id);
        }
        if (this.userProfiles.some((item) => item.id === id)) {
          const response = await this.deps.sendMessage({
            type: "SITE_PROFILE_EDITOR_DELETE",
            id,
          });
          if (!isOk(response)) throw new Error("delete_failed");
          this.userProfiles = this.userProfiles.filter(
            (item) => item.id !== id,
          );
        }
        const builtIn = this.builtIns.find(
          (item) => item.id === saved.profile.id,
        );
        if (builtIn) {
          capture = builtIn;
          kind = "builtin";
        }
      }
      this.edit(capture, kind, { key: "profileSaved", tone: "success" });
    } catch {
      this.feedback = { key: "profileSaveFailed", tone: "error" };
    } finally {
      this.busy = "";
      this.deps.requestRender();
    }
  }

  /** True when the active document has stored data that can be deleted. */
  get deletable(): boolean {
    return (
      this.kind === "user" ||
      this.kind === "site" ||
      this.translations.some((item) => item.id === this.activeId)
    );
  }

  async remove(): Promise<void> {
    if (this.busy) return;
    const id = this.activeId;
    const translation = this.translations.find((item) => item.id === id);
    const capture = this.userProfiles.find((item) => item.id === id);
    const name = translation?.name ?? capture?.name;
    if (!name) return;
    const confirmed = await this.deps.confirm({
      title: this.deps.message("profileDeleteConfirm", name),
      body: this.deps.message("optSiteDeleteImpact"),
      confirmLabel: this.deps.message("deleteProfile"),
      danger: true,
    });
    if (!confirmed) return;
    this.busy = "delete";
    this.deps.requestRender();
    try {
      if (translation) {
        const response = await this.deps.sendMessage({
          type: "SITE_TRANSLATION_PROFILE_DELETE",
          id,
        });
        if (!isOk(response)) throw new Error("delete_failed");
        this.translations = this.translations.filter((item) => item.id !== id);
      }
      if (capture) {
        const response = await this.deps.sendMessage({
          type: "SITE_PROFILE_EDITOR_DELETE",
          id,
        });
        if (!isOk(response)) throw new Error("delete_failed");
        this.userProfiles = this.userProfiles.filter((item) => item.id !== id);
      }
      this.view = "list";
      this.focusTarget = "site-profile-new";
      this.feedback = { key: "profileDeleted", tone: "success" };
    } catch {
      this.feedback = { key: "profileDeleteFailed", tone: "error" };
    } finally {
      this.busy = "";
      this.deps.requestRender();
    }
  }

  /** Drops a built-in site's local override and site settings. */
  async restoreBuiltIn(): Promise<void> {
    if (this.busy) return;
    const id = this.activeId;
    const override = this.overrides.find((item) => item.id === id);
    if (!override) return;
    const confirmed = await this.deps.confirm({
      title: this.deps.message("profileRestoreConfirm", override.name),
      body: this.deps.message("optSiteRestoreImpact"),
      confirmLabel: this.deps.message("profileRestoreBuiltin"),
    });
    if (!confirmed) return;
    this.busy = "restore";
    this.deps.requestRender();
    try {
      if (this.translations.some((item) => item.id === id)) {
        const response = await this.deps.sendMessage({
          type: "SITE_TRANSLATION_PROFILE_DELETE",
          id,
        });
        if (!isOk(response)) throw new Error("restore_failed");
        this.translations = this.translations.filter((item) => item.id !== id);
      }
      const response = await this.deps.sendMessage({
        type: "SITE_PROFILE_OVERRIDE_RESTORE",
        id,
      });
      if (!isOk(response)) throw new Error("restore_failed");
      this.overrides = this.overrides.filter((item) => item.id !== id);
      const builtIn = this.builtIns.find((item) => item.id === id);
      if (builtIn) {
        this.edit(builtIn, "builtin", {
          key: "profileBuiltinRestored",
          tone: "success",
        });
      }
    } catch {
      this.feedback = { key: "profileRestoreFailed", tone: "error" };
    } finally {
      this.busy = "";
      this.deps.requestRender();
    }
  }
}
