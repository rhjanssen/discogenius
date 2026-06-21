import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LocalMusicBrainzCatalogProvider,
} from "./local-musicbrainz-catalog-provider.js";
import {
  mapMbArtistToLidarr,
  mapMbReleaseGroupToLidarrDetail,
  mapMbReleaseToLidarr,
  mapMbRecordingToCatalog,
  flattenArtistCredit,
  type MbArtist,
  type MbReleaseGroup,
  type MbRelease,
  type MbRecording,
} from "./musicbrainz-ws-mapping.js";

/* ---- Recorded `:5000` / ws-2 fixture responses (no live network) ---- */

const ARTIST_FIXTURE: MbArtist = {
  id: "f27ec8db-af05-4f36-916e-3d57f91ecf5e",
  name: "Michael Jackson",
  "sort-name": "Jackson, Michael",
  disambiguation: "“King of Pop”",
  type: "Person",
  "release-groups": [
    {
      id: "f32fab16-755e-3b3a-92e6-7f1d3a4f1a11",
      title: "Thriller",
      "primary-type": "Album",
      "secondary-types": [],
      "first-release-date": "1982-11-30",
      disambiguation: "",
    },
  ],
};

const RELEASE_GROUP_FIXTURE: MbReleaseGroup = {
  id: "f32fab16-755e-3b3a-92e6-7f1d3a4f1a11",
  title: "Thriller",
  "primary-type": "Album",
  "secondary-types": [],
  "first-release-date": "1982-11-30",
  "artist-credit": [
    { name: "Michael Jackson", joinphrase: "", artist: { id: "f27ec8db-af05-4f36-916e-3d57f91ecf5e", name: "Michael Jackson" } },
  ],
  releases: [
    {
      id: "be7f42ee-1234-4567-89ab-000000000001",
      title: "Thriller",
      status: "Official",
      country: "US",
      barcode: "074643811224",
      date: "1982-11-30",
      media: [
        {
          position: 1,
          format: "CD",
          "track-count": 1,
          tracks: [
            {
              id: "track-gid-1",
              number: "1",
              position: 1,
              title: "Wanna Be Startin' Somethin'",
              length: 363000,
              recording: { id: "rec-gid-1", title: "Wanna Be Startin' Somethin'", length: 363000, isrcs: ["USSM18200001"] },
            },
          ],
        },
      ],
    },
  ],
};

const RELEASE_FIXTURE: MbRelease = RELEASE_GROUP_FIXTURE.releases![0];

const RECORDING_FIXTURE: MbRecording = {
  id: "rec-gid-1",
  title: "Billie Jean",
  length: 294000,
  video: false,
  isrcs: ["USSM18300001"],
  "artist-credit": [
    { name: "Michael Jackson", joinphrase: " feat. ", artist: { id: "f27ec8db-af05-4f36-916e-3d57f91ecf5e", name: "Michael Jackson" } },
    { name: "Friend", joinphrase: "", artist: { id: "friend-gid", name: "Friend" } },
  ],
};

/* ---- pure-mapping tests ---- */

test("flattenArtistCredit joins names + join phrases", () => {
  assert.equal(flattenArtistCredit(RECORDING_FIXTURE["artist-credit"]), "Michael Jackson feat. Friend");
  assert.equal(flattenArtistCredit([]), null);
  assert.equal(flattenArtistCredit(undefined), null);
});

test("mapMbArtistToLidarr maps artist + nested release groups", () => {
  const lidarr = mapMbArtistToLidarr(ARTIST_FIXTURE);
  assert.equal(lidarr.id, ARTIST_FIXTURE.id);
  assert.equal(lidarr.artistname, "Michael Jackson");
  assert.equal(lidarr.sortname, "Jackson, Michael");
  assert.equal(lidarr.type, "Person");
  assert.equal(lidarr.Albums.length, 1);
  assert.equal(lidarr.Albums[0].Id, "f32fab16-755e-3b3a-92e6-7f1d3a4f1a11");
  assert.equal(lidarr.Albums[0].Title, "Thriller");
  assert.equal(lidarr.Albums[0].Type, "Album");
  assert.equal(lidarr.Albums[0].ReleaseDate, "1982-11-30");
});

test("mapMbReleaseGroupToLidarrDetail carries owning artist + releases", () => {
  const detail = mapMbReleaseGroupToLidarrDetail(RELEASE_GROUP_FIXTURE);
  assert.equal(detail.id, RELEASE_GROUP_FIXTURE.id);
  assert.equal(detail.artistid, "f27ec8db-af05-4f36-916e-3d57f91ecf5e");
  assert.equal(detail.title, "Thriller");
  assert.equal(detail.type, "Album");
  assert.equal(detail.releasedate, "1982-11-30");
  assert.equal(detail.Releases.length, 1);
  assert.equal(detail.Releases[0].Id, "be7f42ee-1234-4567-89ab-000000000001");
});

test("mapMbReleaseToLidarr flattens media/tracks/recording", () => {
  const release = mapMbReleaseToLidarr(RELEASE_FIXTURE);
  assert.equal(release.Id, "be7f42ee-1234-4567-89ab-000000000001");
  assert.equal(release.Status, "Official");
  assert.deepEqual(release.Country, ["US"]);
  assert.equal(release.Barcode, "074643811224");
  assert.equal(release.TrackCount, 1);
  assert.equal(release.MediaCount, 1);
  assert.equal(release.Media[0].Format, "CD");
  const track = release.Tracks[0];
  assert.equal(track.Id, "track-gid-1");
  assert.equal(track.RecordingId, "rec-gid-1");
  assert.equal(track.TrackName, "Wanna Be Startin' Somethin'");
  assert.equal(track.TrackPosition, 1);
  assert.equal(track.MediumNumber, 1);
  assert.equal(track.DurationMs, 363000);
});

test("mapMbRecordingToCatalog carries isrcs + flattened credit", () => {
  const rec = mapMbRecordingToCatalog(RECORDING_FIXTURE);
  assert.equal(rec.mbid, "rec-gid-1");
  assert.equal(rec.title, "Billie Jean");
  assert.equal(rec.lengthMs, 294000);
  assert.equal(rec.isVideo, false);
  assert.deepEqual(rec.isrcs, ["USSM18300001"]);
  assert.equal(rec.artistCredit, "Michael Jackson feat. Friend");
});

/* ---- provider tests with an injected fixture fetcher (no live net) ---- */

function fixtureFetcher(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetcher = async <T,>(path: string): Promise<T> => {
    calls.push(path);
    const key = Object.keys(routes).find((prefix) => path.startsWith(prefix));
    if (!key) {
      throw new Error(`no fixture for path: ${path}`);
    }
    return routes[key] as T;
  };
  return { fetcher, calls };
}

test("getArtist requests release-groups inc and maps the artist", async () => {
  const { fetcher, calls } = fixtureFetcher({ "/artist/": ARTIST_FIXTURE });
  const provider = new LocalMusicBrainzCatalogProvider({ fetcher });
  const artist = await provider.getArtist(ARTIST_FIXTURE.id!);
  assert.equal(artist.artistname, "Michael Jackson");
  assert.equal(artist.Albums.length, 1);
  assert.ok(calls[0].includes("inc=release-groups"));
  assert.ok(calls[0].includes("fmt=json"));
});

test("getArtistReleaseGroups derives matcher-shaped groups", async () => {
  const { fetcher } = fixtureFetcher({ "/artist/": ARTIST_FIXTURE });
  const provider = new LocalMusicBrainzCatalogProvider({ fetcher });
  const groups = await provider.getArtistReleaseGroups(ARTIST_FIXTURE.id!);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].mbid, "f32fab16-755e-3b3a-92e6-7f1d3a4f1a11");
  assert.equal(groups[0].primaryType, "Album");
  assert.equal(groups[0].firstReleaseDate, "1982-11-30");
});

test("getReleaseWithTracks maps a direct /release lookup", async () => {
  const { fetcher, calls } = fixtureFetcher({ "/release/": RELEASE_FIXTURE });
  const provider = new LocalMusicBrainzCatalogProvider({ fetcher });
  const release = await provider.getReleaseWithTracks(RELEASE_FIXTURE.id!);
  assert.ok(release);
  assert.equal(release!.Tracks.length, 1);
  assert.ok(calls[0].includes("inc=recordings"));
  assert.ok(calls[0].includes("isrcs"));
});

test("getRecording maps a recording lookup", async () => {
  const { fetcher } = fixtureFetcher({ "/recording/": RECORDING_FIXTURE });
  const provider = new LocalMusicBrainzCatalogProvider({ fetcher });
  const rec = await provider.getRecording("rec-gid-1");
  assert.ok(rec);
  assert.equal(rec!.title, "Billie Jean");
  assert.deepEqual(rec!.isrcs, ["USSM18300001"]);
});

test("lookupByUPC strips non-digits and maps release hits", async () => {
  const { fetcher, calls } = fixtureFetcher({
    "/release?": {
      releases: [
        { id: "rel-1", title: "Thriller", "release-group": { id: "rg-1" } },
      ],
    },
  });
  const provider = new LocalMusicBrainzCatalogProvider({ fetcher });
  const result = await provider.lookupByUPC("0746-4381-1224");
  assert.equal(result.upc, "074643811224");
  assert.equal(result.releases.length, 1);
  assert.equal(result.releases[0].releaseMbid, "rel-1");
  assert.equal(result.releases[0].releaseGroupMbid, "rg-1");
  assert.ok(calls[0].includes("barcode%3A074643811224"));
});

test("lookupByUPC short-circuits on empty input", async () => {
  const { fetcher, calls } = fixtureFetcher({});
  const provider = new LocalMusicBrainzCatalogProvider({ fetcher });
  const result = await provider.lookupByUPC("   ");
  assert.deepEqual(result.releases, []);
  assert.equal(calls.length, 0);
});

test("lookupByISRC normalizes and maps recordings", async () => {
  const { fetcher, calls } = fixtureFetcher({
    "/isrc/": { recordings: [RECORDING_FIXTURE] },
  });
  const provider = new LocalMusicBrainzCatalogProvider({ fetcher });
  const result = await provider.lookupByISRC("us-sm1-83-00001");
  assert.equal(result.isrc, "USSM18300001");
  assert.equal(result.recordings.length, 1);
  assert.equal(result.recordings[0].mbid, "rec-gid-1");
  assert.ok(calls[0].includes("USSM18300001"));
});

test("search maps artist query hits", async () => {
  const { fetcher, calls } = fixtureFetcher({ "/artist?": { artists: [ARTIST_FIXTURE] } });
  const provider = new LocalMusicBrainzCatalogProvider({ fetcher });
  const results = await provider.search("michael jackson", { limit: 5 });
  assert.equal(results.artists.length, 1);
  assert.equal(results.artists[0].artistname, "Michael Jackson");
  assert.ok(calls[0].includes("limit=5"));
});

test("search short-circuits on empty query", async () => {
  const { fetcher, calls } = fixtureFetcher({});
  const provider = new LocalMusicBrainzCatalogProvider({ fetcher });
  const results = await provider.search("  ");
  assert.deepEqual(results.artists, []);
  assert.equal(calls.length, 0);
});

test("provider exposes a stable id/name and is constructible without options", () => {
  const provider = new LocalMusicBrainzCatalogProvider();
  assert.equal(provider.id, "musicbrainz-local");
  assert.ok(provider.name.includes("MusicBrainz"));
});
