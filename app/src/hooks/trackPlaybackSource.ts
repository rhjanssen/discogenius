export type TrackPlaybackSource = "local" | "provider";

export function isLocalAudioLibraryFile(file: {
  file_type?: string | null;
} | null | undefined): boolean {
  if (!file) return false;
  const type = String(file.file_type || "track").trim().toLowerCase();
  return type === "track" || type === "audio";
}

export function selectTrackPlaybackSource(options: {
  hasLocalAudioFile: boolean;
  forceProviderPreview: boolean;
}): TrackPlaybackSource {
  if (options.forceProviderPreview) {
    return "provider";
  }

  return options.hasLocalAudioFile ? "local" : "provider";
}
