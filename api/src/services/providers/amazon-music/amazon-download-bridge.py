#!/usr/bin/env python3
"""Non-interactive bridge around amazon-music's library API.

Credentials arrive through the child-process environment so they never appear
in `docker top` / process command lines. Discogenius normalizes the resulting
human-readable filenames to provider ids after this bridge exits.
"""

import argparse
import json
import os
import sys

from amz.main import AmDownloader


def emit(progress: int, message: str) -> None:
    print("DG_PROGRESS " + json.dumps({"progress": progress, "message": message}), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", required=True)
    parser.add_argument("--type", choices=("album", "track"), required=True)
    parser.add_argument("--quality", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--temp", required=True)
    parser.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()

    token = os.environ.get("AMAZON_MUSIC_API_TOKEN", "").strip()
    if not token:
        print("Amazon Music API token is missing", file=sys.stderr)
        return 2
    api_base = os.environ.get("AMAZON_MUSIC_API_BASE", "https://amz.dezalty.com").strip()
    os.makedirs(args.output, exist_ok=True)
    os.makedirs(args.temp, exist_ok=True)

    emit(2, "Starting Amazon Music download")
    downloader = AmDownloader(
        path=args.output,
        path_temp=args.temp,
        api_url=api_base,
        access_token=token,
    )
    if args.type == "album":
        result = downloader.download_album(
            args.id,
            quality=args.quality,
            folder_format=1,
            track_format=1,
            max_workers=max(1, args.workers),
            overwrite=False,
        )
    else:
        result = downloader.download_track(
            args.id,
            quality=args.quality,
            folder_format=1,
            track_format=1,
            overwrite=False,
        )

    if not result or not result.success:
        failed = getattr(result, "failed", None) if result else None
        print(f"Amazon Music download failed{': ' + ', '.join(failed) if failed else ''}", file=sys.stderr)
        return 1
    emit(95, "Amazon Music media acquired")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
