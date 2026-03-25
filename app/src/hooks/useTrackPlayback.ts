import { useCallback, useRef, useState, type MouseEvent } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";

interface PlayableTrackFile {
  id: number;
  file_type: string;
}

export interface PlayableTrack {
  id: string;
  quality?: string | null;
  files?: PlayableTrackFile[] | null;
}

export function useTrackPlayback() {
  const { toast } = useToast();
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [signedStreamUrls, setSignedStreamUrls] = useState<Map<string, string>>(new Map());
  const signingTrackIdsRef = useRef<Set<string>>(new Set());

  const getTrackAudioFile = useCallback((track: PlayableTrack) => {
    return (track.files || []).find((file) => file.file_type === "track") ?? null;
  }, []);

  const getPlaybackSrc = useCallback((track: PlayableTrack) => {
    const audioFile = getTrackAudioFile(track);
    if (audioFile) {
      return api.getStreamUrl(audioFile.id);
    }

    return signedStreamUrls.get(track.id) || "";
  }, [getTrackAudioFile, signedStreamUrls]);

  const toggleTrackPlayback = useCallback(async (track: PlayableTrack, event?: MouseEvent) => {
    event?.stopPropagation();

    if (playingTrackId === track.id) {
      setPlayingTrackId(null);
      return;
    }

    const audioFile = getTrackAudioFile(track);
    const hasSignedUrl = signedStreamUrls.has(track.id);

    if (!audioFile && !hasSignedUrl) {
      if (signingTrackIdsRef.current.has(track.id)) {
        return;
      }

      signingTrackIdsRef.current.add(track.id);

      try {
        const url = await api.signTidalStream(track.id, track.quality);
        setSignedStreamUrls((previous) => new Map(previous).set(track.id, url));
      } catch (error) {
        console.error("Failed to get TIDAL stream URL:", error);
        toast({
          title: "Playback failed",
          description: "Could not get stream URL from TIDAL",
          variant: "destructive",
        });
        return;
      } finally {
        signingTrackIdsRef.current.delete(track.id);
      }
    }

    setPlayingTrackId(track.id);
  }, [getTrackAudioFile, playingTrackId, signedStreamUrls, toast]);

  return {
    getPlaybackSrc,
    getTrackAudioFile,
    playingTrackId,
    setPlayingTrackId,
    toggleTrackPlayback,
  };
}
