// Must stay the first import: the polyfill has to be evaluated before `lit`.
import "./polyfill";
import { NT_ELEMENTS, defineNtComponents } from "../components";
import { customElementsMode, type CustomElementsMode } from "./polyfill";

export {
  NT_GUARDED_EVENT_TYPES,
  guardInjectedEvents,
  type EventGuardOptions,
} from "./event-guard";
export {
  createFullscreenPortal,
  deepFullscreenElement,
  type FullscreenChange,
  type FullscreenPortal,
  type FullscreenPortalOptions,
  type FullscreenPresentation,
} from "./fullscreen";
export {
  createInjectedRoot,
  type InjectedRoot,
  type InjectedRootOptions,
} from "./mount";
export type { CustomElementsMode };

export type InjectedUiResult =
  | {
      ok: true;
      code: "defined";
      mode: Exclude<CustomElementsMode, "unavailable">;
    }
  | { ok: false; code: "custom-elements-unavailable" }
  /**
   * Lit was evaluated before the polyfill, so the components extend the
   * native `HTMLElement`, which cannot be constructed in an isolated world.
   * Fix the import order of the bundle entry (import this module first).
   */
  | { ok: false; code: "polyfill-loaded-too-late" }
  | { ok: false; code: "define-failed" };

/**
 * Whether `ctor` inherits from `base` (the `HTMLElement` binding in effect
 * now). The polyfill replaces the global `HTMLElement`, so classes created
 * before it was installed inherit from a different function.
 */
export function extendsHTMLElement(
  ctor: abstract new () => unknown,
  base: unknown = globalThis.HTMLElement,
): boolean {
  for (
    let current: unknown = ctor;
    typeof current === "function";
    current = Object.getPrototypeOf(current)
  ) {
    if (current === base) return true;
  }
  return false;
}

let defined: InjectedUiResult | undefined;

/**
 * Prepares the `nt-*` components for UI injected by a content script.
 *
 * Idempotent and cheap after the first success. Every frame (all_frames) has
 * its own isolated world, polyfill and registry, so each frame calls this for
 * itself. Several content-script bundles of the extension share one isolated
 * world per frame: the first bundle defines the tags and later bundles reuse
 * those definitions, which assumes all bundles come from the same build.
 */
export function ensureInjectedUi(): InjectedUiResult {
  if (defined) return defined;
  if (customElementsMode === "unavailable") {
    return { ok: false, code: "custom-elements-unavailable" };
  }
  if (!Object.values(NT_ELEMENTS).every((ctor) => extendsHTMLElement(ctor))) {
    return { ok: false, code: "polyfill-loaded-too-late" };
  }
  try {
    const result = defineNtComponents();
    if (!result.ok) return result;
  } catch {
    return { ok: false, code: "define-failed" };
  }
  defined = { ok: true, code: "defined", mode: customElementsMode };
  return defined;
}
