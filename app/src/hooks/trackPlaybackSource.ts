export type TrackPlaybackSource = "local" | "provider";

export function selectTrackPlaybackSource(options: {
  hasLocalAudioFile: boolean;
  forceProviderPreview: boolean;
}): TrackPlaybackSource {
  if (options.forceProviderPreview) {
    return "provider";
  }

  return options.hasLocalAudioFile ? "local" : "provider";
}
