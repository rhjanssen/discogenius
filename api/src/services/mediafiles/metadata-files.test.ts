import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

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
    dbModule.db.prepare("DELETE FROM LyricFiles").run();
    dbModule.db.prepare("DELETE FROM MetadataFiles").run();
    dbModule.db.prepare("DELETE FROM ExtraFiles").run();
    dbModule.db.prepare("DELETE FROM TrackFiles").run();
    dbModule.db.prepare("DELETE FROM ProviderItems").run();
    dbModule.db.prepare("DELETE FROM RecordingRelations").run();
    dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
    dbModule.db.prepare("DELETE FROM Tracks").run();
    dbModule.db.prepare("DELETE FROM AlbumReleases").run();
    dbModule.db.prepare("DELETE FROM Albums").run();
    dbModule.db.prepare("DELETE FROM Recordings").run();
    dbModule.db.prepare("DELETE FROM Artists").run();
    dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedMusicBrainzMetadata() {
    dbModule.db.prepare(`
        INSERT INTO Artists(id, name, mbid, bio_text)
        VALUES(?, ?, ?, ?)
    `).run("100", "The Example Artist", "artist-mbid-100", "Artist bio & history");

    dbModule.db.prepare(`
        INSERT INTO ArtistMetadata(mbid, name)
        VALUES(?, ?)
    `).run("artist-mbid-100", "The Example Artist");
    dbModule.db.prepare(`
        INSERT INTO Albums(mbid, artist_mbid, title, first_release_date, primary_type, review_text)
        VALUES(?, ?, ?, ?, ?, ?)
    `).run("release-group-mbid-200", "artist-mbid-100", "Example Album", "2024-02-03", "Album", "Album review with <markup>");
    dbModule.db.prepare(`
        INSERT INTO AlbumReleases(mbid, release_group_mbid, artist_mbid, title, date, barcode, media_count, track_count)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    `).run("album-mbid-200", "release-group-mbid-200", "artist-mbid-100", "Example Album", "2024-02-03", "123456789012", 1, 1);
    dbModule.db.prepare(`
        INSERT INTO Recordings(mbid, artist_mbid, title, is_video, release_date)
        VALUES(?, ?, ?, ?, ?)
    `).run("recording-mbid-300", "artist-mbid-100", "Example Track", 0, "2024-02-03");
    dbModule.db.prepare(`
        INSERT INTO Tracks(mbid, release_mbid, recording_mbid, medium_position, position, title, length_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("track-mbid-300", "album-mbid-200", "recording-mbid-300", 1, 1, "Example Track", 180000);

    dbModule.db.prepare(`
        INSERT INTO ProviderItems(
            provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
            album_id, title, quality, upc, duration, release_date, library_slot, data
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "album",
        "200",
        "artist-mbid-100",
        "release-group-mbid-200",
        "album-mbid-200",
        "200",
        "Example Album",
        "LOSSLESS",
        "123456789012",
        180,
        "2024-02-03",
        "stereo",
        JSON.stringify({ num_tracks: 1, num_volumes: 1, num_videos: 1 }),
    );
    dbModule.db.prepare(`
        INSERT INTO ProviderItems(
            provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
            track_mbid, recording_mbid, album_id, title, quality, duration, library_slot
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "track",
        "300",
        "artist-mbid-100",
        "release-group-mbid-200",
        "album-mbid-200",
        "track-mbid-300",
        "recording-mbid-300",
        "200",
        "Example Track",
        "LOSSLESS",
        180,
        "stereo",
    );
    dbModule.db.prepare(`
        INSERT INTO Recordings(mbid, artist_mbid, title, is_video, release_date, length_ms)
        VALUES(?, ?, ?, ?, ?, ?)
    `).run("video-mbid-400", "artist-mbid-100", "Example Video", 1, "2024-02-03", 210000);
    const videoRecordingId = (dbModule.db.prepare("SELECT id FROM Recordings WHERE mbid = ?").get("video-mbid-400") as { id: number }).id;
    dbModule.db.prepare(`
        INSERT INTO ProviderItems(
            provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
            recording_mbid, recording_id, album_id, title, quality, duration, release_date, library_slot, data
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "video",
        "400",
        "artist-mbid-100",
        "release-group-mbid-200",
        "album-mbid-200",
        "video-mbid-400",
        videoRecordingId,
        "200",
        "Example Video",
        "MP4_1080P",
        210,
        "2024-02-03",
        "video",
        JSON.stringify({ artists: [{ name: "The Example Artist" }, { name: "Guest Artist" }] }),
    );
}

test("Jellyfin NFO files fall back to local metadata and include MusicBrainz IDs", async () => {
    seedMusicBrainzMetadata();

    const artistPath = path.join(tempDir, "artist.nfo");
    const albumPath = path.join(tempDir, "album.nfo");
    const videoPath = path.join(tempDir, "video.nfo");

    await metadataFilesModule.saveArtistNfoFile("100", artistPath);
    await metadataFilesModule.saveAlbumNfoFile("200", albumPath);
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
        INSERT INTO Artists(id, name, mbid)
        VALUES(?, ?, ?)
    `).run("100", "The Example Artist", "artist-mbid-100");

    dbModule.db.prepare(`
        INSERT INTO ArtistMetadata(mbid, name)
        VALUES(?, ?)
    `).run("artist-mbid-100", "The Example Artist");

    dbModule.db.prepare(`
        INSERT INTO Albums(mbid, artist_mbid, title, first_release_date, primary_type)
        VALUES(?, ?, ?, ?, ?)
    `).run("release-group-mbid-200", "artist-mbid-100", "Example Album", "2024-02-03", "Album");

    dbModule.db.prepare(`
        INSERT INTO AlbumReleases(mbid, release_group_mbid, artist_mbid, title, date, media_count, track_count)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("album-mbid-stereo", "release-group-mbid-200", "artist-mbid-100", "Example Album", "2024-02-03", 1, 1);

    dbModule.db.prepare(`
        INSERT INTO AlbumReleases(mbid, release_group_mbid, artist_mbid, title, date, media_count, track_count)
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

    dbModule.db.prepare(`
        INSERT INTO ProviderItems(
            provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
            track_mbid, recording_mbid, album_id, title, quality, duration, library_slot
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "track",
        "stereo-track",
        "artist-mbid-100",
        "release-group-mbid-200",
        "album-mbid-stereo",
        "track-stereo",
        "recording-stereo",
        "200",
        "Example Track",
        "LOSSLESS",
        180,
        "stereo",
    );

    dbModule.db.prepare(`
        INSERT INTO ProviderItems(
            provider, entity_type, provider_id, artist_mbid, release_group_mbid, release_mbid,
            track_mbid, recording_mbid, album_id, title, quality, duration, library_slot
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "tidal",
        "track",
        "spatial-track",
        "artist-mbid-100",
        "release-group-mbid-200",
        "album-mbid-spatial",
        "track-spatial",
        "recording-atmos",
        "201",
        "Example Track",
        "DOLBY_ATMOS",
        181,
        "spatial",
    );

    const stereoLyricsPath = path.join(tempDir, "stereo-track.lrc");
    fs.writeFileSync(stereoLyricsPath, "[00:01.00]plain lyric", "utf-8");

    dbModule.db.prepare(`
        INSERT INTO LyricFiles(
            artist_id, album_id, media_id,
            canonical_artist_mbid, canonical_release_group_mbid, canonical_recording_mbid,
            provider, provider_entity_type, provider_id, library_slot,
            file_path, relative_path, library_root, extension,
            quality, expected_path
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "100",
        "200",
        "stereo-track",
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

test("album NFO uses the selected canonical release for a composite provider slot", async () => {
    seedMusicBrainzMetadata();
    dbModule.db.prepare("UPDATE Albums SET title = ? WHERE mbid = ?")
      .run("Canonical Release Group Title", "release-group-mbid-200");
    dbModule.db.prepare("UPDATE AlbumReleases SET title = ? WHERE mbid = ?")
      .run("Edition-Specific Release Title", "album-mbid-200");

    dbModule.db.prepare(`
        INSERT INTO Recordings(mbid, title)
        VALUES(?, ?)
    `).run("recording-mbid-301", "Second Canonical Track");
    dbModule.db.prepare(`
        INSERT INTO Tracks(mbid, release_mbid, recording_mbid, medium_position, position, title, length_ms)
        VALUES(?, ?, ?, ?, ?, ?, ?)
    `).run("track-mbid-301", "album-mbid-200", "recording-mbid-301", 1, 2, "Second Canonical Track", 120000);
      dbModule.db.prepare(`
        INSERT INTO ReleaseGroupSlots(
          release_group_mbid, artist_mbid, slot, selected_provider, selected_provider_id, selected_release_mbid
        )
        VALUES(?, ?, ?, ?, ?, ?)
      `).run("release-group-mbid-200", "artist-mbid-100", "stereo", "tidal", "200;201", "album-mbid-200");

    const albumPath = path.join(tempDir, "composite-album.nfo");
    await metadataFilesModule.saveAlbumNfoFile("200", albumPath);
    const albumNfo = fs.readFileSync(albumPath, "utf-8");

    assert.match(albumNfo, /<uniqueid type="tidalAlbum" default="false">200<\/uniqueid>/);
    assert.match(albumNfo, /<uniqueid type="tidalAlbum" default="false">201<\/uniqueid>/);
    assert.match(albumNfo, /<title>Canonical Release Group Title<\/title>/);
    assert.doesNotMatch(albumNfo, /Edition-Specific Release Title/);
    assert.match(albumNfo, /<position>2<\/position>/);
    assert.match(albumNfo, /<uniqueid type="MusicBrainzTrack" default="false">track-mbid-301<\/uniqueid>/);
});
