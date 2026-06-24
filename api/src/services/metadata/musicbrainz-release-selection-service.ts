import { db } from "../../database.js";
import { getConfigSection } from "../config/config.js";

export type MusicBrainzReleaseSelection = {
    mbid: string;
    track_count: number | null;
    imported_file_count: number;
};

export type MusicBrainzReleaseSelectionOptions = {
    availableReleaseMbids?: Iterable<string>;
};

function normalizeReleaseMbids(values: Iterable<string> | undefined): string[] | null {
    if (!values) {
        return null;
    }

    return Array.from(new Set(
        Array.from(values)
            .map((value) => String(value || "").trim())
            .filter(Boolean),
    ));
}

export class MusicBrainzReleaseSelectionService {
    static selectRepresentativeRelease(
        releaseGroupMbid: string,
        options: MusicBrainzReleaseSelectionOptions = {},
    ): MusicBrainzReleaseSelection | null {
        const availableReleaseMbids = normalizeReleaseMbids(options.availableReleaseMbids);
        if (availableReleaseMbids?.length === 0) {
            return null;
        }

        const availabilityWhere = availableReleaseMbids
            ? `AND r.mbid IN (${availableReleaseMbids.map(() => "?").join(", ")})`
            : "";
        const preferExplicit = getConfigSection("filtering").prefer_explicit !== false;
        const row = db.prepare(`
            SELECT
                r.mbid,
                r.track_count,
                (
                    SELECT COUNT(*)
                    FROM TrackFiles lf
                    WHERE lf.file_type = 'track'
                      AND lf.canonical_release_mbid = r.mbid
                ) AS imported_file_count
            FROM AlbumReleases r
            WHERE r.release_group_mbid = ?
              ${availabilityWhere}
            ORDER BY
                imported_file_count DESC,
                COALESCE(r.track_count, 0) DESC,
                CASE WHEN LOWER(COALESCE(r.status, '')) = 'official' THEN 1 ELSE 0 END DESC,
                CASE WHEN EXISTS (
                    SELECT 1
                    FROM json_each(r.data, '$.Media') medium
                    WHERE LOWER(COALESCE(
                        json_extract(medium.value, '$.Format'),
                        json_extract(medium.value, '$.format'),
                        ''
                    )) IN ('digital media', 'digital')
                ) THEN 1 ELSE 0 END DESC,
                CASE
                    WHEN UPPER(COALESCE(r.country, '')) = 'XW'
                      OR UPPER(COALESCE(r.country, '')) LIKE '%"XW"%'
                    THEN 1 ELSE 0
                END DESC,
                CASE
                    WHEN ? = 1 THEN
                        CASE
                            WHEN LOWER(COALESCE(r.disambiguation, '') || ' ' || COALESCE(r.title, '')) LIKE '%explicit%' THEN 2
                            WHEN LOWER(COALESCE(r.disambiguation, '') || ' ' || COALESCE(r.title, '')) LIKE '%clean%' THEN 0
                            ELSE 1
                        END
                    ELSE
                        CASE
                            WHEN LOWER(COALESCE(r.disambiguation, '') || ' ' || COALESCE(r.title, '')) LIKE '%clean%' THEN 2
                            WHEN LOWER(COALESCE(r.disambiguation, '') || ' ' || COALESCE(r.title, '')) LIKE '%explicit%' THEN 0
                            ELSE 1
                        END
                END DESC,
                CASE WHEN r.date IS NULL OR TRIM(r.date) = '' THEN 1 ELSE 0 END ASC,
                r.date ASC,
                CASE WHEN r.barcode IS NULL OR TRIM(r.barcode) = '' THEN 0 ELSE 1 END DESC,
                CASE WHEN COALESCE(r.media_count, 0) > 0 AND COALESCE(r.track_count, 0) > 0 THEN 1 ELSE 0 END DESC,
                r.mbid ASC
            LIMIT 1
        `).get(releaseGroupMbid, ...(availableReleaseMbids || []), preferExplicit ? 1 : 0) as MusicBrainzReleaseSelection | undefined;

        return row || null;
    }

    static selectLocalImportRelease(
        releaseGroupMbid: string,
        options: MusicBrainzReleaseSelectionOptions = {},
    ): MusicBrainzReleaseSelection | null {
        const availableReleaseMbids = normalizeReleaseMbids(options.availableReleaseMbids);
        if (availableReleaseMbids?.length === 0) {
            return null;
        }

        const availabilityWhere = availableReleaseMbids
            ? `AND r.mbid IN (${availableReleaseMbids.map(() => "?").join(", ")})`
            : "";
        const row = db.prepare(`
            SELECT
                r.mbid,
                r.track_count,
                (
                    SELECT COUNT(*)
                    FROM TrackFiles lf
                    WHERE lf.file_type = 'track'
                      AND lf.canonical_release_mbid = r.mbid
                ) AS imported_file_count
            FROM AlbumReleases r
            WHERE r.release_group_mbid = ?
              ${availabilityWhere}
            ORDER BY
                imported_file_count DESC,
                COALESCE(r.track_count, 0) DESC,
                r.mbid ASC
            LIMIT 1
        `).get(releaseGroupMbid, ...(availableReleaseMbids || [])) as MusicBrainzReleaseSelection | undefined;

        return row || null;
    }
}
