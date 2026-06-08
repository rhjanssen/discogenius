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
let configModule: typeof import("./config.js");
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
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  configModule = await import("./config.js");
  slotServiceModule = await import("./release-group-slot-service.js");
  writeTestConfig();
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM ReleaseGroupSlots").run();
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

test("provider slot clearing preserves selections for providers that were not refreshed", () => {
  const { db } = dbModule;
  insertReleaseGroup("rg-mbid-apple");
  insertReleaseGroup("rg-mbid-tidal");

  const insertSlot = db.prepare(`
    INSERT INTO ReleaseGroupSlots (
      artist_mbid, release_group_mbid, slot, wanted, selected_provider, selected_provider_id, match_status
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
    SELECT wanted, selected_provider_id
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
    SELECT wanted, selected_provider, selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { wanted: number; selected_provider: string | null; selected_provider_id: string | null };

  assert.equal(slot.selected_provider, "tidal");
  // It should select the combined provider ID separated by semicolon!
  assert.equal(slot.selected_provider_id, "prov-album-a;prov-album-b");
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
    SELECT selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { selected_provider_id: string | null } | undefined;

  assert.equal(slot, undefined);
});

test("provider slot selection rejects a high quality partial release when target tracks are missing", () => {
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
    SELECT selected_provider_id
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as { selected_provider_id: string | null } | undefined;

  assert.equal(slot, undefined);
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
    INSERT INTO AlbumReleaseMedia (release_mbid, format, position)
    VALUES (?, ?, ?)
  `).run("release-mbid-noisy-track-title", "Digital Media", 1);

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
        { mbid: null, isrc: null, title: "Car Song Provider Version", track_number: 3, volume_number: 1, duration: 150 },
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

  const match = buildMatch(releaseGroupMbid, "provider-album-fallback");

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
    INSERT INTO AlbumReleaseMedia (release_mbid, format, position)
    VALUES (?, ?, ?)
  `).run("release-digital", "Digital Media", 1);

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
