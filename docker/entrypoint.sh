#!/usr/bin/env bash
set -euo pipefail

TARGET_USER="node"
TARGET_GROUP="node"
CONFIG_WRITE_PROBE='
set -euo pipefail
db_path="/config/discogenius.db"
probe="/config/.discogenius-write-check.$$"

if [[ ! -d /config ]]; then
  echo "[ENTRYPOINT] Missing /config mount." >&2
  exit 1
fi

if [[ ! -w /config ]]; then
  echo "[ENTRYPOINT] /config is not writable." >&2
  exit 1
fi

if [[ -e "$db_path" && ! -w "$db_path" ]]; then
  echo "[ENTRYPOINT] $db_path is not writable." >&2
  exit 1
fi

for sidecar in "$db_path-wal" "$db_path-shm"; do
  if [[ -e "$sidecar" && ! -w "$sidecar" ]]; then
    echo "[ENTRYPOINT] $sidecar is not writable." >&2
    exit 1
  fi
done

: > "$probe"
rm -f "$probe"
'

umask 0002

ensure_dir() {
  local dir="$1"
  mkdir -p "$dir"
}

configure_ids() {
  local desired_uid="${PUID:-}"
  local desired_gid="${PGID:-}"

  if [[ -n "$desired_gid" ]] && [[ "$desired_gid" != "$(getent group "$TARGET_GROUP" | cut -d: -f3)" ]]; then
    groupmod -o -g "$desired_gid" "$TARGET_GROUP"
  fi

  if [[ -n "$desired_uid" ]] && [[ "$desired_uid" != "$(id -u "$TARGET_USER")" ]]; then
    usermod -o -u "$desired_uid" -g "$TARGET_GROUP" "$TARGET_USER"
  fi
}

prepare_writable_dirs() {
  ensure_dir /config
  ensure_dir /downloads
  ensure_dir /library

  # Clean up stale runtime dir from pre-1.2 installations (Orpheus is now baked into the image)
  if [[ -d /config/runtime ]]; then
    rm -rf /config/runtime
  fi

  if ! chown -R "$TARGET_USER:$TARGET_GROUP" /config /downloads; then
    echo "[ENTRYPOINT] Warning: failed to normalize ownership for /config or /downloads." >&2
  fi

  if ! chmod -R u+rwX,g+rwX /config /downloads; then
    echo "[ENTRYPOINT] Warning: failed to normalize mode bits for /config or /downloads." >&2
  fi
}

print_config_diagnostics() {
  echo "[ENTRYPOINT] Runtime user: $(id -u):$(id -g)" >&2
  ls -ld /config >&2 || true
  ls -l /config/discogenius.db* >&2 || true
}

verify_target_config_writable() {
  gosu "$TARGET_USER:$TARGET_GROUP" bash -lc "$CONFIG_WRITE_PROBE"
}

verify_current_config_writable() {
  bash -lc "$CONFIG_WRITE_PROBE"
}

fail_with_config_help() {
  local mode="$1"

  echo "[ENTRYPOINT] Discogenius requires a writable /config directory for SQLite, tokens, and runtime state." >&2
  if [[ "$mode" == "root-managed" ]]; then
    echo "[ENTRYPOINT] If you are using TrueNAS, leave Custom User unset when relying on PUID/PGID so the entrypoint can normalize ownership." >&2
  else
    echo "[ENTRYPOINT] If you are using a Custom User on TrueNAS, make sure the /config dataset is writable by that exact UID/GID." >&2
  fi

  print_config_diagnostics
}

if [[ "$(id -u)" == "0" ]]; then
  configure_ids
  prepare_writable_dirs

  if ! verify_target_config_writable; then
    fail_with_config_help "root-managed"
    gosu "$TARGET_USER:$TARGET_GROUP" sh -lc 'id; ls -ld /config; ls -l /config/discogenius.db* 2>/dev/null || true' >&2 || true
    exit 70
  fi

  exec gosu "$TARGET_USER:$TARGET_GROUP" "$@"
fi

if ! verify_current_config_writable; then
  fail_with_config_help "current-user"
  exit 70
fi

exec "$@"
