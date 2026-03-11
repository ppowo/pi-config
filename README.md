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
- merges overlay files into:
  - `~/.pi/agent/settings.json` (from `settings.json`)

## Repo layout

- `bootstrap.mjs` — setup/link/merge script
- `prompts/` — prompt files
- `extensions/` — pi extensions
- `skills/` — pi skills
- `themes/` — pi themes
- `settings.json` — base pi settings overlay

The bootstrap script is plain Node.js, but pi extensions in `extensions/` can still stay TypeScript.

## Re-run / update

Re-run `npm run setup` any time you change files in this repo or set up a new machine.

## Note

This repo intentionally tracks only certain keys in merged settings (`theme`, `packages`, `compaction.enabled`). Other keys in your local pi settings are preserved.