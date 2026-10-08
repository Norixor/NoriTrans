import type {
  PendingStatusAction,
  StatusActionId,
  StatusKind,
} from "@/src/ui/status";

/** How long a resolved request may wait for the confirming status update. */
export const PENDING_CONFIRM_GRACE_MS = 4000;

export interface PendingAction {
  id: StatusActionId;
  /** Transitional label known to the status model, when one exists. */
  label?: PendingStatusAction;
  /** Status kind when the user clicked; a different kind confirms it. */
  baseline: StatusKind;
}

export type PendingRunResult = "done" | "failed" | "busy";

/**
 * Tracks one in-flight user action for a status card (README §2.2 rule 2).
 *
 * The slot stays in its transitional state until the backend confirms a new
 * state (`observe()` sees a kind different from the click-time kind). Callers'
 * promises usually resolve when the command was dispatched, before the status
 * arrives, so a resolved request only ends the transition after a grace
 * period; a rejected request ends it at once. This keeps the button from
 * flipping back to its previous label in between.
 */
export class PendingActionTracker {
  private pending: PendingAction | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onChange: () => void,
    private readonly graceMs = PENDING_CONFIRM_GRACE_MS,
  ) {}

  get current(): PendingAction | undefined {
    return this.pending;
  }

  async run(
    action: PendingAction,
    request: () => Promise<void> | void,
  ): Promise<PendingRunResult> {
    if (this.pending) return "busy";
    const entry = { ...action };
    this.pending = entry;
    this.onChange();
    try {
      await request();
    } catch {
      this.clear(entry);
      return "failed";
    }
    if (this.pending === entry) {
      this.timer = setTimeout(() => this.clear(entry), this.graceMs);
    }
    return "done";
  }

  /** Ends the transition when the status moved away from the baseline. */
  observe(kind: StatusKind): void {
    if (this.pending && this.pending.baseline !== kind) {
      this.clear(this.pending);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }

  private clear(entry: PendingAction): void {
    if (this.pending !== entry) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.onChange();
  }
}
