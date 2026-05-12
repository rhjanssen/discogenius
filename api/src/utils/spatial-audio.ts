const EXACT_SPATIAL_QUALITY_TAGS = new Set([
    "DOLBY_ATMOS",
    "ATMOS",
    "SONY_360RA",
    "360RA",
]);

const SPATIAL_QUALITY_MARKERS = [
    "SPATIAL",
    "SURROUND",
    "IMMERSIVE",
    "ATMOS",
    "360",
];

export function normalizeQualityTag(value: unknown): string {
    return String(value ?? "")
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, "_");
}

export function isSpatialAudioQuality(value: unknown): boolean {
    const normalized = normalizeQualityTag(value);
    if (!normalized) {
        return false;
    }

    return EXACT_SPATIAL_QUALITY_TAGS.has(normalized)
        || SPATIAL_QUALITY_MARKERS.some((marker) => normalized.includes(marker));
}

export function hasSpatialAudioQuality(values: Iterable<unknown>): boolean {
    for (const value of values) {
        if (isSpatialAudioQuality(value)) {
            return true;
        }
    }
    return false;
}

export function spatialAudioQualitySql(columnExpression: string): string {
    const normalized = `UPPER(COALESCE(${columnExpression}, ''))`;
    return `(${normalized} IN ('DOLBY_ATMOS', 'ATMOS', 'SONY_360RA', '360RA')
        OR ${normalized} LIKE '%SPATIAL%'
        OR ${normalized} LIKE '%SURROUND%'
        OR ${normalized} LIKE '%IMMERSIVE%'
        OR ${normalized} LIKE '%ATMOS%'
        OR ${normalized} LIKE '%360%')`;
}
