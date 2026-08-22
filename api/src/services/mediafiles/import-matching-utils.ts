import path from "path";
import type { LocalFile } from "./import-types.js";

/** Uppercase alphanumeric ISRC (shared by matchers / slot planners). */
export function normalizeIsrc(value: unknown): string {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

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

/**
 * Comparable title for video ↔ recording matching: strips accents, punctuation
 * and video-designation words ("official / music / lyric / audio / video / live
 * / …") so a provider upload ("Living (feat. …) (Official Video)") compares equal
 * to the plain recording title. Lives here with the other title helpers rather
 * than duplicated in the video service. (See docs/MATCHING_SET_COVER_DESIGN.md §5
 * for the planned collapse of these variants into one cleaner.)
 */
export function videoComparableTitle(value?: string | null): string {
    return String(value || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\b(official|music|lyric|lyrics|audio|visualizer|visualiser|video|hd|hq|4k|remaster(?:ed)?|live|performance)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function normalizeComparableText(input?: string | null): string {
    return (input || "")
        .toLowerCase()
        .replace(/\[tidal-\d+\]/g, " ")
        .replace(/\((?:[^)]*\b(?:feat|ft|featuring)\b[^)]*)\)/g, " ")
        .replace(/\[(?:[^\]]*\b(?:feat|ft|featuring)\b[^\]]*)\]/g, " ")
        .replace(/\[(?:\d+\s*-\s*bit[^\]]*|album|single|ep|video|explicit|clean|e|atmos|dolby atmos)\]/g, " ")
        .replace(/\((?:19|20)\d{2}\)/g, " ")
        .replace(/[_./\\-]+/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * A trailing " - …" qualifier, as MusicBrainz writes live and session
 * performances: "Good Grief - ARTE Live at Turner Contemporary".
 *
 * Only the significant forms count, and only as a *suffix*. Titles legitimately
 * contain dashes ("Jump - Rerecorded" is a version; "Ohio - Live" is; but
 * "Mother - Daughter" is just a title), so the tail must name a recording
 * variant before it is treated as one. Requiring `SIGNIFICANT_VERSION_RE` to
 * match the tail is what keeps this from eating ordinary titles.
 *
 * Without it the whole suffix stayed in the base title, which had two costs on
 * the same release: three tracks of "&" (Ampersand), Part Four went unmatched
 * despite agreeing with the provider on position AND duration to the second,
 * because their base titles could never compare equal — while a fourth track
 * scraped in on raw string similarity purely because its title was longer. And
 * in the other direction the live/studio veto never fired for dash-form titles
 * at all, since neither side reported a version qualifier.
 */
const DASH_VERSION_SUFFIX_RE = /\s+[-–—]\s+([^-–—]+)$/u;

function significantDashSuffix(text: string): string | null {
    const match = DASH_VERSION_SUFFIX_RE.exec(text);
    if (!match) return null;
    const normalized = normalizeComparableText(match[1]);
    return normalized && SIGNIFICANT_VERSION_RE.test(normalized) ? normalized : null;
}

/**
 * Comparable title with trailing qualifiers removed.
 * MusicBrainz disambiguates bonus and live tracks with suffixes like
 * "Haunt (demo)", "Bad Blood (piano version // live from Unit 24)" or
 * "Good Grief - ARTE Live at Turner Contemporary" that providers usually omit;
 * stripping them exposes the shared base title.
 */
/**
 * Drop a leading track index ("01. ", "7 - ") so tagged rips compare equal to
 * catalog titles. Requires a separator after the number so "99 Problems" and
 * "1989" stay intact.
 */
export function stripLeadingTrackIndex(input?: string | null): string {
    return String(input || "").replace(/^\s*\d{1,3}\s*[.-]\s+/, "").trim();
}

export function baseComparableTitle(input?: string | null): string {
    let text = stripLeadingTrackIndex(input);
    for (;;) {
        let next = text.replace(/\s*[([][^()[\]]*[)\]]\s*$/u, "");
        if (next === text && significantDashSuffix(text)) {
            next = text.replace(DASH_VERSION_SUFFIX_RE, "");
        }
        if (next === text) {
            break;
        }
        text = next;
    }
    return normalizeComparableText(text);
}

// Version qualifiers that denote a genuinely different recording (not cosmetic
// decoration). "One Day (radio edit)" and "One Day (Oliver $ Remix)" share a
// base title but are NOT the same recording. Shared by provider track matching
// and provider↔MusicBrainz video matching so there is one definition.
const SIGNIFICANT_VERSION_RE =
    /\b(remix|re-?edit|\bedit\b|\bmix\b|version|live|acoustic|unplugged|instrumental|a\s*cappella|acappella|karaoke|dub|rework|refix|flip|vip|bootleg|reprise|orchestral|symphonic|extended|radio|club|demo|sessions?|rerecorded|re-?recorded|commentary|interview|spoken\s*word|\bskit\b|\bintro\b|\boutro\b)\b/;

/**
 * The significant version signature of a title — the normalized text of its
 * parenthetical/bracketed qualifiers, but only when they name a recording
 * variant (remix/edit/live/…). Cosmetic qualifiers (feat., explicit, remaster,
 * bit-depth, year) are dropped by normalizeComparableText, so they never count.
 * Returns "" when the title carries no significant version.
 */
export function versionQualifierSignature(title?: string | null): string {
    const raw = String(title || "");
    const qualifiers: string[] = [];
    const pattern = /[([]([^()[\]]*)[)\]]/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(raw)) !== null) {
        qualifiers.push(match[1]);
    }
    // MusicBrainz writes the same qualifier both ways; "Ohio - Live" has to be
    // as incompatible with plain "Ohio" as "Ohio (live)" is.
    const dashSuffix = significantDashSuffix(raw.replace(/\s*[([][^()[\]]*[)\]]\s*$/u, "").trim());
    if (dashSuffix) {
        qualifiers.push(dashSuffix);
    }
    const normalized = normalizeComparableText(qualifiers.join(" "));
    return normalized && SIGNIFICANT_VERSION_RE.test(normalized) ? normalized : "";
}

/**
 * Two titles are version-compatible only when they claim the same recording
 * variant. A significant qualifier on exactly ONE side ("Rehab (live at
 * Kalkscheune, Berlin)" vs "Rehab") names a genuinely different recording, so
 * it is incompatible — title/duration/position must never equate a studio
 * track with its live/remix/demo variant. Cosmetic decoration (remaster, year,
 * bit depth, feat.) never reaches this check because versionQualifierSignature
 * only reports significant variants. Identity evidence (recording MBID/ISRC)
 * is scored before any title logic, so an ISRC-verified match still wins even
 * when the displayed titles disagree about the version.
 */
export function versionsCompatible(titleA?: string | null, titleB?: string | null): boolean {
    const a = versionQualifierSignature(titleA);
    const b = versionQualifierSignature(titleB);
    if (!a && !b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    if (a === b || stringSimilarity(a, b) >= 0.6) {
        return true;
    }
    // "demo" vs "original demo": one qualifier elaborating the other still
    // describes the same variant. Distinct variants ("live at kalkscheune
    // berlin" vs "live at bbc radio 1") share a keyword but neither token set
    // contains the other.
    const tokensA = new Set(a.split(" ").filter(Boolean));
    const tokensB = new Set(b.split(" ").filter(Boolean));
    const [small, large] = tokensA.size <= tokensB.size ? [tokensA, tokensB] : [tokensB, tokensA];
    return small.size > 0 && Array.from(small).every((token) => large.has(token));
}

/**
 * Whether two titles describe the same recording: identical base title AND
 * compatible significant versions. Used to attach a provider item to an existing
 * MusicBrainz recording by title (e.g. video ↔ MusicBrainz video).
 */
export function sameRecordingTitle(titleA?: string | null, titleB?: string | null): boolean {
    const baseA = baseComparableTitle(titleA);
    return Boolean(baseA) && baseA === baseComparableTitle(titleB) && versionsCompatible(titleA, titleB);
}

export function providerTrackComparableTitle(track: {
    title?: string | null;
    version?: string | null;
    raw?: unknown;
}): string {
    const title = String(track.title || "").trim();
    const raw = track.raw && typeof track.raw === "object" ? track.raw as Record<string, unknown> : {};
    const version = String(track.version || raw.version || "").trim();
    if (!version || normalizeComparableText(title).includes(normalizeComparableText(version))) {
        return title;
    }

    return `${title} (${version})`;
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
