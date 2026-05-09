#!/usr/bin/env bash
set -euo pipefail

START_MARKER="# >>> vex setup >>>"
END_MARKER="# <<< vex setup <<<"
DRY_RUN=0
CONFIGURE_RC=1

usage() {
    cat <<'USAGE'
Usage: install.sh [--dry-run] [--no-rc]

Install or update vex from the latest GitHub release and configure bash/zsh PATH.

Options:
  --dry-run  Print the planned install and rc-file block without changing files.
  --no-rc    Install/update the vex binary only; do not edit shell rc files.
USAGE
}

log() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      --no-rc) CONFIGURE_RC=0 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown argument: $arg" ;;
    esac
done

if [ -n "${SHELL:-}" ]; then
    SHELL_NAME="$(basename "$SHELL")"
elif [ -n "${ZSH_VERSION:-}" ]; then
    SHELL_NAME="zsh"
elif [ -n "${BASH_VERSION:-}" ]; then
    SHELL_NAME="bash"
else
    SHELL_NAME="unknown"
fi

case "$SHELL_NAME" in
  bash) RC_FILE="$HOME/.bashrc" ;;
  zsh)  RC_FILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
  *)
    if [ "$CONFIGURE_RC" -eq 1 ]; then
        die "unsupported shell '$SHELL_NAME'; this skill only configures bash and zsh (rerun with --no-rc to install binary only)"
    fi
    RC_FILE="unsupported"
    ;;
esac

OS_NAME="$(uname -s)"
ARCH_NAME="$(uname -m)"
case "$OS_NAME/$ARCH_NAME" in
  Darwin/arm64) ASSET="vex_darwin_arm64.tar.gz" ;;
  Darwin/x86_64) ASSET="vex_darwin_amd64.tar.gz" ;;
  Linux/arm64|Linux/aarch64) ASSET="vex_linux_arm64.tar.gz" ;;
  Linux/x86_64|Linux/amd64) ASSET="vex_linux_amd64.tar.gz" ;;
  *) die "unsupported OS/architecture: $OS_NAME/$ARCH_NAME" ;;
esac
DOWNLOAD_URL="https://github.com/ppowo/vex/releases/latest/download/$ASSET"

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

path_for_rc() {
    local path="$1"
    local prefix="$HOME/"
    local home_literal="\$HOME"
    if [ "$path" = "$HOME" ]; then
        printf '%s' "$home_literal"
    elif [[ "$path" == "$prefix"* ]]; then
        printf '%s/%s' "$home_literal" "${path#"$prefix"}"
    else
        printf '%s' "$path"
    fi
}

render_rc_block() {
    local install_expr="$1"
    cat <<EOF
$START_MARKER
# Keep the vex executable and vex-managed tools available in new shells.
export PATH="$install_expr:\$PATH"
eval "\$(vex init)"
$END_MARKER
EOF
}

configure_rc_file() {
    local rc_file="$1"
    local install_expr="$2"
    local rc_dir backup tmp

    rc_dir="$(dirname "$rc_file")"
    mkdir -p "$rc_dir"
    touch "$rc_file"

    backup="$rc_file.bak.vex-setup-$(date +%Y%m%d%H%M%S)"
    cp "$rc_file" "$backup"

    tmp="$(mktemp)"
    awk -v start="$START_MARKER" -v end="$END_MARKER" '
        $0 == start { skip = 1; next }
        $0 == end { skip = 0; next }
        skip != 1 { print }
    ' "$rc_file" > "$tmp"

    {
        cat "$tmp"
        printf '\n'
        render_rc_block "$install_expr"
    } > "$rc_file"
    rm -f "$tmp"

    log "Updated rc file: $rc_file"
    log "Backup written: $backup"
}

INSTALL_EXPR="$(path_for_rc "$INSTALL_DIR")"

log "Shell: $SHELL_NAME"
log "Rc file: $RC_FILE"
log "Asset: $ASSET"
log "Install dir: $INSTALL_DIR"
log "Default vex-managed dir: $DEFAULT_VEX_DIR"
log "Download URL: $DOWNLOAD_URL"

if [ "$DRY_RUN" -eq 1 ]; then
    log ""
    log "Dry run; no files changed. Rc block would be:"
    render_rc_block "$INSTALL_EXPR"
    exit 0
fi

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

mkdir -p "$INSTALL_DIR"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
archive="$tmpdir/$ASSET"

log "Downloading vex..."
curl -fL -o "$archive" "$DOWNLOAD_URL"

tar -xzf "$archive" -C "$tmpdir"
VEX_CANDIDATE="$(find "$tmpdir" -type f -name vex -print -quit)"
[ -n "$VEX_CANDIDATE" ] || die "downloaded archive did not contain a vex binary"

if command -v install >/dev/null 2>&1; then
    install -m 0755 "$VEX_CANDIDATE" "$INSTALL_DIR/vex"
else
    cp "$VEX_CANDIDATE" "$INSTALL_DIR/vex"
    chmod +x "$INSTALL_DIR/vex"
fi

VEX_DIR="$DEFAULT_VEX_DIR"
DETECTED_VEX_DIR="$("$INSTALL_DIR/vex" path 2>/dev/null || true)"
if [ -n "$DETECTED_VEX_DIR" ]; then
    VEX_DIR="$DETECTED_VEX_DIR"
fi
[ "$VEX_DIR" = "unknown" ] || mkdir -p "$VEX_DIR"

if [ "$CONFIGURE_RC" -eq 1 ]; then
    configure_rc_file "$RC_FILE" "$INSTALL_EXPR"
else
    log "Skipping rc-file configuration (--no-rc)."
fi

log ""
log "Installed vex: $INSTALL_DIR/vex"
log "Version: $("$INSTALL_DIR/vex" --version 2>/dev/null || echo 'version check failed')"
log "Vex-managed dir: $VEX_DIR"
log ""
log "Restart your shell or log out and back in. Then verify:"
log "  command -v vex"
log "  vex --version"
log "  vex_dir=\"\$(vex path)\""
log "  printf '%s\\n' \"\$PATH\" | tr ':' '\\n' | grep -Fx \"\$(dirname \"\$(command -v vex)\")\""
log "  printf '%s\\n' \"\$PATH\" | tr ':' '\\n' | grep -Fx \"\$vex_dir\""
