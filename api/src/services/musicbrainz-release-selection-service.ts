import { db } from "../database.js";

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
