import type { PageStatus, SubtitleStatus } from "@/src/messaging/protocol";

function firstMessage(
  statuses: readonly (PageStatus | SubtitleStatus)[],
): string | undefined {
  return statuses.find((status) => status.message)?.message;
}

function firstDetails(
  statuses: readonly (PageStatus | SubtitleStatus)[],
): string | undefined {
  return statuses.find((status) => status.details)?.details;
}

export function aggregatePageStatuses(
  top: PageStatus,
  children: readonly PageStatus[],
): PageStatus {
  const statuses = [top, ...children];
  const total = statuses.reduce((sum, status) => sum + status.total, 0);
  const completed = statuses.reduce((sum, status) => sum + status.completed, 0);
  const failed = statuses.reduce((sum, status) => sum + status.failed, 0);
  let state: PageStatus["state"];
  if (statuses.some((status) => status.state === "translating")) {
    state = "translating";
  } else if (statuses.some((status) => status.state === "scanning")) {
    state = "scanning";
  } else if (statuses.some((status) => status.state === "partial")) {
    state = "partial";
  } else if (statuses.some((status) => status.state === "cancelled")) {
    state = "cancelled";
  } else if (statuses.some((status) => status.state === "error")) {
    state = completed > 0 ? "partial" : "error";
  } else if (statuses.some((status) => status.state === "translated")) {
    state = "translated";
  } else if (statuses.every((status) => status.state === "unavailable")) {
    // Only when no frame can translate at all; an unavailable child beside an
    // idle top frame is still an idle page.
    state = "unavailable";
  } else {
    state = "idle";
  }
  const message = firstMessage(statuses);
  const details = firstDetails(statuses);
  return {
    state,
    total,
    completed,
    failed,
    ...(message ? { message } : {}),
    ...(details ? { details } : {}),
  };
}

/**
 * Combines per-frame subtitle states. Every frame's SubtitleController is the
 * single source of truth for its own cancellation: a tab-wide cancel reaches
 * each frame, and a frame that later starts a new task (next video, changed
 * source language, newly discovered track) must not be masked as cancelled.
 */
export function aggregateSubtitleStatuses(
  top: SubtitleStatus,
  children: readonly SubtitleStatus[],
): SubtitleStatus {
  const statuses = [top, ...children];
  const active = statuses.filter(
    (status) =>
      (status.state !== "unavailable" && status.state !== "disabled") ||
      status.total > 0,
  );
  if (active.length === 0) {
    // Frames report the same setting, so any "disabled" frame means the
    // feature is off rather than that no track was found.
    const disabled = statuses.some((status) => status.state === "disabled");
    // Keep the reason a frame found no usable track (for example a subtitle
    // language that differs from the configured source language).
    const message = disabled ? undefined : firstMessage(statuses);
    return {
      state: disabled ? "disabled" : "unavailable",
      total: 0,
      completed: 0,
      failed: 0,
      ...(message ? { message } : {}),
    };
  }
  const total = active.reduce((sum, status) => sum + status.total, 0);
  const completed = active.reduce((sum, status) => sum + status.completed, 0);
  const failed = active.reduce((sum, status) => sum + status.failed, 0);
  const stateOrder: SubtitleStatus["state"][] = [
    "translating",
    "partial",
    "ready",
    "error",
    // A cancelled task always has a track; a frame that is still waiting for
    // one must not hide that cancellation.
    "cancelled",
    "waiting",
    "unavailable",
  ];
  const state =
    stateOrder.find((candidate) =>
      active.some((status) => status.state === candidate),
    ) ?? "unavailable";
  const sources = new Set(
    active.flatMap((status) => (status.source ? [status.source] : [])),
  );
  const source = sources.size === 1 ? sources.values().next().value : undefined;
  const completenessValues = active.flatMap((status) =>
    status.completeness ? [status.completeness] : [],
  );
  const message = firstMessage(active);
  const details = firstDetails(active);
  return {
    state,
    total,
    completed,
    failed,
    ...(source ? { source } : {}),
    ...(completenessValues.length > 0
      ? {
          completeness: completenessValues.every((value) => value === "full")
            ? ("full" as const)
            : ("stream" as const),
        }
      : {}),
    ...(message ? { message } : {}),
    ...(details ? { details } : {}),
  };
}
