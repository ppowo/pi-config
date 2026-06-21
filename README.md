# pi-config

My personal pi agent config repo.
It keeps prompts/extensions/skills/themes/reminders plus repo-managed pi config files (settings, models, keybindings, quotas, neuralwatt, etc.) in version control and bootstraps them into `~/.pi/agent`.

## Prerequisites

- **Node.js** ≥ 22.19.0 — see [Installing Node.js](#installing-nodejs)
- **pi** — see [Installing pi](#installing-pi)

### Extra command-line tools

This pi config enables [`pi-hashline-readmap`](https://github.com/coctostan/pi-hashline-readmap). That extension can use several external command-line tools for faster searches, richer structural maps, semantic diffs, and better command-output summaries.

This repo does **not** install those tools. Install them with whatever package manager makes sense for your machine.

#### Tools used by `pi-hashline-readmap`

| Tool/package | Binary | Used for |
| --- | --- | --- |
| `scc` | `scc` | Code counting and some compressed command-output paths. |
| `universal-ctags` | `ctags` | Symbol maps for languages without a dedicated mapper. |
| `difftastic` | `difft` | Semantic diff summaries. |
| `fd` | `fd` | Faster file finding. |
| `jq` | `jq` | JSON processing. |
| `ripgrep` | `rg` | Fast text search. |
| `shellcheck` | `shellcheck` | Shell script checks and related output summaries. |
| `yq` | `yq` | YAML/JSON/XML/CSV processing. |
| `ast-grep` | `ast-grep` | Structure-aware code search via `ast_search`. |

#### Installation guidance

Recommended: use your system package manager (`brew`, `apt`, `dnf`, `pacman`, `zypper`, etc.) and install the package names that match your OS.

For example, on macOS with Homebrew:

```bash
brew install difftastic fd jq ripgrep shellcheck yq scc universal-ctags
```

On the author's setup, these tools are installed through two package managers:

- [`mise`](https://mise.jdx.dev/) provides `ast-grep`, `difftastic`, `fd`, `jq`, `ripgrep`, `shellcheck`, and `yq`.
- [`lum`](https://github.com/ppowo/lum) provides `scc` and `universal-ctags`.

That split is only an implementation detail of this environment; users do not need to use `mise` or `lum` if their normal package manager can install the tools.

### Installing Node.js

**macOS** (Homebrew):
```bash
brew install node
```

Or install via [`mise`](https://mise.jdx.dev/) or [fnm](https://github.com/Schniz/fnm#installation) if you want a version manager for Node.

**Linux** — install via your package manager (`apt`, `dnf`, etc.), [`mise`](https://mise.jdx.dev/), or [fnm](https://github.com/Schniz/fnm#installation).

Verify:
```bash
node --version   # should be ≥ 22.19.0
```

### Installing pi

Install pi globally with npm:
```bash
npm install -g @earendil-works/pi-coding-agent
```

Verify:
```bash
pi --version
```

## Setup
From this repo root:
```bash
npm run setup
```

Theme defaults to light. You can also choose explicitly:

```bash
npm run setup-light
npm run setup-dark
```

No `npm install` needed — the bootstrap script uses only Node.js built-ins.

## What setup does

`npm run setup` runs `bootstrap.mjs`, which:

1. **Clears** all repo-managed paths under `~/.pi/agent/` (prompts, skills, reminders, APPEND_SYSTEM.md, models.json, keybindings.json, extensions/, themes/) — stale symlinks and files are cleaned out before re-creation.

2. **Symlinks** directories and files into `~/.pi/agent`:
   - `prompts/`
   - `skills/`
   - `reminders/`
   - `APPEND_SYSTEM.md`
   - `models.json`
   - `keybindings.json`

3. **Symlinks** extension and theme directories from the repo into `~/.pi/agent`:
   - `extensions/` → `~/.pi/agent/extensions/`
   - `themes/` → `~/.pi/agent/themes/`

4. **Installs** JSON config files (full replacement — the repo file becomes the target file). If a source file is later removed from the repo, re-running setup removes the corresponding target:
   - `settings.json` → `~/.pi/agent/settings.json`
   - `quotas.json` → `~/.pi/agent/extensions/quotas.json`
   - `neuralwatt.json` → `~/.pi/agent/extensions/neuralwatt.json`
   - `pi-vcc-config.json` → `~/.pi/agent/pi-vcc-config.json`
   - `web-tools.json` → `~/.pi/web-tools.json`
   - `hashline-readmap-settings.json` → `~/.pi/agent/hashline-readmap/settings.json`

5. **Switches the active theme** — symlinks the `github-colorblind.json` theme to the light or dark variant (defaults to light unless `--dark` or `--light` is passed to the script).

## Repo layout

- `bootstrap.mjs` — setup/link/merge script
- `prompts/` — prompt files
- `extensions/` — pi extensions
- `skills/` — pi skills
- `themes/` — pi themes
- `reminders/` — global reminder definitions for `pi-system-reminders`
- `APPEND_SYSTEM.md` — extra system prompt text appended into pi
- `settings.json` — repo-managed pi settings, including installed packages/extensions
- `models.json` — custom provider/model definitions symlinked into pi (for example OpenRouter via `OPENROUTER_API_KEY`)
- `keybindings.json` — repo-managed keybinding overrides; unbinds built-in `Ctrl+P` users so `model-info-toggle` can own it

- `quotas.json` — pi-quotas configuration installed into `~/.pi/agent/extensions/quotas.json`
- `neuralwatt.json` — Neuralwatt provider configuration installed into `~/.pi/agent/extensions/neuralwatt.json`
- `pi-vcc-config.json` — pi-vcc extension configuration installed into `~/.pi/agent/pi-vcc-config.json`
- `web-tools.json` — web-tools configuration installed into `~/.pi/web-tools.json`
- `hashline-readmap-settings.json` — hashline-readmap settings installed into `~/.pi/agent/hashline-readmap/settings.json`

The bootstrap script is plain Node.js, but pi extensions in `extensions/` can still stay TypeScript.
Reminder files tracked in `reminders/` become global reminders via `~/.pi/agent/reminders`; project-specific reminders for some other repo should still live in that repo's `.pi/reminders/` directory.

## Re-run / update

Re-run `npm run setup` any time you change files in this repo or set up a new machine.

`bootstrap.mjs` resolves the repo from the script location, so it works even if you invoke it outside the repo root.

## Note

All JSON config files (`settings.json`, `quotas.json`, `neuralwatt.json`, `pi-vcc-config.json`, `web-tools.json`, `hashline-readmap-settings.json`) are **fully replaced** on every `npm run setup` — the repo file is written wholesale over the target. Any local pi settings not tracked in this repo will be overwritten.

If a JSON source file is removed from the repo, re-running setup deletes the corresponding target file.