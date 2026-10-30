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

import { getBestRelease, shouldFingerprint, type LocalTrackInfo, type MbRelease } from "./lidarr-distance.js";

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
    /** Already a monitored edition in the target library (informational; Lidarr has no such tie-break). */
    preferred: boolean;
    artistName?: string;
    oldMbids?: string[];
    albumYear?: number | null;
    releaseYear?: number | null;
    mediaCount?: number;
    mediaFormats?: string[];
    countries?: string[];
    labels?: string[];
    disambiguation?: string | null;
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

export type FolderAutoImportPlan =
    | {
        decision: "import";
        libraryId: number;
        editionId: number;
        mappings: Array<{ unmappedFileId: number; trackId: number }>;
        /** "distance": chosen by ADR-2 step 2; callers verify it by fingerprint. */
        via?: "tags" | "distance";
    }
    | {
        decision: "review";
        reason: string;
        /**
         * Evidence that could still settle this folder (ADR-13 order):
         * "online" = no close catalog release, look the release up on MusicBrainz
         * and add it; "fingerprint" = two different releases are too close.
         */
        needsEvidence?: "online" | "fingerprint";
    };

/** AcoustID recording MBIDs per unmapped file id; a missing or empty entry means no evidence. */
export type FingerprintEvidence = Map<number, string[]>;



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
    /** ADR-13 step 3: AcoustID evidence for tie-breaks and verification. */
    fingerprints?: FingerprintEvidence;
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
        return planByDistance(files, library.id, input.findCandidates, input.folderArtistMbid ?? null, input.fingerprints);
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

/** Cost of matching only after dropping a qualifier that differs ("(voice memo)" vs "(guitar/vocal)"). */
export const QUALIFIER_MISMATCH_PENALTY = 0.1;

function ratio(a: string, b: string): number {
    if (!a || !b) return 1;
    return levenshtein(a, b) / Math.max(a.length, b.length);
}

/**
 * 0 = same, 1 = nothing in common. Qualifiers like "(Remastered)" may be
 * dropped on either side, but a match that needs that costs a penalty, so an
 * edition whose qualifiers agree always beats one whose qualifiers differ.
 */
export function titleDistance(left: string | null, right: string | null): number {
    if (!left || !right) return 1;
    const full = ratio(normalizeTitle(left), normalizeTitle(right));
    let stripped = 1;
    for (const a of [normalizeTitle(left), normalizeTitle(stripQualifiers(left))]) {
        for (const b of [normalizeTitle(right), normalizeTitle(stripQualifiers(right))]) {
            stripped = Math.min(stripped, ratio(a, b));
        }
    }
    return full === 0 ? 0 : Math.min(full, Math.min(1, stripped + QUALIFIER_MISMATCH_PENALTY));
}

function toLocal(file: AutoImportFile, fingerprints?: FingerprintEvidence): LocalTrackInfo {
    const t = file.tags;
    const fp = fingerprints?.get(file.id);
    return {
        id: file.id,
        title: readTag(t, "title"),
        artist: readTag(t, "albumartist", "album artist", "artist"),
        album: readTag(t, "album"),
        trackNumber: leadingInt(readTag(t, "track", "tracknumber")),
        discNumber: leadingInt(readTag(t, "disc", "discnumber", "disk")),
        discCount: leadingInt(readTag(t, "disctotal", "totaldiscs")) ?? leadingInt(readTag(t, "disc", "discnumber")?.split("/")[1] ?? null),
        year: leadingInt(readTag(t, "originalyear", "date", "year")),
        country: readTag(t, "releasecountry", "MusicBrainz Album Release Country")?.toUpperCase() ?? null,
        label: readTag(t, "label", "organization", "publisher"),
        disambiguation: readTag(t, "musicbrainz_albumcomment", "MusicBrainz Album Comment"),
        releaseMbid: releaseMbidOf(file),
        recordingMbid: readTag(t, "musicbrainz_trackid", "MusicBrainz Track Id")?.toLowerCase() ?? null,
        durationSeconds: file.durationSeconds,
        // Lidarr sets AcoustIdResults only when the lookup returned recordings.
        acoustIdResults: fp && fp.length > 0 ? fp.map((id) => id.toLowerCase()) : undefined,
    };
}

function toMbRelease(c: AutoImportCandidateRelease): MbRelease {
    return {
        id: c.id, mbid: c.mbid.toLowerCase(), oldMbids: c.oldMbids, artistMbid: c.artistMbid.toLowerCase(),
        artistName: c.artistName ?? "", albumTitle: c.releaseGroupTitle,
        albumYear: c.albumYear ?? null, releaseYear: c.releaseYear ?? null,
        mediaCount: c.mediaCount ?? new Set(c.tracks.map((t) => t.mediumPosition)).size,
        mediaFormats: c.mediaFormats ?? [], countries: c.countries ?? [], labels: c.labels ?? [],
        disambiguation: c.disambiguation ?? null,
        tracks: c.tracks.map((t) => ({ id: t.id, title: t.title, position: t.position, mediumPosition: t.mediumPosition,
            durationMs: t.durationMs, recordingMbid: t.recordingMbid?.toLowerCase() ?? null })),
    };
}

/**
 * ADR-13 / Lidarr IdentificationService + CloseAlbumMatch/CloseTrackMatch
 * (existing-files branch): lowest distance wins, first candidate on a tie;
 * candidates ordered by track-count difference (CandidateService).
 */
function planByDistance(
    files: AutoImportFile[],
    libraryId: number,
    findCandidates: (query: CandidateQuery) => AutoImportCandidateRelease[],
    folderArtistMbid: string | null,
    fingerprints?: FingerprintEvidence,
): FolderAutoImportPlan {
    const album = mostCommon(files.map((file) => readTag(file.tags, "album")));
    const artistName = mostCommon(files.map((file) => readTag(file.tags, "albumartist", "album artist", "artist")));
    const artistMbid = (mostCommon(files.map((file) => readTag(file.tags, "musicbrainz_albumartistid", "MusicBrainz Album Artist Id")))
        ?? folderArtistMbid)?.toLowerCase() ?? null;
    if (!album) return { decision: "review", reason: "Files have no MusicBrainz release id and no album tag" };
    const candidates = findCandidates({ libraryId, artistMbid, artistName, album })
        .map((c, index) => ({ c, index }))
        .sort((x, y) => Math.abs(x.c.tracks.length - files.length) - Math.abs(y.c.tracks.length - files.length) || x.index - y.index)
        .map(({ c }) => c);
    if (candidates.length === 0) {
        return { decision: "review", needsEvidence: "online", reason: `No catalog release matches album "${album}"${artistName ? ` by ${artistName}` : ""}` };
    }
    const locals = files.map((file) => toLocal(file, fingerprints));
    const best = getBestRelease(locals, candidates.map(toMbRelease));
    if (!best) return { decision: "review", needsEvidence: "online", reason: "No candidate release is closer than distance 1" };
    if (fingerprints === undefined && shouldFingerprint(best)) {
        return { decision: "review", needsEvidence: "fingerprint", reason: `Match not good enough, fingerprinting (${best.release.mbid} distance ${best.distance.normalized().toFixed(3)})` };
    }
    const albumDistance = best.distance.normalizedExcluding(["missing_tracks", "unmatched_tracks"]);
    if (albumDistance > ALBUM_DISTANCE_THRESHOLD) {
        return { decision: "review", needsEvidence: "online",
            reason: `Album match is not close enough: ${best.release.mbid} distance ${albumDistance.toFixed(3)} > ${ALBUM_DISTANCE_THRESHOLD} [${best.distance.reasons().join(", ")}]` };
    }
    // CloseTrackMatch rejects single tracks; they stay in Unmapped.
    const mappings = best.mapping.mapping
        .filter((m) => m.distance.normalized() <= TRACK_DISTANCE_THRESHOLD)
        .map((m) => ({ unmappedFileId: m.local.id, trackId: m.track.id }));
    if (mappings.length === 0) return { decision: "review", reason: `No track of ${best.release.mbid} is close enough` };
    return { decision: "import", libraryId, editionId: best.release.id, mappings, via: "distance" };
}

function mostCommon(values: Array<string | null>): string | null {
    const counts = new Map<string, number>();
    for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    let best: string | null = null;
    for (const [value, count] of counts) if (best === null || count > counts.get(best)!) best = value;
    return best;
}

/**
 * Release status for untagged matching (Lidarr: the metadata profile's allowed
 * statuses). A bootleg additionally needs a streaming provider that offers the
 * release. Files tagged with a release MBID bypass this check.
 */
export function isAutoImportStatusAllowed(status: string | null | undefined, includedByFilter: boolean, providerOffers: boolean): boolean {
    if (!includedByFilter) return false;
    return (status ?? "").trim().toLowerCase() === "bootleg" ? providerOffers : true;
}
