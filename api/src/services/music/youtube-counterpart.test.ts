import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedAcceptedProviderReleaseMatch } from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-yt-counterpart-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let refreshAlbumModule: typeof import("./refresh-album-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  refreshAlbumModule = await import("./refresh-album-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM RecordingRelations").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumReleases").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM Artists").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("storeProviderTrackOffers persists YouTube ATV→OMV counterparts as album-scoped videos", async () => {
  const { db } = dbModule;
  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("artist-yt-cp", "Bastille");
  db.prepare(`INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, 1)`)
    .run("artist-yt-cp", "Bastille", "artist-yt-cp");
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)`)
    .run("rg-yt-cp", "artist-yt-cp", "Bad Blood", "Album");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, 1)
  `).run("release-yt-cp", "rg-yt-cp", "artist-yt-cp", "Bad Blood");
  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, is_video) VALUES (?, ?, ?, 0)`)
    .run("rec-audio-yt-cp", "artist-yt-cp", "Pompeii");
  const audioRecId = (db.prepare(`SELECT id FROM Recordings WHERE mbid = ?`).get("rec-audio-yt-cp") as { id: number }).id;
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, 1, 1, 214000)
  `).run("track-yt-cp", "release-yt-cp", "rec-audio-yt-cp", "Pompeii");

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('youtube-music', 'release', 'MPREb_yt_cp', 'Bad Blood')
  `).run();
  seedAcceptedProviderReleaseMatch(db, {
    provider: "youtube-music",
    providerReleaseId: "MPREb_yt_cp",
    releaseMbid: "release-yt-cp",
  });

  const providerTrack = {
    providerId: "atv-pompeii",
    title: "Pompeii",
    artist: { providerId: "UCbastille", name: "Bastille" },
    album: {
      providerId: "MPREb_yt_cp",
      title: "Bad Blood",
      artist: { providerId: "UCbastille", name: "Bastille" },
    },
    duration: 214,
    trackNumber: 1,
    volumeNumber: 1,
    quality: "YOUTUBE_LOSSY",
    counterpartVideoId: "omv-pompeii",
  };

  await refreshAlbumModule.RefreshAlbumService.storeProviderTrackOffers(
    "youtube-music",
    "MPREb_yt_cp",
    [refreshAlbumModule.providerTrackToTrackMetadataRow(providerTrack as any)],
    "artist-yt-cp",
  );

  const audioMatch = db.prepare(`
    SELECT match.match_state
    FROM ProviderTrackMatches match
    JOIN ProviderReleaseMembers member ON member.id = match.provider_release_member_id
    JOIN ProviderItems item ON item.id = member.member_item_id
    WHERE item.provider = 'youtube-music'
      AND item.entity_type = 'track'
      AND item.provider_id = 'atv-pompeii'
  `).get() as { match_state: string };
  assert.equal(audioMatch.match_state, "accepted");

  const videoOffer = db.prepare(`
    SELECT id, recording_id
    FROM ProviderItems
    WHERE provider = 'youtube-music' AND entity_type = 'video' AND provider_id = 'omv-pompeii'
  `).get() as {
    id: number;
    recording_id: number;
  };
  assert.ok(videoOffer.recording_id);
  const relation = db.prepare(`
    SELECT target_recording_id, confidence, data
    FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(videoOffer.recording_id) as { target_recording_id: number; confidence: number; data: string };
  assert.equal(relation.target_recording_id, audioRecId);
  assert.ok(relation.confidence >= 0.9);
  assert.match(relation.data, /yt-atv-omv/);
});

test("storeProviderTrackOffers persists YouTube self-OMV album tracks as video offers", async () => {
  const { db } = dbModule;
  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("artist-yt-self", "Bastille");
  db.prepare(`INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, 1)`)
    .run("artist-yt-self", "Bastille", "artist-yt-self");
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)`)
    .run("rg-yt-self", "artist-yt-self", "SAVE MY SOUL", "Single");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, 1)
  `).run("release-yt-self", "rg-yt-self", "artist-yt-self", "SAVE MY SOUL");
  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, is_video) VALUES (?, ?, ?, 0)`)
    .run("rec-audio-yt-self", "artist-yt-self", "SAVE MY SOUL");
  const audioRecId = (db.prepare(`SELECT id FROM Recordings WHERE mbid = ?`).get("rec-audio-yt-self") as { id: number }).id;
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, 1, 1, 241000)
  `).run("track-yt-self", "release-yt-self", "rec-audio-yt-self", "SAVE MY SOUL");

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('youtube-music', 'release', 'MPREb_yt_self', 'SAVE MY SOUL')
  `).run();
  seedAcceptedProviderReleaseMatch(db, {
    provider: "youtube-music",
    providerReleaseId: "MPREb_yt_self",
    releaseMbid: "release-yt-self",
  });

  const providerTrack = {
    providerId: "ktWGvv6yHeU",
    title: "SAVE MY SOUL",
    artist: { providerId: "UCbastille", name: "Bastille" },
    album: {
      providerId: "MPREb_yt_self",
      title: "SAVE MY SOUL",
      artist: { providerId: "UCbastille", name: "Bastille" },
    },
    duration: 241,
    trackNumber: 1,
    volumeNumber: 1,
    quality: "YOUTUBE_LOSSY",
    // Same id as the stereo track — official music video published as the album entry.
    counterpartVideoId: "ktWGvv6yHeU",
  };

  await refreshAlbumModule.RefreshAlbumService.storeProviderTrackOffers(
    "youtube-music",
    "MPREb_yt_self",
    [refreshAlbumModule.providerTrackToTrackMetadataRow(providerTrack as any)],
    "artist-yt-self",
  );

  const stereoOffer = db.prepare(`
    SELECT id FROM ProviderItems
    WHERE provider = 'youtube-music' AND entity_type = 'track' AND provider_id = 'ktWGvv6yHeU'
  `).get() as { id: number };
  assert.ok(stereoOffer.id);

  const videoOffer = db.prepare(`
    SELECT id, recording_id FROM ProviderItems
    WHERE provider = 'youtube-music' AND entity_type = 'video' AND provider_id = 'ktWGvv6yHeU'
  `).get() as { id: number; recording_id: number };
  assert.ok(videoOffer.recording_id);
  assert.notEqual(videoOffer.id, stereoOffer.id, "self-OMV keeps distinct provider track and video facts");
  const relation = db.prepare(`
    SELECT target_recording_id FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(videoOffer.recording_id) as { target_recording_id: number };
  assert.equal(relation.target_recording_id, audioRecId);
});
