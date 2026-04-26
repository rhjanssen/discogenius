/**
 * Version Grouper Service
 * 
 * Groups provider variants of the same edition using Tidal's "Other Versions" API.
 * Uses 2-level recursive traversal and Union-Find algorithm to find all connected versions.
 * 
 * Example: "Give Me The Future + Dreams of the Past" has 6 versions:
 * - 3 clean (LOSSLESS, HIRES, ATMOS)
 * - 3 explicit (LOSSLESS, HIRES, ATMOS)
 * All 6 should share the same version_group_id.
 * 
 * Note: Standard vs Deluxe are NOT the same version group - they're different releases.
 * Only same-name albums with different qualities/explicit variants are grouped. MusicBrainz
 * release groups are deliberately broader than this provider edition grouping.
 */

import { db } from '../database.js';
import { getAlbumOtherVersions, getAlbum } from './tidal.js';
import * as crypto from 'crypto';
import pLimit from 'p-limit';

/**
 * Union-Find data structure for efficiently grouping connected albums
 */
class UnionFind {
    private parent: Map<string, string> = new Map();
    private rank: Map<string, number> = new Map();

    find(x: string): string {
        if (!this.parent.has(x)) {
            this.parent.set(x, x);
            this.rank.set(x, 0);
        }
        if (this.parent.get(x) !== x) {
            this.parent.set(x, this.find(this.parent.get(x)!)); // Path compression
        }
        return this.parent.get(x)!;
    }

    union(x: string, y: string): void {
        const rootX = this.find(x);
        const rootY = this.find(y);
        if (rootX === rootY) return;

        // Union by rank
        const rankX = this.rank.get(rootX) || 0;
        const rankY = this.rank.get(rootY) || 0;
        if (rankX < rankY) {
            this.parent.set(rootX, rootY);
        } else if (rankX > rankY) {
            this.parent.set(rootY, rootX);
        } else {
            this.parent.set(rootY, rootX);
            this.rank.set(rootX, rankX + 1);
        }
    }

    /**
     * Get all groups as Map<rootId, Set<albumIds>>
     */
    getGroups(): Map<string, Set<string>> {
        const groups = new Map<string, Set<string>>();
        for (const albumId of this.parent.keys()) {
            const root = this.find(albumId);
            if (!groups.has(root)) {
                groups.set(root, new Set());
            }
            groups.get(root)!.add(albumId);
        }
        return groups;
    }
}

interface VersionGroup {
    groupId: number;      // Unique hash-derived numeric ID
    groupName: string;    // Album title (from first album in group)
    albumIds: Set<string>;
}

export class VersionGrouper {
    /**
     * Build version groups for all albums of an artist using 2-level Other Versions traversal.
     * 
     * Algorithm:
     * 1. For each album, fetch "Other Versions" (level 1)
     * 2. For each other version, fetch THEIR "Other Versions" (level 2)
     * 3. Use Union-Find to merge all connected albums into groups
     * 4. Generate unique group ID using hash of sorted album IDs
     */
    static async buildVersionGroups(artistId: string): Promise<VersionGroup[]> {
        console.log(`[VERSION-GROUPER] Building version groups for artist ${artistId}...`);

        // Get all album IDs for this artist
        const albumRows = db.prepare(`
            SELECT DISTINCT aa.album_id, a.title
            FROM album_artists aa
            JOIN albums a ON a.id = aa.album_id
            WHERE aa.artist_id = ?
        `).all(artistId) as { album_id: number; title: string }[];

        const artistAlbumIds = new Set(albumRows.map(r => r.album_id.toString()));
        const albumTitles = new Map(albumRows.map(r => [r.album_id.toString(), r.title]));
        console.log(`[VERSION-GROUPER] Found ${artistAlbumIds.size} albums for artist`);

        if (artistAlbumIds.size === 0) {
            return [];
        }

        const uf = new UnionFind();
        const visited = new Set<string>();
        let apiCalls = 0;

        // Level 1: Fetch other versions for each album
        for (const albumId of artistAlbumIds) {
            if (visited.has(albumId)) continue;
            visited.add(albumId);

            try {
                const otherVersions = await getAlbumOtherVersions(albumId);
                apiCalls++;

                for (const otherId of otherVersions) {
                    if (!otherId) continue;
                    // Union this album with its other version
                    uf.union(albumId, otherId);

                    // Level 2: Fetch other versions of other versions (if not visited)
                    if (!visited.has(otherId)) {
                        visited.add(otherId);
                        try {
                            const level2Versions = await getAlbumOtherVersions(otherId);
                            apiCalls++;
                            for (const level2Id of level2Versions) {
                                if (!level2Id) continue;
                                uf.union(albumId, level2Id);
                            }
                        } catch {
                            // Best effort - continue on error
                        }
                    }
                }
            } catch {
                // Best effort - continue on error
            }
        }

        console.log(`[VERSION-GROUPER] Made ${apiCalls} API calls for version traversal`);

        // Fallback Grouping by Title (exact match)
        // This catches cases where Tidal's "Other Versions" API misses links (e.g. "MTV Unplugged" Atmos vs HiRes)
        const titleToGroup = new Map<string, string>();

        for (const albumId of artistAlbumIds) {
            const title = albumTitles.get(albumId);
            if (!title) continue;

            const normalizedTitle = title.trim().toLowerCase();

            if (titleToGroup.has(normalizedTitle)) {
                // Found a title match! Union them.
                const existingId = titleToGroup.get(normalizedTitle)!;
                uf.union(existingId, albumId);
            } else {
                // If this album is technically part of a group already (via API), map title to that group's root
                // Otherwise map title to itself
                const root = uf.find(albumId);
                titleToGroup.set(normalizedTitle, root);
            }
        }

        // Build result: filter to only include albums belonging to this artist
        const rawGroups = uf.getGroups();
        const versionGroups: VersionGroup[] = [];

        for (const [, allAlbumIds] of rawGroups) {
            // Filter to only albums that belong to this artist
            const artistOnlyIds = new Set<string>();
            for (const albumId of allAlbumIds) {
                if (artistAlbumIds.has(albumId)) {
                    artistOnlyIds.add(albumId);
                }
            }

            if (artistOnlyIds.size === 0) continue;

            // Generate unique group ID from hash of sorted album IDs
            const groupId = this.generateGroupId(artistOnlyIds);

            // Get group name from first album's title
            const firstAlbumId = Array.from(artistOnlyIds).sort((a, b) => Number(a) - Number(b))[0];
            const groupName = albumTitles.get(firstAlbumId) || 'Unknown Album';

            versionGroups.push({
                groupId,
                groupName,
                albumIds: artistOnlyIds
            });
        }

        console.log(`[VERSION-GROUPER] Created ${versionGroups.length} version groups`);
        return versionGroups;
    }

    /**
     * Generate a unique numeric group ID from a set of album IDs.
     * Uses hash of sorted album IDs to ensure consistency.
     */
    static generateGroupId(albumIds: Set<string>): number {
        const sorted = Array.from(albumIds).sort((a, b) => Number(a) - Number(b));
        const idString = sorted.join('|');

        // Create a hash and convert to a 32-bit integer
        const hash = crypto.createHash('md5').update(idString).digest('hex');
        // Take first 8 hex chars (32 bits) and convert to unsigned integer
        return parseInt(hash.substring(0, 8), 16);
    }

    /**
     * Apply version groups to album_artists table for an artist
     */
    static async applyVersionGroups(artistId: string): Promise<void> {
        const groups = await this.buildVersionGroups(artistId);

        if (groups.length === 0) {
            console.log(`[VERSION-GROUPER] No groups to apply for artist ${artistId}`);
            return;
        }

        const updateStmt = db.prepare(`
            UPDATE album_artists 
            SET version_group_id = ?, version_group_name = ?
            WHERE artist_id = ? AND album_id = ?
        `);

        let totalUpdated = 0;
        db.transaction(() => {
            for (const group of groups) {
                for (const albumId of group.albumIds) {
                    updateStmt.run(group.groupId, group.groupName, artistId, albumId);
                    totalUpdated++;
                }
            }
        })();

        console.log(`[VERSION-GROUPER] Applied version_group to ${totalUpdated} album_artists rows for artist ${artistId}`);
    }
}
