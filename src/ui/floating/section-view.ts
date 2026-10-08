import { message } from "@/src/shared/i18n";
import { icon } from "@/src/ui/components/icons";
import { html, type TemplateResult } from "lit";

/** Text resolved at render: an i18n key, or text already localized. */
export type ViewText =
  { key: string; substitutions?: readonly string[] } | { raw: string };

/** Resolves a section view text through the Chrome i18n catalog. */
export function viewText(text: ViewText): string {
  return "raw" in text
    ? text.raw
    : message(text.key, [...(text.substitutions ?? [])]);
}

export interface SectionHeadOptions {
  /** Id of the body element the header controls. */
  id: string;
  title: string;
  /** Short state word; also part of the button's accessible name. */
  state: string;
  /** Machine-readable state for styling and tests. */
  phase: string;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Disclosure header shared by the image recognition and image translation
 * blocks: a full-width button with the title, a state word and a chevron.
 * State is spelled out, never shown by color alone.
 */
export function renderSectionHead(options: SectionHeadOptions): TemplateResult {
  return html`<button
    type="button"
    class="sec-head"
    data-phase=${options.phase}
    aria-expanded=${String(options.expanded)}
    aria-controls=${options.id}
    @click=${options.onToggle}
  >
    <span class="sec-title">${options.title}</span>
    <span class="sec-state">${options.state}</span>
    <span class="sec-chev" aria-hidden="true">${icon("chevron")}</span>
  </button>`;
}
