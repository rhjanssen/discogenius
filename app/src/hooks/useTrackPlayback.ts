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
}

const ATMOS_PREVIEW_MIME_TYPES = [
  'audio/mp4; codecs="ec-3"',
  'audio/mp4; codecs="ac-4"',
  "audio/eac3",
];

const ATMOS_CODECS = new Set(["EC-3", "EAC3", "AC-4", "AC4"]);

function normalizePlaybackQuality(value: string | undefined | null) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeCodec(value: string | undefined | null) {
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
  const signingTrackIdsRef = useRef<Set<string>>(new Set());
  const previewQualityOverridesRef = useRef<Map<string, string | null>>(new Map());
  const fallbackRetryTrackIdsRef = useRef<Set<string>>(new Set());
  const preferSignedStreamTrackIdsRef = useRef<Set<string>>(new Set());

  const getTrackAudioFile = useCallback((track: PlayableTrack) => {
    return (track.files || []).find((file) => file.file_type === "track") ?? null;
  }, []);

  const shouldUseSignedPreview = useCallback((track: PlayableTrack) => {
    if (preferSignedStreamTrackIdsRef.current.has(track.id)) {
      return true;
    }

    const audioFile = getTrackAudioFile(track);
    if (!audioFile) {
      return true;
    }

    if (canBrowserPlayAtmosPreview()) {
      return false;
    }

    const normalizedTrackQuality = normalizePlaybackQuality(track.quality);
    const normalizedFileQuality = normalizePlaybackQuality(audioFile.quality);
    const normalizedCodec = normalizeCodec(audioFile.codec);

    return (
      normalizedTrackQuality === "DOLBY_ATMOS"
      || normalizedFileQuality === "DOLBY_ATMOS"
      || ATMOS_CODECS.has(normalizedCodec)
    );
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

    const needsSignedPreview = shouldUseSignedPreview(track) || !getTrackAudioFile(track);
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
    playingTrackId,
    shouldUseSignedPreview,
    signedStreamUrls,
    toast,
  ]);

  const handleTrackPlaybackError = useCallback(async (track: PlayableTrack) => {
    const normalizedQuality = normalizePlaybackQuality(track.quality);
    const hasFallbackRemaining =
      normalizedQuality === "DOLBY_ATMOS" && previewQualityOverridesRef.current.get(track.id) !== null;

    if (!hasFallbackRemaining || fallbackRetryTrackIdsRef.current.has(track.id)) {
      setPlayingTrackId(null);
      toast({
        title: "Playback failed",
        description: "This track could not be played in the browser",
        variant: "destructive",
      });
      return;
    }

    fallbackRetryTrackIdsRef.current.add(track.id);
    previewQualityOverridesRef.current.set(track.id, null);
    preferSignedStreamTrackIdsRef.current.add(track.id);

    try {
      await ensureSignedStreamUrl(track, null);
      setPlayingTrackId(track.id);
      toast({
        title: "Playback compatibility fallback",
        description: "Switched this Atmos track to a browser-compatible preview stream",
      });
    } catch (error) {
      console.error("Failed to recover playback after Atmos error:", error);
      setPlayingTrackId(null);
      toast({
        title: "Playback failed",
        description: "Could not switch to a compatible stream",
        variant: "destructive",
      });
    } finally {
      fallbackRetryTrackIdsRef.current.delete(track.id);
    }
  }, [ensureSignedStreamUrl, toast]);

  return {
    getPlaybackSrc,
    getTrackAudioFile,
    handleTrackPlaybackError,
    playingTrackId,
    setPlayingTrackId,
    toggleTrackPlayback,
  };
}
