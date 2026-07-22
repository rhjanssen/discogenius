import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import type { ProviderReleaseGroupMatch } from "../metadata/provider-release-group-matcher.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-release-group-slot-service-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let configModule: typeof import("../config/config.js");
let slotServiceModule: typeof import("./release-group-slot-service.js");

function writeTestConfig(overrides?: {
  filtering?: Partial<any>;
}) {
  const config = configModule.readConfig();
  config.filtering = {
    ...config.filtering,
    require_provider_availability: overrides?.filtering?.require_provider_availability ?? false,
  };
  configModule.writeConfig(config);
}

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
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  configModule = await import("../config/config.js");
  slotServiceModule = await import("./release-group-slot-service.js");
  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
  db.prepare("DELETE FROM ProviderItems").run();
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
    SELECT monitored AS wanted, selected_provider, selected_provider_id
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
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run("artist-mbid-1", "rg-mbid-1", "stereo", 1, "tidal", "stale-provider-album", "verified");

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [],
    matches: new Map(),
  });

  const slot = db.prepare(`
    SELECT monitored AS wanted, selected_provider, selected_provider_id, match_status
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

test("provider slot clearing preserves selections for providers that were not refreshed", () => {
  const { db } = dbModule;
  insertReleaseGroup("rg-mbid-apple");
  insertReleaseGroup("rg-mbid-tidal");

  const insertSlot = db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id, match_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertSlot.run("artist-mbid-1", "rg-mbid-apple", "stereo", 0, "apple-music", "apple-album", "verified");
  insertSlot.run("artist-mbid-1", "rg-mbid-tidal", "stereo", 0, "tidal", "tidal-album", "verified");

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    artistMbid: "artist-mbid-1",
    candidates: [],
    clearProviders: ["tidal"],
  });

  const appleSlot = db.prepare(`
    SELECT selected_provider, selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get("rg-mbid-apple") as { selected_provider: string | null; selected_provider_id: string | null };
  const tidalSlot = db.prepare(`
    SELECT selected_provider, selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get("rg-mbid-tidal") as { selected_provider: string | null; selected_provider_id: string | null };

  assert.equal(appleSlot.selected_provider, "apple-music");
  assert.equal(appleSlot.selected_provider_id, "apple-album");
  assert.equal(tidalSlot.selected_provider, null);
  assert.equal(tidalSlot.selected_provider_id, null);
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
    SELECT selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get("rg-mbid-1") as { selected_provider_id: string };

  assert.equal(row.selected_provider_id, "provider-album-1");
});

test("provider slot selection keeps stereo and Atmos offers on one MusicBrainz release while preferring hi-res stereo", () => {
  const releaseGroupMbid = "rg-mbid-quality-variants";
  const releaseMbid = "release-mbid-quality-variants";
  const match = {
    ...buildMatch(releaseGroupMbid, "provider-album-lossless"),
    releaseMbid,
  };

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "tidal",
      album: {
        providerId: "provider-album-lossless",
        title: "A Night at the Opera",
        quality: "LOSSLESS",
        trackCount: 12,
        volumeCount: 1,
      },
      match,
    },
    {
      provider: "tidal",
      album: {
        providerId: "provider-album-hires",
        title: "A Night at the Opera",
        quality: "HIRES_LOSSLESS",
        trackCount: 12,
        volumeCount: 1,
      },
      match: {
        ...match,
        providerId: "provider-album-hires",
      },
    },
    {
      provider: "tidal",
      album: {
        providerId: "provider-album-atmos",
        title: "A Night at the Opera",
        quality: "DOLBY_ATMOS",
        trackCount: 12,
        volumeCount: 1,
      },
      match: {
        ...match,
        providerId: "provider-album-atmos",
      },
    },
  ], {
    includeSpatial: true,
  });

  assert.deepEqual(
    selections.map((selection) => ({
      slot: selection.slot,
      providerId: selection.album.providerId,
      releaseGroupMbid: selection.releaseGroupMbid,
      releaseMbid: selection.match.releaseMbid,
    })),
    [
      {
        slot: "spatial",
        providerId: "provider-album-atmos",
        releaseGroupMbid,
        releaseMbid,
      },
      {
        slot: "stereo",
        providerId: "provider-album-hires",
        releaseGroupMbid,
        releaseMbid,
      },
    ],
  );
});

test("one Apple album offer materializes separate hi-res stereo and Atmos slot selections", () => {
  const releaseGroupMbid = "rg-mbid-apple-multi-capability";
  const releaseMbid = "release-mbid-apple-multi-capability";
  const providerId = "apple-album-multi-capability";

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([{
    provider: "apple-music",
    album: {
      providerId,
      title: "Give Me the Future",
      quality: "HIRES_LOSSLESS",
      qualityTags: ["lossy-stereo", "lossless", "hi-res-lossless", "atmos"],
      trackCount: 13,
      volumeCount: 1,
    },
    match: {
      ...buildMatch(releaseGroupMbid, providerId),
      releaseMbid,
    },
  }], { includeSpatial: true });

  assert.deepEqual(
    selections.map((selection) => ({
      slot: selection.slot,
      provider: selection.provider,
      providerId: selection.album.providerId,
      quality: selection.album.quality,
    })),
    [
      {
        slot: "spatial",
        provider: "apple-music",
        providerId,
        quality: "DOLBY_ATMOS",
      },
      {
        slot: "stereo",
        provider: "apple-music",
        providerId,
        quality: "HIRES_LOSSLESS",
      },
    ],
  );
});

test("equal-merit offers from two providers tie-break by provider preference, not alphabetically", () => {
  const releaseGroupMbid = "rg-mbid-provider-tiebreak";
  const releaseMbid = "release-mbid-provider-tiebreak";
  const match = {
    ...buildMatch(releaseGroupMbid, "apple-album-1"),
    releaseMbid,
  };

  // "apple-music" sorts before "tidal" alphabetically; with the default
  // provider preference (tidal first) the TIDAL offer must win the tie.
  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "apple-music",
      album: {
        providerId: "apple-album-1",
        title: "A Night at the Opera",
        quality: "LOSSLESS",
        trackCount: 12,
        volumeCount: 1,
      },
      match,
    },
    {
      provider: "tidal",
      album: {
        providerId: "tidal-album-1",
        title: "A Night at the Opera",
        quality: "LOSSLESS",
        trackCount: 12,
        volumeCount: 1,
      },
      match: {
        ...match,
        providerId: "tidal-album-1",
      },
    },
  ], {});

  const stereo = selections.find((selection) => selection.slot === "stereo");
  assert.ok(stereo);
  assert.equal(stereo?.provider, "tidal");
  assert.equal(stereo?.album.providerId, "tidal-album-1");
});

test("provider slot selection links an Atmos-only release to both stereo and spatial slots", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-atmos-only";
  const atmosReleaseMbid = "release-mbid-atmos-only";
  insertReleaseGroup(releaseGroupMbid);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    atmosReleaseMbid,
    releaseGroupMbid,
    "artist-mbid-1",
    "A Night at the Opera (Dolby Atmos)",
    "Official",
    "2024-01-01",
    12,
    1,
  );

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [{
      providerId: "provider-album-atmos-only",
      title: "A Night at the Opera",
      quality: "DOLBY_ATMOS",
      trackCount: 12,
      volumeCount: 1,
    }],
    matches: new Map([[
      "provider-album-atmos-only",
      {
        ...buildMatch(releaseGroupMbid, "provider-album-atmos-only"),
        releaseMbid: atmosReleaseMbid,
        evidence: {
          ...buildMatch(releaseGroupMbid, "provider-album-atmos-only").evidence,
          availableReleaseMbids: [atmosReleaseMbid],
        },
      },
    ]]),
  });

  const slots = db.prepare(`
    SELECT slot, selected_provider_id, selected_release_mbid, quality
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ?
    ORDER BY slot
  `).all(releaseGroupMbid) as Array<{
    slot: string;
    selected_provider_id: string | null;
    selected_release_mbid: string | null;
    quality: string | null;
  }>;

  assert.deepEqual(slots, [
    {
      slot: "spatial",
      selected_provider_id: "provider-album-atmos-only",
      selected_release_mbid: atmosReleaseMbid,
      quality: "DOLBY_ATMOS",
    },
    {
      slot: "stereo",
      selected_provider_id: "provider-album-atmos-only",
      selected_release_mbid: atmosReleaseMbid,
      quality: "DOLBY_ATMOS",
    },
  ]);
});

test("provider slot selection can bind stereo and Atmos to different releases and provider identifiers", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-slot-specific-atmos";
  const stereoReleaseMbid = "release-mbid-slot-stereo";
  const atmosReleaseMbid = "release-mbid-slot-atmos";
  insertReleaseGroup(releaseGroupMbid);

  const insertRelease = db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRelease.run(stereoReleaseMbid, releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "Official", "2024-01-01", 2, 1);
  insertRelease.run(atmosReleaseMbid, releaseGroupMbid, "artist-mbid-1", "A Night at the Opera (Dolby Atmos)", "Official", "2024-01-01", 2, 1);

  const insertRecording = db.prepare("INSERT INTO Recordings (mbid, title) VALUES (?, ?)");
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [releaseMbid, recordingPrefix, trackPrefix] of [
    [stereoReleaseMbid, "rec-slot-stereo", "track-slot-stereo"],
    [atmosReleaseMbid, "rec-slot-atmos", "track-slot-atmos"],
  ] as const) {
    insertRecording.run(`${recordingPrefix}-1`, "Track One");
    insertRecording.run(`${recordingPrefix}-2`, "Track Two");
    insertTrack.run(`${trackPrefix}-1`, releaseMbid, `${recordingPrefix}-1`, "Track One", 1, 1);
    insertTrack.run(`${trackPrefix}-2`, releaseMbid, `${recordingPrefix}-2`, "Track Two", 2, 1);
  }

  const insertProviderItem = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, release_group_mbid, release_mbid,
      title, quality, upc, isrc, library_slot
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertProviderItem.run("tidal", "album", "provider-slot-stereo", releaseGroupMbid, stereoReleaseMbid, "A Night at the Opera", "LOSSLESS", "UPC-STEREO-001", null, "stereo");
  insertProviderItem.run("tidal", "album", "provider-slot-atmos", releaseGroupMbid, atmosReleaseMbid, "A Night at the Opera", "DOLBY_ATMOS", "UPC-ATMOS-001", null, "spatial");
  insertProviderItem.run("tidal", "track", "provider-slot-stereo-1", releaseGroupMbid, stereoReleaseMbid, "Track One", "LOSSLESS", null, "ISRCSTEREO001", "stereo");
  insertProviderItem.run("tidal", "track", "provider-slot-stereo-2", releaseGroupMbid, stereoReleaseMbid, "Track Two", "LOSSLESS", null, "ISRCSTEREO002", "stereo");
  insertProviderItem.run("tidal", "track", "provider-slot-atmos-1", releaseGroupMbid, atmosReleaseMbid, "Track One", "DOLBY_ATMOS", null, "ISRCATMOS001", "spatial");
  insertProviderItem.run("tidal", "track", "provider-slot-atmos-2", releaseGroupMbid, atmosReleaseMbid, "Track Two", "DOLBY_ATMOS", null, "ISRCATMOS002", "spatial");

  const stereoMatch = {
    ...buildMatch(releaseGroupMbid, "provider-slot-stereo"),
    releaseMbid: stereoReleaseMbid,
    evidence: {
      ...buildMatch(releaseGroupMbid, "provider-slot-stereo").evidence,
      availableReleaseMbids: [stereoReleaseMbid],
      targetTrackCount: 2,
    },
  };
  const atmosMatch = {
    ...buildMatch(releaseGroupMbid, "provider-slot-atmos"),
    releaseMbid: atmosReleaseMbid,
    evidence: {
      ...buildMatch(releaseGroupMbid, "provider-slot-atmos").evidence,
      availableReleaseMbids: [atmosReleaseMbid],
      targetTrackCount: 2,
    },
  };

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [
      {
        providerId: "provider-slot-stereo",
        title: "A Night at the Opera",
        quality: "LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "ISRCSTEREO001", title: "Track One", track_number: 1, volume_number: 1, duration: null },
          { mbid: null, isrc: "ISRCSTEREO002", title: "Track Two", track_number: 2, volume_number: 1, duration: null },
        ],
      },
      {
        providerId: "provider-slot-atmos",
        title: "A Night at the Opera",
        quality: "DOLBY_ATMOS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "ISRCATMOS001", title: "Track One", track_number: 1, volume_number: 1, duration: null },
          { mbid: null, isrc: "ISRCATMOS002", title: "Track Two", track_number: 2, volume_number: 1, duration: null },
        ],
      },
    ],
    matches: new Map([
      ["provider-slot-stereo", stereoMatch],
      ["provider-slot-atmos", atmosMatch],
    ]),
  });

  const slots = db.prepare(`
    SELECT slot, selected_provider_id, selected_release_mbid
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ?
    ORDER BY slot
  `).all(releaseGroupMbid) as Array<{
    slot: string;
    selected_provider_id: string | null;
    selected_release_mbid: string | null;
  }>;

  assert.deepEqual(slots, [
    { slot: "spatial", selected_provider_id: "provider-slot-atmos", selected_release_mbid: atmosReleaseMbid },
    { slot: "stereo", selected_provider_id: "provider-slot-stereo", selected_release_mbid: stereoReleaseMbid },
  ]);

  const matchRows = db.prepare(`
    SELECT provider_item_id, musicbrainz_release_mbid, status
    FROM ProviderItemMatches
    WHERE provider = 'tidal' AND provider_item_type = 'album'
      AND provider_item_id IN ('provider-slot-atmos', 'provider-slot-stereo')
    ORDER BY provider_item_id
  `).all() as Array<{ provider_item_id: string; musicbrainz_release_mbid: string; status: string }>;
  assert.deepEqual(matchRows, [
    { provider_item_id: "provider-slot-atmos", musicbrainz_release_mbid: atmosReleaseMbid, status: "verified" },
    { provider_item_id: "provider-slot-stereo", musicbrainz_release_mbid: stereoReleaseMbid, status: "verified" },
  ]);

  const albumEvidence = db.prepare(`
    SELECT provider_id, upc, library_slot, release_mbid
    FROM ProviderItems
    WHERE entity_type = 'album' AND release_group_mbid = ?
    ORDER BY library_slot
  `).all(releaseGroupMbid);
  assert.deepEqual(albumEvidence, [
    { provider_id: "provider-slot-atmos", upc: "UPC-ATMOS-001", library_slot: "spatial", release_mbid: atmosReleaseMbid },
    { provider_id: "provider-slot-stereo", upc: "UPC-STEREO-001", library_slot: "stereo", release_mbid: stereoReleaseMbid },
  ]);

  const trackEvidence = db.prepare(`
    SELECT release_mbid, library_slot, group_concat(isrc, ',') AS isrcs
    FROM ProviderItems
    WHERE entity_type = 'track' AND release_group_mbid = ?
    GROUP BY release_mbid, library_slot
    ORDER BY library_slot
  `).all(releaseGroupMbid);
  assert.deepEqual(trackEvidence, [
    { release_mbid: atmosReleaseMbid, library_slot: "spatial", isrcs: "ISRCATMOS001,ISRCATMOS002" },
    { release_mbid: stereoReleaseMbid, library_slot: "stereo", isrcs: "ISRCSTEREO001,ISRCSTEREO002" },
  ]);

  const catalogIsrcRows = db.prepare(`
    SELECT COUNT(*) AS count
    FROM Recordings
    WHERE mbid LIKE 'rec-slot-%' AND isrcs IS NOT NULL
  `).get() as { count: number };
  assert.equal(catalogIsrcRows.count, 0);
});

test("provider sync retains Atmos matches while spatial downloads are disabled", () => {
  const { db } = dbModule;
  insertReleaseGroup("rg-mbid-hidden-atmos");

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [{
      providerId: "provider-album-atmos",
      title: "A Night at the Opera",
      quality: "DOLBY_ATMOS",
      trackCount: 12,
      volumeCount: 1,
    }],
    matches: new Map([["provider-album-atmos", buildMatch("rg-mbid-hidden-atmos", "provider-album-atmos")]]),
  });

  const slot = db.prepare(`
    SELECT monitored AS wanted, selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'spatial'
  `).get("rg-mbid-hidden-atmos") as { wanted: number; selected_provider_id: string };

  assert.equal(slot.wanted, 0);
  assert.equal(slot.selected_provider_id, "provider-album-atmos");
});

test("provider slot selection prefers an offer compatible with the Lidarr-like representative release", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-provider-shape";
  insertReleaseGroup(releaseGroupMbid);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, track_count, media_count)
    VALUES
      ('release-single', ?, 'artist-mbid-1', 'Release', 1, 1),
      ('release-complete', ?, 'artist-mbid-1', 'Release', 3, 1)
  `).run(releaseGroupMbid, releaseGroupMbid);

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "tidal",
      album: {
        providerId: "provider-single",
        title: "Release",
        quality: "LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
      },
      match: {
        ...buildMatch(releaseGroupMbid, "provider-single"),
        evidence: {
          ...buildMatch(releaseGroupMbid, "provider-single").evidence,
          availableReleaseMbids: ["release-single"],
        },
      },
    },
    {
      provider: "tidal",
      album: {
        providerId: "provider-complete",
        title: "Release",
        quality: "LOSSLESS",
        trackCount: 3,
        volumeCount: 1,
      },
      match: {
        ...buildMatch(releaseGroupMbid, "provider-complete"),
        evidence: {
          ...buildMatch(releaseGroupMbid, "provider-complete").evidence,
          availableReleaseMbids: ["release-complete"],
        },
      },
    },
  ]);

  assert.equal(selections[0]?.album.providerId, "provider-complete");
  assert.equal(selections[0]?.match.releaseMbid, "release-complete");
});

test("Servarr mode (no UPC): an exact-title offer beats a remix-suffixed one", () => {
  // Skyhook strips UPC/ISRC, so the Bakermat "One Day (Vandaag)" case cannot be
  // settled by barcode in Servarr mode. The radio edit is an exact title match
  // while the "… (Remix)" single is only a prefix expansion — the exact match
  // must still win the slot.
  const releaseGroupMbid = "rg-mbid-servarr-remix";
  insertReleaseGroup(releaseGroupMbid);

  const candidate = (providerId: string, titleScore: number, providerTitle: string) => ({
    provider: "tidal",
    album: {
      providerId,
      title: providerTitle,
      quality: "LOSSLESS",
      trackCount: 1,
      volumeCount: 1,
    },
    match: {
      ...buildMatch(releaseGroupMbid, providerId),
      evidence: {
        ...buildMatch(releaseGroupMbid, providerId).evidence,
        providerTitle,
        titleScore,
        upcMatched: false,
        availableReleaseMbids: [] as string[],
      },
    },
  });

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    candidate("provider-remix", 0.9, "One Day (Vandaag) (Oliver $ Remix)"),
    candidate("provider-radio", 1, "One Day (Vandaag)"),
  ]);

  assert.equal(selections[0]?.album.providerId, "provider-radio");
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

  // Store MusicBrainz media/disc shape on the release snapshot.
  db.prepare(`
    UPDATE AlbumReleases
    SET media = ?
    WHERE mbid = ?
  `).run(JSON.stringify([{ Position: 1, Format: "Digital Media" }]), "release-mbid-multi");

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

  // Candidates list: prov-album-a has higher score or we provide both as candidates.
  // We need matches to map both.
  const matchA = { ...buildMatch(releaseGroupMbid, "prov-album-a"), status: "candidate" as const };
  const matchB = { ...buildMatch(releaseGroupMbid, "prov-album-b"), status: "candidate" as const };

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
        tracks: [
          { mbid: "rec-1", isrc: "ISRC001", title: "Death on Two Legs", track_number: 1, volume_number: 1, duration: 150 },
          { mbid: "rec-2", isrc: "ISRC002", title: "Lazing on a Sunday Afternoon", track_number: 2, volume_number: 1, duration: 150 },
        ],
      },
      {
        providerId: "prov-album-b",
        title: "I'm in Love",
        quality: "LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
        tracks: [
          { mbid: "rec-3", isrc: "ISRC003", title: "I'm in Love with My Car", track_number: 1, volume_number: 1, duration: 150 },
        ],
      }
    ],
    matches: new Map([
      ["prov-album-a", matchA],
      ["prov-album-b", matchB]
    ]),
  });

  const slot = db.prepare(`
    SELECT monitored AS wanted, selected_provider, selected_provider_id, match_status, match_method
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { wanted: number; selected_provider: string | null; selected_provider_id: string | null; match_status: string | null; match_method: string | null };

  assert.equal(slot.selected_provider, "tidal");
  // It should select the combined provider ID separated by semicolon!
  assert.equal(slot.selected_provider_id, "prov-album-a;prov-album-b");
  assert.equal(slot.match_status, "verified");
  assert.equal(slot.match_method, "quality_optimized_composite_track_coverage");
});

test("provider slot selection combines hydrated offers before legacy provider rows are stored", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-hydrated-multi";
  insertReleaseGroup(releaseGroupMbid);

  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-hydrated-multi", releaseGroupMbid, "artist-mbid-1", "MTV Unplugged edits", "Official", "2023-04-26", 3, 1);

  const insertRecording = db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)");
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [position, title, isrc] of [
    [1, "Killing Me Softly With His Song (edit)", "GBUM72302334"],
    [2, "Pompeii (edit)", "GBUM72302279"],
    [3, "Come as You Are (edit)", "GBUM72302277"],
  ] as const) {
    insertRecording.run(`rec-hydrated-${position}`, title, JSON.stringify([isrc]));
    insertTrack.run(`track-hydrated-${position}`, "release-mbid-hydrated-multi", `rec-hydrated-${position}`, title, position, 1);
  }

  const match = {
    ...buildMatch(releaseGroupMbid, "provider-softly"),
    releaseMbid: "release-mbid-hydrated-multi",
    evidence: {
      ...buildMatch(releaseGroupMbid, "provider-softly").evidence,
      availableReleaseMbids: ["release-mbid-hydrated-multi"],
    },
  };
  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "tidal",
      album: {
        providerId: "provider-softly",
        title: "Killing Me Softly With His Song (MTV Unplugged / Edit)",
        quality: "HIRES_LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
        tracks: [{ mbid: null, isrc: "GBUM72302334", title: "Killing Me Softly With His Song (edit)", track_number: 1, volume_number: 1, duration: null }],
      },
      match,
    },
    {
      provider: "tidal",
      album: {
        providerId: "provider-pompeii-come-as-you-are",
        title: "Pompeii / Come As You Are (MTV Unplugged)",
        quality: "HIRES_LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "GBUM72302279", title: "Pompeii (edit)", track_number: 1, volume_number: 1, duration: null },
          { mbid: null, isrc: "GBUM72302277", title: "Come as You Are (edit)", track_number: 2, volume_number: 1, duration: null },
        ],
      },
      match: { ...match, providerId: "provider-pompeii-come-as-you-are" },
    },
  ]);

  assert.equal(selections[0]?.album.providerId, "provider-softly;provider-pompeii-come-as-you-are");
  assert.equal(selections[0]?.match.releaseMbid, "release-mbid-hydrated-multi");
});

test("provider slot selection rejects incomplete multi-album hybrids and keeps single-album partials", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-incomplete";
  insertReleaseGroup(releaseGroupMbid);

  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-incomplete", releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", 3, 1);

  db.prepare(`
    UPDATE AlbumReleases
    SET media = ?
    WHERE mbid = ?
  `).run(JSON.stringify([{ Position: 1, Format: "Digital Media" }]), "release-mbid-incomplete");

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
        tracks: [
          { mbid: "rec-incomplete-1", isrc: "ISRC101", title: "Death on Two Legs", track_number: 1, volume_number: 1, duration: 150 },
        ],
      },
      {
        providerId: "prov-incomplete-b",
        title: "Lazing",
        quality: "LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
        tracks: [
          { mbid: "rec-incomplete-2", isrc: "ISRC102", title: "Lazing on a Sunday Afternoon", track_number: 1, volume_number: 1, duration: 150 },
        ],
      },
    ],
    matches: new Map([
      ["prov-incomplete-a", buildMatch(releaseGroupMbid, "prov-incomplete-a")],
      ["prov-incomplete-b", buildMatch(releaseGroupMbid, "prov-incomplete-b")],
    ]),
  });

  const slot = db.prepare(`
    SELECT selected_provider_id, match_status, match_method, match_evidence
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { selected_provider_id: string | null; match_status: string; match_method: string; match_evidence: string };

  // Two albums covering 2/3 must not form an incomplete hybrid — keep the best
  // single-album partial instead.
  assert.ok(slot.selected_provider_id === "prov-incomplete-a" || slot.selected_provider_id === "prov-incomplete-b");
  assert.equal(String(slot.selected_provider_id || "").includes(";"), false);
  assert.equal(slot.match_status, "probable");
  assert.equal(slot.match_method, "strict_partial_track_coverage");
  assert.deepEqual(JSON.parse(slot.match_evidence).coverage, {
    coveredTracks: 1,
    targetTracks: 3,
    complete: false,
    qualityTrackCounts: { LOSSLESS: 1 },
    extraProviderTracks: 0,
  });
});

test("provider slot selection keeps high quality partial coverage explicit", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-high-quality-partial";
  insertReleaseGroup(releaseGroupMbid);

  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-high-quality-partial", releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", 3, 1);

  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title, isrcs)
    VALUES (?, ?, ?)
  `);
  insertRecording.run("rec-hq-partial-1", "Death on Two Legs", JSON.stringify(["ISRC201"]));
  insertRecording.run("rec-hq-partial-2", "Lazing on a Sunday Afternoon", JSON.stringify(["ISRC202"]));
  insertRecording.run("rec-hq-partial-3", "I'm in Love with My Car", JSON.stringify(["ISRC203"]));

  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-hq-partial-1", "release-mbid-high-quality-partial", "rec-hq-partial-1", "Death on Two Legs", 1, 1);
  insertTrack.run("track-hq-partial-2", "release-mbid-high-quality-partial", "rec-hq-partial-2", "Lazing on a Sunday Afternoon", 2, 1);
  insertTrack.run("track-hq-partial-3", "release-mbid-high-quality-partial", "rec-hq-partial-3", "I'm in Love with My Car", 3, 1);

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [
      {
        providerId: "prov-hq-partial",
        title: "A Night at the Opera Continued",
        quality: "HIRES_LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          { mbid: "rec-hq-partial-1", isrc: "ISRC201", title: "Death on Two Legs", track_number: 1, volume_number: 1, duration: 150 },
          { mbid: "rec-hq-partial-2", isrc: "ISRC202", title: "Lazing on a Sunday Afternoon", track_number: 2, volume_number: 1, duration: 150 },
        ],
      },
    ],
    matches: new Map([["prov-hq-partial", buildMatch(releaseGroupMbid, "prov-hq-partial")]]),
  });

  const slot = db.prepare(`
    SELECT selected_provider_id, quality, match_status, match_method
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { selected_provider_id: string | null; quality: string; match_status: string; match_method: string };

  assert.equal(slot.selected_provider_id, "prov-hq-partial");
  assert.equal(slot.quality, "HIRES_LOSSLESS");
  assert.equal(slot.match_status, "probable");
  assert.equal(slot.match_method, "strict_partial_track_coverage");
});

test("provider slot selection falls back to strong release-shape evidence when noisy track titles block strict matching", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-noisy-track-title";
  insertReleaseGroup(releaseGroupMbid);

  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-noisy-track-title", releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", 3, 1);

  db.prepare(`
    UPDATE AlbumReleases
    SET media = ?
    WHERE mbid = ?
  `).run(JSON.stringify([{ Position: 1, Format: "Digital Media" }]), "release-mbid-noisy-track-title");

  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title, isrcs)
    VALUES (?, ?, ?)
  `);
  insertRecording.run("rec-noisy-1", "Death on Two Legs", JSON.stringify(["ISRC301"]));
  insertRecording.run("rec-noisy-2", "Lazing on a Sunday Afternoon", JSON.stringify(["ISRC302"]));
  insertRecording.run("rec-noisy-3", "I'm in Love with My Car", JSON.stringify(["ISRC303"]));

  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-noisy-1", "release-mbid-noisy-track-title", "rec-noisy-1", "Death on Two Legs", 1, 1);
  insertTrack.run("track-noisy-2", "release-mbid-noisy-track-title", "rec-noisy-2", "Lazing on a Sunday Afternoon", 2, 1);
  insertTrack.run("track-noisy-3", "release-mbid-noisy-track-title", "rec-noisy-3", "I'm in Love with My Car", 3, 1);

  const match = {
    ...buildMatch(releaseGroupMbid, "provider-album-noisy"),
    releaseMbid: "release-mbid-noisy-track-title",
    evidence: {
      ...buildMatch(releaseGroupMbid, "provider-album-noisy").evidence,
      providerTrackCount: 3,
      targetTrackCount: 3,
      providerVolumeCount: 1,
      targetVolumeCount: 1,
      availableReleaseMbids: ["release-mbid-noisy-track-title"],
    },
  };

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [{
      providerId: "provider-album-noisy",
      title: "A Night at the Opera",
      quality: "HIRES_LOSSLESS",
      trackCount: 3,
      volumeCount: 1,
      tracks: [
        { mbid: null, isrc: null, title: "Death on Two Legs", track_number: 1, volume_number: 1, duration: 150 },
        { mbid: null, isrc: null, title: "Lazing on a Sunday Afternoon", track_number: 2, volume_number: 1, duration: 150 },
        { mbid: null, isrc: null, title: "Car Song provider Version", track_number: 3, volume_number: 1, duration: 150 },
      ],
    }],
    matches: new Map([["provider-album-noisy", match]]),
  });

  const slot = db.prepare(`
    SELECT selected_provider_id, selected_release_mbid
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { selected_provider_id: string | null; selected_release_mbid: string | null } | undefined;

  assert.ok(slot);
  assert.equal(slot.selected_provider_id, "provider-album-noisy");
  assert.equal(slot.selected_release_mbid, "release-mbid-noisy-track-title");
});

test("provider slot selection falls back to metadata matching when track details are missing", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-fallback";
  insertReleaseGroup(releaseGroupMbid);

  // Insert preferred MusicBrainz release
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-mbid-fallback", releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", 3, 1);

  // Insert Recordings
  const insertRecording = db.prepare(`
    INSERT INTO Recordings (mbid, title)
    VALUES (?, ?)
  `);
  insertRecording.run("rec-fb-1", "Death on Two Legs");
  insertRecording.run("rec-fb-2", "Lazing on a Sunday Afternoon");
  insertRecording.run("rec-fb-3", "I'm in Love with My Car");

  // Insert Tracks (3 tracks, so it won't be considered empty)
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertTrack.run("track-fb-1", "release-mbid-fallback", "rec-fb-1", "Death on Two Legs", 1, 1);
  insertTrack.run("track-fb-2", "release-mbid-fallback", "rec-fb-2", "Lazing on a Sunday Afternoon", 2, 1);
  insertTrack.run("track-fb-3", "release-mbid-fallback", "rec-fb-3", "I'm in Love with My Car", 3, 1);

  // Album metadata has a matching track count but no hydrated track rows —
  // strong shape evidence still allows the standalone metadata fallback.
  const match = {
    ...buildMatch(releaseGroupMbid, "provider-album-fallback"),
    confidence: 0.99,
    evidence: {
      ...buildMatch(releaseGroupMbid, "provider-album-fallback").evidence,
      trackCountMatched: true,
      volumeCountMatched: true,
      providerTrackCount: 3,
      targetTrackCount: 3,
      providerVolumeCount: 1,
      targetVolumeCount: 1,
      availableReleaseMbids: ["release-mbid-fallback"],
      matchedReleaseMbid: "release-mbid-fallback",
    },
  };

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [{
      providerId: "provider-album-fallback",
      title: "A Night at the Opera",
      quality: "LOSSLESS",
      trackCount: 3,
      volumeCount: 1,
    }],
    matches: new Map([["provider-album-fallback", match]]),
  });

  const slot = db.prepare(`
    SELECT selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { selected_provider_id: string | null } | undefined;

  assert.ok(slot);
  assert.equal(slot.selected_provider_id, "provider-album-fallback");
});

test("provider slot selection selects available digital release when require_provider_availability is true and vinyl is overall best representative", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-availability-vinyl-vs-digital";
  insertReleaseGroup(releaseGroupMbid);

  // Set require_provider_availability = true
  writeTestConfig({
    filtering: {
      require_provider_availability: true,
    },
  });

  // Insert vinyl release: Official, Vinyl format (which is not digital media, and has 15 tracks - ranked higher globally)
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-vinyl", releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", 15, 1);

  // Insert digital release: Official, Digital Media (available, has 12 tracks)
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("release-digital", releaseGroupMbid, "artist-mbid-1", "A Night at the Opera", "Official", "1975-11-21", 12, 1);

  db.prepare(`
    UPDATE AlbumReleases
    SET media = ?
    WHERE mbid = ?
  `).run(JSON.stringify([{ Position: 1, Format: "Digital Media" }]), "release-digital");

  // Insert Recordings for digital release
  const insertRecording = db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)");
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 1; i <= 12; i++) {
    insertRecording.run(`rec-avail-${i}`, `Track ${i}`, JSON.stringify([`ISRC_AVAIL_${i}`]));
    insertTrack.run(`track-avail-${i}`, "release-digital", `rec-avail-${i}`, `Track ${i}`, i, 1, 150000);
  }

  // provider offers matches only digital release
  const match = {
    ...buildMatch(releaseGroupMbid, "provider-album-digital"),
    evidence: {
      ...buildMatch(releaseGroupMbid, "provider-album-digital").evidence,
      targetTrackCount: 12,
      availableReleaseMbids: ["release-digital"],
    },
  };

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [{
      providerId: "provider-album-digital",
      title: "A Night at the Opera",
      quality: "LOSSLESS",
      trackCount: 12,
      volumeCount: 1,
      tracks: Array.from({ length: 12 }, (_, i) => ({
        mbid: `rec-avail-${i + 1}`,
        isrc: `ISRC_AVAIL_${i + 1}`,
        title: `Track ${i + 1}`,
        track_number: i + 1,
        volume_number: 1,
        duration: 150,
      })),
    }],
    matches: new Map([["provider-album-digital", match]]),
  });

  const slot = db.prepare(`
    SELECT selected_provider_id, selected_release_mbid
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { selected_provider_id: string | null; selected_release_mbid: string | null } | undefined;

  assert.ok(slot);
  assert.equal(slot.selected_provider_id, "provider-album-digital");
  assert.equal(slot.selected_release_mbid, "release-digital");

  // Restore config to default (false)
  writeTestConfig({
    filtering: {
      require_provider_availability: false,
    },
  });
});

test("provider album covering only the standard edition selects that edition instead of nothing", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-edition-fallback";
  insertReleaseGroup(releaseGroupMbid);

  // Deluxe release (3 tracks) outranks the standard (2 tracks) as representative.
  const insertRelease = db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRelease.run("release-deluxe-fb", releaseGroupMbid, "artist-mbid-1", "Opera (Deluxe)", "Official", "1975-11-21", 3, 1);
  insertRelease.run("release-standard-fb", releaseGroupMbid, "artist-mbid-1", "Opera", "Official", "1975-11-21", 2, 1);

  const insertRecording = db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)");
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertRecording.run("rec-edfb-1", "Track One", JSON.stringify(["FBISRC001"]));
  insertRecording.run("rec-edfb-2", "Track Two", JSON.stringify(["FBISRC002"]));
  insertRecording.run("rec-edfb-3", "Bonus Track", JSON.stringify(["FBISRC003"]));
  insertTrack.run("track-fb-d1", "release-deluxe-fb", "rec-edfb-1", "Track One", 1, 1);
  insertTrack.run("track-fb-d2", "release-deluxe-fb", "rec-edfb-2", "Track Two", 2, 1);
  insertTrack.run("track-fb-d3", "release-deluxe-fb", "rec-edfb-3", "Bonus Track", 3, 1);
  insertTrack.run("track-fb-s1", "release-standard-fb", "rec-edfb-1", "Track One", 1, 1);
  insertTrack.run("track-fb-s2", "release-standard-fb", "rec-edfb-2", "Track Two", 2, 1);

  // The provider only has the 2-track standard edition.
  const match = buildMatch(releaseGroupMbid, "provider-standard-fb");
  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "tidal",
      album: {
        providerId: "provider-standard-fb",
        title: "Opera",
        quality: "LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "FBISRC001", title: "Track One", track_number: 1, volume_number: 1, duration: null },
          { mbid: null, isrc: "FBISRC002", title: "Track Two", track_number: 2, volume_number: 1, duration: null },
        ],
      },
      match,
    },
  ]);

  // Previously the selector only validated against the representative (deluxe)
  // release and produced no selection at all, leaving the album "unavailable"
  // even though the standard edition is fully on the provider.
  assert.equal(selections.length, 1);
  assert.equal(selections[0]?.album.providerId, "provider-standard-fb");
  assert.equal(selections[0]?.match.releaseMbid, "release-standard-fb");
});

test("slot release follows the edition the chosen provider album actually covers", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-edition-binding";
  insertReleaseGroup(releaseGroupMbid);

  const insertRelease = db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRelease.run("release-deluxe-eb", releaseGroupMbid, "artist-mbid-1", "Opera (Deluxe)", "Official", "1975-11-21", 3, 1);
  insertRelease.run("release-standard-eb", releaseGroupMbid, "artist-mbid-1", "Opera", "Official", "1975-11-21", 2, 1);

  const insertRecording = db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)");
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertRecording.run("rec-eb-1", "Track One", JSON.stringify(["EBISRC001"]));
  insertRecording.run("rec-eb-2", "Track Two", JSON.stringify(["EBISRC002"]));
  insertRecording.run("rec-eb-3", "Bonus Track", JSON.stringify(["EBISRC003"]));
  insertTrack.run("track-eb-d1", "release-deluxe-eb", "rec-eb-1", "Track One", 1, 1);
  insertTrack.run("track-eb-d2", "release-deluxe-eb", "rec-eb-2", "Track Two", 2, 1);
  insertTrack.run("track-eb-d3", "release-deluxe-eb", "rec-eb-3", "Bonus Track", 3, 1);
  insertTrack.run("track-eb-s1", "release-standard-eb", "rec-eb-1", "Track One", 1, 1);
  insertTrack.run("track-eb-s2", "release-standard-eb", "rec-eb-2", "Track Two", 2, 1);

  // Both editions exist on the provider; the deluxe must win and the slot must
  // record the deluxe release MBID (not a re-derived representative).
  const standardMatch = buildMatch(releaseGroupMbid, "provider-standard-eb");
  const deluxeMatch = buildMatch(releaseGroupMbid, "provider-deluxe-eb");
  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "tidal",
      album: {
        providerId: "provider-standard-eb",
        title: "Opera",
        quality: "LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "EBISRC001", title: "Track One", track_number: 1, volume_number: 1, duration: null },
          { mbid: null, isrc: "EBISRC002", title: "Track Two", track_number: 2, volume_number: 1, duration: null },
        ],
      },
      match: standardMatch,
    },
    {
      provider: "tidal",
      album: {
        providerId: "provider-deluxe-eb",
        title: "Opera (Deluxe)",
        quality: "LOSSLESS",
        trackCount: 3,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "EBISRC001", title: "Track One", track_number: 1, volume_number: 1, duration: null },
          { mbid: null, isrc: "EBISRC002", title: "Track Two", track_number: 2, volume_number: 1, duration: null },
          { mbid: null, isrc: "EBISRC003", title: "Bonus Track", track_number: 3, volume_number: 1, duration: null },
        ],
      },
      match: deluxeMatch,
    },
  ]);

  assert.equal(selections.length, 1);
  assert.equal(selections[0]?.album.providerId, "provider-deluxe-eb");
  assert.equal(selections[0]?.match.releaseMbid, "release-deluxe-eb");
});

test("MusicBrainz parenthetical bonus-track suffixes do not break edition coverage", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-suffix-coverage";
  insertReleaseGroup(releaseGroupMbid);

  const insertRelease = db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Anniversary edition: MB titles the bonus disc with parenthetical qualifiers.
  insertRelease.run("release-anniv-sfx", releaseGroupMbid, "artist-mbid-1", "Opera X", "Official", "2023-07-14", 4, 2);
  insertRelease.run("release-standard-sfx", releaseGroupMbid, "artist-mbid-1", "Opera", "Official", "2013-03-04", 2, 1);

  const insertRecording = db.prepare("INSERT INTO Recordings (mbid, title, length_ms) VALUES (?, ?, ?)");
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertRecording.run("rec-sfx-1", "Track One", 200000);
  insertRecording.run("rec-sfx-2", "Track Two", 210000);
  insertRecording.run("rec-sfx-3", "Track One (demo)", 190000);
  insertRecording.run("rec-sfx-4", "Track Two (live from Unit 24)", 230000);
  insertTrack.run("track-sfx-a1", "release-anniv-sfx", "rec-sfx-1", "Track One", 1, 1, 200000);
  insertTrack.run("track-sfx-a2", "release-anniv-sfx", "rec-sfx-2", "Track Two", 2, 1, 210000);
  insertTrack.run("track-sfx-a3", "release-anniv-sfx", "rec-sfx-3", "Track One (demo)", 1, 2, 190000);
  insertTrack.run("track-sfx-a4", "release-anniv-sfx", "rec-sfx-4", "Track Two (live from Unit 24)", 2, 2, 230000);
  insertTrack.run("track-sfx-s1", "release-standard-sfx", "rec-sfx-1", "Track One", 1, 1, 200000);
  insertTrack.run("track-sfx-s2", "release-standard-sfx", "rec-sfx-2", "Track Two", 2, 1, 210000);

  // The provider carries both editions, but titles the bonus tracks plainly
  // (no "(demo)" / "(live ...)" suffixes). Durations confirm identity.
  const standardMatch = buildMatch(releaseGroupMbid, "provider-standard-sfx");
  const annivMatch = buildMatch(releaseGroupMbid, "provider-anniv-sfx");
  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "tidal",
      album: {
        providerId: "provider-standard-sfx",
        title: "Opera",
        quality: "LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: null, title: "Track One", track_number: 1, volume_number: 1, duration: 200 },
          { mbid: null, isrc: null, title: "Track Two", track_number: 2, volume_number: 1, duration: 210 },
        ],
      },
      match: standardMatch,
    },
    {
      provider: "tidal",
      album: {
        providerId: "provider-anniv-sfx",
        title: "Opera X (10th Anniversary Edition)",
        quality: "LOSSLESS",
        trackCount: 4,
        volumeCount: 2,
        tracks: [
          { mbid: null, isrc: null, title: "Track One", track_number: 1, volume_number: 1, duration: 200 },
          { mbid: null, isrc: null, title: "Track Two", track_number: 2, volume_number: 1, duration: 210 },
          { mbid: null, isrc: null, title: "Track One", track_number: 1, volume_number: 2, duration: 190 },
          { mbid: null, isrc: null, title: "Track Two", track_number: 2, volume_number: 2, duration: 230 },
        ],
      },
      match: annivMatch,
    },
  ]);

  // The anniversary edition is fully coverable and larger, so it must win even
  // though the standard edition is also fully covered by its own offer.
  assert.equal(selections.length, 1);
  assert.equal(selections[0]?.album.providerId, "provider-anniv-sfx");
  assert.equal(selections[0]?.match.releaseMbid, "release-anniv-sfx");
});

test("quality-aware coverage uses hi-res standard tracks and lossless deluxe-only tracks", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-back-to-black";
  const standardReleaseMbid = "release-back-to-black-standard";
  const deluxeReleaseMbid = "release-back-to-black-deluxe";
  insertReleaseGroup(releaseGroupMbid);

  const insertRelease = db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2006-10-27', ?, ?)
  `);
  insertRelease.run(standardReleaseMbid, releaseGroupMbid, "artist-mbid-1", "Back to Black", 2, 1);
  insertRelease.run(deluxeReleaseMbid, releaseGroupMbid, "artist-mbid-1", "Back to Black (Deluxe Edition)", 4, 2);

  const insertRecording = db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)");
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const [index, title, isrc] of [
    [1, "Rehab", "ISRCAMY001"],
    [2, "You Know I'm No Good", "ISRCAMY002"],
    [3, "Valerie", "ISRCAMY003"],
    [4, "Cupid", "ISRCAMY004"],
  ] as const) {
    insertRecording.run(`amy-rec-${index}`, title, JSON.stringify([isrc]));
    if (index <= 2) {
      insertTrack.run(`amy-standard-track-${index}`, standardReleaseMbid, `amy-rec-${index}`, title, index, 1);
    }
    insertTrack.run(`amy-deluxe-track-${index}`, deluxeReleaseMbid, `amy-rec-${index}`, title, index <= 2 ? index : index - 2, index <= 2 ? 1 : 2);
  }

  const standardMatch = {
    ...buildMatch(releaseGroupMbid, "tidal-standard-hires"),
    releaseMbid: standardReleaseMbid,
    evidence: {
      ...buildMatch(releaseGroupMbid, "tidal-standard-hires").evidence,
      availableReleaseMbids: [standardReleaseMbid],
    },
  };
  const deluxeMatch = {
    ...buildMatch(releaseGroupMbid, "tidal-deluxe-lossless"),
    releaseMbid: deluxeReleaseMbid,
    evidence: {
      ...buildMatch(releaseGroupMbid, "tidal-deluxe-lossless").evidence,
      availableReleaseMbids: [deluxeReleaseMbid],
    },
  };
  const providerTrack = (album: string, index: number, title: string, isrc: string) => ({
    mbid: null,
    providerId: `${album}-track-${index}`,
    isrc,
    title,
    track_number: index,
    volume_number: 1,
    duration: 180,
  });

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid: "artist-mbid-1",
    albums: [
      {
        providerId: "tidal-standard-hires",
        title: "Back to Black",
        quality: "HIRES_LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          providerTrack("tidal-standard-hires", 1, "Rehab", "ISRCAMY001"),
          providerTrack("tidal-standard-hires", 2, "You Know I'm No Good", "ISRCAMY002"),
        ],
      },
      {
        providerId: "tidal-deluxe-lossless",
        title: "Back to Black (Deluxe Edition)",
        quality: "LOSSLESS",
        trackCount: 4,
        volumeCount: 2,
        tracks: [
          providerTrack("tidal-deluxe-lossless", 1, "Rehab", "ISRCAMY001"),
          providerTrack("tidal-deluxe-lossless", 2, "You Know I'm No Good", "ISRCAMY002"),
          providerTrack("tidal-deluxe-lossless", 3, "Valerie", "ISRCAMY003"),
          providerTrack("tidal-deluxe-lossless", 4, "Cupid", "ISRCAMY004"),
        ],
      },
    ],
    matches: new Map([
      ["tidal-standard-hires", standardMatch],
      ["tidal-deluxe-lossless", deluxeMatch],
    ]),
  });

  const slot = db.prepare(`
    SELECT selected_provider_id, selected_release_mbid, quality, match_method, match_evidence
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as any;
  const evidence = JSON.parse(slot.match_evidence);

  assert.equal(slot.selected_provider_id, "tidal-standard-hires;tidal-deluxe-lossless");
  assert.equal(slot.selected_release_mbid, deluxeReleaseMbid);
  // Hybrid badge uses the majority track quality (tie → higher).
  assert.equal(slot.quality, "HIRES_LOSSLESS");
  assert.equal(slot.match_method, "quality_optimized_composite_track_coverage");
  assert.deepEqual(evidence.coverage.qualityTrackCounts, { HIRES_LOSSLESS: 2, LOSSLESS: 2 });
  assert.deepEqual(
    evidence.trackSources.map((source: any) => source.providerAlbumId),
    ["tidal-standard-hires", "tidal-standard-hires", "tidal-deluxe-lossless", "tidal-deluxe-lossless"],
  );
});

test("hybrid coverage cannot reuse one logical provider track through duplicate candidates", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-one-to-one-track-plan";
  const releaseMbid = "release-one-to-one-track-plan";
  insertReleaseGroup(releaseGroupMbid);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', 2, 1)
  `).run(releaseMbid, releaseGroupMbid, "artist-mbid-1", "Two Track EP");
  db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)")
    .run("one-to-one-rec-1", "First Song", JSON.stringify(["ONETOONE01"]));
  db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)")
    .run("one-to-one-rec-2", "Second Song", JSON.stringify(["ONETOONE02"]));
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  insertTrack.run("one-to-one-track-1", releaseMbid, "one-to-one-rec-1", "First Song", 1);
  insertTrack.run("one-to-one-track-2", releaseMbid, "one-to-one-rec-2", "Second Song", 2);

  const match = { ...buildMatch(releaseGroupMbid, "duplicate-provider-album"), releaseMbid };
  const duplicateCandidate = {
    provider: "tidal",
    album: {
      providerId: "duplicate-provider-album",
      title: "Two Track EP",
      quality: "LOSSLESS",
      trackCount: 1,
      volumeCount: 1,
      tracks: [{
        mbid: null,
        providerId: "only-provider-track",
        isrc: "ONETOONE01",
        title: "First Song",
        track_number: 1,
        volume_number: 1,
        duration: 180,
      }],
    },
    match,
  };
  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([duplicateCandidate, { ...duplicateCandidate }]);

  assert.equal(selections.length, 1);
  assert.equal(selections[0]?.match.method, "strict_partial_track_coverage");
  const evidence = selections[0]?.match.evidence as any;
  assert.equal(evidence.coverage.coveredTracks, 1);
  assert.equal(evidence.coverage.targetTracks, 2);
  assert.deepEqual(evidence.providerAlbumIds, ["duplicate-provider-album"]);
  assert.equal(evidence.trackSources.length, 1);
});

test("title-only matching does not confuse repeated vocal and instrumental recordings", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-repeated-instrumental-titles";
  const releaseMbid = "release-repeated-instrumental-titles";
  insertReleaseGroup(releaseGroupMbid);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', 2, 2)
  `).run(releaseMbid, releaseGroupMbid, "artist-mbid-1", "Album + Instrumentals");
  db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, '[]')")
    .run("vocal-recording", "Same Song");
  db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, '[]')")
    .run("instrumental-recording", "Same Song");
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, 1, ?)
  `);
  insertTrack.run("vocal-track", releaseMbid, "vocal-recording", "Same Song", 1);
  insertTrack.run("instrumental-track", releaseMbid, "instrumental-recording", "Same Song", 2);

  const match = {
    ...buildMatch(releaseGroupMbid, "vocal-provider-album"),
    releaseMbid,
    status: "candidate" as const,
  };
  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([{
    provider: "tidal",
    album: {
      providerId: "vocal-provider-album",
      title: "Album",
      quality: "LOSSLESS",
      trackCount: 1,
      volumeCount: 1,
      tracks: [{
        mbid: null,
        providerId: "vocal-provider-track",
        isrc: null,
        title: "Same Song",
        track_number: 1,
        volume_number: 1,
        duration: null,
      }],
    },
    match,
  }]);

  assert.deepEqual(selections, []);
});

test("equal-completeness editions: the higher-bit-depth (hi-res) release wins the stereo slot", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-hires-tiebreak";
  insertReleaseGroup(releaseGroupMbid);

  // Two editions of the same EP, same recordings, same track count. The 16-bit
  // release MBID deliberately sorts BEFORE the 24-bit one, reproducing the bug
  // where release order (not audio quality) decided the slot. Each provider
  // offer is UPC-bound to exactly one edition (distinct match.releaseMbid), so
  // neither offer can cross-cover the other edition.
  const release16 = "release-goosebumps-a16"; // sorts first
  const release24 = "release-goosebumps-b24"; // sorts second
  const insertRelease = db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRelease.run(release16, releaseGroupMbid, "artist-mbid-1", "Goosebumps EP", "Official", "2021-01-29", 2, 1);
  insertRelease.run(release24, releaseGroupMbid, "artist-mbid-1", "Goosebumps EP", "Official", "2021-01-29", 2, 1);

  const insertRecording = db.prepare("INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)");
  const insertTrack = db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertRecording.run("rec-goose-1", "Track One", JSON.stringify(["GBHR21000001"]));
  insertRecording.run("rec-goose-2", "Track Two", JSON.stringify(["GBHR21000002"]));
  // Both editions carry the same two recordings.
  insertTrack.run("track-goose-16a", release16, "rec-goose-1", "Track One", 1, 1);
  insertTrack.run("track-goose-16b", release16, "rec-goose-2", "Track Two", 2, 1);
  insertTrack.run("track-goose-24a", release24, "rec-goose-1", "Track One", 1, 1);
  insertTrack.run("track-goose-24b", release24, "rec-goose-2", "Track Two", 2, 1);

  const providerTracks = [
    { mbid: null, isrc: "GBHR21000001", title: "Track One", track_number: 1, volume_number: 1, duration: null },
    { mbid: null, isrc: "GBHR21000002", title: "Track Two", track_number: 2, volume_number: 1, duration: null },
  ];
  // 16-bit offer bound to the first-sorting edition; 24-bit to the second.
  const match16 = { ...buildMatch(releaseGroupMbid, "163897895"), releaseMbid: release16 };
  const match24 = { ...buildMatch(releaseGroupMbid, "163897909"), releaseMbid: release24 };
  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "tidal",
      album: {
        providerId: "163897895",
        title: "Goosebumps EP",
        quality: "LOSSLESS", // 16-bit
        trackCount: 2,
        volumeCount: 1,
        tracks: providerTracks,
      },
      match: match16,
    },
    {
      provider: "tidal",
      album: {
        providerId: "163897909",
        title: "Goosebumps EP",
        quality: "HIRES_LOSSLESS", // 24-bit
        trackCount: 2,
        volumeCount: 1,
        tracks: providerTracks,
      },
      match: match24,
    },
  ]);

  // Both editions are fully and equally covered; audio quality must break the
  // tie in favour of the 24-bit HIRES offer and bind the slot to its edition.
  const stereo = selections.find((selection) => selection.slot === "stereo");
  assert.ok(stereo, "expected a stereo slot selection");
  assert.equal(stereo?.album.providerId, "163897909");
  assert.equal(stereo?.match.releaseMbid, release24);
});

test("cross-RG HIRES single cannot steal World Gone Mad from the UPC-matched LOSSLESS original", () => {
  // Live Bastille failure: Distorted Light Beam (CamelPhat Remix) HIRES was
  // selected for World Gone Mad because cross-RG coverage + fuzzy track match
  // (same position, duration within 10s) beat the barcode-matched original.
  const { db } = dbModule;
  const artistMbid = "artist-bastille-wgm";
  const rgWgm = "10eccf64-c8b7-4dcd-9a4c-3597bf5d6a9e";
  const rgDlb = "aaf3e065-1a73-45f2-a0a8-312338d2de9b";
  const releaseWgm = "6851dc15-f540-41ee-85ca-887afc84cd03";
  const releaseDlb = "7df03d92-97f4-416c-99d6-18b10f07b44c";

  db.prepare(`INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run(artistMbid, "Bastille");
  db.prepare(`INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)`)
    .run(rgWgm, artistMbid, "World Gone Mad", "Single");
  db.prepare(`INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)`)
    .run(rgDlb, artistMbid, "Distorted Light Beam", "Single");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, barcode, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2017-11-09', '075679882431', 1, 1)
  `).run(releaseWgm, rgWgm, artistMbid, "World Gone Mad");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2021-06-23', 1, 1)
  `).run(releaseDlb, rgDlb, artistMbid, "Distorted Light Beam (CamelPhat Remix)");

  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, isrcs) VALUES (?, ?, ?, ?)`)
    .run("rec-wgm", artistMbid, "World Gone Mad", JSON.stringify(["USAT21704727"]));
  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, isrcs) VALUES (?, ?, ?, ?)`)
    .run("rec-dlb", artistMbid, "Distorted Light Beam", JSON.stringify(["GBUM72104671"]));
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 1, 1, 195000)`).run("t-wgm", releaseWgm, "rec-wgm", "World Gone Mad");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 1, 1, 186000)`).run("t-dlb", releaseDlb, "rec-dlb", "Distorted Light Beam");

  const matchWgm = {
    ...buildMatch(rgWgm, "80830544"),
    releaseMbid: releaseWgm,
    status: "verified" as const,
    confidence: 1,
    method: "musicbrainz-release-upc",
    evidence: {
      ...buildMatch(rgWgm, "80830544").evidence,
      providerTitle: "World Gone Mad (From Bright: The Album)",
      upcMatched: true,
      isrcOverlap: 1,
      isrcCoverageMatched: true,
      trackCountMatched: true,
      volumeCountMatched: true,
      targetTrackCount: 1,
      targetVolumeCount: 1,
      availableReleaseMbids: [releaseWgm],
      matchedReleaseMbid: releaseWgm,
    },
  };
  const matchDlb = {
    ...buildMatch(rgDlb, "192635951"),
    releaseMbid: releaseDlb,
    status: "verified" as const,
    confidence: 0.99,
    method: "musicbrainz-release-group-title-year-type-track-count",
    evidence: {
      ...buildMatch(rgDlb, "192635951").evidence,
      providerTitle: "Distorted Light Beam (CamelPhat Remix)",
      upcMatched: false,
      titleExpansionMatched: true,
      trackCountMatched: true,
      volumeCountMatched: true,
      targetTrackCount: 1,
      targetVolumeCount: 1,
      availableReleaseMbids: [releaseDlb],
      matchedReleaseMbid: releaseDlb,
    },
  };

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "tidal",
      album: {
        providerId: "80830544",
        title: "World Gone Mad (From Bright: The Album)",
        quality: "LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
        tracks: [{
          mbid: null,
          providerId: "80830545",
          isrc: "USAT21704727",
          title: "World Gone Mad",
          track_number: 1,
          volume_number: 1,
          duration: 196,
        }],
      },
      match: matchWgm,
    },
    {
      provider: "tidal",
      album: {
        providerId: "192635951",
        title: "Distorted Light Beam (CamelPhat Remix)",
        quality: "HIRES_LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
        tracks: [{
          mbid: null,
          providerId: "192635952",
          isrc: "GBUM72104671",
          title: "Distorted Light Beam",
          track_number: 1,
          volume_number: 1,
          duration: 186,
        }],
      },
      match: matchDlb,
    },
  ]);

  const wgmStereo = selections.find((selection) =>
    selection.releaseGroupMbid === rgWgm && selection.slot === "stereo"
  );
  assert.ok(wgmStereo, "expected a stereo slot for World Gone Mad");
  assert.equal(wgmStereo?.album.providerId, "80830544");
  assert.equal(wgmStereo?.match.releaseMbid, releaseWgm);
  assert.equal(wgmStereo?.album.quality, "LOSSLESS");

  const dlbStereo = selections.find((selection) =>
    selection.releaseGroupMbid === rgDlb && selection.slot === "stereo"
  );
  assert.ok(dlbStereo, "expected a stereo slot for Distorted Light Beam");
  assert.equal(dlbStereo?.album.providerId, "192635951");
});

test("empty SoundCloud stub without tracks does not fill a tracklisted slot", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-oph-pt2-empty-sc";
  insertReleaseGroup(releaseGroupMbid);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2012-12-06', 2, 1)
  `).run("release-oph-empty-sc", releaseGroupMbid, "artist-mbid-1", "Other People’s Heartache, Pt. 2");
  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title) VALUES (?, ?, ?)`)
    .run("rec-oph-1", "artist-mbid-1", "Tuning In");
  db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title) VALUES (?, ?, ?)`)
    .run("rec-oph-2", "artist-mbid-1", "Killer");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 1, 1, 62000)`).run("t-oph-1", "release-oph-empty-sc", "rec-oph-1", "Tuning In");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 2, 1, 181000)`).run("t-oph-2", "release-oph-empty-sc", "rec-oph-2", "Killer");

  const match = {
    ...buildMatch(releaseGroupMbid, "2881942"),
    status: "verified" as const,
    confidence: 0.97,
    method: "musicbrainz-release-title-year-type-track-count",
    evidence: {
      ...buildMatch(releaseGroupMbid, "2881942").evidence,
      trackCountMatched: false,
      volumeCountMatched: true,
      providerTrackCount: 0,
      targetTrackCount: 2,
      targetVolumeCount: 1,
    },
  };

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([{
    provider: "soundcloud",
    album: {
      providerId: "2881942",
      title: "OTHER PEOPLE'S HEARTACHE, PT. 2",
      quality: "SOUNDCLOUD_LOSSY",
      trackCount: 0,
      volumeCount: 1,
      tracks: [],
    },
    match,
  }]);

  assert.equal(selections.length, 0, "title-only SC stub must not select the stereo slot");
});

test("incomplete pure cross-RG partial cannot steal a monitored sibling tracklist", () => {
  // OPH Pt. 2 must not keep a 2/11 TIDAL tip stolen from Bad Blood X.
  const { db } = dbModule;
  const artistMbid = "artist-bastille-oph";
  const rgOph = "2d1c5d7d-56e3-4f7c-8194-d065595302d8";
  const rgBadBlood = "bf37b1a0-d94f-4230-b2c7-09b17f9f8a68";
  const releaseOph = "6085cdeb-aa4b-4d64-937b-4f22f8520546";
  const releaseBadBlood = "release-bad-blood-x";

  db.prepare(`INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run(artistMbid, "Bastille");
  db.prepare(`INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type, secondary_types)
              VALUES (?, ?, ?, ?, ?)`).run(rgOph, artistMbid, "Other People’s Heartache, Pt. 2", "EP", JSON.stringify(["Mixtape/Street"]));
  db.prepare(`INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type)
              VALUES (?, ?, ?, ?)`).run(rgBadBlood, artistMbid, "Bad Blood", "Album");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2012-12-06', 3, 1)
  `).run(releaseOph, rgOph, artistMbid, "Other People’s Heartache, Pt. 2");
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2023-01-01', 2, 1)
  `).run(releaseBadBlood, rgBadBlood, artistMbid, "Bad Blood X");

  for (const [rec, title, isrc] of [
    ["rec-oph-a", "Tuning In", null],
    ["rec-oph-b", "Dreams", "GBAAA1300203"],
    ["rec-oph-c", "No Angels", null],
  ] as const) {
    db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, isrcs) VALUES (?, ?, ?, ?)`)
      .run(rec, artistMbid, title, isrc ? JSON.stringify([isrc]) : null);
  }
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 1, 1, 62000)`).run("t-oph-a", releaseOph, "rec-oph-a", "Tuning In");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 2, 1, 259000)`).run("t-oph-b", releaseOph, "rec-oph-b", "Dreams");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 3, 1, 240000)`).run("t-oph-c", releaseOph, "rec-oph-c", "No Angels");

  // Mark Bad Blood monitored so this mirrors the live failure mode.
  db.prepare(`
    INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitored, selected_provider, selected_provider_id, match_status)
    VALUES (?, ?, 'stereo', 1, 'tidal', '320186059', 'verified')
  `).run(artistMbid, rgBadBlood);

  const matchOwnedByBadBlood = {
    ...buildMatch(rgBadBlood, "320186059"),
    releaseMbid: releaseBadBlood,
    status: "verified" as const,
    confidence: 0.99,
    method: "musicbrainz-recording-isrc",
    evidence: {
      ...buildMatch(rgBadBlood, "320186059").evidence,
      providerTitle: "Bad Blood X (10th Anniversary Edition)",
      isrcCoverageMatched: true,
      trackCountMatched: true,
      targetTrackCount: 2,
      availableReleaseMbids: [releaseBadBlood],
      matchedReleaseMbid: releaseBadBlood,
    },
  };

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      // Empty title shell matched to OPH — creates the OPH:stereo slot key so
      // cross-RG coverage can attempt to borrow Bad Blood X tips.
      provider: "soundcloud",
      album: {
        providerId: "2881942",
        title: "OTHER PEOPLE'S HEARTACHE, PT. 2",
        quality: "SOUNDCLOUD_LOSSY",
        trackCount: 0,
        volumeCount: 1,
        tracks: [],
      },
      match: {
        ...buildMatch(rgOph, "2881942"),
        status: "probable" as const,
        confidence: 0.9,
        method: "musicbrainz-release-title-year-type-track-count",
        evidence: {
          ...buildMatch(rgOph, "2881942").evidence,
          trackCountMatched: false,
          providerTrackCount: 0,
          targetTrackCount: 3,
        },
      },
    },
    {
      provider: "tidal",
      album: {
        providerId: "320186059",
        title: "Bad Blood X (10th Anniversary Edition)",
        quality: "LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          {
            mbid: null,
            providerId: "tidal-dreams",
            isrc: "GBAAA1300203",
            title: "Dreams",
            track_number: 1,
            volume_number: 1,
            duration: 259,
          },
          {
            mbid: null,
            providerId: "tidal-angels",
            isrc: null,
            title: "No Angels",
            track_number: 2,
            volume_number: 1,
            duration: 240,
          },
        ],
      },
      match: matchOwnedByBadBlood,
    },
  ]);

  const ophStereo = selections.find((selection) =>
    selection.releaseGroupMbid === rgOph && selection.slot === "stereo"
  );
  assert.equal(
    ophStereo,
    undefined,
    "pure cross-RG partial from Bad Blood X must not select OPH Pt. 2",
  );
});

test("cross-RG hybrid prefers the fuller MusicBrainz edition covered by two provider albums", () => {
  const { db } = dbModule;
  const artistMbid = "artist-bastille-hybrid";
  const rgThree = "b1b81699-4273-492e-a8ce-7fa98fac7a93";
  const rgTwo = "ac94d434-171e-4d3f-9e56-985869d569b2";
  const releaseOne = "36f2b40f-b46d-4f37-8931-02c487a7ad3e";
  const releaseThree = "fab7ff68-52e8-45e4-9218-c4eb369c4bc2";
  const releaseTwo = "03358ffb-95aa-4b21-b506-fd79cb0c838b";

  db.prepare(`INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES (?, ?)`).run(artistMbid, "Bastille");
  db.prepare(`INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)`)
    .run(rgThree, artistMbid, "Killing Me Softly With His Song (MTV Unplugged)", "Single");
  db.prepare(`INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type) VALUES (?, ?, ?, ?)`)
    .run(rgTwo, artistMbid, "Pompeii / Come As You Are (MTV Unplugged)", "Single");

  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2023-04-26', ?, 1)
  `).run(releaseOne, rgThree, artistMbid, "Killing Me Softly (1 track)", 1);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2023-04-26', ?, 1)
  `).run(releaseThree, rgThree, artistMbid, "Killing Me Softly (3 track)", 3);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2023-04-26', ?, 1)
  `).run(releaseTwo, rgTwo, artistMbid, "Pompeii / Come As You Are", 2);

  for (const [recording, title, isrc] of [
    ["rec-softly", "Killing Me Softly With His Song", "GBUM72302334"],
    ["rec-pompeii", "Pompeii", "GBUM72302279"],
    ["rec-nirvana", "Come as You Are", "GBUM72302277"],
  ] as const) {
    db.prepare(`INSERT INTO Recordings (mbid, artist_mbid, title, isrcs) VALUES (?, ?, ?, ?)`)
      .run(recording, artistMbid, title, JSON.stringify([isrc]));
  }

  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 1, 1, 299000)`).run("t-one-1", releaseOne, "rec-softly", "Killing Me Softly With His Song");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 1, 1, 299000)`).run("t-three-1", releaseThree, "rec-softly", "Killing Me Softly With His Song");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 2, 1, 269000)`).run("t-three-2", releaseThree, "rec-pompeii", "Pompeii");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 3, 1, 231000)`).run("t-three-3", releaseThree, "rec-nirvana", "Come as You Are");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 1, 1, 269000)`).run("t-two-1", releaseTwo, "rec-pompeii", "Pompeii");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 2, 1, 231000)`).run("t-two-2", releaseTwo, "rec-nirvana", "Come as You Are");

  const matchThin = {
    ...buildMatch(rgThree, "290132977"),
    releaseMbid: releaseOne,
    releaseGroup: {
      ...buildMatch(rgThree, "290132977").releaseGroup!,
      mbid: rgThree,
      title: "Killing Me Softly With His Song (MTV Unplugged)",
      primaryType: "Single",
    },
  };
  const matchOther = {
    ...buildMatch(rgTwo, "287367980"),
    releaseMbid: releaseTwo,
    releaseGroup: {
      ...buildMatch(rgTwo, "287367980").releaseGroup!,
      mbid: rgTwo,
      title: "Pompeii / Come As You Are (MTV Unplugged)",
      primaryType: "Single",
    },
  };

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "tidal",
    artistMbid,
    albums: [
      {
        providerId: "290132977",
        title: "Killing Me Softly With His Song (MTV Unplugged / Edit)",
        quality: "HIRES_LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "GBUM72302334", title: "Killing Me Softly With His Song", track_number: 1, volume_number: 1, duration: 299, providerId: "trk-softly" },
        ],
      },
      {
        providerId: "287367980",
        title: "Pompeii / Come As You Are (MTV Unplugged)",
        quality: "HIRES_LOSSLESS",
        trackCount: 2,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "GBUM72302279", title: "Pompeii", track_number: 1, volume_number: 1, duration: 269, providerId: "trk-pompeii" },
          { mbid: null, isrc: "GBUM72302277", title: "Come as You Are", track_number: 2, volume_number: 1, duration: 231, providerId: "trk-nirvana" },
        ],
      },
    ],
    matches: new Map([
      ["290132977", matchThin],
      ["287367980", matchOther],
    ]),
  });

  const threeTrackSlot = db.prepare(`
    SELECT selected_provider_id, selected_release_mbid, match_method, match_evidence
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(rgThree) as {
    selected_provider_id: string;
    selected_release_mbid: string;
    match_method: string;
    match_evidence: string;
  };

  assert.equal(threeTrackSlot.selected_release_mbid, releaseThree);
  assert.equal(threeTrackSlot.selected_provider_id, "290132977;287367980");
  assert.equal(threeTrackSlot.match_method, "quality_optimized_composite_track_coverage");

  const evidence = JSON.parse(threeTrackSlot.match_evidence) as {
    trackSources?: Array<{ providerAlbumId?: string; providerTrackId?: string }>;
  };
  assert.ok(Array.isArray(evidence.trackSources));
  assert.equal(evidence.trackSources?.length, 3);
  assert.deepEqual(
    [...new Set(evidence.trackSources?.map((source) => source.providerAlbumId))].sort(),
    ["287367980", "290132977"],
  );
});

test("incomplete multi-album stitch loses to a complete smaller edition (Amy Complete Version case)", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-amy-complete";
  insertReleaseGroup(releaseGroupMbid);

  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2006-10-27', ?, 1)
  `).run("release-standard-11", releaseGroupMbid, "artist-mbid-1", "Back to Black", 11);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, date, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', '2007-01-01', ?, 1)
  `).run("release-complete-27", releaseGroupMbid, "artist-mbid-1", "Back to Black (Complete Version)", 27);

  for (let i = 1; i <= 27; i++) {
    const rec = `rec-amy-${i}`;
    const isrc = `ISRCAMY${String(i).padStart(3, "0")}`;
    db.prepare(`INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)`)
      .run(rec, `Track ${i}`, JSON.stringify([isrc]));
    if (i <= 11) {
      db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
                  VALUES (?, 'release-standard-11', ?, ?, ?, 1)`)
        .run(`track-std-${i}`, rec, `Track ${i}`, i);
    }
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
                VALUES (?, 'release-complete-27', ?, ?, ?, 1)`)
      .run(`track-cmp-${i}`, rec, `Track ${i}`, i);
  }

  // Five provider albums together cover 22/27 of the complete edition (incomplete
  // hybrid), while one album covers the standard 11/11 completely.
  const partialAlbums = [1, 2, 3, 4, 5].map((albumIndex) => {
    const start = (albumIndex - 1) * 4 + 1;
    const end = Math.min(start + 4, 22); // 5 albums → tracks 1..22
    const tracks = [];
    for (let i = start; i <= end; i++) {
      tracks.push({
        mbid: `rec-amy-${i}`,
        isrc: `ISRCAMY${String(i).padStart(3, "0")}`,
        title: `Track ${i}`,
        track_number: i - start + 1,
        volume_number: 1,
        duration: 150,
      });
    }
    return {
      providerId: `apple-partial-${albumIndex}`,
      title: `Partial ${albumIndex}`,
      quality: "LOSSLESS",
      trackCount: tracks.length,
      volumeCount: 1,
      tracks,
    };
  });

  const standardAlbum = {
    providerId: "apple-standard-11",
    title: "Back to Black",
    quality: "HIRES_LOSSLESS",
    trackCount: 11,
    volumeCount: 1,
    tracks: Array.from({ length: 11 }, (_, index) => {
      const i = index + 1;
      return {
        mbid: `rec-amy-${i}`,
        isrc: `ISRCAMY${String(i).padStart(3, "0")}`,
        title: `Track ${i}`,
        track_number: i,
        volume_number: 1,
        duration: 150,
      };
    }),
  };

  const albums = [...partialAlbums, standardAlbum];
  const matches = new Map(albums.map((album) => [album.providerId, buildMatch(releaseGroupMbid, album.providerId)]));

  slotServiceModule.ReleaseGroupSlotService.syncProviderAlbumSelections({
    provider: "apple-music",
    artistMbid: "artist-mbid-1",
    albums,
    matches,
  });

  const slot = db.prepare(`
    SELECT selected_provider_id, selected_release_mbid, match_method, match_evidence
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as {
    selected_provider_id: string;
    selected_release_mbid: string;
    match_method: string;
    match_evidence: string;
  };

  assert.equal(slot.selected_provider_id, "apple-standard-11");
  assert.equal(slot.selected_release_mbid, "release-standard-11");
  assert.equal(String(slot.selected_provider_id).includes(";"), false);
  const coverage = JSON.parse(slot.match_evidence).coverage as { coveredTracks: number; targetTracks: number; complete: boolean };
  assert.equal(coverage.complete, true);
  assert.equal(coverage.coveredTracks, 11);
  assert.equal(coverage.targetTracks, 11);
});

test("same-release complete TIDAL MAX hybrid beats Apple HIGH hybrid (and beats Apple HIGH direct)", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-bastille-quality";
  const releaseMbid = "release-bastille-quality";
  insertReleaseGroup(releaseGroupMbid);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', 3, 1)
  `).run(releaseMbid, releaseGroupMbid, "artist-mbid-1", "Three Track EP");

  for (const [i, title, isrc] of [
    [1, "Track One", "ISRCQUAL001"],
    [2, "Track Two", "ISRCQUAL002"],
    [3, "Track Three", "ISRCQUAL003"],
  ] as const) {
    db.prepare(`INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)`)
      .run(`rec-qual-${i}`, title, JSON.stringify([isrc]));
    db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
                VALUES (?, ?, ?, ?, ?, 1)`)
      .run(`track-qual-${i}`, releaseMbid, `rec-qual-${i}`, title, i);
  }

  const tidalHybridA = {
    providerId: "tidal-hybrid-a",
    title: "Part A",
    quality: "HIRES_LOSSLESS",
    trackCount: 1,
    volumeCount: 1,
    tracks: [
      { mbid: null, isrc: "ISRCQUAL001", title: "Track One", track_number: 1, volume_number: 1, duration: 180, providerId: "tidal-t1" },
    ],
  };
  const tidalHybridB = {
    providerId: "tidal-hybrid-b",
    title: "Part B",
    quality: "HIRES_LOSSLESS",
    trackCount: 2,
    volumeCount: 1,
    tracks: [
      { mbid: null, isrc: "ISRCQUAL002", title: "Track Two", track_number: 1, volume_number: 1, duration: 180, providerId: "tidal-t2" },
      { mbid: null, isrc: "ISRCQUAL003", title: "Track Three", track_number: 2, volume_number: 1, duration: 180, providerId: "tidal-t3" },
    ],
  };
  const appleDirect = {
    providerId: "apple-direct-high",
    title: "Three Track EP",
    quality: "HIGH",
    trackCount: 3,
    volumeCount: 1,
    tracks: [
      { mbid: null, isrc: "ISRCQUAL001", title: "Track One", track_number: 1, volume_number: 1, duration: 180, providerId: "apple-t1" },
      { mbid: null, isrc: "ISRCQUAL002", title: "Track Two", track_number: 2, volume_number: 1, duration: 180, providerId: "apple-t2" },
      { mbid: null, isrc: "ISRCQUAL003", title: "Track Three", track_number: 3, volume_number: 1, duration: 180, providerId: "apple-t3" },
    ],
  };

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "tidal",
      album: tidalHybridA,
      match: { ...buildMatch(releaseGroupMbid, "tidal-hybrid-a"), releaseMbid },
    },
    {
      provider: "tidal",
      album: tidalHybridB,
      match: { ...buildMatch(releaseGroupMbid, "tidal-hybrid-b"), releaseMbid },
    },
    {
      provider: "apple-music",
      album: appleDirect,
      match: { ...buildMatch(releaseGroupMbid, "apple-direct-high"), releaseMbid },
    },
  ]);

  const stereo = selections.find((selection) => selection.slot === "stereo");
  assert.ok(stereo);
  assert.equal(stereo?.provider, "tidal");
  assert.equal(stereo?.album.providerId, "tidal-hybrid-a;tidal-hybrid-b");
  assert.equal(stereo?.album.quality, "HIRES_LOSSLESS");
  assert.equal(stereo?.match.method, "quality_optimized_composite_track_coverage");
});

test("title-only soundtrack tracks cannot complete a hybrid without catalog ISRC", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-soundtrack-fuzzy";
  const releaseMbid = "release-studio-edition";
  insertReleaseGroup(releaseGroupMbid);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', 2, 1)
  `).run(releaseMbid, releaseGroupMbid, "artist-mbid-1", "Studio Album");

  // Catalog has no ISRCs (Servarr-style) — hybrid must not form from title matches.
  db.prepare(`INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, '[]')`).run("rec-studio-1", "Rehab");
  db.prepare(`INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, '[]')`).run("rec-studio-2", "Valerie");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 1, 1, 180000)`).run("track-studio-1", releaseMbid, "rec-studio-1", "Rehab");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position, length_ms)
              VALUES (?, ?, ?, ?, 2, 1, 180000)`).run("track-studio-2", releaseMbid, "rec-studio-2", "Valerie");

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "apple-music",
      album: {
        providerId: "apple-ost-part",
        title: "Amy Motion Picture Soundtrack",
        quality: "HIRES_LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: null, title: "Rehab", track_number: 1, volume_number: 1, duration: 180, providerId: "ost-1" },
        ],
      },
      match: { ...buildMatch(releaseGroupMbid, "apple-ost-part"), releaseMbid },
    },
    {
      provider: "apple-music",
      album: {
        providerId: "apple-ost-part-2",
        title: "Amy Motion Picture Soundtrack Vol 2",
        quality: "HIRES_LOSSLESS",
        trackCount: 1,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: null, title: "Valerie", track_number: 1, volume_number: 1, duration: 180, providerId: "ost-2" },
        ],
      },
      match: { ...buildMatch(releaseGroupMbid, "apple-ost-part-2"), releaseMbid },
    },
  ]);

  const stereo = selections.find((selection) => selection.slot === "stereo");
  // No ISRC hybrid: at best a single-album title partial, never a complete multi-album stitch.
  assert.ok(stereo);
  assert.equal(String(stereo?.album.providerId || "").includes(";"), false);
  assert.notEqual(stereo?.match.method, "quality_optimized_composite_track_coverage");
  const evidence = stereo?.match.evidence as { matchKind?: string; coverage?: { complete?: boolean } };
  assert.notEqual(evidence?.matchKind, "composite");
  assert.notEqual(evidence?.coverage?.complete, true);
});

test("hybrid prefers explicit member albums and surfaces explicit on the stitch", () => {
  const { db } = dbModule;
  const releaseGroupMbid = "rg-mbid-hybrid-explicit";
  const releaseMbid = "release-hybrid-explicit";
  insertReleaseGroup(releaseGroupMbid);
  db.prepare(`
    INSERT INTO AlbumReleases (mbid, release_group_mbid, artist_mbid, title, status, track_count, media_count)
    VALUES (?, ?, ?, ?, 'Official', 2, 1)
  `).run(releaseMbid, releaseGroupMbid, "artist-mbid-1", "Explicit Hybrid");

  db.prepare(`INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)`)
    .run("rec-hex-1", "Rehab", JSON.stringify(["ISRCHEX001"]));
  db.prepare(`INSERT INTO Recordings (mbid, title, isrcs) VALUES (?, ?, ?)`)
    .run("rec-hex-2", "Valerie", JSON.stringify(["ISRCHEX002"]));
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
              VALUES (?, ?, ?, ?, 1, 1)`).run("track-hex-1", releaseMbid, "rec-hex-1", "Rehab");
  db.prepare(`INSERT INTO Tracks (mbid, release_mbid, recording_mbid, title, position, medium_position)
              VALUES (?, ?, ?, ?, 2, 1)`).run("track-hex-2", releaseMbid, "rec-hex-2", "Valerie");

  const selections = slotServiceModule.selectReleaseGroupSlotAlbums([
    {
      provider: "apple-music",
      album: {
        providerId: "apple-clean-part",
        title: "Clean Part",
        quality: "LOSSLESS",
        explicit: false,
        trackCount: 1,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "ISRCHEX001", title: "Rehab", track_number: 1, volume_number: 1, duration: 180, providerId: "c1" },
        ],
      },
      match: { ...buildMatch(releaseGroupMbid, "apple-clean-part"), releaseMbid },
    },
    {
      provider: "apple-music",
      album: {
        providerId: "apple-explicit-part",
        title: "Explicit Part",
        quality: "LOSSLESS",
        explicit: true,
        trackCount: 1,
        volumeCount: 1,
        tracks: [
          { mbid: null, isrc: "ISRCHEX002", title: "Valerie", track_number: 1, volume_number: 1, duration: 180, providerId: "e1" },
        ],
      },
      match: { ...buildMatch(releaseGroupMbid, "apple-explicit-part"), releaseMbid },
    },
  ], { preferExplicit: true });

  const stereo = selections.find((selection) => selection.slot === "stereo");
  assert.ok(stereo);
  assert.equal(String(stereo?.album.providerId || "").includes(";"), true);
  assert.equal(stereo?.album.explicit, true);
  assert.equal((stereo?.match.evidence as { explicit?: boolean | null })?.explicit, true);
});
