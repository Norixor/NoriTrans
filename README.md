<div align="center">
  <img src="./assets/branding/ntrans.svg" width="112" alt="nTrans logo" />
  <h1>nTrans</h1>
  <p>A privacy-conscious Chrome extension for translating webpages and existing video subtitles.</p>
  <p><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>
</div>

> [!IMPORTANT]
> nTrans is a `0.x` project under active development. It currently targets desktop Chrome 138+ and Manifest V3. Site-specific subtitle integrations may require maintenance when streaming platforms change their players or private interfaces.

## Why nTrans?

nTrans keeps webpage translation, video subtitle translation, and optional local OCR in one extension without treating them as the same problem.

- **Webpages:** translate semantic text nodes without replacing a page's entire HTML, follow dynamic content and SPA navigation, and safely restore the original text.
- **Video subtitles:** use complete subtitle tracks when available and fall back explicitly to low-latency stream translation when only the current caption can be observed.
- **Local OCR:** recognize burned-in image subtitles only after the user enables OCR and selects a capture region. Screenshots and recognized text stay on the device.
- **Provider choice:** use Chrome's local Translator API, explicitly downloaded Bergamot language packs, AI translation, Google Cloud Translation, Microsoft Translator, or DeepL with your own credentials. AI translation supports both OpenAI-compatible and Anthropic Claude Messages protocols.
- **One compact control:** manage webpage, video, and image translation from a draggable Shadow DOM control.

## Translation modes

| Mode             | Intended use                                                          | Behavior                                                                                              |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Fast translation | Live captions, DOM captions, OCR, and low-latency webpage translation | Uses the configured fast provider. Stream-only subtitles never consume AI batches.                    |
| AI translation   | Context-sensitive webpages and complete subtitle tracks               | Uses stable segment IDs, bounded batches, progressive results, validation, cancellation, and caching. |

Subtitle sources are classified as either:

- **`full`** — a complete timeline is available and can be pretranslated and cached;
- **`stream`** — only captions observed during playback are available. The UI clearly reports that it has fallen back to fast translation.

## Subtitle support

nTrans prefers complete sources before falling back to current-caption collection:

1. HTML5 `TextTrack`;
2. WebVTT, TTML, timed-text, or a finite subtitle manifest;
3. a controlled MAIN-world network hook for supported sites;
4. a built-in or user-created DOM profile;
5. user-initiated local OCR when no readable subtitle source exists.

The repository includes 20 built-in profiles covering standard HTML5, a generic DOM heuristic, YouTube, Netflix, Max/HBO Max, Disney+/Hotstar, Prime Video, Apple TV+, Hulu, Paramount+, Discovery+, Peacock, fuboTV, TED, BBC iPlayer, ZDF, Deutsche Welle, Udemy, Kanopy, and TVer.

A bundled site profile describes a supported subtitle acquisition strategy; it does not claim that a third-party site has been live-verified for every release.

## Recommended installation

1. Download the latest ZIP package from [GitHub Releases](https://github.com/Norixor/nTrans/releases).
2. Open `chrome://extensions` and enable **Developer mode** in the upper-right corner.
3. Drag the downloaded ZIP package directly into the extensions list.

The recommended installation does not require extracting the ZIP or choosing **Load unpacked**.

## Develop from source

Requirements:

- Chrome 138 or newer;
- Node.js `>=22.22.2 <23` or `>=24.15.0 <25`;
- pnpm `10.32.1`.

```bash
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
pnpm build
```

For source debugging, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

```text
.output/chrome-mv3
```

This workflow is only for source development. Unpacked builds do not update automatically. Keep the same extension directory if you want Chrome to preserve the same local development installation.

## Provider and privacy model

| Capability                   | Processing location                           | Data sent externally                                                                    |
| ---------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| Chrome local translation     | Chrome's local model runtime                  | No text is sent to the configured AI provider. Chrome may download language models.     |
| Downloaded local translation | Extension-origin Bergamot runtime             | Directional packs install only after an explicit click; translated text stays local.    |
| AI translation               | The standard model API configured by the user | Only the text segments and bounded translation context required for the active request. |
| Google, Microsoft, or DeepL  | The selected official provider API            | Only the text segments required for the active fast-translation request.                |
| Local subtitle OCR           | Extension-origin Offscreen Document           | Screenshots and recognized text are not uploaded and cannot be sent to an AI provider.  |
| Version update check         | GitHub Releases API                           | No webpage, subtitle, image, provider credential, or translation text is sent.          |

Additional guarantees:

- API keys are stored in `chrome.storage.local`, never in source code or synchronized storage.
- Cloud requests are made by the background service worker, not by webpage content scripts.
- Provider diagnostics are bounded and exclude API keys, authorization headers, full source text, and raw response bodies.
- Translation cache and credentials are cleared through separate actions.
- OCR models are downloaded only after an explicit user action, from pinned sources, and verified with pinned SHA-256 values.

## Permissions

nTrans declares `https://*/*` because the floating control and webpage/video translation must work on HTTPS pages without requiring a toolbar click first. It does not request cookie, browsing-history, or audio-capture permissions.

Optional host permissions are requested only for the related action:

- `<all_urls>` for user-initiated visible-tab OCR capture;
- pinned GitHub asset origins for explicit OCR model downloads;
- pinned Mozilla catalog and attachment origins for explicit local translation pack downloads;
- `http://localhost/*` and `http://127.0.0.1/*` for a user-configured local provider.

## Development

```bash
pnpm dev             # WXT development build
pnpm format:check    # repository-wide Prettier check
pnpm run ci          # ESLint, TypeScript, unit tests, and production build
pnpm test:e2e        # synthetic Manifest V3 acceptance tests in Chromium
pnpm zip             # versioned extension archive
```

The standard E2E suite uses synthetic pages and short subtitle fixtures. It does not replace release-time checks on real signed-in streaming sites.

The complete OCR capture test additionally requires the pinned local runtime files:

```bash
NTRANS_OCR_RUNTIME_DIR=/absolute/path/to/runtime pnpm test:e2e:ocr
```

Without that runtime, the command reports a skip; a skipped OCR test is not a successful OCR acceptance result.

## Architecture

nTrans uses WXT, strict TypeScript, native HTML/CSS, Chrome Manifest V3, Vitest, and Playwright. It intentionally does not use a UI framework or remotely hosted executable code.

```text
entrypoints/     Extension pages, content scripts, and the background worker
src/page/        Webpage scanning, sessions, rendering, and restoration
src/subtitles/   Subtitle profiles, adapters, parsers, timeline, and overlay
src/translation/ Providers, scheduling, validation, and protected text
src/ocr/         Local capture, runtime, preprocessing, and recognition
src/cache/       Background-origin IndexedDB storage
src/messaging/   Cross-context protocol and validation
src/shared/      Settings, errors, diagnostics, and shared controls
```

See [`AGENTS.md`](./AGENTS.md) for product contracts and acceptance boundaries.

## Contributing and security

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a pull request and follow the [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). Please report vulnerabilities privately as described in [`SECURITY.md`](./SECURITY.md); do not publish credentials, private text, full subtitles, or exploitable details in a public issue.

## Acknowledgements

nTrans is built with [WXT](https://github.com/wxt-dev/wxt), `idb`, ONNX Runtime Web, Bergamot, and a packaged PaddleOCR-compatible runtime. OCR and local translation runtime notices are stored alongside their packaged assets.

## License

Unless otherwise noted, source code and documentation are licensed under the [Apache License 2.0](./LICENSE). Copyright 2026 Norixor.

The nTrans name, logo, product identity, and files under `assets/branding/` are not licensed under Apache-2.0. See [`TRADEMARKS.md`](./TRADEMARKS.md) for the brand-use policy.

<p align="center">
  <a href="https://www.star-history.com/Norixor/nTrans">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Norixor/nTrans&amp;type=Date&amp;theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Norixor/nTrans&amp;type=Date" />
      <img alt="nTrans Star History Chart" src="https://api.star-history.com/svg?repos=Norixor/nTrans&amp;type=Date" />
    </picture>
  </a>
</p>
