#!/usr/bin/env bash
set -euo pipefail

TARGET_USER="node"
TARGET_GROUP="node"

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
  ensure_dir /config/runtime
  chown -R "$TARGET_USER:$TARGET_GROUP" /config /downloads
}

if [[ "$(id -u)" == "0" ]]; then
  configure_ids
  prepare_writable_dirs
  exec gosu "$TARGET_USER:$TARGET_GROUP" "$@"
fi

exec "$@"
