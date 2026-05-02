# Pi Config

A personal dotfiles-and-reconciliation system for the pi coding agent. It declares
the desired state of `~/.pi/agent/` and reconciles it idempotently via `bootstrap.mjs`.

## Language

**Reconciliation**:
The act of making `~/.pi/agent/` match the declarative state described by this repo.
_Avoid_: Sync, setup, install.

**Extension**:
Runtime code that hooks into pi's lifecycle (tools, commands, tool_call interception,
prompt injection). Lives in `extensions/`.
_Avoid_: Plugin, addon.

**Skill**:
Declarative markdown guidance for the LLM, loaded by pi's skill system. Defines
behavioral patterns for specific tasks.
_Avoid_: Prompt template (not the same thing—skills are behavioral guidance, not raw prompts).

**Overlay**:
An incremental JSON merge strategy where the repo owns specific leaf paths but
preserves unrelated local mutations in the target file (e.g. `settings.json`).
_Avoid_: Patch, diff.

**Symlink**:
A full directory or file replacement strategy, where the repo owns the entire
asset and any local changes are discarded on reconciliation. Used for static assets
that pi only reads, never writes.
_Avoid_: Link (ambiguous).

**Local Extension**:
A custom extension written and maintained in this repo's `extensions/` directory.
_Avoid_: Custom extension, homegrown extension.

**Package Extension**:
A third-party extension installed via npm package or GitHub URL and managed by
pi's internal package system.
_Avoid_: External extension, remote extension.

**Theme**:
A JSON color palette that defines pi's TUI visual styling, with light and dark
variants.
_Avoid_: Color scheme, palette (too generic).

**Reminder**:
A session-start message injected into the LLM context by `pi-system-reminders`,
defined in `reminders/`.
_Avoid_: System reminder, nudge.

**Source of Truth**:
This repo. The desired state is declared here; `~/.pi/agent/` is the reconciled
copy.
_Avoid_: Master copy, canonical copy.

## Relationships

- A **Theme** has a `light` and `dark` variant. The bootstrap script auto-links
the appropriate variant based on OS appearance mode.
- An **Extension** can be either a **Local Extension** (in `extensions/`) or a
**Package Extension** (installed via npm/GitHub and tracked in `settings.json`).
- A **Package** can bring any combination of **Extensions**, **Skills**, and
**Themes**. This repo selectively loads only the pieces it wants through `settings.json`.
- **Overlay** merge is used for JSON config files that pi mutates at runtime
(`settings.json`, `verbosity.json`, `web-tools.json`, `synthetic.json`). The repo
owns leaf paths; local additions survive reconciliation.
- **Symlink** is used for static assets that pi only reads (`prompts/`,
`skills/`, `themes/`, `extensions/`, `APPEND_SYSTEM.md`, `models.json`).
- **Reconciliation** is idempotent — re-running it is safe and intended to be
done after any change to this repo or on a fresh machine.
- **Reminders** are static assets managed via symlink, but their *semantics*
are behavioral (they inject messages into the LLM context on session start).
- **API keys** for custom providers live outside this repo (Bitwarden). This repo
manages *configuration*, not *credentials*.

## Example dialogue

> **Dev:** "I added a new extension to `extensions/`. Should I run `npm run setup`?"
>
> **Domain expert:** "Yes — that's **reconciliation**. The bootstrap script will
> symlink it into `~/.pi/agent/extensions/` and merge any JSON **overlays**.
> It's idempotent, so you can run it after any change."
>
> **Dev:** "What about `settings.json` — doesn't pi write to that itself?"
>
> **Domain expert:** "Yes, which is why we use **overlay** merge rather than
> full replacement. The repo owns only the leaf paths it declares; anything pi
> added locally survives **reconciliation**."
>
> **Dev:** "And if I delete `~/.pi/agent/` entirely?"
>
> **Domain expert:** "Run `npm run setup` and it'll reconstruct the whole thing.
> API keys live in Bitwarden, not here — you'll need to re-add those manually.
> But your **extensions**, **skills**, **themes**, **reminders**, and config
> **overlays** are all back exactly as declared."

## Flagged ambiguities

- "Prompt" was historically used for both **Skill** definitions and the
  `prompts/` directory. Resolved: **Skills** are behavioral task guidance
  (markdown instructions), while `prompts/` is for raw prompt text fragments
  (currently unused). `APPEND_SYSTEM.md` serves as the de facto system prompt overlay.
- "Bootstrap" is sometimes used casually for "first-time setup." Resolved:
  **Reconciliation** is the correct term — the script is idempotent and meant to
  be run repeatedly, not just once.
