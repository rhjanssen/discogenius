export function formatSourceProviderLabel(sourceProvider?: string | null): string | null {
  const key = String(sourceProvider || "").trim().toLowerCase();
  if (!key) return null;
  if (key === "tidal") return "TIDAL";
  if (key === "apple" || key === "apple_music" || key === "apple-music") return "Apple Music";
  if (key === "amazon" || key === "amazon_music" || key === "amazon-music") return "Amazon Music";
  if (key === "youtube" || key === "youtube_music" || key === "youtube-music") return "YouTube";
  if (key === "deezer") return "Deezer";
  if (key === "spotify") return "Spotify";
  if (key === "soundcloud") return "SoundCloud";
  if (key === "external" || key === "manual") return "External import";
  if (key === "unknown") return "Unknown";
  return sourceProvider?.trim() || null;
}

export function isProviderMarkSupported(sourceProvider?: string | null): boolean {
  const key = String(sourceProvider || "").trim().toLowerCase();
  return key !== "" && key !== "external" && key !== "manual" && key !== "unknown";
}

export interface TrackSourceLike {
  files?: Array<{
    file_type?: string | null;
    source_provider?: string | null;
  }>;
}

/**
 * Summarize the origin of downloaded audio track files on an album, e.g.:
 * - "TIDAL" (when all audio files share one provider)
 * - "TIDAL, 2 tracks Apple Music" (mixed providers)
 * - null (when no audio files carry a known source_provider)
 */
export function summarizeTrackFileSources(tracks: readonly TrackSourceLike[]): string | null {
  const counts = new Map<string, number>();
  for (const track of tracks) {
    const audioFiles = (track.files || []).filter(
      (file) => String(file.file_type || "track") === "track",
    );
    for (const file of audioFiles) {
      const label = formatSourceProviderLabel(file.source_provider);
      if (!label) continue;
      counts.set(label, (counts.get(label) || 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (sorted.length === 1) {
    return sorted[0][0];
  }
  const [primaryLabel] = sorted[0];
  const rest = sorted.slice(1).map(([label, count]) => `${count} ${count === 1 ? "track" : "tracks"} ${label}`);
  return `${primaryLabel}, ${rest.join(", ")}`;
}
