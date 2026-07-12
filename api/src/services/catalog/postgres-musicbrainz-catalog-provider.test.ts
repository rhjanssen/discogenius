import assert from "node:assert/strict";
import test from "node:test";

import { PostgresMusicBrainzCatalogProvider } from "./postgres-musicbrainz-catalog-provider.js";

test("bulk MusicBrainz hydration keeps release-group and unknown-country dates", async () => {
  const provider = new PostgresMusicBrainzCatalogProvider({
    connectionString: "postgresql://unused:unused@127.0.0.1:1/unused",
  });
  const sqlCalls: string[] = [];

  (provider as any).query = async (sql: string) => {
    sqlCalls.push(sql);
    if (sql.includes("WHERE rg.gid = ANY")) {
      return [{
        id: 101,
        gid: "6bb5b3df-c963-49ef-b1e1-2c8ad370eb98",
        name: "The Spirit",
        primary_type: "Album",
        comment: "",
        artist_gid: "df60a241-3b40-4f02-a4f3-9626127dcf8e",
        secondary_types: [],
        // Deliberately earlier than the release event below: MusicBrainz's
        // release_group_meta covers every release, including releases omitted
        // from the track-bearing detail rows.
        y: 2020,
        m: 5,
        d: 15,
      }];
    }
    if (sql.includes("JOIN medium m")) {
      return [{
        rg_id: 101,
        release_id: 201,
        release_gid: "d75f9d41-a70a-4ee1-9343-b58a628d5130",
        release_name: "The Spirit",
        status: "Official",
        barcode: null,
        release_comment: "",
        medium_pos: 1,
        format: "Digital Media",
        medium_name: "",
        track_gid: "04f5b2f0-ec1f-4b81-9dd6-61a21b451f52",
        track_pos: 1,
        track_number: "1",
        track_name: "The Spirit",
        track_length: 205000,
        recording_gid: "df7d32ac-46c8-4748-ad27-f6699a4a932d",
        recording_name: "The Spirit",
        recording_length: 205000,
        video: false,
        isrcs: null,
      }];
    }
    if (sql.includes("release_unknown_country")) {
      return [{
        release_gid: "d75f9d41-a70a-4ee1-9343-b58a628d5130",
        y: 2021,
        m: 6,
        d: 24,
        code: null,
      }];
    }
    throw new Error(`Unexpected SQL in fixture: ${sql}`);
  };

  try {
    const [entry] = await provider.getReleaseGroupDetails([
      "6bb5b3df-c963-49ef-b1e1-2c8ad370eb98",
    ]);

    assert.equal(entry.detail.releasedate, "2020-05-15");
    assert.equal(entry.detail.Releases[0].ReleaseDate, "2021-06-24");
    assert.ok(sqlCalls.some((sql) => sql.includes("release_group_meta")));
    assert.ok(sqlCalls.some((sql) => sql.includes("release_unknown_country")));
  } finally {
    await provider.dispose();
  }
});
