# Desktop Launcher

This project is configured with app-it for Dock-launchable macOS apps: Campaigns.

- Build: `npm run desktop:build` / `pnpm desktop:build` / `bun run desktop:build` depending on this repo.
- Install: `./scripts/desktop-install.sh` copies the app bundle(s) to `~/Applications/App It/`.
- Quit: `./scripts/desktop-quit.sh` stops app-it-managed launcher processes for this project.
- Diagnose: `./scripts/desktop-doctor.sh`.

The generated bundle preserves the existing app name, bundle id, preferred port, and icon identity from the legacy launcher.
