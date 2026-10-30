/**
 * Port of Lidarr's track-import identification maths:
 * NzbDrone.Core/MediaFiles/TrackImport/Identification/{Distance,DistanceCalculator,Munkres}.cs
 * and IdentificationService.MapReleaseTracks / GetBestRelease / ShouldFingerprint.
 * Keep it line-for-line comparable with Lidarr; differences are listed in
 * docs/PRODUCT_VISION.md ADR-13.
 */

/** Distance.Weights (beets defaults). */
export const WEIGHTS: Record<string, number> = {
    source: 2.0, artist: 3.0, album: 3.0, media_count: 1.0, media_format: 1.0, year: 1.0,
    country: 0.5, label: 0.5, catalog_number: 0.5, album_disambiguation: 0.5, album_id: 5.0,
    tracks: 2.0, missing_tracks: 0.6, unmatched_tracks: 0.9,
    track_title: 3.0, track_artist: 2.0, track_index: 1.0, track_length: 2.0, recording_id: 10.0,
};

/** DistanceCalculator.PreferredCountries as MusicBrainz ISO codes: United States, United Kingdom, Europe, [Worldwide]. */
export const PREFERRED_COUNTRIES = ["US", "GB", "XE", "XW"];
const VARIOUS_ARTIST_IDS = ["89ad4ac3-39f7-470e-963a-56509c546377"];
const VARIOUS_ARTIST_NAMES = ["various artists", "various", "va", "unknown"];

export class Distance {
    readonly penalties = new Map<string, number[]>();
    add(key: string, dist: number): void {
        const list = this.penalties.get(key);
        if (list) list.push(dist); else this.penalties.set(key, [dist]);
    }
    addRatio(key: string, value: number, target: number): void {
        this.add(key, target > 0 ? Math.max(Math.min(value, target), 0) / target : 0);
    }
    addNumber(key: string, value: number, target: number): void {
        const diff = Math.abs(value - target);
        if (diff > 0) for (let i = 0; i < diff; i++) this.add(key, 1); else this.add(key, 0);
    }
    addString(key: string, value: string | null | undefined, target: string | null | undefined): void {
        const v = clean(value ?? ""), t = clean(target ?? "");
        if (!v && t) this.add(key, 1);
        else if (!v && !t) this.add(key, 0);
        else this.add(key, 1 - levenshteinCoefficient(v, t));
    }
    addBool(key: string, expr: boolean): void { this.add(key, expr ? 1 : 0); }
    addEquality(key: string, value: string, options: string[]): void { this.add(key, options.includes(value) ? 0 : 1); }
    addPriority(key: string, values: string[], options: string[]): void {
        for (let i = 0; i < options.length; i++) {
            if (values.includes(options[i])) { this.add(key, i / options.length); return; }
        }
        this.add(key, 1);
    }
    maxDistance(): number { let s = 0; for (const [k, v] of this.penalties) s += v.length * WEIGHTS[k]; return s; }
    rawDistance(): number { let s = 0; for (const [k, v] of this.penalties) s += v.reduce((a, b) => a + b, 0) * WEIGHTS[k]; return s; }
    normalized(): number { const max = this.maxDistance(); return max > 0 ? this.rawDistance() / max : 0; }
    /** Distance.NormalizedDistanceExcluding. */
    normalizedExcluding(keys: string[]): number {
        let raw = 0, max = 0;
        for (const [k, v] of this.penalties) {
            if (keys.includes(k)) continue;
            raw += v.reduce((a, b) => a + b, 0) * WEIGHTS[k]; max += v.length * WEIGHTS[k];
        }
        return max > 0 ? raw / max : 0;
    }
    reasons(): string[] { return [...this.penalties].filter(([, v]) => Math.max(...v) > 0).map(([k]) => k.replace(/_/g, " ")); }
}

/** Distance.Clean: lower case, accents removed, letters and digits only. */
export function clean(input: string): string {
    return input.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]/gu, "");
}

function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
    }
    return prev[b.length];
}

export function levenshteinCoefficient(a: string, b: string): number {
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

export interface LocalTrackInfo {
    id: number;
    title: string | null;
    artist: string | null;
    album: string | null;
    trackNumber: number | null;
    discNumber: number | null;
    discCount: number | null;
    year: number | null;
    country: string | null;
    label: string | null;
    disambiguation: string | null;
    releaseMbid: string | null;
    recordingMbid: string | null;
    durationSeconds: number | null;
    /** AcoustID recording ids; undefined when not fingerprinted. */
    acoustIdResults?: string[];
}

export interface MbTrack {
    id: number;
    title: string;
    position: number;
    mediumPosition: number;
    durationMs: number | null;
    recordingMbid: string | null;
    oldRecordingMbids?: string[];
}

export interface MbRelease {
    id: number;
    mbid: string;
    oldMbids?: string[];
    artistMbid: string;
    artistName: string;
    albumTitle: string;
    albumYear: number | null;
    releaseYear: number | null;
    mediaCount: number;
    mediaFormats: string[];
    countries: string[];
    labels: string[];
    disambiguation: string | null;
    tracks: MbTrack[];
}

/** DistanceCalculator.GetTotalTrackNumber. */
export function totalTrackNumber(track: MbTrack, all: MbTrack[]): number {
    return track.position + all.filter((t) => t.mediumPosition < track.mediumPosition).length;
}

/** DistanceCalculator.TrackDistance (includeArtist = false, as in MapReleaseTracks). */
export function trackDistance(local: LocalTrackInfo, mb: MbTrack, total: number): Distance {
    const dist = new Distance();
    const mbLength = (mb.durationMs ?? 0) / 1000;
    if (mbLength > 0) dist.addRatio("track_length", Math.abs((local.durationSeconds ?? 0) - mbLength) - 10, 30);
    dist.addString("track_title", cleanTrackTitle(local.title ?? ""), mb.title);
    if ((local.trackNumber ?? 0) > 0 && mb.position > 0) {
        dist.addBool("track_index", local.trackNumber !== mb.position && local.trackNumber !== total);
    }
    if (local.recordingMbid) {
        dist.addBool("recording_id", local.recordingMbid !== mb.recordingMbid && !(mb.oldRecordingMbids ?? []).includes(local.recordingMbid));
    }
    if (local.acoustIdResults) dist.addBool("recording_id", !local.acoustIdResults.includes(mb.recordingMbid ?? ""));
    return dist;
}

export interface TrackMapping {
    mapping: Array<{ local: LocalTrackInfo; track: MbTrack; distance: Distance }>;
    localExtra: LocalTrackInfo[];
    mbExtra: MbTrack[];
}

/** IdentificationService.MapReleaseTracks: minimum-cost assignment (Munkres). */
export function mapReleaseTracks(locals: LocalTrackInfo[], tracks: MbTrack[]): TrackMapping {
    const distances = locals.map((local) => tracks.map((track) => trackDistance(local, track, totalTrackNumber(track, tracks))));
    const pairs = munkres(distances.map((row) => row.map((d) => d.normalized())));
    const mapping = pairs.map(([r, c]) => ({ local: locals[r], track: tracks[c], distance: distances[r][c] }));
    const usedLocal = new Set(pairs.map(([r]) => r)), usedTrack = new Set(pairs.map(([, c]) => c));
    return { mapping, localExtra: locals.filter((_, i) => !usedLocal.has(i)), mbExtra: tracks.filter((_, i) => !usedTrack.has(i)) };
}

/** Rectangular Hungarian algorithm; returns min(rows, cols) (row, col) pairs. */
export function munkres(cost: number[][]): Array<[number, number]> {
    const rows = cost.length, cols = rows ? cost[0].length : 0;
    if (!rows || !cols) return [];
    const transpose = rows > cols;
    const a = transpose ? cost[0].map((_, c) => cost.map((row) => row[c])) : cost;
    const n = a.length, m = a[0].length;
    const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
    for (let i = 1; i <= n; i++) {
        p[0] = i;
        let j0 = 0;
        const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
        do {
            used[j0] = true;
            const i0 = p[j0];
            let delta = Infinity, j1 = 0;
            for (let j = 1; j <= m; j++) {
                if (used[j]) continue;
                const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
                if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
                if (minv[j] < delta) { delta = minv[j]; j1 = j; }
            }
            for (let j = 0; j <= m; j++) {
                if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
            }
            j0 = j1;
        } while (p[j0] !== 0);
        do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
    }
    const out: Array<[number, number]> = [];
    for (let j = 1; j <= m; j++) if (p[j]) out.push(transpose ? [j - 1, p[j] - 1] : [p[j] - 1, j - 1]);
    return out.sort((x, y) => x[0] - y[0]);
}

function mostCommon<T>(values: T[]): T | null {
    const counts = new Map<T, number>();
    let best: T | null = null, bestCount = 0;
    for (const value of values) {
        const c = (counts.get(value) ?? 0) + 1;
        counts.set(value, c);
        if (c > bestCount) { best = value; bestCount = c; }
    }
    return best;
}

/** DistanceCalculator.AlbumReleaseDistance. */
export function albumReleaseDistance(locals: LocalTrackInfo[], release: MbRelease, mapping: TrackMapping, now = new Date()): Distance {
    const dist = new Distance();
    if (!VARIOUS_ARTIST_IDS.includes(release.artistMbid)) {
        dist.addString("artist", mostCommon(locals.map((l) => l.artist)) ?? "", release.artistName);
    }
    dist.addString("album", mostCommon(locals.map((l) => l.album)) ?? "", release.albumTitle);
    let discCount = mostCommon(locals.map((l) => l.discCount ?? 0)) ?? 0;
    if (discCount === 0) discCount = Math.max(0, ...locals.map((l) => l.discNumber ?? 0));
    if (discCount > 0) dist.addNumber("media_count", discCount, release.mediaCount);
    if (release.mediaFormats.includes("Unknown")) dist.add("media_format", 1);
    const localYear = mostCommon(locals.map((l) => l.year ?? 0)) ?? 0;
    if (localYear > 0 && (release.albumYear || release.releaseYear)) {
        const albumYear = release.albumYear ?? 0, releaseYear = release.releaseYear ?? 0;
        if (localYear === albumYear || localYear === releaseYear) dist.add("year", 0);
        else {
            const remoteYear = albumYear > 0 ? albumYear : releaseYear;
            dist.addRatio("year", Math.abs(localYear - remoteYear), Math.abs(now.getFullYear() - remoteYear));
        }
    }
    const country = mostCommon(locals.map((l) => l.country));
    if (release.countries.length > 0) {
        if (country) dist.addEquality("country", country, release.countries);
        else dist.addPriority("country", release.countries, PREFERRED_COUNTRIES);
    } else dist.add("country", 1);
    const label = mostCommon(locals.map((l) => l.label));
    if (label) dist.addEquality("label", label, release.labels);
    const disambig = mostCommon(locals.map((l) => l.disambiguation));
    if (disambig) dist.addString("album_disambiguation", disambig, release.disambiguation);
    const albumId = mostCommon(locals.map((l) => l.releaseMbid));
    if (albumId) dist.addBool("album_id", albumId !== release.mbid && !(release.oldMbids ?? []).includes(albumId));
    for (const pair of mapping.mapping) dist.add("tracks", pair.distance.normalized());
    for (const _ of mapping.mbExtra.slice(0, locals.length)) dist.add("missing_tracks", 1);
    for (const _ of mapping.localExtra.slice(0, locals.length)) dist.add("unmatched_tracks", 1);
    return dist;
}

export interface BestRelease { release: MbRelease; distance: Distance; mapping: TrackMapping }

/** IdentificationService.GetBestRelease: strictly lowest distance, first candidate on a tie. */
export function getBestRelease(locals: LocalTrackInfo[], candidates: MbRelease[]): BestRelease | null {
    let best: BestRelease | null = null;
    let bestDistance = 1.0;
    for (const release of candidates) {
        const mapping = mapReleaseTracks(locals, release.tracks);
        const distance = albumReleaseDistance(locals, release, mapping);
        const current = distance.normalized();
        if (current < bestDistance) {
            bestDistance = current;
            best = { release, distance, mapping };
            if (current === 0) break;
        }
    }
    return best;
}

/** IdentificationService.ShouldFingerprint. */
export function shouldFingerprint(best: BestRelease): boolean {
    const worst = best.mapping.mapping.length ? Math.max(...best.mapping.mapping.map((m) => m.distance.normalized())) : 1;
    return best.distance.normalized() > 0.15 || best.mapping.localExtra.length > 0 || best.mapping.mbExtra.length > 0 || worst > 0.40;
}

/** Lidarr Parser.CommonTagRegex: MusicBrainz never has "feat." or edition text in a track title. */
const COMMON_TAG_REGEX = [
  /(\[|\()*\b((featuring|feat.|feat|ft|ft.|produced by)\s{1}){1}\s*.*(\]|\))*/gi,
  /(?:\(|\[)(?:[^\(\[]*)(?:version|limited|deluxe|single|clean|album|special|bonus|promo|remaster(ed)?)(?:[^\)\]]*)(?:\)|\])/gi,
];

/** Lidarr Parser.CleanTrackTitle (ParsedTrackInfo.CleanTitle). */
export function cleanTrackTitle(title: string): string {
  let out = title;
  for (const regex of COMMON_TAG_REGEX) out = out.replace(regex, "").trim();
  return out;
}
