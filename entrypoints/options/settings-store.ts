import {
  applySettingsPatch,
  isSettingsPatchResponse,
  mergeSettingsPatches,
  settingsPatchPaths,
  SETTINGS_PATCH_SECTIONS,
  type SettingsPatch,
} from "@/src/shared/settings-patch";
import { mergeSettings, type AppSettings } from "@/src/shared/settings";

/** Default idle time before discrete edits (switches, selects) are sent. */
export const AUTOSAVE_DEBOUNCE_MS = 250;
/** Idle time for free-text fields, so typing does not send every keystroke. */
export const AUTOSAVE_TEXT_DEBOUNCE_MS = 700;

export type SettingsSaveFailureCode =
  | "settings_patch_invalid"
  | "settings_patch_sender_rejected"
  | "settings_patch_save_failed"
  /** No valid response (background unreachable or malformed reply). */
  | "settings_patch_unreachable";

export type SettingsSaveOutcome =
  { ok: true } | { ok: false; code: SettingsSaveFailureCode; paths: string[] };

export type SettingsStoreEvent =
  | { kind: "change" }
  | { kind: "saving" }
  | { kind: "saved"; paths: string[] }
  | {
      kind: "failed";
      code: SettingsSaveFailureCode;
      /** Fields that were rolled back to the stored value. */
      paths: string[];
    };

export interface SettingsStoreDeps {
  /** Sends one `SETTINGS_PATCH` and resolves with the raw response. */
  send(patch: SettingsPatch): Promise<unknown>;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

type Listener = (event: SettingsStoreEvent) => void;

function readPath(settings: AppSettings, path: string): unknown {
  const [section, key] = path.split(".");
  const root = settings as unknown as Record<string, unknown>;
  if (!section) return undefined;
  if (key === undefined) return root[section];
  return (root[section] as Record<string, unknown> | undefined)?.[key];
}

function patchForPath(path: string, value: unknown): SettingsPatch {
  const [section, key] = path.split(".");
  if (section === "uiLanguage" && key === undefined) {
    return { uiLanguage: value as AppSettings["uiLanguage"] };
  }
  if (
    !section ||
    !key ||
    !(SETTINGS_PATCH_SECTIONS as string[]).includes(section)
  ) {
    return {};
  }
  const patch: SettingsPatch = {};
  (patch as Record<string, unknown>)[section] = {
    [key]: structuredClone(value),
  };
  return patch;
}

/**
 * Autosave model for the options page.
 *
 * The displayed value is `stored ⊕ in-flight ⊕ pending ⊕ editing`, where
 * `stored` mirrors `chrome.storage.local`, `in-flight` is the one patch
 * currently being written, `pending` collects edits made during the debounce
 * window (coalesced per field, last write wins) and `editing` pins fields the
 * user is typing into so an external change cannot replace text under the
 * caret. Patches are written one at a time, so the background always applies
 * them in edit order. A failed write drops only that patch, which rolls its
 * fields back to the stored value and reports them to the caller.
 */
export class SettingsStore {
  private stored: AppSettings;
  private pending: SettingsPatch = {};
  private inflight: SettingsPatch | undefined;
  private readonly editing = new Map<string, unknown>();
  private readonly listeners = new Set<Listener>();
  private timer: unknown;
  private flushing: Promise<SettingsSaveOutcome> | undefined;
  private idleWaiters: ((outcome: SettingsSaveOutcome) => void)[] = [];
  private lastOutcome: SettingsSaveOutcome = { ok: true };

  constructor(
    initial: AppSettings,
    private readonly deps: SettingsStoreDeps,
  ) {
    this.stored = structuredClone(initial);
  }

  /** Current value to render. */
  get value(): AppSettings {
    let value = this.stored;
    if (this.inflight) value = applySettingsPatch(value, this.inflight);
    if (settingsPatchPaths(this.pending).length > 0) {
      value = applySettingsPatch(value, this.pending);
    }
    for (const [path, pinned] of this.editing) {
      if (pinned === undefined) continue;
      value = applySettingsPatch(value, patchForPath(path, pinned));
    }
    return value;
  }

  /** Last value confirmed by storage (credentials included). */
  get storedValue(): AppSettings {
    return this.stored;
  }

  get hasUnsavedChanges(): boolean {
    return (
      this.inflight !== undefined || settingsPatchPaths(this.pending).length > 0
    );
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SettingsStoreEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /**
   * Records an edit and schedules a write after `debounceMs` of inactivity.
   * The new value is visible immediately.
   */
  update(patch: SettingsPatch, debounceMs = AUTOSAVE_DEBOUNCE_MS): void {
    if (settingsPatchPaths(patch).length === 0) return;
    this.pending = mergeSettingsPatches(this.pending, patch);
    for (const path of settingsPatchPaths(patch)) {
      if (this.editing.has(path)) this.editing.set(path, undefined);
    }
    this.emit({ kind: "change" });
    this.schedule(debounceMs);
  }

  /** Records an edit and writes it (with anything pending) right away. */
  commit(patch: SettingsPatch): Promise<SettingsSaveOutcome> {
    this.update(patch, 0);
    return this.flush();
  }

  /** Marks a field as being typed into; see the class comment. */
  beginEditing(path: string): void {
    if (!this.editing.has(path)) this.editing.set(path, undefined);
  }

  /** Releases a field pinned by `beginEditing`. */
  endEditing(path: string): void {
    if (!this.editing.delete(path)) return;
    this.emit({ kind: "change" });
  }

  /**
   * Adopts a new stored value written by any page (including this one).
   * Fields with unsent edits keep the local value; fields being typed into
   * keep what is on screen until editing ends.
   */
  applyExternal(stored: unknown): void {
    const before = this.value;
    for (const path of this.editing.keys()) {
      this.editing.set(path, structuredClone(readPath(before, path)));
    }
    this.stored = mergeSettings(stored);
    this.emit({ kind: "change" });
  }

  private setTimer(callback: () => void, ms: number): unknown {
    return this.deps.setTimer
      ? this.deps.setTimer(callback, ms)
      : setTimeout(callback, ms);
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) this.deps.clearTimer(handle);
    else clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.flush();
    }, delay);
  }

  /**
   * Writes everything pending. Resolves once the store is idle with the
   * outcome of the last write (a failure of an earlier patch is reported
   * through the `failed` event as well).
   */
  flush(): Promise<SettingsSaveOutcome> {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (!this.flushing) {
      if (settingsPatchPaths(this.pending).length === 0) {
        return Promise.resolve(this.lastOutcome);
      }
      this.flushing = this.drain().finally(() => {
        this.flushing = undefined;
      });
      return this.flushing;
    }
    // A write is running; resolve after it and anything queued behind it.
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async drain(): Promise<SettingsSaveOutcome> {
    let outcome: SettingsSaveOutcome = { ok: true };
    while (settingsPatchPaths(this.pending).length > 0) {
      const patch = this.pending;
      this.pending = {};
      this.inflight = patch;
      const paths = settingsPatchPaths(patch);
      this.emit({ kind: "saving" });
      outcome = await this.write(patch, paths);
      this.inflight = undefined;
      if (outcome.ok) {
        this.emit({ kind: "saved", paths });
      } else {
        // Dropping the in-flight patch rolls its fields back to the stored
        // value; edits made while it was in flight stay pending.
        this.emit({ kind: "failed", code: outcome.code, paths });
      }
      this.emit({ kind: "change" });
    }
    this.lastOutcome = outcome;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve(outcome);
    return outcome;
  }

  private async write(
    patch: SettingsPatch,
    paths: string[],
  ): Promise<SettingsSaveOutcome> {
    let response: unknown;
    try {
      response = await this.deps.send(patch);
    } catch {
      return { ok: false, code: "settings_patch_unreachable", paths };
    }
    if (!isSettingsPatchResponse(response)) {
      return { ok: false, code: "settings_patch_unreachable", paths };
    }
    if (!response.ok) return { ok: false, code: response.code, paths };
    // Adopt the normalized result for the patched fields; credentials are
    // not part of the response and keep their stored values.
    const normalized = mergeSettings({
      ...response.settings,
      provider: { ...this.stored.provider, ...response.settings.provider },
    });
    let confirmed: SettingsPatch = {};
    for (const path of paths) {
      confirmed = mergeSettingsPatches(
        confirmed,
        patchForPath(path, readPath(normalized, path)),
      );
    }
    this.stored = applySettingsPatch(this.stored, confirmed);
    return { ok: true };
  }
}
