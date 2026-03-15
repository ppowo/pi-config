# pi-config

My personal pi agent config repo.

It keeps prompts/extensions/skills/themes in version control and bootstraps them into `~/.pi/agent`.

## Prerequisites

- Node.js
- pi installed locally

## Setup

From this repo root:

```bash
npm install
npm run setup
```

## What setup does

`npm run setup` runs `bootstrap.mjs`, which:

- symlinks into `~/.pi/agent`:
  - `prompts/`
  - `extensions/`
  - `skills/`
  - `themes/`
  - `APPEND_SYSTEM.md`
  - `models.json`
- merges overlay files into:
  - `~/.pi/agent/settings.json` (from `settings.json`)

## Repo layout

- `bootstrap.mjs` — setup/link/merge script
- `prompts/` — prompt files
- `extensions/` — pi extensions
- `skills/` — pi skills
- `themes/` — pi themes
- `settings.json` — repo-managed pi settings overlay
- `models.json` — custom provider/model definitions symlinked into pi

The bootstrap script is plain Node.js, but pi extensions in `extensions/` can still stay TypeScript.

## Re-run / update

Re-run `npm run setup` any time you change files in this repo or set up a new machine.

`bootstrap.mjs` resolves the repo from the script location, so it works even if you invoke it outside the repo root.

## Note

`settings.json` is applied as a repo-managed overlay. Every leaf path present there is owned by this repo (for example `theme`, `spinnerVerbs`, `packages`, and `compaction.enabled`). Other local pi settings are preserved, and if a repo-managed key is later removed from `settings.json`, re-running setup removes it from `~/.pi/agent/settings.json` too.