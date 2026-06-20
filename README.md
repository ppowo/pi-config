# pi-config

My personal pi agent config repo.
It keeps prompts/extensions/skills/themes/reminders plus repo-managed pi config in version control and bootstraps them into `~/.pi/agent`.

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

- symlinks into `~/.pi/agent`:
  - `prompts/`
  - `extensions/`
  - `skills/`
  - `themes/`
  - `reminders/`
  - `APPEND_SYSTEM.md`
  - `models.json`
  - `keybindings.json`
- merges overlay files into:
  - `~/.pi/agent/settings.json` (from `settings.json`)
  - `~/.pi/web-tools.json` (from `web-tools.json`)
  - `~/.pi/agent/hashline-readmap/settings.json` (from `hashline-readmap-settings.json`)

## Repo layout

- `bootstrap.mjs` — setup/link/merge script
- `prompts/` — prompt files
- `extensions/` — pi extensions
- `skills/` — pi skills
- `themes/` — pi themes
- `reminders/` — global reminder definitions for `pi-system-reminders`
- `APPEND_SYSTEM.md` — extra system prompt text appended into pi
- `settings.json` — repo-managed pi settings overlay, including installed packages/extensions
- `models.json` — custom provider/model definitions symlinked into pi (for example OpenRouter via `OPENROUTER_API_KEY`)
- `keybindings.json` — repo-managed keybinding overrides; unbinds built-in `Ctrl+P` users so `model-info-toggle` can own it

The bootstrap script is plain Node.js, but pi extensions in `extensions/` can still stay TypeScript.
Reminder files tracked in `reminders/` become global reminders via `~/.pi/agent/reminders`; project-specific reminders for some other repo should still live in that repo's `.pi/reminders/` directory.

## Re-run / update

Re-run `npm run setup` any time you change files in this repo or set up a new machine.

`bootstrap.mjs` resolves the repo from the script location, so it works even if you invoke it outside the repo root.

## Note

`settings.json` is applied as a repo-managed overlay. Every leaf path present there is owned by this repo. Other local pi settings are preserved, and if a repo-managed key is later removed from the file, re-running setup removes it from the target file in `~/.pi/agent/`.