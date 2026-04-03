# npm run setup generates ~/.config/pi/nushell/config.nu at bootstrap time.
# It discovers optional Nushell plugins on PATH, registers them into
# ~/.config/pi/nushell/plugins.msgpackz, and emits machine-specific
# `plugin use --plugin-config ...` lines only for plugins that were found.
