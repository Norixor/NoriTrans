export const VIEWPORT_PADDING = 10;
export const LAUNCHER_SIZE = 48;
const LAUNCHER_VISUAL_SIZE = 40;
const EDGE_REVEAL_SIZE = 20;

/** Shadow DOM stylesheet for the unified floating control. */
export const UNIFIED_FLOATING_CONTROL_STYLE = `
  :host {
    all: initial;
    display: block !important;
    position: fixed !important;
    z-index: 2147483647 !important;
    pointer-events: auto !important;
    right: max(16px, env(safe-area-inset-right));
    bottom: max(16px, env(safe-area-inset-bottom));
    color-scheme: light dark;
    width: ${LAUNCHER_SIZE}px !important;
    height: ${LAUNCHER_SIZE}px !important;
    min-width: ${LAUNCHER_SIZE}px !important;
    min-height: ${LAUNCHER_SIZE}px !important;
    max-width: none !important;
    max-height: none !important;
    overflow: visible !important;
    contain: none !important;
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    --nt-bg: #f7f3ed;
    --nt-subtle-bg: #f1ece4;
    --nt-hover-bg: #ece5da;
    --nt-text: #1f1e1b;
    --nt-muted: #716d65;
    --nt-border: #d4cec2;
    --nt-border-muted: #e4ded4;
    --nt-accent: #c48312;
    --nt-accent-hover: #a86908;
    --nt-accent-gradient: #c48312;
    --nt-focus: #bd7b13;
    --nt-danger: #a3483b;
    --nt-success: #587354;
    --nt-warning: #ad710d;
    --nt-primary-bg: #24231f;
    --nt-primary-hover: #11110f;
    --nt-primary-text: #fffdf8;
    --nt-launcher-bg: #f7f3ed;
    --nt-launcher-icon: #1a1a1a;
  }
  :host([data-hidden="true"]) { display: none !important; }
  :host([data-edge-hidden="true"][data-docked-edge="left"]) { transform: translateX(-${LAUNCHER_SIZE + VIEWPORT_PADDING - EDGE_REVEAL_SIZE}px) !important; }
  :host([data-edge-hidden="true"][data-docked-edge="right"]) { transform: translateX(${LAUNCHER_SIZE + VIEWPORT_PADDING - EDGE_REVEAL_SIZE}px) !important; }
  :host([data-edge-hidden="true"][data-docked-edge="top"]) { transform: translateY(-${LAUNCHER_SIZE + VIEWPORT_PADDING - EDGE_REVEAL_SIZE}px) !important; }
  :host([data-edge-hidden="true"][data-docked-edge="bottom"]) { transform: translateY(${LAUNCHER_SIZE + VIEWPORT_PADDING - EDGE_REVEAL_SIZE}px) !important; }
  :host([data-edge-hidden="true"]:focus-within) { transform: translate(0) !important; }
  @media (prefers-color-scheme: dark) {
    :host {
      --nt-bg: #211f1b;
      --nt-subtle-bg: #2a2722;
      --nt-hover-bg: #353129;
      --nt-text: #f5efe5;
      --nt-muted: #b5ad9f;
      --nt-border: #514b42;
      --nt-border-muted: #3d3932;
      --nt-accent: #d49a32;
      --nt-accent-hover: #ebb64f;
      --nt-accent-gradient: #d49a32;
      --nt-focus: #e1aa48;
      --nt-danger: #e3978b;
      --nt-success: #93b18b;
      --nt-warning: #d8a54b;
      --nt-primary-bg: #efe8dc;
      --nt-primary-hover: #fffaf1;
      --nt-primary-text: #211f1b;
      --nt-launcher-bg: #f7f3ed;
      --nt-launcher-icon: #1a1a1a;
    }
  }
  * { box-sizing: border-box; }
  .control {
    position: relative !important;
    isolation: isolate;
    width: ${LAUNCHER_SIZE}px !important;
    height: ${LAUNCHER_SIZE}px !important;
    min-width: ${LAUNCHER_SIZE}px !important;
    min-height: ${LAUNCHER_SIZE}px !important;
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
  }
  .panel {
    position: absolute;
    right: 0;
    bottom: 58px;
    width: min(336px, calc(100vw - 20px));
    min-width: 0;
    max-width: calc(100vw - 20px);
    max-height: calc(100vh - 76px);
    overflow: auto;
    overscroll-behavior: contain;
    padding: 0;
    border: 1px solid var(--nt-border);
    border-radius: 12px;
    background: var(--nt-bg);
    color: var(--nt-text);
    box-shadow: 0 18px 44px rgb(52 45 34 / 18%), 0 3px 10px rgb(52 45 34 / 9%);
    font: 400 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    text-align: start;
    white-space: normal;
    overflow-wrap: normal;
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
  }
  .panel[hidden], .tab-panel[hidden] { display: none; }
  .header, .status-row, .actions, .checkbox { display: flex; align-items: center; }
  .header {
    min-height: 52px;
    justify-content: space-between;
    gap: 12px;
    padding: 0 8px 0 16px;
    border-bottom: 1px solid var(--nt-border-muted);
  }
  .title { min-width: 0; font-size: 15px; font-weight: 720; letter-spacing: -0.01em; overflow-wrap: anywhere; }
  .header-actions { display: flex; align-items: center; }
  .update-banner {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    min-height: 40px;
    align-items: center;
    gap: 8px;
    padding: 5px 12px 5px 16px;
    border-bottom: 1px solid var(--nt-border-muted);
    background: color-mix(in srgb, var(--nt-accent) 10%, var(--nt-bg));
  }
  .update-banner[hidden] { display: none; }
  .update-title {
    min-width: 0;
    overflow: hidden;
    color: var(--nt-text);
    font-size: 11px;
    font-weight: 680;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .update-link, .update-ignore {
    min-width: 0;
    min-height: 28px;
    padding: 0 3px;
    border: 0;
    background: transparent;
    color: var(--nt-accent-hover);
    font: 650 10px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    text-decoration: none;
    white-space: nowrap;
  }
  .update-link { display: inline-flex; align-items: center; }
  .update-ignore { color: var(--nt-muted); }
  .update-link:hover, .update-ignore:hover { background: transparent; text-decoration: underline; }
  .panel-menu { position: relative; }
  .panel-menu > summary {
    display: grid;
    width: 44px;
    height: 44px;
    cursor: pointer;
    list-style: none;
    place-items: center;
  }
  .panel-menu > summary::-webkit-details-marker { display: none; }
  .panel-menu > summary svg { width: 20px; height: 20px; }
  .panel-menu[open] > summary, .panel-menu > summary:hover { border-radius: 10px; background: var(--nt-hover-bg); }
  .panel-menu-popover {
    position: absolute;
    z-index: 2;
    top: 42px;
    right: 0;
    width: 176px;
    padding: 4px;
    border: 1px solid var(--nt-border);
    border-radius: 10px;
    background: var(--nt-bg);
    box-shadow: 0 12px 28px rgb(52 45 34 / 18%);
  }
  .panel-menu-popover button, .panel-menu-popover a {
    display: flex;
    width: 100%;
    min-height: 40px;
    align-items: center;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--nt-text);
    font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    text-decoration: none;
  }
  .panel-menu-popover button:hover, .panel-menu-popover a:hover { background: var(--nt-hover-bg); }
  .tablist {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    padding: 0 12px;
    border-bottom: 1px solid var(--nt-border);
  }
  .tab {
    position: relative;
    min-width: 0;
    min-height: 44px;
    padding: 7px 8px;
    border: 0;
    border-bottom: 0;
    border-radius: 0;
    background: transparent;
    color: var(--nt-muted);
    font-size: 13px;
    font-weight: 650;
  }
  .tab::after {
    position: absolute;
    right: 15%;
    bottom: -1px;
    left: 15%;
    height: 2px;
    border-radius: 999px;
    background: var(--nt-accent);
    content: "";
    opacity: 0;
  }
  .tab[aria-selected="true"] { color: var(--nt-text); }
  .tab[aria-selected="true"]::after { opacity: 1; }
  .tab:hover { background: transparent; color: var(--nt-text); }
  .tab:not([aria-selected="true"]):hover::after { opacity: 0.45; }
  .tab-panel {
    min-width: 0;
    padding: 10px 12px 12px;
  }
  .tab-panel:focus-visible {
    outline: 3px solid var(--nt-focus);
    outline-offset: -3px;
  }
  .status-row {
    min-width: 0;
    min-height: 40px;
    justify-content: space-between;
    gap: 10px;
    padding: 0 3px 10px;
    border-bottom: 1px solid var(--nt-border-muted);
  }
  .status-copy { display: flex; min-width: 0; align-items: center; gap: 10px; }
  .dot { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: #918b81; box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 8%, transparent); }
  .status-row[data-state="scanning"] .dot,
  .status-row[data-state="translating"] .dot,
  .status-row[data-state="waiting"] .dot { background: var(--nt-accent); }
  .status-row[data-state="translated"] .dot,
  .status-row[data-state="ready"] .dot { background: var(--nt-success); }
  .status-row[data-state="partial"] .dot { background: var(--nt-warning); }
  .status-row[data-state="error"] .dot { background: var(--nt-danger); }
  .status-row[data-state="unavailable"] .dot,
  .status-row[data-state="disabled"] .dot { background: #8c959f; }
  .status {
    min-width: 0;
    overflow: hidden;
    font-size: 12.5px;
    font-weight: 680;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .progress { flex: 0 0 auto; color: var(--nt-muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .diagnostic {
    margin: 6px 0 0;
    border: 1px solid var(--nt-border-muted);
    border-radius: 9px;
    background: var(--nt-subtle-bg);
  }
  .diagnostic[hidden] { display: none; }
  .diagnostic summary {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 44px;
    padding: 12px 10px;
    color: var(--nt-text);
    cursor: pointer;
    font-size: 12px;
    font-weight: 650;
  }
  .diagnostic summary::before {
    display: inline-grid;
    width: 18px;
    height: 18px;
    flex: 0 0 18px;
    border: 1px solid var(--nt-danger);
    border-radius: 50%;
    color: var(--nt-danger);
    content: "!";
    font-size: 12px;
    font-weight: 750;
    line-height: 1;
    place-items: center;
  }
  .diagnostic pre {
    max-height: 160px;
    margin: 0;
    overflow: auto;
    padding: 0 10px 10px;
    color: var(--nt-muted);
    font: 11px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }
  .settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: 12px;
    row-gap: 0;
    min-width: 0;
    margin-top: 5px;
  }
  .field {
    display: grid;
    min-width: 0;
    min-height: 58px;
    align-content: center;
    gap: 1px;
    padding: 6px 2px 7px;
    border-bottom: 1px solid var(--nt-border-muted);
  }
  .field > span {
    min-width: 0;
    overflow: visible;
    color: var(--nt-muted);
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.25;
    overflow-wrap: anywhere;
    text-overflow: clip;
    white-space: normal;
  }
  .field-wide { grid-column: 1 / -1; }
  .field-wide > span {
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
  }
  select, .compact-input {
    display: block;
    width: 100%;
    min-width: 0;
    height: 30px;
    min-height: 30px;
    padding: 0 28px 0 0;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--nt-text);
    cursor: pointer;
    font: 650 12.5px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  .compact-input { padding-right: 4px; border-bottom: 1px solid var(--nt-border-muted); }
  .checkbox {
    min-width: 0;
    min-height: 58px;
    gap: 9px;
    color: var(--nt-text);
    cursor: pointer;
    padding: 6px 2px;
    border-bottom: 1px solid var(--nt-border-muted);
    font-size: 12px;
    font-weight: 620;
  }
  .checkbox > span { min-width: 0; overflow-wrap: anywhere; }
  .checkbox input { width: 20px; height: 20px; flex: 0 0 20px; margin: 0; accent-color: var(--nt-accent); }
  .checkbox-copy { display: grid; min-width: 0; gap: 1px; }
  .checkbox-copy small {
    overflow: hidden;
    color: var(--nt-muted);
    font-size: 10px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .settings-grid > .checkbox { align-self: end; }
  .subtitle-appearance {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    border-bottom: 1px solid var(--nt-border-muted);
  }
  .adjustment {
    display: flex;
    min-width: 0;
    min-height: 52px;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    padding: 4px 2px;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .adjustment-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: visible;
    color: var(--nt-muted);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    overflow-wrap: anywhere;
    text-overflow: clip;
    white-space: normal;
  }
  .stepper { display: flex; flex: 0 0 auto; align-items: center; gap: 1px; }
  .stepper button {
    display: grid;
    width: 28px;
    min-width: 28px;
    height: 28px;
    min-height: 28px;
    padding: 0;
    border: 0;
    background: transparent;
    font-size: 17px;
    line-height: 1;
    place-items: center;
  }
  .stepper output {
    width: 38px;
    color: var(--nt-text);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
    text-align: center;
  }
  .actions { gap: 8px; margin-top: 10px; }
  .actions button { flex: 1 1 0; min-width: 0; }
  .subtitle-actions {
    padding-bottom: 8px;
    border-bottom: 1px solid var(--nt-border-muted);
  }
  .profile-action { width: 100%; margin-top: 8px; }
  .ocr-section { margin: 10px -12px -12px; padding: 8px 12px 12px; border-top: 1px solid var(--nt-border); }
  .ocr-section > summary { min-height: 36px; cursor: pointer; color: var(--nt-text); }
  .ocr-section > summary .status-row { display: inline-flex; width: calc(100% - 18px); padding: 0; border: 0; vertical-align: middle; }
  .ocr-controls { padding-top: 4px; border-top: 1px solid var(--nt-border-muted); }
  .ocr-controls .checkbox { margin-top: 2px; }
  button {
    min-width: 44px;
    min-height: 44px;
    padding: 0 10px;
    border: 1px solid var(--nt-border);
    border-radius: 8px;
    background: var(--nt-subtle-bg);
    color: var(--nt-text);
    cursor: pointer;
    font: 600 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  button:hover { background: var(--nt-hover-bg); }
  button.primary { border-color: var(--nt-primary-bg); background: var(--nt-primary-bg); color: var(--nt-primary-text); }
  button.primary:hover { border-color: var(--nt-primary-hover); background: var(--nt-primary-hover); }
  .actions .primary:disabled + button:not(:disabled) {
    border-color: var(--nt-primary-bg);
    background: var(--nt-primary-bg);
    color: var(--nt-primary-text);
  }
  .actions .primary:disabled + button:not(:disabled):hover {
    border-color: var(--nt-primary-hover);
    background: var(--nt-primary-hover);
  }
  button:disabled { cursor: not-allowed; opacity: 0.55; }
  button:focus-visible, select:focus-visible, .checkbox input:focus-visible,
  .panel-menu > summary:focus-visible, .panel-menu-popover a:focus-visible {
    outline: 3px solid var(--nt-focus);
    outline-offset: 2px;
  }
  .icon-button { display: grid; width: 44px; padding: 0; place-items: center; }
  .header-actions > .icon-button {
    border-color: transparent;
    background: transparent;
  }
  .icon-button svg { display: block; width: 20px; height: 20px; }
  .launcher {
    position: relative;
    width: ${LAUNCHER_SIZE}px;
    height: ${LAUNCHER_SIZE}px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    box-shadow: none;
    touch-action: none;
    cursor: grab;
    place-items: center;
  }
  .launcher::after {
    position: absolute;
    inset: 1px;
    z-index: 1;
    border: 2px solid transparent;
    border-top-color: var(--nt-accent);
    border-right-color: var(--nt-accent);
    border-radius: 50%;
    content: "";
    opacity: 0;
    pointer-events: none;
  }
  .launcher-surface {
    position: relative;
    display: grid;
    width: ${LAUNCHER_VISUAL_SIZE}px;
    height: ${LAUNCHER_VISUAL_SIZE}px;
    border: 1px solid #e6e1d8;
    border-radius: 50%;
    background: var(--nt-launcher-bg);
    color: var(--nt-launcher-icon);
    box-shadow: 0 4px 10px rgb(59 49 35 / 18%), 0 0 0 5px rgb(247 243 237 / 72%);
    pointer-events: none;
    place-items: center;
  }
  .launcher-surface svg { width: 23px; height: 23px; }
  .launcher-active-dot {
    position: absolute;
    top: 4px;
    right: 5px;
    width: 6px;
    height: 6px;
    border: 1px solid rgb(122 74 0 / 30%);
    border-radius: 50%;
    background: var(--nt-accent);
    box-shadow: 0 1px 2px rgb(88 54 0 / 26%);
  }
  .launcher-surface::before {
    position: absolute;
    border-radius: 999px;
    background: var(--nt-muted);
    content: "";
    opacity: 0;
    pointer-events: none;
  }
  :host([data-edge-hidden="true"][data-docked-edge="left"]) .launcher-surface::before,
  :host([data-edge-hidden="true"][data-docked-edge="right"]) .launcher-surface::before {
    top: 12px;
    width: 3px;
    height: 15px;
    opacity: 1;
  }
  :host([data-edge-hidden="true"][data-docked-edge="left"]) .launcher-surface::before { right: 7px; }
  :host([data-edge-hidden="true"][data-docked-edge="right"]) .launcher-surface::before { left: 7px; }
  :host([data-edge-hidden="true"][data-docked-edge="top"]) .launcher-surface::before,
  :host([data-edge-hidden="true"][data-docked-edge="bottom"]) .launcher-surface::before {
    left: 12px;
    width: 15px;
    height: 3px;
    opacity: 1;
  }
  :host([data-edge-hidden="true"][data-docked-edge="top"]) .launcher-surface::before { bottom: 7px; }
  :host([data-edge-hidden="true"][data-docked-edge="bottom"]) .launcher-surface::before { top: 7px; }
  :host([data-loading="true"]) .launcher::after {
    opacity: 1;
    animation: norixor-launcher-spin 900ms linear infinite;
  }
  :host([data-loading="true"][data-progress-mode="determinate"]) .launcher::after {
    border: 0;
    background: conic-gradient(
      var(--nt-accent) 0 var(--nt-progress-angle, 0deg),
      var(--nt-text) var(--nt-progress-angle, 0deg) 360deg
    );
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
    mask: radial-gradient(farthest-side, transparent calc(100% - 3px), #000 0);
    animation: none;
  }
  :host([data-loading="true"]) .launcher svg { opacity: 0.72; }
  :host([data-dragging="true"]) .launcher { cursor: grabbing; }
  .launcher:hover .launcher-surface { background: #fffaf1; border-color: #d8d1c5; }
  .quick-actions {
    --nt-quick-action-shift: 5px;
    position: absolute;
    right: calc(100% + 2px);
    bottom: 0;
    display: flex;
    min-width: max-content;
    align-items: center;
    gap: 8px;
    padding: 4px 7px;
    opacity: 0;
    pointer-events: none;
    transform: translateX(var(--nt-quick-action-shift));
    visibility: hidden;
  }
  :host([data-quick-action-side="right"]) .quick-actions {
    --nt-quick-action-shift: -5px;
    right: auto;
    left: calc(100% + 2px);
  }
  .quick-action {
    display: inline-grid;
    width: 48px;
    min-width: 48px;
    min-height: 48px;
    height: 48px;
    padding: 0;
    border-radius: 6px;
    background: var(--nt-bg);
    box-shadow: 0 6px 16px rgb(52 45 34 / 16%);
    place-items: center;
  }
  .quick-action svg { width: 20px; height: 20px; }
  .quick-translate {
    border-color: var(--nt-border);
    background: var(--nt-bg);
    color: var(--nt-accent-hover);
  }
  .quick-translate:hover { border-color: var(--nt-accent); background: var(--nt-hover-bg); }
  .quick-stop { color: var(--nt-danger); }
  .quick-stop:hover { border-color: var(--nt-danger); background: var(--nt-hover-bg); }
  .quick-action:focus-visible { outline: 3px solid var(--nt-focus); outline-offset: 3px; }
  .control:focus-within .quick-actions {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(0);
    visibility: visible;
  }
  @media (hover: hover) and (pointer: fine) {
    .control:hover .quick-actions {
      opacity: 1;
      pointer-events: auto;
      transform: translateX(0);
      visibility: visible;
    }
  }
  .panel:not([hidden]) ~ .quick-actions,
  :host([data-edge-hidden="true"]) .quick-actions,
  :host([data-dragging="true"]) .quick-actions {
    opacity: 0;
    pointer-events: none;
    visibility: hidden;
  }
  .danger { color: var(--nt-danger); }
  @keyframes norixor-launcher-spin { to { transform: rotate(360deg); } }
  @media (max-width: 375px) {
    .panel { width: calc(100vw - 20px); max-width: calc(100vw - 20px); }
    .panel-menu-popover button, .panel-menu-popover a,
    .ocr-section > summary { min-height: 44px; }
    select { height: 44px; min-height: 44px; }
  }
  @media (max-width: 319px) {
    .settings-grid { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: no-preference) {
    :host { transition: transform 180ms ease; }
    button, select { transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease; }
  }
  @media (prefers-reduced-motion: reduce) {
    :host, button, select { animation: none !important; transition: none !important; }
    :host([data-loading="true"]) .launcher::after { animation: none !important; }
  }
`;
