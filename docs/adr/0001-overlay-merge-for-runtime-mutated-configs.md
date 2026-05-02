# Overlay Merge for Runtime-Mutated Configs

The bootstrap script treats files in two different ways: some are fully symlinked (or directories are symlinked), and some JSON config files are merged as "overlays" where the repo owns specific leaf paths but preserves unrelated local mutations. This is a deliberate choice, not an inconsistency.

The files affected (`settings.json`, `verbosity.json`, `web-tools.json`, `synthetic.json`) are mutated by pi at runtime. For example, pi writes to `settings.json` when you change the theme via the UI. If we fully replaced these files on every `npm run setup`, we'd destroy those local changes. Overlay merge lets the repo declare the desired state for the paths it cares about while leaving everything else alone. The repo even tracks which leaf paths it "owns" (per-overlay `.owned-paths.json` files), so removing a key from the repo overlay will remove it from the target file on the next reconciliation.

This contrasts with `prompts/`, `skills/`, `themes/`, `extensions/`, `APPEND_SYSTEM.md`, and `models.json` — pi only reads these, never writes them. Full symlinks are simpler and correct there.

The other obvious alternatives were (1) full replacement of all files on every run, which would be destructive to runtime state, and (2) manual merging where the user edits both `~/.pi/agent/settings.json` and `settings.json` in this repo, which would quickly diverge and be unmaintainable. Overlay merge is more complex but is the only approach that preserves both repo-managed config and local pi mutations.
