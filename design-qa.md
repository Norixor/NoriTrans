# NorixorTrans 0.1.118 Design QA

## Source targets

- The original concept images were generated outside this repository and are not portable project artifacts. Repository-controlled implementation captures, when available, are stored under [`output/playwright/`](./output/playwright/). A future design update must copy any retained reference into the repository before citing it from this document.

## Implemented target

- Native HTML/CSS/TypeScript only; no new runtime dependency.
- Warm Paper tokens: warm neutral canvas and surfaces, black-ink primary actions, restrained amber selected/progress states, fine neutral dividers and no gradients.
- Settings: persistent left sidebar on desktop, compact horizontal navigation on narrow viewports, single-layer content regions, 40px fields and a solid fixed save bar.
- Quick panel: 336px maximum width, 12px outer radius, 44px tabs, dense two-column settings, structured status/diagnostic regions and unchanged functional IDs.
- Paper Seal: 40px visible circle inside a 48px interaction target, active indicator, determinate/indeterminate progress ring, edge-reveal marker and 48px hover/focus quick actions.
- Popup, OCR permission, profile wizard and selected-text translation use the same visual tokens so the selected direction is applied as a system instead of one isolated screen.
- Image translation: translated text uses the same black translucent cue surface as video subtitles, covers the complete detected source-text line while remaining vertically compact, and stays centered over that line. Image progress and error copy no longer render on top of the image; they remain available through the unified floating control. Stale image controls left by an unpacked-extension reload are removed before remounting.
- Image OCR now reads the hovered `<img>` source directly (`currentSrc`, plus local `data:`/`blob:` handling) instead of cropping a visible-tab screenshot. Cross-origin HTTPS raster images are fetched through the background with type, size and timeout bounds, so extension controls cannot enter the OCR pixels.

## Local checks

- `pnpm build`: passed for Chrome MV3, version 0.1.118.
- `pnpm zip`: passed for `.output/norixortrans-0.1.118-chrome.zip`.
- Automated behavior tests were not run, following the current project acceptance instruction.

## Browser comparison status

The implementation screenshot is not available in this pass. Reloading the unpacked extension requires opening Chrome's internal extension-management page, and the connected browser session blocked navigation to `chrome://extensions/` by security policy. No workaround or alternate browser session was used.

Consequently, same-viewport pixel comparison, overflow inspection, hover/focus state screenshots, dark-theme rendering and console interaction checks remain pending until the user manually reloads 0.1.118. Source-level dimensions can be checked locally, but this is not equivalent to browser-rendered visual acceptance.

## Open visual checks after reload

- Settings at approximately 1487 × 1058: sidebar rhythm, field alignment, fixed save bar and responsive navigation.
- Quick panel at native 336px width: density, menu positioning, long localized copy and diagnostic expansion.
- Paper Seal on ordinary pages and video fullscreen: edge reveal, loading ring, hover/focus actions and restored remembered position.
- Light and dark themes in Chinese and English.

final result: blocked
