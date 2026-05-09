#!/usr/bin/env bash
set -euo pipefail

# Detect the user's preferred shell, not just the agent process shell.
if [ -n "${SHELL:-}" ]; then
    CURRENT_SHELL="$SHELL"
    SHELL_NAME="$(basename "$SHELL")"
elif [ -n "${ZSH_VERSION:-}" ]; then
    CURRENT_SHELL="$(command -v zsh 2>/dev/null || echo zsh)"
    SHELL_NAME="zsh"
elif [ -n "${BASH_VERSION:-}" ]; then
    CURRENT_SHELL="$(command -v bash 2>/dev/null || echo bash)"
    SHELL_NAME="bash"
else
    CURRENT_SHELL="unknown"
    SHELL_NAME="unknown"
fi

case "$SHELL_NAME" in
  bash) RC_FILE="$HOME/.bashrc" ;;
  zsh)  RC_FILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
  *)    RC_FILE="unsupported" ;;
esac

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"

if [ -d "$HOME/.bio/bin" ]; then
    INSTALL_DIR="$HOME/.bio/bin"
else
    INSTALL_DIR="$HOME/.local/share/bin"
fi

case "$OS_NAME" in
  Darwin) DEFAULT_VEX_DIR="$HOME/.local/share/vex" ;;
  Linux)  DEFAULT_VEX_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/vex" ;;
  *)      DEFAULT_VEX_DIR="unknown" ;;
esac

VEX_BIN=""
VEX_VERSION=""
VEX_DIR="$DEFAULT_VEX_DIR"
if command -v vex >/dev/null 2>&1; then
    VEX_BIN="$(command -v vex)"
    VEX_VERSION="$(vex --version 2>/dev/null || echo 'version check failed')"
    DETECTED_VEX_DIR="$(vex path 2>/dev/null || true)"
    if [ -n "$DETECTED_VEX_DIR" ]; then
        VEX_DIR="$DETECTED_VEX_DIR"
    fi
fi

path_contains() {
    case ":$PATH:" in
      *":$1:"*) return 0 ;;
      *) return 1 ;;
    esac
}

print_path_status() {
    label="$1"
    dir="$2"
    if [ "$dir" = "unknown" ] || [ -z "$dir" ]; then
        echo "$label: unknown"
    elif path_contains "$dir"; then
        echo "$label: in PATH ($dir)"
    else
        echo "$label: NOT in PATH ($dir)"
    fi
}

echo "=== Environment Inspection ==="
echo "Shell: $CURRENT_SHELL"
echo "Shell name: $SHELL_NAME"
echo "Shell support: $([ "$SHELL_NAME" = "bash" ] || [ "$SHELL_NAME" = "zsh" ] && echo supported || echo unsupported)"
echo "Rc file: $RC_FILE"
echo "OS: $OS_NAME"
echo "Arch: $ARCH_NAME"
echo ""

echo "=== PATH ==="
echo "$PATH"
echo ""

echo "=== Required directories ==="
echo "Install dir: $INSTALL_DIR"
echo "Vex-managed dir: $VEX_DIR"
[ -d "$HOME/.bio/bin" ] && echo "$HOME/.bio/bin: EXISTS" || echo "$HOME/.bio/bin: MISSING"
[ -d "$HOME/.local/share/bin" ] && echo "$HOME/.local/share/bin: EXISTS" || echo "$HOME/.local/share/bin: MISSING"
[ "$VEX_DIR" != "unknown" ] && [ -d "$VEX_DIR" ] && echo "$VEX_DIR: EXISTS" || true
[ "$VEX_DIR" != "unknown" ] && [ ! -d "$VEX_DIR" ] && echo "$VEX_DIR: MISSING" || true
echo ""

echo "=== PATH contains required dirs ==="
print_path_status "Install dir" "$INSTALL_DIR"
print_path_status "Vex-managed dir" "$VEX_DIR"
echo ""

echo "=== Vex ==="
if [ -n "$VEX_BIN" ]; then
    echo "Vex: $VEX_BIN ($VEX_VERSION)"
    echo "vex path: $VEX_DIR"
else
    echo "Vex: NOT FOUND"
fi
