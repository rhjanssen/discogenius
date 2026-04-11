import axios from 'axios';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { resolveAcoustIdClientId } from './provider-client-config.js';
import { Config } from './config.js';

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
    artistCredits: MusicBrainzArtistCredit[];
}

const MUSICBRAINZ_USER_AGENT = "Discogenius/1.2.1 (music metadata enrichment)";

function getMusicBrainzHeaders() {
    return {
        "User-Agent": MUSICBRAINZ_USER_AGENT,
    };
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

/**
 * Lookup AcoustID and retrieve corresponding MusicBrainz Recording IDs
 * @param fingerprint Chromaprint fingerprint
 * @param duration Duration in seconds
 * @returns Array of unique MusicBrainz IDs (MBIDs)
 */
export async function lookupAcoustId(fingerprint: string, duration: number): Promise<string[]> {
    const clientId = resolveAcoustIdClientId({
        env: process.env,
        appConfig: Config.getAppConfig(),
    });
    const url = `https://api.acoustid.org/v2/lookup?client=${clientId}&meta=recordingids&duration=${duration}&fingerprint=${fingerprint}`;

    try {
        const response = await axios.get(url, { timeout: 10000 });
        if (response.data.status !== 'ok') {
            console.warn('[Fingerprint] AcoustID API error:', response.data.error);
            return [];
        }

        const results = response.data.results;
        if (!results || results.length === 0) return [];

        const mbids = new Set<string>();
        for (const res of results) {
            if (res.recordings) {
                for (const rec of res.recordings) {
                    if (rec.id) mbids.add(rec.id);
                }
            }
        }
        return Array.from(mbids);
    } catch (error: any) {
        console.error('[Fingerprint] AcoustID lookup error:', error.message);
        return [];
    }
}

export async function lookupMusicBrainzRecording(recordingId: string): Promise<MusicBrainzRecording | null> {
    if (!recordingId) {
        return null;
    }

    const url = `https://musicbrainz.org/ws/2/recording/${encodeURIComponent(recordingId)}?fmt=json&inc=artist-credits+isrcs+releases`;

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            headers: getMusicBrainzHeaders(),
        });

        const data = response.data || {};
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

    const url = `https://musicbrainz.org/ws/2/recording?fmt=json&limit=10&query=${encodeURIComponent(`isrc:${normalized}`)}`;

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            headers: getMusicBrainzHeaders(),
        });

        const recordings = Array.isArray(response.data?.recordings) ? response.data.recordings : [];
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

    const url = `https://musicbrainz.org/ws/2/release?fmt=json&limit=10&query=${encodeURIComponent(`barcode:${normalized}`)}`;

    try {
        const response = await axios.get(url, {
            timeout: 10000,
            headers: getMusicBrainzHeaders(),
        });

        const releases = Array.isArray(response.data?.releases) ? response.data.releases : [];
        return releases.map((release: any) => ({
            id: String(release?.id || "").trim(),
            title: String(release?.title || "").trim(),
            barcode: String(release?.barcode || "").trim() || null,
            date: String(release?.date || "").trim() || null,
            country: String(release?.country || "").trim() || null,
            status: String(release?.status || "").trim() || null,
            releaseGroupId: String(release?.["release-group"]?.id || "").trim() || null,
            artistCredits: mapMusicBrainzArtistCredits(release?.["artist-credit"]),
        })).filter((release: MusicBrainzRelease) => Boolean(release.id && release.title));
    } catch (error: any) {
        console.warn(`[Fingerprint] MusicBrainz barcode lookup failed for ${normalized}:`, error?.message || error);
        return [];
    }
}
