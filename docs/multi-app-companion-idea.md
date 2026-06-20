# Kro: Multi-App Companions

## The Idea

Build a local companion layer for your digital life.

Kro is a small animated buddy that lives in the macOS menu bar, watches apps and AI tools, surfaces only what needs the user, and teleports the user there in one click.

It is not primarily an assistant. It is a local attention router with a face.

The important shift:

> The companion is not tied to one app. It is a calm, always-on layer above apps, scripts, AI tools, sessions, and workflows.

Kro should run without an LLM. The default system is deterministic: scripts, event watchers, deep links, rules, and lightweight actions. AI can be added by the user, but it is not required and not the default.

## Hard Constraints

- **No LLM by default.** Kro itself should be instant, free, private, deterministic, and always-on.
- **Not a chatbot.** Kro does not compete with Claude, Codex, or other AI tools. It sits above them.
- **Local-first, single-user.** State, rules, grants, and preferences live on the user's machine by default.
- **Notification scarcity.** Kro should interrupt rarely and be right when it does.
- **Teleport or stay quiet.** Every notification needs an exact `open` target. No dead alerts.
- **Radical simplicity.** Scripts over services. Boring local files over clever infrastructure.

## The Optional AI Layer

Users should be able to add AI to Kro if they want.

Examples:

- Add a local model so Kro can generate charming, contextual one-liners.
- Let Kro use an LLM to help classify ambiguous messages.
- Let Kro become more proactive for users who explicitly want that.
- Let Kro orchestrate AI tools in the background.

Example:

> Hey Kro, tell Codex to start the Awesome_Lama_2000 project.

Kro replies:

> You got it.

Then Kro opens/launches Codex in the background, points it at the right repo, sends the task, and reports back:

> Codex has fired up and is implementing. I'll ping you when it's done.

The human does not need to see the terminal, IDE, or agent setup unless they ask.

This is the bigger vision: one tiny companion interface steering many powerful tools behind the scenes.

## Installation Model

At install, the user should be able to choose preconfigured tools/capability packs:

- All
- None
- Some

Examples:

- Campaigns
- Claude session watcher
- Codex session watcher
- Mail
- Calendar
- Messenger
- Files/folders
- Notifications
- Terminal launcher

Later, users can add their own packs or install packs from a marketplace.

MCP fits here as a standard way to expose, inspect, and configure capabilities. It should not be required for Kro to work, but it should be a first-class path for AI-capable clients and community adapters.

## User Stories

Deterministic default:

> Claude finished running that task.

Kro wiggles. The user clicks Kro. Kro opens the exact Claude session.

Configured by an AI client:

> Give Kro access to my Messenger app. He should only notify me when my wife texts, when a client asks a direct question, or when something is urgent. He may draft replies, but he cannot send without asking me.

The AI client can use Kro's MCP/control surface to:

1. Discover installed apps and available adapters.
2. Inspect Messenger capability packs.
3. Grant Kro only the required capabilities.
4. Configure notification rules.
5. Mark risky actions as approval-required.
6. Save this setup as a reusable capability pack.

Optional AI orchestration:

> Kro, start the Lama project in Codex and tell me when it needs me.

Kro launches the right tool, passes the instruction, watches the session, and surfaces completion or blockers.

## Core Concepts

**Companion**

A companion is a face/personality plus a scope: which tools it watches, which rules it follows, and how it asks for attention.

Examples:

- Kro: playful campaign bird.
- Work Sentinel: quiet work-only monitor.
- Finance Watcher: watches spending, invoices, cash movement.

**App Adapter**

An app adapter exposes one app/tool/session type to the companion runtime through a stable contract.

Examples:

- Campaigns adapter.
- Claude session adapter.
- Codex session adapter.
- Messenger adapter.
- Mail adapter.
- Calendar adapter.
- Money adapter.

Each adapter implements three verbs:

```txt
watch -> emit events and a one-line status
open  -> deep-link into the exact app/session/item
act   -> optional light action, like copy path, mark read, draft reply
```

**Capability Pack**

A reusable group of watch/open/act behavior.

Examples:

- `campaigns.status.read`
- `campaigns.step.copy_path`
- `claude.session.watch`
- `codex.session.start`
- `messenger.unread.read`
- `messenger.reply.draft`
- `calendar.availability.read`
- `mail.urgent.detect`

Companions should not get vague "app access." They should get named capabilities.

**Grant**

A grant connects one companion to one or more capability packs.

Example:

```txt
Kro
  campaigns.status.read
  campaigns.step.copy_path
  messenger.unread.read
  messenger.reply.draft requires approval
```

**Notification Rule**

A rule decides what is worth interrupting the user for.

Example:

```txt
Notify Kro only when:
  - campaign is failed, halted, or stalled
  - item is not intentionally parked
  - activity happened within the last 24 hours
```

## Interaction Grammar

Use the same vocabulary everywhere:

- **Wiggle:** ambient "psst"; wordless and ignorable.
- **Speech bubble:** named event, like "Claude's done" or "3 unread."
- **Icon:** one-click teleport into the exact app/session/item.
- **Blur until hover:** private previews stay blurred until the user peeks.
- **Hover:** peek and act inline.
- **Right-click:** board view: everything running across apps, one status line each, jump anywhere.

Attention scales by importance:

```txt
silence -> wiggle -> bubble -> persistent badge
```

The only default brain is rules.

## What We Already Built With Kro

The Campaigns app now has a working first version of this idea.

Kro is a companion connected to Campaigns.

Current Kro behavior:

- Lives in the macOS menu bar through the native desktop wrapper.
- Can appear even when the main Campaigns window is closed.
- Opens a floating companion panel.
- Can collapse down to just Kro plus a notification badge.
- Can be dragged while collapsed.
- Right-clicking collapsed Kro shows **Expand**.
- Has an **Open App** button that opens the normal Campaigns app window.
- Defaults to active/relevant campaigns, not the full archive.
- Still has an **All** toggle for sleeping, finished, and idle campaigns.
- Shows only important notification count, not every possible stale item.
- Lets the user copy the referenced campaign/step path with one icon click.
- Uses the same custom pet package as Codex `/pet`: Kro's `spritesheet.webp`.
- Plays real pet animation rows: idle, running, and waving on hover.

Current implementation points:

- Campaign state API: `GET /api/companion-state`
- Pet API: `GET /api/companion-pet`
- Companion route: `/companion`
- Native menu-bar and floating panel: `scripts/wrapper.swift`
- Companion UI: `public/companion.html`, `public/companion.css`, `public/companion.js`
- Pet package discovery: `lib/companion-pets.mjs`
- Login item support: `npm run desktop:login-item -- install`

In other words: Campaigns is already the first app adapter, and Kro is already the first companion runtime.

## Generalized Architecture

```txt
Local Companion Runtime
  - menu-bar presence
  - floating/collapsed companions
  - notification badge
  - pet/avatar animation
  - local registry
  - local rules engine
        |
        v
App Adapters
  Campaigns / Claude / Codex / Messenger / Mail / Calendar / Money
        |
        v
Optional MCP / AI Control Plane
  Codex / Claude Code / other MCP-capable clients
```

The runtime is the product. MCP is an optional control plane and adapter surface.

## Suggested MCP Tools

The companion MCP/control server could expose tools like:

```txt
list_companions
create_companion
update_companion
list_apps
list_capability_packs
inspect_capability_pack
grant_capability_pack
revoke_capability_pack
set_notification_rule
simulate_notification_rule
explain_notification
list_current_grants
list_pending_approvals
approve_action
deny_action
open_companion
open_app
start_ai_session
send_ai_task
```

This lets AI clients configure or inspect Kro, while state remains owned by the local runtime.

## Suggested Data Model

```txt
companions/
  kro
    name
    avatar/pet package
    personality profile
    default notification style

apps/
  campaigns
  claude
  codex
  messenger
  mail

capability_packs/
  campaigns-status-reader
  claude-session-watcher
  codex-task-launcher
  messenger-urgent-thread-watcher
  messenger-reply-drafter

grants/
  kro -> campaigns-status-reader
  kro -> messenger-urgent-thread-watcher

notification_rules/
  kro/campaigns/important-only
  kro/claude/session-done
  kro/codex/task-needs-attention
  kro/messenger/urgent-only
```

## Why This Is Interesting

Most app assistants are trapped inside one app or one heavy interface.

Kro is the next layer of abstraction: fewer clicks, fewer interfaces, more invisible orchestration.

This model lets the user build a personal local capability graph over time:

- First connect Campaigns.
- Then Claude/Codex sessions.
- Then Messenger.
- Then Calendar.
- Then Mail.
- Then Finance.

Each new app adds reusable capability packs. Each companion can receive only the packs it needs.

Over time, the user gets a personalized companion system that can span apps without giving every companion everything.

Kro does not need to be a powerful brain. It only needs to connect to powerful tools and know when to surface them.

## Product Principles

1. **Local-first by default.**
   State, grants, and rules live locally unless the user chooses otherwise.

2. **Named capabilities, not blanket access.**
   "Read unread Messenger threads" is better than "access Messenger."

3. **Approval gates for risky actions.**
   Drafting is different from sending. Reading is different from deleting.

4. **Notification scarcity.**
   Companions should interrupt only for important things.

5. **Reusable setup.**
   A capability pack configured once should be reusable by other companions.

6. **AI-agnostic control plane.**
   Any MCP-capable AI should be able to configure or inspect the runtime.

7. **Companion as UI layer, MCP as wiring layer.**
   The companion is what the user relates to. MCP is one way capabilities are installed, scoped, and inspected.

8. **AI is opt-in.**
   Kro can orchestrate AI tools or use a local model, but the base product must work without AI.

9. **Focus is scope.**
   Multiple companions are not just permission buckets; they are separate attention channels.

## First Generalized Milestone

Lift the companion runtime out of Campaigns into a small local daemon.

Ship:

- One companion: Kro.
- Two adapters: Campaigns and a Claude/Codex session watcher.
- One menu-bar runtime.
- One right-click board.
- One scope toggle per adapter.
- One event schema.
- One exact open target per event.

Prove the loop:

```txt
Claude/Codex starts work
Kro watches
Kro wiggles when done or blocked
click opens the exact session
right-click shows all running work
```

## Open Questions

- Should app adapters be MCP servers themselves, or should one companion MCP server broker all adapters?
- How should capability packs declare read/write/approval boundaries?
- How should users inspect what each companion can currently do?
- How much personality should live in the companion runtime versus the AI client?
- Should companions share memory, or should memory be scoped per companion?
- How should remote/cloud apps work without breaking the local-first model?
- How should an adapter declare whether an action is safe, approval-required, or forbidden?
- How should marketplace packs be reviewed without adding enterprise/security theater?
- Should AI orchestration be a first-party adapter or just another capability pack?

## Review Prompt For Other AIs

Please review this product idea.

I am exploring Kro: a local macOS companion layer for apps and AI tools. It is not a chatbot and has no LLM by default. It is a deterministic local attention router with a face: scripts, event watchers, deep links, rules, and light actions. Users can create one or more companions, then grant each companion scoped capability packs for different apps/tools. AI and MCP are optional power surfaces: useful for setup, inspection, marketplace adapters, or explicit orchestration, but not required for the base product.

We already have a Kro prototype inside a local Campaigns app. Kro lives in the macOS menu bar, opens a floating panel, collapses into just the animated pet plus a notification badge, reads Campaigns state from `/api/companion-state`, uses a custom pet package from `/api/companion-pet`, defaults to active/relevant campaigns, and exposes important notifications plus copy-path actions.

Question:

What is strong about this idea, what is weak or risky, what should the first generalized version include, and what architecture would you recommend for making it work across many local apps/tools while keeping the deterministic local runtime as the core?
