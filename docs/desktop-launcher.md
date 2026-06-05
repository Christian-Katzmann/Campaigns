# Desktop Launcher

This project is configured with app-it for Dock-launchable macOS apps: Campaigns.

- Build: `npm run desktop:build` / `pnpm desktop:build` / `bun run desktop:build` depending on this repo.
- Install: `./scripts/desktop-install.sh` copies the app bundle(s) to `~/Applications/App It/`.
- Quit: `./scripts/desktop-quit.sh` stops app-it-managed launcher processes for this project.
- Diagnose: `./scripts/desktop-doctor.sh`.

The generated bundle preserves the existing app name, bundle id, preferred port, and icon identity from the legacy launcher.

## Campaign Companion

Campaign Companion is a small always-on-top panel that shows which registered campaigns are running, stalled, paused, stale, or done — without opening the full board.

- **Launch:** open the Campaigns app, then use the **Launch Campaign Companion** control in the UI. Inside the desktop app this opens a sticky floating panel that stays visible across Spaces and other apps; in a plain browser it falls back to a small popup window.
- **Close:** click the panel's close button, or use the bridge's toggle/close. The panel rides the same dev server as the main window and runs inside the app's own process — so quitting the app (Cmd+Q) or running `./scripts/desktop-quit.sh` closes the companion too. There is no separate companion server, port, or PID file to clean up.

The companion route (`/companion`) is wired into the bundle via the `companion_path` field in `scripts/app-it.config.json`. Re-run `npm run desktop:build` after changing it. Leave `companion_path` empty to ship a build with no companion bridge.
