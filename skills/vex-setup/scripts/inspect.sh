#!/usr/bin/env bash
set -euo pipefail

# Robust shell detection
if [ -n "${ZSH_VERSION:-}" ]; then
    SHELL_NAME="zsh"
    CURRENT_SHELL="$(which zsh 2>/dev/null || echo zsh)"
elif [ -n "${BASH_VERSION:-}" ]; then
    SHELL_NAME="bash"
    CURRENT_SHELL="$(which bash 2>/dev/null || echo bash)"
else
    CURRENT_SHELL="${SHELL:-unknown}"
    SHELL_NAME="$(basename "$CURRENT_SHELL")"
fi

RC_FILE=""
case "$SHELL_NAME" in
  bash) RC_FILE="$HOME/.bashrc" ;;
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  fish) RC_FILE="$HOME/.config/fish/config.fish" ;;
  *)    RC_FILE="unknown" ;;
esac

echo "=== Environment Inspection ==="
echo "Shell: $CURRENT_SHELL"
echo "Shell name: $SHELL_NAME"
echo "Rc file: $RC_FILE"
echo "OS: $(uname -s)"
echo "Arch: $(uname -m)"
echo ""

echo "=== PATH ==="
echo "$PATH"
echo ""

echo "=== Directories ==="
[ -d "$HOME/.bio/bin" ] && echo "$HOME/.bio/bin: EXISTS" || echo "$HOME/.bio/bin: MISSING"
[ -d "$HOME/.local/share/bin" ] && echo "$HOME/.local/share/bin: EXISTS" || echo "$HOME/.local/share/bin: MISSING"
[ -d "$HOME/.local/share/vex" ] && echo "$HOME/.local/share/vex: EXISTS" || echo "$HOME/.local/share/vex: MISSING"
echo ""

echo "=== PATH contains ==="
echo "$PATH" | tr ':' '\n' | grep -E "\.bio/bin|\.local/share/bin" || echo "(none found)"
echo ""

echo "=== Vex ==="
if command -v vex &>/dev/null; then
    VEX_VERSION=$(vex version 2>/dev/null || echo 'version check failed')
    echo "Vex: $(which vex) ($VEX_VERSION)"
else
    echo "Vex: NOT FOUND"
fi
