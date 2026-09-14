import assert from "node:assert/strict";
import { after, test } from "node:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  closeActiveSchemaDb,
  openActiveSchemaDb,
  prepareActiveSchemaEnv,
} from "../../test-support/active-schema-fixture.js";

const { tempDir } = prepareActiveSchemaEnv("video-tag-active-schema");
const { db, dbModule } = await openActiveSchemaDb();
const { VideoTagService } = await import("./video-tag-service.js");
const { getConfigSection, updateConfig } = await import("../config/config.js");
updateConfig("metadata", { ...getConfigSection("metadata"), write_audio_tags_policy: "all_files" });

after(() => closeActiveSchemaDb(dbModule, tempDir));

test("video tagging reads the active TrackFiles artist identity column", async () => {
  const artist = db.prepare(`
    INSERT INTO ArtistMetadata (mbid, name)
    VALUES ('video-tag-artist', 'Video Tag Artist')
    RETURNING id
  `).get() as { id: number };

  const file = db.prepare(`
    INSERT INTO TrackFiles (
      artist_metadata_id, provider, provider_entity_type, provider_id,
      file_path, relative_path, library_root, filename, extension, file_type
    ) VALUES (?, 'tidal', 'video', 'video-tag-provider-id', ?, ?, ?, ?, 'mp4', 'video') RETURNING id
  `).get(
    artist.id,
    `${tempDir}/missing-video.mp4`,
    "missing-video.mp4",
    tempDir,
    "missing-video.mp4",
  ) as { id: number };

  const result = await VideoTagService.apply([file.id]);
  assert.deepEqual(result, {
    retagged: 0,
    skipped: 0,
    missing: 1,
    errors: [],
  });
});

test("MP4 video retag uses exact provider identity, all recording ISRCs and an idempotent verified diff", {
  skip: spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status !== 0,
}, async () => {
  const mediaPath = path.join(tempDir, "catalog-video.mp4");
  const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10",
    "-f", "lavfi", "-i", "sine=frequency=440", "-t", "0.2", "-c:v", "libx264", "-c:a", "aac", mediaPath],
    { windowsHide: true, encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const artist = db.prepare("SELECT id FROM ArtistMetadata WHERE mbid = 'video-tag-artist'").get() as { id: number };
  const recording = db.prepare(`INSERT INTO Recordings (mbid, title, is_video, artist_metadata_id, isrcs)
    VALUES ('video-recording-mbid', 'Catalog video', 1, ?, ?) RETURNING id`)
    .get(artist.id, JSON.stringify(["USUM70722793", "USUM70809583"])) as { id: number };
  const provider = db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('tidal', 'video', 'shared-id', 'TIDAL resource') RETURNING id`).get() as { id: number };
  db.prepare(`INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES ('apple-music', 'video', 'shared-id', 'Wrong resource')`).run();
  const file = db.prepare(`INSERT INTO TrackFiles (artist_metadata_id, recording_id, provider_item_id, provider_id,
    file_path, relative_path, library_root, filename, extension, file_type)
    VALUES (?, ?, ?, 'shared-id', ?, 'catalog-video.mp4', ?, 'catalog-video.mp4', 'mp4', 'video') RETURNING id`)
    .get(artist.id, recording.id, provider.id, mediaPath, tempDir) as { id: number };
  updateConfig("metadata", { ...getConfigSection("metadata"), scrub_audio_tags: true });
  const before = spawnSync("ffmpeg", ["-v", "error", "-i", mediaPath, "-map", "0", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"], { windowsHide: true, encoding: "utf8" });
  assert.deepEqual(await VideoTagService.apply([file.id]), { retagged: 1, skipped: 0, missing: 0, errors: [] });
  const { parseFile } = await import("music-metadata");
  const tags = await parseFile(mediaPath);
  assert.equal(tags.common.title, "Catalog video");
  assert.equal(tags.common.musicbrainz_recordingid, "video-recording-mbid");
  assert.deepEqual(tags.common.isrc, ["USUM70722793", "USUM70809583"]);
  assert.ok(Object.values(tags.native).flat().some(tag => tag.id === "stik" && tag.value === 6));
  assert.ok(Object.values(tags.native).flat().some(tag => tag.id === "----:com.apple.iTunes:PROVIDER" && tag.value === "tidal"));
  assert.deepEqual(await VideoTagService.apply([file.id]), { retagged: 0, skipped: 1, missing: 0, errors: [] });
  const afterHash = spawnSync("ffmpeg", ["-v", "error", "-i", mediaPath, "-map", "0", "-c", "copy", "-f", "hash", "-hash", "sha256", "-"], { windowsHide: true, encoding: "utf8" });
  assert.equal(before.status, 0, before.stderr);
  assert.equal(afterHash.status, 0, afterHash.stderr);
  assert.match(before.stdout, /^SHA256=/);
  assert.equal(afterHash.stdout, before.stdout);
});
