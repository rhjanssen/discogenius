import path from "path";
import { db } from "../database.js";
import { getAlbum, getArtistVideos, getTrack, getVideo, searchTidal } from "./providers/tidal/tidal.js";
import { IdentificationService, type AlbumCandidateMatch, type IdentifiableFile } from "./identification-service.js";
import { ImportDecisionEngine } from "./import-decision/engine.js";
import type { ImportDecisionMode } from "./import-decision/types.js";
import { extractTrackStem } from "./import-discovery.js";
import { normalizeComparableText, stringSimilarity } from "./import-matching-utils.js";
import type {
    ImportCandidate,
    LocalGroup,
    RootFolderImportProgressEvent,
    TidalMatch,
} from "./import-types.js";

type DirectGroupIdentifiers = {
    albumIds: string[];
    trackIds: string[];
    videoIds: string[];
    upcs: string[];
};

type AlbumMatchEvidence = AlbumCandidateMatch & {
    trackIdsByFilePath: Record<string, string>;
};

type MatchEvidenceSignals = {
    directCandidateIds?: Set<string>;
    fingerprintCandidateIds?: Set<string>;
    fingerprintTrackHints?: Map<string, Record<string, string>>;
    upcs?: Set<string>;
};

export class ImportMatcherService {
    async findMatches(
        groups: LocalGroup[],
        context: "music" | "atmos" | "video" = "music",
        options?: { onProgress?: (event: RootFolderImportProgressEvent) => void },
        mode: ImportDecisionMode = "NewDownload",
    ): Promise<ImportCandidate[]> {
        const results: ImportCandidate[] = [];
        const totalFiles = groups.reduce((sum, group) => sum + group.files.length, 0);
        const totalGroups = groups.length;
        let processedFiles = 0;

        if (totalFiles === 0) {
            options?.onProgress?.({
                message: "No files found for import evaluation",
                currentFileNum: 0,
                totalFiles: 0,
                currentGroupNum: 0,
                totalGroups,
            });
        }

        for (let index = 0; index < groups.length; index += 1) {
            const group = groups[index];
            const matches = await this.matchGroup(group, context, mode);
            results.push({
                group,
                matches,
            });

            processedFiles += group.files.length;
            options?.onProgress?.({
                message: `Reading file ${processedFiles}/${totalFiles}`,
                currentFileNum: processedFiles,
                totalFiles,
                currentGroupNum: index + 1,
                totalGroups,
            });
        }
        return results;
    }

    async findMatchesForGroup(
        group: LocalGroup,
        context: "music" | "atmos" | "video" = "music",
        mode: ImportDecisionMode = "NewDownload",
    ): Promise<TidalMatch[]> {
        return this.matchGroup(group, context, mode);
    }

    private getCandidateKey(candidate: any): string | null {
        const directId = candidate?.id?.toString?.();
        if (directId) {
            return directId;
        }

        const artistId = candidate?.artist_id?.toString?.() ?? candidate?.artist?.id?.toString?.() ?? candidate?.artists?.[0]?.id?.toString?.();
        const title = candidate?.title ?? candidate?.name ?? null;
        if (!artistId || !title) {
            return null;
        }

        return `${artistId}:${title}`;
    }

    private mergeCandidates(...sources: any[][]): any[] {
        const merged = new Map<string, any>();

        for (const source of sources) {
            for (const candidate of source) {
                const key = this.getCandidateKey(candidate);
                if (!key || merged.has(key)) {
                    continue;
                }

                merged.set(key, candidate);
            }
        }

        return Array.from(merged.values());
    }

    private async ensureFingerprints(group: LocalGroup): Promise<void> {
        const { calculateFingerprint } = await import("./audioUtils.js");

        for (const file of group.files) {
            if (file.fingerprint !== undefined) {
                continue;
            }

            if (![".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".alac", ".aiff"].includes(file.extension)) {
                file.fingerprint = null;
                continue;
            }

            file.fingerprint = await calculateFingerprint(file.path);
        }
    }

    private normalizeBarcode(value: unknown): string | null {
        if (value === null || value === undefined) {
            return null;
        }

        const normalized = String(value).replace(/\D/g, "");
        return normalized.length >= 12 && normalized.length <= 14 ? normalized : null;
    }

    private extractTextIdentifiers(text: string, identifiers: {
        albumIds: Set<string>;
        trackIds: Set<string>;
        videoIds: Set<string>;
        upcs: Set<string>;
    }) {
        const tidalUrlRegex = /(?:https?:\/\/)?(?:listen\.|www\.)?tidal\.com(?:\/browse)?\/(album|track|video|artist)\/(\d+)/gi;
        const labeledTidalIdRegex = /\btidal[\s_-]*(album|track|video|artist)(?:[\s_-]*id)?\s*[:=]\s*(\d+)\b/gi;
        const labeledUpcRegex = /\b(?:upc|barcode|ean)\s*[:=]\s*([\d -]{12,20})\b/gi;

        let match: RegExpExecArray | null;
        while ((match = tidalUrlRegex.exec(text)) !== null) {
            const entityType = match[1].toLowerCase();
            const entityId = match[2];
            if (entityType === "album") identifiers.albumIds.add(entityId);
            if (entityType === "track") identifiers.trackIds.add(entityId);
            if (entityType === "video") identifiers.videoIds.add(entityId);
        }

        while ((match = labeledTidalIdRegex.exec(text)) !== null) {
            const entityType = match[1].toLowerCase();
            const entityId = match[2];
            if (entityType === "album") identifiers.albumIds.add(entityId);
            if (entityType === "track") identifiers.trackIds.add(entityId);
            if (entityType === "video") identifiers.videoIds.add(entityId);
        }

        while ((match = labeledUpcRegex.exec(text)) !== null) {
            const upc = this.normalizeBarcode(match[1]);
            if (upc) {
                identifiers.upcs.add(upc);
            }
        }
    }

    private collectDirectIdentifiers(group: LocalGroup): DirectGroupIdentifiers {
        const identifiers = {
            albumIds: new Set<string>(),
            trackIds: new Set<string>(),
            videoIds: new Set<string>(),
            upcs: new Set<string>(),
        };

        const addPossibleBarcode = (value: unknown) => {
            if (Array.isArray(value)) {
                for (const entry of value) {
                    addPossibleBarcode(entry);
                }
                return;
            }

            const barcode = this.normalizeBarcode(value);
            if (barcode) {
                identifiers.upcs.add(barcode);
            }
        };

        this.extractTextIdentifiers(group.path, identifiers);

        const tidalIdMatch = group.path.match(/\[TIDAL-(\d+)\]/i);
        if (tidalIdMatch) {
            identifiers.albumIds.add(tidalIdMatch[1]);
        }

        for (const file of group.files) {
            this.extractTextIdentifiers(file.path, identifiers);

            const common = (file.metadata?.common || {}) as Record<string, any>;
            const freeTextValues = [
                common.comment,
                common.description,
                common.website,
                common.url,
                common.source,
                common.grouping,
            ].flat().filter(Boolean);

            for (const value of freeTextValues) {
                this.extractTextIdentifiers(String(value), identifiers);
            }

            addPossibleBarcode(common.barcode);
            addPossibleBarcode(common.upc);
            addPossibleBarcode(common.ean);

            const nativeTags = Object.values((file.metadata?.native || {}) as Record<string, Array<{ id?: string; value?: unknown }>>);
            for (const tagGroup of nativeTags) {
                for (const tag of tagGroup) {
                    if (!tag) {
                        continue;
                    }

                    this.extractTextIdentifiers(String(tag.id || ""), identifiers);

                    const values = Array.isArray(tag.value) ? tag.value : [tag.value];
                    for (const value of values) {
                        if (value === null || value === undefined) {
                            continue;
                        }

                        if (typeof value === "string") {
                            this.extractTextIdentifiers(value, identifiers);
                            addPossibleBarcode(value);
                        } else {
                            addPossibleBarcode(value);
                            this.extractTextIdentifiers(JSON.stringify(value), identifiers);
                        }
                    }
                }
            }
        }

        return {
            albumIds: Array.from(identifiers.albumIds),
            trackIds: Array.from(identifiers.trackIds),
            videoIds: Array.from(identifiers.videoIds),
            upcs: Array.from(identifiers.upcs),
        };
    }

    private async getDirectIdentifierCandidates(
        identifiers: DirectGroupIdentifiers,
        context: "music" | "atmos" | "video"
    ): Promise<any[]> {
        const resolvedCandidates: any[] = [];
        const uniqueAlbumIds = Array.from(new Set(identifiers.albumIds));
        const uniqueVideoIds = Array.from(new Set(identifiers.videoIds));
        const uniqueUpcs = Array.from(new Set(identifiers.upcs));

        if (context === "video" && uniqueVideoIds.length === 1) {
            try {
                const video = await getVideo(uniqueVideoIds[0]);
                if (video) {
                    resolvedCandidates.push(video);
                }
            } catch (error) {
                console.warn(`[Import] Failed to resolve embedded TIDAL video ID ${uniqueVideoIds[0]}:`, error);
            }
        }

        if (context === "video") {
            return resolvedCandidates;
        }

        if (uniqueAlbumIds.length === 1) {
            try {
                const album = await getAlbum(uniqueAlbumIds[0]);
                if (album) {
                    resolvedCandidates.push(album);
                }
            } catch (error) {
                console.warn(`[Import] Failed to resolve embedded TIDAL album ID ${uniqueAlbumIds[0]}:`, error);
            }
        }

        if (identifiers.trackIds.length > 0) {
            const albumIdsFromTracks = new Set<string>();

            for (const trackId of identifiers.trackIds) {
                try {
                    const track = await getTrack(trackId);
                    if (track?.album_id) {
                        albumIdsFromTracks.add(String(track.album_id));
                    }
                } catch (error) {
                    console.warn(`[Import] Failed to resolve embedded TIDAL track ID ${trackId}:`, error);
                }

                if (albumIdsFromTracks.size > 1) {
                    break;
                }
            }

            if (albumIdsFromTracks.size === 1) {
                const [albumId] = Array.from(albumIdsFromTracks);
                try {
                    const album = await getAlbum(albumId);
                    if (album) {
                        resolvedCandidates.push(album);
                    }
                } catch (error) {
                    console.warn(`[Import] Failed to resolve album ${albumId} from embedded TIDAL track IDs:`, error);
                }
            }
        }

        if (uniqueUpcs.length === 1) {
            try {
                const searchResults = await searchTidal(uniqueUpcs[0], "albums", 5);
                const searchCandidates = Array.isArray(searchResults) ? searchResults : [];
                const exactUpcMatch = searchCandidates.find((candidate) =>
                    this.normalizeBarcode(candidate?.upc) === uniqueUpcs[0]
                );

                if (exactUpcMatch) {
                    resolvedCandidates.push(exactUpcMatch);
                }
            } catch (error) {
                console.warn(`[Import] Failed to resolve embedded UPC ${uniqueUpcs[0]}:`, error);
            }
        }

        return this.mergeCandidates(resolvedCandidates);
    }

    private async getFingerprintCandidates(
        group: LocalGroup,
        context: "music" | "atmos" | "video"
    ): Promise<{ candidates: any[]; strongCandidateIds: Set<string>; trackHintsByCandidateId: Map<string, Record<string, string>> }> {
        if (context === "video") {
            return { candidates: [], strongCandidateIds: new Set<string>(), trackHintsByCandidateId: new Map<string, Record<string, string>>() };
        }

        await this.ensureFingerprints(group);
        const fingerprints = group.files
            .map((file) => file.fingerprint)
            .filter(Boolean) as string[];

        if (fingerprints.length === 0) {
            return { candidates: [], strongCandidateIds: new Set<string>(), trackHintsByCandidateId: new Map<string, Record<string, string>>() };
        }

        const candidates: any[] = [];
        const strongCandidateIds = new Set<string>();
        const trackHintsByCandidateId = new Map<string, Record<string, string>>();
        const strongThreshold = Math.max(1, Math.ceil(fingerprints.length * 0.6));

        const placeholders = fingerprints.map(() => "?").join(", ");
        const rows = db.prepare(`
            SELECT COALESCE(m.album_id, lf.album_id) AS album_id, COUNT(*) AS matched_files
            FROM library_files lf
            LEFT JOIN media m ON m.id = lf.media_id
            WHERE lf.file_type = 'track'
              AND lf.fingerprint IN (${placeholders})
              AND COALESCE(m.album_id, lf.album_id) IS NOT NULL
            GROUP BY COALESCE(m.album_id, lf.album_id)
            ORDER BY matched_files DESC
        `).all(...fingerprints) as Array<{ album_id: string; matched_files: number }>;

        for (const row of rows) {
            try {
                const album = await getAlbum(String(row.album_id));
                if (!album) {
                    continue;
                }

                candidates.push(album);
                if (row.matched_files >= strongThreshold) {
                    const candidateKey = this.getCandidateKey(album);
                    if (candidateKey) {
                        strongCandidateIds.add(candidateKey);
                    }
                }
            } catch (error) {
                console.warn(`[Import] Failed to hydrate fingerprint candidate album ${row.album_id}:`, error);
            }
        }

        if (rows.length === 0) {
            const remoteEvidence = await this.getRemoteFingerprintCandidates(group);
            for (const candidate of remoteEvidence.candidates) {
                candidates.push(candidate);
            }
            for (const candidateId of remoteEvidence.strongCandidateIds) {
                strongCandidateIds.add(candidateId);
            }
            for (const [candidateId, hints] of remoteEvidence.trackHintsByCandidateId.entries()) {
                trackHintsByCandidateId.set(candidateId, hints);
            }
        }

        return { candidates: this.mergeCandidates(candidates), strongCandidateIds, trackHintsByCandidateId };
    }

    private async getRemoteFingerprintCandidates(
        group: LocalGroup
    ): Promise<{ candidates: any[]; strongCandidateIds: Set<string>; trackHintsByCandidateId: Map<string, Record<string, string>> }> {
        const { generateFingerprint, lookupAcoustId, lookupMusicBrainzRecording } = await import("./fingerprint.js");

        const candidates: any[] = [];
        const strongCandidateIds = new Set<string>();
        const trackHintsByCandidateId = new Map<string, Record<string, string>>();
        const albumsById = new Map<string, any>();
        const albumMatchedFiles = new Map<string, number>();
        const albumStrongFiles = new Map<string, number>();
        const seenRecordingIds = new Set<string>();
        let fingerprintedFiles = 0;

        for (const file of group.files.slice(0, 3)) {
            if (![".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg", ".opus", ".alac", ".aiff"].includes(file.extension)) {
                continue;
            }

            let fingerprintResult: { duration: number; fingerprint: string } | null = null;
            try {
                fingerprintResult = await generateFingerprint(file.path);
                file.fingerprint = fingerprintResult.fingerprint;
                fingerprintedFiles += 1;
            } catch (error) {
                console.warn(`[Import] Failed to fingerprint ${file.path} for remote matching:`, error);
                continue;
            }

            const fileAlbumIds = new Set<string>();
            const fileStrongAlbumIds = new Set<string>();
            const seenTrackIdsForFile = new Set<string>();
            const recordingIds = await lookupAcoustId(fingerprintResult.fingerprint, fingerprintResult.duration);
            for (const recordingId of recordingIds.slice(0, 4)) {
                if (seenRecordingIds.has(recordingId)) {
                    continue;
                }
                seenRecordingIds.add(recordingId);

                const recording = await lookupMusicBrainzRecording(recordingId);
                if (!recording?.title) {
                    continue;
                }

                const primaryArtist = recording.artists[0] || group.commonTags.artist || "";
                const query = [primaryArtist, recording.title].filter(Boolean).join(" ").trim();
                if (!query) {
                    continue;
                }

                let trackResults: any[] = [];
                try {
                    const searchResults = await searchTidal(query, "tracks", 10);
                    trackResults = Array.isArray(searchResults) ? searchResults : [];
                } catch (error) {
                    console.warn(`[Import] Failed to search TIDAL tracks for fingerprint query "${query}":`, error);
                    continue;
                }

                for (const trackResult of trackResults) {
                    const trackId = trackResult?.id?.toString?.();
                    if (!trackId || seenTrackIdsForFile.has(trackId)) {
                        continue;
                    }
                    seenTrackIdsForFile.add(trackId);

                    let trackDetails: any = trackResult;
                    if (!trackDetails?.isrc) {
                        try {
                            trackDetails = await getTrack(trackId);
                        } catch (error) {
                            console.warn(`[Import] Failed to hydrate fingerprint-matched track ${trackId}:`, error);
                            continue;
                        }
                    }

                    const titleScore = stringSimilarity(
                        normalizeComparableText(recording.title),
                        normalizeComparableText(trackDetails?.title || trackResult?.title || "")
                    );
                    const artistScore = primaryArtist
                        ? stringSimilarity(
                            normalizeComparableText(primaryArtist),
                            normalizeComparableText(trackDetails?.artist_name || trackResult?.artist_name || "")
                        )
                        : 0;
                    const isrcMatch = Boolean(trackDetails?.isrc)
                        && recording.isrcs.some((isrc) => normalizeComparableText(isrc) === normalizeComparableText(trackDetails.isrc));
                    const durationMatches = !trackDetails?.duration
                        || !fingerprintResult.duration
                        || Math.abs(Number(trackDetails.duration) - Number(fingerprintResult.duration)) <= 5;

                    if (!isrcMatch && titleScore < 0.84) {
                        continue;
                    }
                    if (!isrcMatch && primaryArtist && artistScore < 0.65) {
                        continue;
                    }
                    if (!isrcMatch && !durationMatches) {
                        continue;
                    }

                    const albumId = trackDetails?.album_id?.toString?.() ?? trackResult?.album_id?.toString?.();
                    if (!albumId) {
                        continue;
                    }

                    try {
                        if (!albumsById.has(albumId)) {
                            const album = await getAlbum(albumId);
                            if (!album) {
                                continue;
                            }
                            albumsById.set(albumId, album);
                        }

                        fileAlbumIds.add(albumId);
                        if (isrcMatch || titleScore >= 0.96) {
                            fileStrongAlbumIds.add(albumId);
                            const existingHints = trackHintsByCandidateId.get(albumId) || {};
                            existingHints[file.path] = trackId;
                            trackHintsByCandidateId.set(albumId, existingHints);
                        }
                    } catch (error) {
                        console.warn(`[Import] Failed to hydrate fingerprint-matched album ${albumId}:`, error);
                    }
                }
            }

            for (const albumId of fileAlbumIds) {
                albumMatchedFiles.set(albumId, (albumMatchedFiles.get(albumId) || 0) + 1);
            }
            for (const albumId of fileStrongAlbumIds) {
                albumStrongFiles.set(albumId, (albumStrongFiles.get(albumId) || 0) + 1);
            }
        }

        const strongThreshold = Math.max(1, Math.ceil(Math.max(fingerprintedFiles, 1) * 0.6));
        for (const [albumId, album] of albumsById.entries()) {
            candidates.push(album);

            const candidateKey = this.getCandidateKey(album);
            if (!candidateKey) {
                continue;
            }

            const matchedFiles = albumMatchedFiles.get(albumId) || 0;
            const strongFiles = albumStrongFiles.get(albumId) || 0;
            if (matchedFiles >= strongThreshold || strongFiles >= strongThreshold) {
                strongCandidateIds.add(candidateKey);
            }
        }

        return {
            candidates: this.mergeCandidates(candidates),
            strongCandidateIds,
            trackHintsByCandidateId,
        };
    }

    private scoreCandidates(
        group: LocalGroup,
        candidates: any[],
        context: "music" | "atmos" | "video",
        itemType: "album" | "video",
        evidence?: MatchEvidenceSignals,
        albumEvidence?: Map<string, AlbumMatchEvidence>,
        mode: ImportDecisionMode = "NewDownload"
    ): TidalMatch[] {
        const validMatches: TidalMatch[] = [];

        for (const candidate of candidates) {
            const candidateId = this.getCandidateKey(candidate);
            const evaluation = candidateId ? albumEvidence?.get(candidateId) : undefined;
            const fingerprintTrackHints = candidateId ? evidence?.fingerprintTrackHints?.get(candidateId) : undefined;

            let score = evaluation
                ? mode === "ExistingFiles"
                    ? evaluation.closeMatchScore
                    : evaluation.combinedScore
                : itemType === "video"
                    ? this.calculateVideoScore(group, candidate)
                    : this.calculateScore(group, candidate, context);

            let matchType: TidalMatch["matchType"] = score > 0.9 ? "exact" : "fuzzy";

            if (candidateId && evidence?.directCandidateIds?.has(candidateId)) {
                score = Math.max(score, 0.9);
                matchType = "exact";
            } else if (candidateId && evidence?.fingerprintCandidateIds?.has(candidateId)) {
                score = Math.max(score, 0.88);
                matchType = "fingerprint";
            } else if (itemType === "album") {
                const candidateUpc = this.normalizeBarcode(candidate?.upc);
                if (candidateUpc && evidence?.upcs?.has(candidateUpc)) {
                    score = Math.max(score, 0.9);
                    matchType = "exact";
                }
            }

            score += this.calculateReleaseCompatibilityAdjustment(group, candidate, context, itemType);

            if (score > 0.4) {
                let matchedCount = evaluation?.matchedCount;
                const totalFiles = evaluation?.totalFiles ?? group.files.length;
                let confidence = mode === "ExistingFiles"
                    ? evaluation?.closeMatchConfidence ?? evaluation?.confidence
                    : evaluation?.confidence;
                const closeMatchScore = evaluation?.closeMatchScore;
                let closeMatchConfidence = evaluation?.closeMatchConfidence;
                let coverage = evaluation?.coverage;
                let trackIdsByFilePath = evaluation?.trackIdsByFilePath;

                if (fingerprintTrackHints && Object.keys(fingerprintTrackHints).length > 0) {
                    const hintedMatches = Object.keys(fingerprintTrackHints).length;
                    matchedCount = Math.max(matchedCount ?? 0, hintedMatches);
                    coverage = totalFiles > 0 ? matchedCount / totalFiles : 0;
                    const hintedConfidence = coverage >= 1 ? 0.84 : 0.68;
                    confidence = Math.max(confidence ?? 0, hintedConfidence);
                    closeMatchConfidence = Math.max(closeMatchConfidence ?? 0, hintedConfidence);
                    trackIdsByFilePath = {
                        ...(trackIdsByFilePath || {}),
                        ...fingerprintTrackHints,
                    };
                }

                const normalizedScore = Math.min(score, 1);
                const normalizedCloseMatchScore = itemType === "album"
                    ? closeMatchScore ?? normalizedScore
                    : undefined;
                const normalizedCloseMatchConfidence = itemType === "album"
                    ? closeMatchConfidence ?? confidence
                    : undefined;

                validMatches.push({
                    item: candidate,
                    itemType,
                    score: normalizedScore,
                    closeMatchScore: normalizedCloseMatchScore,
                    matchType,
                    confidence,
                    closeMatchConfidence: normalizedCloseMatchConfidence,
                    coverage,
                    matchedCount,
                    totalFiles,
                    autoImportReady: false,
                    trackIdsByFilePath,
                });
            }
        }

        return this.applyAutoImportPolicy(group, validMatches, itemType, evidence, mode);
    }

    private groupSuggestsSpatialAudio(group: LocalGroup): boolean {
        const combinedPath = `${group.path} ${group.files.map((file) => file.name).join(" ")}`.toLowerCase();
        if (/(dolby[_ -]?atmos|atmos|sony[_ -]?360|360ra|spatial)/.test(combinedPath)) {
            return true;
        }

        return group.files.some((file) => {
            const channels = file.metadata?.format?.numberOfChannels || 0;
            return channels > 2;
        });
    }

    private getLocalExplicitPreference(group: LocalGroup): "explicit" | "clean" | null {
        const combinedPath = `${group.path} ${group.files.map((file) => file.name).join(" ")}`.toLowerCase();
        if (/\[(?:e|explicit)\]|(?:^|[\s_-])explicit(?:$|[\s_-])/.test(combinedPath)) {
            return "explicit";
        }
        if (/(?:^|[\s_-])clean(?:$|[\s_-])/.test(combinedPath)) {
            return "clean";
        }
        return null;
    }

    private calculateReleaseCompatibilityAdjustment(
        group: LocalGroup,
        candidate: any,
        context: "music" | "atmos" | "video",
        itemType: "album" | "video",
    ): number {
        if (itemType === "video") {
            return 0;
        }

        let adjustment = 0;
        const localLooksSpatial = this.groupSuggestsSpatialAudio(group);
        const localExplicitPreference = this.getLocalExplicitPreference(group);
        const candidateIsAtmos = candidate?.quality === "DOLBY_ATMOS"
            || candidate?.audio_quality === "DOLBY_ATMOS"
            || candidate?.audioModes?.includes?.("DOLBY_ATMOS");

        if (context === "music" && candidateIsAtmos && !localLooksSpatial) {
            adjustment -= 0.18;
        }

        if (context === "atmos" && candidateIsAtmos) {
            adjustment += 0.08;
        }

        if (localExplicitPreference === "explicit") {
            adjustment += candidate?.explicit ? 0.08 : -0.08;
        } else if (localExplicitPreference === "clean") {
            adjustment += candidate?.explicit ? -0.08 : 0.08;
        }

        return adjustment;
    }

    private applyAutoImportPolicy(
        group: LocalGroup,
        matches: TidalMatch[],
        itemType: "album" | "video",
        evidence?: MatchEvidenceSignals,
        mode: ImportDecisionMode = "NewDownload",
    ): TidalMatch[] {
        return ImportDecisionEngine.evaluateMatches({
            group,
            matches,
            mode,
            directCandidateCount: evidence?.directCandidateIds?.size || 0,
            strongFingerprintCandidateCount: evidence?.fingerprintCandidateIds?.size || 0,
        });
    }

    private toIdentifiableFiles(group: LocalGroup): IdentifiableFile[] {
        return group.files.map((file, index) => ({
            id: index + 1,
            filename: file.name,
            duration: file.metadata?.format?.duration ?? null,
            detected_artist: group.commonTags.artist || file.metadata?.common?.artist || null,
            detected_album: group.commonTags.album || file.metadata?.common?.album || null,
            detected_track: file.metadata?.common?.title || path.parse(file.name).name,
            file_path: file.path,
            relative_path: path.relative(group.rootPath, file.path),
        }));
    }

    private async buildAlbumMatchEvidence(
        group: LocalGroup,
        candidates: any[]
    ): Promise<Map<string, AlbumMatchEvidence>> {
        const evidence = new Map<string, AlbumMatchEvidence>();
        if (candidates.length === 0) {
            return evidence;
        }

        const identifiableFiles = this.toIdentifiableFiles(group);
        if (identifiableFiles.length === 0) {
            return evidence;
        }

        const fileById = new Map(identifiableFiles.map((file) => [file.id, file]));
        const scoredCandidates = await IdentificationService.scoreAlbumCandidates(identifiableFiles, candidates);

        for (const scored of scoredCandidates) {
            const candidateId = this.getCandidateKey(scored.album);
            if (!candidateId) {
                continue;
            }

            const trackIdsByFilePath: Record<string, string> = {};
            for (const [fileId, trackId] of Object.entries(scored.mappedTracks)) {
                const file = fileById.get(Number(fileId));
                if (!file?.file_path) {
                    continue;
                }

                trackIdsByFilePath[file.file_path] = trackId;
            }

            evidence.set(candidateId, {
                ...scored,
                trackIdsByFilePath,
            });
        }

        return evidence;
    }

    private async getTrackBackfilledAlbumCandidates(group: LocalGroup, queries: string[]): Promise<any[]> {
        const albums: any[] = [];
        const seenAlbumIds = new Set<string>();

        for (const query of queries) {
            if (!query) {
                continue;
            }

            let trackResults: any[] = [];
            try {
                const results = await searchTidal(query, "tracks", 5);
                trackResults = Array.isArray(results) ? results : [];
            } catch {
                continue;
            }

            for (const track of trackResults) {
                const albumId = track?.album_id?.toString?.();
                if (!albumId || seenAlbumIds.has(albumId)) {
                    continue;
                }

                const trackArtist = track?.artist_name?.toLowerCase?.();
                const groupArtist = group.commonTags.artist?.toLowerCase();
                if (groupArtist && trackArtist && !trackArtist.includes(groupArtist) && !groupArtist.includes(trackArtist)) {
                    continue;
                }

                seenAlbumIds.add(albumId);

                try {
                    const album = await getAlbum(albumId);
                    if (album) {
                        albums.push(album);
                    }
                } catch (error) {
                    console.warn(`[Import] Failed to hydrate album ${albumId} from track search:`, error);
                }
            }
        }

        return albums;
    }

    private async matchGroup(
        group: LocalGroup,
        context: "music" | "atmos" | "video",
        mode: ImportDecisionMode = "NewDownload"
    ): Promise<TidalMatch[]> {
        const { artist, album } = group.commonTags;
        const directIdentifiers = this.collectDirectIdentifiers(group);
        const directCandidates = await this.getDirectIdentifierCandidates(directIdentifiers, context);
        const fingerprintEvidence = await this.getFingerprintCandidates(group, context);
        const directCandidateIds = new Set(
            directCandidates
                .map((candidate) => this.getCandidateKey(candidate))
                .filter(Boolean) as string[]
        );
        const directUpcs = new Set(directIdentifiers.upcs);

        const fallbackTitle = group.files[0]?.metadata?.common?.title
            || path.parse(group.files[0]?.name || "Unknown").name;
        const searchTitle = album || fallbackTitle;

        const queryParts = [artist, searchTitle].filter(Boolean);
        if (queryParts.length === 0) return [];

        const query = queryParts.join(" ");
        let searchCandidates: any[] = [];
        try {
            const results = await searchTidal(query, context === "video" ? "videos" : "albums", 5);
            searchCandidates = Array.isArray(results) ? results : [];
        } catch {
            searchCandidates = [];
        }

        let artistVideosCandidates: any[] = [];
        if (context === "video") {
            const artistId = this.resolveArtistIdByName(artist);
            if (artistId) {
                try {
                    artistVideosCandidates = (await getArtistVideos(artistId)).slice(0, 30);
                } catch (error) {
                    console.warn("[Import] Failed to fetch artist-scoped videos:", error);
                }
            }
        }

        const initialCandidates = this.mergeCandidates(
            directCandidates,
            fingerprintEvidence.candidates,
            searchCandidates,
            artistVideosCandidates,
        );
        const trackQueries = context === "video"
            ? []
            : Array.from(new Set([
                [artist, fallbackTitle].filter(Boolean).join(" ").trim(),
                query,
                ...group.files
                    .slice(0, 3)
                    .map((file) => [artist, extractTrackStem(file.name)].filter(Boolean).join(" ").trim())
                    .filter(Boolean),
            ].filter(Boolean)));
        const trackBackfilledAlbums = context === "video"
            ? []
            : await this.getTrackBackfilledAlbumCandidates(group, trackQueries);
        const candidates = context === "video"
            ? initialCandidates
            : this.mergeCandidates(initialCandidates, trackBackfilledAlbums);
        const albumEvidence = context === "video"
            ? undefined
            : await this.buildAlbumMatchEvidence(group, candidates);

        let validMatches = this.scoreCandidates(
            group,
            candidates,
            context,
            context === "video" ? "video" : "album",
            {
                directCandidateIds,
                fingerprintCandidateIds: fingerprintEvidence.strongCandidateIds,
                fingerprintTrackHints: fingerprintEvidence.trackHintsByCandidateId,
                upcs: directUpcs,
            },
            albumEvidence,
            mode
        );

        if (context !== "video" && validMatches.length === 0) {
            const mergedAlbums = this.mergeCandidates(
                directCandidates,
                fingerprintEvidence.candidates,
                searchCandidates,
                trackBackfilledAlbums
            );
            const backfilledEvidence = await this.buildAlbumMatchEvidence(group, mergedAlbums);
            validMatches = this.scoreCandidates(
                group,
                mergedAlbums,
                context,
                "album",
                {
                    directCandidateIds,
                    fingerprintCandidateIds: fingerprintEvidence.strongCandidateIds,
                    fingerprintTrackHints: fingerprintEvidence.trackHintsByCandidateId,
                    upcs: directUpcs,
                },
                backfilledEvidence,
                mode
            );
        }

        // Video ambiguity check: if gap between top-1 and top-2 is < 0.15, require manual review
        if (context === "video" && validMatches.length >= 2) {
            const sorted = [...validMatches].sort((a, b) => b.score - a.score);
            if (sorted[0].score - sorted[1].score < 0.15) {
                const topMatch = sorted[0];
                const ambiguityReason = "Ambiguous: score gap to next candidate is below threshold";
                validMatches = validMatches.map((m) =>
                    m === topMatch
                        ? {
                            ...m,
                            autoImportReady: false,
                            rejections: [...(m.rejections || []), ambiguityReason],
                            typedRejections: [...(m.typedRejections || []), { reason: ambiguityReason, type: "temporary" as const }],
                        }
                        : m
                );
            }
        }

        return validMatches;
    }

    private resolveArtistIdByName(artistName: string | undefined): string | null {
        if (!artistName) return null;
        const row = db.prepare("SELECT id FROM artists WHERE LOWER(name) = LOWER(?) LIMIT 1")
            .get(artistName) as { id: number } | undefined;
        return row ? String(row.id) : null;
    }

    private stripVersionSuffix(title: string): string {
        return title
            .replace(/\s*[([]\s*(?:explicit|clean|censored|remaster(?:ed)?|remix|live|deluxe|extended|radio\s*edit|acoustic|instrumental|version|edit|feat\..+?|ft\..+?)\s*[)\]]/gi, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    private calculateScore(group: LocalGroup, tidalAlbum: any, context: "music" | "atmos" | "video"): number {
        const localArtist = normalizeComparableText(group.commonTags.artist);
        const localAlbum = normalizeComparableText(group.commonTags.album);
        const tidalArtist = normalizeComparableText(tidalAlbum.artist?.name || tidalAlbum.artists?.[0]?.name);
        const tidalAlbumTitle = normalizeComparableText(tidalAlbum.title);
        const localLooksSpatial = this.groupSuggestsSpatialAudio(group);

        let weightedScore = 0;
        let totalWeight = 0;

        if (localArtist && tidalArtist) {
            weightedScore += stringSimilarity(localArtist, tidalArtist) * 0.45;
            totalWeight += 0.45;
        }

        if (localAlbum && tidalAlbumTitle) {
            weightedScore += stringSimilarity(localAlbum, tidalAlbumTitle) * 0.55;
            totalWeight += 0.55;
        }

        if (totalWeight === 0) {
            return 0;
        }

        let score = weightedScore / totalWeight;

        if (!localArtist || !localAlbum) {
            score *= 0.92;
        }

        const remoteReleaseDate = tidalAlbum.releaseDate || tidalAlbum.release_date;
        if (group.commonTags.year && remoteReleaseDate) {
            const localYear = parseInt(group.commonTags.year.toString());
            const tidalYear = new Date(remoteReleaseDate).getFullYear();
            if (!isNaN(localYear) && !isNaN(tidalYear) && localYear !== tidalYear) {
                if (Math.abs(localYear - tidalYear) > 1) {
                    score -= 0.1;
                }
            }
        }

        if (tidalAlbum.numberOfTracks && group.files.length > 0) {
            const trackDiff = Math.abs(group.files.length - tidalAlbum.numberOfTracks);
            if (trackDiff === 0) score += 0.05;
            else if (trackDiff > 5) score -= 0.1;
        }

        if (context === "atmos") {
            const isAtmos = tidalAlbum.quality === "DOLBY_ATMOS" ||
                (tidalAlbum.audioModes && tidalAlbum.audioModes.includes("DOLBY_ATMOS"));
            if (isAtmos) score += 0.2;
            else score -= 0.3;
        } else if (context === "music") {
            const isAtmos = tidalAlbum.quality === "DOLBY_ATMOS" ||
                (tidalAlbum.audioModes && tidalAlbum.audioModes.includes("DOLBY_ATMOS"));
            if (isAtmos && !localLooksSpatial) {
                score -= 0.18;
            }
        }

        return Math.min(Math.max(score, 0), 1);
    }

    private calculateVideoScore(group: LocalGroup, tidalVideo: any): number {
        const fallbackTitle = group.files[0]?.metadata?.common?.title
            || path.parse(group.files[0]?.name || "Unknown").name;
        const rawLocalTitle = group.commonTags.album || fallbackTitle || "";
        const rawTidalTitle = tidalVideo.title || "";

        if (!rawLocalTitle || !rawTidalTitle) return 0;

        const localTitle = normalizeComparableText(this.stripVersionSuffix(rawLocalTitle));
        const tidalTitle = normalizeComparableText(this.stripVersionSuffix(rawTidalTitle));
        const localArtist = group.commonTags.artist
            ? normalizeComparableText(group.commonTags.artist)
            : null;
        const tidalArtist = normalizeComparableText(
            tidalVideo.artist?.name || tidalVideo.artists?.[0]?.name || tidalVideo.artist_name || ""
        );

        const titleScore = stringSimilarity(localTitle, tidalTitle);
        const artistScore = (localArtist && tidalArtist) ? stringSimilarity(localArtist, tidalArtist) : 0;

        // Duration score: 0→1 over ±30s proximity window; omitted if either side unavailable
        const localDuration = group.files[0]?.metadata?.format?.duration ?? null;
        const tidalDuration = tidalVideo.duration ?? null;
        let durationScore = 0;
        let durationWeight = 0;
        if (localDuration != null && tidalDuration != null) {
            const diff = Math.abs(Number(localDuration) - Number(tidalDuration));
            durationScore = Math.max(0, 1 - diff / 30);
            durationWeight = 0.20;
        }

        // Year score: 1.0 at same year, decays 0.15/year, 0 at ±4+ years; omitted if unavailable
        const localYear = group.commonTags.year ?? null;
        const tidalReleaseDate = tidalVideo.release_date ?? null;
        let yearScore = 0;
        let yearWeight = 0;
        if (localYear != null && tidalReleaseDate != null) {
            const tidalYear = new Date(tidalReleaseDate).getFullYear();
            if (!isNaN(tidalYear)) {
                const yearDiff = Math.abs(Number(localYear) - tidalYear);
                yearScore = yearDiff >= 4 ? 0 : 1 - yearDiff * 0.15;
                yearWeight = 0.05;
            }
        }

        // Version/explicit token compatibility: bonus if both explicit or both clean, penalty if mismatch
        const pathAndNames = `${group.path} ${group.files.map((f) => f.name).join(" ")}`;
        const localLooksExplicit = /\[(?:e|explicit)\]|\bexplicit\b/i.test(pathAndNames);
        const localLooksClean = /\bclean\b/i.test(pathAndNames);
        let versionScore = 0;
        let versionWeight = 0;
        if (tidalVideo.explicit != null && (localLooksExplicit || localLooksClean)) {
            versionWeight = 0.05;
            const tidalExplicit = Boolean(tidalVideo.explicit);
            versionScore = (tidalExplicit && localLooksExplicit) || (!tidalExplicit && localLooksClean) ? 1.0 : 0.0;
        }

        const artistWeight = (localArtist && tidalArtist) ? 0.25 : 0;
        const totalWeight = 0.45 + artistWeight + durationWeight + yearWeight + versionWeight;

        const rawScore = (
            titleScore * 0.45
            + artistScore * artistWeight
            + durationScore * durationWeight
            + yearScore * yearWeight
            + versionScore * versionWeight
        ) / (totalWeight || 1);

        // Hard artist-mismatch penalty: cap at 0.35 when artist similarity is very low
        if (localArtist && tidalArtist && artistScore < 0.25) {
            return Math.min(rawScore, 0.35);
        }

        return Math.min(Math.max(rawScore, 0), 1);
    }
}

export const importMatcherService = new ImportMatcherService();