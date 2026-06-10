import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-refresh-artist-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let refreshServiceModule: typeof import("./refresh-artist-service.js");

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  refreshServiceModule = await import("./refresh-artist-service.js");
});

beforeEach(() => {
  dbModule.db.prepare("DELETE FROM ProviderItems").run();
  dbModule.db.prepare("DELETE FROM ReleaseGroupSlots").run();
  dbModule.db.prepare("DELETE FROM Tracks").run();
  dbModule.db.prepare("DELETE FROM Recordings").run();
  dbModule.db.prepare("DELETE FROM AlbumReleases").run();
  dbModule.db.prepare("DELETE FROM ArtistReleaseGroups").run();
  dbModule.db.prepare("DELETE FROM Albums").run();
  dbModule.db.prepare("DELETE FROM Artists").run();
  dbModule.db.prepare("DELETE FROM ArtistMetadata").run();
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("unmatched provider offers retain discovery provenance without claiming canonical ownership", () => {
  const artistMbid = "artist-mbid-bastille";
  const album = {
    provider_id: "314738795",
    title: "Happier",
    artist_name: "Marshmello & Bastille",
    quality: "LOSSLESS",
  };

  (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "tidal",
    artistMbid,
    [album],
    new Map(),
  );

  const row = dbModule.db.prepare(`
    SELECT artist_mbid, release_group_mbid, match_status, data
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = ?
  `).get(album.provider_id) as {
    artist_mbid: string | null;
    release_group_mbid: string | null;
    match_status: string;
    data: string;
  };

  assert.equal(row.artist_mbid, null);
  assert.equal(row.release_group_mbid, null);
  assert.equal(row.match_status, "unmatched");
  assert.equal(JSON.parse(row.data).discoveredFromArtistMbid, artistMbid);
});

test("matched provider offers attach to the canonical MusicBrainz artist and release group", () => {
  const artistMbid = "artist-mbid-bastille";
  const album = {
    provider_id: "provider-album-1",
    title: "Doom Days",
    artist_name: "Bastille",
    quality: "LOSSLESS",
  };

  (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "tidal",
    artistMbid,
    [album],
    new Map([
      [album.provider_id, {
        providerId: album.provider_id,
        status: "verified",
        confidence: 1,
        method: "musicbrainz-release-upc",
        releaseMbid: "release-mbid-1",
        releaseGroup: {
          mbid: "release-group-mbid-1",
          title: "Doom Days",
        },
        evidence: {
          providerTitle: "Doom Days",
        },
      }],
    ]),
  );

  const row = dbModule.db.prepare(`
    SELECT artist_mbid, release_group_mbid, release_mbid, match_status
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = ?
  `).get(album.provider_id) as {
    artist_mbid: string | null;
    release_group_mbid: string | null;
    release_mbid: string | null;
    match_status: string;
  };

  assert.equal(row.artist_mbid, artistMbid);
  assert.equal(row.release_group_mbid, "release-group-mbid-1");
  assert.equal(row.release_mbid, "release-mbid-1");
  assert.equal(row.match_status, "verified");
});

test("matched provider offers persist the best compatible MusicBrainz release version", () => {
  const artistMbid = "artist-mbid-bastille";
  const releaseGroupMbid = "release-group-gmtf";
  const standardReleaseMbid = "release-gmtf-standard";
  const expandedReleaseMbid = "release-gmtf-expanded";
  const album = {
    provider_id: "tidal-expanded",
    title: "Give Me The Future + Dreams Of The Past",
    artist_name: "Bastille",
    quality: "HIRES_LOSSLESS",
  };

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "Give Me the Future", "Album", "2022-02-04");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count
    ) VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    standardReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future",
    "Official",
    JSON.stringify(["XW"]),
    "2022-02-04",
    1,
    13,
    expandedReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future + Dreams of the Past",
    "Official",
    JSON.stringify(["XW"]),
    "2022-08-26",
    3,
    27,
  );

  (refreshServiceModule.RefreshArtistService as any).storeProviderAlbumOffers(
    "tidal",
    artistMbid,
    [album],
    new Map([
      [album.provider_id, {
        providerId: album.provider_id,
        status: "verified",
        confidence: 1,
        method: "musicbrainz-release-group-title-year-type-track-count",
        releaseMbid: null,
        releaseGroup: {
          mbid: releaseGroupMbid,
          title: "Give Me the Future",
        },
        evidence: {
          providerTitle: "Give Me The Future + Dreams Of The Past",
          availableReleaseMbids: [standardReleaseMbid, expandedReleaseMbid],
        },
      }],
    ]),
  );

  const row = dbModule.db.prepare(`
    SELECT release_group_mbid, release_mbid, match_status
    FROM ProviderItems
    WHERE provider = 'tidal' AND entity_type = 'album' AND provider_id = ?
  `).get(album.provider_id) as {
    release_group_mbid: string | null;
    release_mbid: string | null;
    match_status: string;
  };

  assert.equal(row.release_group_mbid, releaseGroupMbid);
  assert.equal(row.release_mbid, expandedReleaseMbid);
  assert.equal(row.match_status, "verified");
});

test("stored matched provider offers rebuild release-group slot selections without broad hydration", () => {
  const artistMbid = "artist-mbid-bastille";
  const releaseGroupMbid = "release-group-gmtf";
  const releaseMbid = "release-gmtf-expanded";
  const providerAlbumId = "tidal-gmtf-expanded";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bastille");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run(artistMbid, "Bastille", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "Give Me the Future", "Album", "2022-02-04");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    releaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Give Me the Future + Dreams of the Past",
    "Official",
    JSON.stringify(["XW"]),
    "2022-08-26",
    3,
    27,
  );
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, quality, release_date,
      artist_mbid, release_group_mbid, release_mbid,
      match_status, match_confidence, match_method, match_evidence, data
    ) VALUES (?, 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    providerAlbumId,
    "Give Me The Future + Dreams Of The Past",
    "HIRES_LOSSLESS",
    "2022-08-26",
    artistMbid,
    releaseGroupMbid,
    releaseMbid,
    "verified",
    1,
    "musicbrainz-release-group-title-year-type-track-count",
    JSON.stringify({
      providerTitle: "Give Me The Future + Dreams Of The Past",
      candidateTitle: "give me the future",
      titleScore: 1,
      titleExpansionMatched: true,
      typeMatched: true,
      yearMatched: true,
      trackCountMatched: true,
      volumeCountMatched: true,
      providerTrackCount: 27,
      targetTrackCount: 27,
      providerVolumeCount: 3,
      targetVolumeCount: 3,
      matchedReleaseMbid: releaseMbid,
      availableReleaseMbids: [releaseMbid],
    }),
    JSON.stringify({ quality: "HIRES_LOSSLESS" }),
  );

  const counts = (refreshServiceModule.RefreshArtistService as any)
    .syncProviderSelectionsFromStoredOffers(artistMbid);

  assert.deepEqual(counts, { stereo: 1, spatial: 0 });

  const slot = dbModule.db.prepare(`
    SELECT selected_provider, selected_provider_id, selected_release_mbid, match_status
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as {
    selected_provider: string | null;
    selected_provider_id: string | null;
    selected_release_mbid: string | null;
    match_status: string | null;
  };

  assert.equal(slot.selected_provider, "tidal");
  assert.equal(slot.selected_provider_id, providerAlbumId);
  assert.equal(slot.selected_release_mbid, releaseMbid);
  assert.equal(slot.match_status, "verified");
});

test("stored matched provider offers repair an unmatched slot for a representative release", () => {
  const artistMbid = "artist-mbid-bakermat";
  const releaseGroupMbid = "release-group-teach-me";
  const representativeReleaseMbid = "release-teach-me-3-track";
  const shorterReleaseMbid = "release-teach-me-radio-edit";

  dbModule.db.prepare("INSERT INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, "Bakermat");
  dbModule.db.prepare("INSERT INTO Artists (id, name, mbid) VALUES (?, ?, ?)")
    .run(artistMbid, "Bakermat", artistMbid);
  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(releaseGroupMbid, artistMbid, "Teach Me", "Single", "2015-02-06");
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    representativeReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Teach Me",
    "Official",
    JSON.stringify(["Belgium", "Luxembourg", "Netherlands"]),
    "2015-02-06",
    1,
    3,
  );
  dbModule.db.prepare(`
    INSERT INTO AlbumReleases (
      mbid, release_group_mbid, artist_mbid, title, status, country, date, media_count, track_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    shorterReleaseMbid,
    releaseGroupMbid,
    artistMbid,
    "Teach Me (MK Remix)",
    "Official",
    JSON.stringify(["Netherlands"]),
    "2015-02-13",
    1,
    1,
  );
  dbModule.db.prepare(`
    INSERT INTO ReleaseGroupSlots (artist_mbid, release_group_mbid, slot, monitored, match_status)
    VALUES (?, ?, 'stereo', 0, 'unmatched')
  `).run(artistMbid, releaseGroupMbid);
  dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, quality, release_date,
      artist_mbid, release_group_mbid, release_mbid,
      match_status, match_confidence, match_method, match_evidence, data
    ) VALUES
      (?, 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
      (?, 'album', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "tidal",
    "40775426",
    "Teach Me",
    "LOSSLESS",
    "2015-02-06",
    artistMbid,
    releaseGroupMbid,
    representativeReleaseMbid,
    "verified",
    1,
    "musicbrainz-release-group-title-year-type-track-count",
    JSON.stringify({
      providerTitle: "Teach Me",
      providerReleaseDate: "2015-02-06",
      providerType: "EP",
      typeMatched: false,
      trackCountMatched: true,
      volumeCountMatched: true,
      providerTrackCount: 3,
      targetTrackCount: 3,
      providerVolumeCount: 1,
      targetVolumeCount: 1,
      matchedReleaseMbid: representativeReleaseMbid,
      availableReleaseMbids: [representativeReleaseMbid],
    }),
    JSON.stringify({ quality: "LOSSLESS", num_tracks: 3, num_volumes: 1 }),
    "tidal",
    "38984935",
    "Teach Me (Radio Edit)",
    "LOSSLESS",
    "2014-12-19",
    artistMbid,
    releaseGroupMbid,
    shorterReleaseMbid,
    "probable",
    1,
    "musicbrainz-release-group-title-year-type-track-count",
    JSON.stringify({
      providerTitle: "Teach Me (Radio Edit)",
      providerReleaseDate: "2014-12-19",
      providerType: "SINGLE",
      typeMatched: true,
      trackCountMatched: true,
      volumeCountMatched: true,
      providerTrackCount: 1,
      targetTrackCount: 1,
      providerVolumeCount: 1,
      targetVolumeCount: 1,
      matchedReleaseMbid: shorterReleaseMbid,
      availableReleaseMbids: [shorterReleaseMbid],
    }),
    JSON.stringify({ quality: "LOSSLESS", num_tracks: 1, num_volumes: 1 }),
  );

  const counts = refreshServiceModule.RefreshArtistService
    .syncProviderSelectionsFromStoredOffers(artistMbid);

  assert.deepEqual(counts, { stereo: 1, spatial: 0 });

  const slot = dbModule.db.prepare(`
    SELECT selected_provider, selected_provider_id, selected_release_mbid, match_status
    FROM ReleaseGroupSlots
    WHERE release_group_mbid = ? AND slot = 'stereo'
  `).get(releaseGroupMbid) as {
    selected_provider: string | null;
    selected_provider_id: string | null;
    selected_release_mbid: string | null;
    match_status: string | null;
  };

  assert.equal(slot.selected_provider, "tidal");
  assert.equal(slot.selected_provider_id, "40775426");
  assert.equal(slot.selected_release_mbid, representativeReleaseMbid);
  assert.equal(slot.match_status, "verified");
});
