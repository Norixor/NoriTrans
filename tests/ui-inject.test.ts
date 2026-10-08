import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NT_GUARDED_EVENT_TYPES,
  createFullscreenPortal,
  createInjectedRoot,
  ensureInjectedUi,
  extendsHTMLElement,
} from "@/src/ui/inject";
import { emit } from "@/src/ui/components/shared";
import {
  NT_THEME_DOCUMENT_CSS,
  NT_THEME_HOST_CSS,
  NT_THEME_WRAPPER_CSS,
} from "@/src/ui/tokens/tokens";

const source = (path: string): string => readFileSync(resolve(path), "utf8");

function importSpecifiers(code: string): string[] {
  return [...code.matchAll(/^import\s+(?:[^"']*?from\s+)?["']([^"']+)["']/gmu)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

afterEach(() => {
  document.documentElement
    .querySelectorAll("[data-noritrans-ui]")
    .forEach((element) => element.remove());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("polyfill evaluation order", () => {
  it.each(["src/ui/inject/index.ts", "src/ui/inject/mount.ts"])(
    "%s imports the polyfill before anything else",
    (path) => {
      expect(importSpecifiers(source(path))[0]).toBe("./polyfill");
    },
  );

  it("configures the polyfill before evaluating it", () => {
    expect(importSpecifiers(source("src/ui/inject/polyfill.ts"))).toEqual([
      "./polyfill-options",
      "@webcomponents/custom-elements/custom-elements.min.js",
    ]);
  });

  it("detects classes created against a different HTMLElement", () => {
    class Native {}
    class Polyfilled {}
    class Component extends Native {}
    expect(extendsHTMLElement(Component, Native)).toBe(true);
    expect(extendsHTMLElement(Component, Polyfilled)).toBe(false);
  });
});

describe("ensureInjectedUi", () => {
  it("defines the components with the native registry and is idempotent", () => {
    const first = ensureInjectedUi();
    expect(first).toEqual({ ok: true, code: "defined", mode: "native" });
    expect(ensureInjectedUi()).toBe(first);
    expect(customElements.get("nt-menu")).toBeTypeOf("function");
  });
});

describe("theme CSS shapes", () => {
  it("scopes the wrapper theme to .nt-theme with system and explicit modes", () => {
    expect(NT_THEME_WRAPPER_CSS).not.toContain(":host");
    expect(NT_THEME_WRAPPER_CSS).toMatch(
      /^\.nt-theme \{[^}]*--nt-fg: #181530/u,
    );
    expect(NT_THEME_WRAPPER_CSS).toMatch(
      /@media \(prefers-color-scheme: dark\) \{ \.nt-theme:not\(\[data-theme="light"\]\) \{[^}]*--nt-fg: #f1efff/u,
    );
    expect(NT_THEME_WRAPPER_CSS).toContain('.nt-theme[data-theme="dark"]');
    expect(NT_THEME_WRAPPER_CSS).toContain('.nt-theme[data-theme="light"]');
    // Typography reset by the host's `all: initial` is restored.
    expect(NT_THEME_WRAPPER_CSS).toMatch(
      /^\.nt-theme \{[^}]*font-size: var\(--nt-fs-body\);[^}]*line-height: var\(--nt-lh-body\)/u,
    );
  });

  it("keeps the host and document shapes", () => {
    expect(NT_THEME_HOST_CSS).toMatch(/^:host \{/u);
    expect(NT_THEME_HOST_CSS).toContain(':host([data-theme="dark"])');
    expect(NT_THEME_DOCUMENT_CSS).toMatch(/^:root \{/u);
    expect(NT_THEME_DOCUMENT_CSS).toContain(':root[data-theme="dark"]');
  });
});

describe("createInjectedRoot", () => {
  it("builds marker host, open shadow root and theme wrapper", () => {
    const ui = createInjectedRoot({
      surface: "test-surface",
      hostStyle: { right: "16px", "pointer-events": "none" },
      theme: "dark",
    });
    expect(ui.host.parentElement).toBe(document.documentElement);
    expect(ui.host.tagName).toBe("DIV");
    expect(ui.host.dataset.noritransUi).toBe("test-surface");
    expect(ui.host.shadowRoot).toBe(ui.root);
    expect(ui.root.mode).toBe("open");
    expect(ui.theme.parentNode).toBe(ui.root);
    expect(ui.theme.className).toBe("nt-theme");
    expect(ui.theme.dataset.theme).toBe("dark");
    for (const property of ["all", "display", "position", "z-index"]) {
      expect(ui.host.style.getPropertyPriority(property)).toBe("important");
    }
    expect(ui.host.style.getPropertyValue("display")).toBe("block");
    expect(ui.host.style.getPropertyValue("position")).toBe("fixed");
    expect(ui.host.style.getPropertyValue("right")).toBe("16px");
    expect(ui.host.style.getPropertyPriority("pointer-events")).toBe(
      "important",
    );

    ui.setTheme("system");
    expect(ui.theme.hasAttribute("data-theme")).toBe(false);
    ui.setHostStyle({ right: "", left: "8px" });
    expect(ui.host.style.getPropertyValue("right")).toBe("");
    expect(ui.host.style.getPropertyPriority("left")).toBe("important");

    ui.dispose();
    ui.dispose();
    expect(ui.host.isConnected).toBe(false);
  });
});

describe("event guard", () => {
  it("lists every event type the component library dispatches", () => {
    const dir = resolve("src/ui/components");
    const emitted = new Set<string>();
    for (const file of readdirSync(dir)) {
      const code = readFileSync(resolve(dir, file), "utf8");
      for (const match of code.matchAll(/emit\(\s*this,\s*"([^"]+)"/gu)) {
        if (match[1]) emitted.add(match[1]);
      }
    }
    expect(emitted.size).toBeGreaterThan(0);
    expect(
      [...emitted].filter((type) => !NT_GUARDED_EVENT_TYPES.includes(type)),
    ).toEqual([]);
  });

  function composedEvent(type: string, detail: unknown): CustomEvent {
    return new CustomEvent(type, {
      detail,
      bubbles: true,
      composed: true,
      cancelable: true,
    });
  }

  it("never lets component events reach page listeners, even in the capture phase", () => {
    const ui = createInjectedRoot({ surface: "test-not-composed" });
    const item = document.createElement("span");
    ui.theme.append(item);
    const inside = vi.fn();
    const pageCapture = vi.fn();
    const pageBubble = vi.fn();
    ui.theme.addEventListener("nt-select", inside);
    window.addEventListener("nt-select", pageCapture, true);
    document.addEventListener("nt-select", pageBubble);
    try {
      emit(item, "nt-select", { id: "hide" });
    } finally {
      window.removeEventListener("nt-select", pageCapture, true);
      document.removeEventListener("nt-select", pageBubble);
    }
    expect(inside).toHaveBeenCalledOnce();
    expect((inside.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      id: "hide",
    });
    expect(pageCapture).not.toHaveBeenCalled();
    expect(pageBubble).not.toHaveBeenCalled();
  });

  it("also stops composed events from escaping the injected root", () => {
    const ui = createInjectedRoot({ surface: "test-guard" });
    const item = document.createElement("span");
    ui.theme.append(item);
    const inside = vi.fn();
    const atRoot = vi.fn();
    const onDocument = vi.fn();
    const onWindow = vi.fn();
    ui.theme.addEventListener("nt-select", inside);
    ui.root.addEventListener("nt-select", atRoot);
    document.addEventListener("nt-select", onDocument);
    window.addEventListener("nt-select", onWindow);
    try {
      item.dispatchEvent(composedEvent("nt-select", { id: "hide" }));
      item.dispatchEvent(composedEvent("change", { checked: true }));
    } finally {
      document.removeEventListener("nt-select", onDocument);
      window.removeEventListener("nt-select", onWindow);
    }
    expect(inside).toHaveBeenCalledOnce();
    expect((inside.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({
      id: "hide",
    });
    expect(atRoot).toHaveBeenCalledOnce();
    expect(onDocument).not.toHaveBeenCalled();
    expect(onWindow).not.toHaveBeenCalled();
  });

  it("stops guarding after dispose", () => {
    const ui = createInjectedRoot({ surface: "test-guard-dispose" });
    const onDocument = vi.fn();
    document.addEventListener("nt-close", onDocument);
    ui.dispose();
    document.documentElement.append(ui.host);
    ui.theme.dispatchEvent(composedEvent("nt-close", { reason: "escape" }));
    document.removeEventListener("nt-close", onDocument);
    expect(onDocument).toHaveBeenCalledOnce();
  });
});

describe("createFullscreenPortal", () => {
  let fullscreenElement: Element | null = null;

  function setFullscreen(element: Element | null): void {
    fullscreenElement = element;
    document.dispatchEvent(new Event("fullscreenchange"));
  }

  function installFullscreenStubs(withPopover: boolean): void {
    fullscreenElement = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    if (withPopover) {
      const proto = HTMLElement.prototype as HTMLElement & {
        showPopover?: () => void;
        hidePopover?: () => void;
      };
      proto.showPopover = vi.fn(function (this: HTMLElement) {
        this.dataset.testOpen = "true";
      });
      proto.hidePopover = vi.fn(function (this: HTMLElement) {
        delete this.dataset.testOpen;
      });
    }
  }

  afterEach(() => {
    const proto = HTMLElement.prototype as {
      showPopover?: unknown;
      hidePopover?: unknown;
    };
    delete proto.showPopover;
    delete proto.hidePopover;
    Reflect.deleteProperty(document, "fullscreenElement");
  });

  function setup(): {
    host: HTMLElement;
    sibling: HTMLElement;
    player: HTMLElement;
    video: HTMLVideoElement;
    changes: string[];
    portal: ReturnType<typeof createFullscreenPortal>;
  } {
    const host = document.createElement("div");
    const sibling = document.createElement("div");
    document.body.append(host, sibling);
    const player = document.createElement("div");
    const video = document.createElement("video");
    document.body.append(player, video);
    const changes: string[] = [];
    const portal = createFullscreenPortal({
      host,
      surface: "test-fullscreen-portal",
      onChange: (change) => changes.push(change.presentation),
    });
    return { host, sibling, player, video, changes, portal };
  }

  it("puts an interactive portal inside a fullscreen container and restores the host", () => {
    installFullscreenStubs(true);
    const { host, sibling, player, changes, portal } = setup();
    setFullscreen(player);
    const portalElement = host.parentElement;
    expect(portalElement?.dataset.noritransUi).toBe("test-fullscreen-portal");
    expect(portalElement?.parentElement).toBe(player);
    expect(portalElement?.getAttribute("popover")).toBe("manual");
    expect(portalElement?.dataset.testOpen).toBe("true");
    expect(portalElement?.style.getPropertyPriority("display")).toBe(
      "important",
    );
    expect(portal.presentation).toBe("portal");

    setFullscreen(null);
    expect(host.parentElement).toBe(document.body);
    expect(host.nextSibling).toBe(sibling);
    expect(portalElement?.isConnected).toBe(false);
    expect(changes).toEqual(["portal", "inline"]);
    portal.dispose();
  });

  it("falls back to an inert root portal for a fullscreen video", () => {
    installFullscreenStubs(true);
    const { host, video, player, portal } = setup();
    setFullscreen(video);
    expect(host.parentElement?.parentElement).toBe(document.documentElement);
    expect(portal.presentation).toBe("inert-portal");
    // Switching to another element without exiting moves the portal there.
    setFullscreen(player);
    expect(host.parentElement?.parentElement).toBe(player);
    expect(portal.presentation).toBe("portal");
    portal.dispose();
    expect(host.parentElement).toBe(document.body);
    expect(
      document.querySelector('[data-noritrans-ui="test-fullscreen-portal"]'),
    ).toBeNull();
  });

  it("appends to the fullscreen element without the Popover API", () => {
    installFullscreenStubs(false);
    const { host, player, video, portal } = setup();
    setFullscreen(player);
    expect(host.parentElement).toBe(player);
    expect(portal.presentation).toBe("element");
    setFullscreen(null);
    setFullscreen(video);
    expect(portal.presentation).toBe("unsupported");
    expect(host.parentElement).toBe(document.body);
    portal.dispose();
  });
});
