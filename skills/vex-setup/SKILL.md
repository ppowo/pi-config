---
name: vex-setup
description: Inspect macOS/Linux environment and install or update the vex shell environment manager from https://github.com/ppowo/vex via prebuilt binaries. Use when user mentions vex, wants to install or update vex, or needs help setting up vex CLI PATH integration for bash/zsh.
---

# vex Setup

## Quick start

1. Run `bash skills/vex-setup/scripts/inspect.sh` to gather system info.
2. To perform the install/update automatically, run `bash skills/vex-setup/scripts/install.sh --dry-run` first, then `bash skills/vex-setup/scripts/install.sh` if the plan is correct.
3. Support only bash and zsh. If the detected shell is not bash or zsh, stop and explain that this skill does not configure that shell.
4. Determine OS (`uname -s`) and architecture (`uname -m`).
5. Determine install directory for the `vex` executable:
   - If `~/.bio/bin` exists, use it.
   - Otherwise create `~/.local/share/bin` and use it.
6. Download or update the matching `vex` binary in the install directory.
7. Persist shell setup in the detected rc file:
   - The install directory must stay in `$PATH` so `vex` is available after restart.
   - The vex-managed directory from `vex path` must stay in `$PATH` after restart.
   - Use `eval "$(vex init)"` to persist the vex-managed directory and other vex environment setup.
8. Tell user: "Please restart your shell or log out and back in to use vex." No need to source rc file in the agent process.

## Required PATH invariant

After a new bash/zsh shell starts:

- `command -v vex` resolves to the selected install directory.
- `vex path` prints the vex-managed directory.
- Both `dirname "$(command -v vex)"` and `vex path` appear as exact entries in `$PATH`.

## Workflows

### Inspect environment

- Detect shell from `$SHELL`; support `bash` and `zsh` only.
- Detect rc file:
  - bash → `~/.bashrc`
  - zsh → `${ZDOTDIR:-$HOME}/.zshrc`
- Detect OS and architecture.
- Print current `$PATH`, candidate install directory, vex-managed directory, and whether each required directory is currently in `$PATH`.

### Determine install directory

- If `~/.bio/bin` exists → use it.
- Else → `mkdir -p ~/.local/share/bin` and use that.

### Ensure persistent PATH setup

Use a single managed block in the rc file so repeated installs are idempotent and reversible. Create a timestamped backup before editing the rc file.

For bash/zsh, append or replace this block, using the selected install directory:

```sh
# >>> vex setup >>>
# Keep the vex executable and vex-managed tools available in new shells.
export PATH="$HOME/.local/share/bin:$PATH"
eval "$(vex init)"
# <<< vex setup <<<
```

If using `~/.bio/bin`, the PATH line becomes:

```sh
export PATH="$HOME/.bio/bin:$PATH"
```

Important ordering:

1. The install directory PATH export must come before `eval "$(vex init)"` so the rc file can find the `vex` executable.
2. `eval "$(vex init)"` must stay in the rc file because it adds the vex-managed directory from `vex path` to `$PATH`.

### Download binary

```sh
# Example: macOS arm64 targeting ~/.local/share/bin
mkdir -p ~/.local/share/bin
curl -L -o /tmp/vex.tar.gz "https://github.com/ppowo/vex/releases/latest/download/vex_darwin_arm64.tar.gz"
# Optional: verify checksum against vex_checksums.txt
tar -xzf /tmp/vex.tar.gz -C ~/.local/share/bin --strip-components=0 vex
chmod +x ~/.local/share/bin/vex
```

### Configure shell

- Supported rc files: `~/.zshrc`, `${ZDOTDIR}/.zshrc`, `~/.bashrc`.
- Do not configure fish or other shells.
- Use the managed block above; do not append duplicate `PATH` or `vex init` lines.
- Inform user: "Please restart your shell or log back in for changes to take effect."

### Verify

Run these after restarting the shell or after explicitly sourcing the rc file:

```sh
command -v vex
vex --version
vex_dir="$(vex path)"
printf '%s\n' "$PATH" | tr ':' '\n' | grep -Fx "$(dirname "$(command -v vex)")"
printf '%s\n' "$PATH" | tr ':' '\n' | grep -Fx "$vex_dir"
vex list
```

## Advanced features

See [REFERENCE.md](REFERENCE.md) for architecture mapping, troubleshooting, and uninstall steps.
