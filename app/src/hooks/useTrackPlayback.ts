import { useCallback, useRef, useState, type MouseEvent } from "react";
import { api } from "@/services/api";
import { useToast } from "@/hooks/useToast";

interface PlayableTrackFile {
  id: number;
  file_type: string;
  codec?: string | null;
  quality?: string | null;
  extension?: string | null;
}

export interface PlayableTrack {
  id: string;
  quality?: string | null;
  files?: PlayableTrackFile[] | null;
  downloaded?: boolean;
  is_downloaded?: boolean;
}

const ATMOS_PREVIEW_MIME_TYPES = [
  'audio/mp4; codecs="ec-3"',
  'audio/mp4; codecs="ac-4"',
  "audio/eac3",
];

function normalizePlaybackQuality(value: string | undefined | null) {
  return String(value ?? "").trim().toUpperCase();
}

function canBrowserPlayAtmosPreview() {
  if (typeof document === "undefined") {
    return false;
  }

  const audio = document.createElement("audio");
  return ATMOS_PREVIEW_MIME_TYPES.some((mimeType) => {
    const supportLevel = audio.canPlayType(mimeType);
    return supportLevel === "probably" || supportLevel === "maybe";
  });
}

export function useTrackPlayback() {
  const { toast } = useToast();
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);
  const [signedStreamUrls, setSignedStreamUrls] = useState<Map<string, string>>(new Map());
  const [trackFilesById, setTrackFilesById] = useState<Record<string, PlayableTrackFile[]>>({});
  const signingTrackIdsRef = useRef<Set<string>>(new Set());
  const loadingTrackFileIdsRef = useRef<Set<string>>(new Set());
  const previewQualityOverridesRef = useRef<Map<string, string | null>>(new Map());
  const fallbackRetryTrackIdsRef = useRef<Set<string>>(new Set());
  const preferSignedStreamTrackIdsRef = useRef<Set<string>>(new Set());

  const isDownloadedTrack = useCallback((track: PlayableTrack) => {
    return Boolean(track.is_downloaded ?? track.downloaded);
  }, []);

  const getTrackFiles = useCallback((track: PlayableTrack) => {
    if (Array.isArray(track.files) && track.files.length > 0) {
      return track.files;
    }

    return trackFilesById[track.id] ?? [];
  }, [trackFilesById]);

  const getTrackAudioFile = useCallback((track: PlayableTrack) => {
    return getTrackFiles(track).find((file) => file.file_type === "track") ?? null;
  }, [getTrackFiles]);

  const loadTrackFilesIfNeeded = useCallback(async (track: PlayableTrack) => {
    const existingFiles = getTrackFiles(track);
    if (existingFiles.length > 0 || !isDownloadedTrack(track)) {
      return existingFiles;
    }

    if (loadingTrackFileIdsRef.current.has(track.id)) {
      return [];
    }

    loadingTrackFileIdsRef.current.add(track.id);
    try {
      const response = await api.getTrackFiles(track.id) as { items?: PlayableTrackFile[] };
      const files = Array.isArray(response?.items) ? response.items : [];
      setTrackFilesById((previous) => ({ ...previous, [track.id]: files }));
      return files;
    } finally {
      loadingTrackFileIdsRef.current.delete(track.id);
    }
  }, [getTrackFiles, isDownloadedTrack]);

  const shouldUseSignedPreview = useCallback((track: PlayableTrack, audioFileOverride?: PlayableTrackFile | null) => {
    if (preferSignedStreamTrackIdsRef.current.has(track.id)) {
      return true;
    }

    const audioFile = audioFileOverride ?? getTrackAudioFile(track);
    if (!audioFile) {
      return true;
    }

    return false;
  }, [getTrackAudioFile]);

  const getPreviewPreferredQuality = useCallback((track: PlayableTrack) => {
    if (previewQualityOverridesRef.current.has(track.id)) {
      return previewQualityOverridesRef.current.get(track.id) ?? null;
    }

    const normalizedQuality = normalizePlaybackQuality(track.quality);
    if (normalizedQuality !== "DOLBY_ATMOS") {
      return track.quality ?? null;
    }

    return canBrowserPlayAtmosPreview() ? track.quality ?? null : null;
  }, []);

  const getPlaybackSrc = useCallback((track: PlayableTrack) => {
    const audioFile = getTrackAudioFile(track);
    if (audioFile && !shouldUseSignedPreview(track)) {
      return api.getStreamUrl(audioFile.id);
    }

    return signedStreamUrls.get(track.id) || "";
  }, [getTrackAudioFile, shouldUseSignedPreview, signedStreamUrls]);

  const ensureSignedStreamUrl = useCallback(async (track: PlayableTrack, preferredQuality?: string | null) => {
    if (signingTrackIdsRef.current.has(track.id)) {
      return;
    }

    signingTrackIdsRef.current.add(track.id);

    try {
      const url = await api.signTidalStream(track.id, preferredQuality ?? undefined);
      setSignedStreamUrls((previous) => new Map(previous).set(track.id, url));
    } finally {
      signingTrackIdsRef.current.delete(track.id);
    }
  }, []);

  const toggleTrackPlayback = useCallback(async (track: PlayableTrack, event?: MouseEvent) => {
    event?.stopPropagation();

    if (playingTrackId === track.id) {
      setPlayingTrackId(null);
      return;
    }

    let audioFile = getTrackAudioFile(track);
    if (!audioFile && isDownloadedTrack(track)) {
      const loadedFiles = await loadTrackFilesIfNeeded(track);
      audioFile = loadedFiles.find((file) => file.file_type === "track") ?? null;
    }

    const needsSignedPreview = shouldUseSignedPreview(track, audioFile);
    const hasSignedUrl = signedStreamUrls.has(track.id);

    if (needsSignedPreview && !hasSignedUrl) {
      try {
        await ensureSignedStreamUrl(track, getPreviewPreferredQuality(track));
      } catch (error) {
        console.error("Failed to get TIDAL stream URL:", error);
        toast({
          title: "Playback failed",
          description: "Could not get stream URL from TIDAL",
          variant: "destructive",
        });
        return;
      }
    }

    setPlayingTrackId(track.id);
  }, [
    ensureSignedStreamUrl,
    getPreviewPreferredQuality,
    getTrackAudioFile,
    isDownloadedTrack,
    loadTrackFilesIfNeeded,
    playingTrackId,
    shouldUseSignedPreview,
    signedStreamUrls,
    toast,
  ]);

  const handleTrackPlaybackError = useCallback(async (track: PlayableTrack) => {
    if (fallbackRetryTrackIdsRef.current.has(track.id)) {
      setPlayingTrackId(null);
      toast({
        title: "Playback failed",
        description: "This track could not be played in the browser",
        variant: "destructive",
      });
      return;
    }

    let audioFile = getTrackAudioFile(track);
    if (!audioFile && isDownloadedTrack(track)) {
      const loadedFiles = await loadTrackFilesIfNeeded(track);
      audioFile = loadedFiles.find((file) => file.file_type === "track") ?? null;
    }

    const usingSignedPreview = shouldUseSignedPreview(track, audioFile);
    const canFallbackToSignedPreview = !usingSignedPreview;
    const canFallbackToLocalFile = usingSignedPreview && Boolean(audioFile);

    if (!canFallbackToSignedPreview && !canFallbackToLocalFile) {
      setPlayingTrackId(null);
      toast({
        title: "Playback failed",
        description: "This track could not be played in the browser",
        variant: "destructive",
      });
      return;
    }

    fallbackRetryTrackIdsRef.current.add(track.id);

    try {
      if (canFallbackToLocalFile) {
        preferSignedStreamTrackIdsRef.current.delete(track.id);
      } else {
        previewQualityOverridesRef.current.set(track.id, null);
        preferSignedStreamTrackIdsRef.current.add(track.id);
        await ensureSignedStreamUrl(track, null);
      }

      setPlayingTrackId(track.id);
      toast({
        title: "Playback compatibility fallback",
        description: canFallbackToLocalFile
          ? "Switched to the local library stream"
          : "Switched to a browser-compatible preview stream",
      });
    } catch (error) {
      console.error("Failed to recover playback after playback error:", error);
      setPlayingTrackId(null);
      toast({
        title: "Playback failed",
        description: "Could not switch to a compatible stream",
        variant: "destructive",
      });
    } finally {
      fallbackRetryTrackIdsRef.current.delete(track.id);
    }
  }, [
    ensureSignedStreamUrl,
    getTrackAudioFile,
    isDownloadedTrack,
    loadTrackFilesIfNeeded,
    shouldUseSignedPreview,
    toast,
  ]);

  return {
    getPlaybackSrc,
    getTrackAudioFile,
    handleTrackPlaybackError,
    playingTrackId,
    setPlayingTrackId,
    toggleTrackPlayback,
  };
}
