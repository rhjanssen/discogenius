import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import {
  seedAcceptedProviderReleaseMatch,
  seedCanonicalAlbum,
} from "../../test-support/normalized-provider-fixtures.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "discogenius-provider-editorial-"));
process.env.DB_PATH = path.join(tempDir, "discogenius.test.db");
process.env.DISCOGENIUS_CONFIG_DIR = tempDir;

let dbModule: typeof import("../../database.js");
let extractAppleEditorialNotes: typeof import("./apple-music/apple-music-catalog.js").extractAppleEditorialNotes;
let firstProviderEditorialText: typeof import("./provider-editorial-text.js").firstProviderEditorialText;
let listReleaseGroupAlbumOfferCandidates:
  typeof import("./provider-editorial-text.js").listReleaseGroupAlbumOfferCandidates;
let streamingProviderManager: typeof import("./index.js").streamingProviderManager;

before(async () => {
  dbModule = await import("../../database.js");
  dbModule.initDatabase();
  ({ extractAppleEditorialNotes } = await import("./apple-music/apple-music-catalog.js"));
  ({ firstProviderEditorialText, listReleaseGroupAlbumOfferCandidates } =
    await import("./provider-editorial-text.js"));
  ({ streamingProviderManager } = await import("./index.js"));
});

after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("extractAppleEditorialNotes prefers standard over short and strips HTML", () => {
  assert.equal(
    extractAppleEditorialNotes({
      editorialNotes: {
        short: "Short blurb",
        standard: "<p>Longer <b>album</b> note<br/>line two</p>",
      },
    }),
    "Longer album note\nline two",
  );
  assert.equal(
    extractAppleEditorialNotes({
      editorialNotes: { short: "Only short" },
    }),
    "Only short",
  );
  assert.equal(extractAppleEditorialNotes({}), null);
});

test("firstProviderEditorialText walks provider_priority and returns first non-empty", async () => {
  const originalPriority = streamingProviderManager.getProviderPriority.bind(streamingProviderManager);
  const originalGet = streamingProviderManager.getStreamingProvider.bind(streamingProviderManager);

  const calls: string[] = [];
  (streamingProviderManager as any).getProviderPriority = () => ["apple-music", "tidal"];
  (streamingProviderManager as any).getStreamingProvider = (id: string) => ({
    id,
    isAuthenticated: () => true,
    capabilities: { editorialMetadata: true },
    getAlbumReview: async (providerId: string) => {
      calls.push(`${id}:${providerId}`);
      if (id === "apple-music") return "   ";
      if (id === "tidal") return "TIDAL review text";
      return null;
    },
  });

  try {
    const result = await firstProviderEditorialText({
      kind: "albumReview",
      candidates: [
        { provider: "tidal", providerId: "t1" },
        { provider: "apple-music", providerId: "a1" },
      ],
    });
    assert.deepEqual(result, { text: "TIDAL review text", source: "tidal" });
    assert.deepEqual(calls, ["apple-music:a1", "tidal:t1"]);
  } finally {
    (streamingProviderManager as any).getProviderPriority = originalPriority;
    (streamingProviderManager as any).getStreamingProvider = originalGet;
  }
});

test("listReleaseGroupAlbumOfferCandidates returns matched album offers", () => {
  const releaseGroupMbid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const releaseMbid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  seedCanonicalAlbum(dbModule.db, {
    releaseGroupMbid,
    releaseMbid,
    title: "Test Album",
  });
  seedAcceptedProviderReleaseMatch(dbModule.db, {
    provider: "tidal",
    providerEditionId: "editorial-test-99",
    releaseMbid,
  });

  try {
    const candidates = listReleaseGroupAlbumOfferCandidates(releaseGroupMbid);
    assert.ok(candidates.some((c) => c.provider === "tidal" && c.providerId === "editorial-test-99"));
  } finally {
    dbModule.db.prepare(`
      DELETE FROM ProviderItems
      WHERE provider = 'tidal' AND entity_type = 'release' AND provider_id = 'editorial-test-99'
    `).run();
  }
});
