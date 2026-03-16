import { db } from '../database.js';
import { getArtistPage } from './tidal.js';

type CanonicalModule =
    | 'ALBUM'
    | 'EP'
    | 'SINGLE'
    | 'COMPILATION'
    | 'LIVE'
    | 'REMIX'
    | 'APPEARS_ON'
    | 'DJ_MIXES';

type PageModuleKey =
    | CanonicalModule
    | 'EPSANDSINGLES'
    | 'ALBUMS';

function getMbSecondaryFromModule(module: CanonicalModule | null): string | null {
    if (!module) return null;
    switch (module) {
        case 'LIVE': return 'live';
        case 'COMPILATION': return 'compilation';
        case 'REMIX': return 'remix';
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

function normalizePageModuleTitleToKey(title: string | null | undefined): PageModuleKey | null {
    const t = (title || '').toLowerCase().trim();
    if (!t) return null;

    if (t.includes('live')) return 'LIVE';
    if (t.includes('compilation')) return 'COMPILATION';
    if (t.includes('appears')) return 'APPEARS_ON';
    if (t.includes('remix')) return 'REMIX';
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
    artistId: string
): void {
    const expandable = new Set<PageModuleKey>(['LIVE', 'COMPILATION', 'REMIX', 'DJ_MIXES']);

    // Get all version groups for this artist's albums from album_artists table
    const albumGroups = db.prepare(`
        SELECT aa.album_id, aa.version_group_id
        FROM album_artists aa
        WHERE aa.artist_id = ? AND aa.version_group_id IS NOT NULL
    `).all(artistId) as { album_id: number; version_group_id: number }[];

    // Build a map of version_group_id -> album IDs
    const groupToAlbums = new Map<number, string[]>();
    for (const row of albumGroups) {
        const albumId = row.album_id.toString();
        const groupId = row.version_group_id;
        if (!groupToAlbums.has(groupId)) {
            groupToAlbums.set(groupId, []);
        }
        groupToAlbums.get(groupId)!.push(albumId);
    }

    // For each group, determine the best module and apply to all members
    for (const [, albumIds] of groupToAlbums) {
        // Collect all modules present in this group
        const presentModules = new Set<PageModuleKey>();
        for (const albumId of albumIds) {
            const mod = moduleMap.get(albumId);
            if (mod) presentModules.add(mod);
        }

        if (presentModules.size === 0) continue;

        // Determine best module based on hierarchy
        let bestModule: PageModuleKey | null = null;

        if (presentModules.has('LIVE')) bestModule = 'LIVE';
        else if (presentModules.has('COMPILATION')) bestModule = 'COMPILATION';
        else if (presentModules.has('APPEARS_ON')) bestModule = 'APPEARS_ON';
        else if (presentModules.has('REMIX')) bestModule = 'REMIX';
        else if (presentModules.has('DJ_MIXES')) bestModule = 'DJ_MIXES';
        else if (presentModules.has('EP')) bestModule = 'EP';
        else if (presentModules.has('SINGLE')) bestModule = 'SINGLE';
        else if (presentModules.has('ALBUM')) bestModule = 'ALBUM';

        // Apply best module to ALL albums in the group
        if (bestModule) {
            for (const albumId of albumIds) {
                // Force update even if already set, to ensure consistency (e.g. ALBUM -> LIVE)
                moduleMap.set(albumId, bestModule!);
            }
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
    static async fixModuleTagsForArtist(artistId: string) {
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
        let pageMap: Map<string, PageModuleKey> = new Map();
        try {
            pageMap = await buildArtistPageModuleMap(artistId);
            // Propagate modules within version groups (uses pre-computed version_group)
            propagateModulesWithinVersionGroups(pageMap, artistId);
        } catch (e) {
            console.warn(`[MODULE-FIXER] Failed to fetch page modules for artist ${artistId}:`, e);
        }

        const albumRows = db.prepare(`
            SELECT aa.album_id as album_id,
                   aa.group_type as group_type,
                   aa.module as current_module,
                   a.type as album_type
            FROM album_artists aa
            JOIN albums a ON a.id = aa.album_id
            WHERE aa.artist_id = ?
        `).all(artistId) as any[];

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

            let desired: CanonicalModule | null = null;
            const fromPage = pageMap.get(albumId) || null;
            if (fromPage) {
                if (fromPage === 'EPSANDSINGLES') {
                    desired = getCanonicalModuleForEpOrSingle(albumType);
                } else if (fromPage === 'ALBUMS') {
                    desired = getCanonicalModuleForEpOrSingle(albumType);
                } else {
                    desired = fromPage;
                }
            }

            // Fallback based on group/type (no title heuristics)
            if (!desired) {
                if (groupType === 'COMPILATIONS') {
                    desired = 'APPEARS_ON';
                } else {
                    desired = getCanonicalModuleForEpOrSingle(albumType);
                }
            }

            // CRITICAL: Prevent overwriting strong signals with generic types
            // If current_module is already a strong type (REMIX, LIVE, COMPILATION, DJ_MIXES), keep it!
            // This prevents "Happier (Remixes)" (REMIX) from becoming (EP) just because it has type EP.
            if (row.current_module) {
                const current = row.current_module.toUpperCase();
                const strongTypes = new Set(['REMIX', 'LIVE', 'COMPILATION', 'DJ_MIXES', 'APPEARS_ON']);

                // If we calculated a generic type (ALBUM/EP/SINGLE) but we have a strong type in DB (from page map or title detection), keep the strong type.
                const isDesiredGeneric = ['ALBUM', 'EP', 'SINGLE'].includes(desired);
                if (isDesiredGeneric && strongTypes.has(current)) {
                    desired = current as CanonicalModule;
                }
            }

            updateModule.run(desired, artistId, albumId);

            const mbSecondary = getMbSecondaryFromModule(desired);
            const mbPrimary = getMbPrimaryFromTypeAndSecondary(albumType, mbSecondary);
            updateMb.run(mbPrimary, mbSecondary, albumId);
        }

        console.log(`[MODULE-FIXER] Module tag fixing complete for artist ${artistId}`);
    }
}
