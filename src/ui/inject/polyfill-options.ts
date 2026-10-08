/**
 * Pre-polyfill configuration. Must be evaluated before
 * `@webcomponents/custom-elements` (see ./polyfill.ts).
 *
 * In a Chrome content-script isolated world `customElements` is `null`. The
 * polyfill reads its options from whatever `window.customElements` holds when
 * it is evaluated, so a placeholder carrying the options is installed here and
 * replaced by the polyfill immediately afterwards.
 *
 * `noDocumentConstructionObserver` matters because NoriTrans content scripts
 * run at `document_start`: without it the polyfill observes the whole page
 * while it is still parsing, patching every node and upgrading any page-owned
 * element whose tag name matches one of ours.
 *
 * Contexts with a native registry (extension pages, jsdom) are left untouched.
 */
const current: unknown = (globalThis as { customElements?: unknown })
  .customElements;

if (current === null || current === undefined) {
  Object.defineProperty(globalThis, "customElements", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { noDocumentConstructionObserver: true },
  });
}

export {};
