# pi-config

Bun-first bootstrap for local pi agent configuration.

## Requirements

- [Bun](https://bun.sh) installed

## Usage

From this repository root:

```bash
bun install
bun run setup
```

This links the following into `~/.pi/agent`:

- `prompts/`
- `extensions/`
- `themes/`
- `APPEND_SYSTEM.md`

It also merges repo overlays into:

- `~/.pi/agent/settings.json`
- `~/.pi/agent/pi-sub-bar-settings.json`

## Notes

- This project intentionally uses `latest` dependencies.
- Lockfiles are intentionally not tracked (`package-lock.json`, `bun.lock`, `bun.lockb`).
