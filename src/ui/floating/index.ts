// Must stay the first import: the polyfill has to be evaluated before `lit`.
export {
  FLOATING_CONTROL_PORTAL_SURFACE,
  FLOATING_CONTROL_SURFACE,
  FloatingControl,
  type FloatingControlOptions,
  type FloatingMountResult,
} from "./control";
export type {
  FloatingPanelSection,
  FloatingTab,
  FloatingTabContext,
  SettingsSection,
} from "./tab";
