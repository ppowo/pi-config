# vex Setup Reference

## Architecture mapping

| `uname -s` | `uname -m`      | Asset name                        |
|------------|-----------------|-----------------------------------|
| Darwin     | arm64           | `vex_darwin_arm64.tar.gz`         |
| Darwin     | x86_64          | `vex_darwin_amd64.tar.gz`         |
| Linux      | arm64 / aarch64 | `vex_linux_arm64.tar.gz`          |
| Linux      | x86_64 / amd64  | `vex_linux_amd64.tar.gz`          |

If architecture is unsupported, the user must compile from source (see vex repo).

## Download URL pattern

Latest release stable URL:
```
https://github.com/ppowo/vex/releases/latest/download/<ASSET_NAME>
```

Checksums file:
```
https://github.com/ppowo/vex/releases/latest/download/vex_checksums.txt
```

## Supported shells

This skill configures only bash and zsh.

| Shell | Rc file |
|-------|---------|
| bash  | `~/.bashrc` |
| zsh   | `${ZDOTDIR:-$HOME}/.zshrc` |

For any other shell, install the binary if requested but do not mutate shell rc files unless the user gives explicit manual instructions.

## Required persistent PATH entries

A new bash/zsh shell must contain both of these exact PATH entries:

1. The install directory containing the `vex` executable:
   - `~/.bio/bin`, if it already exists
   - otherwise `~/.local/share/bin`
2. The vex-managed directory printed by `vex path`:
   - macOS default: `~/.local/share/vex`
   - Linux default: `${XDG_DATA_HOME:-~/.local/share}/vex`

The install directory is persisted with an explicit `export PATH=...` line. The vex-managed directory is persisted by `eval "$(vex init)"`.

## Shell init snippet

Use a marked block. Replace any previous marked vex setup block rather than appending duplicates.

### Bash/zsh

```sh
# >>> vex setup >>>
# Keep the vex executable and vex-managed tools available in new shells.
export PATH="$HOME/.local/share/bin:$PATH"
eval "$(vex init)"
# <<< vex setup <<<
```

If `~/.bio/bin` is the selected install directory, use:

```sh
export PATH="$HOME/.bio/bin:$PATH"
```

## What `vex init` does

1. Exports several `PI_`-prefixed environment variables.
2. Creates an OS-dependent vex-managed directory:
   - macOS: `~/.local/share/vex`
   - Linux: `${XDG_DATA_HOME:-~/.local/share}/vex`
3. Prepends that directory to `$PATH`.

Keep the install directory export before `eval "$(vex init)"`; otherwise a fresh shell may not be able to find the `vex` executable before evaluating the init snippet.

## Troubleshooting

### Binary does not run (macOS "cannot verify developer")
Run: `xattr -d com.apple.quarantine <install_dir>/vex`

### `vex` exists but `command -v vex` returns nothing
Ensure the install directory is in `$PATH` before the `eval "$(vex init)"` line in the rc file.

### `vex path` is not in `$PATH` after shell restart
Ensure the rc file contains `eval "$(vex init)"` and that it runs after the install directory PATH export.

### Vex already installed
If vex is already present, run `vex --version` to check the installed version. Compare to the GitHub latest release; if outdated, proceed with upgrade. Verify the shell rc file contains the managed setup block before restarting shell.

### `vex` not found after shell restart
- Check the correct rc file for your shell login mode (e.g. `.zshrc` vs `.zprofile`).
- Run `source <rc-file>` explicitly to test.
- Verify the install directory appears in `$PATH` exactly, not only as a substring.

### `vex path` shows wrong directory
Ensure `XDG_DATA_HOME` is set on Linux if you want a non-default data location. If it is changed, restart the shell so `eval "$(vex init)"` recomputes the managed directory.

### Checksum mismatch
Delete downloaded tarball and retry. If still mismatched, do not install — report upstream.

## Uninstall

1. Remove the marked vex setup block from your shell rc file.
2. Delete the vex binary from the install directory (e.g. `~/.bio/bin/vex` or `~/.local/share/bin/vex`).
3. Delete the OS-specific data directory printed by `vex path`.
4. Optionally remove the PATH export line only if it is outside the managed block and nothing else uses that directory.
