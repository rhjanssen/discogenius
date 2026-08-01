import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { seedSelectedAcquisitionPlan } from "../test-support/acquisition-plan-fixture.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-search-route-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.search.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../database.js");
let searchRouter: typeof import("./search.js").default;

before(async () => {
  dbModule = await import("../database.js");
  dbModule.initDatabase();
  searchRouter = (await import("./search.js")).default;
});

beforeEach(() => {
  const { db } = dbModule;
  db.prepare("DELETE FROM TrackFiles").run();
  db.prepare("DELETE FROM AcquisitionPlanTracks").run();
  db.prepare("DELETE FROM AcquisitionPlanSources").run();
  // Release the deferred plan reference before its rows go.
  db.prepare("UPDATE LibraryEditions SET preferred_plan_key = NULL").run();
  db.prepare("DELETE FROM AcquisitionPlans").run();
  db.prepare("DELETE FROM LibraryEditions").run();
  db.prepare("DELETE FROM LibraryAlbums").run();
  db.prepare("DELETE FROM ProviderTrackMatches").run();
  db.prepare("DELETE FROM ProviderVideoMatches").run();
  db.prepare("DELETE FROM ProviderEditionMatches").run();
  db.prepare("DELETE FROM ProviderEditionMembers").run();
  db.prepare("DELETE FROM ProviderItemAudioVariants").run();
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

type MockResponse = {
  statusCode: number;
  body: any;
  status: (code: number) => MockResponse;
  json: (payload: unknown) => MockResponse;
};

function createMockResponse(): MockResponse {
  return {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

function getSearchHandler(): (req: any, res: any) => Promise<void> {
  const layer = (searchRouter as any).stack.find((entry: any) => entry.route?.path === "/" && entry.route?.methods?.get);
  assert.ok(layer, "Expected GET / search route");
  return layer.route.stack[0].handle;
}

function insertCanonicalArtist() {
  const artist = dbModule.db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('artist-mbid', 'Search Artist')
    RETURNING id
  `).get() as { id: number };

  dbModule.db.prepare(`
    INSERT INTO Artists (id, name, mbid, monitored)
    VALUES ('artist-id', 'Search Artist', 'artist-mbid', 1)
  `).run();

  return artist;
}

test("local artist search honors canonical artwork preference", async () => {
  insertCanonicalArtist();
  dbModule.db.prepare(`
    UPDATE ArtistMetadata
    SET images = '[{"coverType":"Poster","url":"https://fanart.example/canonical.jpg"}]'
    WHERE mbid = 'artist-mbid'
  `).run();
  dbModule.db.prepare(`
    UPDATE Artists
    SET picture = 'https://provider.example/provider.jpg'
    WHERE mbid = 'artist-mbid'
  `).run();

  const res = createMockResponse();
  await getSearchHandler()({ query: { query: "Search Artist", type: "artists", limit: "10" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.artists.length, 1);
  assert.match(
    res.body.results.artists[0].imageId,
    /^\/media-cover\/artist-mbid\/poster\.jpg\?source=canonical&rev=[a-f0-9]{16}$/,
  );
});

test("local search returns canonical tracks", async () => {
  insertCanonicalArtist();

  dbModule.db.prepare(`
    INSERT INTO Albums (mbid, artist_mbid, title, primary_type, first_release_date)
    VALUES ('rg-mbid', 'artist-mbid', 'Search Album', 'Album', '2024-01-01')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO AlbumEditions (mbid, release_group_mbid, artist_mbid, title, status, country, date)
    VALUES ('release-mbid', 'rg-mbid', 'artist-mbid', 'Search Album', 'Official', 'XW', '2024-01-01')
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Recordings (mbid, artist_mbid, title, length_ms, is_video)
    VALUES ('recording-mbid', 'artist-mbid', 'Canonical Track Recording', 181000, 0)
  `).run();
  dbModule.db.prepare(`
    INSERT INTO Tracks (mbid, release_mbid, recording_mbid, medium_position, position, number, title, length_ms)
    VALUES ('track-mbid', 'release-mbid', 'recording-mbid', 1, 1, '1', 'Canonical Search Track', 181000)
  `).run();
  const providerRelease = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title
    ) VALUES ('tidal', 'release', 'provider-album-1', 'Search Album')
    RETURNING id
  `).get() as { id: number };
  const providerTrack = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, explicit, duration_ms
    ) VALUES ('tidal', 'track', 'provider-track-1', 'Canonical Search Track', 1, 181000)
    RETURNING id
  `).get() as { id: number };
  const member = dbModule.db.prepare(`
    INSERT INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, 1)
    RETURNING id
  `).get(providerRelease.id, providerTrack.id) as { id: number };
  const release = dbModule.db.prepare(`
    SELECT id, release_group_id FROM AlbumEditions WHERE mbid = 'release-mbid'
  `).get() as { id: number; release_group_id: number };
  const track = dbModule.db.prepare(`
    SELECT id, recording_id FROM Tracks WHERE mbid = 'track-mbid'
  `).get() as { id: number; recording_id: number };
  const releaseMatch = dbModule.db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerRelease.id, release.id) as { id: number };
  const trackMatch = dbModule.db.prepare(`
    INSERT INTO ProviderTrackMatches (
      provider_track_item_id, provider_edition_member_id, provider_edition_match_id, track_id,
      recording_id, match_state, decision_source, confidence, method,
      matcher_version
    ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 1, 'test', 1)
    RETURNING id
  `).get(providerTrack.id, member.id, releaseMatch.id, track.id, track.recording_id) as { id: number };
  const variant = dbModule.db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label,
      availability
    ) VALUES (?, 'hires', 'hires-lossless', 'HIRES_LOSSLESS', 'available')
    RETURNING id
  `).get(providerTrack.id) as { id: number };
  const library = dbModule.db.prepare(`
    SELECT id FROM Libraries WHERE name = 'Stereo'
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO LibraryAlbums (
      library_id, release_group_id, selection_mode, locked, curation_version
    ) VALUES (?, ?, 'auto', 0, 1)
  `).run(library.id, release.release_group_id);
  const libraryRelease = dbModule.db.prepare(`
    INSERT INTO LibraryEditions (
      library_id, edition_id, selection_mode, curation_version
    ) VALUES (?, ?, 'auto', 1)
    RETURNING id
  `).get(library.id, release.id) as { id: number };
  const plan = seedSelectedAcquisitionPlan(dbModule.db, { libraryEditionId: libraryRelease.id, provider: 'tidal' }) as { id: number };
  const source = dbModule.db.prepare(`
    INSERT INTO AcquisitionPlanSources (
      plan_id, provider_edition_match_id, role, sort_order
    ) VALUES (?, ?, 'primary', 0)
    RETURNING id
  `).get(plan.id, releaseMatch.id) as { id: number };
  dbModule.db.prepare(`
    INSERT INTO AcquisitionPlanTracks (
      plan_id, track_id, source_id, provider_track_match_id,
      provider_audio_variant_id, source_quality_snapshot
    ) VALUES (?, ?, ?, ?, ?, '{"quality":"HIRES_LOSSLESS"}')
  `).run(plan.id, track.id, source.id, trackMatch.id, variant.id);

  const res = createMockResponse();
  await getSearchHandler()({ query: { query: "Canonical Search", type: "tracks", limit: "10" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.tracks.length, 1);
  assert.equal(res.body.results.tracks[0].id, "track-mbid");
  assert.equal(res.body.results.tracks[0].quality, "HIRES_LOSSLESS");
  assert.equal(res.body.results.tracks[0].monitored, true);
});

test("local search returns canonical videos", async () => {
  const artist = insertCanonicalArtist();
  const video = dbModule.db.prepare(`
    INSERT INTO Recordings (
      foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
      title, length_ms, is_video, metadata_status, release_date, cover_image_id, monitored
    )
    VALUES (
      'mb-video-search-1', 'mb-video-search-1', ?, 'artist-mbid',
      'Canonical Search Video', 201000, 1, 'musicbrainz', '2023-02-03', 'recording-cover', 1
    )
    RETURNING id
  `).get(artist.id) as { id: number };

  const providerVideo = dbModule.db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, video_quality, duration_ms, release_date, cover_id
    ) VALUES ('tidal', 'video', 'provider-video-1', 'Canonical Search Video', 'FHD', 201000, '2023-02-03', 'provider-cover')
    RETURNING id
  `).get() as { id: number };
  dbModule.db.prepare(`
    INSERT INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test', 1)
  `).run(providerVideo.id, video.id);

  const res = createMockResponse();
  await getSearchHandler()({ query: { query: "Canonical Search", type: "videos", limit: "10" } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.results.videos.length, 1);
  assert.equal(res.body.results.videos[0].id, String(video.id));
  assert.equal(res.body.results.videos[0].quality, "FHD");
  assert.equal(res.body.results.videos[0].imageId, `/media-cover/Videos/${video.id}/cover.jpg`);
  assert.equal(res.body.results.videos[0].monitored, true);
});

test("empty-library search automatically includes canonical catalog discovery", async () => {
  const { catalogProviderRegistry } = await import("../services/catalog/index.js");
  const provider = catalogProviderRegistry.getActive();
  const originalSearch = provider.search;
  provider.search = async () => ({
    artists: [{
      id: "bastille-mbid",
      artistname: "Bastille",
      disambiguation: "British indie pop band",
      Albums: [],
      Images: [{ CoverType: "Poster", Url: "https://images.example/bastille.jpg" }],
    }] as any,
    releaseGroups: [],
  });

  try {
    const res = createMockResponse();
    await getSearchHandler()({ query: { query: "Bastille", type: "artists", limit: "10" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.results.artists.length, 1);
    assert.equal(res.body.results.artists[0].id, "bastille-mbid");
    assert.equal(res.body.results.artists[0].in_library, false);
  } finally {
    provider.search = originalSearch;
  }
});
