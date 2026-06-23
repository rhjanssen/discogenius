import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-metadata-backfill-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.metadata-backfill.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let libraryFilesModule: typeof import("./library-files.js");
let backfillModule: typeof import("./library-metadata-backfill.js");
let providersModule: typeof import("../providers/index.js");

const providerCapabilities = {
    catalogSearch: false,
    artistCatalog: false,
    followedArtists: false,
    audioPreviews: false,
    audioDownloads: false,
    lossyStereo: false,
    losslessStereo: false,
    hiResStereo: false,
    spatialAudio: false,
    lyrics: false,
    musicVideos: false,
    videoPreviews: false,
    videoDownloads: false,
    artwork: false,
    editorialMetadata: true,
    providerIds: true,
};

before(async () => {
    dbModule = await import("../../database.js");
    configModule = await import("../config/config.js");
    libraryFilesModule = await import("./library-files.js");
    backfillModule = await import("./library-metadata-backfill.js");
    providersModule = await import("../providers/index.js");
    dbModule.initDatabase();
    providersModule.streamingProviderManager.registerStreamingProvider({
        id: "tidal",
        name: "TIDAL Test",
        capabilities: providerCapabilities,
        async search() {
            return { artists: [], albums: [], tracks: [], videos: [] };
        },
        async getArtist(id: string | number) {
            return { providerId: String(id), name: "The Example Artist" };
        },
        async getArtistAlbums() {
            return [];
        },
        async getAlbum(id: string | number) {
            return {
                providerId: String(id),
                title: "Provider Album",
                artist: { providerId: "100", name: "The Example Artist" },
                artists: [{ providerId: "100", name: "The Example Artist" }],
                releaseDate: "2024-02-03",
                trackCount: 1,
                volumeCount: 1,
                quality: "LOSSLESS",
                upc: "123456789012",
            };
        },
        async getAlbumTracks() {
            return [];
        },
        async getTrack(id: string | number) {
            return {
                providerId: String(id),
                title: "Provider Track",
                artist: { providerId: "100", name: "The Example Artist" },
                album: {
                    providerId: "200",
                    title: "Provider Album",
                    artist: { providerId: "100", name: "The Example Artist" },
                },
                duration: 180,
                trackNumber: 1,
            };
        },
        async getVideo(id: string | number) {
            return {
                providerId: String(id),
                title: "Provider Video",
                artist: { providerId: "100", name: "The Example Artist" },
                artists: [{ providerId: "100", name: "The Example Artist" }],
                artist_id: "100",
                artist_name: "The Example Artist",
                album_id: "200",
                release_date: "2024-02-03",
                duration: 210,
            } as any;
        },
        async getArtistBio() {
            return "Artist bio";
        },
        async getAlbumReview() {
            return null;
        },
        async getAuthStatus() {
            return {
                connected: true,
                tokenExpired: false,
                refreshTokenExpired: false,
                hoursUntilExpiry: 1,
                canAccessShell: true,
                canAccessLocalLibrary: true,
                remoteCatalogAvailable: true,
                canAuthenticate: true,
            };
        },
    } as any);
});

beforeEach(() => {
    for (const table of [
        "LyricFiles",
        "MetadataFiles",
        "ExtraFiles",
        "TrackFiles",
        "ProviderItems",
        "ReleaseGroupSlots",
        "Tracks",
        "AlbumReleases",
        "Albums",
        "Recordings",
        "Artists",
        "ArtistMetadata",
    ]) {
        dbModule.db.prepare(`DELETE FROM ${table}`).run();
    }

    configModule.updateConfig("metadata", {
        save_album_cover: false,
        save_artist_picture: false,
        save_video_thumbnail: false,
        save_lyrics: false,
        save_nfo: true,
        write_audio_tags_policy: "no",
    });
    configModule.updateConfig("path", {
        music_path: path.join(tempDir, "music"),
        spatial_path: path.join(tempDir, "spatial"),
        video_path: path.join(tempDir, "videos"),
        video_folder_layout: "separated",
    });
    configModule.updateConfig("naming", {
        artist_folder: "{artistName}",
        album_track_path_single: "{Album CleanTitle}/{track:00} - {Track CleanTitle}",
        album_track_path_multi: "{Album CleanTitle}/{medium:0}{track:00} - {Track CleanTitle}",
        video_file: "{Artist CleanName} - {Video CleanTitle} {{providerName}-{mediaId}}",
    });
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedCanonicalLibraryFiles() {
    dbModule.db.prepare("INSERT INTO ArtistMetadata(mbid, name) VALUES(?, ?)")
        .run("artist-mbid-100", "The Example Artist");
    dbModule.db.prepare("INSERT INTO Artists(id, name, mbid, monitored) VALUES(?, ?, ?, ?)")
        .run("100", "The Example Artist", "artist-mbid-100", 1);
    dbModule.db.prepare(`
        INSERT INTO Albums(mbid, artist_mbid, title, first_release_date, primary_type)
        VALUES(?, ?, ?, ?, ?)
    `).run("release-group-mbid-200", "artist-mbid-100", "Canonical Album", "2024-02-03", "Album");
    dbModule.db.prepare(`
        INSERT INTO AlbumReleases(mbid, release_group_mbid, artist_mbid, title, date, media_count, barcode)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("release-mbid-200", "release-group-mbid-200", "artist-mbid-100", "Canonical Album", "2024-02-03", 1, "123456789012");
    dbModule.db.prepare("INSERT INTO Recordings(mbid, artist_mbid, title, is_video, release_date) VALUES(?, ?, ?, ?, ?)")
        .run("recording-mbid-300", "artist-mbid-100", "Canonical Track", 0, "2024-02-03");
    dbModule.db.prepare(`
        INSERT INTO Tracks(mbid, release_mbid, recording_mbid, medium_position, position, title, length_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("track-mbid-300", "release-mbid-200", "recording-mbid-300", 1, 1, "Canonical Track", 180000);
    dbModule.db.prepare(`
        INSERT INTO ProviderItems (
          provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
          album_id, title, quality, library_slot, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "album",
        "200",
        "artist-mbid-100",
        "release-group-mbid-200",
        "release-mbid-200",
        "200",
        "Provider Album",
        "LOSSLESS",
        "stereo",
        JSON.stringify({ video_cover: "album-video-cover-id" }),
    );
    dbModule.db.prepare(`
        INSERT INTO ProviderItems (
          provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
          track_mbid, recording_mbid, album_id, title, quality, library_slot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "track",
        "300",
        "artist-mbid-100",
        "release-group-mbid-200",
        "release-mbid-200",
        "track-mbid-300",
        "recording-mbid-300",
        "200",
        "Provider Track",
        "LOSSLESS",
        "stereo",
    );
    dbModule.db.prepare(`
        INSERT INTO ReleaseGroupSlots(
          artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id, selected_release_mbid
        ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("artist-mbid-100", "release-group-mbid-200", "stereo", 1, "tidal", "200", "release-mbid-200");

    const musicRoot = configModule.Config.getMusicPath();
    const albumNfoPath = libraryFilesModule.LibraryFilesService.computeExpectedPath({
        id: -1,
        artist_id: "100" as unknown as number,
        album_id: "200" as unknown as number,
        media_id: null,
        file_path: "",
        relative_path: null,
        library_root: musicRoot,
        file_type: "nfo",
        extension: "nfo",
    }).expectedPath;
    assert.ok(albumNfoPath);
    const albumDir = path.dirname(albumNfoPath);
    fs.mkdirSync(albumDir, { recursive: true });
    const trackPath = path.join(albumDir, "01 - Canonical Track.flac");
    fs.writeFileSync(trackPath, "audio");
    dbModule.db.prepare(`
        INSERT INTO TrackFiles (
          artist_id, album_id, media_id,
          canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
          canonical_track_mbid, canonical_recording_mbid,
          provider, provider_entity_type, provider_id, library_slot,
          file_path, relative_path, library_root, filename, extension, file_type, quality
        ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "100",
        "artist-mbid-100",
        "release-group-mbid-200",
        "release-mbid-200",
        "track-mbid-300",
        "recording-mbid-300",
        "tidal",
        "track",
        "300",
        "stereo",
        trackPath,
        path.relative(musicRoot, trackPath),
        musicRoot,
        path.basename(trackPath),
        "flac",
        "track",
        "LOSSLESS",
    );

    dbModule.db.prepare("INSERT INTO Recordings(mbid, artist_mbid, title, is_video, release_date) VALUES(?, ?, ?, ?, ?)")
        .run("video-recording-mbid-400", "artist-mbid-100", "Canonical Video", 1, "2024-02-03");
    const videoRecordingId = Number((dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
        .get("video-recording-mbid-400") as { id: number }).id);
    dbModule.db.prepare(`
        INSERT INTO ProviderItems (
          provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
          recording_mbid, recording_id, album_id, title, quality, library_slot, data
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "video",
        "400",
        "artist-mbid-100",
        "release-group-mbid-200",
        "release-mbid-200",
        "video-recording-mbid-400",
        videoRecordingId,
        "200",
        "Provider Video",
        "MP4_1080P",
        "video",
        JSON.stringify({ copyright: "Provider copyright" }),
    );

    const videoRoot = configModule.Config.getVideoPath();
    const videoDir = path.join(videoRoot, "The Example Artist");
    fs.mkdirSync(videoDir, { recursive: true });
    const videoPath = path.join(videoDir, "The Example Artist - Canonical Video {tidal-400}.mp4");
    fs.writeFileSync(videoPath, "video");
    dbModule.db.prepare(`
        INSERT INTO TrackFiles (
          artist_id, album_id, media_id,
          canonical_artist_mbid, canonical_recording_mbid,
          provider, provider_entity_type, provider_id, library_slot,
          file_path, relative_path, library_root, filename, extension, file_type, quality
        ) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "100",
        "artist-mbid-100",
        "video-recording-mbid-400",
        "tidal",
        "video",
        "400",
        "video",
        videoPath,
        path.relative(videoRoot, videoPath),
        videoRoot,
        path.basename(videoPath),
        "mp4",
        "video",
        "MP4_1080P",
    );
}

test("metadata backfill discovers album and video sidecars from canonical ProviderItems without legacy provider rows", async () => {
    seedCanonicalLibraryFiles();

    const result = await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("100");

    assert.equal(result.failed, 0);
    assert.ok(result.downloaded >= 2);
    assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
    assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);

    const albumNfo = dbModule.db.prepare(`
        SELECT album_id, media_id, provider, provider_entity_type, provider_id, library_slot
        FROM MetadataFiles
        WHERE file_type = 'nfo'
          AND provider_entity_type = 'album'
          AND provider_id = '200'
        LIMIT 1
    `).get() as {
        album_id: string | null;
        media_id: string | null;
        provider: string | null;
        provider_entity_type: string | null;
        provider_id: string | null;
        library_slot: string | null;
    } | undefined;
    assert.deepEqual(albumNfo, {
        album_id: "200",
        media_id: null,
        provider: "tidal",
        provider_entity_type: "album",
        provider_id: "200",
        library_slot: "stereo",
    });

    const videoNfo = dbModule.db.prepare(`
        SELECT album_id, media_id, provider, provider_entity_type, provider_id, library_slot, track_file_id
        FROM MetadataFiles
        WHERE file_type = 'nfo'
          AND provider_entity_type = 'video'
          AND provider_id = '400'
        LIMIT 1
    `).get() as {
        album_id: string | null;
        media_id: string | null;
        provider: string | null;
        provider_entity_type: string | null;
        provider_id: string | null;
        library_slot: string | null;
        track_file_id: number | null;
    } | undefined;
    assert.equal(videoNfo?.album_id, "200");
    assert.equal(videoNfo?.media_id, "400");
    assert.equal(videoNfo?.provider, "tidal");
    assert.equal(videoNfo?.provider_entity_type, "video");
    assert.equal(videoNfo?.provider_id, "400");
    assert.equal(videoNfo?.library_slot, "video");
    assert.ok(videoNfo?.track_file_id);
});
