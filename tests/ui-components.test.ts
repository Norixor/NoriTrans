import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defineNtComponents,
  fabArcPath,
  fabArcSpec,
  fabRingKind,
  type NtButton,
  type NtMenu,
  type NtPillFab,
  type NtSegmented,
  type NtStatusCard,
  type NtStepper,
  type NtSwitch,
  type NtTabs,
} from "@/src/ui/components";

beforeAll(() => {
  expect(defineNtComponents()).toEqual({ ok: true, code: "defined" });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function mount<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  setup?: (element: HTMLElementTagNameMap[K]) => void,
): Promise<HTMLElementTagNameMap[K]> {
  const element = document.createElement(tag);
  setup?.(element);
  document.body.append(element);
  await (element as unknown as { updateComplete: Promise<unknown> })
    .updateComplete;
  return element;
}

function shadow(element: Element): ShadowRoot {
  if (!element.shadowRoot) throw new Error("missing shadow root");
  return element.shadowRoot;
}

function key(target: Element, keyName: string): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: keyName,
      bubbles: true,
      composed: true,
    }),
  );
}

describe("defineNtComponents", () => {
  it("reports a stable code when custom elements are unavailable (content-script world)", () => {
    expect(defineNtComponents(null)).toEqual({
      ok: false,
      code: "custom-elements-unavailable",
    });
  });

  it("is idempotent", () => {
    expect(defineNtComponents()).toEqual({ ok: true, code: "defined" });
  });
});

describe("nt-status-card", () => {
  it("falls back to idle for unknown states", async () => {
    const card = await mount("nt-status-card", (el) => {
      el.setAttribute("state", "bogus");
    });
    await card.updateComplete;
    expect(card.getAttribute("state")).toBe("idle");
  });

  it("exposes determinate and indeterminate progress through progressbar semantics", async () => {
    const card = await mount("nt-status-card", (el) => {
      el.state = "translating";
      el.progress = 0.314;
      el.progressLabel = "Translation progress";
    });
    const bar = shadow(card).querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("31");
    expect(bar?.getAttribute("aria-label")).toBe("Translation progress");

    card.progress = null;
    await card.updateComplete;
    expect(bar?.hasAttribute("aria-valuenow")).toBe(false);

    card.state = "ready";
    await card.updateComplete;
    expect(shadow(card).querySelector('[role="progressbar"]')).toBeNull();
  });

  it("is a polite live region unless quiet", async () => {
    const card: NtStatusCard = await mount("nt-status-card", (el) => {
      el.heading = "Translated 120 blocks";
    });
    const heading = shadow(card).querySelector(".heading");
    expect(heading?.getAttribute("aria-live")).toBe("polite");
    expect(heading?.textContent).toContain("Translated 120 blocks");
    card.quiet = true;
    await card.updateComplete;
    expect(heading?.hasAttribute("aria-live")).toBe(false);
  });

  it("only shows the action row when an action is slotted", async () => {
    const card = await mount("nt-status-card");
    const row = shadow(card).querySelector<HTMLElement>(".actions");
    expect(row?.hidden).toBe(true);
    const action = document.createElement("nt-button");
    action.slot = "actions";
    action.textContent = "Retry 8";
    card.append(action);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await card.updateComplete;
    expect(row?.hidden).toBe(false);
  });
});

describe("nt-fab", () => {
  it.each([
    ["ready", "solid"],
    ["partial", "dashed"],
    ["error", "dotted"],
    ["cancelled", "dashdot"],
    ["idle", "none"],
    ["disabled", "none"],
    ["translating", "progress"],
    ["scanning", "progress"],
  ] as const)("state %s draws a %s ring", async (state, ring) => {
    const fab = await mount("nt-fab", (el) => {
      el.state = state;
      el.label = "NoriTrans";
    });
    expect(fab.getAttribute("data-ring")).toBe(ring);
    expect(fabRingKind(state)).toBe(ring);
    const arc = shadow(fab).querySelector(".dial .arc");
    expect(arc === null).toBe(ring === "none");
    expect(shadow(fab).querySelector(".badge")).toBeNull();
    expect(
      shadow(fab).querySelector("button")?.getAttribute("aria-label"),
    ).toBe("NoriTrans");
  });

  it("gives every finished state a distinct stroke pattern", async () => {
    const patterns = new Set<string>();
    for (const state of ["ready", "partial", "error", "cancelled"] as const) {
      const fab = await mount("nt-fab", (el) => {
        el.state = state;
      });
      const arc = shadow(fab).querySelector(".dial .arc");
      patterns.add(
        `${arc?.getAttribute("stroke-dasharray") ?? "solid"}|${arc?.getAttribute("stroke-linecap")}`,
      );
    }
    expect(patterns.size).toBe(4);
  });

  it("draws a progress arc while busy, indeterminate without progress", async () => {
    const fab = await mount("nt-fab", (el) => {
      el.state = "translating";
      el.progress = 0.5;
    });
    const arc = () => shadow(fab).querySelector(".dial .arc");
    expect(arc()?.getAttribute("stroke-dasharray")).toBe("60 120");
    expect(shadow(fab).querySelector(".dial .track")).not.toBeNull();
    fab.progress = null;
    await fab.updateComplete;
    expect(arc()?.classList.contains("indet")).toBe(true);
    fab.state = "ready";
    await fab.updateComplete;
    expect(shadow(fab).querySelector(".dial .track")).toBeNull();
    expect(arc()?.hasAttribute("stroke-dasharray")).toBe(false);
  });

  it("draws only the visible half while tucked into an edge", async () => {
    const fab = await mount("nt-fab", (el) => {
      el.state = "translating";
      el.progress = 0.3;
      el.edge = "left";
    });
    const arc = () => shadow(fab).querySelector(".dial .arc");
    expect(fab.getAttribute("edge")).toBe("left");
    expect(arc()?.getAttribute("pathLength")).toBe("60");
    expect(arc()?.getAttribute("d")).toBe(fabArcPath("left").d);
    expect(arc()?.getAttribute("stroke-dasharray")).toBe("18 60");
    fab.edge = "middle" as never;
    await fab.updateComplete;
    expect(fab.edge).toBeUndefined();
    expect(fab.hasAttribute("edge")).toBe(false);
    expect(arc()?.getAttribute("pathLength")).toBe("120");
  });
});

describe("fab arc geometry", () => {
  it("runs the full circle clockwise from the top", () => {
    expect(fabArcPath(undefined, 24, 21)).toEqual({
      d: "M 24 3 A 21 21 0 0 1 24 45 A 21 21 0 0 1 24 3",
      length: 120,
    });
  });

  it.each([
    // Left edge: right half visible, top to bottom clockwise.
    ["left", "M 24 3 A 21 21 0 0 1 24 45"],
    // Right edge: left half visible, top to bottom anticlockwise.
    ["right", "M 24 3 A 21 21 0 0 0 24 45"],
    // Top edge: bottom half visible, left to right through the bottom.
    ["top", "M 3 24 A 21 21 0 0 0 45 24"],
    // Bottom edge: top half visible, left to right through the top.
    ["bottom", "M 3 24 A 21 21 0 0 1 45 24"],
  ] as const)("draws the visible half for the %s edge", (edge, d) => {
    expect(fabArcPath(edge, 24, 21)).toEqual({ d, length: 60 });
  });

  it.each([
    [undefined, 0, "0 120", "butt"],
    [undefined, 0.3, "36 120", "round"],
    [undefined, 0.7, "84 120", "round"],
    [undefined, 1, "120 120", "round"],
    ["left", 0, "0 60", "butt"],
    ["right", 0.3, "18 60", "round"],
    ["top", 0.7, "42 60", "round"],
    ["bottom", 1, "60 60", "round"],
  ] as const)(
    "maps progress onto the visible arc (edge %s, %s)",
    (edge, progress, dasharray, linecap) => {
      expect(fabArcSpec("progress", edge, progress)).toMatchObject({
        dasharray,
        linecap,
        indeterminate: false,
      });
    },
  );

  it("keeps patterns whole on a half arc and travels when indeterminate", () => {
    for (const kind of ["dashed", "dotted", "dashdot"] as const) {
      const spec = fabArcSpec(kind, "right", null)!;
      const period = spec
        .dasharray!.split(" ")
        .reduce((sum, part) => sum + Number(part), 0);
      expect(spec.length % period).toBe(0);
    }
    expect(fabArcSpec("solid", "top", null)?.dasharray).toBeNull();
    expect(fabArcSpec("dotted", undefined, null)?.linecap).toBe("round");
    expect(fabArcSpec("none", "left", 0.5)).toBeNull();
    expect(fabArcSpec("progress", "left", null)).toMatchObject({
      dasharray: "15 165",
      indeterminate: true,
    });
  });
});

describe("nt-fab accessibility", () => {
  it("marks the button busy only while a task is running", async () => {
    const fab = await mount("nt-pill-fab", (el) => {
      el.state = "translating";
    });
    const button = () => shadow(fab).querySelector("button")!;
    expect(button().getAttribute("aria-busy")).toBe("true");
    fab.state = "ready";
    await fab.updateComplete;
    expect(button().hasAttribute("aria-busy")).toBe(false);
  });

  it("points aria-controls at a panel in the host's tree while set", async () => {
    const panel = document.createElement("section");
    panel.id = "nt-test-panel";
    document.body.append(panel);
    const fab = await mount("nt-fab", (el) => {
      el.expanded = "true";
      el.controls = "nt-test-panel";
    });
    const button = () => shadow(fab).querySelector("button")!;
    const reflected = (): Element | undefined =>
      (
        button() as HTMLButtonElement & {
          ariaControlsElements?: Element[] | null;
        }
      ).ariaControlsElements?.[0];
    // Engines with ARIA element reflection expose the target; others get the
    // attribute (jsdom lacks the reflection API).
    expect(
      reflected() === panel ||
        button().getAttribute("aria-controls") === "nt-test-panel",
    ).toBe(true);
    fab.controls = "";
    await fab.updateComplete;
    expect(button().hasAttribute("aria-controls")).toBe(false);
    expect(reflected()).toBeUndefined();
  });
});

describe("nt-pill-fab announcement", () => {
  async function pill(setup?: (el: NtPillFab) => void): Promise<NtPillFab> {
    vi.useFakeTimers();
    return mount("nt-pill-fab", (el) => {
      el.label = "NoriTrans";
      el.state = "translating";
      setup?.(el);
    });
  }

  it("does not announce the initial state", async () => {
    const fab = await pill((el) => {
      el.message = "Translating";
    });
    expect(fab.announcing).toBe(false);
  });

  it("stretches on a state change and collapses after the duration", async () => {
    const fab = await pill();
    const ended = vi.fn();
    fab.addEventListener("nt-announce-end", ended);
    fab.state = "ready";
    fab.message = "Translated 120 blocks";
    await fab.updateComplete;
    expect(fab.announcing).toBe(true);
    expect(shadow(fab).querySelector(".msg-text")?.textContent).toBe(
      "Translated 120 blocks",
    );
    expect(shadow(fab).querySelector('[role="status"]')?.textContent).toBe(
      "Translated 120 blocks",
    );
    vi.advanceTimersByTime(2999);
    expect(fab.announcing).toBe(true);
    vi.advanceTimersByTime(1);
    await fab.updateComplete;
    expect(fab.announcing).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("keeps partial/error expanded until activated", async () => {
    const fab = await pill();
    fab.state = "partial";
    fab.message = "8 blocks failed";
    await fab.updateComplete;
    vi.advanceTimersByTime(10_000);
    expect(fab.announcing).toBe(true);
    shadow(fab).querySelector("button")?.click();
    await fab.updateComplete;
    expect(fab.announcing).toBe(false);
  });

  it("silent disables the visual stretch but still updates the live region", async () => {
    const fab = await pill((el) => {
      el.silent = true;
    });
    fab.state = "ready";
    fab.message = "Translated 120 blocks";
    await fab.updateComplete;
    expect(fab.announcing).toBe(false);
    expect(fab.hasAttribute("announcing")).toBe(false);
    expect(shadow(fab).querySelector('[role="status"]')?.textContent).toBe(
      "Translated 120 blocks",
    );
  });

  it("turning silent on collapses an ongoing announcement", async () => {
    const fab = await pill();
    fab.state = "error";
    fab.message = "Can’t translate";
    await fab.updateComplete;
    expect(fab.announcing).toBe(true);
    fab.silent = true;
    await fab.updateComplete;
    expect(fab.announcing).toBe(false);
  });
});

describe("nt-button", () => {
  it("swallows activation while busy and exposes busy/disabled state", async () => {
    const button: NtButton = await mount("nt-button", (el) => {
      el.textContent = "Stopping…";
      el.busy = true;
    });
    const onClick = vi.fn();
    button.addEventListener("click", onClick);
    const inner = shadow(button).querySelector("button");
    inner?.click();
    expect(onClick).not.toHaveBeenCalled();
    expect(inner?.getAttribute("aria-busy")).toBe("true");
    expect(inner?.getAttribute("aria-disabled")).toBe("true");

    button.busy = false;
    await button.updateComplete;
    inner?.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("nt-tabs", () => {
  async function tabs(): Promise<NtTabs> {
    return mount("nt-tabs", (el) => {
      el.label = "Sections";
      el.tabs = [
        {
          id: "page",
          label: "Page",
          indicator: "run",
          indicatorLabel: "translating",
        },
        { id: "video", label: "Video" },
        { id: "more", label: "More" },
      ];
      el.selected = "page";
      el.innerHTML =
        '<p slot="page">Page panel</p><p slot="video">Video panel</p>';
    });
  }

  function tabButtons(el: NtTabs): HTMLElement[] {
    return Array.from(shadow(el).querySelectorAll<HTMLElement>('[role="tab"]'));
  }

  it("uses a roving tabindex and links the tab to its panel", async () => {
    const el = await tabs();
    const [first, second] = tabButtons(el);
    expect(first?.getAttribute("tabindex")).toBe("0");
    expect(second?.getAttribute("tabindex")).toBe("-1");
    const panel = shadow(el).querySelector('[role="tabpanel"]');
    expect(panel?.getAttribute("aria-labelledby")).toBe(first?.id);
    expect(first?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(shadow(el).querySelector("slot")?.name).toBe("page");
  });

  it("moves and selects with arrow keys (wrapping), Home and End", async () => {
    const el = await tabs();
    const changes: string[] = [];
    el.addEventListener("nt-change", (event) => {
      changes.push((event as CustomEvent<{ id: string }>).detail.id);
    });
    key(tabButtons(el)[0]!, "ArrowRight");
    await el.updateComplete;
    expect(el.selected).toBe("video");
    key(tabButtons(el)[1]!, "End");
    await el.updateComplete;
    expect(el.selected).toBe("more");
    key(tabButtons(el)[2]!, "ArrowRight");
    await el.updateComplete;
    expect(el.selected).toBe("page");
    key(tabButtons(el)[0]!, "ArrowLeft");
    await el.updateComplete;
    expect(el.selected).toBe("more");
    key(tabButtons(el)[2]!, "Home");
    await el.updateComplete;
    await el.updateComplete;
    expect(changes).toEqual(["video", "more", "page", "more", "page"]);
    expect(shadow(el).activeElement).toBe(tabButtons(el)[0]);
  });

  it("lets the host veto a selection by cancelling nt-change", async () => {
    const el = await tabs();
    el.addEventListener("nt-change", (event) => event.preventDefault());
    tabButtons(el)[1]?.click();
    await el.updateComplete;
    expect(el.selected).toBe("page");
  });
});

describe("nt-segmented", () => {
  it("behaves as a radio group with arrow keys and skips disabled options", async () => {
    const el: NtSegmented = await mount("nt-segmented", (seg) => {
      seg.label = "Display";
      seg.options = [
        { value: "bilingual", label: "Bilingual" },
        { value: "original", label: "Original", disabled: true },
        { value: "translation", label: "Translation only" },
      ];
      seg.value = "bilingual";
    });
    const values: string[] = [];
    el.addEventListener("change", (event) => {
      values.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    const radios = shadow(el).querySelectorAll<HTMLElement>('[role="radio"]');
    expect(
      shadow(el)
        .querySelector('[role="radiogroup"]')
        ?.getAttribute("aria-label"),
    ).toBe("Display");
    key(radios[0]!, "ArrowRight");
    await el.updateComplete;
    expect(el.value).toBe("translation");
    expect(radios[2]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[2]?.getAttribute("tabindex")).toBe("0");
    expect(radios[0]?.getAttribute("tabindex")).toBe("-1");
    radios[1]?.click();
    await el.updateComplete;
    expect(el.value).toBe("translation");
    expect(values).toEqual(["translation"]);
  });
});

describe("nt-switch", () => {
  it("toggles aria-checked and emits change; nt-before-change can veto", async () => {
    const el: NtSwitch = await mount("nt-switch", (sw) => {
      sw.label = "Auto-translate";
    });
    const button = shadow(el).querySelector('[role="switch"]') as HTMLElement;
    const changes: boolean[] = [];
    el.addEventListener("change", (event) => {
      changes.push((event as CustomEvent<{ checked: boolean }>).detail.checked);
    });
    button.click();
    await el.updateComplete;
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(changes).toEqual([true]);
    const labelledBy = button.getAttribute("aria-labelledby") ?? "";
    expect(shadow(el).getElementById(labelledBy)?.textContent).toBe(
      "Auto-translate",
    );

    el.addEventListener("nt-before-change", (event) => event.preventDefault());
    button.click();
    await el.updateComplete;
    expect(el.checked).toBe(true);
    expect(changes).toEqual([true]);
  });
});

describe("nt-stepper", () => {
  const setup = (el: NtStepper) => {
    el.label = "Font size";
    el.min = 0.75;
    el.max = 1.8;
    el.step = 0.05;
    el.scale = 100;
    el.unit = "%";
    el.value = 1.2;
    el.decrementLabel = "Smaller";
    el.incrementLabel = "Larger";
  };
  const record = (el: NtStepper) => {
    const inputs: number[] = [];
    const changes: number[] = [];
    el.addEventListener("nt-input", (event) => {
      inputs.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    el.addEventListener("change", (event) => {
      changes.push((event as CustomEvent<{ value: number }>).detail.value);
    });
    return { inputs, changes };
  };
  const pointer = (target: Element, type: string, pointerId = 1) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    target.dispatchEvent(event);
  };

  it("exposes spinbutton semantics with a formatted value and labelled buttons", async () => {
    const el: NtStepper = await mount("nt-stepper", setup);
    const spin = shadow(el).querySelector('[role="spinbutton"]')!;
    expect(spin.getAttribute("tabindex")).toBe("0");
    expect(spin.getAttribute("aria-valuenow")).toBe("1.2");
    expect(spin.getAttribute("aria-valuemin")).toBe("0.75");
    expect(spin.getAttribute("aria-valuemax")).toBe("1.8");
    expect(spin.getAttribute("aria-valuetext")).toBe("120%");
    expect(spin.textContent?.trim()).toBe("120%");
    const labelledBy = spin.getAttribute("aria-labelledby") ?? "";
    expect(shadow(el).getElementById(labelledBy)?.textContent).toBe(
      "Font size",
    );
    const buttons = shadow(el).querySelectorAll("button");
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Smaller");
    expect(buttons[1]?.getAttribute("aria-label")).toBe("Larger");
    expect(buttons[0]?.getAttribute("tabindex")).toBe("-1");
    el.format = (value) => `${value}x`;
    await el.updateComplete;
    expect(spin.getAttribute("aria-valuetext")).toBe("1.2x");
  });

  it("steps with arrow keys, jumps with Home/End and commits once after idle", async () => {
    vi.useFakeTimers();
    const el: NtStepper = await mount("nt-stepper", setup);
    const { inputs, changes } = record(el);
    const spin = shadow(el).querySelector('[role="spinbutton"]')!;
    key(spin, "ArrowUp");
    key(spin, "ArrowUp");
    key(spin, "ArrowDown");
    await el.updateComplete;
    expect(inputs).toEqual([1.25, 1.3, 1.25]);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([1.25]);
    key(spin, "End");
    key(spin, "ArrowUp");
    key(spin, "Enter");
    expect(el.value).toBe(1.8);
    expect(changes).toEqual([1.25, 1.8]);
    key(spin, "Home");
    key(spin, "PageUp");
    vi.advanceTimersByTime(1000);
    expect(el.value).toBe(1);
    expect(changes).toEqual([1.25, 1.8, 1]);
  });

  it("does not report a change when an interaction returns to its start", async () => {
    vi.useFakeTimers();
    const el: NtStepper = await mount("nt-stepper", setup);
    const { inputs, changes } = record(el);
    const spin = shadow(el).querySelector('[role="spinbutton"]')!;
    key(spin, "ArrowUp");
    key(spin, "ArrowDown");
    vi.advanceTimersByTime(1000);
    expect(inputs).toEqual([1.25, 1.2]);
    expect(changes).toEqual([]);
  });

  it("repeats while a button is held and commits on release, stopping at the bound", async () => {
    vi.useFakeTimers();
    const el: NtStepper = await mount("nt-stepper", (s) => {
      setup(s);
      s.value = 1.6;
    });
    const { inputs, changes } = record(el);
    const plus = shadow(el).querySelectorAll("button")[1]!;
    pointer(plus, "pointerdown");
    expect(inputs).toEqual([1.65]);
    vi.advanceTimersByTime(399);
    expect(inputs).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(el.value).toBe(1.8);
    expect(inputs).toEqual([1.65, 1.7, 1.75, 1.8]);
    // The bound ends the hold at once: a disabled button may miss pointerup.
    expect(changes).toEqual([1.8]);
    pointer(plus, "pointerup");
    expect(changes).toEqual([1.8]);
    await el.updateComplete;
    expect(plus.disabled).toBe(true);

    const minus = shadow(el).querySelectorAll("button")[0]!;
    pointer(minus, "pointerdown", 2);
    vi.advanceTimersByTime(500);
    pointer(minus, "pointerup", 2);
    expect(inputs.slice(4)).toEqual([1.75, 1.7, 1.65]);
    expect(changes).toEqual([1.8, 1.65]);
  });

  it("settles quick pointer clicks into one change", async () => {
    vi.useFakeTimers();
    const el: NtStepper = await mount("nt-stepper", setup);
    const { inputs, changes } = record(el);
    const plus = shadow(el).querySelectorAll("button")[1]!;
    for (const id of [1, 2, 3]) {
      pointer(plus, "pointerdown", id);
      pointer(plus, "pointerup", id);
      vi.advanceTimersByTime(150);
    }
    expect(inputs).toEqual([1.25, 1.3, 1.35]);
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([1.35]);
  });

  it("steps once per programmatic click and ignores input while disabled", async () => {
    vi.useFakeTimers();
    const el: NtStepper = await mount("nt-stepper", setup);
    const { changes } = record(el);
    const minus = shadow(el).querySelectorAll("button")[0]!;
    minus.click();
    minus.click();
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([1.1]);
    el.disabled = true;
    await el.updateComplete;
    const spin = shadow(el).querySelector('[role="spinbutton"]')!;
    expect(spin.getAttribute("aria-disabled")).toBe("true");
    expect(spin.getAttribute("tabindex")).toBe("-1");
    key(spin, "ArrowUp");
    vi.advanceTimersByTime(1000);
    expect(el.value).toBe(1.1);
  });

  it("flushes a pending change when focus leaves", async () => {
    vi.useFakeTimers();
    const el: NtStepper = await mount("nt-stepper", setup);
    const { changes } = record(el);
    const spin = shadow(el).querySelector('[role="spinbutton"]')!;
    key(spin, "ArrowDown");
    spin.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(changes).toEqual([1.15]);
  });
});

describe("nt-select", () => {
  it("labels the native select and re-emits change with the value", async () => {
    const el = await mount("nt-select", (select) => {
      select.label = "Target language";
      select.options = [
        { value: "en", label: "English" },
        { value: "zh-CN", label: "Chinese (Simplified)" },
      ];
      select.value = "en";
    });
    const native = shadow(el).querySelector("select") as HTMLSelectElement;
    const label = shadow(el).querySelector("label");
    expect(label?.htmlFor).toBe(native.id);
    const values: string[] = [];
    el.addEventListener("change", (event) => {
      values.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    native.value = "zh-CN";
    native.dispatchEvent(new Event("change", { bubbles: true }));
    expect(values).toEqual(["zh-CN"]);
    expect(el.value).toBe("zh-CN");
  });
});

describe("nt-menu", () => {
  async function menu(): Promise<{ el: NtMenu; trigger: HTMLButtonElement }> {
    const trigger = document.createElement("button");
    trigger.textContent = "More";
    document.body.append(trigger);
    trigger.focus();
    const el = await mount("nt-menu", (m) => {
      m.label = "More actions";
      m.anchor = trigger;
      m.items = [
        { id: "hide-site", label: "Hide on this site", icon: "eye-off" },
        { id: "disabled", label: "Unavailable", disabled: true },
        {
          id: "hide-all",
          label: "Hide everywhere…",
          icon: "power",
          separatorBefore: true,
        },
      ];
      m.open = true;
    });
    return { el, trigger };
  }

  function items(el: NtMenu): HTMLElement[] {
    return Array.from(
      shadow(el).querySelectorAll<HTMLElement>('[role="menuitem"]'),
    );
  }

  it("focuses the first item and cycles enabled items with arrow keys", async () => {
    const { el } = await menu();
    const [first, , last] = items(el);
    expect(shadow(el).activeElement).toBe(first);
    key(first!, "ArrowDown");
    expect(shadow(el).activeElement).toBe(last);
    key(last!, "ArrowDown");
    expect(shadow(el).activeElement).toBe(first);
    key(first!, "ArrowUp");
    expect(shadow(el).activeElement).toBe(last);
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const { el, trigger } = await menu();
    const reasons: string[] = [];
    el.addEventListener("nt-close", (event) => {
      reasons.push((event as CustomEvent<{ reason: string }>).detail.reason);
    });
    key(items(el)[0]!, "Escape");
    await el.updateComplete;
    expect(el.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
    expect(reasons).toEqual(["escape"]);
  });

  it("emits nt-select then closes; ignores disabled items", async () => {
    const { el } = await menu();
    const selected: string[] = [];
    el.addEventListener("nt-select", (event) => {
      selected.push((event as CustomEvent<{ id: string }>).detail.id);
    });
    items(el)[1]?.click();
    expect(el.open).toBe(true);
    items(el)[2]?.click();
    expect(selected).toEqual(["hide-all"]);
    expect(el.open).toBe(false);
  });

  it("closes on an outside press but not on its anchor", async () => {
    const { el, trigger } = await menu();
    trigger.dispatchEvent(
      new Event("pointerdown", { bubbles: true, composed: true }),
    );
    expect(el.open).toBe(true);
    document.body.dispatchEvent(
      new Event("pointerdown", { bubbles: true, composed: true }),
    );
    expect(el.open).toBe(false);
  });
});
