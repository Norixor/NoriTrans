/**
 * Keeps component events inside an injected shadow root.
 *
 * `nt-*` components dispatch bubbling, non-composed custom events (see
 * `emit()` in src/ui/components/shared.ts) whose `detail` can describe user
 * choices, e.g. which menu item was picked. Because they are not composed, a
 * page script never sees them on `window` or `document`, in the capture phase
 * or the bubble phase. This guard is defense in depth for any event that is
 * dispatched composed anyway (a future component, or code in the content
 * script that forwards one).
 *
 * The guard listens on the shadow root and stops propagation there. Listeners
 * inside the shadow tree run earlier in the bubble path and are unaffected;
 * other listeners on the root itself still run because only
 * `stopPropagation()` (not `stopImmediatePropagation()`) is used.
 *
 * Limitation: for a composed event, capture-phase listeners that the page
 * registers on `window` or `document` run before the event reaches the root
 * and cannot be blocked from here, which is why `emit()` is not composed.
 */

/**
 * Every event type dispatched by the `nt-*` component library. Native
 * `change` events are not composed and never leave the root anyway, so
 * guarding `change` only affects the components' custom `change` events.
 * tests/ui-inject.test.ts checks this list against the component sources.
 */
export const NT_GUARDED_EVENT_TYPES: readonly string[] = [
  "nt-action",
  "nt-announce-end",
  "nt-before-change",
  "nt-change",
  "nt-close",
  "nt-input",
  "nt-select",
  "change",
];

export interface EventGuardOptions {
  /** Additional event types to contain, e.g. events of caller-owned elements. */
  extraTypes?: readonly string[];
}

const stop = (event: Event): void => {
  event.stopPropagation();
};

/**
 * Installs the guard on `root` and returns a function that removes it.
 * Installing twice on the same root is harmless (listeners are deduplicated).
 */
export function guardInjectedEvents(
  root: ShadowRoot,
  options: EventGuardOptions = {},
): () => void {
  const types = [
    ...new Set([...NT_GUARDED_EVENT_TYPES, ...(options.extraTypes ?? [])]),
  ];
  for (const type of types) root.addEventListener(type, stop);
  return () => {
    for (const type of types) root.removeEventListener(type, stop);
  };
}
