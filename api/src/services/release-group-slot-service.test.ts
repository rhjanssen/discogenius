import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import type { ProviderReleaseGroupMatch } from "./metadata/provider-release-group-matcher.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-release-group-slot-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let slotServiceModule: typeof import("./release-group-slot-service.js");

function buildMatch(releaseGroupMbid: string, providerId: string): ProviderReleaseGroupMatch {
  return {
    providerId,
    status: "verified",
    confidence: 1,
    method: "test",
    releaseGroup: {
      mbid: releaseGroupMbid,
      title: "A Night at the Opera",
      primaryType: "Album",
      secondaryTypes: [],
      firstReleaseDate: "1975-11-21",
      releases: [],
    },
    evidence: {
      providerTitle: "A Night at the Opera",
      candidateTitle: "A Night at the Opera",
      typeMatched: true,
      trackCountMatched: true,
      volumeCountMatched: true,
      targetTrackCount: 12,
      targetVolumeCount: 1,
    },
  };
}

function insertReleaseGroup(releaseGroupMbid: string): void {
  const { db } = dbModule;
  db.prepare(`
    INSERT OR IGNORE INTO ArtistMetadata (mbid, name)
    VALUES (?, ?)
  `).run("artist-mbid-1", "Queen");

  db.prepare(`
    INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, ?)
  `).run(releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "album");
}

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  slotServiceModule = await import("./release-group-slot-service.js");
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM ProviderAlbums").run();
  db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("provider slot selection does not make a MusicBrainz release group wanted", () => {
  const { db } = dbModule;
  insertReleaseGroup("rg-mbid-1");

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [{
      providerId: "provider-album-1",
      title: "A Night at the Opera",
      quality: "LOSSLESS",
      trackCount: 12,
      volumeCount: 1,
    }],
    matches: new Map([["provider-album-1", buildMatch("rg-mbid-1", "provider-album-1")]]),
  });

  const slot = db.prepare(`
    SELECT wanted, selected_provider, selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get("rg-mbid-1") as { wanted: number; selected_provider: string | null; selected_provider_id: string | null };

  assert.equal(slot.wanted, 0);
  assert.equal(slot.selected_provider, "tidal");
  assert.equal(slot.selected_provider_id, "provider-album-1");
});

test("provider slot clearing preserves MusicBrainz wanted state", () => {
  const { db } = dbModule;
  insertReleaseGroup("rg-mbid-1");

  db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted, selected_provider, selected_provider_id, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", 1, "tidal", "stale-provider-album", "verified");

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [],
    matches: new Map(),
  });

  const slot = db.prepare(`
    SELECT wanted, selected_provider, selected_provider_id, match_status
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get("rg-mbid-1") as {
    wanted: number;
    selected_provider: string | null;
    selected_provider_id: string | null;
    match_status: string;
  };

  assert.equal(slot.wanted, 1);
  assert.equal(slot.selected_provider, null);
  assert.equal(slot.selected_provider_id, null);
  assert.equal(slot.match_status, "unmatched");
});

test("provider slot selection stores a compact provider snapshot instead of raw payloads", () => {
  const { db } = dbModule;
  insertReleaseGroup("rg-mbid-1");

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [{
      providerId: "provider-album-1",
      title: "A Night at the Opera",
      version: "Deluxe",
      quality: "LOSSLESS",
      trackCount: 12,
      volumeCount: 1,
      raw: {
        title: "A Night at the Opera",
        cover: "cover-id",
        quality: "LOSSLESS",
        artist: { name: "Queen" },
        providerSecret: "do-not-store",
      },
    }],
    matches: new Map([["provider-album-1", buildMatch("rg-mbid-1", "provider-album-1")]]),
  });

  const row = db.prepare(`
    SELECT provider_data
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get("rg-mbid-1") as { provider_data: string };
  const providerData = JSON.parse(row.provider_data) as Record<string, any>;

  assert.equal(providerData.title, "A Night at the Opera");
  assert.equal(providerData.cover, "cover-id");
  assert.equal(providerData.quality, "LOSSLESS");
  assert.equal(providerData.artist?.name, "Queen");
  assert.equal("providerSecret" in providerData, false);
});

test("provider slot selection matches multiple provider releases to cover a MusicBrainz release", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-multi";
  insertReleaseGroup(releaseGroupMbid);

  // Insert preferred MusicBrainz release
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-multi", releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", 3, 1);

  // Insert AlbumReleaseMedia
  db.prepare(`
    INSERT INTO AlbumReleaseMedia (release_mbid, format, position)
    VALUES (?, ?, ?)
  `).run("release-mbid-multi", "Digital Media", 1);

  // Insert Recordings (3 tracks)
  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title, isrcs)
    VALUES (?, ?, ?)
  `);
  insertRecording.run("rec-1", "Death on Two Legs", JSON.stringify(["ISRC001"]));
  insertRecording.run("rec-2", "Lazing on a Sunday Afternoon", JSON.stringify(["ISRC002"]));
  insertRecording.run("rec-3", "I'm in Love with My Car", JSON.stringify(["ISRC003"]));

  // Insert Tracks (3 tracks)
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-mb-1", "release-mbid-multi", "rec-1", "Death on Two Legs", 1, 1);
  insertTrack.run("track-mb-2", "release-mbid-multi", "rec-2", "Lazing on a Sunday Afternoon", 2, 1);
  insertTrack.run("track-mb-3", "release-mbid-multi", "rec-3", "I'm in Love with My Car", 3, 1);

  // Insert artist (provider side)
  db.prepare(`
    INSERT INTO Artists (id, name, monitor)
    VALUES (?, ?, ?)
  `).run("artist-1", "Queen", 1);

  // Insert ProviderAlbums (two separate EPs/singles covering all 3 tracks)
  const insertProvAlbum = db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, type, explicit, quality, num_tracks, num_volumes, num_videos, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertProvAlbum.run("prov-album-a", "artist-1", "Death / Lazing", "EP", 0, "LOSSLESS", 2, 1, 0, 300, 0, 0);
  insertProvAlbum.run("prov-album-b", "artist-1", "I'm in Love", "SINGLE", 0, "LOSSLESS", 1, 1, 0, 150, 0, 0);

  // Insert ProviderMedia tracks
  const insertProvMedia = db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number, explicit, type, quality, duration, monitor, monitor_lock, mbid, isrc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // prov-album-a has track 1 and track 2
  insertProvMedia.run("prov-track-1", "artist-1", "prov-album-a", "Death on Two Legs", 1, 1, 0, "Track", "LOSSLESS", 150, 0, 0, "rec-1", "ISRC001");
  insertProvMedia.run("prov-track-2", "artist-1", "prov-album-a", "Lazing on a Sunday Afternoon", 2, 1, 0, "Track", "LOSSLESS", 150, 0, 0, "rec-2", "ISRC002");
  // prov-album-b has track 3
  insertProvMedia.run("prov-track-3", "artist-1", "prov-album-b", "I'm in Love with My Car", 1, 1, 0, "Track", "LOSSLESS", 150, 0, 0, "rec-3", "ISRC003");

  // Candidates list: prov-album-a has higher score or we provide both as candidates.
  // We need matches to map both.
  const matchA = buildMatch(releaseGroupMbid, "prov-album-a");
  const matchB = buildMatch(releaseGroupMbid, "prov-album-b");

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [
      {
        providerId: "prov-album-a",
        title: "Death / Lazing",
        quality: "LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
      },
      {
        providerId: "prov-album-b",
        title: "I'm in Love",
        quality: "LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
      }
    ],
    matches: new Map([
      ["prov-album-a", matchA],
      ["prov-album-b", matchB]
    ]),
  });

  const slot = db.prepare(`
    SELECT wanted, selected_provider, selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { wanted: number; selected_provider: string | null; selected_provider_id: string | null };

  assert.equal(slot.selected_provider, "tidal");
  // It should select the combined provider ID separated by semicolon!
  assert.equal(slot.selected_provider_id, "prov-album-a;prov-album-b");
});

test("provider slot selection skips partial provider releases unless they complete the MusicBrainz release", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-incomplete";
  insertReleaseGroup(releaseGroupMbid);

  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-incomplete", releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", 3, 1);

  db.prepare(`
    INSERT INTO AlbumReleaseMedia (release_mbid, format, position)
    VALUES (?, ?, ?)
  `).run("release-mbid-incomplete", "Digital Media", 1);

  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title, isrcs)
    VALUES (?, ?, ?)
  `);
  insertRecording.run("rec-incomplete-1", "Death on Two Legs", JSON.stringify(["ISRC101"]));
  insertRecording.run("rec-incomplete-2", "Lazing on a Sunday Afternoon", JSON.stringify(["ISRC102"]));
  insertRecording.run("rec-incomplete-3", "I'm in Love with My Car", JSON.stringify(["ISRC103"]));

  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-incomplete-1", "release-mbid-incomplete", "rec-incomplete-1", "Death on Two Legs", 1, 1);
  insertTrack.run("track-incomplete-2", "release-mbid-incomplete", "rec-incomplete-2", "Lazing on a Sunday Afternoon", 2, 1);
  insertTrack.run("track-incomplete-3", "release-mbid-incomplete", "rec-incomplete-3", "I'm in Love with My Car", 3, 1);

  db.prepare(`
    INSERT INTO Artists (id, name, monitor)
    VALUES (?, ?, ?)
  `).run("artist-incomplete", "Queen", 1);

  const insertProvAlbum = db.prepare(`
    INSERT INTO ProviderAlbums (
      id, artist_id, title, type, explicit, quality, num_tracks, num_volumes, num_videos, duration, monitor, monitor_lock
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertProvAlbum.run("prov-incomplete-a", "artist-incomplete", "Death", "SINGLE", 0, "LOSSLESS", 1, 1, 0, 150, 0, 0);
  insertProvAlbum.run("prov-incomplete-b", "artist-incomplete", "Lazing", "SINGLE", 0, "LOSSLESS", 1, 1, 0, 150, 0, 0);

  const insertProvMedia = db.prepare(`
    INSERT INTO ProviderMedia (
      id, artist_id, album_id, title, track_number, volume_number, explicit, type, quality, duration, monitor, monitor_lock, mbid, isrc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertProvMedia.run("prov-incomplete-track-1", "artist-incomplete", "prov-incomplete-a", "Death on Two Legs", 1, 1, 0, "Track", "LOSSLESS", 150, 0, 0, "rec-incomplete-1", "ISRC101");
  insertProvMedia.run("prov-incomplete-track-2", "artist-incomplete", "prov-incomplete-b", "Lazing on a Sunday Afternoon", 1, 1, 0, "Track", "LOSSLESS", 150, 0, 0, "rec-incomplete-2", "ISRC102");

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [
      {
        providerId: "prov-incomplete-a",
        title: "Death",
        quality: "LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
      },
      {
        providerId: "prov-incomplete-b",
        title: "Lazing",
        quality: "LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
      },
    ],
    matches: new Map([
      ["prov-incomplete-a", buildMatch(releaseGroupMbid, "prov-incomplete-a")],
      ["prov-incomplete-b", buildMatch(releaseGroupMbid, "prov-incomplete-b")],
    ]),
  });

  const slot = db.prepare(`
    SELECT selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { selected_provider_id: string | null } | undefined;

  assert.equal(slot, undefined);
});
