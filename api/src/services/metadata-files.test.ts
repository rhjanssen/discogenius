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
    dbModule.db.prepare("DELETE FROM media").run();
    dbModule.db.prepare("DELETE FROM albums").run();
    dbModule.db.prepare("DELETE FROM artists").run();
});

after(() => {
    dbModule.closeDatabase();
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function seedMusicBrainzMetadata() {
    dbModule.db.prepare(`
        INSERT INTO artists(id, name, mbid, bio_text)
        VALUES(?, ?, ?, ?)
    `).run(100, "The Example Artist", "artist-mbid-100", "Artist bio & history");

    dbModule.db.prepare(`
        INSERT INTO albums(
            id, artist_id, title, release_date, type, explicit, quality,
            num_tracks, num_volumes, num_videos, duration, review_text,
            upc, mbid, mb_release_group_id
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        200,
        100,
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
        INSERT INTO media(
            id, artist_id, album_id, title, release_date, type, explicit,
            quality, track_number, volume_number, duration, mbid
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        300,
        100,
        200,
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
        INSERT INTO media(
            id, artist_id, album_id, title, release_date, type, explicit,
            quality, track_number, volume_number, duration
        )
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        400,
        100,
        200,
        "Example Video",
        "2024-02-03",
        "Music Video",
        0,
        "MP4_1080P",
        null,
        null,
        210,
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
    assert.match(albumNfo, /<uniqueid type="MusicBrainzTrack" default="false">recording-mbid-300<\/uniqueid>/);
    assert.match(albumNfo, /Album review with &lt;markup&gt;/);

    const videoNfo = fs.readFileSync(videoPath, "utf-8");
    assert.match(videoNfo, /<musicvideo>/);
    assert.match(videoNfo, /<musicbrainzartistid>artist-mbid-100<\/musicbrainzartistid>/);
    assert.match(videoNfo, /<musicbrainzalbumid>album-mbid-200<\/musicbrainzalbumid>/);
    assert.match(videoNfo, /<uniqueid type="TidalVideo" default="true">400<\/uniqueid>/);
});
