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
  } else if (statuses.some((status) => status.state === "error")) {
    state = completed > 0 ? "partial" : "error";
  } else if (statuses.some((status) => status.state === "translated")) {
    state = "translated";
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

export function aggregateSubtitleStatuses(
  top: SubtitleStatus,
  children: readonly SubtitleStatus[],
  options: { cancelRequested?: boolean } = {},
): SubtitleStatus {
  const statuses = [top, ...children];
  const active = statuses.filter(
    (status) => status.state !== "unavailable" || status.total > 0,
  );
  if (active.length === 0) {
    return { state: "unavailable", total: 0, completed: 0, failed: 0 };
  }
  const total = active.reduce((sum, status) => sum + status.total, 0);
  const completed = active.reduce((sum, status) => sum + status.completed, 0);
  const failed = active.reduce((sum, status) => sum + status.failed, 0);
  const stateOrder: SubtitleStatus["state"][] = [
    "translating",
    "partial",
    "ready",
    "error",
    "waiting",
    "cancelled",
    "unavailable",
  ];
  const state = options.cancelRequested
    ? "cancelled"
    : (stateOrder.find((candidate) =>
        active.some((status) => status.state === candidate),
      ) ?? "unavailable");
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
