import fs from "node:fs";
import path from "node:path";
import { db, withSqliteWriteGate } from "../../database.js";
import { getConfigSection } from "../config/config.js";
import { isLyricSidecarExtension } from "../extras/lyrics/lyric-sidecar.js";
import { LyricFileService } from "../extras/lyrics/lyric-file-service.js";
import { MetadataFileService, getMetadataType } from "../extras/metadata/files/metadata-file-service.js";
import { ExtraFileService, type ExtraFileUpsertInput } from "../extras/files/extra-file-service.js";
import { SUPPORTED_IMPORT_EXTENSIONS } from "./import-discovery.js";

type Owner = {
    id: number; library_id: number; library_slot: string; file_path: string; file_type: string; root_path: string;
    artist: string; album: string | null; edition: string | null; track: string | null; recording: string | null;
};
export type SidecarDecision = { status: "not_sidecar" | "owned" | "review_sidecar" | "unresolved" }
    | { status: "identified"; input: ExtraFileUpsertInput; libraryIds: number[];
        existing?: { table: "MetadataFiles" | "LyricFiles"; row: Record<string,unknown> } };

function identity(file: string): string {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Sidecar path changed: ${file}`);
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(":");
}

function artistFolderScope(file: string, root: string): SidecarDecision | undefined {
    const directory = path.dirname(file), relative = path.relative(root,directory);
    // The library root itself is not an artist folder. Persisted paths, rather
    // than a basename or naming-template guess, establish artist ownership.
    if (!relative) return undefined;
    const paths = [...new Set([relative,relative.replace(/\\/g,"/"),relative.replace(/\//g,"\\"),directory])];
    const rows = db.prepare(`SELECT library.id AS library_id,library.root_path,artist.mbid AS artist
        FROM LibraryArtists membership JOIN Libraries library ON library.id=membership.library_id
        JOIN ArtistMetadata artist ON artist.id=membership.artist_metadata_id
        WHERE membership.path ${process.platform === "win32" ? "COLLATE NOCASE" : ""}
          IN (${paths.map(() => "?").join(",")}) ORDER BY library.id,membership.id`).all(...paths) as Array<{library_id:number;root_path:string;artist:string}>;
    const matching = rows.filter(row => path.relative(path.resolve(row.root_path),root) === "");
    if (!matching.length) return undefined;
    if (matching.some(row => !row.artist) || new Set(matching.map(row => row.artist)).size !== 1) return {status:"unresolved"};
    const config = getConfigSection("path");
    const slots = new Set(([ [config.music_path,"stereo"], [config.spatial_path,"spatial"], [config.video_path,"video"] ] as const)
        .filter(([configured]) => configured && path.relative(path.resolve(configured),root) === "").map(([,slot]) => slot));
    if (slots.size !== 1) return {status:"unresolved"};
    const libraryIds = [...new Set(matching.map(row => row.library_id))].sort((a,b) => a-b);
    return {status:"identified",libraryIds,input:{artistId:matching[0].artist,canonicalArtistMbid:matching[0].artist,
        libraryId:libraryIds[0],libraryRoot:root,filePath:file,librarySlot:[...slots][0],
        fileType:path.extname(file).toLowerCase() === ".nfo" ? "nfo" : "cover",trackFileId:null}};
}

/** Resolve from exact physical siblings, never a provider ID or an arbitrary
 * occurrence. Unmapped companions and ambiguous editions remain protected. */
export function inspectInventorySidecar(file: string, root: string, siblings: string[]): SidecarDecision {
    file = path.resolve(file); root = path.resolve(root);
    const relative = path.relative(root, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error("Sidecar escaped its library root");
    }
    const extension = path.extname(file).toLowerCase(), stem = path.parse(file).name;
    const metadata = getConfigSection("metadata");
    const name = path.basename(file).toLowerCase();
    const lyric = isLyricSidecarExtension(extension);
    const image = new Set([".jpg", ".jpeg", ".png", ".webp"]).has(extension);
    const folderCover = image && new Set([
        metadata.album_cover_name || "cover.jpg", metadata.artist_picture_name || "folder.jpg",
    ].map(value => value.toLowerCase())).has(name);
    const folderNfo = extension === ".nfo" && ["album.nfo", "artist.nfo"].includes(name);
    if (!lyric && !image && !folderNfo) return { status: "not_sidecar" };
    for (let directory = path.dirname(file);; directory = path.dirname(directory)) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Sidecar ancestor is linked or unavailable");
        if (path.relative(root,directory) === "") break;
    }
    if (db.prepare(`SELECT 1 FROM TrackFiles WHERE file_path=?
        UNION ALL SELECT 1 FROM ExtraFiles WHERE file_path=?
        UNION ALL SELECT 1 FROM UnmappedFiles WHERE file_path=? LIMIT 1`).get(file,file,file)) {
        return { status: "owned" };
    }
    const artistAsset = name === "artist.nfo" || (image && name === (metadata.artist_picture_name || "folder.jpg").toLowerCase());
    const artistScope = artistAsset ? artistFolderScope(file,root) : undefined;
    if (artistScope && artistScope.status !== "identified") return artistScope;
    if (name === "artist.nfo" && !artistScope) return { status: "unresolved" };
    const candidates = siblings.map(value => path.resolve(value)).filter(value => value !== file
        && path.dirname(value) === path.dirname(file) && SUPPORTED_IMPORT_EXTENSIONS.has(path.extname(value).toLowerCase())
        && (folderCover || folderNfo || path.parse(value).name === stem));
    const review = db.prepare("SELECT 1 FROM UnmappedFiles WHERE file_path=?");
    if (!artistScope && candidates.some(candidate => review.get(candidate))) return { status: "review_sidecar" };
    const lookup = db.prepare(`SELECT f.id,f.library_id,f.library_slot,f.file_path,f.file_type,library.root_path,
        artist.mbid AS artist,album.mbid AS album,edition.mbid AS edition,
        track.mbid AS track,recording.mbid AS recording
        FROM TrackFiles f JOIN ArtistMetadata artist ON artist.id=f.artist_metadata_id
        JOIN Libraries library ON library.id=f.library_id
        LEFT JOIN AlbumEditions edition ON edition.id=f.album_edition_id
        LEFT JOIN Albums album ON album.id=edition.release_group_id
        LEFT JOIN Tracks track ON track.id=f.track_id
        LEFT JOIN Recordings recording ON recording.id=f.recording_id
        WHERE f.file_path=? AND (
          (f.file_type='track' AND f.release_group_id=album.id AND album.artist_mbid=artist.mbid
            AND track.album_edition_id=edition.id AND track.recording_id=recording.id)
          OR (f.file_type='video' AND recording.is_video=1
            AND (recording.artist_metadata_id IS NULL OR recording.artist_metadata_id=artist.id)
            AND (recording.artist_mbid IS NULL OR recording.artist_mbid=artist.mbid)
            AND (edition.id IS NULL OR (f.release_group_id=album.id AND album.artist_mbid=artist.mbid)))
        )`);
    const owners: Owner[] = [];
    for (const candidate of artistScope ? [] : candidates) {
        const owner = lookup.get(candidate) as Owner | undefined;
        if (!owner || path.relative(path.resolve(owner.root_path),root) !== "") return { status: "unresolved" };
        identity(candidate);
        owners.push(owner);
    }
    if (!artistScope && !owners.length) return { status: image && !folderCover ? "not_sidecar" : "unresolved" };
    const folderScoped = folderCover || folderNfo;
    if (folderScoped && owners.some(owner => !owner.album || !owner.edition)) return { status: "unresolved" };
    const keys = new Set(owners.map(owner => folderScoped
        ? JSON.stringify([owner.artist,owner.album,owner.edition,owner.library_slot]) : String(owner.id)));
    if (!artistScope && (keys.size !== 1 || (!folderScoped && (lyric ? owners[0].file_type !== "track" : owners[0].file_type !== "video")))) {
        return { status: "unresolved" };
    }
    const owner = owners[0];
    const libraryIds = artistScope?.libraryIds ?? [...new Set(owners.map(value => value.library_id))].sort((a,b) => a-b);
    const input: ExtraFileUpsertInput = artistScope?.input ?? {
        artistId: owner.artist, libraryId: owner.library_id, libraryRoot: root, filePath: file,
        fileType: lyric ? "lyrics" : folderNfo ? "nfo" : folderCover ? "cover" : "video_thumbnail",
        librarySlot: owner.library_slot, canonicalArtistMbid: owner.artist,
        canonicalReleaseGroupMbid: owner.album, canonicalReleaseMbid: owner.edition,
        trackFileId: folderScoped ? null : owner.id,
        canonicalTrackMbid: folderScoped ? null : owner.track,
        canonicalRecordingMbid: folderScoped ? null : owner.recording,
    };
    const existingMetadata = db.prepare("SELECT * FROM MetadataFiles WHERE file_path=?").get(file) as Record<string,unknown> | undefined;
    const existingLyric = db.prepare("SELECT * FROM LyricFiles WHERE file_path=?").get(file) as Record<string,unknown> | undefined;
    if (existingMetadata && existingLyric) return { status: "unresolved" };
    const existing = existingMetadata ? {table:"MetadataFiles" as const,row:existingMetadata}
        : existingLyric ? {table:"LyricFiles" as const,row:existingLyric} : undefined;
    if (existing) {
        const desired = ownershipFields(input);
        if ((existing.table === "LyricFiles") !== lyric || (existingMetadata && existingMetadata.file_type !== input.fileType)
            || Object.keys(desired).filter(key => key.startsWith("canonical_")).some(key =>
                existing.row[key] != null && existing.row[key] !== desired[key])
            || (existing.row.track_file_id != null && existing.row.track_file_id !== desired.track_file_id
                && (!folderScoped || !owners.some(value => value.id === existing.row.track_file_id)))) return { status: "unresolved" };
        const associated = ExtraFileService.libraryIds(existing.table,Number(existing.row.id));
        if (Object.keys(desired).every(key => existing.row[key] === desired[key])
            && libraryIds.every(id => associated.includes(id))) return { status: "owned" };
    }
    return { status: "identified", libraryIds, input, ...(existing ? {existing} : {}) };
}

function ownershipFields(input: ExtraFileUpsertInput): Record<string,string | number | null> {
    const base = ExtraFileService.buildBaseRecord(input);
    const result: Record<string,string | number | null> = {};
    for (const key of ["artist_id","track_file_id","library_slot","canonical_artist_mbid","canonical_release_group_mbid",
        "canonical_release_mbid","canonical_track_mbid","canonical_recording_mbid"] as const) result[key] = base[key];
    if (input.fileType !== "lyrics") result.type = getMetadataType(input);
    return result;
}

export async function reconcileInventorySidecar(file: string, root: string, siblings: string[]): Promise<boolean> {
    const before = inspectInventorySidecar(file,root,siblings);
    if (before.status !== "identified") return false;
    const witness = identity(file);
    const peerWitnesses = siblings.filter(value => path.dirname(value) === path.dirname(file)
        && SUPPORTED_IMPORT_EXTENSIONS.has(path.extname(value).toLowerCase())).map(value => [value,identity(value)]);
    return withSqliteWriteGate(() => db.transaction(() => {
        const admitted = inspectInventorySidecar(file,root,siblings);
        if (JSON.stringify(admitted) !== JSON.stringify(before) || identity(file) !== witness
            || peerWitnesses.some(([peer,stat]) => identity(peer) !== stat)) throw new Error("Sidecar ownership changed during inspection");
        if (admitted.status !== "identified") return false;
        const table = admitted.input.fileType === "lyrics" ? "LyricFiles" : "MetadataFiles";
        let id: number;
        if (admitted.existing) {
            const fields = ownershipFields(admitted.input);
            id = Number(admitted.existing.row.id);
            db.prepare(`UPDATE ${table} SET ${Object.keys(fields).map(key => `${key}=?`).join(",")},last_updated=CURRENT_TIMESTAMP WHERE id=?`)
                .run(...Object.values(fields),id);
        } else id = table === "LyricFiles" ? LyricFileService.upsert(admitted.input) : MetadataFileService.upsert(admitted.input);
        for (const libraryId of admitted.libraryIds) {
            ExtraFileService.associateLibraries(table,id,{...admitted.input,libraryId});
        }
        return true;
    })(), "scan:sidecar-ownership");
}
