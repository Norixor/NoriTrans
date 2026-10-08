import {
  OPTIONS_GROUPS,
  resolveOptionsRoute,
  type OptionsGroup,
  type OptionsRoute,
} from "./router";
import { rememberAdvancedOpen } from "./sections/common";

/**
 * Navigation shell: one group is visible at a time, chosen by `#hash`.
 * Links are plain anchors (one tab stop each, native keyboard behavior);
 * `aria-current="page"` marks the visible group.
 */
export class OptionsShell {
  private current: OptionsGroup | undefined;
  private readonly onHashChange = (): void => {
    this.show(resolveOptionsRoute(window.location.hash), true);
  };

  constructor(private readonly doc: Document = document) {}

  start(): void {
    window.addEventListener("hashchange", this.onHashChange);
    this.show(resolveOptionsRoute(window.location.hash), false);
  }

  dispose(): void {
    window.removeEventListener("hashchange", this.onHashChange);
  }

  /** Navigates to `hash` (updates history so Back works). */
  navigate(hash: string): void {
    if (window.location.hash === hash) {
      this.onHashChange();
    } else {
      window.location.hash = hash;
    }
  }

  show(route: OptionsRoute, moveFocus: boolean): void {
    for (const group of OPTIONS_GROUPS) {
      const panel = this.doc.getElementById(`group-${group}`);
      if (panel) panel.hidden = group !== route.group;
      const link = this.doc.querySelector<HTMLAnchorElement>(
        `.opt-nav a[data-group="${group}"]`,
      );
      if (!link) continue;
      if (group === route.group) {
        link.setAttribute("aria-current", "page");
        link.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      } else {
        link.removeAttribute("aria-current");
      }
    }
    const changedGroup = this.current !== route.group;
    this.current = route.group;
    // Deep links open their collapsed block once the group is rendered.
    requestAnimationFrame(() => {
      const target = route.anchor
        ? this.doc.getElementById(route.anchor)
        : undefined;
      if (target instanceof HTMLDetailsElement) {
        target.open = true;
        rememberAdvancedOpen(target.id, true);
      }
      if (target) {
        target.scrollIntoView({ block: "start" });
        if (moveFocus) target.querySelector<HTMLElement>("summary")?.focus();
        return;
      }
      if (changedGroup) window.scrollTo({ top: 0 });
      if (moveFocus) {
        this.doc
          .querySelector<HTMLElement>(`#group-${route.group} h1`)
          ?.focus({ preventScroll: true });
      }
    });
  }

  get group(): OptionsGroup | undefined {
    return this.current;
  }
}
