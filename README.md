# pi-config

My personal pi agent config repo.
It keeps prompts/extensions/skills/themes/reminders plus repo-managed pi config in version control, bootstraps them into `~/.pi/agent`, and sets up pi Nushell config in `~/.config/pi/nushell`.

## Prerequisites

- Node.js
- pi installed locally

## Setup
From this repo root:
```bash
npm run setup
```

No `npm install` needed — the bootstrap script uses only Node.js built-ins.

## What setup does

`npm run setup` runs `bootstrap.mjs`, which:

- symlinks into `~/.pi/agent`:
  - `prompts/`
  - `extensions/`
  - `skills/`
  - `themes/`
  - `reminders/`
  - `APPEND_SYSTEM.md`
  - `models.json`
- merges overlay files into:
  - `~/.pi/agent/settings.json` (from `settings.json`)
  - `~/.pi/agent/verbosity.json` (from `verbosity.json`)
  - `~/.pi/web-tools.json` (from `web-tools.json`)
- if `nu` is available, generates `~/.config/pi/nushell/config.nu` and `plugins.msgpackz`, registering optional Nushell plugins found on `PATH`

## Repo layout

- `bootstrap.mjs` — setup/link/merge script
- `prompts/` — prompt files
- `extensions/` — pi extensions
- `skills/` — pi skills
- `themes/` — pi themes
- `reminders/` — global reminder definitions for `pi-system-reminders`
- `APPEND_SYSTEM.md` — extra system prompt text appended into pi
- `nushell/` — notes about pi Nushell bootstrap
- `settings.json` — repo-managed pi settings overlay, including installed packages/extensions
- `verbosity.json` — repo-managed pi-verbosity-control overlay
- `models.json` — custom provider/model definitions symlinked into pi (for example OpenRouter via `OPENROUTER_API_KEY`)

The bootstrap script is plain Node.js, but pi extensions in `extensions/` can still stay TypeScript.
Reminder files tracked in `reminders/` become global reminders via `~/.pi/agent/reminders`; project-specific reminders for some other repo should still live in that repo's `.pi/reminders/` directory.

## Re-run / update

Re-run `npm run setup` any time you change files in this repo or set up a new machine.

`bootstrap.mjs` resolves the repo from the script location, so it works even if you invoke it outside the repo root.

## Note

`settings.json` and `verbosity.json` are applied as repo-managed overlays. Every leaf path present there is owned by this repo. Other local pi settings are preserved, and if a repo-managed key is later removed from either file, re-running setup removes it from the corresponding file in `~/.pi/agent/` too.