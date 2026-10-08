import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  defineNtComponents,
  type NtSlider,
  type NtTextField,
} from "@/src/ui/components";

beforeAll(() => {
  defineNtComponents();
});

afterEach(() => {
  document.body.replaceChildren();
});

async function mount<K extends "nt-text-field" | "nt-slider">(
  tag: K,
  setup: (element: HTMLElementTagNameMap[K]) => void,
): Promise<HTMLElementTagNameMap[K]> {
  const element = document.createElement(tag);
  setup(element);
  document.body.append(element);
  await element.updateComplete;
  return element;
}

function collect(target: EventTarget, type: string): unknown[] {
  const details: unknown[] = [];
  target.addEventListener(type, (event) => {
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(false);
    details.push((event as CustomEvent).detail);
  });
  return details;
}

describe("nt-text-field", () => {
  it("labels the input and reports edits and commits", async () => {
    const field: NtTextField = await mount("nt-text-field", (element) => {
      element.label = "Model";
      element.value = "a";
      element.description = "Help";
    });
    const input = field.shadowRoot!.querySelector("input")!;
    const label = field.shadowRoot!.querySelector("label")!;
    expect(label.htmlFor).toBe(input.id);
    expect(input.getAttribute("aria-describedby")).toBeTruthy();
    const inputs = collect(field, "nt-input");
    const changes = collect(field, "change");
    input.value = "ab";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(inputs).toEqual([{ value: "ab" }]);
    expect(changes).toEqual([{ value: "ab" }]);
    expect(field.value).toBe("ab");
  });

  it("renders a textarea and an invalid state with its error", async () => {
    const field = await mount("nt-text-field", (element) => {
      element.label = "Prompt";
      element.multiline = true;
      element.invalid = true;
      element.error = "Required";
    });
    const textarea = field.shadowRoot!.querySelector("textarea")!;
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(field.shadowRoot!.querySelector(".desc.err")?.textContent).toContain(
      "Required",
    );
  });

  it("keeps a password value out of attributes", async () => {
    const field = await mount("nt-text-field", (element) => {
      element.label = "Key";
      element.type = "password";
      element.value = "secret";
    });
    const input = field.shadowRoot!.querySelector("input")!;
    expect(input.type).toBe("password");
    expect(input.value).toBe("secret");
    expect(input.getAttribute("value")).toBeNull();
    expect(field.getAttribute("value")).toBeNull();
  });
});

describe("nt-slider", () => {
  it("shows the formatted value and emits input and change", async () => {
    const slider: NtSlider = await mount("nt-slider", (element) => {
      element.label = "Background";
      element.min = 0.3;
      element.max = 0.95;
      element.step = 0.05;
      element.value = 0.5;
      element.format = (value) => `${Math.round(value * 100)}%`;
    });
    const range = slider.shadowRoot!.querySelector("input")!;
    expect(range.getAttribute("aria-valuetext")).toBe("50%");
    const inputs = collect(slider, "nt-input");
    const changes = collect(slider, "change");
    range.value = "0.7";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
    await slider.updateComplete;
    expect(inputs).toEqual([{ value: 0.7 }]);
    expect(changes).toEqual([{ value: 0.7 }]);
    expect(slider.shadowRoot!.querySelector("output")?.textContent).toBe("70%");
  });
});
