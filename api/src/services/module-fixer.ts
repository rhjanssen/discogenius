import { db } from '../database.js';
import { getArtistPage } from "./providers/tidal/tidal.js";

type CanonicalModule =
    | 'ALBUM'
    | 'EP'
    | 'SINGLE'
    | 'COMPILATION'
    | 'LIVE'
    | 'REMIX'
    | 'SOUNDTRACK'
    | 'DEMO'
    | 'APPEARS_ON'
    | 'DJ_MIXES';

type PageModuleKey =
    | CanonicalModule
    | 'EPSANDSINGLES'
    | 'ALBUMS';

// MusicBrainz release-group secondary types (https://musicbrainz.org/doc/Release_Group/Type)
const VALID_MUSICBRAINZ_SECONDARY_TYPES = new Set<string>([
    'compilation',
    'soundtrack',
    'spokenword',
    'interview',
    'audiobook',
    'audio drama',
    'live',
    'remix',
    'dj-mix',
    'mixtape/street',
    'demo',
    'field recording',
]);

export function normalizeMusicBrainzSecondaryType(value: string | null | undefined): string | null {
    const normalized = (value || '').trim().toLowerCase();
    if (!normalized) return null;
    return VALID_MUSICBRAINZ_SECONDARY_TYPES.has(normalized) ? normalized : null;
}

export function resolveVersionGroupModule(
    presentModules: Iterable<PageModuleKey>,
): PageModuleKey | null {
    const moduleSet = new Set(presentModules);

    if (moduleSet.size === 0) {
        return null;
    }

    // Propagate stable artist-page module tags across release variants in the same version group.
    // Deterministic precedence handles mixed module signals.
    if (moduleSet.has('LIVE')) return 'LIVE';
    if (moduleSet.has('COMPILATION')) return 'COMPILATION';
    if (moduleSet.has('REMIX')) return 'REMIX';
    if (moduleSet.has('SOUNDTRACK')) return 'SOUNDTRACK';
    if (moduleSet.has('DEMO')) return 'DEMO';
    if (moduleSet.has('APPEARS_ON')) return 'APPEARS_ON';
    if (moduleSet.has('DJ_MIXES')) return 'DJ_MIXES';
    if (moduleSet.has('EP')) return 'EP';
    if (moduleSet.has('SINGLE')) return 'SINGLE';
    if (moduleSet.has('ALBUM')) return 'ALBUM';
    return null;
}

function getMbSecondaryFromModule(module: CanonicalModule | null): string | null {
    if (!module) return null;
    // APPEARS_ON is a relationship bucket, not a MusicBrainz secondary type.
    switch (module) {
        case 'LIVE': return normalizeMusicBrainzSecondaryType('live');
        case 'COMPILATION': return normalizeMusicBrainzSecondaryType('compilation');
        case 'REMIX': return normalizeMusicBrainzSecondaryType('remix');
        case 'SOUNDTRACK': return normalizeMusicBrainzSecondaryType('soundtrack');
        case 'DEMO': return normalizeMusicBrainzSecondaryType('demo');
        default: return null;
    }
}

function getMbPrimaryFromTypeAndSecondary(tidalType: string | null | undefined, mbSecondary: string | null): string {
    if (mbSecondary) return 'album';
    const type = (tidalType || 'ALBUM').toUpperCase();
    switch (type) {
        case 'EP': return 'ep';
        case 'SINGLE': return 'single';
        case 'ALBUM':
        default: return 'album';
    }
}

function getCanonicalModuleForEpOrSingle(tidalType: string | null | undefined): CanonicalModule {
    const type = (tidalType || 'ALBUM').toUpperCase();
    if (type === 'EP') return 'EP';
    if (type === 'SINGLE') return 'SINGLE';
    return 'ALBUM';
}

function normalizeMbSecondaryToModule(value: string | null | undefined): CanonicalModule | null {
    const secondary = normalizeMusicBrainzSecondaryType(value);
    if (!secondary) return null;

    if (secondary === 'live') return 'LIVE';
    if (secondary === 'compilation') return 'COMPILATION';
    if (secondary === 'remix') return 'REMIX';
    if (secondary === 'soundtrack') return 'SOUNDTRACK';
    if (secondary === 'demo') return 'DEMO';
    if (secondary === 'dj-mix') return 'DJ_MIXES';
    return null;
}

function resolveMusicBrainzModule(primary: string | null | undefined, secondary: string | null | undefined): CanonicalModule | null {
    const secondaryModule = normalizeMbSecondaryToModule(secondary);
    if (secondaryModule) return secondaryModule;

    const normalizedPrimary = (primary || '').trim().toLowerCase();
    if (normalizedPrimary === 'ep') return 'EP';
    if (normalizedPrimary === 'single') return 'SINGLE';
    if (normalizedPrimary === 'album') return 'ALBUM';
    return null;
}

export function normalizeStoredModuleToCanonical(
    moduleValue: string | null | undefined,
    tidalType: string | null | undefined,
): CanonicalModule | null {
    const normalized = (moduleValue || '').trim().toUpperCase();
    if (!normalized) return null;

    switch (normalized) {
        case 'ALBUM':
        case 'ALBUMS':
        case 'ARTIST_ALBUMS':
            return 'ALBUM';
        case 'EP':
        case 'ARTIST_EPS':
        case 'ARTIST_EP':
            return 'EP';
        case 'SINGLE':
        case 'ARTIST_SINGLES':
        case 'ARTIST_SINGLE':
            return 'SINGLE';
        case 'COMPILATION':
        case 'ARTIST_COMPILATIONS':
            return 'COMPILATION';
        case 'LIVE':
        case 'ARTIST_LIVE_ALBUMS':
            return 'LIVE';
        case 'REMIX':
        case 'ARTIST_REMIXES':
            return 'REMIX';
        case 'SOUNDTRACK':
        case 'ARTIST_SOUNDTRACKS':
            return 'SOUNDTRACK';
        case 'DEMO':
        case 'ARTIST_DEMOS':
            return 'DEMO';
        case 'APPEARS_ON':
        case 'ARTIST_APPEARS_ON':
            return 'APPEARS_ON';
        case 'DJ_MIXES':
        case 'DJ MIXES':
        case 'DJ-MIXES':
            return 'DJ_MIXES';
        case 'ARTIST_EPS_AND_SINGLES':
        case 'EPSANDSINGLES':
            return getCanonicalModuleForEpOrSingle(tidalType);
        default:
            return null;
    }
}

export function resolveAlbumModuleClassification(options: {
    fromPage?: PageModuleKey | null;
    groupType?: string | null;
    albumType?: string | null;
}): CanonicalModule {
    const albumType = (options.albumType || 'ALBUM').toUpperCase();

    if (options.fromPage) {
        if (options.fromPage === 'EPSANDSINGLES' || options.fromPage === 'ALBUMS') {
            return getCanonicalModuleForEpOrSingle(albumType);
        }

        return options.fromPage;
    }

    if ((options.groupType || '').toUpperCase() === 'COMPILATIONS') {
        return 'APPEARS_ON';
    }

    return getCanonicalModuleForEpOrSingle(albumType);
}

function normalizePageModuleTitleToKey(title: string | null | undefined): PageModuleKey | null {
    const t = (title || '').toLowerCase().trim();
    if (!t) return null;

    if (t.includes('live')) return 'LIVE';
    if (t.includes('compilation')) return 'COMPILATION';
    if (t.includes('appears')) return 'APPEARS_ON';
    if (t.includes('mix') || t.includes('dj')) return 'DJ_MIXES';

    // These are "primary" buckets; we still normalize to EP/SINGLE/ALBUM using album.type.
    if (t.includes('ep') || t.includes('single')) return 'EPSANDSINGLES';
    if (t === 'albums' || t.includes('albums') || t.includes('featured')) return 'ALBUMS';

    return null;
}

async function buildArtistPageModuleMap(artistId: string, cachedPageData?: any): Promise<Map<string, PageModuleKey>> {
    const moduleMap = new Map<string, PageModuleKey>();
    const pageData = cachedPageData ?? await getArtistPage(artistId);
    const rows = pageData?.rows;
    if (!Array.isArray(rows)) return moduleMap;

    for (const row of rows) {
        const modules = row?.modules;
        if (!Array.isArray(modules)) continue;

        for (const mod of modules) {
            const items = mod?.pagedList?.items || mod?.items || [];
            if (!Array.isArray(items) || items.length === 0) continue;

            const key = normalizePageModuleTitleToKey(mod?.title);
            if (!key) continue;

            for (const item of items) {
                const albumId = item?.id?.toString?.() ?? (item?.id != null ? String(item.id) : null);
                if (!albumId) continue;
                moduleMap.set(albumId, key);
            }
        }
    }

    return moduleMap;
}

/**
 * Propagate module tags within version groups.
 * Uses pre-computed version_group_id from album_artists table.
 * If any album in a group has a special module (LIVE, COMPILATION, etc.),
 * all albums in that group should inherit it.
 */
function propagateModulesWithinVersionGroups(
    moduleMap: Map<string, PageModuleKey>,
    artistId: string,
): void {
    const albumGroups = db.prepare(`
        SELECT aa.album_id, aa.version_group_id, aa.module, a.mb_secondary, a.type as album_type
        FROM album_artists aa
        JOIN albums a ON a.id = aa.album_id
        WHERE aa.artist_id = ? AND aa.version_group_id IS NOT NULL
    `).all(artistId) as Array<{
        album_id: number;
        version_group_id: number;
        module: string | null;
        mb_secondary: string | null;
        album_type: string | null;
    }>;

    const groupToAlbums = new Map<number, Array<{ albumId: string; module: string | null; mbSecondary: string | null; albumType: string | null }>>();
    for (const row of albumGroups) {
        const albumId = row.album_id.toString();
        const groupId = row.version_group_id;
        if (!groupToAlbums.has(groupId)) {
            groupToAlbums.set(groupId, []);
        }

        groupToAlbums.get(groupId)!.push({
            albumId,
            module: row.module,
            mbSecondary: row.mb_secondary,
            albumType: row.album_type,
        });
    }

    // If any variant in the group has a secondary classification, propagate it across the whole group.
    for (const [, albumRows] of groupToAlbums) {
        const signals = new Set<PageModuleKey>();

        for (const row of albumRows) {
            const pageModule = moduleMap.get(row.albumId);
            if (pageModule) signals.add(pageModule);

            const normalizedModule = normalizeStoredModuleToCanonical(row.module, row.albumType);
            if (normalizedModule && (
                normalizedModule === 'LIVE'
                || normalizedModule === 'COMPILATION'
                || normalizedModule === 'REMIX'
                || normalizedModule === 'SOUNDTRACK'
                || normalizedModule === 'DEMO'
                || normalizedModule === 'APPEARS_ON'
            )) {
                signals.add(normalizedModule);
            }

            const secondaryModule = normalizeMbSecondaryToModule(row.mbSecondary);
            if (secondaryModule) {
                signals.add(secondaryModule);
            }
        }

        if (signals.size === 0) continue;

        const bestModule = resolveVersionGroupModule(signals);
        if (!bestModule) continue;

        for (const row of albumRows) {
            moduleMap.set(row.albumId, bestModule);
        }
    }
}

export class ModuleFixer {
    /**
     * Propagate/fill missing module tags for a specific artist.
     *
     * In our schema, module tags live on `album_artists.module` (per-artist classification),
     * not on the `albums` table.
     */
    static async fixModuleTagsForArtist(artistId: string, cachedPageData?: any, pageLookupArtistId: string = artistId) {
        console.log(`[MODULE-FIXER] Fixing module tags for artist ${artistId}...`);

        // 0) Normalize legacy module values to the canonical set used by the UI layer
        db.prepare(`
            UPDATE album_artists
            SET module = CASE
                WHEN module IS NULL THEN NULL
                WHEN UPPER(module) IN ('ALBUM', 'ALBUMS', 'ARTIST_ALBUMS') THEN 'ALBUM'
                WHEN UPPER(module) IN ('EP', 'ARTIST_EPS', 'ARTIST_EP') THEN 'EP'
                WHEN UPPER(module) IN ('SINGLE', 'ARTIST_SINGLES', 'ARTIST_SINGLE') THEN 'SINGLE'
                WHEN UPPER(module) IN ('COMPILATION', 'ARTIST_COMPILATIONS') THEN 'COMPILATION'
                WHEN UPPER(module) IN ('LIVE', 'ARTIST_LIVE_ALBUMS') THEN 'LIVE'
                WHEN UPPER(module) IN ('REMIX', 'ARTIST_REMIXES') THEN 'REMIX'
                WHEN UPPER(module) IN ('SOUNDTRACK', 'ARTIST_SOUNDTRACKS') THEN 'SOUNDTRACK'
                WHEN UPPER(module) IN ('DEMO', 'ARTIST_DEMOS') THEN 'DEMO'
                WHEN UPPER(module) IN ('APPEARS_ON', 'ARTIST_APPEARS_ON') THEN 'APPEARS_ON'
                WHEN UPPER(module) IN ('DJ_MIXES', 'DJ MIXES', 'DJ-MIXES') THEN 'DJ_MIXES'
                WHEN UPPER(module) IN ('ARTIST_EPS_AND_SINGLES', 'EPSANDSINGLES') THEN (
                    CASE UPPER(COALESCE((SELECT type FROM albums WHERE id = album_id), 'ALBUM'))
                        WHEN 'EP' THEN 'EP'
                        WHEN 'SINGLE' THEN 'SINGLE'
                        ELSE 'ALBUM'
                    END
                )
                ELSE module
            END
            WHERE artist_id = ?
        `).run(artistId);

        // 1) Page-derived tagging (Tidal artist page modules), with propagation via version_group
        let pageMap = new Map<string, PageModuleKey>();
        try {
            pageMap = await buildArtistPageModuleMap(pageLookupArtistId, cachedPageData);
        } catch (error) {
            console.warn(`[MODULE-FIXER] Provider artist page module lookup failed for ${artistId}; falling back to stored MusicBrainz/provider classification:`, error);
        }
        propagateModulesWithinVersionGroups(pageMap, artistId);

        const albumRows = db.prepare(`
            SELECT aa.album_id as album_id,
                   aa.type as relation_type,
                   aa.group_type as group_type,
                   a.type as album_type,
                   a.mb_primary as mb_primary,
                   a.mb_secondary as mb_secondary,
                   a.musicbrainz_status as musicbrainz_status
            FROM album_artists aa
            JOIN albums a ON a.id = aa.album_id
            WHERE aa.artist_id = ?
        `).all(artistId) as Array<{
            album_id: number | string;
            relation_type: string | null;
            group_type: string | null;
            album_type: string | null;
            mb_primary: string | null;
            mb_secondary: string | null;
            musicbrainz_status: string | null;
        }>;

        const updateModule = db.prepare(`
            UPDATE album_artists
            SET module = ?
            WHERE artist_id = ? AND album_id = ?
        `);

        const updateMb = db.prepare(`
            UPDATE albums
            SET mb_primary = ?,
                mb_secondary = ?
            WHERE id = ?
        `);

        for (const row of albumRows) {
            const albumId = row.album_id?.toString?.() ?? String(row.album_id);
            const groupType = (row.group_type || '').toUpperCase();
            const albumType = (row.album_type || 'ALBUM').toUpperCase();
            const mbModule = row.musicbrainz_status === 'verified'
                ? resolveMusicBrainzModule(row.mb_primary, row.mb_secondary)
                : null;
            const desired = (row.relation_type || '').toUpperCase() === 'APPEARS_ON'
                ? 'APPEARS_ON'
                : mbModule || resolveAlbumModuleClassification({
                fromPage: pageMap.get(albumId) || null,
                groupType,
                albumType,
            });

            updateModule.run(desired, artistId, albumId);

            if (row.musicbrainz_status !== 'verified') {
                const mbSecondary = getMbSecondaryFromModule(desired);
                const mbPrimary = getMbPrimaryFromTypeAndSecondary(albumType, mbSecondary);
                updateMb.run(mbPrimary, mbSecondary, albumId);
            }
        }

        console.log(`[MODULE-FIXER] Module tag fixing complete for artist ${artistId}`);
    }
}
