import assert from "node:assert/strict";
import { test } from "node:test";

import { ServarrMetadataCatalogProvider } from "./servarr-metadata-catalog-provider.js";
import type {
  LidarrArtist,
  LidarrReleaseGroupDetail,
} from "./catalog-provider.js";

function makeArtist(): LidarrArtist {
  return {
    id: "artist-mbid",
    artistname: "Test Artist",
    sortname: "Artist, Test",
    type: "Group",
    images: [],
    Albums: [
      { Id: "rg-1", Title: "First", Type: "Album", SecondaryTypes: [], ReleaseDate: "2001-01-01" },
      { Id: "", Title: "No Id — should be dropped" },
      { Id: "rg-2", Title: "Second", Type: "EP", SecondaryTypes: ["Live"], ReleaseDate: "2002-02-02" },
    ],
  };
}

function makeGroupDetail(): LidarrReleaseGroupDetail {
  return {
    id: "rg-1",
    artistid: "artist-mbid",
    title: "First",
    type: "Album",
    Releases: [
      { Id: "rel-1", Title: "First (US)", Status: "Official", Country: ["US"], Label: [], Media: [], ReleaseDate: "2001-01-01", TrackCount: 10, Disambiguation: "", Tracks: [] },
      { Id: "rel-2", Title: "First (EU)", Status: "Official", Country: ["GB"], Label: [], Media: [], ReleaseDate: "2001-03-01", TrackCount: 10, Disambiguation: "", Tracks: [] },
    ],
  };
}

/** Records each delegated call so we can assert the adapter is a thin pass-through. */
function spyProxy(overrides: Partial<Record<string, (...args: any[]) => any>> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = (method: string, value: unknown) => (...args: unknown[]) => {
    calls.push({ method, args });
    return value;
  };
  const proxy = {
    getArtistInfo: overrides.getArtistInfo ?? record("getArtistInfo", makeArtist()),
    getAlbumInfo: overrides.getAlbumInfo ?? record("getAlbumInfo", makeGroupDetail()),
    searchForNewArtist: overrides.searchForNewArtist ?? record("searchForNewArtist", [makeArtist()]),
    searchAll: overrides.searchAll ?? record("searchAll", [{ artist: makeArtist() }]),
  };
  return { proxy, calls };
}

test("getArtist delegates straight to proxy.getArtistInfo", async () => {
  const { proxy, calls } = spyProxy();
  const provider = new ServarrMetadataCatalogProvider(proxy as any);
  const artist = await provider.getArtist("artist-mbid");
  assert.equal(artist.artistname, "Test Artist");
  assert.deepEqual(calls.map((c) => c.method), ["getArtistInfo"]);
  assert.deepEqual(calls[0].args, ["artist-mbid"]);
});

test("getArtistReleaseGroups derives matcher groups + drops idless albums", async () => {
  const { proxy } = spyProxy();
  const provider = new ServarrMetadataCatalogProvider(proxy as any);
  const groups = await provider.getArtistReleaseGroups("artist-mbid");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.mbid), ["rg-1", "rg-2"]);
  assert.equal(groups[1].primaryType, "EP");
  assert.deepEqual(groups[1].secondaryTypes, ["Live"]);
  assert.equal(groups[0].firstReleaseDate, "2001-01-01");
});

test("getReleaseGroup delegates to proxy.getAlbumInfo", async () => {
  const { proxy, calls } = spyProxy();
  const provider = new ServarrMetadataCatalogProvider(proxy as any);
  const detail = await provider.getReleaseGroup("rg-1");
  assert.equal(detail.title, "First");
  assert.equal(detail.Releases.length, 2);
  assert.equal(calls[0].method, "getAlbumInfo");
});

test("getReleaseWithTracks returns null (Servarr Metadata Server has no /release endpoint)", async () => {
  const { proxy, calls } = spyProxy();
  const provider = new ServarrMetadataCatalogProvider(proxy as any);
  const release = await provider.getReleaseWithTracks("rel-1");
  assert.equal(release, null);
  assert.equal(calls.length, 0);
});

test("getReleaseWithTracksInGroup projects a release out of its group", async () => {
  const { proxy } = spyProxy();
  const provider = new ServarrMetadataCatalogProvider(proxy as any);
  const release = await provider.getReleaseWithTracksInGroup("rg-1", "rel-2");
  assert.ok(release);
  assert.equal(release!.Title, "First (EU)");
  const missing = await provider.getReleaseWithTracksInGroup("rg-1", "rel-missing");
  assert.equal(missing, null);
});

test("search delegates to both searchForNewArtist and searchAll", async () => {
  const { proxy, calls } = spyProxy();
  const provider = new ServarrMetadataCatalogProvider(proxy as any);
  const results = await provider.search("test", { limit: 7 });
  assert.equal(results.artists.length, 1);
  assert.ok(Array.isArray(results.raw));
  const methods = calls.map((c) => c.method).sort();
  assert.deepEqual(methods, ["searchAll", "searchForNewArtist"]);
  // limit threaded through to both
  assert.deepEqual(calls.find((c) => c.method === "searchForNewArtist")?.args, ["test", 7]);
});

test("search tolerates a failing searchAll (degrades to artists only)", async () => {
  const { proxy } = spyProxy({
    searchAll: async () => {
      throw new Error("boom");
    },
  });
  const provider = new ServarrMetadataCatalogProvider(proxy as any);
  const results = await provider.search("test");
  assert.equal(results.artists.length, 1);
  assert.deepEqual(results.raw, []);
});

test("exposes stable id/name", () => {
  const provider = new ServarrMetadataCatalogProvider(spyProxy().proxy as any);
  assert.equal(provider.id, "servarr-metadata");
  assert.ok(provider.name.length > 0);
});
