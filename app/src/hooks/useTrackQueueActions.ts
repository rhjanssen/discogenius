import { useState } from "react";
import type React from "react";
import { useToast } from "@/hooks/useToast";
import { tidalUrl } from "@/utils/tidalUrl";
import type { TrackListItem } from "@/types/track-list";
import { useQueueStatus } from "@/hooks/useQueueStatus";

type QueueableTrack = Pick<TrackListItem, "id" | "title" | "version" | "downloaded" | "is_downloaded">;

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
      await addToQueue(tidalUrl("track", track.id), "track", track.id, {
        successTitle: "Track added to queue",
        successDescription: `${fullTitle} will be downloaded shortly`,
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
