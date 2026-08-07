import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { resolveAcoustIdClientId } from '../config/provider-client-config.js';
import { Config } from '../config/config.js';
import { getDiscogeniusUserAgent } from '../config/user-agent.js';

export interface MusicBrainzRecording {
    id: string;
    title: string;
    artists: string[];
    artistCredits?: MusicBrainzArtistCredit[];
    isrcs: string[];
    releaseTitles: string[];
    firstReleaseDate: string | null;
    durationSeconds: number | null;
}

export interface MusicBrainzArtistCredit {
    id: string;
    name: string;
}

export interface MusicBrainzRelease {
    id: string;
    title: string;
    barcode: string | null;
    date: string | null;
    country: string | null;
    status: string | null;
    releaseGroupId: string | null;
    releaseGroupPrimaryType: string | null;
    releaseGroupSecondaryTypes: string[];
    artistCredits: MusicBrainzArtistCredit[];
}

export interface AcoustIdLookupResult {
    id: string;
    score: number | null;
    recordingIds: string[];
}

export interface AcoustIdBatchInput {
    fingerprint: string;
    duration: number;
}

export type AcoustIdLookupStatus =
    | "matched"
    | "no_match"
    | "missing_client"
    | "invalid_input"
    | "service_error";

export interface AcoustIdLookupOutcome {
    status: AcoustIdLookupStatus;
    matches: AcoustIdLookupResult[];
    cached: boolean;
    error?: string;
}

type AcoustIdPost = (
    url: string,
    data: Buffer,
    config: Record<string, unknown>,
) => Promise<{ status?: number; data?: any }>;

export interface AcoustIdLookupOptions {
    /** Explicit null/blank exercises the missing-client boundary. */
    clientId?: string | null;
    post?: AcoustIdPost;
    bypassCache?: boolean;
}

const MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS = 1100;
let musicBrainzRequestChain: Promise<void> = Promise.resolve();
let lastMusicBrainzRequestAt = 0;
const ACOUSTID_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ACOUSTID_CACHE_MAX_ENTRIES = 256;
const acoustIdLookupCache = new Map<string, {
    expiresAt: number;
    outcome: Omit<AcoustIdLookupOutcome, "cached">;
}>();

export function getMusicBrainzHeaders() {
    return {
        "User-Agent": getDiscogeniusUserAgent("metadata identity"),
    };
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function scheduleMusicBrainzRequest<T>(request: () => Promise<T>): Promise<T> {
    const run = musicBrainzRequestChain.then(async () => {
        const elapsed = Date.now() - lastMusicBrainzRequestAt;
        if (elapsed < MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS) {
            await delay(MUSICBRAINZ_MIN_REQUEST_INTERVAL_MS - elapsed);
        }

        lastMusicBrainzRequestAt = Date.now();
        return request();
    });

    musicBrainzRequestChain = run.then(() => undefined, () => undefined);
    return run;
}

export async function requestMusicBrainzJson<T = any>(url: string): Promise<T> {
    return scheduleMusicBrainzRequest(async () => {
        const response = await axios.get(url, {
            timeout: 10000,
            headers: getMusicBrainzHeaders(),
        });
        return response.data as T;
    });
}

function mapMusicBrainzArtistCredits(rawCredits: unknown): MusicBrainzArtistCredit[] {
    if (!Array.isArray(rawCredits)) {
        return [];
    }

    return rawCredits
        .map((credit: any) => {
            const id = String(credit?.artist?.id || "").trim();
            const name = String(credit?.name || credit?.artist?.name || "").trim();
            if (!id || !name) {
                return null;
            }

            return { id, name };
        })
        .filter(Boolean) as MusicBrainzArtistCredit[];
}

function getReleaseGroupPrimaryType(release: any): string | null {
    return String(release?.["release-group"]?.["primary-type"] || "")
        .trim()
        .toLowerCase() || null;
}

function getReleaseGroupSecondaryTypes(release: any): string[] {
    const rawSecondaryTypes = release?.["release-group"]?.["secondary-types"];
    if (!Array.isArray(rawSecondaryTypes)) {
        return [];
    }

    return rawSecondaryTypes
        .map((type) => String(type || "").trim().toLowerCase())
        .filter(Boolean);
}

function findWingetFpcalcPath(): string {
    if (process.platform !== 'win32') {
        return '';
    }

    const packagesDir = path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    if (!fs.existsSync(packagesDir)) {
        return '';
    }

    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('AcoustID.Chromaprint')) {
            continue;
        }

        const packageRoot = path.join(packagesDir, entry.name);
        const nestedDirs = fs.readdirSync(packageRoot, { withFileTypes: true })
            .filter((child) => child.isDirectory())
            .map((child) => path.join(packageRoot, child.name));

        for (const candidateDir of [packageRoot, ...nestedDirs]) {
            const candidateBinary = path.join(candidateDir, 'fpcalc.exe');
            if (fs.existsSync(candidateBinary)) {
                return candidateBinary;
            }
        }
    }

    return '';
}

function resolveFpcalcBinary(): string {
    const override = process.env.FPCALC_PATH;
    const defaultBinary = process.platform === 'win32' ? 'fpcalc.exe' : 'fpcalc';

    if (!override) {
        const wingetBinary = findWingetFpcalcPath();
        if (wingetBinary) {
            return wingetBinary;
        }

        return defaultBinary;
    }

    try {
        const stat = fs.statSync(override);
        if (stat.isDirectory()) {
            return path.join(override, defaultBinary);
        }
    } catch {
        // Fall back to using the override as a direct binary path.
    }

    return override;
}

function parseFpcalcOutput(rawOutput: string): { duration: number; fingerprint: string } {
    const pairs = rawOutput
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const separatorIndex = line.indexOf('=');
            if (separatorIndex <= 0) return null;
            return [
                line.slice(0, separatorIndex).trim().toUpperCase(),
                line.slice(separatorIndex + 1).trim(),
            ] as const;
        })
        .filter(Boolean) as Array<readonly [string, string]>;

    const output = Object.fromEntries(pairs);
    const fingerprint = output.FINGERPRINT || '';
    const duration = Number.parseInt(output.DURATION || '0', 10);

    if (!fingerprint) {
        throw new Error('fpcalc did not return a fingerprint');
    }

    return {
        duration: Number.isFinite(duration) ? duration : 0,
        fingerprint,
    };
}

/**
 * Generate a Chromaprint audio fingerprint using fpcalc.
 * Rejects cleanly when fpcalc is unavailable so callers can degrade gracefully.
 */
export async function generateFingerprint(filePath: string): Promise<{ duration: number, fingerprint: string }> {
    return new Promise((resolve, reject) => {
        const fpcalcBinary = resolveFpcalcBinary();
        const child = spawn(fpcalcBinary, [filePath], {
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const rejectOnce = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        child.on('error', (error) => {
            rejectOnce(new Error(`fpcalc unavailable: ${error.message}`));
        });

        child.stdout.on('data', (chunk: Buffer | string) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk: Buffer | string) => {
            stderr += chunk.toString();
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;

            if (code !== 0) {
                reject(new Error(stderr.trim() || `fpcalc exited with code ${code}`));
                return;
            }

            try {
                resolve(parseFpcalcOutput(stdout));
            } catch (error: any) {
                reject(new Error(error?.message || 'Failed to parse fpcalc output'));
            }
        });
    });
}

function mapAcoustIdResults(results: any[]): AcoustIdLookupResult[] {
    return results
        .map((result: any) => {
            const id = String(result?.id || "").trim();
            const recordingIds = new Set<string>();
            if (Array.isArray(result?.recordings)) {
                for (const recording of result.recordings) {
                    const recordingId = String(recording?.id || "").trim();
                    if (recordingId) recordingIds.add(recordingId);
                }
            }

            return {
                id,
                score: typeof result?.score === "number" && Number.isFinite(result.score) ? result.score : null,
                recordingIds: Array.from(recordingIds),
            } satisfies AcoustIdLookupResult;
        })
        .filter((result: AcoustIdLookupResult) => result.id || result.recordingIds.length > 0);
}

function acoustIdCacheKey(fingerprint: string, duration: number, clientId: string): string {
    return createHash("sha256")
        .update(`${clientId}\0${Math.round(duration)}\0${fingerprint}`)
        .digest("hex");
}

function cacheAcoustIdOutcome(
    key: string,
    outcome: Omit<AcoustIdLookupOutcome, "cached">,
): void {
    if (acoustIdLookupCache.size >= ACOUSTID_CACHE_MAX_ENTRIES) {
        const oldest = acoustIdLookupCache.keys().next().value;
        if (oldest) acoustIdLookupCache.delete(oldest);
    }
    acoustIdLookupCache.set(key, {
        expiresAt: Date.now() + ACOUSTID_CACHE_TTL_MS,
        outcome,
    });
}

export function clearAcoustIdLookupCacheForTest(): void {
    acoustIdLookupCache.clear();
}

export async function lookupAcoustIdDetailed(
    input: AcoustIdBatchInput,
    options: AcoustIdLookupOptions = {},
): Promise<AcoustIdLookupOutcome> {
    const fingerprint = String(input.fingerprint || "").trim();
    const duration = Number(input.duration);
    if (!fingerprint || !Number.isFinite(duration) || duration <= 0) {
        return {
            status: "invalid_input",
            matches: [],
            cached: false,
            error: "A non-empty fingerprint and positive duration are required",
        };
    }

    const explicitlyConfigured = Object.prototype.hasOwnProperty.call(options, "clientId");
    const clientId = String(
        explicitlyConfigured
            ? options.clientId ?? ""
            : resolveAcoustIdClientId({
                env: process.env,
                appConfig: Config.getAppConfig(),
            }),
    ).trim();
    if (!clientId) {
        return {
            status: "missing_client",
            matches: [],
            cached: false,
            error: "AcoustID client key is not configured",
        };
    }

    const cacheKey = acoustIdCacheKey(fingerprint, duration, clientId);
    if (!options.bypassCache) {
        const cached = acoustIdLookupCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return { ...cached.outcome, cached: true };
        }
        if (cached) acoustIdLookupCache.delete(cacheKey);
    }

    const params = new URLSearchParams({
        client: clientId,
        format: "json",
        meta: "recordingids",
        duration: String(Math.round(duration)),
        fingerprint,
    });

    try {
        const post = options.post ?? (axios.post.bind(axios) as AcoustIdPost);
        const response = await post(
            "https://api.acoustid.org/v2/lookup",
            gzipSync(Buffer.from(params.toString(), "utf8")),
            {
                timeout: 10000,
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Content-Encoding": "gzip",
                },
                validateStatus: (status: number) => status < 500,
            },
        );
        if (
            (typeof response.status === "number" && response.status >= 400)
            || response.data?.status !== "ok"
        ) {
            return {
                status: "service_error",
                matches: [],
                cached: false,
                error: String(
                    response.data?.error?.message
                    || response.data?.error?.code
                    || response.data?.error
                    || `AcoustID returned HTTP ${response.status ?? "error"}`,
                ),
            };
        }

        const matches = mapAcoustIdResults(
            Array.isArray(response.data?.results) ? response.data.results : [],
        );
        const outcome: Omit<AcoustIdLookupOutcome, "cached"> = {
            status: matches.length > 0 ? "matched" : "no_match",
            matches,
        };
        cacheAcoustIdOutcome(cacheKey, outcome);
        return { ...outcome, cached: false };
    } catch (error: any) {
        return {
            status: "service_error",
            matches: [],
            cached: false,
            error: error?.message || String(error),
        };
    }
}

export async function lookupAcoustIdBatch(inputs: AcoustIdBatchInput[]): Promise<AcoustIdLookupResult[][]> {
    if (inputs.length === 0) {
        return [];
    }

    // The lookup-by-fingerprint endpoint accepts one fingerprint per request.
    // A `batch` parameter exists on other AcoustID endpoints, but not this one.
    // Run serially and stay below the documented three-requests/second limit.
    const output: AcoustIdLookupResult[][] = [];
    for (let index = 0; index < inputs.length; index += 1) {
        if (index > 0) await delay(350);
        const outcome = await lookupAcoustIdDetailed(inputs[index]);
        if (outcome.status === "service_error") {
            console.warn("[Fingerprint] AcoustID lookup failed:", outcome.error);
        }
        output.push(outcome.matches);
    }
    return output;
}

export async function lookupAcoustIdMatches(fingerprint: string, duration: number): Promise<AcoustIdLookupResult[]> {
    const [matches] = await lookupAcoustIdBatch([{ fingerprint, duration }]);
    return matches || [];
}

/**
 * Lookup AcoustID and retrieve corresponding MusicBrainz Recording IDs
 * @param fingerprint Chromaprint fingerprint
 * @param duration Duration in seconds
 * @returns Array of unique MusicBrainz IDs (MBIDs)
 */
export async function lookupAcoustId(fingerprint: string, duration: number): Promise<string[]> {
    const results = await lookupAcoustIdMatches(fingerprint, duration);
    const mbids = new Set<string>();
    for (const result of results) {
        for (const recordingId of result.recordingIds) {
            if (recordingId) {
                mbids.add(recordingId);
            }
        }
    }

    return Array.from(mbids);
}

/**
 * The configured catalog source, when it is present and can answer directly.
 *
 * Every lookup below is a per-file question asked during import and retag. Sent
 * to musicbrainz.org they queue behind one global 1-request-per-second lock and,
 * across a real library, come back 503 — which is why importing files for
 * artists not already in the database resolved nothing. A local MusicBrainz
 * mirror answers all three from Postgres, so ask it first and keep the public
 * service as the fallback for deployments that have no local source.
 */
async function activeCatalogSource(): Promise<import("../catalog/catalog-provider.js").CatalogProvider | null> {
    try {
        const { catalogProviderRegistry } = await import("../catalog/index.js");
        return catalogProviderRegistry.getActive();
    } catch {
        return null;
    }
}

export async function lookupMusicBrainzRecording(recordingId: string): Promise<MusicBrainzRecording | null> {
    if (!recordingId) {
        return null;
    }

    const source = await activeCatalogSource();
    if (typeof source?.getRecording === "function") {
        try {
            const recording = await source.getRecording(recordingId);
            if (recording) {
                const credits = recording.artistCredit
                    ? [{ id: "", name: recording.artistCredit, joinPhrase: "" }]
                    : [];
                return {
                    id: recording.mbid || recordingId,
                    title: recording.title || "",
                    artists: credits.map((credit) => credit.name),
                    artistCredits: credits,
                    isrcs: recording.isrcs || [],
                    releaseTitles: [],
                    firstReleaseDate: null,
                    durationSeconds: recording.lengthMs == null ? null : Math.round(recording.lengthMs / 1000),
                };
            }
        } catch (error: any) {
            console.warn(`[Fingerprint] Catalog recording lookup failed for ${recordingId}; falling back to public MusicBrainz:`, error?.message || error);
        }
    }

    const url = `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(recordingId)}?fmt=json&inc=artist-credits+isrcs+releases`;

    try {
        const data = await requestMusicBrainzJson<any>(url) || {};
        const artistCredits = mapMusicBrainzArtistCredits(data["artist-credit"]);
        const artists = artistCredits.map((credit) => credit.name);
        const releaseTitles = Array.isArray(data.releases)
            ? data.releases
                .map((release: any) => release?.title || null)
                .filter(Boolean)
            : [];
        const durationSeconds = typeof data.length === "number" && Number.isFinite(data.length)
            ? Math.round(data.length / 1000)
            : null;

        return {
            id: String(data.id || recordingId),
            title: data.title || "",
            artists,
            artistCredits,
            isrcs: Array.isArray(data.isrcs) ? data.isrcs.filter(Boolean) : [],
            releaseTitles,
            firstReleaseDate: data["first-release-date"] || null,
            durationSeconds,
        };
    } catch (error: any) {
        const status = error?.response?.status;
        if (status === 404) {
            return null;
        }

        console.warn(`[Fingerprint] MusicBrainz lookup failed for ${recordingId}:`, error?.message || error);
        return null;
    }
}

export async function lookupMusicBrainzRecordingsByIsrc(isrc: string): Promise<MusicBrainzRecording[]> {
    const normalized = String(isrc || "").trim().toUpperCase();
    if (!normalized) {
        return [];
    }

    const source = await activeCatalogSource();
    if (typeof source?.lookupByISRC === "function") {
        try {
            const local = await source.lookupByISRC(normalized);
            const recordings = (local.recordings || []).map((recording) => {
                const credits = recording.artistCredit
                    ? [{ id: "", name: recording.artistCredit, joinPhrase: "" }]
                    : [];
                return {
                    id: String(recording.mbid || "").trim(),
                    title: String(recording.title || "").trim(),
                    artists: credits.map((credit) => credit.name),
                    artistCredits: credits,
                    isrcs: [normalized],
                    releaseTitles: [],
                    firstReleaseDate: null,
                    durationSeconds: recording.lengthMs == null ? null : Math.round(recording.lengthMs / 1000),
                } satisfies MusicBrainzRecording;
            }).filter((recording) => Boolean(recording.id && recording.title));
            if (recordings.length > 0) return recordings;
        } catch (error: any) {
            console.warn(`[Fingerprint] Catalog ISRC lookup failed for ${normalized}; falling back to public MusicBrainz:`, error?.message || error);
        }
    }

    const url = `https://musicbrainz.org/ws/2/recording?fmt=json&limit=10&query=${encodeURIComponent(`isrc:${normalized}`)}`;

    try {
        const data = await requestMusicBrainzJson<any>(url);
        const recordings = Array.isArray(data?.recordings) ? data.recordings : [];
        return recordings.map((recording: any) => {
            const artistCredits = mapMusicBrainzArtistCredits(recording?.["artist-credit"]);
            const releaseTitles = Array.isArray(recording?.releases)
                ? recording.releases.map((release: any) => String(release?.title || "").trim()).filter(Boolean)
                : [];
            const durationSeconds = typeof recording?.length === "number" && Number.isFinite(recording.length)
                ? Math.round(recording.length / 1000)
                : null;

            return {
                id: String(recording?.id || "").trim(),
                title: String(recording?.title || "").trim(),
                artists: artistCredits.map((credit) => credit.name),
                artistCredits,
                isrcs: [normalized],
                releaseTitles,
                firstReleaseDate: recording?.["first-release-date"] || null,
                durationSeconds,
            } satisfies MusicBrainzRecording;
        }).filter((recording: MusicBrainzRecording) => Boolean(recording.id && recording.title));
    } catch (error: any) {
        console.warn(`[Fingerprint] MusicBrainz ISRC lookup failed for ${normalized}:`, error?.message || error);
        return [];
    }
}

export async function lookupMusicBrainzReleasesByBarcode(barcode: string): Promise<MusicBrainzRelease[]> {
    const normalized = String(barcode || "").trim().replace(/[^0-9]/g, "");
    if (!normalized) {
        return [];
    }

    const source = await activeCatalogSource();
    if (typeof source?.lookupByUPC === "function") {
        try {
            const local = await source.lookupByUPC(normalized);
            const hits = local.releases || [];
            // The barcode index gives identity; the release detail gives the
            // fields the match scorer weighs (date, country, status).
            const releases = (await Promise.all(hits.map(async (hit) => {
                const detail = typeof source.getReleaseWithTracks === "function"
                    ? await source.getReleaseWithTracks(hit.releaseMbid).catch(() => null)
                    : null;
                return {
                    id: String(hit.releaseMbid || "").trim(),
                    title: String(detail?.Title || hit.title || "").trim(),
                    barcode: normalized,
                    date: String(detail?.ReleaseDate || "").trim() || null,
                    country: (detail?.Country || []).map((value) => String(value || "").trim()).filter(Boolean)[0] || null,
                    status: String(detail?.Status || "").trim() || null,
                    releaseGroupId: String(hit.releaseGroupMbid || "").trim() || null,
                    releaseGroupPrimaryType: null,
                    releaseGroupSecondaryTypes: [],
                    artistCredits: [],
                } satisfies MusicBrainzRelease;
            }))).filter((release) => Boolean(release.id && release.title));
            if (releases.length > 0) return releases;
        } catch (error: any) {
            console.warn(`[Fingerprint] Catalog barcode lookup failed for ${normalized}; falling back to public MusicBrainz:`, error?.message || error);
        }
    }

    const url = `https://musicbrainz.org/ws/2/release?fmt=json&limit=10&query=${encodeURIComponent(`barcode:${normalized}`)}`;

    try {
        const data = await requestMusicBrainzJson<any>(url);
        const releases = Array.isArray(data?.releases) ? data.releases : [];
        return releases.map((release: any) => ({
            id: String(release?.id || "").trim(),
            title: String(release?.title || "").trim(),
            barcode: String(release?.barcode || "").trim() || null,
            date: String(release?.date || "").trim() || null,
            country: String(release?.country || "").trim() || null,
            status: String(release?.status || "").trim() || null,
            releaseGroupId: String(release?.["release-group"]?.id || "").trim() || null,
            releaseGroupPrimaryType: getReleaseGroupPrimaryType(release),
            releaseGroupSecondaryTypes: getReleaseGroupSecondaryTypes(release),
            artistCredits: mapMusicBrainzArtistCredits(release?.["artist-credit"]),
        })).filter((release: MusicBrainzRelease) => Boolean(release.id && release.title));
    } catch (error: any) {
        console.warn(`[Fingerprint] MusicBrainz barcode lookup failed for ${normalized}:`, error?.message || error);
        return [];
    }
}
