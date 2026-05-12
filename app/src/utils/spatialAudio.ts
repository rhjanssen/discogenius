const exactSpatialQualityTags = new Set([
  "DOLBY_ATMOS",
  "ATMOS",
  "SONY_360RA",
  "360RA",
]);

const spatialQualityMarkers = [
  "SPATIAL",
  "SURROUND",
  "IMMERSIVE",
  "ATMOS",
  "360",
];

export const normalizeQualityTag = (value: unknown) => String(value ?? "")
  .trim()
  .toUpperCase()
  .replace(/[\s-]+/g, "_");

export const isSpatialAudioQuality = (value: unknown) => {
  const normalized = normalizeQualityTag(value);
  if (!normalized) return false;

  return exactSpatialQualityTags.has(normalized)
    || spatialQualityMarkers.some((marker) => normalized.includes(marker));
};
