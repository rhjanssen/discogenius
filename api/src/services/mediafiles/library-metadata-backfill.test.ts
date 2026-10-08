import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedTestLibrary } from "../../test-support/library-fixtures.js";
import { seedSelectedAcquisitionPlan } from "../../test-support/acquisition-plan-fixture.js";
import { execFileSync } from "node:child_process";
import * as jpeg from "jpeg-js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-metadata-backfill-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.metadata-backfill.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let libraryFilesModule: typeof import("./library-files.js");
let backfillModule: typeof import("./library-metadata-backfill.js");
let diskScanModule: typeof import("./library-scan.js");
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
    diskScanModule = await import("./library-scan.js");
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
                artist_metadata_id: "100",
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

test("disk scan metadata repair never rewrites embedded media metadata", async () => {
    const originalFill = backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles;
    let receivedOptions: import("./library-metadata-backfill.js").MetadataFillOptions | undefined;
    const progress: string[] = [];
    backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles = (async (_artistId, options) => {
        receivedOptions = options;
        return { downloaded: 0, failed: 0, skipped: 0 };
    }) as typeof originalFill;

    try {
        await diskScanModule.DiskScanService.fillMissingMetadataFiles("artist-mbid-100", (message) => progress.push(message));
    } finally {
        backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles = originalFill;
    }

    assert.equal(receivedOptions?.writeEmbeddedMediaMetadata, false);
    assert.equal(receivedOptions?.fetchMissingLyrics, false);
    assert.equal(receivedOptions?.repairMissingOnly, true);
    receivedOptions?.onProgress?.("checking lyrics (1/2)");
    assert.deepEqual(progress, ["checking lyrics (1/2)"]);
});

beforeEach(() => {
    for (const folder of ["music", "spatial", "videos", "media-cover"]) {
        fs.rmSync(path.join(tempDir, folder), { recursive: true, force: true });
    }
    // Release the deferred plan reference before the plan rows go.
    dbModule.db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
    for (const table of [
        "LyricFiles",
        "MetadataFiles",
        "ExtraFiles",
        "TrackFiles",
        "AcquisitionPlanTracks",
        "AcquisitionPlanSources",
        "AcquisitionPlans",
        "LibraryEditions",
        "LibraryAlbums",
        "Libraries",
        "ProviderTrackMatches",
        "ProviderEditionMatches",
        "ProviderEditionMembers",
        "ProviderItemAudioVariants",
        "ProviderItems",
        "Tracks",
        "AlbumEditions",
        "Albums",
        "Recordings",
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
        album_track_path_single: "{albumTitle}/{trackNumber00} - {trackTitle}",
        album_track_path_multi: "{albumTitle}/Disc {volumeNumber0}/{trackNumber00} - {trackTitle}",
        video_file: "{artistName} - {videoTitle} {{provider}-{mediaId}}",
    });
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedCanonicalLibraryFiles() {
    dbModule.db.prepare("INSERT INTO ArtistMetadata(mbid, name) VALUES(?, ?)")
        .run("artist-mbid-100", "The Example Artist");
    dbModule.db.prepare(`
        INSERT INTO Albums(mbid, artist_mbid, title, first_release_date, primary_type)
        VALUES(?, ?, ?, ?, ?)
    `).run("release-group-mbid-200", "artist-mbid-100", "Canonical Album", "2024-02-03", "Album");
    dbModule.db.prepare(`
        INSERT INTO AlbumEditions(mbid, release_group_mbid, artist_mbid, title, date, media_count, barcode)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("release-mbid-200", "release-group-mbid-200", "artist-mbid-100", "Canonical Album", "2024-02-03", 1, "123456789012");
    dbModule.db.prepare("INSERT INTO Recordings(mbid, artist_mbid, title, is_video, release_date) VALUES(?, ?, ?, ?, ?)")
        .run("recording-mbid-300", "artist-mbid-100", "Canonical Track", 0, "2024-02-03");
    dbModule.db.prepare(`
        INSERT INTO Tracks(mbid, release_mbid, recording_mbid, medium_position, position, title, length_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("track-mbid-300", "release-mbid-200", "recording-mbid-300", 1, 1, "Canonical Track", 180000);
    const artistMetadata = dbModule.db.prepare(`
        SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid-100'
    `).get() as { id: number };
    const releaseGroup = dbModule.db.prepare(`
        SELECT id FROM Albums WHERE mbid = 'release-group-mbid-200'
    `).get() as { id: number };
    const release = dbModule.db.prepare(`
        SELECT id FROM AlbumEditions WHERE mbid = 'release-mbid-200'
    `).get() as { id: number };
    const recording = dbModule.db.prepare(`
        SELECT id FROM Recordings WHERE mbid = 'recording-mbid-300'
    `).get() as { id: number };
    const canonicalTrack = dbModule.db.prepare(`
        SELECT id FROM Tracks WHERE mbid = 'track-mbid-300'
    `).get() as { id: number };
    dbModule.db.prepare(`
        UPDATE Albums SET artist_metadata_id = ? WHERE id = ?
    `).run(artistMetadata.id, releaseGroup.id);
    dbModule.db.prepare(`
        UPDATE AlbumEditions
        SET release_group_id = ?, artist_metadata_id = ?
        WHERE id = ?
    `).run(releaseGroup.id, artistMetadata.id, release.id);
    dbModule.db.prepare(`
        UPDATE Tracks SET album_edition_id = ?, recording_id = ? WHERE id = ?
    `).run(release.id, recording.id, canonicalTrack.id);
    dbModule.db.prepare(`
        INSERT OR IGNORE INTO MetadataProfiles (name, release_type_policy)
        VALUES ('Metadata Backfill Test', '{}')
    `).run();
    dbModule.db.prepare(`
        INSERT INTO Libraries (
          name, root_path, metadata_profile_id, quality_profile_id
        )
        SELECT
          'Metadata Backfill Stereo',
          ?,
          metadata_profile.id,
          quality_profile.id
        FROM MetadataProfiles metadata_profile
        JOIN quality_profiles quality_profile
          ON COALESCE(quality_profile.allowed_source_formats, '[]') NOT LIKE '%spatial%'
        WHERE metadata_profile.name = 'Metadata Backfill Test'
        ORDER BY quality_profile.id
        LIMIT 1
    `).run(configModule.Config.getMusicPath());
    const videoLibraryId = seedTestLibrary(dbModule.db, {
        name: "Metadata Backfill Video",
        rootPath: configModule.Config.getVideoPath(),
    });
    const library = dbModule.db.prepare(`
        SELECT id FROM Libraries WHERE name = 'Metadata Backfill Stereo'
    `).get() as { id: number };
    dbModule.db.prepare(`
        INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, reason, curation_version
    ) VALUES (?, ?, 'auto', 0, 'test', 1)
    `).run(library.id, releaseGroup.id);
    const libraryRelease = dbModule.db.prepare(`
        INSERT INTO LibraryEditions (
          library_id, edition_id, selection_mode, reason, curation_version
        ) VALUES (?, ?, 'auto', 'test', 1)
        RETURNING id
    `).get(library.id, release.id) as { id: number };
    dbModule.db.prepare(`
        INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
    `).run( "tidal", "release", "200", "Provider Album" );
    const providerRelease = dbModule.db.prepare(`
        SELECT id
        FROM ProviderItems
        WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = '200'
    `).get() as { id: number };
    const releaseMatch = dbModule.db.prepare(`
        INSERT INTO ProviderEditionMatches (
          provider_edition_item_id, edition_id, relation, match_state,
          decision_source, confidence, method, matcher_version
        ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
        RETURNING id
    `).get(providerRelease.id, release.id) as { id: number };
    const plan = seedSelectedAcquisitionPlan(dbModule.db, { libraryEditionId: libraryRelease.id, provider: 'tidal' }) as { id: number };
    dbModule.db.prepare(`
        INSERT INTO AcquisitionPlanSources (
          plan_id, provider_edition_match_id, role, sort_order
        ) VALUES (?, ?, 'primary', 0)
    `).run(plan.id, releaseMatch.id);
    dbModule.db.prepare(`
        INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
    `).run( "tidal", "track", "300", "Provider Track" );
    const musicRoot = configModule.Config.getMusicPath();
    const albumNfoPath = libraryFilesModule.LibraryFilesService.computeExpectedPath({
        id: -1,
        artist_metadata_id: artistMetadata.id,
        album_id: releaseGroup.id as unknown as number,
        media_id: null,
        file_path: "",
        relative_path: null,
        library_root: musicRoot,
        file_type: "nfo",
        extension: "nfo",
        canonical_artist_mbid: "artist-mbid-100",
        canonical_release_group_mbid: "release-group-mbid-200",
        canonical_release_mbid: "release-mbid-200",
    }).expectedPath;
    assert.ok(albumNfoPath);
    const albumDir = path.dirname(albumNfoPath);
    fs.mkdirSync(albumDir, { recursive: true });
    const trackPath = path.join(albumDir, "01 - Canonical Track.flac");
    fs.writeFileSync(trackPath, "audio");
    dbModule.db.prepare(`
        INSERT INTO TrackFiles (
          artist_metadata_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
          canonical_track_mbid, canonical_recording_mbid,
          release_group_id, album_edition_id, track_id, recording_id, library_id,
          provider, provider_entity_type, provider_id, library_slot,
          file_path, relative_path, library_root, filename, extension, file_type, quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        artistMetadata.id,
        "artist-mbid-100",
        "release-group-mbid-200",
        "release-mbid-200",
        "track-mbid-300",
        "recording-mbid-300",
        releaseGroup.id,
        release.id,
        canonicalTrack.id,
        recording.id,
        library.id,
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
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
    `).run( "tidal", "video", "400", "Provider Video" );
    const providerVideoItemId = Number((dbModule.db.prepare(`
        SELECT id FROM ProviderItems
        WHERE provider = 'tidal' AND entity_type = 'video' AND provider_id = '400'
    `).get() as { id: number }).id);
    dbModule.db.prepare(`
        INSERT INTO ProviderVideoMatches (
          provider_video_item_id, recording_id, match_state, decision_source,
          confidence, method, matcher_version
        ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
    `).run(providerVideoItemId, videoRecordingId);
    // The video's album identity derives from its related audio recording.
    dbModule.db.prepare(`
        INSERT INTO RecordingRelations (
          source_recording_id, target_recording_id, relation_type, confidence
        ) VALUES (?, ?, 'provider_video_for', 0.95)
    `).run(videoRecordingId, recording.id);

    const videoRoot = configModule.Config.getVideoPath();
    const videoDir = path.join(videoRoot, "The Example Artist");
    fs.mkdirSync(videoDir, { recursive: true });
    const videoPath = path.join(videoDir, "The Example Artist - Canonical Video {tidal-400}.mp4");
    fs.writeFileSync(videoPath, "video");
    dbModule.db.prepare(`
        INSERT INTO TrackFiles (
          artist_metadata_id, library_id, canonical_artist_mbid, canonical_recording_mbid,
          provider, provider_entity_type, provider_id, library_slot,
          file_path, relative_path, library_root, filename, extension, file_type, quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        artistMetadata.id,
        videoLibraryId,
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

    const progress: string[] = [];
    const result = await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("artist-mbid-100", {
        onProgress: (message) => progress.push(message),
    });

    assert.equal(result.failed, 0);
    assert.ok(result.downloaded >= 2);
    assert.ok(progress.some((message) => message.startsWith("checking album sidecars (")));
    assert.ok(progress.some((message) => message.startsWith("checking video thumbnails (")));
    assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
    assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);

    const albumNfo = dbModule.db.prepare(`
        SELECT canonical_release_group_mbid, canonical_release_mbid,
               canonical_track_mbid, canonical_recording_mbid,
               provider, provider_entity_type, provider_id, library_slot
        FROM MetadataFiles
        WHERE file_type = 'nfo'
          AND provider_entity_type = 'album'
          AND provider_id = '200'
        LIMIT 1
    `).get() as {
        canonical_release_group_mbid: string | null;
        canonical_release_mbid: string | null;
        canonical_track_mbid: string | null;
        canonical_recording_mbid: string | null;
        provider: string | null;
        provider_entity_type: string | null;
        provider_id: string | null;
        library_slot: string | null;
    } | undefined;
    assert.deepEqual(albumNfo, {
        canonical_release_group_mbid: "release-group-mbid-200",
        canonical_release_mbid: "release-mbid-200",
        canonical_track_mbid: null,
        canonical_recording_mbid: null,
        provider: "tidal",
        provider_entity_type: "album",
        provider_id: "200",
        library_slot: "stereo",
    });

    const videoNfo = dbModule.db.prepare(`
        SELECT canonical_release_group_mbid, canonical_release_mbid,
               canonical_track_mbid, canonical_recording_mbid,
               provider, provider_entity_type, provider_id, library_slot, track_file_id
        FROM MetadataFiles
        WHERE file_type = 'nfo'
          AND provider_entity_type = 'video'
          AND provider_id = '400'
        LIMIT 1
    `).get() as {
        canonical_release_group_mbid: string | null;
        canonical_release_mbid: string | null;
        canonical_track_mbid: string | null;
        canonical_recording_mbid: string | null;
        provider: string | null;
        provider_entity_type: string | null;
        provider_id: string | null;
        library_slot: string | null;
        track_file_id: number | null;
    } | undefined;
    assert.equal(videoNfo?.canonical_release_group_mbid, "release-group-mbid-200");
    assert.equal(videoNfo?.canonical_release_mbid, "release-mbid-200");
    assert.equal(videoNfo?.canonical_track_mbid, null);
    assert.equal(videoNfo?.canonical_recording_mbid, "video-recording-mbid-400");
    assert.equal(videoNfo?.provider, "tidal");
    assert.equal(videoNfo?.provider_entity_type, "video");
    assert.equal(videoNfo?.provider_id, "400");
    assert.equal(videoNfo?.library_slot, "video");
    assert.ok(videoNfo?.track_file_id);
});

test("metadata backfill records existing artist, album, and lyric sidecars", async () => {
    seedCanonicalLibraryFiles();

    configModule.updateConfig("metadata", {
        save_album_cover: true,
        save_artist_picture: true,
        save_video_thumbnail: false,
        save_lyrics: true,
        save_nfo: false,
    });

    const musicRoot = configModule.Config.getMusicPath();
    const track = dbModule.db.prepare(`
        SELECT id, file_path
        FROM TrackFiles
        WHERE provider_entity_type = 'track'
        LIMIT 1
    `).get() as { id: number; file_path: string };
    const artistDir = path.join(musicRoot, "The Example Artist");
    const albumDir = path.dirname(track.file_path);
    const artistPicPath = path.join(artistDir, "folder.jpg");
    const albumCoverPath = path.join(albumDir, "cover.jpg");
    const legacyLyricPath = track.file_path.replace(/\.flac$/i, ".lrc");
    const lyricPath = track.file_path.replace(/\.flac$/i, ".txt");
    const videoArtistPicPath = path.join(configModule.Config.getVideoPath(), "The Example Artist", "folder.jpg");

    fs.mkdirSync(artistDir, { recursive: true });
    fs.writeFileSync(artistPicPath, "artist image");
    fs.writeFileSync(videoArtistPicPath, "artist image");
    fs.writeFileSync(albumCoverPath, "album image");
    fs.writeFileSync(legacyLyricPath, "plain lyrics without timestamps");

    const progress: string[] = [];
    const result = await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("artist-mbid-100", {
        onProgress: (message) => progress.push(message),
    });

    assert.equal(result.failed, 0);
    assert.ok(result.skipped >= 3);
    assert.ok(progress.some((message) => message.startsWith("checking album sidecars (")));
    assert.ok(progress.some((message) => message.startsWith("checking lyrics (")));

    const artistImage = dbModule.db.prepare(`
        SELECT type, file_type, file_path, provider_entity_type, provider_id
        FROM MetadataFiles
        WHERE file_path = ?
    `).get(artistPicPath) as {
        type: string;
        file_type: string;
        file_path: string;
        provider_entity_type: string | null;
        provider_id: string | null;
    } | undefined;
    assert.deepEqual(artistImage, {
        type: "ArtistImage",
        file_type: "cover",
        file_path: artistPicPath,
        provider_entity_type: "artist",
        provider_id: null,
    });

    const albumImage = dbModule.db.prepare(`
        SELECT type, file_type, provider_entity_type, provider_id, library_slot
        FROM MetadataFiles
        WHERE file_path = ?
    `).get(albumCoverPath) as {
        type: string;
        file_type: string;
        provider_entity_type: string | null;
        provider_id: string | null;
        library_slot: string | null;
    } | undefined;
    assert.deepEqual(albumImage, {
        type: "AlbumImage",
        file_type: "cover",
        provider_entity_type: "album",
        provider_id: "200",
        library_slot: "stereo",
    });

    const lyric = dbModule.db.prepare(`
        SELECT canonical_track_mbid, canonical_recording_mbid, track_file_id, provider_entity_type, provider_id, library_slot
        FROM LyricFiles
        WHERE file_path = ?
    `).get(lyricPath) as {
        canonical_track_mbid: string | null;
        canonical_recording_mbid: string | null;
        track_file_id: number | null;
        provider_entity_type: string | null;
        provider_id: string | null;
        library_slot: string | null;
    } | undefined;
    assert.deepEqual(lyric, {
        canonical_track_mbid: "track-mbid-300",
        canonical_recording_mbid: "recording-mbid-300",
        track_file_id: track.id,
        provider_entity_type: "track",
        provider_id: "300",
        library_slot: "stereo",
    });
    assert.equal(fs.existsSync(legacyLyricPath), false);
    assert.equal(fs.readFileSync(lyricPath, "utf8"), "plain lyrics without timestamps");

    assert.equal(path.relative(musicRoot, artistPicPath).startsWith("The Example Artist"), true);
});

test("ordinary disk repair indexes existing lyrics without waiting for a missing provider lyric", async () => {
    seedCanonicalLibraryFiles();
    configModule.updateConfig("metadata", {
        save_album_cover: false, save_artist_picture: false, save_video_thumbnail: false,
        save_lyrics: true, save_nfo: false,
    });
    const provider = providersModule.streamingProviderManager.getStreamingProvider('tidal');
    const originalLyrics = provider.getLyrics;
    const originalCapability = provider.capabilities.lyrics;
    let requests = 0;
    provider.capabilities.lyrics = true;
    provider.getLyrics = async () => { requests++; return null; };
    try {
        await diskScanModule.DiskScanService.fillMissingMetadataFiles('artist-mbid-100');
        assert.equal(requests, 0, 'filesystem reconciliation must not perform optional lyric lookups');
        const track = dbModule.db.prepare("SELECT id, file_path FROM TrackFiles WHERE file_type = 'track' LIMIT 1")
            .get() as { id: number; file_path: string };
        const sidecar = track.file_path.replace(/\.flac$/i, '.lrc');
        fs.writeFileSync(sidecar, '[00:01.00]Existing local lyrics');
        await diskScanModule.DiskScanService.fillMissingMetadataFiles('artist-mbid-100');
        assert.equal(requests, 0);
        const row = dbModule.db.prepare('SELECT track_file_id FROM LyricFiles WHERE file_path = ?')
            .get(sidecar) as { track_file_id: number } | undefined;
        assert.equal(row?.track_file_id, track.id);
    } finally {
        provider.getLyrics = originalLyrics;
        provider.capabilities.lyrics = originalCapability;
    }
});

test("unchanged disk repair preserves sidecar contents and performs no sidecar database writes", async () => {
    seedCanonicalLibraryFiles();
    configModule.updateConfig("metadata", {
        save_album_cover: true, save_artist_picture: false, save_video_thumbnail: false,
        save_lyrics: true, save_nfo: true,
    });
    const track = dbModule.db.prepare("SELECT id, file_path FROM TrackFiles WHERE file_type = 'track' LIMIT 1")
        .get() as { id: number; file_path: string };
    const coverPath = path.join(path.dirname(track.file_path), "cover.jpg");
    const nfoPath = path.join(path.dirname(track.file_path), "album.nfo");
    const lyricPath = track.file_path.replace(/\.flac$/i, ".lrc");
    fs.writeFileSync(coverPath, "original full-resolution artwork");
    fs.writeFileSync(nfoPath, "existing external NFO content");
    fs.writeFileSync(lyricPath, "[00:01.00]Existing lyrics");
    await diskScanModule.DiskScanService.fillMissingMetadataFiles("artist-mbid-100");
    const paths = [coverPath, nfoPath, lyricPath];
    const before = paths.map(filePath => ({ bytes: fs.readFileSync(filePath), mtime: fs.statSync(filePath).mtimeMs }));
    const originalUpsert = libraryFilesModule.LibraryFilesService.upsertLibraryFile;
    let writes = 0;
    libraryFilesModule.LibraryFilesService.upsertLibraryFile = (...args) => {
        writes++;
        return originalUpsert.apply(libraryFilesModule.LibraryFilesService, args);
    };
    try {
        await diskScanModule.DiskScanService.fillMissingMetadataFiles("artist-mbid-100");
        assert.equal(writes, 0, "existing sidecars must not enter the writer gate for an unchanged scan");
        for (let i = 0; i < paths.length; i++) {
            assert.deepEqual(fs.readFileSync(paths[i]), before[i].bytes);
            assert.equal(fs.statSync(paths[i]).mtimeMs, before[i].mtime);
        }
        fs.unlinkSync(nfoPath);
        await diskScanModule.DiskScanService.fillMissingMetadataFiles("artist-mbid-100");
        assert.match(fs.readFileSync(nfoPath, "utf8"), /<title>Canonical Album<\/title>/);
        assert.deepEqual(fs.readFileSync(coverPath), before[0].bytes);
        assert.equal(fs.statSync(coverPath).mtimeMs, before[0].mtime);
    } finally {
        libraryFilesModule.LibraryFilesService.upsertLibraryFile = originalUpsert;
    }
    dbModule.db.prepare("UPDATE Albums SET title = 'Updated Canonical Album' WHERE mbid = 'release-group-mbid-200'").run();
    await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("artist-mbid-100", {
        fetchMissingLyrics: false, writeEmbeddedMediaMetadata: false,
    });
    assert.match(fs.readFileSync(nfoPath, "utf8"), /<title>Updated Canonical Album<\/title>/);
});

test("disk repair indexes provider-free lyrics and repairs a missing library association", async () => {
    seedCanonicalLibraryFiles();
    configModule.updateConfig("metadata", {
        save_album_cover: false, save_artist_picture: false, save_video_thumbnail: false,
        save_lyrics: true, save_nfo: false,
    });
    dbModule.db.prepare("UPDATE TrackFiles SET provider = NULL, provider_id = NULL WHERE file_type = 'track'").run();
    const track = dbModule.db.prepare("SELECT id, file_path, library_id FROM TrackFiles WHERE file_type = 'track' LIMIT 1")
        .get() as { id: number; file_path: string; library_id: number };
    const lyricPath = track.file_path.replace(/\.flac$/i, ".lrc");
    fs.writeFileSync(lyricPath, "[00:01.00]Local canonical-only lyrics");
    await diskScanModule.DiskScanService.fillMissingMetadataFiles("artist-mbid-100");
    const row = dbModule.db.prepare("SELECT id, track_file_id, provider_id FROM LyricFiles WHERE file_path = ?")
        .get(lyricPath) as { id: number; track_file_id: number; provider_id: string | null };
    assert.equal(row.track_file_id, track.id);
    assert.equal(row.provider_id, null);
    dbModule.db.prepare("DELETE FROM LyricFileLibraries WHERE lyric_file_id = ?").run(row.id);
    await diskScanModule.DiskScanService.fillMissingMetadataFiles("artist-mbid-100");
    assert.deepEqual(dbModule.db.prepare("SELECT library_id FROM LyricFileLibraries WHERE lyric_file_id = ?").all(row.id),
        [{ library_id: track.library_id }]);
});

test("canonical albums without any provider match still regenerate album.nfo", async () => {
    seedCanonicalLibraryFiles();
    dbModule.db.prepare("DELETE FROM AcquisitionPlanSources").run();
    dbModule.db.prepare("DELETE FROM ProviderItems").run();

    const result = await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("artist-mbid-100");
    const track = dbModule.db.prepare(`
        SELECT file_path FROM TrackFiles WHERE file_type = 'track' LIMIT 1
    `).get() as { file_path: string };
    const nfoPath = path.join(path.dirname(track.file_path), "album.nfo");
    assert.equal(result.failed, 0);
    assert.equal(fs.existsSync(nfoPath), true);
    const nfo = fs.readFileSync(nfoPath, "utf8");
    assert.match(nfo, /<title>Canonical Album<\/title>/);
    assert.match(nfo, /<musicbrainzreleasegroupid>release-group-mbid-200<\/musicbrainzreleasegroupid>/);
    assert.doesNotMatch(nfo, /tidalAlbum/);
});

test("metadata backfill writes album.nfo into each monitored edition folder", async () => {
    seedCanonicalLibraryFiles();
    const library = dbModule.db.prepare(`
        SELECT id FROM Libraries WHERE name = 'Metadata Backfill Stereo'
    `).get() as { id: number };
    const releaseGroup = dbModule.db.prepare(`
        SELECT id FROM Albums WHERE mbid = 'release-group-mbid-200'
    `).get() as { id: number };
    const deluxe = dbModule.db.prepare(`
        INSERT INTO AlbumEditions(mbid, release_group_id, release_group_mbid, artist_mbid, title, date, media_count)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        RETURNING id
    `).get("release-mbid-deluxe", releaseGroup.id, "release-group-mbid-200", "artist-mbid-100", "Canonical Album Deluxe", "2024-02-03", 1) as { id: number };
    dbModule.db.prepare(`
        INSERT INTO LibraryEditions (
          library_id, edition_id, selection_mode, reason, curation_version
        ) VALUES (?, ?, 'auto', 'test', 1)
    `).run(library.id, deluxe.id);

    const musicRoot = configModule.Config.getMusicPath();
    const deluxeDir = path.join(musicRoot, "The Example Artist", "Canonical Album Deluxe");
    fs.mkdirSync(deluxeDir, { recursive: true });
    const deluxeTrackPath = path.join(deluxeDir, "01 - Canonical Track.flac");
    fs.writeFileSync(deluxeTrackPath, "audio");
    const original = dbModule.db.prepare(`
        SELECT * FROM TrackFiles WHERE file_type = 'track' LIMIT 1
    `).get() as any;
    dbModule.db.prepare(`
        INSERT INTO TrackFiles (
          artist_metadata_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
          canonical_track_mbid, canonical_recording_mbid,
          release_group_id, album_edition_id, track_id, recording_id, library_id,
          provider, provider_entity_type, provider_id, library_slot,
          file_path, relative_path, library_root, filename, extension, file_type, quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        original.artist_metadata_id,
        original.canonical_artist_mbid,
        original.canonical_release_group_mbid,
        "release-mbid-deluxe",
        original.canonical_track_mbid,
        original.canonical_recording_mbid,
        original.release_group_id,
        deluxe.id,
        original.track_id,
        original.recording_id,
        original.library_id,
        original.provider,
        original.provider_entity_type,
        "301",
        original.library_slot,
        deluxeTrackPath,
        path.relative(musicRoot, deluxeTrackPath),
        musicRoot,
        path.basename(deluxeTrackPath),
        "flac",
        "track",
        "LOSSLESS",
    );

    const result = await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("artist-mbid-100");
    assert.equal(result.failed, 0);
    const originalNfo = path.join(path.dirname(original.file_path), "album.nfo");
    const deluxeNfo = path.join(deluxeDir, "album.nfo");
    assert.equal(fs.existsSync(originalNfo), true);
    assert.equal(fs.existsSync(deluxeNfo), true);
});

test("a stale tracked lyric row does not block adjacent-sidecar recovery", async () => {
    seedCanonicalLibraryFiles();
    configModule.updateConfig("metadata", {
        save_album_cover: false,
        save_artist_picture: false,
        save_video_thumbnail: false,
        save_lyrics: true,
        save_nfo: false,
    });
    const track = dbModule.db.prepare(`
        SELECT id, file_path, library_root, library_slot,
               canonical_artist_mbid, canonical_release_group_mbid,
               canonical_release_mbid, canonical_track_mbid,
               canonical_recording_mbid, provider, provider_id
        FROM TrackFiles
        WHERE file_type = 'track'
        LIMIT 1
    `).get() as any;
    const stalePath = path.join(path.dirname(track.file_path), "deleted-old-name.lrc");
    libraryFilesModule.LibraryFilesService.upsertLibraryFile({
        artistId: "artist-mbid-100",
        albumId: "200",
        mediaId: String(track.provider_id),
        trackFileId: track.id,
        filePath: stalePath,
        libraryRoot: track.library_root,
        fileType: "lyrics",
        expectedPath: stalePath,
        librarySlot: track.library_slot,
        provider: track.provider,
        providerEntityType: "track",
        providerId: String(track.provider_id),
        canonicalArtistMbid: track.canonical_artist_mbid,
        canonicalReleaseGroupMbid: track.canonical_release_group_mbid,
        canonicalReleaseMbid: track.canonical_release_mbid,
        canonicalTrackMbid: track.canonical_track_mbid,
        canonicalRecordingMbid: track.canonical_recording_mbid,
        removeFromUnmapped: false,
    });
    const recoveredPath = track.file_path.replace(/\.flac$/i, ".lrc");
    fs.writeFileSync(recoveredPath, "[00:01.00]Recovered lyric");

    await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("artist-mbid-100");
    const rows = dbModule.db.prepare(`
        SELECT file_path
        FROM LyricFiles
        WHERE canonical_recording_mbid = ?
        ORDER BY id
    `).all("recording-mbid-300") as Array<{ file_path: string }>;
    // Recovery claims the adjacent physical lyric without treating the old
    // identity as permission to delete another path. Missing-row pruning is a
    // separate, root-availability-checked maintenance phase.
    assert.deepEqual(rows, [{ file_path: stalePath }, { file_path: recoveredPath }]);
    await libraryFilesModule.LibraryFilesService.pruneStaleTrackedAssets();
    assert.deepEqual(dbModule.db.prepare(`SELECT file_path FROM LyricFiles
        WHERE canonical_recording_mbid = ? ORDER BY id`).all("recording-mbid-300"),[{file_path:recoveredPath}]);
    assert.equal(fs.readFileSync(recoveredPath,"utf8"),"[00:01.00]Recovered lyric");
    assert.equal(fs.existsSync(stalePath), false);
});




test("explicit artwork preference job replaces existing full-resolution sidecar and embedded FLAC art while scans preserve it", async () => {
    seedCanonicalLibraryFiles();
    configModule.updateConfig("metadata", {
        artwork_preference: "canonical", save_album_cover: true, save_artist_picture: false,
        save_video_thumbnail: false, embed_video_thumbnail: false, save_nfo: false, save_lyrics: false,
    });
    configModule.updateConfig("quality", { embed_cover: true });
    const track = dbModule.db.prepare("SELECT id,file_path FROM TrackFiles WHERE file_type='track' LIMIT 1").get() as { id: number; file_path: string };
    const cover = path.join(path.dirname(track.file_path), "cover.jpg");
    const old = Buffer.from(jpeg.encode({width:200,height:200,data:Buffer.alloc(200*200*4,80)},90).data);
    const selected = Buffer.from(jpeg.encode({width:800,height:600,data:Buffer.alloc(800*600*4,180)},95).data);
    fs.writeFileSync(cover,old);
    const { resolveFfmpegBinary } = await import("./audioUtils.js");
    const ffmpeg = resolveFfmpegBinary();
    execFileSync(ffmpeg,["-v","error","-y","-f","lavfi","-i","sine=frequency=440:duration=1","-c:a","flac",track.file_path],{windowsHide:true,timeout:30000});
    const pcm = () => execFileSync(ffmpeg,["-v","error","-i",track.file_path,"-map","0:a:0","-f","hash","-hash","SHA256","-"],{windowsHide:true,timeout:30000}).toString();
    const before = pcm();
    dbModule.db.prepare("UPDATE Albums SET images=? WHERE mbid='release-group-mbid-200'").run(JSON.stringify([{coverType:"Cover",url:"https://fixture.example/selected-cover.jpg"}]));
    await diskScanModule.DiskScanService.fillMissingMetadataFiles("artist-mbid-100");
    const owner = dbModule.db.prepare("SELECT id FROM MetadataFiles WHERE file_path=?").get(cover);
    assert.deepEqual(fs.readFileSync(cover),old);
    dbModule.db.exec(`INSERT INTO ArtistMetadata(mbid,name) VALUES('unmanaged-art','Catalog Only');
        INSERT INTO Albums(mbid,artist_mbid,title,images) VALUES('unmanaged-album','unmanaged-art','Catalog Only Album','[{"coverType":"Cover","url":"https://fixture.example/unmanaged.jpg"}]');`);
    const requests: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async input => {
        requests.push(String(input));
        return new Response(selected,{headers:{"content-type":"image/jpeg"}});
    };
    try {
        const { runConfigPruneMaintenance } = await import("../commands/scheduler-maintenance-handlers.js");
        await runConfigPruneMaintenance({id:1,name:"ConfigPrune",payload:{refreshArtworkPreference:true},status:"started",progress:0} as any,{updateCommandDescription:()=>{}});
        assert.equal(requests.some(url => url.includes("unmanaged.jpg")),false,"library artwork changes must not fetch the unrelated catalog");
        assert.deepEqual(fs.readFileSync(cover),selected,"selected source must replace an existing cover, not only fill missing files");
        assert.deepEqual(dbModule.db.prepare("SELECT id FROM MetadataFiles WHERE file_path=?").get(cover),owner);
        const { parseFile } = await import("music-metadata");
        const metadata = await parseFile(track.file_path);
        assert.deepEqual(Buffer.from(metadata.common.picture?.[0]?.data ?? []),selected,"embedded artwork must follow the full-resolution sidecar");
        assert.equal(pcm(),before,"artwork replacement must preserve decoded audio");
        const image = jpeg.decode(fs.readFileSync(cover));
        assert.equal(image.width,800); assert.equal(image.height,600);
        const settledAudio = fs.readFileSync(track.file_path);
        await runConfigPruneMaintenance({id:1,name:"ConfigPrune",payload:{refreshArtworkPreference:true},status:"started",progress:0} as any,{updateCommandDescription:()=>{}});
        assert.deepEqual(fs.readFileSync(cover),selected);
        assert.deepEqual(fs.readFileSync(track.file_path),settledAudio,"unchanged repeat must not rewrite the audio container");
    } finally { globalThis.fetch = previousFetch; }
});
