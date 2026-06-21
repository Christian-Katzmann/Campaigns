# Vendored: mermaid 11 (ESM)

Offline-first: the Campaigns static server only serves files under `public/`, so the
workflow-map viewer imports mermaid from `/vendor/mermaid/mermaid.esm.min.mjs`
(see `renderWorkflowMapDiagram` in `public/app.js`) — not from a CDN or node_modules.

## What's here
- `mermaid.esm.min.mjs` — the ESM entry (exports `default`).
- `chunks/mermaid.esm.min/*.mjs` — its code-split chunks (eager + lazy diagram types).
  Source maps (`*.map`) are intentionally omitted to keep the tree small.

## Refresh recipe
```sh
npm install mermaid@11 --no-save
rm -rf public/vendor/mermaid && mkdir -p public/vendor/mermaid/chunks/mermaid.esm.min
cp node_modules/mermaid/dist/mermaid.esm.min.mjs public/vendor/mermaid/
find node_modules/mermaid/dist/chunks/mermaid.esm.min -name '*.mjs' ! -name '*.map' \
  -exec cp {} public/vendor/mermaid/chunks/mermaid.esm.min/ \;
```
The app stays zero-dependency: mermaid is vendored, never a package.json entry.
