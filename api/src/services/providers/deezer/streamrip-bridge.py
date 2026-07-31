#!/opt/streamrip-venv/bin/python3
"""Discogenius' narrow compatibility bridge for Streamrip.

Streamrip 2.1 exposes an album ``id`` to folder templates, but omits the
already-available track ``info.id`` from track templates. Discogenius needs
provider-resource filenames so imported files retain exact provider identity.
Keep the compatibility change local to the ``{id}`` template we own and let
Streamrip handle every other format unchanged.
"""

from streamrip.metadata.track import TrackMetadata
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


if __name__ == "__main__":
    raise SystemExit(rip())
