#!/usr/bin/env bash
# Shared install step for cloud coding agents (Cursor Cloud Agents, Claude Code
# on the web, CI runners). Keep Cursor's environment.json "install" and the
# Claude cloud environment "setup script" as thin wrappers around this file so
# both agents get the same workspace.
#
# Idempotent: safe to rerun. Run from anywhere; it cds to the repo root.
set -u
cd "$(dirname "$0")/../.." || exit 1
export GIT_TERMINAL_PROMPT=0

yarn install --frozen-lockfile || yarn install || exit $?

# Read-only reference checkouts (see AGENTS.md "Layout"). Gitignored.
# Set SKIP_REFS=1 to skip them (e.g. short CI runs).
clone_ref() {
  dir="$1"
  url="$2"
  if [ -d "$dir/.git" ]; then
    return 0
  fi
  rm -rf "$dir"
  git clone --depth 1 --single-branch "$url" "$dir" \
    || echo "warn: could not clone $url into $dir" >&2
}

if [ "${SKIP_REFS:-0}" != "1" ]; then
  clone_ref .ref_apple-music-downloader https://github.com/zhaarey/apple-music-downloader.git
  clone_ref .ref_arr_scripts https://github.com/RandomNinjaAtk/arr-scripts.git
  clone_ref .ref_fluentui https://github.com/microsoft/fluentui.git
  clone_ref .ref_immich https://github.com/immich-app/immich.git
  clone_ref .ref_jellyfin https://github.com/jellyfin/jellyfin.git
  clone_ref .ref_kodi https://github.com/xbmc/xbmc.git
  clone_ref .ref_lidarr https://github.com/Lidarr/Lidarr.git
  clone_ref .ref_musicbrainz-docker https://github.com/metabrainz/musicbrainz-docker.git
  clone_ref .ref_picard https://github.com/metabrainz/picard.git
  clone_ref .ref_qbittorrent https://github.com/qbittorrent/qBittorrent.git
  clone_ref .ref_tidarr https://github.com/cstaelen/tidarr.git
  clone_ref .ref_tiddl https://github.com/oskvr37/tiddl.git
  clone_ref .ref_yt-dlp https://github.com/yt-dlp/yt-dlp.git
fi

mkdir -p library/stereo-music library/spatial-music library/music-videos downloads
exit 0
