import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedAcceptedProviderTrackMatch } from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-metadata-files-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.metadata-files.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let metadataFilesModule: typeof import("./metadata-files.js");

before(async () => {
    dbModule = await import("../../database.js");
    metadataFilesModule = await import("./metadata-files.js");
    dbModule.initDatabase();
});

beforeEach(() => {
    fs.rmSync(path.join(tempDir, "media-cover"), { recursive: true, force: true });
    fs.rmSync(path.join(tempDir, "video-thumbnail-tests"), { recursive: true, force: true });
    dbModule.db.prepare("DELETE FROM LyricFiles").run();
    dbModule.db.prepare("DELETE FROM MetadataFiles").run();
    dbModule.db.prepare("DELETE FROM ExtraFiles").run();
    dbModule.db.prepare("DELETE FROM TrackFiles").run();
    dbModule.db.prepare("DELETE FROM ProviderItems").run();
    dbModule.db.prepare("DELETE FROM RecordingRelations").run();
    dbModule.db.prepare("DELETE FROM Tracks").run();
    dbModule.db.prepare("DELETE FROM AlbumEditions").run();
    dbModule.db.prepare("DELETE FROM Albums").run();
    dbModule.db.prepare("DELETE FROM LibraryArtists").run();
    dbModule.db.prepare("DELETE FROM Recordings").run();
    dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedMusicBrainzMetadata() {
    dbModule.db.prepare(`
        INSERT INTO ArtistMetadata (id, mbid, name) VALUES (?, ?, ?)`).run(100, "artist-mbid-100", "The Example Artist");

dbModule.db.prepare(`
        INSERT INTO Albums(mbid, artist_mbid, title, first_release_date, primary_type, review_text, genres)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("release-group-mbid-200", "artist-mbid-100", "Example Album", "2024-02-03", "Album", "Album review with <markup>", JSON.stringify(["Indie Pop", "Synth-pop"]));
    dbModule.db.prepare(`
        INSERT INTO AlbumEditions(mbid, release_group_mbid, artist_mbid, title, date, barcode, media_count, track_count, label)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("album-mbid-200", "release-group-mbid-200", "artist-mbid-100", "Example Album", "2024-02-03", "123456789012", 1, 1, JSON.stringify(["Virgin Records"]));
    dbModule.db.prepare(`
        INSERT INTO Recordings(mbid, artist_mbid, title, is_video, release_date, isrcs)
        VALUES(?, ?, ?, ?, ?, ?)
    `).run("recording-mbid-300", "artist-mbid-100", "Example Track", 0, "2024-02-03", JSON.stringify(["GBUM72300001"]));
    dbModule.db.prepare(`
        INSERT INTO Tracks(mbid, release_mbid, recording_mbid, medium_position, position, title, length_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("track-mbid-300", "album-mbid-200", "recording-mbid-300", 1, 1, "Example Track", 180000);

      // Release + track offers linked to the canonical release/track through the
      // typed match authority (ProviderEditionMembers + accepted Provider*Matches).
      seedAcceptedProviderTrackMatch(dbModule.db, {
          provider: "tidal",
          providerEditionId: "200",
          providerTrackId: "300",
          releaseMbid: "album-mbid-200",
          trackMbid: "track-mbid-300",
      });
      dbModule.db.prepare(`
          UPDATE ProviderItems
          SET upc = '123456789012', duration_ms = 180, release_date = '2024-02-03',
              title = 'Example Album'
          WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = '200'
      `).run();
      dbModule.db.prepare(`
          UPDATE ProviderItems
          SET duration_ms = 180, title = 'Example Track'
          WHERE provider = 'tidal' AND entity_type = 'track' AND provider_id = '300'
      `).run();
      dbModule.db.prepare(`
          INSERT INTO Recordings(mbid, artist_mbid, title, is_video, release_date, length_ms, credits)
          VALUES(?, ?, ?, ?, ?, ?, ?)
      `).run("video-mbid-400", "artist-mbid-100", "Example Video", 1, "2024-02-03", 210000, JSON.stringify([{ name: "The Example Artist" }, { name: "Guest Artist" }]));
    const videoRecordingId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?").get("video-mbid-400") as { id: number }).id;
      const videoItem = dbModule.db.prepare(`
          INSERT INTO ProviderItems(
      provider, entity_type, provider_id, title, duration_ms, release_date
    ) VALUES (?, ?, ?, ?, ?, ?)
    RETURNING id
      `).get( "tidal", "video", "400", "Example Video", 210, "2024-02-03" ) as { id: number };
    dbModule.db.prepare(`
        INSERT INTO ProviderVideoMatches (
          provider_video_item_id, recording_id, match_state, decision_source,
          confidence, method, matcher_version
        ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
    `).run(videoItem.id, videoRecordingId);
    // The video's album identity is derived from its related audio recording.
    const audioRecordingId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
        .get("recording-mbid-300") as { id: number }).id;
    dbModule.db.prepare(`
        INSERT INTO RecordingRelations (
          source_recording_id, target_recording_id, relation_type, confidence
        ) VALUES (?, ?, 'provider_video_for', 0.95)
    `).run(videoRecordingId, audioRecordingId);
}

test("Jellyfin NFO files use canonical local metadata and include MusicBrainz IDs", async () => {
    seedMusicBrainzMetadata();

    const artistPath = path.join(tempDir, "artist.nfo");
    const albumPath = path.join(tempDir, "album.nfo");
    const videoPath = path.join(tempDir, "video.nfo");

    await metadataFilesModule.saveArtistNfoFile("100", artistPath);
    await metadataFilesModule.saveAlbumNfoFile("release-group-mbid-200", albumPath, {
        releaseGroupMbid: "release-group-mbid-200",
        releaseMbid: "album-mbid-200",
        provider: "tidal",
        providerAlbumId: "200",
    });
    await metadataFilesModule.saveVideoNfoFile("400", videoPath);

    const artistNfo = fs.readFileSync(artistPath, "utf-8");
    assert.match(artistNfo, /<artist>/);
    assert.match(artistNfo, /<musicbrainzartistid>artist-mbid-100<\/musicbrainzartistid>/);
    assert.match(artistNfo, /<uniqueid type="MusicBrainzArtist" default="true">artist-mbid-100<\/uniqueid>/);

    const albumNfo = fs.readFileSync(albumPath, "utf-8");
    assert.match(albumNfo, /<album>/);
    assert.match(albumNfo, /<musicbrainzalbumid>album-mbid-200<\/musicbrainzalbumid>/);
    assert.match(albumNfo, /<musicbrainzreleasegroupid>release-group-mbid-200<\/musicbrainzreleasegroupid>/);
    assert.match(albumNfo, /<musicbrainzalbumartistid>artist-mbid-100<\/musicbrainzalbumartistid>/);
    assert.match(albumNfo, /<uniqueid type="MusicBrainzTrack" default="false">track-mbid-300<\/uniqueid>/);
    assert.match(albumNfo, /<uniqueid type="MusicBrainzRecording" default="false">recording-mbid-300<\/uniqueid>/);
    assert.match(albumNfo, /Album review with &lt;markup&gt;/);
    assert.match(albumNfo, /<genre>Indie Pop<\/genre>/);
    assert.match(albumNfo, /<genre>Synth-pop<\/genre>/);
    assert.match(albumNfo, /<label>Virgin Records<\/label>/);
    assert.match(albumNfo, /<upc>123456789012<\/upc>/);
    assert.match(albumNfo, /<isrc>GBUM72300001<\/isrc>/);
    assert.match(albumNfo, /<duration>03:00<\/duration>/);

    const videoNfo = fs.readFileSync(videoPath, "utf-8");
    assert.match(videoNfo, /<musicvideo>/);
    assert.match(videoNfo, /<musicbrainzartistid>artist-mbid-100<\/musicbrainzartistid>/);
    assert.match(videoNfo, /<musicbrainzalbumid>album-mbid-200<\/musicbrainzalbumid>/);
    assert.match(videoNfo, /<uniqueid type="tidalVideo" default="true">400<\/uniqueid>/);
    assert.match(videoNfo, /<artist>The Example Artist<\/artist>/);
    assert.match(videoNfo, /<artist>Guest Artist<\/artist>/);
    assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
    assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);
});

test("lyrics cached for a stereo provider item are shared with a spatial counterpart", async () => {
    dbModule.db.prepare(`
        INSERT INTO ArtistMetadata (id, mbid, name) VALUES (?, ?, ?)`).run(100, "artist-mbid-100", "The Example Artist");

dbModule.db.prepare(`
        INSERT INTO Albums(mbid, artist_mbid, title, first_release_date, primary_type)
        VALUES(?, ?, ?, ?, ?)
    `).run("release-group-mbid-200", "artist-mbid-100", "Example Album", "2024-02-03", "Album");

    dbModule.db.prepare(`
        INSERT INTO AlbumEditions(mbid, release_group_mbid, artist_mbid, title, date, media_count, track_count)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("album-mbid-stereo", "release-group-mbid-200", "artist-mbid-100", "Example Album", "2024-02-03", 1, 1);

    dbModule.db.prepare(`
        INSERT INTO AlbumEditions(mbid, release_group_mbid, artist_mbid, title, date, media_count, track_count)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("album-mbid-spatial", "release-group-mbid-200", "artist-mbid-100", "Example Album", "2024-02-03", 1, 1);

    dbModule.db.prepare(`
        INSERT INTO Recordings(mbid, artist_mbid, title, length_ms)
        VALUES(?, ?, ?, ?)
    `).run("recording-stereo", "artist-mbid-100", "Example Track", 180000);

    dbModule.db.prepare(`
        INSERT INTO Recordings(mbid, artist_mbid, title, length_ms)
        VALUES(?, ?, ?, ?)
    `).run("recording-atmos", "artist-mbid-100", "Example Track", 181000);

    dbModule.db.prepare(`
        INSERT INTO Tracks(mbid, release_mbid, recording_mbid, medium_position, position, title, length_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("track-stereo", "album-mbid-stereo", "recording-stereo", 1, 1, "Example Track", 180000);

    dbModule.db.prepare(`
        INSERT INTO Tracks(mbid, release_mbid, recording_mbid, medium_position, position, title, length_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("track-spatial", "album-mbid-spatial", "recording-atmos", 1, 1, "Example Track", 181000);

    // Each offer reaches its canonical recording through the typed match chain,
    // and its stereo/spatial rendition through the normalized audio-variant
    // boundary (quality is no longer a ProviderItems scalar).
    const stereoIds = seedAcceptedProviderTrackMatch(dbModule.db, {
        provider: "tidal",
        providerEditionId: "stereo-release",
        providerTrackId: "stereo-track",
        releaseMbid: "album-mbid-stereo",
        trackMbid: "track-stereo",
    });
    const spatialIds = seedAcceptedProviderTrackMatch(dbModule.db, {
        provider: "tidal",
        providerEditionId: "spatial-release",
        providerTrackId: "spatial-track",
        releaseMbid: "album-mbid-spatial",
        trackMbid: "track-spatial",
    });
    dbModule.db.prepare(`
        UPDATE ProviderItems SET duration_ms = 180000
        WHERE id = ?
    `).run(stereoIds.providerTrackItemId);
    dbModule.db.prepare(`
        UPDATE ProviderItems SET duration_ms = 181000
        WHERE id = ?
    `).run(spatialIds.providerTrackItemId);
    dbModule.db.prepare(`
        INSERT INTO ProviderItemAudioVariants (
          provider_item_id, variant_key, quality_class, provider_quality_label, availability
        ) VALUES (?, 'lossless', 'lossless', 'LOSSLESS', 'available')
    `).run(stereoIds.providerTrackItemId);
    dbModule.db.prepare(`
        INSERT INTO ProviderItemAudioVariants (
          provider_item_id, variant_key, quality_class, provider_quality_label, availability
        ) VALUES (?, 'atmos', 'spatial', 'DOLBY_ATMOS', 'available')
    `).run(spatialIds.providerTrackItemId);
    const artistMetaId = (dbModule.db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'artist-mbid-100'")
        .get() as { id: number }).id;
    dbModule.db.prepare("UPDATE Albums SET artist_metadata_id = ? WHERE mbid = 'release-group-mbid-200'")
        .run(artistMetaId);
    dbModule.db.prepare("UPDATE Recordings SET artist_metadata_id = ? WHERE mbid IN ('recording-stereo', 'recording-atmos')")
        .run(artistMetaId);

    const stereoLyricsPath = path.join(tempDir, "stereo-track.lrc");
    fs.writeFileSync(stereoLyricsPath, "[00:01.00]plain lyric", "utf-8");

    dbModule.db.prepare(`
        INSERT INTO LyricFiles(
            artist_id,
            canonical_artist_mbid, canonical_release_group_mbid, canonical_recording_mbid,
            provider, provider_entity_type, provider_id, library_slot,
            file_path, relative_path, library_root, extension,
            quality, expected_path
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "100",
        "artist-mbid-100",
        "release-group-mbid-200",
        "recording-stereo",
        "tidal",
        "track",
        "stereo-track",
        "stereo",
        stereoLyricsPath,
        path.basename(stereoLyricsPath),
        tempDir,
        "lrc",
        "LOSSLESS",
        stereoLyricsPath,
    );

    assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderAlbums'").get(), undefined);
    assert.equal(dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ProviderMedia'").get(), undefined);

    const lyrics = await metadataFilesModule.getTrackLyrics("spatial-track");
    assert.equal(lyrics?.subtitles, "[00:01.00]plain lyric");
    assert.equal(lyrics?.matchType, "shared_from_related_recording");

    const linked = dbModule.db.prepare(`
        SELECT relation_type, source_foreign_recording_id, target_foreign_recording_id
        FROM RecordingRelations
        WHERE relation_type = 'same_lyrical_content'
          AND source_foreign_recording_id = 'recording-stereo'
          AND target_foreign_recording_id = 'recording-atmos'
        LIMIT 1
    `).get() as { relation_type?: string; source_foreign_recording_id?: string; target_foreign_recording_id?: string } | undefined;

    assert.equal(linked?.relation_type, "same_lyrical_content");
    assert.equal(linked?.source_foreign_recording_id, "recording-stereo");
    assert.equal(linked?.target_foreign_recording_id, "recording-atmos");
});

test("lyrics fall back across providers for the same canonical recording", async () => {
    seedMusicBrainzMetadata();
    // Apple offer for the SAME canonical recording as the tidal one seeded above,
    // so the lyric lookup can fall back across providers through typed matches.
    seedAcceptedProviderTrackMatch(dbModule.db, {
        provider: "apple-music",
        providerEditionId: "apple-release-200",
        providerTrackId: "apple-track-300",
        releaseMbid: "album-mbid-200",
        trackMbid: "track-mbid-300",
    });

    const providersModule = await import("../providers/index.js");
    const tidal = providersModule.streamingProviderManager.getStreamingProvider("tidal") as any;
    const originalGetLyrics = tidal.getLyrics;
    const requested: string[] = [];
    tidal.getLyrics = async (trackId: string) => {
        requested.push(String(trackId));
        return {
            text: "Provider-neutral plain lyric",
            subtitles: "[00:03.00]Provider-neutral synced lyric",
            provider: "TIDAL fixture",
        };
    };

    try {
        const lyrics = await metadataFilesModule.getTrackLyrics("apple-track-300", "apple-music");
        assert.equal(lyrics?.subtitles, "[00:03.00]Provider-neutral synced lyric");
        assert.equal(lyrics?.provider, "tidal");
        assert.equal(lyrics?.matchType, "shared_from_related_recording");
        assert.deepEqual(requested, ["300"]);
    } finally {
        tidal.getLyrics = originalGetLyrics;
    }
});

test("lyrics lookup scopes equal provider track IDs to the requested provider", async () => {
    seedMusicBrainzMetadata();
    dbModule.db.prepare(`
        INSERT INTO Recordings(mbid, artist_mbid, title, length_ms)
        VALUES('apple-recording-300', 'artist-mbid-100', 'Apple Collision Track', 181000)
    `).run();
    dbModule.db.prepare(`
        INSERT INTO ProviderItems(
      provider, entity_type, provider_id, title, duration_ms
    ) VALUES ('apple-music', 'track', '300', 'Apple Collision Track', 181)
    `).run();

    const appleLyricsPath = path.join(tempDir, "apple-collision.lrc");
    fs.writeFileSync(appleLyricsPath, "[00:02.00]apple provider lyric", "utf-8");
    dbModule.db.prepare(`
        INSERT INTO LyricFiles(
            artist_id, canonical_artist_mbid, canonical_release_group_mbid,
            canonical_recording_mbid, provider, provider_entity_type, provider_id,
            library_slot, file_path, relative_path, library_root, extension,
            quality, expected_path
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "100",
        "artist-mbid-100",
        "release-group-mbid-200",
        "apple-recording-300",
        "apple-music",
        "track",
        "300",
        "stereo",
        appleLyricsPath,
        path.basename(appleLyricsPath),
        tempDir,
        "lrc",
        "HIRES_LOSSLESS",
        appleLyricsPath,
    );

    const lyrics = await metadataFilesModule.getTrackLyrics("300", "apple-music");
    assert.equal(lyrics?.subtitles, "[00:02.00]apple provider lyric");
    assert.equal(lyrics?.provider, "apple-music");
});

test("timestamp-free legacy lrc content is reused as plain lyrics", async () => {
    seedMusicBrainzMetadata();
    const legacyPath = path.join(tempDir, "legacy-plain.lrc");
    fs.writeFileSync(legacyPath, "Plain lyric without timestamps", "utf8");
    dbModule.db.prepare(`
        INSERT INTO LyricFiles(
            artist_id, canonical_artist_mbid, canonical_release_group_mbid,
            canonical_recording_mbid, provider, provider_entity_type, provider_id,
            library_slot, file_path, relative_path, library_root, extension,
            quality, expected_path
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "100",
        "artist-mbid-100",
        "release-group-mbid-200",
        "recording-mbid-300",
        "tidal",
        "track",
        "300",
        "stereo",
        legacyPath,
        path.basename(legacyPath),
        tempDir,
        "lrc",
        "LOSSLESS",
        legacyPath,
    );

    const lyrics = await metadataFilesModule.getTrackLyrics("300", "tidal");
    assert.equal(lyrics?.text, "Plain lyric without timestamps");
    assert.equal(lyrics?.subtitles, "");
});

test("saveLyricsFile chooses txt for plain lyrics and lrc for valid timestamps", async () => {
    seedMusicBrainzMetadata();
    const providersModule = await import("../providers/index.js");
    const tidal = providersModule.streamingProviderManager.getStreamingProvider("tidal") as any;
    const originalGetLyrics = tidal.getLyrics;
    const requestedPath = path.join(tempDir, "semantic-lyrics.lrc");

    try {
        tidal.getLyrics = async () => ({
            text: "Plain provider lyric",
            subtitles: "",
            provider: "TIDAL fixture",
        });
        const plainPath = await metadataFilesModule.saveLyricsFile("300", requestedPath, "tidal");
        assert.equal(plainPath, path.join(tempDir, "semantic-lyrics.txt"));
        assert.equal(fs.existsSync(requestedPath), false);
        assert.equal(fs.readFileSync(plainPath, "utf8"), "Plain provider lyric\n");

        tidal.getLyrics = async () => ({
            text: "Plain provider lyric",
            subtitles: "[00:01.20]Synchronized provider lyric",
            provider: "TIDAL fixture",
        });
        const synchronizedPath = await metadataFilesModule.saveLyricsFile("300", requestedPath, "tidal");
        assert.equal(synchronizedPath, requestedPath);
        assert.equal(fs.readFileSync(synchronizedPath, "utf8"), "[00:01.20]Synchronized provider lyric\n");
    } finally {
        tidal.getLyrics = originalGetLyrics;
    }
});

test("album NFO uses the selected canonical release and one exact provider release", async () => {
    seedMusicBrainzMetadata();
    dbModule.db.prepare("UPDATE Albums SET title = ? WHERE mbid = ?")
      .run("Canonical Release Group Title", "release-group-mbid-200");
    dbModule.db.prepare("UPDATE AlbumEditions SET title = ? WHERE mbid = ?")
      .run("Edition-Specific Release Title", "album-mbid-200");

    dbModule.db.prepare(`
        INSERT INTO Recordings(mbid, title)
        VALUES(?, ?)
    `).run("recording-mbid-301", "Second Canonical Track");
    dbModule.db.prepare(`
        INSERT INTO Tracks(mbid, release_mbid, recording_mbid, medium_position, position, title, length_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("track-mbid-301", "album-mbid-200", "recording-mbid-301", 1, 2, "Second Canonical Track", 120000);
    const albumPath = path.join(tempDir, "composite-album.nfo");
    await metadataFilesModule.saveAlbumNfoFile("release-group-mbid-200", albumPath, {
        releaseGroupMbid: "release-group-mbid-200",
        releaseMbid: "album-mbid-200",
        librarySlot: "stereo",
        provider: "tidal",
        providerAlbumId: "200",
    });
    const albumNfo = fs.readFileSync(albumPath, "utf-8");

    assert.match(albumNfo, /<uniqueid type="tidalAlbum" default="false">200<\/uniqueid>/);
    assert.doesNotMatch(albumNfo, /<uniqueid type="tidalAlbum" default="false">201<\/uniqueid>/);
    assert.match(albumNfo, /<title>Canonical Release Group Title<\/title>/);
    assert.doesNotMatch(albumNfo, /Edition-Specific Release Title/);
    assert.match(albumNfo, /<position>2<\/position>/);
    assert.match(albumNfo, /<uniqueid type="MusicBrainzTrack" default="false">track-mbid-301<\/uniqueid>/);
});

test("a cold static video thumbnail sidecar performs no provider or network access", async () => {
    seedMusicBrainzMetadata();
    const providerModule = await import("../providers/index.js");
    const manager = providerModule.streamingProviderManager as any;
    const originalGetStreamingProvider = manager.getStreamingProvider;
    const originalGetDefaultStreamingProvider = manager.getDefaultStreamingProvider;
    const originalGetDefaultProviderId = manager.getDefaultProviderId;
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    let fetchCalls = 0;
    manager.getStreamingProvider = () => {
        providerCalls += 1;
        throw new Error("provider access is forbidden for sidecar sync");
    };
    manager.getDefaultStreamingProvider = () => {
        providerCalls += 1;
        throw new Error("provider access is forbidden for sidecar sync");
    };
    manager.getDefaultProviderId = () => {
        providerCalls += 1;
        throw new Error("provider access is forbidden for sidecar sync");
    };
    globalThis.fetch = (async () => {
        fetchCalls += 1;
        throw new Error("network access is forbidden for sidecar sync");
    }) as typeof fetch;

    const outputPath = path.join(tempDir, "video-thumbnail-tests", "cold.jpg");
    try {
        const result = await metadataFilesModule.downloadVideoThumbnail(
            "remote-cover-id",
            "origin",
            outputPath,
            { provider: "tidal", providerId: "400" },
        );
        assert.equal(result, "missing");
        assert.equal(fs.existsSync(outputPath), false);
        assert.equal(providerCalls, 0);
        assert.equal(fetchCalls, 0);
    } finally {
        manager.getStreamingProvider = originalGetStreamingProvider;
        manager.getDefaultStreamingProvider = originalGetDefaultStreamingProvider;
        manager.getDefaultProviderId = originalGetDefaultProviderId;
        globalThis.fetch = originalFetch;
    }
});

test("static video thumbnail sidecars copy the canonical recording's cached origin", async () => {
    seedMusicBrainzMetadata();
    const recording = dbModule.db.prepare(`
      SELECT id FROM Recordings WHERE mbid = ?
    `).get("video-mbid-400") as { id: number };
    const cachedOrigin = path.join(
        tempDir,
        "media-cover",
        "Videos",
        String(recording.id),
        "cover.png",
    );
    const outputPath = path.join(tempDir, "video-thumbnail-tests", "cached.jpg");
    const expected = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    fs.mkdirSync(path.dirname(cachedOrigin), { recursive: true });
    fs.writeFileSync(cachedOrigin, expected);

    assert.equal(
        await metadataFilesModule.downloadVideoThumbnail(
            "remote-cover-id",
            "1080x720",
            outputPath,
            { provider: "tidal", providerId: "400" },
        ),
        "written",
    );
    assert.deepEqual(fs.readFileSync(outputPath), expected);
    assert.equal(
        await metadataFilesModule.downloadVideoThumbnail(
            "remote-cover-id",
            "origin",
            outputPath,
            { provider: "tidal", providerId: "400" },
        ),
        "unchanged",
    );
});

test("Bad Blood NFO cannot cross providers when Apple and TIDAL IDs collide", async () => {
    seedMusicBrainzMetadata();
    dbModule.db.prepare("UPDATE Albums SET title = ? WHERE mbid = ?")
        .run("Bad Blood", "release-group-mbid-200");
    dbModule.db.prepare(`
        INSERT INTO ProviderItems(
      provider, entity_type, provider_id, title
    ) VALUES (?, 'release', ?, ?)
    `).run( "apple-music", "1705033078", "Pompeii MMXXIII" );
    dbModule.db.prepare(`
        INSERT INTO ProviderItems(
      provider, entity_type, provider_id, title
    ) VALUES (?, 'release', ?, ?)
    `).run( "apple-music", "1710633308", "Bad Blood X (10th Anniversary Edition)" );
    dbModule.db.prepare(`
        INSERT INTO ProviderItems(
      provider, entity_type, provider_id, title
    ) VALUES (?, 'release', ?, ?)
    `).run( "tidal", "1705033078", "Wrong TIDAL Collision" );
    const nfoPath = path.join(tempDir, "bad-blood.nfo");
    await metadataFilesModule.saveAlbumNfoFile("release-group-mbid-200", nfoPath, {
        releaseGroupMbid: "release-group-mbid-200",
        releaseMbid: "album-mbid-200",
        librarySlot: "stereo",
        provider: "apple-music",
        providerAlbumId: "1705033078",
    });
    const nfo = fs.readFileSync(nfoPath, "utf8");
    assert.match(nfo, /<title>Bad Blood<\/title>/);
    assert.match(nfo, /<uniqueid type="apple-musicAlbum" default="false">1705033078<\/uniqueid>/);
    assert.doesNotMatch(nfo, /<uniqueid type="apple-musicAlbum" default="false">1710633308<\/uniqueid>/);
    assert.doesNotMatch(nfo, /tidalAlbum[^>]*>1705033078/);
    assert.doesNotMatch(nfo, /Wrong TIDAL Collision|Pompeii MMXXIII/);
});

test("downloadAlbumVideoCover resolves artwork through the requested provider", async () => {
    const { streamingProviderManager } = await import("../providers/index.js");
    const outputPath = path.join(tempDir, "animated-cover.mp4");
    const calls: Array<Record<string, unknown>> = [];
    const originalGet = streamingProviderManager.getStreamingProvider.bind(streamingProviderManager);
    const originalDefault = streamingProviderManager.getDefaultStreamingProvider.bind(streamingProviderManager);

    streamingProviderManager.getStreamingProvider = ((id: string) => {
        assert.equal(id, "apple-music");
        return {
            id: "apple-music",
            name: "Apple Music",
            capabilities: {} as any,
            async getArtworkUrl(request: Record<string, unknown>) {
                calls.push(request);
                return "https://example.test/apple-motion.mp4";
            },
        } as any;
    }) as typeof streamingProviderManager.getStreamingProvider;

    streamingProviderManager.getDefaultStreamingProvider = (() => {
        throw new Error("default provider must not be used when provider is explicit");
    }) as typeof streamingProviderManager.getDefaultStreamingProvider;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
        ok: true,
        statusText: "OK",
        async arrayBuffer() {
            return new Uint8Array([0, 0, 0, 0]).buffer;
        },
    })) as unknown as typeof fetch;

    try {
        await metadataFilesModule.downloadAlbumVideoCover(
            "https://example.test/apple-motion.mp4",
            "origin",
            outputPath,
            { provider: "apple-music", providerAlbumId: "1440904699" },
        );
        assert.equal(calls.length, 1);
        assert.equal(calls[0].entityType, "albumVideoCover");
        assert.equal(calls[0].imageId, "https://example.test/apple-motion.mp4");
        assert.equal(calls[0].providerId, "1440904699");
        assert.equal(fs.existsSync(outputPath), true);
    } finally {
        streamingProviderManager.getStreamingProvider = originalGet;
        streamingProviderManager.getDefaultStreamingProvider = originalDefault;
        globalThis.fetch = originalFetch;
        try {
            fs.unlinkSync(outputPath);
        } catch {
            // ignore
        }
    }
});
