// Helper to extract Release Group from filename (Scene/P2P standard)
// Handles: "Artist - Title [Source-Group]", "File [Group] [FLAC]", "File [Group-FLAC]"
export function extractReleaseGroup(filename: string): string | null {
    const name = path.parse(filename).name;

    const KNOWN_EXCEPTIONS = new Set([
        "E.N.D", "KRaLiMaRKo", "YIFY", "YTS", "EVO", "ETRG"
    ]);

    const IGNORED = new Set([
        "FLAC", "MP3", "AAC", "WAV", "ALAC", "AIFF", "DTS", "ATMOS", "TRUEHD", "EAC3", "AC3",
        "WEB", "WEB-DL", "WEBRIP", "CD", "VINYL", "RIP", "BLURAY", "DVD", "SACD",
        "320", "V0", "V2", "1080P", "720P", "4K", "2160P", "HDR", "DV",
        "CLEAN", "DIRTY", "EXPLICIT", "REPACK", "PROPER", "REMASTER", "DELUXE",
        "MONO", "STEREO", "MULTICHANNEL", "MKV", "MP4", "AVI"
    ]);

    const brackets = name.match(/\[([^\]]+)\]/g);

    if (brackets) {
        for (let i = brackets.length - 1; i >= 0; i--) {
            const content = brackets[i].slice(1, -1).trim();

            for (const exception of KNOWN_EXCEPTIONS) {
                if (content.toUpperCase() === exception.toUpperCase()) return exception;
                if (content.toUpperCase().endsWith(exception.toUpperCase())) {
                    const idx = content.toUpperCase().lastIndexOf(exception.toUpperCase());
                    if (idx === 0 || /[-_ ]/.test(content[idx - 1])) {
                        return exception;
                    }
                }
            }

            const tokens = content.split(/[-_]/);

            for (let j = tokens.length - 1; j >= 0; j--) {
                const token = tokens[j].trim();
                const upper = token.toUpperCase();

                if (/^(19|20)\d{2}$/.test(token)) continue;
                if (/^\d{1,3}$/.test(token)) continue;
                if (IGNORED.has(upper)) continue;

                if (token.length > 1) {
                    return token;
                }
            }
        }
    }

    const parts = name.split('-');
    if (parts.length > 2) {
        const last = parts[parts.length - 1].trim();
        if (/^\d+$/.test(last)) return null;
        if (IGNORED.has(last.toUpperCase())) return null;

        if (KNOWN_EXCEPTIONS.has(last.toUpperCase())) return last;

        if (last.length > 1 && last.length < 15) {
            const secondLast = parts[parts.length - 2].trim();
            if (/^(19|20)\d{2}$/.test(secondLast)) return last;
        }
    }

    return null;
}

import path from "path";
import type { LocalFile } from "./import-types.js";

export type AlbumTrackLike = {
    id: string;
    title: string;
    track_number: number;
    volume_number: number;
};

function levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1)
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

export function stringSimilarity(s1: string, s2: string): number {
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    if (longer.length === 0) return 1.0;
    return (longer.length - levenshteinDistance(longer, shorter)) / longer.length;
}

export function normalizeTitle(input: string): string {
    return (input || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .trim();
}

export function normalizeComparableText(input?: string | null): string {
    return (input || "")
        .toLowerCase()
        .replace(/\[tidal-\d+\]/g, " ")
        .replace(/\[(?:\d+\s*-\s*bit[^\]]*|album|single|ep|video|explicit|clean|e|atmos|dolby atmos)\]/g, " ")
        .replace(/\((?:19|20)\d{2}\)/g, " ")
        .replace(/[_./\\-]+/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function matchTrackForFile(file: LocalFile, tracks: AlbumTrackLike[]): AlbumTrackLike | null {
    if (!tracks || tracks.length === 0) return null;

    const trackNo = file.metadata?.common?.track?.no;
    const volumeNo = file.metadata?.common?.disk?.no || 1;
    const rawTitle = file.metadata?.common?.title || path.parse(file.name).name;
    const normalizedTitle = normalizeTitle(rawTitle);

    const scoreTitle = (candidate: AlbumTrackLike) => {
        if (!normalizedTitle) return 0;
        return stringSimilarity(normalizedTitle, normalizeTitle(candidate.title));
    };

    let candidates = tracks;
    if (trackNo) {
        candidates = tracks.filter((t) =>
            t.track_number === trackNo && (t.volume_number || 1) === volumeNo
        );
    }

    if (candidates.length === 1) return candidates[0];

    if (candidates.length > 1) {
        const scored = candidates
            .map((track) => ({ track, score: scoreTitle(track) }))
            .sort((a, b) => b.score - a.score);
        return scored[0]?.score >= 0.55 ? scored[0].track : candidates[0];
    }

    if (normalizedTitle) {
        const scored = tracks
            .map((track) => ({ track, score: scoreTitle(track) }))
            .sort((a, b) => b.score - a.score);
        return scored[0]?.score >= 0.7 ? scored[0].track : null;
    }

    return null;
}