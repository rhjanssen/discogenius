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
  db.prepare("DELETE FROM AlbumEditions").run();
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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, 1)
  `).run("release-yt-cp", "rg-yt-cp", "artist-yt-cp", "Bad Blood");
  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, is_video) VALUES (?, ?, ?, 0)`)
    .run("rec-audio-yt-cp", "artist-yt-cp", "Pompeii");
  const audioRecId = (db.prepare(`SELECT id FROM Recordings WHERE mbid = ?`).get("rec-audio-yt-cp") as { id: number }).id;
  db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('rec-video-yt-cp', 'artist-yt-cp', 'Pompeii', 214000, 1, 'musicbrainz')
  `).run();
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
    providerEditionId: "MPREb_yt_cp",
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
    JOIN ProviderEditionMembers member ON member.id = match.provider_edition_member_id
    JOIN ProviderItems item ON item.id = member.member_item_id
    WHERE item.provider = 'youtube-music'
      AND item.entity_type = 'track'
      AND item.provider_id = 'atv-pompeii'
  `).get() as { match_state: string };
  assert.equal(audioMatch.match_state, "accepted");

  const videoOffer = db.prepare(`
    SELECT item.id, match.recording_id
    FROM ProviderItems item
    JOIN ProviderVideoMatches match
      ON match.provider_video_item_id = item.id
     AND match.match_state = 'accepted'
    WHERE item.provider = 'youtube-music'
      AND item.entity_type = 'video'
      AND item.provider_id = 'omv-pompeii'
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
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, 1)
  `).run("release-yt-self", "rg-yt-self", "artist-yt-self", "SAVE MY SOUL");
  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, is_video) VALUES (?, ?, ?, 0)`)
    .run("rec-audio-yt-self", "artist-yt-self", "SAVE MY SOUL");
  const audioRecId = (db.prepare(`SELECT id FROM Recordings WHERE mbid = ?`).get("rec-audio-yt-self") as { id: number }).id;
  db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('rec-video-yt-self', 'artist-yt-self', 'SAVE MY SOUL', 241000, 1, 'musicbrainz')
  `).run();
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
    providerEditionId: "MPREb_yt_self",
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
    SELECT item.id, match.recording_id
    FROM ProviderItems item
    JOIN ProviderVideoMatches match
      ON match.provider_video_item_id = item.id
     AND match.match_state = 'accepted'
    WHERE item.provider = 'youtube-music'
      AND item.entity_type = 'video'
      AND item.provider_id = 'ktWGvv6yHeU'
  `).get() as { id: number; recording_id: number };
  assert.ok(videoOffer.recording_id);
  assert.notEqual(videoOffer.id, stereoOffer.id, "self-OMV keeps distinct provider track and video facts");
  const relation = db.prepare(`
    SELECT target_recording_id FROM RecordingRelations
    WHERE source_recording_id = ? AND relation_type = 'provider_video_for'
  `).get(videoOffer.recording_id) as { target_recording_id: number };
  assert.equal(relation.target_recording_id, audioRecId);
});

test("YouTube self-OMV with album-track duration still follows a unique music_video_for", async () => {
  const { db } = dbModule;
  db.prepare(`INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run("artist-yt-mv", "Bastille");
  db.prepare(`INSERT INTO Artists (id, name, mbid, monitored) VALUES (?, ?, ?, 1)`)
    .run("artist-yt-mv", "Bastille", "artist-yt-mv");
  db.prepare(`INSERT INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)`)
    .run("rg-yt-mv", "artist-yt-mv", "Bad Blood", "Album");
  db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, track_count)
    VALUES (?, ?, ?, ?, 1)
  `).run("release-yt-mv", "rg-yt-mv", "artist-yt-mv", "Bad Blood");
  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video) VALUES (?, ?, ?, ?, 0)`)
    .run("rec-audio-yt-mv", "artist-yt-mv", "Overjoyed", 206000);
  const audioRecId = (db.prepare(`SELECT id FROM Recordings WHERE mbid = ?`).get("rec-audio-yt-mv") as { id: number }).id;
  db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video, metadata_status)
    VALUES ('rec-video-yt-mv', 'artist-yt-mv', 'Overjoyed', 223000, 1, 'musicbrainz')
  `).run();
  const videoRecId = (db.prepare(`SELECT id FROM Recordings WHERE mbid = ?`).get("rec-video-yt-mv") as { id: number }).id;
  db.prepare(`
    INSERT INTO RecordingRelations (
      source_recording_id, target_recording_id, relation_type, source, confidence
    ) VALUES (?, ?, 'music_video_for', 'musicbrainz', 1)
  `).run(videoRecId, audioRecId);
  db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, 1, 1, 206000)
  `).run("track-yt-mv", "release-yt-mv", "rec-audio-yt-mv", "Overjoyed");

  db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('youtube-music', 'release', 'MPREb_yt_mv', 'Bad Blood X')
  `).run();
  seedAcceptedProviderReleaseMatch(db, {
    provider: "youtube-music",
    providerEditionId: "MPREb_yt_mv",
    releaseMbid: "release-yt-mv",
  });

  const providerTrack = {
    providerId: "fK3fVJtFTh0",
    title: "Overjoyed",
    artist: { providerId: "UCbastille", name: "Bastille" },
    album: {
      providerId: "MPREb_yt_mv",
      title: "Bad Blood X",
      artist: { providerId: "UCbastille", name: "Bastille" },
    },
    // YouTube Music album listing uses the stereo duration, not the 223s OMV.
    duration: 207,
    trackNumber: 1,
    volumeNumber: 1,
    quality: "YOUTUBE_LOSSY",
    counterpartVideoId: "fK3fVJtFTh0",
  };

  await refreshAlbumModule.RefreshAlbumService.storeProviderTrackOffers(
    "youtube-music",
    "MPREb_yt_mv",
    [refreshAlbumModule.providerTrackToTrackMetadataRow(providerTrack as any)],
    "artist-yt-mv",
  );

  const videoOffer = db.prepare(`
    SELECT match.recording_id
    FROM ProviderItems item
    JOIN ProviderVideoMatches match
      ON match.provider_video_item_id = item.id
     AND match.match_state = 'accepted'
    WHERE item.provider = 'youtube-music'
      AND item.entity_type = 'video'
      AND item.provider_id = 'fK3fVJtFTh0'
  `).get() as { recording_id: number } | undefined;
  assert.equal(videoOffer?.recording_id, videoRecId);
});
