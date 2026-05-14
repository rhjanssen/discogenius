import type { LibraryFileContract } from "@contracts/media";

export interface TrackAlbumRef {
  id?: string | null;
  title?: string | null;
  cover_id?: string | null;
}

export interface TrackListItem {
  id: string;
  preview_provider?: string | null;
  preview_provider_track_id?: string | null;
  title: string;
  version?: string | null;
  duration: number;
  track_number?: number | null;
  volume_number?: number | null;
  explicit?: boolean;
  quality?: string | null;
  album_id?: string | null;
  album_title?: string | null;
  album_cover?: string | null;
  cover_url?: string | null;
  artist_id?: string | null;
  artist_name?: string | null;
  musicbrainz_track_id?: string | null;
  musicbrainz_recording_id?: string | null;
  musicbrainz_release_id?: string | null;
  created_at?: string | null;
  downloaded?: boolean;
  is_downloaded?: boolean;
  monitored?: boolean;
  is_monitored?: boolean;
  monitor?: boolean | number;
  monitor_lock?: boolean | number;
  monitor_locked?: boolean;
  files?: LibraryFileContract[] | null;
  album?: TrackAlbumRef | null;
}
