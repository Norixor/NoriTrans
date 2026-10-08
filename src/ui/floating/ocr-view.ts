import type { SubtitleStatus } from "@/src/messaging/protocol";
import {
  OCR_REASON,
  type OcrReasonCode,
  type OcrStatus,
  type OcrStatusState,
} from "@/src/ocr/types";
import { STATUS_REASON } from "@/src/shared/status-reasons";
import type { NtButtonVariant, NtVisualState } from "@/src/ui/components";
import { subtitleStatusView, type StatusView } from "@/src/ui/status";
import type { ViewText } from "./section-view";

/**
 * Thin view mapping for image recognition (OCR) in the floating control.
 * `OcrStatus` is not part of the shared status model (src/ui/status), so the
 * card, header and actions are derived here from the session status, the
 * user's settings and the subtitle status the OCR track feeds. Wording comes
 * from `OcrStatus.reasonCode`, never from `message`; `message` is only shown
 * as is when no code is known, or as bounded diagnostics.
 */

export type OcrActionId =
  "enable" | "start" | "stop" | "reselect" | "openSettings" | "dismiss";

export interface OcrCardAction {
  id: OcrActionId;
  label: ViewText;
  variant: NtButtonVariant;
  busy: boolean;
  disabled: boolean;
}

export interface OcrNote {
  tone: "info" | "warn";
  text: ViewText;
}

export interface OcrCardView {
  state: NtVisualState;
  title: ViewText;
  count?: ViewText;
  description?: ViewText;
  /** 0..1 while preparing; null for an indeterminate bar. */
  progress: number | null;
  /** Live OCR track chips ("live subtitles" + "experimental"). */
  liveChips: boolean;
  primary?: OcrCardAction;
  secondary: OcrCardAction[];
  notes: OcrNote[];
  /** Bounded diagnostics (session text carrying a technical detail). */
  diagnostics?: string;
}

/** A request the user started that the status has not confirmed yet. */
export type OcrPending = "enabling" | "starting" | "stopping";

export type OcrRuntimeReadiness = "ready" | "missing" | "unknown";

export interface OcrViewInput {
  status: OcrStatus;
  /** Effective `settings.ocr.enabled` (including an in-flight change). */
  enabled: boolean;
  subtitle: SubtitleStatus;
  pending?: OcrPending | undefined;
  /** The user closed the current problem card. */
  dismissed: boolean;
  runtime: OcrRuntimeReadiness;
  /** The local translator can translate the OCR language pair. */
  pairAvailable: boolean;
  /** Whether the host can start/stop (callbacks present). */
  canStart: boolean;
}

/** Short state word shown in the collapsed section header. */
export type OcrPhase =
  "off" | "ready" | "notReady" | "running" | "stopped" | "blocked" | "problem";

const RUNNING: ReadonlySet<OcrStatusState> = new Set([
  "selecting",
  "initializing",
  "capturing",
  "recognizing",
  "active",
]);

export function isOcrRunning(status: OcrStatus): boolean {
  return RUNNING.has(status.state);
}

/**
 * Mirrors the host rule for starting OCR: a non-OCR track with cues already
 * exists, so OCR must not start or interfere with it (AGENTS §7).
 */
export function otherTrackAvailable(subtitle: SubtitleStatus): boolean {
  return subtitle.total > 0 && subtitle.source !== "ocr";
}

function isProblem(status: OcrStatus): boolean {
  return status.state === "error" || status.state === "unavailable";
}

function blockedByTrack(input: OcrViewInput): boolean {
  return (
    otherTrackAvailable(input.subtitle) ||
    input.status.reasonCode === OCR_REASON.existingSubtitles
  );
}

/**
 * Whether the OCR card stands in for the subtitle card: while OCR is turning
 * on, starting or running, or stopped on a problem the user has not closed,
 * and only when no other subtitle track exists.
 */
export function ocrOwnsCard(input: OcrViewInput): boolean {
  if (blockedByTrack(input)) return false;
  if (input.pending === "enabling" || input.pending === "starting") {
    return true;
  }
  if (isOcrRunning(input.status)) return true;
  return isProblem(input.status) && !input.dismissed;
}

export function ocrPhase(input: OcrViewInput): OcrPhase {
  const { status } = input;
  if (
    isOcrRunning(status) ||
    input.pending === "starting" ||
    input.pending === "enabling"
  ) {
    return "running";
  }
  if (!input.enabled || status.state === "disabled") return "off";
  if (blockedByTrack(input)) return "blocked";
  if (isProblem(status)) return "problem";
  if (status.state === "cancelled") return "stopped";
  return input.runtime === "missing" ? "notReady" : "ready";
}

export const OCR_PHASE_KEYS: Readonly<Record<OcrPhase, string>> = {
  off: "floatingOcrStateOff",
  ready: "floatingOcrStateReady",
  notReady: "floatingOcrStateNotReady",
  running: "floatingOcrStateRunning",
  stopped: "floatingOcrStateStopped",
  blocked: "floatingOcrStateBlocked",
  problem: "floatingOcrStateProblem",
};

type ReasonRemedy = "start" | "settings" | "none";

interface ReasonEntry {
  key: string;
  remedy: ReasonRemedy;
  /** "notReady" and "unavailable" read as a setup problem, not a stop. */
  kind: "notReady" | "unavailable" | "stopped";
  /** The session message carries a technical detail worth showing. */
  diagnostic?: boolean;
}

const REASONS: Readonly<Record<OcrReasonCode, ReasonEntry>> = {
  [OCR_REASON.sourceLanguageUnsupported]: {
    key: "floatingOcrReasonLanguageUnsupported",
    remedy: "none",
    kind: "unavailable",
  },
  [OCR_REASON.runtimeMissing]: {
    key: "floatingOcrRuntimeMissing",
    remedy: "settings",
    kind: "notReady",
  },
  [OCR_REASON.engineUnavailable]: {
    key: "floatingOcrReasonEngineUnavailable",
    remedy: "settings",
    kind: "notReady",
  },
  [OCR_REASON.startFailed]: {
    key: "floatingOcrReasonStartFailed",
    remedy: "start",
    kind: "stopped",
    diagnostic: true,
  },
  [OCR_REASON.videoUnavailable]: {
    key: "floatingOcrReasonNoVideo",
    remedy: "start",
    kind: "unavailable",
  },
  [OCR_REASON.pictureInPicture]: {
    key: "floatingOcrReasonPictureInPicture",
    remedy: "start",
    kind: "unavailable",
  },
  [OCR_REASON.videoChanged]: {
    key: "floatingOcrReasonVideoChanged",
    remedy: "start",
    kind: "stopped",
  },
  [OCR_REASON.capturePermissionRequired]: {
    key: "floatingOcrReasonPermission",
    remedy: "start",
    kind: "stopped",
  },
  [OCR_REASON.captureTooLarge]: {
    key: "floatingOcrReasonCaptureTooLarge",
    remedy: "start",
    kind: "stopped",
  },
  [OCR_REASON.captureFailed]: {
    key: "floatingOcrReasonCaptureFailed",
    remedy: "start",
    kind: "stopped",
    diagnostic: true,
  },
  [OCR_REASON.protectedVideo]: {
    key: "statusReasonOcrProtectedVideo",
    remedy: "start",
    kind: "stopped",
  },
  [OCR_REASON.recognitionFailed]: {
    key: "floatingOcrReasonRecognitionFailed",
    remedy: "start",
    kind: "stopped",
  },
  [OCR_REASON.existingSubtitles]: {
    key: "floatingOcrTrackAvailable",
    remedy: "none",
    kind: "unavailable",
  },
};

function reasonEntry(status: OcrStatus): ReasonEntry | undefined {
  const code = status.reasonCode;
  return code !== undefined && Object.hasOwn(REASONS, code)
    ? REASONS[code]
    : undefined;
}

/** The reason sentence for a stopped or unavailable session. */
export function ocrReasonText(status: OcrStatus): ViewText | undefined {
  const entry = reasonEntry(status);
  if (entry) return { key: entry.key };
  return status.message ? { raw: status.message } : undefined;
}

function action(
  id: OcrActionId,
  key: string,
  variant: NtButtonVariant,
  disabled = false,
): OcrCardAction {
  return { id, label: { key }, variant, busy: false, disabled };
}

function busyAction(id: OcrActionId, key: string): OcrCardAction {
  return {
    id,
    label: { key },
    variant: "secondary",
    busy: true,
    disabled: true,
  };
}

/**
 * Notes about the translation side of an OCR track (AGENTS §7): the local
 * translator could not prepare (recognized text stays visible), or it is
 * still preparing its model.
 */
function translationNotes(subtitle: SubtitleStatus): OcrNote[] {
  if (subtitle.source !== "ocr") return [];
  if (subtitle.reasonCode === STATUS_REASON.ocrLocalTranslationUnavailable) {
    return [
      { tone: "warn", text: { key: "statusReasonOcrTranslationUnavailable" } },
    ];
  }
  // The controller reports local model preparation as a message without a
  // code while translating; show it as is.
  if (subtitle.state === "translating" && subtitle.message) {
    return [{ tone: "info", text: { raw: subtitle.message } }];
  }
  return [];
}

function recognizedCount(status: OcrStatus): ViewText | undefined {
  return status.recognized > 0
    ? { key: "ocrRecognizedCount", substitutions: [String(status.recognized)] }
    : undefined;
}

function clampProgress(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

/** The status card while OCR owns the video tab's card slot. */
export function ocrCardView(input: OcrViewInput): OcrCardView {
  const { status, pending } = input;
  const stopping = pending === "stopping";
  const stop = stopping
    ? busyAction("stop", "statusActionStopping")
    : action("stop", "statusActionStop", "secondary");
  const reselect = action(
    "reselect",
    "floatingOcrReselect",
    "ghost",
    stopping || !input.pairAvailable,
  );
  const base = {
    progress: null,
    secondary: [] as OcrCardAction[],
    notes: [] as OcrNote[],
  };

  if (pending === "enabling" || pending === "starting") {
    return {
      ...base,
      state: "waiting",
      title: {
        key:
          pending === "enabling"
            ? "floatingOcrEnablingTitle"
            : "floatingOcrSelectingTitle",
      },
      description: { key: "statusReasonOcrLocalOnly" },
      liveChips: true,
      primary: busyAction(
        pending === "enabling" ? "enable" : "start",
        pending === "enabling"
          ? "statusActionEnabling"
          : "statusActionStarting",
      ),
    };
  }

  switch (status.state) {
    case "selecting":
      return {
        ...base,
        state: "waiting",
        title: { key: "floatingOcrSelectingTitle" },
        description: { key: "ocrSelectHint" },
        liveChips: true,
        primary: stop,
      };
    case "initializing":
      return {
        ...base,
        state: "translating",
        title: { key: "floatingOcrPreparingTitle" },
        description: { key: "floatingOcrPreparingHint" },
        progress: clampProgress(status.progress),
        liveChips: true,
        primary: stop,
      };
    case "capturing":
    case "recognizing":
    case "active": {
      const count = recognizedCount(status);
      return {
        ...base,
        state: "translating",
        title: { key: "floatingOcrRunningTitle" },
        ...(count ? { count } : {}),
        // Pauses (inactive tab, black frame) are reported as a message on a
        // running state; they replace the standing local-only sentence.
        description: status.message
          ? { raw: status.message }
          : { key: "statusReasonOcrLocalOnly" },
        liveChips: true,
        primary: stop,
        secondary: [reselect],
        notes: translationNotes(input.subtitle),
      };
    }
    default:
      break;
  }

  // A problem card (error / unavailable) the user has not closed.
  const entry = reasonEntry(status);
  const kind =
    entry?.kind ?? (status.state === "error" ? "stopped" : "unavailable");
  const remedy = entry?.remedy ?? "start";
  const count = recognizedCount(status);
  const reason = ocrReasonText(status);
  const primary =
    remedy === "settings"
      ? action("openSettings", "floatingOcrOpenSettings", "primary")
      : remedy === "start"
        ? action(
            "reselect",
            "floatingOcrReselect",
            "primary",
            !input.enabled || !input.pairAvailable || !input.canStart,
          )
        : undefined;
  const details =
    entry?.diagnostic && status.message ? status.message.trim() : "";
  return {
    ...base,
    state: kind === "stopped" ? "error" : "unavailable",
    title: {
      key:
        kind === "notReady"
          ? "floatingOcrNotReadyTitle"
          : kind === "unavailable"
            ? "floatingOcrUnavailableTitle"
            : "floatingOcrStoppedTitle",
    },
    ...(count ? { count } : {}),
    ...(reason ? { description: reason } : {}),
    liveChips: false,
    ...(primary ? { primary } : {}),
    secondary: [action("dismiss", "floatingOcrDismiss", "ghost")],
    ...(details ? { diagnostics: details } : {}),
  };
}

/**
 * What the shell shows for the video tab while OCR owns the card before its
 * track exists (subtitles still "no readable track"): the live OCR track
 * view of the shared model, so the tab dot and collapsed button show work
 * in progress. Once the OCR track carries cues the subtitle view is used.
 */
export function ocrShellView(input: OcrViewInput): StatusView | undefined {
  if (!ocrOwnsCard(input) || input.subtitle.source === "ocr") return undefined;
  if (isProblem(input.status) && !input.pending) return undefined;
  const preparing =
    input.pending !== undefined ||
    input.status.state === "selecting" ||
    input.status.state === "initializing";
  return subtitleStatusView({
    state: preparing ? "waiting" : "translating",
    source: "ocr",
    completeness: "stream",
    total: 0,
    completed: 0,
    failed: 0,
  });
}
