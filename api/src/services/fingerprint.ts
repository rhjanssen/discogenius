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
    isrcs: string[];
    releaseTitles: string[];
    firstReleaseDate: string | null;
    durationSeconds: number | null;
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
            headers: {
                "User-Agent": "Discogenius/0.1 (alpha import fingerprint resolver)",
            },
        });

        const data = response.data || {};
        const artistCredits = Array.isArray(data["artist-credit"]) ? data["artist-credit"] : [];
        const artists = artistCredits
            .map((credit: any) => credit?.name || credit?.artist?.name || null)
            .filter(Boolean);
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
