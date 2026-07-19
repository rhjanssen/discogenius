#!/usr/bin/env python3
"""Replace embedded audio cover art without rewriting audio streams or tags."""

from __future__ import annotations

import base64
import json
import os
import sys

from mutagen.flac import FLAC, Picture
from mutagen.id3 import APIC, ID3, ID3NoHeaderError
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis


def image_details(path: str) -> tuple[bytes, str, int]:
    with open(path, "rb") as handle:
        data = handle.read()
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return data, "image/png", MP4Cover.FORMAT_PNG
    return data, "image/jpeg", MP4Cover.FORMAT_JPEG


def picture_block(data: bytes, mime: str) -> Picture:
    picture = Picture()
    picture.type = 3  # front cover
    picture.mime = mime
    picture.desc = "Cover (front)"
    picture.data = data
    return picture


def replace_cover(media_path: str, cover_path: str) -> None:
    data, mime, mp4_format = image_details(cover_path)
    extension = os.path.splitext(media_path)[1].lower()

    if extension in {".m4a", ".m4b", ".m4p", ".mp4"}:
        audio = MP4(media_path)
        if audio.tags is None:
            audio.add_tags()
        audio.tags["covr"] = [MP4Cover(data, imageformat=mp4_format)]
        audio.save()
        return

    if extension == ".flac":
        audio = FLAC(media_path)
        audio.clear_pictures()
        audio.add_picture(picture_block(data, mime))
        audio.save()
        return

    if extension == ".mp3":
        try:
            tags = ID3(media_path)
        except ID3NoHeaderError:
            tags = ID3()
        tags.delall("APIC")
        tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover (front)", data=data))
        tags.save(media_path, v2_version=3)
        # Ensure Mutagen can still parse the audio after the in-place ID3 write.
        MP3(media_path)
        return

    if extension in {".ogg", ".oga", ".opus"}:
        audio = OggOpus(media_path) if extension == ".opus" else OggVorbis(media_path)
        encoded = base64.b64encode(picture_block(data, mime).write()).decode("ascii")
        audio["metadata_block_picture"] = [encoded]
        audio.save()
        return

    raise ValueError(f"Unsupported embedded-cover container: {extension or '(none)'}")


MP4_STRING_KEYS = {
    "title": "\xa9nam",
    "artist": "\xa9ART",
    "album_artist": "aART",
    "album": "\xa9alb",
    "date": "\xa9day",
    "year": "\xa9day",
    "comment": "\xa9cmt",
    "copyright": "cprt",
    "genre": "\xa9gen",
    "composer": "\xa9wrt",
    "lyrics": "\xa9lyr",
    "lyrics-eng": "\xa9lyr",
    # ffmpeg accepts the friendly metadata names and maps them to the native
    # iTunes atoms. Mutagen requires those atoms explicitly.
    "track": "trkn",
    "disc": "disk",
}


def mp4_key(raw_key: str) -> str:
    return MP4_STRING_KEYS.get(raw_key.lower(), raw_key)


def mp4_value(key: str, value: str):
    if key.startswith("----:"):
        return [value.encode("utf-8")]
    if key in {"trkn", "disk"}:
        parts = value.split("/", 1)
        current = int(parts[0] or 0)
        total = int(parts[1] or 0) if len(parts) > 1 else 0
        return [(current, total)]
    return [value]


def write_mp4_metadata(media_path: str, payload_path: str) -> None:
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    audio = MP4(media_path)
    if audio.tags is None:
        audio.add_tags()
    for raw_key in payload.get("removeKeys", []):
        audio.tags.pop(mp4_key(str(raw_key)), None)
    for raw_key, raw_value in payload.get("tags", {}).items():
        value = str(raw_value)
        if not value:
            continue
        key = mp4_key(str(raw_key))
        audio.tags[key] = mp4_value(key, value)
    audio.save()


def clear_mp4_metadata(media_path: str) -> None:
    audio = MP4(media_path)
    retained_cover = list((audio.tags or {}).get("covr", []))
    if audio.tags is None:
        audio.add_tags()
    else:
        audio.tags.clear()
    if retained_cover:
        audio.tags["covr"] = retained_cover
    audio.save()


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit("usage: mutagen-cover-bridge.py cover|metadata|clear MEDIA_PATH [INPUT]")
    command = sys.argv[1]
    if command == "cover" and len(sys.argv) == 4:
        replace_cover(sys.argv[2], sys.argv[3])
    elif command == "metadata" and len(sys.argv) == 4:
        write_mp4_metadata(sys.argv[2], sys.argv[3])
    elif command == "clear" and len(sys.argv) == 3:
        clear_mp4_metadata(sys.argv[2])
    else:
        raise SystemExit("invalid arguments")
