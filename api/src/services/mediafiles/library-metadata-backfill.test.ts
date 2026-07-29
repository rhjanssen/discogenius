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
    for (const folder of ["music", "spatial", "videos", "media-cover"]) {
        fs.rmSync(path.join(tempDir, folder), { recursive: true, force: true });
    }
    for (const table of [
        "LyricFiles",
        "MetadataFiles",
        "ExtraFiles",
        "TrackFiles",
        "AcquisitionPlanTracks",
        "AcquisitionPlanSources",
        "AcquisitionPlans",
        "LibraryReleases",
        "LibraryReleaseGroups",
        "Libraries",
        "ProviderTrackMatches",
        "ProviderReleaseMatches",
        "ProviderReleaseMembers",
        "ProviderItemAudioVariants",
        "ProviderItems",
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
    const artistMetadata = dbModule.db.prepare(`
        SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid-100'
    `).get() as { id: number };
    const releaseGroup = dbModule.db.prepare(`
        SELECT id FROM Albums WHERE mbid = 'release-group-mbid-200'
    `).get() as { id: number };
    const release = dbModule.db.prepare(`
        SELECT id FROM AlbumReleases WHERE mbid = 'release-mbid-200'
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
        UPDATE AlbumReleases
        SET release_group_id = ?, artist_metadata_id = ?
        WHERE id = ?
    `).run(releaseGroup.id, artistMetadata.id, release.id);
    dbModule.db.prepare(`
        UPDATE Tracks SET album_release_id = ?, recording_id = ? WHERE id = ?
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
    const library = dbModule.db.prepare(`
        SELECT id FROM Libraries WHERE name = 'Metadata Backfill Stereo'
    `).get() as { id: number };
    dbModule.db.prepare(`
        INSERT INTO LibraryReleaseGroups (
          library_id, release_group_id, monitored, selection_mode, locked,
          reason, curation_version
        ) VALUES (?, ?, 1, 'auto', 0, 'test', 1)
    `).run(library.id, releaseGroup.id);
    const libraryRelease = dbModule.db.prepare(`
        INSERT INTO LibraryReleases (
          library_id, release_id, selection_mode, locked, reason, curation_version
        ) VALUES (?, ?, 'auto', 0, 'test', 1)
        RETURNING id
    `).get(library.id, release.id) as { id: number };
    dbModule.db.prepare(`
        INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES (?, ?, ?, ?)
    `).run( "tidal", "album", "200", "Provider Album" );
    const providerRelease = dbModule.db.prepare(`
        SELECT id
        FROM ProviderItems
        WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = '200'
    `).get() as { id: number };
    const releaseMatch = dbModule.db.prepare(`
        INSERT INTO ProviderReleaseMatches (
          provider_release_item_id, release_id, relation, match_state,
          decision_source, confidence, method, matcher_version
        ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
        RETURNING id
    `).get(providerRelease.id, release.id) as { id: number };
    const plan = dbModule.db.prepare(`
        INSERT INTO AcquisitionPlans (
          library_release_id, provider, composition, download_mode, state,
          planner_version, policy_hash, computed_at
        ) VALUES (?, 'tidal', 'single_source', 'album', 'current', 1, 'test', CURRENT_TIMESTAMP)
        RETURNING id
    `).get(libraryRelease.id) as { id: number };
    dbModule.db.prepare(`
        INSERT INTO AcquisitionPlanSources (
          plan_id, provider_release_match_id, role, sort_order
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
          artist_id, canonical_artist_mbid, canonical_release_group_mbid, canonical_release_mbid,
          canonical_track_mbid, canonical_recording_mbid,
          release_group_id, album_release_id, track_id, recording_id, library_id,
          provider, provider_entity_type, provider_id, library_slot,
          file_path, relative_path, library_root, filename, extension, file_type, quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "100",
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

    const videoRoot = configModule.Config.getVideoPath();
    const videoDir = path.join(videoRoot, "The Example Artist");
    fs.mkdirSync(videoDir, { recursive: true });
    const videoPath = path.join(videoDir, "The Example Artist - Canonical Video {tidal-400}.mp4");
    fs.writeFileSync(videoPath, "video");
    dbModule.db.prepare(`
        INSERT INTO TrackFiles (
          artist_id, canonical_artist_mbid, canonical_recording_mbid,
          provider, provider_entity_type, provider_id, library_slot,
          file_path, relative_path, library_root, filename, extension, file_type, quality
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    const artistDir = path.dirname(path.dirname(track.file_path));
    const albumDir = path.dirname(track.file_path);
    const artistPicPath = path.join(artistDir, "folder.jpg");
    const albumCoverPath = path.join(albumDir, "cover.jpg");
    const legacyLyricPath = track.file_path.replace(/\.flac$/i, ".lrc");
    const lyricPath = track.file_path.replace(/\.flac$/i, ".txt");
    const videoArtistPicPath = path.join(configModule.Config.getVideoPath(), "The Example Artist", "folder.jpg");

    fs.writeFileSync(artistPicPath, "artist image");
    fs.writeFileSync(videoArtistPicPath, "artist image");
    fs.writeFileSync(albumCoverPath, "album image");
    fs.writeFileSync(legacyLyricPath, "plain lyrics without timestamps");

    const result = await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("100");

    assert.equal(result.failed, 0);
    assert.ok(result.skipped >= 3);

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

test("canonical albums without any provider match still regenerate album.nfo", async () => {
    seedCanonicalLibraryFiles();
    dbModule.db.prepare("DELETE FROM AcquisitionPlanSources").run();
    dbModule.db.prepare("DELETE FROM ProviderItems").run();

    const result = await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("100");
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
        artistId: "100",
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

    await backfillModule.libraryMetadataBackfillService.fillMissingMetadataFiles("100");
    const rows = dbModule.db.prepare(`
        SELECT file_path
        FROM LyricFiles
        WHERE canonical_recording_mbid = ?
        ORDER BY id
    `).all("recording-mbid-300") as Array<{ file_path: string }>;
    assert.deepEqual(rows, [{ file_path: recoveredPath }]);
    assert.equal(fs.existsSync(stalePath), false);
});



