import type { ContentSettings } from "@/src/shared/settings";
import type { StatusView } from "@/src/ui/status";
import type { TemplateResult } from "lit";
import type { CapabilitySnapshot } from "./options";
import type { FloatingTabId } from "./view";

export type { FloatingTabId };

/**
 * Options-page sections the floating control links to (`options.html#<id>`).
 * `ocr`, `image` and `video` point at the image recognition (runtime
 * downloads), image translation and video settings; the options page opens
 * its first tab for a hash it does not route yet.
 */
export type SettingsSection =
  "providers" | "visibility" | "ocr" | "image" | "video";

/** Services the shell offers to tab modules. */
export interface FloatingTabContext {
  /** Schedules a (batched) re-render of the whole control. */
  requestRender(): void;
  capabilities(): CapabilitySnapshot;
  openSettings(section?: SettingsSection): void;
  /** Hostname of the page the control lives on. */
  hostname(): string;
  /** Closes the panel (e.g. before a page-level overlay takes over). */
  collapse(): void;
  /**
   * Renders now and moves focus to the first element matching `selector`
   * inside the control, once it has rendered. Used when the focused control
   * is replaced (e.g. a card swap) so keyboard focus is not lost.
   */
  focus(selector: string): void;
}

/**
 * One tab of the floating panel. The shell owns the frame (launcher, title
 * bar, tabs, dismissal, fullscreen); a tab owns its status card, summary and
 * controls. Tabs render into a light-DOM slot of `nt-tabs`, inside the
 * control's shadow root, so the shell stylesheet applies to them.
 *
 * Extension point for later steps: the video tab (3b-2) implements this
 * interface, and OCR / image blocks (3b-3) are `FloatingPanelSection`s that a
 * tab lists after its own content.
 */
export interface FloatingTab {
  readonly id: FloatingTabId;
  label(): string;
  /** Current status view; drives the tab dot and the collapsed button. */
  statusView(): StatusView;
  updateSettings(settings: ContentSettings): void;
  render(): TemplateResult;
  /** Escape pressed while the panel is open; true when the tab consumed it. */
  handleEscape?(): boolean;
  dispose(): void;
}

/** A self-contained block a tab can append below its own content. */
export interface FloatingPanelSection {
  readonly id: string;
  /** Hidden sections are skipped entirely (no empty wrappers). */
  visible(): boolean;
  render(): TemplateResult;
  /** Settings pushed to the host tab are forwarded to its sections. */
  updateSettings?(settings: ContentSettings): void;
  /**
   * A status card that should stand in for the tab's own card while the
   * section owns the task (e.g. image recognition running in place of "no
   * readable subtitles"). Undefined leaves the tab's card in place.
   */
  renderStatusCard?(): TemplateResult | undefined;
  /**
   * Status the tab should report to the shell (tab dot, collapsed button)
   * while the section owns the task; undefined keeps the tab's own view.
   */
  statusView?(): StatusView | undefined;
  /** Escape pressed while the panel is open; true when consumed. */
  handleEscape?(): boolean;
  dispose?(): void;
}
