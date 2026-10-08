import type { StatusMessageKey } from "@/src/ui/status/messages";

export type { StatusMessageKey };

/**
 * Framework-free status view contract shared by every surface (floating
 * control, popup, options page, subtitle overlay and page markers). Surfaces
 * render a `StatusView`; they never derive state, copy or actions themselves.
 */

/** Unified state across page and subtitle tasks (README §2.1). */
export type StatusKind =
  | "disabled"
  | "unavailable"
  | "idle"
  | "scanning"
  | "translating"
  | "ready"
  | "partial"
  | "cancelled"
  | "error";

/**
 * Shape identifier for the state icon, so state never depends on color alone.
 * Names describe the drawn shape, not a specific icon set.
 */
export type StatusIcon =
  | "circle-slash"
  | "circle-dashed-bar"
  | "circle-outline"
  | "circle-dashed"
  | "progress-arc"
  | "circle-check"
  | "circle-half"
  | "circle-square"
  | "triangle-exclamation";

/** Semantic color role; surfaces map it to their theme tokens. */
export type StatusTone =
  "neutral" | "progress" | "success" | "warning" | "danger";

/**
 * What the collapsed floating button may express (README §2.2 rule 5): idle,
 * in progress, done, or needs attention (the icon tells partial, error and
 * cancelled apart).
 */
export type StatusBadge = "idle" | "progress" | "done" | "attention";

/** A Chrome i18n key plus positional substitutions in placeholder order. */
export interface LocalizedText {
  key: StatusMessageKey;
  substitutions: readonly string[];
}

export type StatusActionId =
  | "translate"
  | "enable"
  | "stop"
  | "retry"
  | "resume"
  | "restore"
  | "disable"
  | "openProviderSettings"
  | "useAutoDetect"
  | "tryOcr"
  | "rescan"
  | "switchDisplay";

export interface StatusAction {
  id: StatusActionId;
  label: LocalizedText;
  disabled: boolean;
  /** True while the request behind this action is in flight (show a spinner). */
  busy: boolean;
}

/**
 * A user action whose request is in flight. While set, the primary slot keeps
 * its place and shows the transitional label disabled, instead of flipping to
 * whatever the intermediate backend state would suggest.
 */
export type PendingStatusAction =
  "starting" | "stopping" | "retrying" | "resuming";

/** Orthogonal subtitle track label shown as a text chip. */
export type SubtitleTrackTag = "full" | "stream" | "experimental";

/** Track kind supplied by the caller when it knows better than the status. */
export type SubtitleTrackKind = "full" | "stream" | "ocr";

export interface StatusProgress {
  /** Real completed count; never estimated. */
  done: number;
  total: number;
  /** Terminal failure count (meaningful for partial, error and cancelled). */
  failed: number;
  /**
   * Failures seen so far while still translating. The kind stays
   * `translating` and the primary action stays "stop"; this only feeds a
   * counter.
   */
  failedSoFar?: number;
}

export interface StatusDiagnostics {
  /** Raw machine-readable reason, when the status carried one. */
  reasonCode?: string;
  /** Bounded structural diagnostics from the status; never secrets or text. */
  details?: string;
}

export interface StatusView {
  task: "page" | "subtitle";
  kind: StatusKind;
  icon: StatusIcon;
  tone: StatusTone;
  /** Whether the icon conveys ongoing work (spinning arc or dashed circle). */
  animated: boolean;
  badge: StatusBadge;
  title: LocalizedText;
  /** One sentence naming the cause or constraint; absent when none applies. */
  reason?: LocalizedText;
  progress: StatusProgress;
  /** Counter text for `progress.failedSoFar`; never changes the kind. */
  progressNote?: LocalizedText;
  /** True while a user-requested retry of failed items is running. */
  retrying: boolean;
  /** Text chips for the subtitle track; empty for page tasks. */
  tracks: readonly SubtitleTrackTag[];
  /** The single primary action slot (README §2.2 rule 1). */
  primaryAction?: StatusAction;
  secondaryActions: readonly StatusAction[];
  diagnostics: StatusDiagnostics;
}

export interface StatusViewContext {
  /** False when the user switched the feature off; overrides every state. */
  featureEnabled?: boolean;
  pending?: PendingStatusAction;
  /**
   * Set while a user-requested "retry N items" runs: the counts at the moment
   * the retry started, so the title can read "retrying k of N".
   */
  retry?: { completedAtStart: number; count: number };
}

export interface SubtitleStatusViewContext extends StatusViewContext {
  /** Overrides the track kind derived from `source` and `completeness`. */
  track?: SubtitleTrackKind;
  /** Whether offering the experimental OCR fallback makes sense here. */
  ocrAvailable?: boolean;
}
