import { PendingActionTracker } from "@/src/ui/floating/pending";
import { withLocalPending } from "@/src/ui/floating/view";
import type {
  StatusAction,
  StatusActionId,
  StatusKind,
  StatusView,
  StatusViewContext,
} from "@/src/ui/status";

/**
 * Actions the popup cannot perform: switching display mode and changing the
 * subtitle source language need the page's site profile, and image OCR needs
 * a region drawn on the page. The floating control and settings page offer
 * them instead.
 */
const POPUP_UNSUPPORTED_ACTIONS: ReadonlySet<StatusActionId> = new Set([
  "switchDisplay",
  "useAutoDetect",
  "tryOcr",
]);

/**
 * Per-card interaction state: the in-flight action (README §2.2 rule 2) and
 * the "retrying k of N" context. Status derivation itself stays in the
 * shared status model.
 */
export class TaskCardState {
  readonly tracker: PendingActionTracker;
  private retry: { completedAtStart: number; count: number } | undefined;
  private retrySawTranslating = false;

  constructor(onChange: () => void, graceMs?: number) {
    this.tracker = new PendingActionTracker(onChange, graceMs);
  }

  /** Feeds the latest backend kind; ends transitions it confirms. */
  observe(kind: StatusKind): void {
    this.tracker.observe(kind);
    if (!this.retry) return;
    if (kind === "translating") {
      this.retrySawTranslating = true;
    } else if (this.retrySawTranslating || !this.tracker.current) {
      this.retry = undefined;
      this.retrySawTranslating = false;
    }
  }

  context(): StatusViewContext {
    const pending = this.tracker.current;
    return {
      ...(pending?.label ? { pending: pending.label } : {}),
      ...(this.retry ? { retry: this.retry } : {}),
    };
  }

  /** Freezes actions for an unlabeled pending action and drops unsupported ones. */
  decorate(view: StatusView): StatusView {
    const pending = this.tracker.current;
    const next =
      pending && !pending.label ? withLocalPending(view, pending.id) : view;
    const supported = (action: StatusAction): boolean =>
      !POPUP_UNSUPPORTED_ACTIONS.has(action.id);
    const { primaryAction, ...rest } = next;
    return {
      ...rest,
      ...(primaryAction && supported(primaryAction) ? { primaryAction } : {}),
      secondaryActions: next.secondaryActions.filter(supported),
    };
  }

  beginRetry(completed: number, failed: number): void {
    if (failed <= 0) return;
    this.retry = { completedAtStart: completed, count: failed };
    this.retrySawTranslating = false;
  }

  cancelRetry(): void {
    this.retry = undefined;
    this.retrySawTranslating = false;
  }

  dispose(): void {
    this.tracker.dispose();
  }
}
