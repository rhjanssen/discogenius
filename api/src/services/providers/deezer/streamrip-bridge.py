#!/opt/streamrip-venv/bin/python3
"""Discogenius' narrow compatibility bridge for Streamrip.

Streamrip 2.1 exposes an album ``id`` to folder templates, but omits the
already-available track ``info.id`` from track templates. Discogenius needs
provider-resource filenames so imported files retain exact provider identity.
Keep the filename change local to the ``{id}`` template we own. Disable the
obsolete media fallback that discards the requested quality.
"""

from streamrip.metadata.track import TrackMetadata
from streamrip.client import DeezerClient
from streamrip.exceptions import NonStreamableError
from streamrip.rip import rip


_streamrip_format_track_path = TrackMetadata.format_track_path


def _format_track_path_with_provider_id(
    self: TrackMetadata,
    format_string: str,
) -> str:
    if format_string == "{id}":
        return str(self.info.id)
    return _streamrip_format_track_path(self, format_string)


TrackMetadata.format_track_path = _format_track_path_with_provider_id


def _reject_legacy_low_quality_fallback(self, meta_id, track_hash, media_version):
    # Streamrip reaches this only when Deezer supplied no URL for the requested
    # format. Its legacy fallback forces MP3_128 even for a FLAC request, and
    # uses retired e-cdns-proxy hosts. Preserve the acquisition quality policy.
    raise NonStreamableError(
        "Deezer requested quality unavailable: no media URL for this track; "
        "legacy 128 kbps fallback disabled."
    )


DeezerClient._get_encrypted_file_url = _reject_legacy_low_quality_fallback


if __name__ == "__main__":
    raise SystemExit(rip())
