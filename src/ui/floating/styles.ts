import { css } from "lit";
import { LAUNCHER_SIZE, PANEL_GAP } from "./geometry";

/** Host declarations on top of the injected-root reset (`!important`). */
export const FLOATING_HOST_STYLE: Readonly<Record<string, string>> = {
  width: `${LAUNCHER_SIZE}px`,
  height: `${LAUNCHER_SIZE}px`,
  "min-width": `${LAUNCHER_SIZE}px`,
  "min-height": `${LAUNCHER_SIZE}px`,
  overflow: "visible",
  "pointer-events": "auto",
  right: "max(16px, env(safe-area-inset-right))",
  bottom: "max(16px, env(safe-area-inset-bottom))",
};

/**
 * Shell layout. The `.nt-theme` wrapper holds the tokens; this sheet only
 * consumes them. Tab content renders into light-DOM slots of `nt-tabs`, which
 * live in this shadow root, so these rules style it too.
 */
export const floatingStyles = css`
  .nt-theme {
    position: relative;
    width: ${LAUNCHER_SIZE}px;
    height: ${LAUNCHER_SIZE}px;
  }
  .launcher {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: flex-start;
  }
  /* Right half: the pill grows towards the inline start (overflows left). */
  .launcher[data-direction="start"] {
    justify-content: flex-end;
  }
  .launcher[data-status-only] nt-pill-fab {
    cursor: default;
  }
  [data-dragging] .launcher nt-pill-fab {
    cursor: grabbing;
  }
  .panel {
    position: absolute;
    top: ${LAUNCHER_SIZE + PANEL_GAP}px;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: min(336px, calc(100vw - 20px));
    max-height: min(560px, calc(100vh - 80px));
    border: 1px solid var(--nt-line);
    border-radius: var(--nt-r-card);
    background: var(--nt-glass);
    -webkit-backdrop-filter: blur(18px) saturate(1.4);
    backdrop-filter: blur(18px) saturate(1.4);
    box-shadow: var(--nt-shadow-float);
    color: var(--nt-fg);
    overflow: visible;
  }
  .panel[hidden] {
    display: none;
  }
  .panel[data-open-up] {
    top: auto;
    bottom: ${LAUNCHER_SIZE + PANEL_GAP}px;
  }
  .hd {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: var(--nt-space-1);
    height: 44px;
    padding: 0 4px 0 12px;
  }
  .ttl {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--nt-space-3);
    font-size: var(--nt-fs-body);
    font-weight: 700;
  }
  .logo {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--nt-fab-bg);
    color: var(--nt-fab-fg);
  }
  .logo svg {
    width: 14px;
    height: 14px;
  }
  .menu {
    position: absolute;
    top: 44px;
    right: 8px;
    z-index: 2;
  }
  .menu:not([open]) {
    display: none;
  }
  .body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 0 10px 10px;
    border-radius: 0 0 var(--nt-r-card) var(--nt-r-card);
  }
  .tab-body {
    display: grid;
    gap: 10px;
    min-width: 0;
  }
  .notice,
  .confirm {
    margin-bottom: 10px;
  }
  .tab-body .notice {
    margin-bottom: 0;
  }
  .confirm {
    display: grid;
    gap: var(--nt-space-3);
    padding: 12px;
    border-radius: var(--nt-r-card);
    background: var(--nt-s-err-bg);
  }
  .confirm h2 {
    margin: 0;
    font-size: var(--nt-fs-body);
    font-weight: 700;
  }
  .confirm p {
    margin: 0;
    color: var(--nt-fg-2);
    font-size: var(--nt-fs-sm);
  }
  .confirm .acts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--nt-space-3);
  }
  .summary b {
    font-weight: 700;
  }
  .editor {
    display: grid;
    gap: 10px;
    padding: 12px;
    border-radius: var(--nt-r-card);
    background: var(--nt-surface-2);
  }
  .editor .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--nt-space-3);
  }
  .summary [data-fallback] {
    color: var(--nt-fg-2);
  }
  .editor-foot {
    display: flex;
    justify-content: flex-start;
    margin: -2px 0 -4px;
  }
  .diag summary {
    cursor: pointer;
    color: var(--nt-fg-2);
    font-size: var(--nt-fs-sm);
  }
  .diag pre {
    margin: 6px 0 0;
    max-height: 160px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
    font: var(--nt-fs-xs) / 1.4 var(--nt-mono);
    color: var(--nt-fg-2);
  }
  /* Disclosure blocks (image recognition, image translation). */
  .section {
    display: grid;
    min-width: 0;
  }
  .sec-head {
    display: flex;
    align-items: center;
    gap: var(--nt-space-3);
    width: 100%;
    min-height: 44px;
    margin: 0;
    padding: 0 10px 0 12px;
    border: 0;
    border-radius: var(--nt-r-card);
    background: var(--nt-surface-2);
    color: var(--nt-fg);
    font: inherit;
    font-size: var(--nt-fs-sm);
    text-align: start;
    cursor: pointer;
  }
  .sec-head:hover {
    background: var(--nt-surface-3);
  }
  .sec-head:focus-visible {
    outline: var(--nt-focus-width) solid var(--nt-focus);
    outline-offset: 2px;
  }
  .sec-head[aria-expanded="true"] {
    border-radius: var(--nt-r-card) var(--nt-r-card) 0 0;
  }
  .sec-title {
    flex: 1 1 auto;
    min-width: 0;
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  .sec-state {
    flex: 0 1 auto;
    min-width: 0;
    color: var(--nt-fg-2);
    text-align: end;
    overflow-wrap: anywhere;
  }
  .sec-head[data-phase="running"] .sec-state {
    color: var(--nt-s-progress);
    font-weight: 600;
  }
  .sec-head[data-phase="problem"] .sec-state {
    color: var(--nt-s-err);
    font-weight: 600;
  }
  .sec-chev {
    flex: 0 0 auto;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    color: var(--nt-fg-2);
    transition: transform var(--nt-dur-base) var(--nt-ease-standard);
  }
  .sec-chev svg {
    width: 18px;
    height: 18px;
  }
  .sec-head[aria-expanded="true"] .sec-chev {
    transform: rotate(180deg);
  }
  .sec-body {
    display: grid;
    gap: 10px;
    min-width: 0;
    padding: 4px 12px 12px;
    border-radius: 0 0 var(--nt-r-card) var(--nt-r-card);
    background: var(--nt-surface-2);
  }
  .sec-body[hidden] {
    display: none;
  }
  .sec-body .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--nt-space-3);
  }
  .sec-line {
    margin: 0;
    color: var(--nt-fg-2);
    font-size: var(--nt-fs-sm);
  }
  .sec-callout {
    display: grid;
    gap: 4px;
    justify-items: start;
  }
  .card-notes {
    display: grid;
    gap: var(--nt-space-3);
    margin-top: 10px;
  }
  @media (max-width: 400px) {
    .editor .row,
    .sec-body .row {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    * {
      transition-duration: 0.01ms !important;
      animation-duration: 0.01ms !important;
    }
  }
`;
