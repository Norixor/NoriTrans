import { NtButton } from "./button";
import { NtChip } from "./chip";
import { NtFab, NtPillFab } from "./fab";
import { NtIconButton } from "./icon-button";
import { NtMenu } from "./menu";
import { NtNote } from "./note";
import { NtProgressRing } from "./progress-ring";
import { NtQuickLine } from "./quick-line";
import { NtSegmented } from "./segmented";
import { NtSelect } from "./select";
import { NtSlider } from "./slider";
import { NtStatusCard } from "./status-card";
import { NtStatusIcon } from "./status-icon";
import { NtStepper } from "./stepper";
import { NtSwitch } from "./switch";
import { NtTabs } from "./tabs";
import { NtTextField } from "./text-field";

export { NtButton, type NtButtonSize, type NtButtonVariant } from "./button";
export { NtChip, type NtChipTone } from "./chip";
export { NtFab, NtPillFab } from "./fab";
export { NtIconButton } from "./icon-button";
export type { NtIconName } from "./icons";
export { NtMenu, type NtMenuCloseReason, type NtMenuItem } from "./menu";
export { NtNote, type NtNoteTone } from "./note";
export { NtProgressRing } from "./progress-ring";
export { NtQuickLine } from "./quick-line";
export { NtSegmented, type NtSegmentOption } from "./segmented";
export { NtSelect, type NtSelectOption } from "./select";
export { NtSlider } from "./slider";
export { NT_VISUAL_STATES, type NtVisualState } from "./shared";
export { NtStatusCard } from "./status-card";
export { NtStatusIcon } from "./status-icon";
export { NtStepper } from "./stepper";
export { NtSwitch } from "./switch";
export { NtTabs, type NtTabIndicator, type NtTabItem } from "./tabs";
export { NtTextField, type NtTextFieldType } from "./text-field";

/** Tag name → element class for every component in the B library. */
export const NT_ELEMENTS = {
  "nt-status-icon": NtStatusIcon,
  "nt-status-card": NtStatusCard,
  "nt-fab": NtFab,
  "nt-pill-fab": NtPillFab,
  "nt-button": NtButton,
  "nt-icon-button": NtIconButton,
  "nt-tabs": NtTabs,
  "nt-switch": NtSwitch,
  "nt-select": NtSelect,
  "nt-segmented": NtSegmented,
  "nt-stepper": NtStepper,
  "nt-menu": NtMenu,
  "nt-quick-line": NtQuickLine,
  "nt-note": NtNote,
  "nt-chip": NtChip,
  "nt-progress-ring": NtProgressRing,
  "nt-text-field": NtTextField,
  "nt-slider": NtSlider,
} as const;

export type NtDefineResult =
  | { ok: true; code: "defined" }
  | { ok: false; code: "custom-elements-unavailable" };

/**
 * Registers all `nt-*` elements. Registration is explicit (never a module
 * side effect) because Chrome content-script isolated worlds expose
 * `customElements === null` and cannot construct `HTMLElement` subclasses;
 * importing this module there must not throw. Callers in such contexts get
 * `custom-elements-unavailable` and must choose a different strategy.
 * Already-defined tags are skipped, so repeated calls are safe.
 */
export function defineNtComponents(
  registry:
    CustomElementRegistry | null | undefined = globalThis.customElements,
): NtDefineResult {
  if (!registry) return { ok: false, code: "custom-elements-unavailable" };
  for (const [tag, element] of Object.entries(NT_ELEMENTS)) {
    if (!registry.get(tag)) registry.define(tag, element);
  }
  return { ok: true, code: "defined" };
}

declare global {
  interface HTMLElementTagNameMap {
    "nt-status-icon": NtStatusIcon;
    "nt-status-card": NtStatusCard;
    "nt-fab": NtFab;
    "nt-pill-fab": NtPillFab;
    "nt-button": NtButton;
    "nt-icon-button": NtIconButton;
    "nt-tabs": NtTabs;
    "nt-switch": NtSwitch;
    "nt-select": NtSelect;
    "nt-segmented": NtSegmented;
    "nt-stepper": NtStepper;
    "nt-menu": NtMenu;
    "nt-quick-line": NtQuickLine;
    "nt-note": NtNote;
    "nt-chip": NtChip;
    "nt-progress-ring": NtProgressRing;
    "nt-text-field": NtTextField;
    "nt-slider": NtSlider;
  }
}
