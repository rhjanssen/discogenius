#!/usr/bin/env bash
set -euo pipefail

TARGET_USER="node"
TARGET_GROUP="node"

# The database does not have to live under /config. Keeping SQLite on a named
# volume rather than a Docker Desktop bind mount is what stops the host
# filesystem from breaking its locking guarantees, so every check below follows
# DB_PATH instead of assuming a location.
DB_PATH="${DB_PATH:-/config/discogenius.db}"
DB_DIR="$(dirname "$DB_PATH")"
export DB_PATH DB_DIR

CONFIG_WRITE_PROBE='
set -euo pipefail
db_path="${DB_PATH:-/config/discogenius.db}"
db_dir="$(dirname "$db_path")"
probe="$db_dir/.discogenius-write-check.$$"

for required in /config "$db_dir"; do
  if [[ ! -d "$required" ]]; then
    echo "[ENTRYPOINT] Missing $required mount." >&2
    exit 1
  fi

  if [[ ! -w "$required" ]]; then
    echo "[ENTRYPOINT] $required is not writable." >&2
    exit 1
  fi
done

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

for dir in /downloads /library; do
  if [[ ! -d "$dir" ]]; then
    echo "[ENTRYPOINT] Missing $dir mount." >&2
    exit 1
  fi

  if [[ ! -w "$dir" ]]; then
    echo "[ENTRYPOINT] $dir is not writable." >&2
    exit 1
  fi

  probe="$dir/.discogenius-write-check.$$"
  : > "$probe"
  rm -f "$probe"
done
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
  local want_uid want_gid
  want_uid="$(id -u "$TARGET_USER")"
  want_gid="$(getent group "$TARGET_GROUP" | cut -d: -f3)"

  # Known managed dirs are (re)created here as root. mkdir leaves them root-owned,
  # so each must be shallow-chowned to the runtime user — otherwise the app (running
  # as TARGET_USER) cannot mkdir the per-artist subdirs inside them (EACCES). This
  # is O(1) and independent of the deep-recursion decision below.
  local managed_dir
  for managed_dir in /config "$DB_DIR" /downloads /library \
      /library/stereo-music /library/spatial-music /library/music-videos; do
    ensure_dir "$managed_dir"
    chown "$TARGET_USER:$TARGET_GROUP" "$managed_dir" 2>/dev/null || true
    chmod u+rwX,g+rwX "$managed_dir" 2>/dev/null || true
  done

  # Clean up stale runtime dirs from pre-2.0 installations (Orpheus/tidal-dl-ng era)
  for stale in /config/runtime /config/orpheusdl /config/tidal_dl_ng-dev; do
    if [[ -d "$stale" ]]; then
      rm -rf "$stale"
    fi
  done

  # Recursive chown/chmod over /downloads and /library is O(files) and becomes
  # pathologically slow on large libraries (minutes-to-tens-of-minutes on Docker
  # Desktop bind mounts), blocking startup every boot. The app writes its own
  # files as TARGET_USER, so a full recursive pass is only needed on first run or
  # after a PUID/PGID change. Detect that by the top-level dir's owner and only
  # recurse when it differs; otherwise the shallow chown above already keeps the
  # mount root + managed subdirs writable.

  normalize_tree() {
    local dir="$1"
    local cur_uid cur_gid
    cur_uid="$(stat -c %u "$dir" 2>/dev/null || echo -1)"
    cur_gid="$(stat -c %g "$dir" 2>/dev/null || echo -1)"

    if [[ "$cur_uid" != "$want_uid" || "$cur_gid" != "$want_gid" ]]; then
      if ! chown -R "$TARGET_USER:$TARGET_GROUP" "$dir"; then
        echo "[ENTRYPOINT] Warning: failed to normalize ownership for $dir." >&2
      fi
      if ! chmod -R u+rwX,g+rwX "$dir"; then
        echo "[ENTRYPOINT] Warning: failed to normalize mode bits for $dir." >&2
      fi
    else
      # Already owned by the runtime user — just keep the mount root writable.
      chown "$TARGET_USER:$TARGET_GROUP" "$dir" 2>/dev/null || true
      chmod u+rwX,g+rwX "$dir" 2>/dev/null || true
    fi
  }

  normalize_tree /config
  normalize_tree "$DB_DIR"
  normalize_tree /downloads
  normalize_tree /library
}

print_config_diagnostics() {
  echo "[ENTRYPOINT] Runtime user: $(id -u):$(id -g)" >&2
  ls -ld /config >&2 || true
  ls -ld "$DB_DIR" >&2 || true
  ls -ld /downloads >&2 || true
  ls -ld /library >&2 || true
  ls -l "$DB_PATH"* >&2 || true
}

verify_target_config_writable() {
  gosu "$TARGET_USER:$TARGET_GROUP" bash -lc "$CONFIG_WRITE_PROBE"
}

verify_current_config_writable() {
  bash -lc "$CONFIG_WRITE_PROBE"
}

fail_with_config_help() {
  local mode="$1"

  echo "[ENTRYPOINT] Discogenius requires writable /config, $DB_DIR, /downloads, and /library directories for settings, SQLite, downloads, imports, and organized media." >&2
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
    gosu "$TARGET_USER:$TARGET_GROUP" sh -lc 'id; ls -ld /config "$DB_DIR"; ls -l "$DB_PATH"* 2>/dev/null || true' >&2 || true
    exit 70
  fi

  exec gosu "$TARGET_USER:$TARGET_GROUP" "$@"
fi

if ! verify_current_config_writable; then
  fail_with_config_help "current-user"
  exit 70
fi

exec "$@"
