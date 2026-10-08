import type {
  ImageTranslationState,
  ImageTranslationStatus,
} from "@/src/image-translation/controller";
import type { NtButtonVariant, NtVisualState } from "@/src/ui/components";
import { resolveReason } from "@/src/ui/status";
import type { ViewText } from "./section-view";

/**
 * Thin view mapping for image translation (a page-level block of the page
 * tab). `ImageTranslationStatus` is not part of the shared status model, so
 * the card and actions are derived here. Actions come from `reasonCode`;
 * `message` is the controller's localized sentence and is shown as is.
 */

export type ImageActionId =
  "translate" | "stop" | "clear" | "openSettings" | "openProviderSettings";

export interface ImageCardAction {
  id: ImageActionId;
  label: ViewText;
  variant: NtButtonVariant;
  busy: boolean;
  disabled: boolean;
}

export interface ImageCardView {
  state: NtVisualState;
  title: ViewText;
  count?: ViewText;
  description?: ViewText;
  /** 0..1 while translating; null for an indeterminate bar. */
  progress: number | null;
  primary?: ImageCardAction;
  secondary: ImageCardAction[];
  diagnostics?: string;
}

export type ImagePending = "starting" | "stopping" | "clearing";

export interface ImageViewInput {
  status: ImageTranslationStatus;
  pending?: ImagePending | undefined;
  /** The selected method can translate the language pair. */
  pairAvailable: boolean;
}

export type ImagePhase =
  "off" | "waiting" | "ready" | "running" | "done" | "stopped" | "problem";

export const IMAGE_PHASE_KEYS: Readonly<Record<ImagePhase, string>> = {
  off: "floatingImageStateOff",
  waiting: "floatingImageStateWaiting",
  ready: "floatingImageStateReady",
  running: "floatingImageStateRunning",
  done: "floatingImageStateDone",
  stopped: "floatingImageStateStopped",
  problem: "floatingImageStateProblem",
};

const RUNNING: ReadonlySet<ImageTranslationState> = new Set([
  "capturing",
  "recognizing",
  "translating",
]);

export function isImageRunning(status: ImageTranslationStatus): boolean {
  return RUNNING.has(status.state);
}

export function imagePhase(
  status: ImageTranslationStatus,
  enabled: boolean,
): ImagePhase {
  if (!enabled || status.state === "disabled") return "off";
  switch (status.state) {
    case "idle":
      return "waiting";
    case "available":
      return "ready";
    case "capturing":
    case "recognizing":
    case "translating":
      return "running";
    case "ready":
      return "done";
    case "cancelled":
      return "stopped";
    case "unavailable":
    case "error":
      return "problem";
  }
}

const TITLE_KEYS: Readonly<Record<ImageTranslationState, string>> = {
  disabled: "imageStatusDisabled",
  idle: "floatingImageNoImageTitle",
  available: "imageStatusAvailable",
  capturing: "imageStatusCapturing",
  recognizing: "imageStatusRecognizing",
  translating: "imageStatusTranslating",
  ready: "imageStatusReady",
  cancelled: "imageStatusCancelled",
  unavailable: "imageStatusUnavailable",
  error: "floatingImageErrorTitle",
};

function visualState(state: ImageTranslationState): NtVisualState {
  switch (state) {
    case "available":
    case "disabled":
      return "idle";
    case "capturing":
    case "recognizing":
      return "scanning";
    default:
      return state;
  }
}

function action(
  id: ImageActionId,
  key: string,
  variant: NtButtonVariant,
  disabled = false,
): ImageCardAction {
  return { id, label: { key }, variant, busy: false, disabled };
}

function busyAction(id: ImageActionId, key: string): ImageCardAction {
  return {
    id,
    label: { key },
    variant: "secondary",
    busy: true,
    disabled: true,
  };
}

/** Remedy for a failed or unavailable image (from the reason code). */
function remedy(status: ImageTranslationStatus): ImageActionId | undefined {
  const code = status.reasonCode;
  if (code === "ocr_runtime_missing") return "openSettings";
  if (code === "image_not_visible") return undefined;
  if (code && resolveReason(code).remedy === "settings") {
    return "openProviderSettings";
  }
  return status.hasCurrentImage ? "translate" : undefined;
}

export function imageCardView(input: ImageViewInput): ImageCardView {
  const { status, pending } = input;
  const busy = pending !== undefined;
  const translate = (key: string, variant: NtButtonVariant = "primary") =>
    pending === "starting"
      ? busyAction("translate", "statusActionStarting")
      : action(
          "translate",
          key,
          variant,
          busy || !status.hasCurrentImage || !input.pairAvailable,
        );
  const clear = (variant: NtButtonVariant) =>
    pending === "clearing"
      ? busyAction("clear", "imageClearAction")
      : action("clear", "imageClearAction", variant, busy);
  const view: ImageCardView = {
    state: visualState(status.state),
    title: { key: TITLE_KEYS[status.state] },
    progress: null,
    secondary: [],
  };
  const details = status.details?.trim();
  if (details) view.diagnostics = details;

  switch (status.state) {
    case "disabled":
    case "idle":
      view.description = { key: "imageStatusIdle" };
      view.primary = translate("imageTranslateCurrent");
      break;
    case "available":
      view.primary = translate("imageTranslateCurrent");
      break;
    case "capturing":
    case "recognizing":
    case "translating":
      if (status.state === "translating" && status.total > 0) {
        view.count = {
          key: "floatingImageCount",
          substitutions: [String(status.completed), String(status.total)],
        };
        view.progress = Math.min(
          1,
          Math.max(0, status.completed / status.total),
        );
      }
      view.primary =
        pending === "stopping"
          ? busyAction("stop", "statusActionStopping")
          : action("stop", "statusActionStop", "secondary", busy);
      break;
    case "ready":
      view.primary = clear("secondary");
      break;
    case "cancelled":
      view.primary = translate("imageTranslateCurrent");
      if (status.hasCurrentImage) view.secondary = [clear("ghost")];
      break;
    case "unavailable":
    case "error": {
      if (status.message) view.description = { raw: status.message };
      const fix = remedy(status);
      if (fix === "openSettings") {
        view.primary = action(
          "openSettings",
          "floatingImageOpenSettings",
          "primary",
        );
      } else if (fix === "openProviderSettings") {
        view.primary = action(
          "openProviderSettings",
          "statusActionOpenProviderSettings",
          "primary",
        );
      } else if (fix === "translate") {
        view.primary = translate("imageRetryAction");
      }
      if (status.hasCurrentImage) view.secondary = [clear("ghost")];
      break;
    }
  }
  return view;
}
