#!/opt/streamrip-venv/bin/python3
"""Discogenius' narrow compatibility bridge for Streamrip.

Streamrip 2.1 exposes an album ``id`` to folder templates, but omits the
already-available track ``info.id`` from track templates. Discogenius needs
provider-resource filenames so imported files retain exact provider identity.
Keep the filename change local to the ``{id}`` template we own. Disable the
obsolete media fallback that discards the requested quality.
"""

import threading

from requests.adapters import HTTPAdapter
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

# Streamrip resolves every album track with asyncio.gather before the download
# semaphore applies. Deezer's client uses one requests.Session (urllib3's
# default pool is 10 and does not block), so a large album discards
# connections and the rip dies with "Connection pool is full". toml
# max_connections only limits file transfers. Serialize the session and make
# the pool block instead of discarding.
_deezer_session_lock = threading.Lock()
_deezer_client_init = DeezerClient.__init__


def _init_serialized_deezer_client(self, *args, **kwargs):
    _deezer_client_init(self, *args, **kwargs)
    session = getattr(getattr(self, "client", None), "session", None)
    if session is None or getattr(session, "_discogenius_serialized", False):
        return
    adapter = HTTPAdapter(pool_connections=1, pool_maxsize=1, pool_block=True)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    original_request = session.request

    def _serialized_request(*request_args, **request_kwargs):
        with _deezer_session_lock:
            return original_request(*request_args, **request_kwargs)

    session.request = _serialized_request
    session._discogenius_serialized = True


DeezerClient.__init__ = _init_serialized_deezer_client


if __name__ == "__main__":
    raise SystemExit(rip())
