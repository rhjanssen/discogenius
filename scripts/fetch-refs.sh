#!/usr/bin/env bash
# Fetch the read-only .ref_* checkouts that docs and agents consult.
#
# Idempotent: missing directories are shallow-cloned; existing git checkouts
# are reset to the upstream default branch. These trees are references, so
# local edits to tracked files are discarded on update.
#
# One upstream failure does not stop the others. The script exits 0 when at
# least one checkout is present, so a single outage does not fail Cloud Agent
# install. It exits 1 only when every checkout failed.
set -u

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

export GIT_TERMINAL_PROMPT=0

# directory<TAB>clone URL. Keep this list aligned with AGENTS.md.
refs=(
  $'.ref_lidarr\thttps://github.com/Lidarr/Lidarr.git'
  $'.ref_fluentui\thttps://github.com/microsoft/fluentui.git'
  $'.ref_jellyfin\thttps://github.com/jellyfin/jellyfin.git'
  $'.ref_musicbrainz-docker\thttps://github.com/metabrainz/musicbrainz-docker.git'
  $'.ref_tidarr\thttps://github.com/cstaelen/tidarr.git'
  $'.ref_tiddl\thttps://github.com/oskvr37/tiddl.git'
  $'.ref_yt-dlp\thttps://github.com/yt-dlp/yt-dlp.git'
  $'.ref_apple-music-downloader\thttps://github.com/zhaarey/apple-music-downloader.git'
)

if ! command -v git >/dev/null 2>&1; then
  echo "fetch-refs: git is required" >&2
  exit 1
fi

default_branch() {
  local url="$1"
  local symref
  symref="$(git ls-remote --symref "$url" HEAD | awk '$1 == "ref:" { print $2; exit }')"
  case "$symref" in
    refs/heads/*) ;;
    *)
      echo "fetch-refs: could not resolve default branch for $url" >&2
      return 1
      ;;
  esac
  local branch="${symref#refs/heads/}"
  case "$branch" in
    *[!A-Za-z0-9._/-]*|"")
      echo "fetch-refs: refusing unexpected branch name '$branch' for $url" >&2
      return 1
      ;;
  esac
  printf '%s\n' "$branch"
}

remove_ref_dir() {
  local dir="$1"
  if ! is_ref_dir "$dir"; then
    echo "fetch-refs: refusing to remove '$dir'" >&2
    return 1
  fi
  rm -rf -- "$dir"
}

clone_new() {
  local dir="$1"
  local url="$2"
  echo "fetch-refs: cloning $url -> $dir"
  if git clone --quiet --depth 1 --filter=blob:none --single-branch "$url" "$dir"; then
    return 0
  fi
  echo "fetch-refs: partial clone failed for $dir; retrying as a plain shallow clone" >&2
  remove_ref_dir "$dir"
  if git clone --quiet --depth 1 --single-branch "$url" "$dir"; then
    return 0
  fi
  remove_ref_dir "$dir"
  return 1
}

update_existing() {
  local dir="$1"
  local url="$2"
  local branch="$3"
  echo "fetch-refs: updating $dir ($branch)"
  if git -C "$dir" remote get-url origin >/dev/null 2>&1; then
    git -C "$dir" remote set-url origin "$url"
  else
    git -C "$dir" remote add origin "$url"
  fi
  if [[ -n "$(git -C "$dir" status --porcelain)" ]]; then
    echo "fetch-refs: $dir has local changes; resetting to upstream" >&2
  fi
  local refspec="+refs/heads/${branch}:refs/remotes/origin/${branch}"
  if ! git -C "$dir" fetch --quiet --depth 1 --filter=blob:none --no-tags origin "$refspec"; then
    echo "fetch-refs: filtered fetch failed for $dir; retrying without a blob filter" >&2
    git -C "$dir" fetch --quiet --depth 1 --no-tags origin "$refspec"
  fi
  git -C "$dir" checkout --quiet -f -B "$branch" "origin/${branch}"
}

is_ref_dir() {
  local dir="$1"
  [[ "$dir" =~ ^\.ref_[A-Za-z0-9._-]+$ ]]
}

fetch_one() {
  local dir="$1"
  local url="$2"
  if ! is_ref_dir "$dir"; then
    echo "fetch-refs: refusing unexpected directory name '$dir'" >&2
    return 1
  fi

  local branch
  branch="$(default_branch "$url")" || return 1

  if [[ -e "$dir/.git" ]]; then
    update_existing "$dir" "$url" "$branch" || return 1
  elif [[ -e "$dir" ]]; then
    if [[ -d "$dir" ]] && [[ -z "$(ls -A "$dir")" ]]; then
      rmdir -- "$dir"
      clone_new "$dir" "$url" || return 1
    else
      echo "fetch-refs: $dir exists and is not a git checkout; leaving it alone" >&2
      return 1
    fi
  else
    clone_new "$dir" "$url" || return 1
  fi

  local sha
  sha="$(git -C "$dir" rev-parse --short HEAD)"
  echo "fetch-refs: $dir @ $sha ($branch)"
}

ok=0
failed=0
for spec in "${refs[@]}"; do
  dir="${spec%%$'\t'*}"
  url="${spec#*$'\t'}"
  if (set -euo pipefail; fetch_one "$dir" "$url"); then
    ok=$((ok + 1))
  else
    echo "fetch-refs: FAILED $dir ($url)" >&2
    failed=$((failed + 1))
  fi
done

echo "fetch-refs: ${ok} ready, ${failed} failed"
if (( ok == 0 && failed > 0 )); then
  exit 1
fi
exit 0
