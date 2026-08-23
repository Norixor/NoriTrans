# Contributing to NorixorTrans

Thank you for helping improve NorixorTrans. Before contributing, please read
this guide, the [Code of Conduct](./CODE_OF_CONDUCT.md), and the
[Security Policy](./SECURITY.md).

## Development Environment

- Node.js `>=22.22.2 <23` or `>=24.15.0 <25`
- pnpm `10.32.1` (pinned by the `packageManager` field in `package.json`)
- Chrome 138 or later

Enable the required pnpm version and install dependencies:

```bash
corepack enable
corepack prepare pnpm@10.32.1 --activate
pnpm install --frozen-lockfile
```

Start a development build:

```bash
pnpm dev
```

When the build is ready, enable Developer mode on `chrome://extensions` and
load `.output/chrome-mv3` as an unpacked extension.

## Submitting Changes

1. Search existing issues and pull requests before starting work to avoid
   duplication.
2. Bug reports and fixes should include reproduction steps, expected behavior,
   and actual behavior. For site-specific changes, include the Chrome version,
   site, subtitle source, language, and whether the session was signed in. Do
   not include cookies, API keys, complete subtitles, or other sensitive data.
3. Discuss scope and privacy boundaries with the maintainers before adding new
   permissions, audio capture, ASR or OCR, cloud services, account sync,
   billing, store distribution, or bulk subtitle collection.
4. Keep changes focused. Do not commit `.output/`, `.wxt/`, test reports, OCR
   models, real user data, or complete copyrighted subtitle files.
5. When changing public contracts, settings, visible copy, or permissions,
   update the corresponding types, Chrome i18n resources, and documentation.
   Do not change the project version in an ordinary pull request unless a
   maintainer requests it.

The project uses WXT, TypeScript strict mode, native HTML and CSS, and Chrome
Manifest V3. Do not introduce remotely executable code, `eval`, or
`new Function`. New dependencies and UI frameworks require prior discussion of
their necessity, licensing, and bundle impact.

## Validation

Before submitting a pull request, run at least:

```bash
pnpm run ci
pnpm format:check
```

`pnpm run ci` runs ESLint, TypeScript type checking, Vitest unit tests, and a
production build. `pnpm format:check` checks source files, tests,
configuration, and documentation supported by Prettier and not excluded by
`.prettierignore`.

When changing extension pages, Content Scripts, subtitle adapters, or browser
messaging flows, also run:

```bash
pnpm test:e2e
```

The standard E2E suite uses synthetic fixtures. It is not equivalent to
acceptance testing on authenticated production sites, and it does not cover
OCR paths that require the local PP-OCR runtime, real image fixtures, and
bounded screenshot permissions. Run the dedicated OCR suite only when the
repository-pinned runtime files are available:

```bash
NORIXORTRANS_OCR_RUNTIME_DIR=/absolute/path/to/runtime pnpm test:e2e:ocr
```

Without that runtime, the command reports a skip. A skipped run does not
validate the OCR path. Do not download or commit real third-party subtitles as
test fixtures.

Site-adapter diagnostics are disabled in normal builds. For local debugging
only, create an uncommitted `.env.local` from `.env.example` and set
`WXT_NORIXORTRANS_SITE_DIAGNOSTICS=1`. Diagnostics may include truncated media
paths and language identifiers. Do not enable them in sensitive accounts, and
do not submit or paste complete Console output without reviewing it first.

## Pull Request Checklist

- Explain the problem, solution, behavior changes, and unverified boundaries.
- Link related issues and list the validation commands actually run and their
  results.
- Include tests proportionate to the risk of new behavior, and add regression
  coverage for bug fixes where practical.
- For UI changes, check keyboard access, accessible names, light and dark
  themes, and affected languages.
- Do not include credentials, authentication headers, complete source text,
  raw Provider responses, or generated artifacts.
- Keep commits reviewable and avoid unrelated refactoring or formatting.
