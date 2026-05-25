# Campaigns

Campaigns turns a markdown plan into a local execution board for AI-assisted projects: phases, checklists, prompt cards, progress, and a registry of plans you can switch between.

Status: usable public alpha. The Node server and sample campaign are portable; the optional desktop wrapper is macOS-only.

![Campaigns showing a markdown campaign as an execution board](design/screenshots/01-campaign-board.png)

*The board reads checklist state straight from markdown, so the plan file stays the source of truth while the UI gives you a calmer way to execute it.*

## What This Is Not

- Not a hosted project manager or team workspace.
- Not a replacement for GitHub Issues, Linear, or your source control history.
- Not a cloud sync layer; Campaigns reads and writes local markdown files.

## Quick Start

Requirements:

- Node.js 20 or newer
- A markdown campaign file, or the sample in this repo

```bash
git clone https://github.com/Christian-Katzmann/Campaigns.git
cd Campaigns
./install.sh
npm run start:sample
```

Then open the URL printed by the server. By default it is `http://localhost:4178`.

Open your own campaign file:

```bash
npm start -- --file path/to/your-campaign.md
```

Useful flags and environment variables:

- `--file <path>` or `CAMPAIGN_FILE=path/to/file.md`
- `--port <number>` or `PORT=4179`
- `CAMPAIGNS_REGISTRY_DIR=/path/to/state`
- `CAMPAIGNS_PORT_FILE=/path/to/server.port`

## Choose Your Path

- **Try the product:** run `npm run start:sample` and edit `examples/sample-campaign.md`.
- **Pair it with an agent skill:** register campaigns through the local `POST /api/registry` contract.
- **Package the desktop launcher:** run `npm run desktop:build` on macOS.
- **Work on the repo:** run `npm run check` before handing changes back.

## What It Reads

Any markdown file opens. These conventions unlock the richer campaign UI:

- `## Progress checklist` with `### Phase N - Title` sections and `- [ ] Step N.M - name` checklist items.
- `## Step N.M - name` headings for the implementation steps.
- `Model:` and `Parallel:` metadata lines directly under each step heading.
- Fenced prompt blocks inside steps.
- A single `## Final review` section plus a `- [ ] Final review` checklist item for campaign-level closure.

Legacy campaigns with per-step or per-phase review templates still render.

See [examples/sample-campaign.md](examples/sample-campaign.md) for a small file you can edit safely.

## How It Works

```text
Markdown campaign
  -> parser extracts phases, steps, prompts, and checkboxes
  -> local server exposes the document and registry API
  -> browser UI edits the same markdown file with conflict checks
  -> paired skills can register new campaigns by local HTTP
```

The important choice: markdown remains the source of truth. Campaigns is the execution surface around it, not a second database you have to reconcile later.

## Paired Skills

Campaigns is designed to pair with agent skills that create and register campaign markdown.

The expected flow is:

1. A skill writes a campaign markdown file into a project.
2. It discovers the running Campaigns server port.
3. It registers the file with `POST /api/registry`.
4. The file appears in the Campaigns library and switcher.

The desktop launcher writes the active port to:

- macOS: `~/Library/Logs/Campaigns/server.port`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/campaigns/server.port`
- Windows: `%LOCALAPPDATA%\Campaigns\server.port`

If you run the server manually, it writes the same port file on startup. Set `CAMPAIGNS_PORT_FILE` if your paired skill should read a different location.

## API Contract

The local server exposes the endpoints paired skills rely on:

```http
GET /api/registry
POST /api/registry
DELETE /api/registry
POST /api/registry/park
GET /api/document?id=<campaign-id>
PUT /api/document?id=<campaign-id>
```

Register a campaign:

```json
{
  "filePath": "/absolute/path/to/campaign.md",
  "logoPath": "/optional/path/to/logo.svg"
}
```

The response contains:

```json
{
  "id": "campaign-id",
  "filePath": "/absolute/path/to/campaign.md"
}
```

`PUT /api/document` expects `{ "markdown": "...", "baseHash": "optional-current-hash" }`. If `baseHash` is stale, the server returns `409` so a client does not overwrite disk changes.

## Local State

The registry is stored outside the repo:

- macOS: `~/Library/Application Support/Campaigns/registry.json`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/campaigns/registry.json`
- Windows: `%APPDATA%\Campaigns\registry.json`

Per-file UI preferences live in browser `localStorage`, keyed by the campaign file path.

## Notifications

Completion notifications are opt-in:

- Mac alerts use `POST /api/notify` and require macOS.
- ntfy.sh, Slack, and Discord use `POST /api/push`.

No remote notification topic or webhook is configured by default.

## Desktop Launcher

The optional desktop wrapper is macOS-only. It builds a local `.app` that starts the Node server and opens a WebKit window.

```bash
npm run desktop:build
npm run desktop:install
npm run desktop:quit
```

The plain Node server is the portable path. A Dockerfile is intentionally not included yet because the app has no build step or service dependencies; `clone + ./install.sh + npm start` is the shorter reliable install path.

## Public Assets

Publication assets live in `design/`:

- `design/screenshots/` contains the README hero and supporting screenshots.
- `design/social/social-preview.png` is the GitHub social preview source.
- `design/trailer/trailer.mp4` is a local 30-second product-forward preview for later GitHub attachment upload.
- `design/visual-principles.md` records the screenshot, poster, and demo-data rules.

Regenerate them from the built-in public demo campaign:

```bash
npm run assets:render
```

## Development

```bash
npm run check
npm start -- --file examples/sample-campaign.md
```

The repository keeps product examples in `examples/`. Local dogfood campaigns and implementation plans are ignored so they do not leak machine-specific paths into the public repo.

## Decisions

- [0001 - Markdown remains the source of truth](docs/decisions/0001-markdown-source-of-truth.md)
- [0002 - Local registry and port-file contract](docs/decisions/0002-local-registry-port-contract.md)
- [0003 - No hosted live demo yet](docs/decisions/0003-no-hosted-live-demo-yet.md)

## License

MIT.
