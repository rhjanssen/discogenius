import { useState } from "react";
import type React from "react";
import { useToast } from "@/hooks/useToast";
import type { TrackListItem } from "@/types/track-list";
import { useQueueStatus } from "@/hooks/useQueueStatus";

type QueueableTrack = Pick<
  TrackListItem,
  | "id"
  | "preview_provider"
  | "preview_provider_track_id"
  | "title"
  | "version"
  | "downloaded"
  | "is_downloaded"
  | "quality"
  | "album_id"
  | "album_title"
  | "album_cover"
  | "cover_url"
  | "artist_id"
  | "artist_name"
  | "musicbrainz_track_id"
  | "musicbrainz_recording_id"
>;

export function useTrackQueueActions() {
  const { toast } = useToast();
  const { addToQueue } = useQueueStatus();
  const [downloadingTracks, setDownloadingTracks] = useState<Set<string>>(new Set());

  const handleDownloadTrack = async (
    track: QueueableTrack,
    event?: React.MouseEvent,
  ) => {
    if (event) {
      event.stopPropagation();
    }

    if (track.is_downloaded ?? track.downloaded) {
      return;
    }

    setDownloadingTracks((previous) => new Set(previous).add(track.id));

    try {
      const fullTitle = track.version ? `${track.title} (${track.version})` : track.title;
      const providerTrackId = String(track.preview_provider_track_id || "").trim();
      if (!providerTrackId) {
        toast({
          title: "No provider track",
          description: "This MusicBrainz track is not matched to a provider track yet.",
          variant: "destructive",
        });
        return;
      }
      const looksLikeMusicBrainzMbid = (value: string | null | undefined) => (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || "").trim())
      );
      const releaseGroupMbid = looksLikeMusicBrainzMbid(track.album_id) ? track.album_id : null;
      const canonicalTrackMbid = track.musicbrainz_track_id ?? (looksLikeMusicBrainzMbid(track.id) ? track.id : null);

      await addToQueue(null, "track", providerTrackId, {
        successTitle: "Track added to queue",
        successDescription: `${fullTitle} will be downloaded shortly`,
        payload: {
          provider: track.preview_provider ?? "tidal",
          providerId: providerTrackId,
          canonicalTrackMbid,
          canonicalRecordingMbid: track.musicbrainz_recording_id ?? null,
          releaseGroupMbid,
          albumId: track.album_id ?? null,
          albumTitle: track.album_title ?? null,
          artistId: track.artist_id ?? null,
          title: fullTitle,
          artist: track.artist_name ?? "Unknown",
          cover: track.album_cover ?? track.cover_url ?? null,
          quality: track.quality ?? null,
          description: track.album_title
            ? `${fullTitle} on ${track.album_title}`
            : fullTitle,
        },
      });
    } catch (error) {
      console.error("Error adding track to queue:", error);
      toast({
        title: "Failed to add to queue",
        description: "Please try again",
        variant: "destructive",
      });
    } finally {
      setDownloadingTracks((previous) => {
        const next = new Set(previous);
        next.delete(track.id);
        return next;
      });
    }
  };

  return {
    downloadingTracks,
    handleDownloadTrack,
  };
}
