import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { db } from "../../database.js";
import { probeAudioStreamMetrics, resolveFfmpegBinary, resolveFfprobeBinary } from "./audioUtils.js";

const identityColumns = ["artist_metadata_id", "library_id", "track_id", "album_edition_id", "release_group_id",
    "recording_id", "canonical_artist_mbid", "canonical_release_group_mbid", "canonical_release_mbid",
    "canonical_track_mbid", "canonical_recording_mbid", "library_slot", "quality", "codec", "sample_rate", "bit_depth", "channels"];
type FileRow = Record<string, unknown> & { id: number; file_path: string; library_root: string; file_type: string };
const row = (id: number) => db.prepare("SELECT * FROM TrackFiles WHERE id = ?").get(id) as FileRow | undefined;
const snapshot = (file: FileRow) => JSON.stringify(file);

function fileWitness(file: string, root: string): string {
    const relative = path.relative(path.resolve(root), path.resolve(file));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Duplicate file is outside its library root");
    }
    let directory = path.dirname(path.resolve(file));
    while (true) {
        if (!fs.lstatSync(directory).isDirectory()) throw new Error("Duplicate file has a linked or unavailable ancestor");
        if (path.relative(path.resolve(root), directory) === "") break;
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error("Duplicate file escaped its library root");
        directory = parent;
    }
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error("Duplicate proof requires a regular file");
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":");
}

function pcmDigest(file: string): Promise<string> {
    return new Promise((resolve, reject) => execFile(resolveFfmpegBinary(),
        ["-v", "error", "-xerror", "-i", file, "-map", "0:a:0", "-c:a", "pcm_s32le", "-f", "hash", "-hash", "sha256", "-"],
        { windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            const digest = stdout.trim().match(/^SHA256=([a-f0-9]{64})$/i)?.[1];
            if (error || !digest) reject(new Error(`Could not verify duplicate audio: ${error?.message || "missing digest"}`));
            else resolve(digest.toLowerCase());
        }));
}

function hasSingleAudioStream(file: string): Promise<boolean> {
    return new Promise(resolve => execFile(resolveFfprobeBinary(),
        ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "json", file],
        { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
            try { resolve(!error && JSON.parse(stdout).streams?.length === 1); }
            catch { resolve(false); }
        }));
}

function noOtherClaims(file: string): boolean {
    return !["MetadataFiles", "LyricFiles", "ExtraFiles", "UnmappedFiles"].some(table =>
        db.prepare(`SELECT 1 FROM ${table} WHERE file_path = ? LIMIT 1`).get(file));
}

function canonicalGraphAgrees(file: FileRow): boolean {
    return Boolean(db.prepare(`SELECT 1 FROM Tracks t
        JOIN AlbumEditions e ON e.id=t.album_edition_id
        JOIN Albums a ON a.id=e.release_group_id
        JOIN Recordings r ON r.id=t.recording_id
        JOIN ArtistMetadata artist ON artist.id=?
        WHERE t.id=? AND e.id=? AND a.id=? AND r.id=?
          AND t.mbid=? AND e.mbid=? AND a.mbid=? AND r.mbid=? AND artist.mbid=?`)
        .get(file.artist_metadata_id, file.track_id, file.album_edition_id, file.release_group_id, file.recording_id,
            file.canonical_track_mbid, file.canonical_release_mbid, file.canonical_release_group_mbid,
            file.canonical_recording_mbid, file.canonical_artist_mbid));
}

/** No provider identity or equal recording alone authorizes deleting an edition.
 * Decode outside writer admission, then retain exact row/filesystem witnesses
 * through the journaled ownership transaction. Currently lossless stereo only. */
export function audioDuplicateCandidate(sourceId: number, destinationId: number, sourcePath: string, destinationPath: string)
    : { source: FileRow; destination: FileRow } | null {
    const source = row(sourceId), destination = row(destinationId);
    if (!source || !destination || sourceId === destinationId || source.file_path !== sourcePath
        || destination.file_path !== destinationPath || source.file_type !== "track" || destination.file_type !== "track"
        || source.library_slot !== "stereo" || !source.track_id || !source.album_edition_id || !source.recording_id
        || !source.library_id || !source.quality || identityColumns.some(key => source[key] !== destination[key])
        || !noOtherClaims(sourcePath) || !noOtherClaims(destinationPath) || !canonicalGraphAgrees(source)) return null;
    return { source, destination };
}

export async function proveAudioDuplicate(sourceId: number, destinationId: number, sourcePath: string, destinationPath: string)
    : Promise<{ assertUnchanged: (stagedPath: string) => void; retainedId: number } | null> {
    const candidate = audioDuplicateCandidate(sourceId, destinationId, sourcePath, destinationPath);
    if (!candidate) return null;
    const { source, destination } = candidate;
    const sourceSnapshot = snapshot(source), destinationSnapshot = snapshot(destination);
    const sourceWitness = fileWitness(sourcePath, source.library_root);
    const destinationWitness = fileWitness(destinationPath, destination.library_root);
    const [sourceMetrics, destinationMetrics, singleSource, singleDestination] = await Promise.all([
        probeAudioStreamMetrics(sourcePath), probeAudioStreamMetrics(destinationPath),
        hasSingleAudioStream(sourcePath), hasSingleAudioStream(destinationPath),
    ]);
    if (!singleSource || !singleDestination || !sourceMetrics.codec || !["flac", "alac"].includes(sourceMetrics.codec.toLowerCase())
        || sourceMetrics.channels !== 2 || !sourceMetrics.sampleRate || !sourceMetrics.bitDepth || sourceMetrics.bitDepth > 32
        || ["codec", "sampleRate", "bitDepth", "channels"].some(key =>
            sourceMetrics[key as keyof typeof sourceMetrics] !== destinationMetrics[key as keyof typeof destinationMetrics])
        || sourceMetrics.sampleRate !== source.sample_rate || sourceMetrics.bitDepth !== source.bit_depth
        || sourceMetrics.channels !== source.channels || sourceMetrics.codec.toLowerCase() !== String(source.codec).toLowerCase()) return null;
    const [sourceDigest, destinationDigest] = await Promise.all([pcmDigest(sourcePath), pcmDigest(destinationPath)]);
    if (sourceDigest !== destinationDigest) return null;
    const assertUnchanged = (stagedPath: string) => {
        const currentSource = row(sourceId), currentDestination = row(destinationId);
        if (!currentSource || !currentDestination || snapshot(currentSource) !== sourceSnapshot
            || snapshot(currentDestination) !== destinationSnapshot
            || fileWitness(stagedPath, source.library_root) !== sourceWitness
            || fileWitness(destinationPath, destination.library_root) !== destinationWitness
            || !noOtherClaims(sourcePath) || !noOtherClaims(destinationPath) || !canonicalGraphAgrees(currentSource)) {
            throw new Error("Duplicate audio or ownership changed; preserving the source");
        }
    };
    assertUnchanged(sourcePath);
    return { assertUnchanged, retainedId: destinationId };
}
