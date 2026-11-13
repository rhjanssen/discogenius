/**
 * TrackFiles.source_provider vocabulary. A real provider id (tidal, apple,
 * amazon, deezer, spotify, youtube, ...) means a download import produced the
 * file. `external` is a manual/unmapped import. `unknown` is a file whose
 * origin could not be established (backfill with no evidence).
 */
export const SOURCE_PROVIDER_EXTERNAL = "external";
export const SOURCE_PROVIDER_UNKNOWN = "unknown";

export function normalizeSourceProvider(provider?: string | null): string {
  const key = String(provider || "").trim().toLowerCase();
  if (key === "apple_music" || key === "apple-music") return "apple";
  if (key === "amazon_music" || key === "amazon-music") return "amazon";
  if (key === "youtube_music" || key === "youtube-music") return "youtube";
  if (key === "manual") return SOURCE_PROVIDER_EXTERNAL;
  return key;
}

export function isNonProviderSource(source?: string | null): boolean {
  return source === SOURCE_PROVIDER_EXTERNAL || source === SOURCE_PROVIDER_UNKNOWN || !source;
}
