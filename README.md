# pi-config

Bun-first bootstrap for local pi agent configuration.

## Requirements

- [Bun](https://bun.sh) installed

## Usage

From this repository root:

```bash
bun install
bun run bootstrap
```

This links the following into `~/.pi/agent`:

- `prompts/`
- `extensions/`
- `themes/`
- `settings.json`

## Notes

- This project intentionally uses `latest` dependencies.
- Lockfiles are intentionally not tracked (`package-lock.json`, `bun.lock`, `bun.lockb`).
