# pi-config

My personal pi agent config repo.

It keeps prompts/extensions/themes in version control and bootstraps them into `~/.pi/agent`.

## Prerequisites

- [Bun](https://bun.sh) (`>=1.0.0`)
- pi installed locally

## Setup

From this repo root:

```bash
bun install
bun run setup
```

## What setup does

`bun run setup` runs `bootstrap.ts`, which:

- symlinks into `~/.pi/agent`:
  - `prompts/`
  - `extensions/`
  - `themes/`
  - `APPEND_SYSTEM.md`
- merges overlay files into:
  - `~/.pi/agent/settings.json` (from `settings.json`)
  - `~/.pi/agent/pi-sub-bar-settings.json` (from `sub-bar-settings.json`)

## Repo layout

- `bootstrap.ts` — setup/link/merge script
- `prompts/` — prompt files
- `extensions/` — pi extensions
- `themes/` — pi themes
- `settings.json` — base pi settings overlay
- `sub-bar-settings.json` — sub-bar display overlay

## Re-run / update

Re-run `bun run setup` any time you change files in this repo or set up a new machine.

## Note

This repo intentionally tracks only certain keys in merged settings (theme/packages/compaction and sub-bar display keys). Other keys in your local pi settings are preserved.
