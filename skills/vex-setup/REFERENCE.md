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

## Shell-specific init snippets

### Bash (`~/.bashrc`)
```sh
eval "$(vex init)"
```

### Zsh (`~/.zshrc`)
```sh
eval "$(vex init)"
```

### Fish (`~/.config/fish/config.fish`)
```fish
vex init | source
```

## What `vex init` does

1. Exports several `PI_`-prefixed environment variables.
2. Creates an OS-dependent bin directory:
   - macOS: `~/.local/share/vex`
   - Linux: `${XDG_DATA_HOME:-~/.local/share}/vex`
3. Prepends that directory to `$PATH`.

## Troubleshooting

### Binary does not run (macOS "cannot verify developer")
Run: `xattr -d com.apple.quarantine <install_dir>/vex`

### `vex` exists but `which vex` returns nothing
Ensure the install directory is in `$PATH` **before** the `eval "$(vex init)"` line in rc file.
### Vex already installed
If vex is already present, run `vex version` to check the installed version. Compare to the GitHub latest release; if outdated, proceed with upgrade. Verify the shell rc file contains the correct `vex init` line before restarting shell.

### `vex` not found after shell restart
- Check the correct rc file for your shell login mode (e.g. `.zshrc` vs `.zprofile`).
- Run `source <rc-file>` explicitly to test.

### `vex path` shows wrong directory
Ensure `XDG_DATA_HOME` is set on Linux if you want a non-default data location.

### Checksum mismatch
Delete downloaded tarball and retry. If still mismatched, do not install — report upstream.

## Uninstall

1. Remove `eval "$(vex init)"` (or fish equivalent) from your shell rc.
2. Delete the vex binary from the install directory (e.g. `~/.bio/bin/vex` or `~/.local/share/bin/vex`).
3. Delete the OS-specific data directory printed by `vex path`.
4. Optionally remove the PATH export line from rc if nothing else uses that directory.
