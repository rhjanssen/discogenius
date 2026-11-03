#!/usr/bin/env bash
# Shared install step for cloud & local coding agents (Cursor Cloud Agents,
# Claude Code on the web, Google Antigravity / Gemini CLI, CI runners). Keep
# Cursor's environment.json "install" and the Claude cloud environment "setup
# script" as thin wrappers around this file so all agents get the same workspace.
#
# Idempotent: safe to rerun. Run from anywhere; it cds to the repo root.
set -u
cd "$(dirname "$0")/../.." || exit 1
export GIT_TERMINAL_PROMPT=0

# Ensure native media tools (ffmpeg + fpcalc) exist on Ubuntu/Debian cloud VMs.
if command -v apt-get >/dev/null 2>&1; then
  missing_pkgs=()
  command -v ffmpeg >/dev/null 2>&1 || missing_pkgs+=(ffmpeg)
  command -v fpcalc >/dev/null 2>&1 || missing_pkgs+=(libchromaprint-tools)
  if [ "${#missing_pkgs[@]}" -gt 0 ]; then
    sudo_cmd=""
    if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
      sudo_cmd="sudo -n"
    fi
    DEBIAN_FRONTEND=noninteractive $sudo_cmd apt-get update -qq \
      && DEBIAN_FRONTEND=noninteractive $sudo_cmd apt-get install -y -qq "${missing_pkgs[@]}" \
      || echo "warn: could not auto-install ${missing_pkgs[*]}" >&2
  fi
fi

# Ensure python3 mutagen==1.47.0 is installed for API audio tag tests.
if command -v python3 >/dev/null 2>&1; then
  if ! python3 -c "import mutagen" >/dev/null 2>&1; then
    python3 -m pip install --quiet --break-system-packages 'mutagen==1.47.0' 2>/dev/null \
      || python3 -m pip install --quiet 'mutagen==1.47.0' 2>/dev/null \
      || echo "warn: could not auto-install python3 mutagen" >&2
  fi
fi

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
