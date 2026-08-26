import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
} from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("video-tag-active-schema");
const { db, dbModule } = await openActiveSchemaDb();
const { VideoTagService } = await import("./video-tag-service.js");

after(() => closeActiveSchemaDb(dbModule, tempDir));

test("video tagging reads the active TrackFiles artist identity column", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('video-tag-artist', 'Video Tag Artist')
    RETURNING id
  `).get() as { id: number };

  db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, provider, provider_entity_type, provider_id,
      file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, 'tidal', 'video', 'video-tag-provider-id', ?, ?, ?, ?, 'mp4', 'video')
  `).run(
    artist.id,
    `${tempDir}/missing-video.mp4`,
    "missing-video.mp4",
    tempDir,
    "missing-video.mp4",
  );

  const result = await VideoTagService.applyForProviderIds(
    ["video-tag-provider-id"],
    "tidal",
  );
  assert.deepEqual(result, {
    retagged: 0,
    skipped: 0,
    missing: 1,
    errors: [],
  });
});
