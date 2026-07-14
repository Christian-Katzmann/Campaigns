# Visual Principles

Campaigns should look like a calm execution desk: local files, visible progress, no dashboard noise.

## Hero Shot

- Category: product screenshot hero.
- Subject: the campaign board with progress, checklist state, and a reproducible live-run drawer visible.
- Demo data: fictional but realistic agent-workflow language.
- Crop: wide desktop view, centered on the board and progress sidebar.
- Caption: explain that markdown remains the source of truth while local run activity stays visible beside it.

## Screenshot System

- Theme: light only.
- Aspect ratios: desktop hero at 1440 x 1100, mobile flow at 390 x 900, library view at 1440 x 900.
- Captions should say what each image proves, not merely what it depicts.
- Reuse `design/demo-data/publication-campaign.md` and the generated live-run ledger in `scripts/render-public-assets.sh` when regenerating public screenshots.
- Never show Christian's personal paths, private campaign names, or local worktree directories.

## Social Preview

- Size: 2560 x 1280 source PNG, suitable for GitHub's 2:1 preview.
- Elements: project name, one positioning sentence, one real UI screenshot.
- Palette: Campaigns paper, ink, muted line, and blue accent from `public/styles.css`.
- No badges, star requests, version numbers, or decorative AI imagery.

## Motion Artifact

The current trailer is a local product-forward MP4 built from real screenshots. It is intentionally suitable as a GitHub attachment source after the repository is public, but the README should not embed it as a relative `<video>` tag because GitHub strips that form.

## Open Publication Decisions

- Live demo: defer until there is a sandbox mode that cannot overwrite shared visitor data.
- Custom domain: defer until a hosted demo or documentation site exists; a parked domain would signal more than the project currently offers.
- Hero choice: use the board screenshot, not a logo or composite marketing banner.
