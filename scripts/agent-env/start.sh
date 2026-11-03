#!/usr/bin/env bash
# Shared start step for cloud coding agents: runs the dev stack
# (API on 127.0.0.1:3737, Vite on 127.0.0.1:8080) against repo-local library
# roots. Exits immediately when both are already up; otherwise runs `yarn dev`
# in the foreground, so agents start it as a background process.
cd "$(dirname "$0")/../.." || exit 1
unset PORT
mkdir -p library/stereo-music library/spatial-music library/music-videos downloads
export MUSIC_PATH="$PWD/library/stereo-music"
export SPATIAL_PATH="$PWD/library/spatial-music"
export VIDEO_PATH="$PWD/library/music-videos"
export DOWNLOAD_PATH="$PWD/downloads"
# Vite listens on "::" by default; fall back to IPv4 when the kernel has no IPv6.
if [ -z "${DISCOGENIUS_DEV_HOST:-}" ] && [ ! -e /proc/net/if_inet6 ]; then
  export DISCOGENIUS_DEV_HOST=0.0.0.0
fi
if curl -sf --max-time 2 http://127.0.0.1:3737/ping >/dev/null \
  && curl -sf --max-time 2 -o /dev/null http://127.0.0.1:8080/; then
  exit 0
fi
exec yarn dev
