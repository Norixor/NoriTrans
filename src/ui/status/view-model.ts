import type { PageStatus, SubtitleStatus } from "@/src/messaging/protocol";
import { STATUS_REASON } from "@/src/shared/status-reasons";
import { isStreamReasonCode, resolveReason } from "@/src/ui/status/reasons";
import type {
  LocalizedText,
  PendingStatusAction,
  StatusAction,
  StatusActionId,
  StatusBadge,
  StatusIcon,
  StatusKind,
  StatusMessageKey,
  StatusProgress,
  StatusTone,
  StatusView,
  StatusViewContext,
  SubtitleStatusViewContext,
  SubtitleTrackKind,
  SubtitleTrackTag,
} from "@/src/ui/status/types";

type Task = StatusView["task"];

interface KindAppearance {
  icon: StatusIcon;
  tone: StatusTone;
  animated: boolean;
  badge: StatusBadge;
}

const APPEARANCE: Readonly<Record<StatusKind, KindAppearance>> = {
  disabled: {
    icon: "circle-slash",
    tone: "neutral",
    animated: false,
    badge: "idle",
  },
  unavailable: {
    icon: "circle-dashed-bar",
    tone: "neutral",
    animated: false,
    badge: "idle",
  },
  idle: {
    icon: "circle-outline",
    tone: "neutral",
    animated: false,
    badge: "idle",
  },
  scanning: {
    icon: "circle-dashed",
    tone: "progress",
    animated: true,
    badge: "progress",
  },
  translating: {
    icon: "progress-arc",
    tone: "progress",
    animated: true,
    badge: "progress",
  },
  ready: {
    icon: "circle-check",
    tone: "success",
    animated: false,
    badge: "done",
  },
  partial: {
    icon: "circle-half",
    tone: "warning",
    animated: false,
    badge: "attention",
  },
  cancelled: {
    icon: "circle-square",
    tone: "neutral",
    animated: false,
    badge: "attention",
  },
  error: {
    icon: "triangle-exclamation",
    tone: "danger",
    animated: false,
    badge: "attention",
  },
};

function text(
  key: StatusMessageKey,
  ...substitutions: readonly (string | number)[]
): LocalizedText {
  return { key, substitutions: substitutions.map(String) };
}

function action(
  id: StatusActionId,
  label: LocalizedText,
  disabled = false,
): StatusAction {
  return { id, label, disabled, busy: false };
}

/**
 * Terminal failure states follow README §2.2 rule 4: any success next to a
 * failure is `partial`, and a "partial" without a single success is `error`.
 */
function terminalFailureKind(status: {
  completed: number;
  failed: number;
}): "partial" | "error" {
  return status.completed > 0 && status.failed > 0 ? "partial" : "error";
}

/**
 * Page kind. `featureEnabled: false` wins over every reported state, so a
 * switched-off feature never shows detection results.
 */
export function pageStatusKind(
  status: PageStatus,
  context: StatusViewContext = {},
): StatusKind {
  if (context.featureEnabled === false) return "disabled";
  switch (status.state) {
    case "unavailable":
      return "unavailable";
    case "idle":
      return "idle";
    case "scanning":
      return "scanning";
    // Failures seen mid-run never turn an ongoing task into `partial`.
    case "translating":
      return "translating";
    case "translated":
      return "ready";
    case "cancelled":
      return "cancelled";
    case "partial":
    case "error":
      return terminalFailureKind(status);
  }
}

/** Subtitle kind; `disabled` outranks `unavailable`, which outranks the rest. */
export function subtitleStatusKind(
  status: SubtitleStatus,
  context: StatusViewContext = {},
): StatusKind {
  if (context.featureEnabled === false || status.state === "disabled") {
    return "disabled";
  }
  switch (status.state) {
    case "unavailable":
      return "unavailable";
    case "waiting":
      return "scanning";
    case "translating":
      return "translating";
    case "ready":
      return "ready";
    case "cancelled":
      return "cancelled";
    case "partial":
    case "error":
      return terminalFailureKind(status);
  }
}

function pendingPrimaryAction(
  pending: PendingStatusAction,
  task: Task,
): StatusAction {
  const busy = (id: StatusActionId, key: StatusMessageKey): StatusAction => ({
    id,
    label: text(key),
    disabled: true,
    busy: true,
  });
  switch (pending) {
    case "starting":
      return task === "page"
        ? busy("translate", "statusActionStarting")
        : busy("enable", "statusActionEnabling");
    case "stopping":
      return busy("stop", "statusActionStopping");
    case "retrying":
      return busy("retry", "statusActionRetrying");
    case "resuming":
      return busy("resume", "statusActionResuming");
  }
}

function retryLabel(task: Task, count: number): LocalizedText {
  return task === "page"
    ? text("statusActionRetryBlocks", count)
    : text("statusActionRetryCues", count);
}

/** "Close" for subtitles means switching subtitle translation off. */
function closeAction(task: Task): StatusAction {
  return task === "page"
    ? action("restore", text("statusActionRestore"))
    : action("disable", text("statusActionDisableSubtitles"));
}

interface Actions {
  primary?: StatusAction;
  secondary: StatusAction[];
}

function actionsFor(
  task: Task,
  kind: StatusKind,
  progress: StatusProgress,
  reasonCode: string | undefined,
  ocrAvailable: boolean,
): Actions {
  switch (kind) {
    case "disabled":
      return {
        primary: action("enable", text("statusActionEnable")),
        secondary: [],
      };
    case "unavailable": {
      const entry = resolveReason(reasonCode);
      const remedy = entry.unavailableAction;
      const labels: Partial<Record<StatusActionId, StatusMessageKey>> = {
        tryOcr: "statusActionTryOcr",
        useAutoDetect: "statusActionUseAutoDetect",
        openProviderSettings: "statusActionOpenProviderSettings",
      };
      const key =
        remedy && !(remedy === "tryOcr" && !ocrAvailable)
          ? labels[remedy]
          : undefined;
      const remedyAction =
        remedy && key ? action(remedy, text(key)) : undefined;
      // Discovery ended without a track: checking again is always possible,
      // so it backs up the remedy (or stands alone without OCR).
      const rescan =
        task === "subtitle" && reasonCode === STATUS_REASON.subtitleNoTrack
          ? action("rescan", text("statusActionRescan"))
          : undefined;
      if (remedyAction) {
        return { primary: remedyAction, secondary: rescan ? [rescan] : [] };
      }
      return rescan ? { primary: rescan, secondary: [] } : { secondary: [] };
    }
    case "idle":
      return task === "page"
        ? {
            primary: action("translate", text("statusActionTranslate")),
            secondary: [],
          }
        : {
            primary: action("enable", text("statusActionEnable")),
            secondary: [],
          };
    case "scanning":
      return task === "page"
        ? { primary: action("stop", text("statusActionStop")), secondary: [] }
        : { primary: closeAction(task), secondary: [] };
    case "translating":
      return {
        primary: action("stop", text("statusActionStop")),
        secondary: [],
      };
    case "ready":
      return {
        primary: closeAction(task),
        secondary: [action("switchDisplay", text("statusActionSwitchDisplay"))],
      };
    case "partial":
      return {
        primary: action("retry", retryLabel(task, progress.failed)),
        secondary: [closeAction(task)],
      };
    case "cancelled":
      return {
        primary: action("resume", text("statusActionResume")),
        secondary: [closeAction(task)],
      };
    case "error": {
      const settings = action(
        "openProviderSettings",
        text("statusActionOpenProviderSettings"),
      );
      const retry = action("retry", retryLabel(task, progress.failed));
      // A zero-count retry label would be meaningless; a task-level failure
      // without failed items is retried by starting it again.
      const retryOrRestart =
        progress.failed > 0
          ? retry
          : task === "page"
            ? action("translate", text("statusActionTranslate"))
            : action("enable", text("statusActionEnable"));
      return resolveReason(reasonCode).remedy === "settings"
        ? { primary: settings, secondary: [retryOrRestart] }
        : { primary: retryOrRestart, secondary: [settings] };
    }
  }
}

/**
 * Applies README §2.2 rule 2: an in-flight request occupies the same slot
 * with a disabled transitional label, and nothing else is clickable meanwhile.
 */
function withPending(
  actions: Actions,
  pending: PendingStatusAction | undefined,
  task: Task,
): Actions {
  if (!pending) return actions;
  return {
    primary: pendingPrimaryAction(pending, task),
    secondary: actions.secondary.map((item) => ({ ...item, disabled: true })),
  };
}

function trackTags(kind: SubtitleTrackKind | undefined): SubtitleTrackTag[] {
  switch (kind) {
    case "full":
      return ["full"];
    case "stream":
      return ["stream"];
    case "ocr":
      return ["stream", "experimental"];
    case undefined:
      return [];
  }
}

function subtitleTrackKind(
  status: SubtitleStatus,
  context: SubtitleStatusViewContext,
): SubtitleTrackKind | undefined {
  if (context.track) return context.track;
  if (status.source === "ocr") return "ocr";
  return status.completeness;
}

/**
 * The reason line. Failure kinds always name a reason (unknown or missing
 * codes get the explicit generic sentences); live tracks carry their fixed
 * constraint sentence; everything else has no reason line.
 */
function reasonLine(
  kind: StatusKind,
  progress: StatusProgress,
  reasonCode: string | undefined,
  track: SubtitleTrackKind | undefined,
): LocalizedText | undefined {
  switch (kind) {
    case "disabled":
    case "idle":
    case "scanning":
    case "cancelled":
      return undefined;
    case "unavailable":
    case "partial":
    case "error":
      return resolveReason(reasonCode).text;
    case "translating":
    case "ready":
      break;
  }
  if (
    kind === "translating" &&
    progress.failedSoFar !== undefined &&
    reasonCode !== undefined &&
    !isStreamReasonCode(reasonCode)
  ) {
    return resolveReason(reasonCode).text;
  }
  if (track === "ocr") return text("statusReasonOcrLocalOnly");
  if (track === "stream") {
    return reasonCode === STATUS_REASON.streamFallbackRefresh
      ? text("statusReasonStreamFallbackRefresh")
      : text("statusReasonStreamFallback");
  }
  return undefined;
}

function progressFor(
  kind: StatusKind,
  status: PageStatus | SubtitleStatus,
): StatusProgress {
  return {
    done: status.completed,
    total: status.total,
    failed: status.failed,
    ...(kind === "translating" && status.failed > 0
      ? { failedSoFar: status.failed }
      : {}),
  };
}

function progressNote(
  progress: StatusProgress,
): Pick<StatusView, "progressNote"> {
  return progress.failedSoFar === undefined
    ? {}
    : { progressNote: text("statusProgressFailedSoFar", progress.failedSoFar) };
}

function retryProgress(
  context: StatusViewContext,
  status: PageStatus | SubtitleStatus,
): { done: number; count: number } | undefined {
  if (!context.retry) return undefined;
  const done = Math.max(0, status.completed - context.retry.completedAtStart);
  return {
    done: Math.min(done, context.retry.count),
    count: context.retry.count,
  };
}

function pageTitle(
  kind: StatusKind,
  status: PageStatus,
  context: StatusViewContext,
): LocalizedText {
  switch (kind) {
    case "disabled":
      return text("statusTitleDisabledPage");
    case "unavailable":
      return text("statusTitleUnavailablePage");
    case "idle":
      return text("statusTitleIdlePage");
    case "scanning":
      return text("statusTitleScanningPage");
    case "translating": {
      const retry = retryProgress(context, status);
      return retry
        ? text("statusTitleRetryingPage", retry.done, retry.count)
        : text("statusTitleTranslatingPage", status.completed, status.total);
    }
    case "ready":
      return text("statusTitleReadyPage", status.total);
    case "partial":
      return text(
        "statusTitlePartialPage",
        status.completed,
        status.total,
        status.failed,
      );
    case "cancelled":
      return text("statusTitleCancelled", status.completed, status.total);
    case "error":
      return text("statusTitleErrorPage");
  }
}

function subtitleTitle(
  kind: StatusKind,
  status: SubtitleStatus,
  context: StatusViewContext,
  track: SubtitleTrackKind | undefined,
  reasonCode: string | undefined,
): LocalizedText {
  const live = track === "stream" || track === "ocr";
  switch (kind) {
    case "disabled":
      return text("statusTitleDisabledSubtitle");
    case "unavailable":
      return reasonCode === STATUS_REASON.sourceLanguageMismatch
        ? text("statusTitleUnavailableSubtitleLanguage")
        : text("statusTitleUnavailableSubtitle");
    case "idle":
      return text("statusTitleIdleSubtitle");
    case "scanning":
      return text("statusTitleWaitingSubtitle");
    case "translating": {
      const retry = retryProgress(context, status);
      if (retry) {
        return text("statusTitleRetryingSubtitle", retry.done, retry.count);
      }
      // A live track has no meaningful total: only observed cues exist.
      return live
        ? text("statusTitleLiveSubtitle")
        : text(
            "statusTitleTranslatingSubtitle",
            status.completed,
            status.total,
          );
    }
    case "ready":
      return live
        ? text("statusTitleLiveSubtitle")
        : text("statusTitleReadySubtitle", status.total);
    case "partial":
      return text(
        "statusTitlePartialSubtitle",
        status.completed,
        status.total,
        status.failed,
      );
    case "cancelled":
      return text("statusTitleCancelled", status.completed, status.total);
    case "error":
      return text("statusTitleErrorSubtitle");
  }
}

function diagnosticsFor(
  kind: StatusKind,
  status: PageStatus | SubtitleStatus,
): StatusView["diagnostics"] {
  // A disabled feature ran no detection, so stale diagnostics must not leak.
  if (kind === "disabled") return {};
  return {
    ...(status.reasonCode ? { reasonCode: status.reasonCode } : {}),
    ...(status.details ? { details: status.details } : {}),
  };
}

export function pageStatusView(
  status: PageStatus,
  context: StatusViewContext = {},
): StatusView {
  const kind = pageStatusKind(status, context);
  const progress = progressFor(kind, status);
  const reasonCode = kind === "disabled" ? undefined : status.reasonCode;
  const reason = reasonLine(kind, progress, reasonCode, undefined);
  const actions = withPending(
    actionsFor("page", kind, progress, reasonCode, false),
    context.pending,
    "page",
  );
  return {
    task: "page",
    kind,
    ...APPEARANCE[kind],
    title: pageTitle(kind, status, context),
    ...(reason ? { reason } : {}),
    progress,
    ...progressNote(progress),
    retrying: kind === "translating" && context.retry !== undefined,
    tracks: [],
    ...(actions.primary ? { primaryAction: actions.primary } : {}),
    secondaryActions: actions.secondary,
    diagnostics: diagnosticsFor(kind, status),
  };
}

export function subtitleStatusView(
  status: SubtitleStatus,
  context: SubtitleStatusViewContext = {},
): StatusView {
  const kind = subtitleStatusKind(status, context);
  const progress = progressFor(kind, status);
  const reasonCode = kind === "disabled" ? undefined : status.reasonCode;
  // Track chips describe an acquired track; none exists when off or absent.
  const track =
    kind === "disabled" || kind === "unavailable" || kind === "scanning"
      ? undefined
      : subtitleTrackKind(status, context);
  const reason = reasonLine(kind, progress, reasonCode, track);
  const actions = withPending(
    actionsFor(
      "subtitle",
      kind,
      progress,
      reasonCode,
      context.ocrAvailable === true,
    ),
    context.pending,
    "subtitle",
  );
  return {
    task: "subtitle",
    kind,
    ...APPEARANCE[kind],
    title: subtitleTitle(kind, status, context, track, reasonCode),
    ...(reason ? { reason } : {}),
    progress,
    ...progressNote(progress),
    retrying: kind === "translating" && context.retry !== undefined,
    tracks: trackTags(track),
    ...(actions.primary ? { primaryAction: actions.primary } : {}),
    secondaryActions: actions.secondary,
    diagnostics: diagnosticsFor(kind, status),
  };
}
