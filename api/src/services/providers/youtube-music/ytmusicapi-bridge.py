#!/usr/bin/env python3
"""Small JSON bridge between Discogenius and ytmusicapi.

The bridge intentionally owns no catalog state. It accepts one operation plus a
JSON object on stdin, performs the request, and emits exactly one JSON value on
stdout. Browser authentication, when configured, stays in the provider-owned
browser.json file and is handed directly to ytmusicapi.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from typing import Any, Iterable

from ytmusicapi import YTMusic


SEARCH_FILTERS = {
    "artists": "artists",
    "albums": "albums",
    "tracks": "songs",
    "videos": "videos",
}


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("bridge payload must be a JSON object")
    return parsed


def require_text(payload: dict[str, Any], key: str) -> str:
    value = str(payload.get(key) or "").strip()
    if not value:
        raise ValueError(f"{key} is required")
    return value


def section_results(section: Any) -> list[dict[str, Any]]:
    if isinstance(section, list):
        return [item for item in section if isinstance(item, dict)]
    if isinstance(section, dict):
        results = section.get("results")
        if isinstance(results, list):
            return [item for item in results if isinstance(item, dict)]
    return []


def get_artist_albums(api: YTMusic, artist_id: str) -> list[dict[str, Any]]:
    artist = api.get_artist(artist_id)
    albums: list[dict[str, Any]] = []
    seen: set[str] = set()
    for key in ("albums", "singles"):
        section = artist.get(key) if isinstance(artist, dict) else None
        items = section_results(section)
        if isinstance(section, dict) and section.get("params"):
            try:
                expanded = api.get_artist_albums(artist_id, section["params"])
                if isinstance(expanded, list):
                    items = [item for item in expanded if isinstance(item, dict)]
            except Exception:
                # The compact artist response is still useful when YouTube
                # changes or withholds the continuation parameters.
                pass
        for item in items:
            identity = str(item.get("browseId") or item.get("playlistId") or item.get("title") or "")
            if identity and identity not in seen:
                seen.add(identity)
                albums.append(item)
    return albums


# The artist "videos" section returns neither videoType nor duration, but we need
# both: videoType to drop audio-only (ATV) and user-generated (UGC) entries, and
# duration for the title+duration fingerprint that groups the SAME music video
# across TIDAL/Apple/YouTube. get_song() supplies both. Capped and best-effort, so
# a slow or rate-limited lookup degrades gracefully instead of failing a refresh.
VIDEO_ENRICH_LIMIT = 40

# ATV→OMV counterpart lookups (UI audio/video switcher) use get_watch_playlist.
# Cap per album so artist-wide refreshes cannot issue unbounded watch calls.
COUNTERPART_ENRICH_LIMIT = 40


def extract_watch_track(watch: Any, video_id: str) -> dict[str, Any] | None:
    tracks = watch.get("tracks") if isinstance(watch, dict) else None
    if not isinstance(tracks, list):
        return None
    match = next(
        (track for track in tracks if isinstance(track, dict) and track.get("videoId") == video_id),
        next((track for track in tracks if isinstance(track, dict)), None),
    )
    return match if isinstance(match, dict) else None


def extract_counterpart(watch: Any, video_id: str) -> dict[str, Any] | None:
    match = extract_watch_track(watch, video_id)
    if not isinstance(match, dict):
        return None
    counterpart = match.get("counterpart")
    if not isinstance(counterpart, dict):
        return None
    counterpart_id = str(counterpart.get("videoId") or "").strip()
    if not counterpart_id or counterpart_id == video_id:
        return None
    return counterpart


def is_official_music_video_type(video_type: Any) -> bool:
    normalized = str(video_type or "").strip().upper()
    if not normalized or "UGC" in normalized or "ATV" in normalized:
        return False
    return "OMV" in normalized or "OFFICIAL_SOURCE_MUSIC" in normalized or "MUSIC_VIDEO" in normalized


def get_track_counterparts(api: YTMusic, video_ids: Iterable[str]) -> dict[str, Any]:
    """Resolve ATV→OMV pairs, or mark album tracks that are already OMV.

    Some YouTube Music "albums" (especially singles) publish the official music
    video itself as the album track. Those have no separate counterpart id —
    the watch id is already OMV. Return that as a self-OMV counterpart so the
    TypeScript layer can persist a video offer alongside the stereo track.
    """
    counterparts: dict[str, Any] = {}
    seen: set[str] = set()
    for raw_id in video_ids:
        video_id = str(raw_id or "").strip()
        if not video_id or video_id in seen:
            continue
        seen.add(video_id)
        if len(seen) > COUNTERPART_ENRICH_LIMIT:
            counterparts[video_id] = None
            continue
        try:
            watch = api.get_watch_playlist(videoId=video_id, limit=1)
            counterpart = extract_counterpart(watch, video_id)
            if counterpart is not None:
                counterparts[video_id] = counterpart
                continue
            match = extract_watch_track(watch, video_id)
            video_type = (match or {}).get("videoType")
            if is_official_music_video_type(video_type):
                counterparts[video_id] = {
                    "videoId": video_id,
                    "videoType": video_type,
                    "kind": "yt-self-omv",
                }
            else:
                counterparts[video_id] = None
        except Exception:
            counterparts[video_id] = None
    return {"counterparts": counterparts}


def enrich_videos(api: YTMusic, videos: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for video in videos[:VIDEO_ENRICH_LIMIT]:
        if not isinstance(video, dict):
            continue
        if video.get("videoType") and video.get("duration_seconds"):
            continue
        video_id = video.get("videoId")
        if not video_id:
            continue
        try:
            details = api.get_song(str(video_id)).get("videoDetails") or {}
        except Exception:
            continue
        if not isinstance(details, dict):
            continue
        if not video.get("videoType") and details.get("musicVideoType"):
            video["videoType"] = details["musicVideoType"]
        if not video.get("duration_seconds") and details.get("lengthSeconds") is not None:
            try:
                video["duration_seconds"] = int(details["lengthSeconds"])
            except (TypeError, ValueError):
                pass
    return videos


def get_artist_videos(api: YTMusic, artist_id: str) -> list[dict[str, Any]]:
    artist = api.get_artist(artist_id)
    section = artist.get("videos") if isinstance(artist, dict) else None
    videos = section_results(section)
    if videos:
        return enrich_videos(api, videos)
    if isinstance(section, dict) and section.get("browseId"):
        playlist_id = str(section["browseId"])
        if playlist_id.startswith("VL"):
            playlist_id = playlist_id[2:]
        playlist = api.get_playlist(playlist_id, limit=None)
        return enrich_videos(
            api,
            section_results(playlist.get("tracks") if isinstance(playlist, dict) else None),
        )
    return []


def artist_entries(items: Iterable[Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        candidates = item.get("artists")
        if not isinstance(candidates, list):
            candidates = [item]
        for artist in candidates:
            if not isinstance(artist, dict):
                continue
            name = str(artist.get("name") or artist.get("artist") or "").strip()
            provider_id = str(artist.get("id") or artist.get("channelId") or artist.get("browseId") or "").strip()
            identity = provider_id or name.casefold()
            if not name or not identity or identity in seen:
                continue
            seen.add(identity)
            result.append(artist)
    return result


def list_import_sources(api: YTMusic) -> dict[str, Any]:
    return {
        "libraryArtists": api.get_library_artists(limit=1000),
        "playlists": api.get_library_playlists(limit=1000),
        "favoriteTracksAvailable": True,
    }


def get_import_artists(api: YTMusic, payload: dict[str, Any]) -> list[dict[str, Any]]:
    category = require_text(payload, "category")
    if category == "library-artists":
        return artist_entries(api.get_library_artists(limit=1000))
    if category == "playlist":
        playlist_id = require_text(payload, "listId")
        playlist = api.get_playlist(playlist_id, limit=None)
        tracks = playlist.get("tracks", []) if isinstance(playlist, dict) else []
        return artist_entries(tracks if isinstance(tracks, list) else [])
    if category == "favorite-tracks":
        liked = api.get_liked_songs(limit=5000)
        tracks = liked.get("tracks", []) if isinstance(liked, dict) else liked
        return artist_entries(tracks if isinstance(tracks, list) else [])
    raise ValueError(f"unsupported import category: {category}")


def lrc_timestamp(milliseconds: Any) -> str | None:
    try:
        total = max(0, int(milliseconds))
    except (TypeError, ValueError):
        return None
    minutes, remaining = divmod(total, 60_000)
    seconds, millis = divmod(remaining, 1_000)
    return f"[{minutes:02d}:{seconds:02d}.{millis // 10:02d}]"


def get_track_lyrics(api: YTMusic, video_id: str) -> dict[str, Any] | None:
    """Return provider-neutral plain and synchronized lyrics for a video id.

    ytmusicapi exposes the lyrics browse id through get_watch_playlist(). Its
    timestamped response contains LyricLine dataclasses, which json.dump would
    otherwise stringify into Python reprs. Convert those objects deliberately
    and emit ordinary LRC so the TypeScript provider contract stays stable.
    """
    watch = api.get_watch_playlist(videoId=video_id, limit=1)
    browse_id = watch.get("lyrics") if isinstance(watch, dict) else None
    if not browse_id:
        return None

    result = api.get_lyrics(str(browse_id), timestamps=True)
    if not isinstance(result, dict):
        return None

    raw_lines = result.get("lyrics")
    plain_lines: list[str] = []
    synced_lines: list[str] = []
    if isinstance(raw_lines, str):
        plain_lines = [line for line in raw_lines.splitlines() if line.strip()]
    elif isinstance(raw_lines, list):
        for raw_line in raw_lines:
            line = raw_line if isinstance(raw_line, dict) else vars(raw_line) if hasattr(raw_line, "__dict__") else {}
            lyric_text = str(line.get("text") or "").strip()
            if not lyric_text:
                continue
            plain_lines.append(lyric_text)
            timestamp = lrc_timestamp(line.get("start_time"))
            if timestamp:
                synced_lines.append(f"{timestamp}{lyric_text}")

    text = "\n".join(plain_lines).strip()
    subtitles = "\n".join(synced_lines).strip()
    if not text and not subtitles:
        return None
    return {
        "text": text,
        "subtitles": subtitles,
        "provider": str(result.get("source") or "YouTube Music"),
    }


def dispatch(api: YTMusic, operation: str, payload: dict[str, Any]) -> Any:
    if operation == "search":
        query = require_text(payload, "query")
        raw_types = payload.get("types")
        types = raw_types if isinstance(raw_types, list) else list(SEARCH_FILTERS)
        limit = max(1, min(int(payload.get("limit") or 10), 100))
        result: dict[str, Any] = {key: [] for key in SEARCH_FILTERS}
        for resource_type in types:
            if resource_type in SEARCH_FILTERS:
                result[resource_type] = api.search(
                    query,
                    filter=SEARCH_FILTERS[resource_type],
                    limit=limit,
                    ignore_spelling=True,
                )
        return result
    if operation == "get_artist":
        return api.get_artist(require_text(payload, "id"))
    if operation == "get_artist_albums":
        return get_artist_albums(api, require_text(payload, "id"))
    if operation == "get_artist_videos":
        return get_artist_videos(api, require_text(payload, "id"))
    if operation == "get_album":
        return api.get_album(require_text(payload, "id"))
    if operation == "get_track":
        video_id = require_text(payload, "id")
        player = api.get_song(video_id)
        try:
            watch = api.get_watch_playlist(videoId=video_id, limit=1)
            tracks = watch.get("tracks", []) if isinstance(watch, dict) else []
            match = next(
                (track for track in tracks if isinstance(track, dict) and track.get("videoId") == video_id),
                None,
            )
            if match:
                # Preserve player-only fields (thumbnail, exact duration) while
                # adding watch-playlist album/artist identity and OMV counterpart.
                merged = {**player, **match}
                counterpart = extract_counterpart(watch, video_id)
                if counterpart is not None:
                    merged["counterpart"] = counterpart
                return merged
        except Exception:
            pass
        return player
    if operation == "get_track_counterparts":
        ids = payload.get("ids")
        if not isinstance(ids, list):
            raise ValueError("ids must be a JSON array of video ids")
        return get_track_counterparts(api, [str(item) for item in ids])
    if operation == "get_video":
        return api.get_song(require_text(payload, "id"))
    if operation == "get_lyrics":
        return get_track_lyrics(api, require_text(payload, "id"))
    if operation == "list_import_sources":
        return list_import_sources(api)
    if operation == "get_import_artists":
        return get_import_artists(api, payload)
    raise ValueError(f"unsupported operation: {operation}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=(
        "search", "get_artist", "get_artist_albums", "get_artist_videos",
        "get_album", "get_track", "get_track_counterparts", "get_video", "get_lyrics",
        "list_import_sources", "get_import_artists",
    ))
    parser.add_argument("--headers")
    args = parser.parse_args()
    payload = read_payload()
    auth = args.headers if args.headers and os.path.isfile(args.headers) else None

    # Keep stdout machine-readable even if a dependency happens to log there.
    with contextlib.redirect_stdout(sys.stderr):
        api = YTMusic(auth)
        result = dispatch(api, args.operation, payload)
    json.dump(result, sys.stdout, ensure_ascii=False, default=str)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
