import { db } from "../database.js";

/**
 * Quality system aligned with tidal-dl-ng downloader options and TIDAL metadata.
 * 
 * IMPORTANT: TIDAL's metadata API primarily advertises these source-quality tags:
 *   - LOSSLESS (16-bit 44.1kHz)
 *   - HIRES_LOSSLESS (up to 24-bit 192kHz)
 *   - DOLBY_ATMOS (spatial audio - separate media type)
 *
 * Discogenius stores the actual library-file quality in `library_files.quality`.
 * That means AAC downloads converted by tidal-dl-ng can show up as `LOW` or `HIGH`
 * in the local library even if the TIDAL source metadata only reports lossless tiers.
 * 
 * tidal-dl-ng quality_audio options (from tidalapi.Quality):
 *   LOW            -> 96 kbps AAC
 *   HIGH           -> 320 kbps AAC
 *   LOSSLESS       -> 16-bit 44.1kHz FLAC
 *   HIRES_LOSSLESS -> up to 24-bit 192kHz FLAC
 * 
 * DOLBY_ATMOS is treated as a separate media type (like music videos), not a quality tier.
 * Albums can have both stereo and Atmos versions downloaded separately.
 * tidal-dl-ng's download_dolby_atmos is hardcoded to true; curation (include_atmos) controls
 * whether Atmos items are monitored and kept in the library.
 */

/**
 * Quality rankings for stored and derived library qualities.
 */
const QUALITY_RANKINGS: Record<string, number> = {
    "LOW": 1,              // tidal-dl-ng LOW - 96 kbps AAC
    "HIGH": 2,             // tidal-dl-ng HIGH - 320 kbps AAC
    "LOSSLESS": 3,         // tidal-dl-ng LOSSLESS - 16-bit 44.1kHz FLAC
    "HIRES_LOSSLESS": 4,   // TIDAL API HIRES_LOSSLESS - up to 24-bit 192kHz FLAC
};

/**
 * Maps tidal-dl-ng quality settings to what should be monitored in the database.
 * Since TIDAL only stores LOSSLESS and HIRES_LOSSLESS, LOW/HIGH all monitor LOSSLESS.
 */
export const TIDAL_DL_NG_QUALITY_TO_MONITOR: Record<string, string> = {
    "LOW": "LOSSLESS",            // Monitor LOSSLESS, tidal-dl-ng downloads as 96 kbps AAC
    "HIGH": "LOSSLESS",           // Monitor LOSSLESS, tidal-dl-ng downloads as 320 kbps AAC
    "LOSSLESS": "LOSSLESS",       // Monitor LOSSLESS, tidal-dl-ng downloads as 16-bit FLAC
    "HIRES_LOSSLESS": "HIRES_LOSSLESS", // Monitor HIRES_LOSSLESS, downloads as 24-bit FLAC
};

/**
 * Human-readable quality descriptions for display
 */
export const QUALITY_DESCRIPTIONS: Record<string, string> = {
    "LOW": "Low (96 kbps AAC)",
    "HIGH": "High (320 kbps AAC)",
    "LOSSLESS": "Lossless (16-bit 44.1kHz FLAC)",
    "HIRES_LOSSLESS": "Hi-Res (up to 24-bit 192kHz FLAC)",
    "DOLBY_ATMOS": "Dolby Atmos (spatial audio)",
};

export interface QualityProfile {
    id: number;
    name: string;
    upgrade_allowed: boolean;
    cutoff: string;
    items: string[]; // Ordered list of allowed qualities
}

export interface QualityComparison {
    needsUpgrade: boolean;
    currentQuality: string;
    targetQuality: string;
    reason: string;
}

export function normalizeAudioQualityTag(quality: string | null | undefined): string {
    return (quality || "").trim().toUpperCase();
}

export class QualityService {
    /**
     * Get quality profile by ID
     */
    static getProfile(profileId: number): QualityProfile | null {
        const row = db.prepare(`
            SELECT id, name, upgrade_allowed, cutoff, items
            FROM quality_profiles
            WHERE id = ?
        `).get(profileId) as any;

        if (!row) return null;

        return {
            id: row.id,
            name: row.name,
            upgrade_allowed: Boolean(row.upgrade_allowed),
            cutoff: row.cutoff,
            items: JSON.parse(row.items)
        };
    }

    /**
     * Get default quality profile (Max Quality)
     */
    static getDefaultProfile(): QualityProfile {
        const row = db.prepare(`
            SELECT id, name, upgrade_allowed, cutoff, items
            FROM quality_profiles
            WHERE name = 'Max Quality'
        `).get() as any;

        if (!row) {
            // Fallback if default doesn't exist
            return {
                id: 1,
                name: "Max Quality",
                upgrade_allowed: true,
                cutoff: "HIRES_LOSSLESS",
                items: ["HIRES_LOSSLESS", "LOSSLESS"]
            };
        }

        return {
            id: row.id,
            name: row.name,
            upgrade_allowed: Boolean(row.upgrade_allowed),
            cutoff: row.cutoff,
            items: JSON.parse(row.items)
        };
    }

    /**
     * Compare two qualities and determine if upgrade is needed
     */
    static compareQualities(
        currentQuality: string,
        availableQuality: string,
        profile: QualityProfile
    ): QualityComparison {
        const normalizedCurrentQuality = normalizeAudioQualityTag(currentQuality);
        const normalizedAvailableQuality = normalizeAudioQualityTag(availableQuality);
        const normalizedCutoff = normalizeAudioQualityTag(profile.cutoff);
        const currentRank = QUALITY_RANKINGS[normalizedCurrentQuality] || 0;
        const availableRank = QUALITY_RANKINGS[normalizedAvailableQuality] || 0;
        const cutoffRank = QUALITY_RANKINGS[normalizedCutoff] || 0;

        // Check if upgrade is allowed
        if (!profile.upgrade_allowed) {
            return {
                needsUpgrade: false,
                currentQuality: normalizedCurrentQuality,
                targetQuality: normalizedAvailableQuality,
                reason: "Quality profile does not allow upgrades"
            };
        }

        // Check if current quality meets cutoff
        if (currentRank >= cutoffRank) {
            return {
                needsUpgrade: false,
                currentQuality: normalizedCurrentQuality,
                targetQuality: normalizedAvailableQuality,
                reason: `Current quality (${normalizedCurrentQuality}) meets or exceeds cutoff (${normalizedCutoff})`
            };
        }

        // Check if available quality is better
        if (availableRank > currentRank) {
            return {
                needsUpgrade: true,
                currentQuality: normalizedCurrentQuality,
                targetQuality: normalizedAvailableQuality,
                reason: `Available quality (${normalizedAvailableQuality}) is better than current (${normalizedCurrentQuality})`
            };
        }

        return {
            needsUpgrade: false,
            currentQuality: normalizedCurrentQuality,
            targetQuality: normalizedAvailableQuality,
            reason: "No better quality available"
        };
    }

    /**
     * Check all media for a given album and queue upgrades if needed
     */
    static async checkAlbumForUpgrades(albumId: number): Promise<number> {
        // Get album info
        const album = db.prepare(`
            SELECT id, quality as available_quality, artist_id
            FROM albums
            WHERE id = ?
        `).get(albumId) as any;

        if (!album) return 0;

        // Get quality profile (use default for now)
        const profile = this.getDefaultProfile();

        // Get all tracks for this album with existing library files
        const tracks = db.prepare(`
            SELECT 
                m.id as media_id,
                m.quality as media_quality,
                lf.quality as file_quality,
                lf.id as file_id
            FROM media m
            INNER JOIN library_files lf ON lf.media_id = m.id
            WHERE m.album_id = ? AND lf.file_type = 'track'
        `).all(albumId) as any[];

        let upgradesQueued = 0;

        for (const track of tracks) {
            const currentQuality = track.file_quality || track.media_quality;
            const availableQuality = album.available_quality;

            const comparison = this.compareQualities(currentQuality, availableQuality, profile);

            if (comparison.needsUpgrade) {
                // Queue upgrade
                const existing = db.prepare(`
                    SELECT id FROM upgrade_queue
                    WHERE media_id = ? AND status = 'pending'
                `).get(track.media_id) as any;

                if (!existing) {
                    db.prepare(`
                        INSERT INTO upgrade_queue (media_id, album_id, current_quality, target_quality, reason, status)
                        VALUES (?, ?, ?, ?, ?, 'pending')
                    `).run(
                        track.media_id,
                        albumId,
                        comparison.currentQuality,
                        comparison.targetQuality,
                        comparison.reason
                    );
                    upgradesQueued++;
                }
            }
        }

        return upgradesQueued;
    }

    /**
     * Get pending upgrades
     */
    static getPendingUpgrades(): any[] {
        return db.prepare(`
            SELECT 
                uq.*,
                m.title as track_title,
                a.title as album_title,
                ar.name as artist_name
            FROM upgrade_queue uq
            INNER JOIN media m ON m.id = uq.media_id
            INNER JOIN albums a ON a.id = uq.album_id
            INNER JOIN artists ar ON ar.id = a.artist_id
            WHERE uq.status = 'pending'
            ORDER BY uq.created_at DESC
        `).all();
    }

    /**
     * Get config value
     */
    static getConfig(key: string, defaultValue: string = ""): string {
        const row = db.prepare(`
            SELECT value FROM config WHERE key = ?
        `).get(key) as any;
        return row ? row.value : defaultValue;
    }

    /**
     * Check if automatic upgrades are enabled
     */
    static isAutoUpgradeEnabled(): boolean {
        const value = this.getConfig("quality.upgrade_automatically", "true");
        return value.toLowerCase() === "true";
    }
}
