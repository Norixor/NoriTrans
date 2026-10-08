/**
 * Side-effect module that makes custom elements usable in a content-script
 * isolated world. Import it before anything that evaluates `lit`: Lit's
 * element base class binds `HTMLElement` when its module is evaluated, and
 * only the polyfill's `HTMLElement` can be constructed in an isolated world.
 *
 * Where a native registry exists (extension pages, jsdom) the polyfill does
 * not install itself and this module has no effect beyond the polyfill's own
 * `window.__CE_installPolyfill` global.
 *
 * Once installed, document-wide flushing is disabled. By default every
 * `define()` walks the entire page document (~100 ms on a large page) and
 * upgrades page-owned elements that happen to share an `nt-*` tag name.
 * Injected UI never relies on that walk: definitions are registered before any
 * injected element is created, and elements created or inserted later are
 * upgraded by the polyfill's patched DOM methods. Consequence: the polyfilled
 * `customElements.whenDefined()` never resolves, so injected code must not use
 * it.
 */
import "./polyfill-options";
import "@webcomponents/custom-elements/custom-elements.min.js";

const FLUSH_DISABLED = Symbol.for(
  "noritrans.ui.custom-elements-flush-disabled",
);

interface PolyfilledRegistry extends CustomElementRegistry {
  polyfillWrapFlushCallback?: (outer: (flush: () => void) => void) => void;
  [FLUSH_DISABLED]?: true;
}

/** How custom elements are provided in the current JavaScript world. */
export type CustomElementsMode = "native" | "polyfill" | "unavailable";

function configureRegistry(): CustomElementsMode {
  const registry = (globalThis as { customElements?: unknown })
    .customElements as PolyfilledRegistry | null | undefined;
  if (
    !registry ||
    typeof registry.define !== "function" ||
    typeof registry.get !== "function"
  ) {
    return "unavailable";
  }
  if (typeof registry.polyfillWrapFlushCallback !== "function") {
    return "native";
  }
  // Every content-script bundle of the extension shares one isolated world per
  // frame, so a second bundle finds the registry already configured.
  if (!registry[FLUSH_DISABLED]) {
    registry.polyfillWrapFlushCallback(() => {
      // Intentionally never flush; see the module comment.
    });
    registry[FLUSH_DISABLED] = true;
  }
  return "polyfill";
}

export const customElementsMode: CustomElementsMode = configureRegistry();
