---
name: vex-setup
description: Inspect macOS/Linux environment and install the vex shell environment manager from https://github.com/ppowo/vex via prebuilt binaries. Use when user mentions vex, wants to install vex, or needs help setting up vex CLI.
---

# vex Setup

## Quick start

1. Run `bash skills/vex-setup/scripts/inspect.sh` to gather system info.
2. Determine OS (`uname -s`) and architecture (`uname -m`).
3. Determine install directory:
   - If `~/.bio/bin` exists, use it.
   - Otherwise create `~/.local/share/bin` and use it.
4. If the install directory is not in `$PATH`, add it to the rc file.
5. If vex is already installed, report its version (`vex --version` or `vex version`) and compare to latest; if out of date, proceed to download.
6. Download matching binary to the install directory.
7. Add `eval "$(vex init)"` to the detected shell rc file.
8. Tell user: "Please restart your shell or log out and back in to use vex." No need to source rc file in the agent process.

## Workflows

### Inspect environment
- Detect shell (`$SHELL`, `$0`) and rc file
- Detect OS and architecture
- Print current `$PATH` and `~/.bio/bin` existence

### Determine install directory
- If `~/.bio/bin` exists → use it.
- Else → `mkdir -p ~/.local/share/bin` and use that.

### Ensure directory is in PATH
Check if the target directory is in `$PATH`:
```sh
echo "$PATH" | tr ':' '\n' | grep -q "<target_dir>" && echo "in PATH" || echo "NOT in PATH"
```
If NOT in PATH, append to rc file **before** the `vex init` line, e.g.:
```sh
echo 'export PATH="$HOME/.local/share/bin:$PATH"' >> ~/.bashrc
```

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

- Detected shell rc: `~/.zshrc`, `~/.bashrc`, `~/.config/fish/config.fish`, etc.
- Append `eval "$(vex init)"` (bash/zsh) or `vex init | source` (fish).
- If a new PATH export was added, ensure it comes **before** the vex init line.
- Inform user: "Please restart your shell or log back in for changes to take effect."
### Verify

- `which vex` → should resolve to the install directory.
- `vex version` (or `vex --version`) → check installed version.
- `vex path` → should print OS-specific bin directory.
- `vex list` → should run without error.

## Advanced features

See [REFERENCE.md](REFERENCE.md) for architecture mapping, troubleshooting, and uninstall steps.
