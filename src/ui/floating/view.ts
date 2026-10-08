import { message } from "@/src/shared/i18n";
import type {
  NtButtonVariant,
  NtTabIndicator,
  NtVisualState,
} from "@/src/ui/components";
import type {
  LocalizedText,
  StatusAction,
  StatusActionId,
  StatusKind,
  StatusView,
} from "@/src/ui/status";

/** Resolves a status-model text through the Chrome i18n catalog. */
export function localize(text: LocalizedText): string {
  return message(text.key, [...text.substitutions]);
}

/** Subtitle "scanning" is "waiting for subtitles"; it draws the same glyph. */
export function visualState(view: StatusView): NtVisualState {
  return view.task === "subtitle" && view.kind === "scanning"
    ? "waiting"
    : view.kind;
}

/** Real 0..1 progress while work runs; null (indeterminate) otherwise. */
export function progressValue(view: StatusView): number | null {
  const { done, total } = view.progress;
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, done / total));
}

export function isActiveKind(kind: StatusKind): boolean {
  return kind === "scanning" || kind === "translating";
}

/** Dot after a tab label; always paired with an accessible label. */
export function tabIndicator(view: StatusView): NtTabIndicator {
  switch (view.kind) {
    case "scanning":
    case "translating":
      return "run";
    case "ready":
      return "ok";
    case "partial":
    case "cancelled":
      return "warn";
    case "error":
      return "err";
    default:
      return "none";
  }
}

/**
 * Filled for actions that start or recover work, plain for actions that end
 * it (stop, restore, switch off). Only the primary slot uses these; every
 * secondary action is a ghost button.
 */
export function primaryVariant(id: StatusActionId): NtButtonVariant {
  switch (id) {
    case "translate":
    case "enable":
    case "retry":
    case "resume":
    case "openProviderSettings":
    case "useAutoDetect":
      return "primary";
    default:
      return "secondary";
  }
}

/** Marks one action busy and freezes every other action (no status label). */
export function withLocalPending(
  view: StatusView,
  id: StatusActionId,
): StatusView {
  const freeze = (action: StatusAction): StatusAction =>
    action.id === id
      ? { ...action, busy: true, disabled: true }
      : { ...action, disabled: true };
  return {
    ...view,
    ...(view.primaryAction
      ? { primaryAction: freeze(view.primaryAction) }
      : {}),
    secondaryActions: view.secondaryActions.map(freeze),
  };
}

export type FloatingTabId = "page" | "video";

/**
 * Which task the collapsed button speaks for: the only running task; else a
 * task needing attention or just finished while the preferred one is quiet;
 * else the preferred (last selected) tab.
 */
export function launcherSource(
  views: Readonly<Record<FloatingTabId, StatusView>>,
  preferred: FloatingTabId,
): FloatingTabId {
  const ids: FloatingTabId[] = ["page", "video"];
  const active = ids.filter((id) => isActiveKind(views[id].kind));
  if (active.length === 1) return active[0]!;
  if (active.length > 1) return preferred;
  const quiet = (kind: StatusKind): boolean =>
    kind === "idle" || kind === "disabled" || kind === "unavailable";
  const other: FloatingTabId = preferred === "page" ? "video" : "page";
  if (quiet(views[preferred].kind) && !quiet(views[other].kind)) return other;
  return preferred;
}

/**
 * One-shot pill announcement for a state the user should notice without
 * opening the panel: outcomes only. Work in progress is shown by the ring.
 */
export function announcementFor(view: StatusView): string {
  switch (view.kind) {
    case "ready":
    case "partial":
    case "cancelled":
    case "error":
      return localize(view.title);
    default:
      return "";
  }
}
