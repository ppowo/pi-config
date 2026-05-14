#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
REPO_URL="${PI_CONFIG_REPO_URL:-git@github.com:ppowo/pi-config.git}"
TARGET="${PI_CONFIG_TARGET:-$HOME/Developer/pi-config}"
DEVELOPER_DIR="$(dirname "$TARGET")"

usage() {
  cat <<'USAGE'
Usage: setup-pi-config.sh [--dry-run] [--help]

Clone or update ppowo/pi-config into $HOME/Developer/pi-config, then run npm run setup.

Environment overrides:
  PI_CONFIG_REPO_URL   Repository URL to clone (default: git@github.com:ppowo/pi-config.git)
  PI_CONFIG_TARGET     Target directory (default: $HOME/Developer/pi-config)
USAGE
}

log() {
  printf '[pi-config-setup] %s\n' "$*"
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

normalize_url() {
  local url="$1"
  url="${url%.git}"
  case "$url" in
    git@github.com:ppowo/pi-config|https://github.com/ppowo/pi-config) echo "ppowo/pi-config" ;;
    *) echo "$url" ;;
  esac
}

remote_matches_expected_repo() {
  local actual="$1"
  [[ "$(normalize_url "$actual")" == "$(normalize_url "$REPO_URL")" ]] || \
    [[ "$(normalize_url "$actual")" == "ppowo/pi-config" ]]
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

log "Repository: $REPO_URL"
log "Target: $TARGET"

if ! command -v git >/dev/null 2>&1; then
  log "ERROR: git is not installed or not on PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  log "ERROR: npm is not installed or not on PATH."
  exit 1
fi

if [[ -e "$TARGET" && ! -d "$TARGET" ]]; then
  log "ERROR: target exists but is not a directory: $TARGET"
  exit 1
fi

if [[ ! -d "$TARGET" ]]; then
  log "Cloning repository into target directory."
  run mkdir -p "$DEVELOPER_DIR"
  run git clone "$REPO_URL" "$TARGET"
else
  if [[ ! -d "$TARGET/.git" ]]; then
    log "ERROR: target exists but is not a git repository: $TARGET"
    log "Move it aside or set PI_CONFIG_TARGET to a different directory."
    exit 1
  fi

  origin_url="$(git -C "$TARGET" remote get-url origin 2>/dev/null || true)"
  if [[ -z "$origin_url" ]]; then
    log "ERROR: existing repository has no origin remote: $TARGET"
    exit 1
  fi

  if ! remote_matches_expected_repo "$origin_url"; then
    log "ERROR: target origin does not look like ppowo/pi-config."
    log "  target: $TARGET"
    log "  origin: $origin_url"
    log "  expected: $REPO_URL"
    exit 1
  fi

  log "Updating existing repository with git pull --ff-only."
  run git -C "$TARGET" pull --ff-only
fi

log "Running npm run setup."
run npm --prefix "$TARGET" run setup

log "Done."
log "Next step: in interactive pi, run /reload to load the updated configuration."
