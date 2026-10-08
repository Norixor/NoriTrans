import { NT_THEME_WRAPPER_CSS } from "@/src/ui/tokens/tokens";

/*
 * Subtitle overlay stylesheet (direction B "Prism").
 *
 * Tokens are declared on the `.nt-theme` wrapper inside the shadow root, never
 * on `:host`, because page rules can override custom properties declared on
 * the host element (see src/ui/tokens/tokens.ts). The wrapper is pinned to the
 * dark palette: the layer always sits on video, so status colours must read
 * on a dark translucent surface regardless of the page's colour scheme.
 *
 * `--noritrans-*` properties are geometry/user settings written by the
 * overlay itself on the host (anchor, max width, font scale, background
 * opacity); they are inputs, not design tokens.
 */
const OVERLAY_CSS = `
  :host {
    all: initial;
    position: fixed !important;
    z-index: 2147483646 !important;
    inset: 0 !important;
    display: block !important;
    width: auto !important;
    height: auto !important;
    min-width: 0 !important;
    min-height: 0 !important;
    max-width: none !important;
    max-height: none !important;
    overflow: visible !important;
    contain: none !important;
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
    pointer-events: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    opacity: 1 !important;
  }
  /* Page rules can give the host generated boxes; inner important wins. */
  :host::before,
  :host::after {
    content: none !important;
    display: none !important;
  }
  :host([hidden]) { display: none !important; }
  :host([data-dragging="true"]) { pointer-events: auto !important; }
  .overlay {
    position: fixed;
    z-index: 2147483646;
    left: var(--noritrans-anchor-x, 50vw);
    top: var(--noritrans-anchor-y, 82vh);
    transform: translate(-50%, -100%);
    width: var(--noritrans-max-width, 80vw);
    max-width: var(--noritrans-max-width, 80vw);
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    justify-items: center;
    gap: var(--nt-space-2);
    pointer-events: none;
    font-family: var(--nt-font);
    text-align: center;
  }
  :host([data-position="top"]) .overlay {
    transform: translate(-50%, 0);
  }
  :host([data-position="center"]) .overlay {
    transform: translate(-50%, -50%);
  }
  :host([data-position="custom"]) .overlay {
    transform: translate(-50%, -50%);
  }
  :host([data-ocr-safe-side="above"]) .overlay {
    transform: translate(-50%, -100%);
  }
  :host([data-ocr-safe-side="below"]) .overlay {
    transform: translate(-50%, 0);
  }
  .ocr-region-guide {
    position: fixed;
    left: var(--noritrans-ocr-left, 0);
    top: var(--noritrans-ocr-top, 0);
    width: var(--noritrans-ocr-width, 0);
    height: var(--noritrans-ocr-height, 0);
    box-sizing: border-box;
    display: none;
    border: 2px dashed var(--nt-accent);
    border-radius: var(--nt-space-1);
    background: color-mix(in srgb, var(--nt-accent) 10%, transparent);
    box-shadow: 0 0 0 1px rgb(255 255 255 / 55%) inset;
    pointer-events: none;
  }
  :host([data-dragging="true"][data-has-ocr-region="true"]) .ocr-region-guide {
    display: block;
  }
  .cue-card {
    width: max-content;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    padding: var(--nt-space-3) var(--nt-space-5);
    border-radius: var(--nt-r-ctl);
    /* --nt-sub-bg hue with the user's background opacity. */
    background: rgb(12 10 26 / var(--noritrans-opacity, 0.74));
    -webkit-backdrop-filter: blur(calc(var(--noritrans-opacity, 0.74) * 8px));
    backdrop-filter: blur(calc(var(--noritrans-opacity, 0.74) * 8px));
    color: var(--nt-sub-fg);
    box-shadow: 0 1px 3px rgb(0 0 0 / 35%);
    /* Keeps text legible when the user turns the background off. */
    text-shadow: 0 1px 2px rgb(0 0 0 / 60%);
    font-size: calc(18px * var(--noritrans-scale, 1));
    line-height: 1.35;
    max-height: min(45vh, 320px);
    overflow: hidden;
    overflow-wrap: anywhere;
    pointer-events: auto;
    cursor: grab;
    touch-action: none;
    user-select: none;
    white-space: pre-wrap;
  }
  .cue-card:active,
  .cue-card[data-dragging="true"] { cursor: grabbing; }
  .cue-card[data-saving="true"] { cursor: wait; }
  .cue-card:focus-visible {
    outline: var(--nt-focus-width) solid var(--nt-focus);
    outline-offset: 2px;
  }
  .cue {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    color: inherit;
    font: inherit;
    line-height: inherit;
    white-space: nowrap;
    overflow-wrap: normal;
    word-break: normal;
    hyphens: none;
  }
  .cue-text { display: inline-block; width: max-content; min-width: 100%; }
  @media (prefers-reduced-motion: reduce) {
    .cue[data-overflow="true"] { overflow-x: auto; touch-action: pan-x; }
  }
  .cue + .cue:not([hidden]) { margin-top: 2px; }
  /* Translation leads; the source line is the quieter companion. */
  .translated { font-weight: 700; }
  .original { font-weight: 400; }
  .cue-card[data-layout="bilingual"] .original {
    font-size: 0.74em;
    color: rgb(255 255 255 / 82%);
  }
  .cue-card[data-layout="original"] .original { font-weight: 500; }
  .tag {
    display: inline-flex;
    align-items: center;
    gap: var(--nt-space-2);
    max-width: min(520px, 100%);
    box-sizing: border-box;
    padding: var(--nt-space-1) 10px;
    border-radius: var(--nt-r-pill);
    background: rgb(12 10 26 / 72%);
    color: #fff;
    box-shadow: 0 1px 3px rgb(0 0 0 / 35%);
    font: 600 var(--nt-fs-xs)/1.35 var(--nt-font);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .tag > svg, .notice > svg {
    flex: none;
    width: 14px;
    height: 14px;
  }
  .tag[data-kind="live"] > svg { color: var(--nt-s-warn); }
  .tag[data-kind="pending"] > svg { color: var(--nt-s-progress); }
  @media (prefers-reduced-motion: no-preference) {
    .tag[data-kind="pending"] > svg {
      animation: nt-subtitle-spin 900ms linear infinite;
    }
    @keyframes nt-subtitle-spin { to { transform: rotate(360deg); } }
  }
  .status {
    display: none;
  }
  .status[data-visible="true"] {
    display: block;
    max-width: min(520px, 80vw);
    padding: var(--nt-space-1) 10px;
    border-radius: var(--nt-r-ctl);
    background: rgb(12 10 26 / 86%);
    border: 1px solid var(--nt-s-err);
    color: #fff;
    font: 600 var(--nt-fs-sm)/1.4 var(--nt-font);
    text-align: center;
  }
  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--nt-space-3);
    max-width: min(520px, 80vw);
    box-sizing: border-box;
    padding: var(--nt-space-3) 14px;
    border: 1px solid color-mix(in srgb, var(--nt-s-err) 60%, transparent);
    border-radius: var(--nt-r-card);
    background: rgb(12 10 26 / 90%);
    color: #fff;
    box-shadow: 0 4px 18px rgb(0 0 0 / 38%);
    font: 600 var(--nt-fs-body)/1.45 var(--nt-font);
    overflow-wrap: anywhere;
    pointer-events: auto;
    text-align: start;
  }
  .notice > svg { width: 16px; height: 16px; margin-top: 2px; color: var(--nt-s-err); }
  .notice-text { min-width: 0; }
  .overlay[hidden], .cue-card[hidden], .original[hidden], .translated[hidden], .notice[hidden], .tag[hidden] { display: none; }
  @media (max-width: 600px) {
    .cue-card {
      font-size: calc(16px * var(--noritrans-scale, 1));
      padding: 6px 10px;
      border-radius: var(--nt-space-3);
    }
  }
  @media (forced-colors: active) {
    .cue-card, .tag, .notice, .status[data-visible="true"] {
      border: 1px solid CanvasText;
      background: Canvas;
      color: CanvasText;
      text-shadow: none;
    }
    .tag > svg, .notice > svg { color: CanvasText; }
  }
  @media (prefers-reduced-motion: reduce) { .overlay { scroll-behavior: auto; } }
`;

export const SUBTITLE_OVERLAY_STYLE = `${NT_THEME_WRAPPER_CSS}\n${OVERLAY_CSS}`;
