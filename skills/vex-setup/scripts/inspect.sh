#!/usr/bin/env bash
set -euo pipefail

# Detect shell — prefer the user's login/choice over the agent process shell.
# On modern macOS, the default user shell is zsh even if the agent runs in bash.
if [ -n "${ZSH_VERSION:-}" ]; then
    SHELL_NAME="zsh"
    CURRENT_SHELL="$(which zsh 2>/dev/null || echo zsh)"
elif [ -n "${BASH_VERSION:-}" ]; then
    # If on a terminal and $SHELL points to zsh, trust $SHELL over the agent's bash
    if [ "$(uname -s)" = "Darwin" ] && [ "$(basename "${SHELL:-}" 2>/dev/null)" = "zsh" ]; then
        SHELL_NAME="zsh"
        CURRENT_SHELL="$SHELL"
    else
        SHELL_NAME="bash"
        CURRENT_SHELL="$(which bash 2>/dev/null || echo bash)"
    fi
else
    CURRENT_SHELL="${SHELL:-unknown}"
    SHELL_NAME="$(basename "$CURRENT_SHELL")"
fi

# Extra heuristic for macOS: if we still look like bash but ~/.zshrc exists and
# ~/.bashrc does not, the user almost certainly uses zsh.
if [ "$SHELL_NAME" = "bash" ] && [ "$(uname -s)" = "Darwin" ]; then
    if [ -f "$HOME/.zshrc" ] && [ ! -f "$HOME/.bashrc" ]; then
        SHELL_NAME="zsh"
        CURRENT_SHELL="${SHELL:-/bin/zsh}"
    fi
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
    VEX_VERSION=$(vex --version 2>/dev/null || echo 'version check failed')
    echo "Vex: $(which vex) ($VEX_VERSION)"
else
    echo "Vex: NOT FOUND"
fi
