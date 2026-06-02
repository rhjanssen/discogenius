import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-metadata-files-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.metadata-files.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let metadataFilesModule: typeof import("./metadata-files.js");

before(async () => {
    dbModule = await import("../database.js");
    metadataFilesModule = await import("./metadata-files.js");
    dbModule.initDatabase();
});

beforeEach(() => {
    dbModule.db.prepare("DELETE FROM LyricFiles").run();
    dbModule.db.prepare("DELETE FROM MetadataFiles").run();
    dbModule.db.prepare("DELETE FROM ExtraFiles").run();
    dbModule.db.prepare("DELETE FROM TrackFiles").run();
    dbModule.db.prepare("DELETE FROM RecordingRelations").run();
    dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
    dbModule.db.prepare("DELETE FROM Tracks").run();
    dbModule.db.prepare("DELETE FROM AlbumReleases").run();
    dbModule.db.prepare("DELETE FROM Albums").run();
    dbModule.db.prepare("DELETE FROM Recordings").run();
    dbModule.db.prepare("DELETE FROM ProviderMedia").run();
    dbModule.db.prepare("DELETE FROM ProviderAlbums").run();
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
        INSERT INTO ProviderAlbums(
            id, artist_id, title, release_date, type, explicit, quality,
            num_tracks, num_volumes, num_videos, duration, review_text,
            upc, mbid, mb_release_group_id
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "200",
        "100",
        "Example Album",
        "2024-02-03",
        "ALBUM",
        0,
        "LOSSLESS",
        1,
        1,
        1,
        180,
        "Album review with <markup>",
        "123456789012",
        "album-mbid-200",
        "release-group-mbid-200",
    );

    dbModule.db.prepare(`
        INSERT INTO ProviderMedia(
            id, artist_id, album_id, title, release_date, type, explicit,
            quality, track_number, volume_number, duration, mbid
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "300",
        "100",
        "200",
        "Example Track",
        "2024-02-03",
        "TRACK",
        0,
        "LOSSLESS",
        1,
        1,
        180,
        "recording-mbid-300",
    );

    dbModule.db.prepare(`
        INSERT INTO ArtistMetadata(mbid, name)
        VALUES(?, ?)
    `).run("artist-mbid-100", "The Example Artist");
    dbModule.db.prepare(`
        INSERT INTO Albums(mbid, artist_mbid, title)
        VALUES(?, ?, ?)
    `).run("release-group-mbid-200", "artist-mbid-100", "Example Album");
    dbModule.db.prepare(`
        INSERT INTO AlbumReleases(mbid, release_group_mbid, artist_mbid, title)
        VALUES(?, ?, ?, ?)
    `).run("album-mbid-200", "release-group-mbid-200", "artist-mbid-100", "Example Album");
    dbModule.db.prepare(`
        INSERT INTO Recordings(mbid, title)
        VALUES(?, ?)
    `).run("recording-mbid-300", "Example Track");
    dbModule.db.prepare(`
        INSERT INTO Tracks(mbid, release_mbid, recording_mbid, medium_position, position, title)
        VALUES(?, ?, ?, ?, ?, ?)
    `).run("track-mbid-300", "album-mbid-200", "recording-mbid-300", 1, 1, "Example Track");

    dbModule.db.prepare(`
        INSERT INTO ProviderMedia(
            id, artist_id, album_id, title, release_date, type, explicit,
            quality, track_number, volume_number, duration, credits
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "400",
        "100",
        "200",
        "Example Video",
        "2024-02-03",
        "Music Video",
        0,
        "MP4_1080P",
        null,
        null,
        210,
        JSON.stringify([{ name: "The Example Artist" }, { name: "Guest Artist" }]),
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
});

test("lyrics cached for a stereo provider item are shared with a spatial counterpart", async () => {
    dbModule.db.prepare(`
        INSERT INTO Artists(id, name, mbid)
        VALUES(?, ?, ?)
    `).run("100", "The Example Artist", "artist-mbid-100");

    dbModule.db.prepare(`
        INSERT INTO ProviderAlbums(
            id, artist_id, title, release_date, type, explicit, quality,
            num_tracks, num_volumes, num_videos, duration, mb_release_group_id
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("200", "100", "Example Album", "2024-02-03", "ALBUM", 0, "LOSSLESS", 1, 1, 0, 180, "release-group-mbid-200");

    dbModule.db.prepare(`
        INSERT INTO ProviderAlbums(
            id, artist_id, title, release_date, type, explicit, quality,
            num_tracks, num_volumes, num_videos, duration, mb_release_group_id
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("201", "100", "Example Album", "2024-02-03", "ALBUM", 0, "DOLBY_ATMOS", 1, 1, 0, 180, "release-group-mbid-200");

    dbModule.db.prepare(`
        INSERT INTO ProviderMedia(
            id, artist_id, album_id, title, release_date, type, explicit,
            quality, track_number, volume_number, duration, mbid
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("stereo-track", "100", "200", "Example Track", "2024-02-03", "TRACK", 0, "LOSSLESS", 1, 1, 180, "recording-stereo");

    dbModule.db.prepare(`
        INSERT INTO ProviderMedia(
            id, artist_id, album_id, title, release_date, type, explicit,
            quality, track_number, volume_number, duration, mbid
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("spatial-track", "100", "201", "Example Track", "2024-02-03", "TRACK", 0, "DOLBY_ATMOS", 1, 1, 181, "recording-atmos");

    const stereoLyricsPath = path.join(tempDir, "stereo-track.lrc");
    fs.writeFileSync(stereoLyricsPath, "[00:01.00]plain lyric", "utf-8");

    dbModule.db.prepare(`
        INSERT INTO LyricFiles(
            ArtistId, AlbumId, MediaId,
            CanonicalArtistMbid, CanonicalReleaseGroupMbid, CanonicalRecordingMbid,
            Provider, ProviderEntityType, ProviderId, LibrarySlot,
            FilePath, RelativePath, LibraryRoot, Extension,
            Quality, ExpectedPath
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

    const lyrics = await metadataFilesModule.getTrackLyrics("spatial-track");
    assert.equal(lyrics?.subtitles, "[00:01.00]plain lyric");
    assert.equal(lyrics?.matchType, "shared_from_related_recording");

    const linked = dbModule.db.prepare(`
        SELECT RelationType, SourceForeignRecordingId, TargetForeignRecordingId
        FROM RecordingRelations
        WHERE RelationType = 'same_lyrical_content'
          AND SourceForeignRecordingId = 'recording-stereo'
          AND TargetForeignRecordingId = 'recording-atmos'
        LIMIT 1
    `).get() as { RelationType?: string; SourceForeignRecordingId?: string; TargetForeignRecordingId?: string } | undefined;

    assert.equal(linked?.RelationType, "same_lyrical_content");
    assert.equal(linked?.SourceForeignRecordingId, "recording-stereo");
    assert.equal(linked?.TargetForeignRecordingId, "recording-atmos");
});

test("album NFO uses the selected canonical release for a composite provider slot", async () => {
    seedMusicBrainzMetadata();

    dbModule.db.prepare(`
        INSERT INTO ProviderAlbums(
            id, artist_id, title, release_date, type, explicit, quality,
            num_tracks, num_volumes, num_videos, duration, mb_release_group_id
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("201", "100", "Second Provider Single", "2024-02-03", "SINGLE", 0, "LOSSLESS", 1, 1, 0, 120, "other-release-group");
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
    assert.match(albumNfo, /<position>2<\/position>/);
    assert.match(albumNfo, /<uniqueid type="MusicBrainzTrack" default="false">track-mbid-301<\/uniqueid>/);
});
