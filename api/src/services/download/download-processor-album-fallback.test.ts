import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-album-fallback-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

const dbModule = await import("../../database.js");
dbModule.initDatabase();
const { db } = dbModule;
const { listProviderAlbumFallbackTracks } = await import("./download-processor.js");

beforeEach(() => {
  db.prepare("DELETE FROM ProviderTrackMatches").run();
  db.prepare("DELETE FROM ProviderEditionMatches").run();
  db.prepare("DELETE FROM ProviderEditionMembers").run();
  db.prepare("DELETE FROM ProviderItems").run();
  db.prepare("DELETE FROM Tracks").run();
  db.prepare("DELETE FROM Recordings").run();
  db.prepare("DELETE FROM AlbumEditions").run();
  db.prepare("DELETE FROM Albums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

function providerItem(provider: string, entityType: string, providerId: string, title: string, version: string | null = null): number {
  return (db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title, version, availability)
    VALUES (?, ?, ?, ?, ?, 'available')
    RETURNING id
  `).get(provider, entityType, providerId, title, version) as { id: number }).id;
}

function addMember(releaseItemId: number, memberItemId: number, medium: number, position: number): number {
  return (db.prepare(`
    INSERT INTO ProviderEditionMembers (provider_edition_item_id, member_item_id, medium_position, position)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).get(releaseItemId, memberItemId, medium, position) as { id: number }).id;
}

/** Canonical release-group / release / track, returning the Tracks row id. */
function seedCanonicalTrack(
  editionMbid: string, trackMbid: string, title: string, medium: number, position: number,
): { trackId: number; recordingId: number } {
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES ('artist-mbid', 'Fallback Artist')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES ('rg-fallback', 'artist-mbid', 'Fallback Album', 'album')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, date, track_count)
    VALUES (?, 'rg-fallback', 'artist-mbid', 'Fallback Album', '2024-01-01', 3)
  `).run(editionMbid);
  const recording = db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, is_video, metadata_status)
    VALUES (?, 'artist-mbid', ?, 0, 'complete')
    RETURNING id
  `).get(`rec-${trackMbid}`, title) as { id: number };
  const track = db.prepare(`
    INSERT INTO Tracks (mbid, edition_mbid, recording_mbid, recording_id, medium_position, position, number, title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(trackMbid, editionMbid, `rec-${trackMbid}`, recording.id, medium, position, String(position), title) as { id: number };
  return { trackId: track.id, recordingId: recording.id };
}

/** One accepted release edge per (provider release item, canonical release). */
function acceptReleaseMatch(releaseItemId: number, editionId: number): number {
  return (db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 0.99, 'test_fixture', 1)
    RETURNING id
  `).get(releaseItemId, editionId) as { id: number }).id;
}

function addTrackMatch(
  memberId: number, releaseMatchId: number, trackId: number, recordingId: number,
  matchState: "accepted" | "rejected" = "accepted",
) {
  db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_edition_member_id, provider_edition_match_id, track_id, recording_id,
      match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, ?, ?, 'automatic', 0.99, 'test_fixture', 1)
  `).run(memberId, releaseMatchId, trackId, recordingId, matchState);
}

test("fallback tracklist takes numbers from the accepted canonical track", () => {
  const releaseItem = providerItem("tidal", "release", "album-1", "Fallback Album");
  const trackA = providerItem("tidal", "track", "t-a", "Provider Title A", "Radio Edit");
  const trackB = providerItem("tidal", "track", "t-b", "Provider Title B");

  // The provider lists them 1 then 2; the canonical release orders them 2 then 1
  // across two media, and the canonical numbering must win.
  const memberA = addMember(releaseItem, trackA, 1, 1);
  const memberB = addMember(releaseItem, trackB, 1, 2);

  const editionId = (db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-1'").get() as { id: number } | undefined)?.id;
  assert.equal(editionId, undefined, "no canonical release yet");

  const canonicalB = seedCanonicalTrack("rel-1", "track-b", "Canonical Title B", 1, 1);
  const canonicalA = seedCanonicalTrack("rel-1", "track-a", "Canonical Title A", 2, 3);
  const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-1'").get() as { id: number };

  const releaseMatch = acceptReleaseMatch(releaseItem, release.id);
  addTrackMatch(memberA, releaseMatch, canonicalA.trackId, canonicalA.recordingId);
  addTrackMatch(memberB, releaseMatch, canonicalB.trackId, canonicalB.recordingId);

  const rows = listProviderAlbumFallbackTracks(db, {
    provider: "tidal",
    providerAlbumId: "album-1",
    editionMbid: "rel-1",
  });

  assert.deepEqual(rows, [
    { provider_id: "t-b", title: "Canonical Title B", version: null, track_number: 1, volume_number: 1 },
    { provider_id: "t-a", title: "Canonical Title A", version: "Radio Edit", track_number: 3, volume_number: 2 },
  ]);
});

test("an unmatched member keeps null numbers but orders by its provider position", () => {
  const releaseItem = providerItem("tidal", "release", "album-1", "Fallback Album");
  const second = providerItem("tidal", "track", "zzz-second", "Second");
  const first = providerItem("tidal", "track", "aaa-first", "First");
  // Deliberately inserted out of order, and named so lexical provider-id order
  // would reverse them.
  addMember(releaseItem, second, 1, 2);
  addMember(releaseItem, first, 1, 1);

  const rows = listProviderAlbumFallbackTracks(db, {
    provider: "tidal",
    providerAlbumId: "album-1",
    editionMbid: null,
  });

  assert.deepEqual(rows.map((row) => row.provider_id), ["aaa-first", "zzz-second"]);
  // Numbers stay canonical-only: no accepted match means no track number, never
  // the provider's native album layout.
  assert.deepEqual(rows.map((row) => row.track_number), [null, null]);
  assert.deepEqual(rows.map((row) => row.volume_number), [null, null]);
  assert.deepEqual(rows.map((row) => row.title), ["First", "Second"]);
});

test("a colliding album id from another provider contributes nothing", () => {
  const tidalRelease = providerItem("tidal", "release", "shared-id", "TIDAL Album");
  const appleRelease = providerItem("apple-music", "release", "shared-id", "Apple Album");
  addMember(tidalRelease, providerItem("tidal", "track", "tidal-track", "TIDAL Track"), 1, 1);
  addMember(appleRelease, providerItem("apple-music", "track", "apple-track", "Apple Track"), 1, 1);

  const tidalRows = listProviderAlbumFallbackTracks(db, {
    provider: "tidal",
    providerAlbumId: "shared-id",
    editionMbid: null,
  });
  const appleRows = listProviderAlbumFallbackTracks(db, {
    provider: "apple-music",
    providerAlbumId: "shared-id",
    editionMbid: null,
  });

  assert.deepEqual(tidalRows.map((row) => row.provider_id), ["tidal-track"]);
  assert.deepEqual(appleRows.map((row) => row.provider_id), ["apple-track"]);
});

test("a track on several provider releases only contributes to the requested one", () => {
  const albumRelease = providerItem("tidal", "release", "album-1", "Album");
  const singleRelease = providerItem("tidal", "release", "single-1", "Single");
  const shared = providerItem("tidal", "track", "shared-track", "Shared Track");
  addMember(albumRelease, shared, 1, 5);
  addMember(singleRelease, shared, 1, 1);

  const albumRows = listProviderAlbumFallbackTracks(db, {
    provider: "tidal",
    providerAlbumId: "album-1",
    editionMbid: null,
  });

  assert.equal(albumRows.length, 1, "one occurrence, not one row per membership");
  assert.equal(albumRows[0]?.provider_id, "shared-track");
});

test("a rejected typed edge does not supply canonical numbering", () => {
  const releaseItem = providerItem("tidal", "release", "album-1", "Album");
  const trackItem = providerItem("tidal", "track", "t-a", "Provider Title");
  const memberId = addMember(releaseItem, trackItem, 1, 1);
  const canonical = seedCanonicalTrack("rel-1", "track-a", "Canonical Title", 1, 7);
  const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = 'rel-1'").get() as { id: number };

  // The release edge is accepted, but this member's track edge is rejected.
  const releaseMatch = acceptReleaseMatch(releaseItem, release.id);
  addTrackMatch(memberId, releaseMatch, canonical.trackId, canonical.recordingId, "rejected");

  const rows = listProviderAlbumFallbackTracks(db, {
    provider: "tidal",
    providerAlbumId: "album-1",
    editionMbid: "rel-1",
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.title, "Provider Title", "a rejected edge must not supply the canonical title");
  assert.equal(rows[0]?.track_number, null);
});
