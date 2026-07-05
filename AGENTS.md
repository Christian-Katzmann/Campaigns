# Agent Notes

Safest first command:

```bash
git status --short
```

Campaigns is a local-first Node app. The markdown file is the product data model; the browser UI is an editor around that file, not an independent store.

## Verify

Run this before handing code changes back:

```bash
npm run check
```

For visual/publication asset changes, also run:

```bash
npm run assets:render
```

That script starts a temporary server, captures screenshots, writes the social preview, and builds the local trailer. Kill any server you start manually; this repo commonly uses ports `4178` and `4182`.

## Source Map

- `server.mjs` owns CLI flags, local file IO, registry endpoints, conflict checks, notifications, and static serving.
- `public/app.js` owns markdown parsing/rendering, UI state, localStorage preferences, editor interactions, and save behavior.
- `public/styles.css` owns all product visual language. Keep the UI quiet and dense; this is an execution board, not a marketing site.
- Colors resolve through semantic CSS variables (`--danger`, `--status-ok`, `--hover-wash`, …) defined in `:root`, the dark media query, and each `body.theme-*` block. Never hardcode a component color or add per-theme component overrides — define or extend a variable instead, in all five scopes.
- `examples/` holds public-safe markdown campaigns.
- `design/` holds publication assets and demo data, not runtime product state.

## Do Not

- Do not commit local dogfood campaigns from `campaigns/` or implementation plans from `plans/`; they are intentionally ignored.
- Do not make the app depend on Christian's home directory. Use platform defaults or configurable environment variables.
- Do not replace the markdown-as-source-of-truth model with a hidden database.
- Do not add a hosted demo that can write arbitrary visitor data to a persistent shared file.
- Do not add broad agent instructions or generic architecture prose; if a doc does not encode a Campaigns-specific decision, leave it out.

## Product Conventions

- File conflict safety matters. Preserve the `baseHash` flow for `PUT /api/document`.
- Paired skills depend on `POST /api/registry` and port discovery through the platform-specific `server.port` path.
- Public screenshots should use realistic but fictional campaign data. Avoid personal paths, private campaign names, and placeholder strings like `User 1` or `example.com`.
- Visual assets should stay product-forward: one real UI surface, restrained palette, and captions that explain what the image proves.
