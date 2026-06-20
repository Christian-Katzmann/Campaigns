# Desktop Launcher

This project is configured with app-it for Dock-launchable macOS apps: Campaigns.

- Build: `npm run desktop:build` / `pnpm desktop:build` / `bun run desktop:build` depending on this repo.
- Install: `./scripts/desktop-install.sh` copies the app bundle(s) to `~/Applications/App It/`.
- Quit: `./scripts/desktop-quit.sh` stops app-it-managed launcher processes for this project.
- Diagnose: `./scripts/desktop-doctor.sh`.

The generated bundle preserves the existing app name, bundle id, preferred port, and icon identity from the legacy launcher.

## Campaign Companion

Campaign Companion is a small always-on-top panel that shows which registered campaigns are running, stalled, paused, stale, or done — without opening the full board.

- **Launch:** open the Campaigns app, then click the Campaign Companion icon in the macOS menu bar. The in-app **Companion** button does the same thing. In a plain browser it falls back to a small popup window.
- **Use:** the panel defaults to **Active** campaigns only. Toggle **All** to see sleeping, finished, and idle campaigns. The collapse button shrinks the panel down to the pet plus an attention signal. In collapsed mode, drag the pet to move it, or right-click it and choose **Expand**. **Open App** brings the main Campaigns window forward.
- **Notifications:** the badge only counts non-parked `failed`, `halted`, or `stalled` campaigns touched in the last 24 hours. Old attention states move to **All**.
- **Close:** click the panel's close button, or click the menu-bar icon again. With companion support enabled, closing the main Campaigns window hides the board but keeps the menu-bar icon alive. Quit the app with Cmd+Q, or run `./scripts/desktop-quit.sh`, to stop the server and companion.
- **Keep in menu bar after login:** run `npm run desktop:login-item -- install`. This installs a user LaunchAgent that starts Campaigns hidden in menu-bar mode at login. Remove it with `npm run desktop:login-item -- uninstall`.

The companion route (`/companion`) is wired into the bundle via the `companion_path` field in `scripts/app-it.config.json`. Re-run `npm run desktop:build` after changing it. Leave `companion_path` empty to ship a build with no companion bridge.
