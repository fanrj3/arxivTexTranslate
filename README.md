# arXiv Translate

A local arXiv LaTeX translation workspace with a companion Zotero plugin.

## What is included

- `service/`: React + Tailwind + shadcn/ui desktop/web service for pulling arXiv sources, translating LaTeX to Chinese, compiling PDFs, tracking token/cost usage, and generating feedback log bundles.
- `plugin/ar-xiv-translate.xpi`: compiled Zotero plugin that sends selected papers to the local service for one-click translation attachment.
- `src/`, `addon/`: Zotero plugin source code.

## Service development

```bash
cd service
npm install
npm run dev
npm run server
```

Build frontend:

```bash
cd service
npm run build
```

Build Windows desktop artifacts:

```bash
cd service
npm run dist:win
```

The desktop app stores jobs and settings under Electron `userData`, not inside the installation directory.

## Feedback bundles

From the service job detail page, click `一键反馈`. The service creates a `log.zip` containing:

- full job source snapshot
- translated LaTeX
- build logs and PDFs
- metadata and token/cost details
- service logs

It also opens the GitHub issue page and copies a ready-to-paste issue title to the clipboard.
