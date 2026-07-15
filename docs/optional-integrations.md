# Optional integrations

Campaigns works as a local markdown editor without any automation setup. Extra
surfaces appear only when the server detects the local data they need.

## Automation and personal tools

- **Automate**, **Away**, and **Companion** appear when Campaigns detects either
  a Claude automation directory or a Codex home directory. Set
  `CAMPAIGNS_AUTOMATE_BASE` to override the Claude directory and `CODEX_HOME` to
  override the Codex directory. `CAMPAIGNS_CODEX_RECOVER` can point recovery
  actions at a different `campaign_recover.py` script.
- **Lessons** appears when Campaigns finds unified run ledgers. Set
  `CAMPAIGNS_RUNS_DIR` to move that local history. A compatible
  `CAMPAIGNS_LESSONS_HELPER` is used only as a legacy fallback when no unified
  ledgers exist.
- Companion pets are optional decoration. Set `CAMPAIGNS_PETS_DIR` to a pet
  package directory and `CAMPAIGNS_COMPANION_PET` to select one package by id.

Defaults and examples live in [`.env.example`](../.env.example). Missing
integrations stay hidden; they do not block the board, library, or campaign
editing.

## Notifications

- Native desktop alerts use `osascript` and are available on macOS only.
- ntfy, Slack, and Discord notifications use HTTP and work on every supported platform.
- ntfy attention alerts can carry Stop and eligible human-approval actions. The
  phone posts a short-lived signed command to a separate random command topic;
  the local Campaigns server polls that topic outbound, rejects expired or
  replayed commands, and never exposes an inbound control port.
- Approve appears only when a run awaits human review because its configured
  reviewer was unavailable. Slack and Discord remain message/link channels;
  they do not receive command actions.
- Open appears only after phone onboarding has stored a verified, phone-reachable
  HTTPS URL. Loopback URLs are never published as actions.
- ntfy topics are public by default. Use unguessable topic names and treat the
  topic as notification data, not as an authorization boundary.
- Quiet-hours digest settings persist suppressed alerts locally and page the
  selected attention states immediately (human review by default).
- No remote topic or webhook is configured by default.

## Workflow maps

The **Workflows** view appears when at least one registered campaign belongs to
a repository containing a map under `docs/workflows/`. To opt in, add a Markdown
file at `docs/workflows/<category>/<slug>.md`. Each map contains one fenced JSON
machine record with `name`, `what`, `kind`, `entry_points`, `ends_with`,
`key_files`, and `status`; a drawn map also contains a fenced Mermaid
`flowchart` plus `nodes` and `score` in that JSON record. Register any campaign
from that repository and Campaigns discovers the maps automatically.
