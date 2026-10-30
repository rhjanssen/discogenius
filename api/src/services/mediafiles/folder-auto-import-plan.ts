/**
 * Decides whether one folder of unmapped files can be imported without a
 * person, and onto which canonical tracks. Pure: callers read tags and the
 * catalog, this function only decides (Lidarr: ImportDecisionMaker with
 * CloseTrackMatch / NoMissingOrUnmatchedTracks; PRODUCT_VISION ADR-2).
 *
 * Authority rules:
 * - One library: the enabled library whose root holds every file.
 * - One release: every file carries the same MusicBrainz release id, and that
 *   release exists in the local catalog.
 * - Every file maps to exactly one distinct track of that release, by track
 *   MBID, then recording MBID (unique in the release), then disc+track number
 *   with a matching title. A known duration must be within 10 s.
 * Anything else is "review" with a reason; nothing is imported partially.
 */

export interface AutoImportFile {
    id: number;
    libraryRoot: string;
    ignored: boolean;
    durationSeconds: number | null;
    tags: Record<string, string>;
}

export interface AutoImportLibrary {
    id: number;
    rootPath: string;
}

export interface AutoImportReleaseTrack {
    id: number;
    mbid: string | null;
    recordingMbid: string | null;
    mediumPosition: number;
    position: number;
    title: string;
    durationMs: number | null;
}

export interface AutoImportRelease {
    id: number;
    mbid: string;
    tracks: AutoImportReleaseTrack[];
}

/** A catalog release considered for an untagged folder (ADR-2 step 2). */
export interface AutoImportCandidateRelease extends AutoImportRelease {
    title: string;
    releaseGroupTitle: string;
    artistMbid: string;
    /** Already a monitored edition in the target library: wins ties. */
    preferred: boolean;
}

export interface CandidateQuery {
    libraryId: number;
    artistMbid: string | null;
    artistName: string | null;
    album: string | null;
}

/** Lidarr CloseAlbumMatchSpecification / CloseTrackMatchSpecification. */
export const ALBUM_DISTANCE_THRESHOLD = 0.20;
export const TRACK_DISTANCE_THRESHOLD = 0.40;
/** Picard find_best_match_with_margin: the winner must be clearly better. */
export const DISTANCE_MARGIN = 0.05;

export type FolderAutoImportPlan =
    | {
        decision: "import";
        libraryId: number;
        editionId: number;
        mappings: Array<{ unmappedFileId: number; trackId: number }>;
    }
    | { decision: "review"; reason: string };

export const DURATION_TOLERANCE_SECONDS = 10;

function normalizeKey(key: string): string {
    return key.toLowerCase().replace(/^(txxx:|----:com\.apple\.itunes:)/, "").replace(/[\s_]/g, "");
}

export function readTag(tags: Record<string, string>, ...names: string[]): string | null {
    const wanted = new Set(names.map(normalizeKey));
    for (const [key, value] of Object.entries(tags)) {
        if (wanted.has(normalizeKey(key))) {
            const trimmed = String(value).split(/[;\0]/)[0]?.trim();
            if (trimmed) return trimmed;
        }
    }
    return null;
}

function leadingInt(value: string | null): number | null {
    if (!value) return null;
    const match = /^\s*(\d+)/.exec(value);
    return match ? Number(match[1]) : null;
}

function normalizeTitle(value: string): string {
    return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function releaseMbidOf(file: AutoImportFile): string | null {
    return readTag(file.tags, "musicbrainz_albumid", "MusicBrainz Album Id")?.toLowerCase() ?? null;
}

export function planFolderAutoImport(input: {
    files: AutoImportFile[];
    libraries: AutoImportLibrary[];
    findRelease: (releaseMbid: string) => AutoImportRelease | null;
    /** Catalog candidates for files without a release id. Omitted: tags only. */
    findCandidates?: (query: CandidateQuery) => AutoImportCandidateRelease[];
    /** Artist MBID from the folder name ("{mbid-…}") when tags lack one. */
    folderArtistMbid?: string | null;
}): FolderAutoImportPlan {
    const { files } = input;
    if (files.length === 0) return { decision: "review", reason: "No files in this folder" };
    if (files.some((file) => file.ignored)) {
        return { decision: "review", reason: "A file in this folder is ignored" };
    }

    const roots = new Set(files.map((file) => normalizePath(file.libraryRoot)));
    if (roots.size !== 1) return { decision: "review", reason: "Files are in more than one library root" };
    const [root] = [...roots];
    const library = input.libraries.find((candidate) => normalizePath(candidate.rootPath) === root);
    if (!library) return { decision: "review", reason: `No enabled library uses root ${root}` };

    const releaseMbids = new Set(files.map(releaseMbidOf));
    if (releaseMbids.size === 1 && releaseMbids.has(null) && input.findCandidates) {
        return planByDistance(files, library.id, input.findCandidates, input.folderArtistMbid ?? null);
    }
    if (releaseMbids.has(null)) {
        return { decision: "review", reason: releaseMbids.size === 1
            ? "A file has no MusicBrainz release id tag"
            : "Some files have a MusicBrainz release id tag and some do not" };
    }
    if (releaseMbids.size !== 1) {
        return { decision: "review", reason: "Files carry different MusicBrainz release ids" };
    }
    const [releaseMbid] = [...releaseMbids] as string[];
    const release = input.findRelease(releaseMbid);
    if (!release) {
        return {
            decision: "review",
            reason: `MusicBrainz release ${releaseMbid} is not in the catalog; add or refresh the artist first`,
        };
    }

    const byTrackMbid = new Map<string, AutoImportReleaseTrack>();
    const byRecording = new Map<string, AutoImportReleaseTrack[]>();
    const byPosition = new Map<string, AutoImportReleaseTrack>();
    for (const track of release.tracks) {
        if (track.mbid) byTrackMbid.set(track.mbid.toLowerCase(), track);
        if (track.recordingMbid) {
            const key = track.recordingMbid.toLowerCase();
            byRecording.set(key, [...(byRecording.get(key) ?? []), track]);
        }
        byPosition.set(`${track.mediumPosition}:${track.position}`, track);
    }

    const mappings: Array<{ unmappedFileId: number; trackId: number }> = [];
    const usedTracks = new Set<number>();
    for (const file of files) {
        let track: AutoImportReleaseTrack | undefined;
        const trackMbid = readTag(file.tags, "musicbrainz_releasetrackid", "MusicBrainz Release Track Id")?.toLowerCase();
        if (trackMbid) track = byTrackMbid.get(trackMbid);
        if (!track) {
            const recordingMbid = readTag(file.tags, "musicbrainz_trackid", "MusicBrainz Track Id")?.toLowerCase();
            const candidates = recordingMbid ? byRecording.get(recordingMbid) ?? [] : [];
            if (candidates.length === 1) track = candidates[0];
        }
        if (!track) {
            const disc = leadingInt(readTag(file.tags, "disc", "discnumber", "disk")) ?? 1;
            const number = leadingInt(readTag(file.tags, "track", "tracknumber"));
            const title = readTag(file.tags, "title");
            const candidate = number !== null ? byPosition.get(`${disc}:${number}`) : undefined;
            if (candidate && title && normalizeTitle(candidate.title) === normalizeTitle(title)) {
                track = candidate;
            }
        }
        if (!track) {
            return { decision: "review", reason: `File ${file.id} matches no track of release ${releaseMbid}` };
        }
        if (
            file.durationSeconds !== null
            && track.durationMs !== null
            && Math.abs(file.durationSeconds - track.durationMs / 1000) > DURATION_TOLERANCE_SECONDS
        ) {
            return {
                decision: "review",
                reason: `File ${file.id} length differs more than ${DURATION_TOLERANCE_SECONDS}s from "${track.title}"`,
            };
        }
        if (usedTracks.has(track.id)) {
            return { decision: "review", reason: `Two files map to "${track.title}"` };
        }
        usedTracks.add(track.id);
        mappings.push({ unmappedFileId: file.id, trackId: track.id });
    }

    return { decision: "import", libraryId: library.id, editionId: release.id, mappings };
}

// ---------------------------------------------------------------------------
// ADR-2 step 2: own catalog by artist/album/title tags, then distance + margin.

function stripQualifiers(value: string): string {
    return value.replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

/** 0 = same, 1 = nothing in common. Qualifiers like "(Remastered)" may be dropped on either side. */
export function titleDistance(left: string | null, right: string | null): number {
    if (!left || !right) return 1;
    let best = 1;
    for (const a of [normalizeTitle(left), normalizeTitle(stripQualifiers(left))]) {
        for (const b of [normalizeTitle(right), normalizeTitle(stripQualifiers(right))]) {
            if (!a || !b) continue;
            best = Math.min(best, levenshtein(a, b) / Math.max(a.length, b.length));
        }
    }
    return best;
}

function durationDistance(fileSeconds: number | null, trackMs: number | null): number {
    if (fileSeconds === null || trackMs === null) return 0.5;
    const delta = Math.abs(fileSeconds - trackMs / 1000);
    if (delta <= 3) return 0;
    if (delta > DURATION_TOLERANCE_SECONDS) return 1;
    return (delta - 3) / (DURATION_TOLERANCE_SECONDS - 3);
}

export function trackDistance(file: AutoImportFile, track: AutoImportReleaseTrack): number {
    return 0.6 * titleDistance(readTag(file.tags, "title"), track.title) + 0.4 * durationDistance(file.durationSeconds, track.durationMs);
}

interface ScoredCandidate {
    release: AutoImportCandidateRelease;
    distance: number;
    worstTrack: number;
    mappings: Array<{ unmappedFileId: number; trackId: number }>;
    unmatchedFiles: number;
}

/** Map files to tracks (position first, then best title) and score the release. */
export function scoreCandidate(files: AutoImportFile[], release: AutoImportCandidateRelease, album: string | null, artistMbid: string | null): ScoredCandidate {
    const byPosition = new Map(release.tracks.map((track) => [`${track.mediumPosition}:${track.position}`, track]));
    const used = new Set<number>();
    const mappings: ScoredCandidate["mappings"] = [];
    let trackSum = 0;
    let worstTrack = 0;
    let unmatchedFiles = 0;
    for (const file of files) {
        const disc = leadingInt(readTag(file.tags, "disc", "discnumber", "disk")) ?? 1;
        const number = leadingInt(readTag(file.tags, "track", "tracknumber"));
        let track = number !== null ? byPosition.get(`${disc}:${number}`) : undefined;
        let distance = track && !used.has(track.id) ? trackDistance(file, track) : 1;
        if (!track || used.has(track.id) || distance > TRACK_DISTANCE_THRESHOLD) {
            track = undefined;
            distance = 1;
            for (const candidate of release.tracks) {
                if (used.has(candidate.id)) continue;
                const d = trackDistance(file, candidate);
                if (d < distance) { distance = d; track = candidate; }
            }
        }
        if (!track || distance > TRACK_DISTANCE_THRESHOLD) { unmatchedFiles++; trackSum += 1; worstTrack = 1; continue; }
        used.add(track.id);
        mappings.push({ unmappedFileId: file.id, trackId: track.id });
        trackSum += distance;
        worstTrack = Math.max(worstTrack, distance);
    }
    const missingTracks = release.tracks.length - used.size;
    const albumTitle = Math.min(titleDistance(album, release.title), titleDistance(album, release.releaseGroupTitle));
    const artist = artistMbid ? (artistMbid === release.artistMbid.toLowerCase() ? 0 : 1) : 0.5;
    // Weights after Lidarr DistanceCalculator: album and artist count 3 each,
    // every track 1, every missing track 0.9 (an incomplete copy of a matching release).
    const weighted = 3 * albumTitle + 3 * artist + trackSum + 0.9 * missingTracks;
    const total = 3 + 3 + files.length + 0.9 * missingTracks;
    return { release, distance: weighted / total, worstTrack, mappings, unmatchedFiles };
}

function trackListKey(release: AutoImportRelease): string {
    return release.tracks.map((track) => track.recordingMbid ?? normalizeTitle(track.title)).join("|");
}

function planByDistance(
    files: AutoImportFile[],
    libraryId: number,
    findCandidates: (query: CandidateQuery) => AutoImportCandidateRelease[],
    folderArtistMbid: string | null,
): FolderAutoImportPlan {
    const album = mostCommon(files.map((file) => readTag(file.tags, "album")));
    const artistName = mostCommon(files.map((file) => readTag(file.tags, "albumartist", "album artist", "artist")));
    const artistMbid = (mostCommon(files.map((file) => readTag(file.tags, "musicbrainz_albumartistid", "MusicBrainz Album Artist Id")))
        ?? folderArtistMbid)?.toLowerCase() ?? null;
    if (!album) return { decision: "review", reason: "Files have no MusicBrainz release id and no album tag" };
    const candidates = findCandidates({ libraryId, artistMbid, artistName, album });
    if (candidates.length === 0) {
        return { decision: "review", reason: `No catalog release matches album "${album}"${artistName ? ` by ${artistName}` : ""}; refresh the artist first` };
    }
    const scored = candidates
        .map((release) => scoreCandidate(files, release, album, artistMbid))
        .sort((a, b) => a.distance - b.distance || Number(b.release.preferred) - Number(a.release.preferred) || a.release.id - b.release.id);
    const best = scored[0];
    const describe = (c: ScoredCandidate) => `${c.release.title} (${c.release.mbid}) distance ${c.distance.toFixed(3)}`;
    if (best.unmatchedFiles > 0) return { decision: "review", reason: `Best candidate ${describe(best)} leaves ${best.unmatchedFiles} file(s) unmatched` };
    if (best.distance > ALBUM_DISTANCE_THRESHOLD) return { decision: "review", reason: `Best candidate ${describe(best)} is above ${ALBUM_DISTANCE_THRESHOLD}` };
    // Releases with the same track list are the same content: not a real
    // ambiguity. Prefer the edition already monitored, then the closest.
    const sameContent = scored.filter((c) => trackListKey(c.release) === trackListKey(best.release) && c.distance - best.distance < DISTANCE_MARGIN && c.unmatchedFiles === 0);
    const rival = scored.find((c) => trackListKey(c.release) !== trackListKey(best.release));
    if (rival && rival.distance - best.distance < DISTANCE_MARGIN) {
        return { decision: "review", reason: `Too close: ${describe(best)} vs ${describe(rival)}` };
    }
    const chosen = sameContent.find((c) => c.release.preferred) ?? best;
    return { decision: "import", libraryId, editionId: chosen.release.id, mappings: chosen.mappings };
}

function mostCommon(values: Array<string | null>): string | null {
    const counts = new Map<string, number>();
    for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    let best: string | null = null;
    for (const [value, count] of counts) if (best === null || count > counts.get(best)!) best = value;
    return best;
}
