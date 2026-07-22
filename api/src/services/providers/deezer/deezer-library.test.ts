import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DeezerGwFetchLike } from "./deezer-gw-api.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-deezer-import-"));
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");

const { saveDeezerCredentials } = await import("./deezer-auth.js");
const { getDeezerArtistsForImportSource, getDeezerImportSources } = await import("./deezer-library.js");

saveDeezerCredentials({ arl: "test-arl-cookie-value-1234567890" });

/** Mirror live Deezer gw-light envelopes, which include a truthy empty `error: []`. */
function gwOk(results: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { error: [], results };
    },
  };
}

const fixtureFetch: DeezerGwFetchLike = async (url, init) => {
  const method = new URL(url).searchParams.get("method") || "";
  const body = init?.body ? JSON.parse(init.body) as Record<string, unknown> : {};

  if (method === "deezer.ping") {
    return gwOk({ SESSION: "sid-test" });
  }

  if (method === "deezer.getUserData") {
    return gwOk({
      checkForm: "api-token",
      USER: {
        USER_ID: 42,
        SETTING: { global: { language: "en" } },
      },
    });
  }

  if (method === "deezer.pageProfile") {
    const tab = String(body.tab || "");
    if (tab === "artists") {
      return gwOk({
        TAB: {
          artists: {
            data: [{ ART_ID: "1352097", ART_NAME: "Bastille", ART_PICTURE: "artist-md5" }],
          },
        },
      });
    }
    return gwOk({
      TAB: {
        playlists: {
          data: [{
            PLAYLIST_ID: "9911",
            TITLE: "Bastille picks",
            NB_SONG: 12,
            PLAYLIST_PICTURE: "cover-md5",
          }],
        },
      },
    });
  }

  if (method === "song.getFavoriteIds") {
    return gwOk({ data: [{ SNG_ID: 1001 }] });
  }

  if (method === "song.getListData") {
    return gwOk({
      data: [{ ART_ID: 1352097, ART_NAME: "Bastille" }],
    });
  }

  if (method === "deezer.pagePlaylist") {
    assert.equal(body.playlist_id, "9911");
    return gwOk({
      SONGS: {
        data: [{ ART_ID: 1352097, ART_NAME: "Bastille" }],
      },
    });
  }

  throw new Error(`Unexpected Deezer gw-light call: ${method}`);
};

test("Deezer import sources expose favorite artists, loved tracks and user playlists", async () => {
  const sources = await getDeezerImportSources(fixtureFetch);
  assert.deepEqual(sources.map((source) => source.category), ["followed-artists", "favorite-tracks", "playlist"]);
  assert.equal(sources[2].lists?.[0]?.id, "9911");
  assert.match(String(sources[2].lists?.[0]?.image || ""), /cover-md5/);
});

test("Deezer import resolves distinct artists from favorites, loved tracks and playlists", async () => {
  const followed = await getDeezerArtistsForImportSource({ category: "followed-artists" }, fixtureFetch);
  assert.equal(followed[0].name, "Bastille");
  assert.match(String(followed[0].picture || ""), /artist-md5/);

  const loved = await getDeezerArtistsForImportSource({ category: "favorite-tracks" }, fixtureFetch);
  assert.equal(loved[0].name, "Bastille");

  const playlist = await getDeezerArtistsForImportSource({ category: "playlist", listId: "9911" }, fixtureFetch);
  assert.equal(playlist[0].providerId, "1352097");
});
