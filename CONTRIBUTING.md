# Contributing

Issues are welcome. Small pull requests are preferred: one clear problem, one coherent change, and enough context to verify it.

## Development setup

Campaigns has no runtime dependencies or build step. Clone the repo, use Node.js 20+, and start the sample:

```bash
git clone https://github.com/Christian-Katzmann/Campaigns.git
cd Campaigns
node --version
npm run start:sample
```

The server prints its local URL. Stop it with `Ctrl-C` when finished.

## Before handing work back

Run both checks:

```bash
npm run check
npm test
```

For screenshot, social-preview, or trailer changes, also run `npm run assets:render` on macOS.

## Find the right module

[docs/architecture.md](docs/architecture.md) maps the frontend modules, server boundaries, and import direction. Keep markdown as the product data model; the browser is an editor around the file, not an independent store.

## Pull requests

- Open an issue first when the behavior or product direction is unclear.
- Keep a pull request small enough to explain in a few sentences.
- Include the practical command output that proves the change.
- Include a regenerated screenshot for visible UI changes.
- Preserve the `baseHash` conflict flow for document writes.
- Keep local campaigns, machine paths, credentials, and generated run state out of commits.

This is a solo-maintainer repository. Fast, focused changes are easier to review and merge than large speculative refactors.
