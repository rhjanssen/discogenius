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
