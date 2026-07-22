#!/usr/bin/env python3
"""Run tiddl while emitting Discogenius-readable per-item progress.

This is intentionally a thin provider-side wrapper. It monkey-patches tiddl's
download progress hooks at runtime and leaves Discogenius core unaware of tiddl.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
import time
from typing import Any

PROGRESS_PREFIX = "DISCOGENIUS_TIDDL_PROGRESS "
RICH_TAG_RE = re.compile(r"\[[^\]]+\]")


def clean_description(value: str) -> str:
    return " ".join(RICH_TAG_RE.sub("", value).split())


def emit_progress(event: str, **payload: Any) -> None:
    data = {"event": event, **payload}
    # Single write call: print() issues separate writes for text and newline,
    # and ffmpeg/tiddl output sharing this stderr pipe can interleave between
    # them, splitting the JSON line. One write <= PIPE_BUF is atomic on a pipe.
    sys.stderr.write(PROGRESS_PREFIX + json.dumps(data, separators=(",", ":")) + "\n")
    sys.stderr.flush()


def install_video_metadata_guard() -> None:
    """TIDAL sometimes returns video.artists=None; upstream iterates it bare.

    Must run before tiddl's download CLI imports add_video_metadata, so the
    patched function is what the download command binds.
    """
    from pathlib import Path

    from mutagen.easymp4 import EasyMP4 as MutagenEasyMP4
    from tiddl.core.api.models import Video
    from tiddl.core.metadata import video as video_metadata
    import tiddl.core.metadata as metadata_pkg

    def add_video_metadata(path: Path, video: Video) -> None:
        mutagen = MutagenEasyMP4(path)
        artists = video.artists or []
        mutagen.update(
            {
                "title": video.title,
                "artist": "; ".join(artist.name.strip() for artist in artists),
            }
        )

        if video.artist:
            mutagen["albumartist"] = video.artist.name

        if video.album:
            mutagen["album"] = video.album.title

        if video.streamStartDate:
            mutagen["date"] = str(video.streamStartDate)

        if video.trackNumber:
            mutagen["tracknumber"] = str(video.trackNumber)

        if video.volumeNumber:
            mutagen["discnumber"] = str(video.volumeNumber)

        mutagen.save(path)

    video_metadata.add_video_metadata = add_video_metadata
    metadata_pkg.add_video_metadata = add_video_metadata


def install_progress_hooks() -> None:
    import aiohttp
    from tiddl.cli.commands.download.downloader import Downloader
    from tiddl.cli.commands.download.output import RichOutput

    task_state_by_async_task: dict[asyncio.Task[Any], dict[str, Any]] = {}
    task_state_by_rich_id: dict[int, dict[str, Any]] = {}
    item_context_by_async_task: dict[asyncio.Task[Any], dict[str, Any]] = {}
    finished_provider_ids: set[str] = set()

    original_downloader_download = Downloader.download
    original_download_start = RichOutput.download_start
    original_download_advance = RichOutput.download_advance
    original_download_finish = RichOutput.download_finish
    original_total_increment = RichOutput.total_increment
    original_show_item_result = RichOutput.show_item_result
    original_request = aiohttp.ClientSession._request

    # Items handled so far: show_item_result fires once per downloaded,
    # overwritten, or already-existing item (download_finish alone misses
    # skipped items, which would stall a count-based progress bar).
    queue_state = {"handled": 0}

    def read_queue_total(self: Any) -> int | None:
        try:
            task = self.total_progress._tasks.get(self.total_task)
            total = getattr(task, "total", None)
            return int(total) if total else None
        except Exception:
            return None

    def get_current_async_task() -> asyncio.Task[Any] | None:
        try:
            return asyncio.current_task()
        except RuntimeError:
            return None

    def item_context(item: Any) -> dict[str, Any]:
        album = getattr(item, "album", None)
        artist = getattr(item, "artist", None)
        return {
            "providerTrackId": str(getattr(item, "id", "")) or None,
            "title": str(getattr(item, "title", "")) or None,
            "trackNumber": getattr(item, "trackNumber", None),
            "volumeNumber": getattr(item, "volumeNumber", None),
            "albumProviderId": str(getattr(album, "id", "")) if album is not None and getattr(album, "id", None) is not None else None,
            "albumTitle": getattr(album, "title", None) if album is not None else None,
            "artistName": getattr(artist, "name", None) if artist is not None else None,
            "isrc": getattr(item, "isrc", None),
        }

    def compact_context(context: dict[str, Any] | None) -> dict[str, Any]:
        if not context:
            return {}
        return {key: value for key, value in context.items() if value is not None and value != ""}

    async def patched_downloader_download(self: Any, item: Any, file_path: Any) -> Any:
        async_task = get_current_async_task()
        if async_task is not None:
            item_context_by_async_task[async_task] = item_context(item)
        try:
            return await original_downloader_download(self, item, file_path)
        finally:
            if async_task is not None:
                item_context_by_async_task.pop(async_task, None)

    def percent_for(state: dict[str, Any]) -> int | None:
        total = int(state.get("bytesTotal") or 0)
        if total <= 0:
            return None
        downloaded = int(state.get("bytesDownloaded") or 0)
        return max(0, min(100, round((downloaded / total) * 100)))

    def patched_download_start(self: Any, description: str) -> Any:
        task_id = original_download_start(self, description)
        rich_task_id = int(task_id)
        clean_title = clean_description(description)
        state = {
            "taskId": rich_task_id,
            "title": clean_title,
            "bytesDownloaded": 0,
            "bytesTotal": 0,
            "startedAt": time.monotonic(),
            "lastAt": time.monotonic(),
            "lastBytes": 0,
        }

        async_task = get_current_async_task()
        context = item_context_by_async_task.get(async_task) if async_task is not None else None
        if context:
            state.update({
                key: value
                for key, value in compact_context(context).items()
                if key != "title"
            })
            # Keep the provider title separate from the formatted Rich label.
            if context.get("title"):
                state["itemTitle"] = context["title"]
        if async_task is not None:
            task_state_by_async_task[async_task] = state
        task_state_by_rich_id[rich_task_id] = state
        emit_progress(
            "track_start",
            taskId=rich_task_id,
            title=str(state.get("itemTitle") or clean_title),
            **progress_identity(state),
        )
        return task_id

    def progress_identity(state: dict[str, Any]) -> dict[str, Any]:
        return {
            key: state.get(key)
            for key in (
                "providerTrackId",
                "trackNumber",
                "volumeNumber",
                "albumProviderId",
                "albumTitle",
                "artistName",
                "isrc",
            )
            if state.get(key) is not None
        }

    async def patched_request(self: Any, method: str, url: Any, **kwargs: Any) -> Any:
        response = await original_request(self, method, url, **kwargs)
        async_task = get_current_async_task()
        state = task_state_by_async_task.get(async_task) if async_task is not None else None
        content_length = getattr(response, "content_length", None)

        if str(method).upper() == "GET" and state is not None and isinstance(content_length, int) and content_length > 0:
            state["bytesTotal"] = int(state.get("bytesTotal") or 0) + content_length
            emit_progress(
                "track_total",
                taskId=state["taskId"],
                title=str(state.get("itemTitle") or state["title"]),
                bytesDownloaded=int(state.get("bytesDownloaded") or 0),
                bytesTotal=int(state["bytesTotal"]),
                percent=percent_for(state),
                **progress_identity(state),
            )

        return response

    def patched_download_advance(self: Any, task_id: Any, size: float) -> Any:
        result = original_download_advance(self, task_id, size)
        rich_task_id = int(task_id)
        state = task_state_by_rich_id.get(rich_task_id)
        if state is None:
            return result

        downloaded = int(state.get("bytesDownloaded") or 0) + int(size or 0)
        state["bytesDownloaded"] = downloaded
        now = time.monotonic()

        # download_advance fires per HTTP chunk; unthrottled that is hundreds of
        # JSON lines per second across parallel downloads. Only emit when the
        # visible percent changes or every 250ms.
        percent = percent_for(state)
        last_emit_at = float(state.get("lastEmitAt") or 0.0)
        last_emit_percent = state.get("lastEmitPercent")
        if percent == last_emit_percent and (now - last_emit_at) < 0.25:
            return result

        elapsed = now - float(state.get("lastAt") or now)
        previous_bytes = int(state.get("lastBytes") or 0)
        speed = None
        if elapsed >= 0.25:
            speed = max(0, round((downloaded - previous_bytes) / elapsed))
            state["lastAt"] = now
            state["lastBytes"] = downloaded

        state["lastEmitAt"] = now
        state["lastEmitPercent"] = percent

        payload = {
            "taskId": rich_task_id,
            "title": str(state.get("itemTitle") or state["title"]),
            "bytesDownloaded": downloaded,
            "bytesTotal": int(state.get("bytesTotal") or 0) or None,
            "percent": percent,
            **progress_identity(state),
        }
        if speed is not None:
            payload["bytesPerSecond"] = speed
        emit_progress("track_progress", **payload)
        return result

    def patched_total_increment(self: Any, count: float = 1) -> Any:
        # tiddl grows the queue total as it enumerates items; this is the only
        # place the album's item count surfaces, since the "Total Progress"
        # Rich panel never prints on a piped stdout.
        result = original_total_increment(self, count)
        total = read_queue_total(self)
        if total:
            emit_progress("queue_total", total=total, completed=queue_state["handled"])
        return result

    def patched_show_item_result(self: Any, result_message: str, item_description: str, item_path: Any) -> Any:
        result = original_show_item_result(self, result_message, item_description, item_path)
        async_task = get_current_async_task()
        context = item_context_by_async_task.get(async_task) if async_task is not None else None
        if context:
            provider_track_id = str(context.get("providerTrackId") or "")
            emitted_by_download_finish = provider_track_id in finished_provider_ids
            if not emitted_by_download_finish:
                result_text = clean_description(str(result_message or "")).lower()
                emit_progress(
                    "track_done",
                    title=clean_description(str(item_description or context.get("title") or "")),
                    trackStatus="skipped" if "exists" in result_text else "completed",
                    percent=100,
                    **{
                        key: value
                        for key, value in compact_context(context).items()
                        if key != "title"
                    },
                )
        queue_state["handled"] += 1
        emit_progress(
            "queue_progress",
            completed=queue_state["handled"],
            total=read_queue_total(self),
        )
        return result

    def patched_download_finish(self: Any, task_id: Any) -> Any:
        rich_task_id = int(task_id)
        state = task_state_by_rich_id.get(rich_task_id)
        try:
            return original_download_finish(self, task_id)
        finally:
            if state is not None:
                downloaded = int(state.get("bytesDownloaded") or 0)
                total = int(state.get("bytesTotal") or 0) or downloaded or None
                state["finishedEmitted"] = True
                provider_track_id = str(state.get("providerTrackId") or "")
                if provider_track_id:
                    finished_provider_ids.add(provider_track_id)
                emit_progress(
                    "track_done",
                    taskId=rich_task_id,
                    title=str(state.get("itemTitle") or state["title"]),
                    bytesDownloaded=downloaded,
                    bytesTotal=total,
                    percent=100,
                    **progress_identity(state),
                )
                task_state_by_rich_id.pop(rich_task_id, None)

            async_task = get_current_async_task()
            if async_task is not None:
                task_state_by_async_task.pop(async_task, None)

    RichOutput.download_start = patched_download_start
    RichOutput.download_advance = patched_download_advance
    RichOutput.download_finish = patched_download_finish
    RichOutput.total_increment = patched_total_increment
    RichOutput.show_item_result = patched_show_item_result
    Downloader.download = patched_downloader_download
    aiohttp.ClientSession._request = patched_request


def main() -> Any:
    install_video_metadata_guard()
    install_progress_hooks()
    from tiddl.cli.app import app

    return app()


if __name__ == "__main__":
    sys.exit(main())
