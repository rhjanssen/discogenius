import assert from "node:assert/strict";
import test from "node:test";
import { AudioTagService } from "./audio-tag-service.js";
import { buildVideoManagedTags } from "./video-tag-service.js";

test("video tags preserve canonical and provider identity in MP4 freeform fields", () => {
  const tags = buildVideoManagedTags({
    id: 1,
    file_path: "/library/video.mp4",
    relative_path: "video.mp4",
    library_root: "/library",
    extension: ".mp4",
    provider: "tidal",
    provider_id: "23282282",
    provider_url: "https://listen.tidal.com/video/23282282",
    quality: "MP4_1080P",
    title: "A Light That Never Comes",
    release_date: "2013-10-17T00:00:00.000+0000",
    copyright: "Copyright",
    artist_name: "Linkin Park",
    artist_mbid: "f59c5520-5f46-4d2c-b2c4-822eabf53419",
    recording_mbid: "3ccf19be-8a25-4127-8d57-e0e86b344dfb",
    recording_credits: JSON.stringify([{ name: "Linkin Park", join_phrase: " & " }, { name: "Steve Aoki" }]),
  });
  const output = AudioTagService.buildAudioTagWriteMap(tags, ".mp4");

  assert.equal(output.title, "A Light That Never Comes");
  assert.equal(output.artist, "Linkin Park; Steve Aoki");
  assert.equal(output.date, "2013-10-17");
  assert.equal(output["----:com.apple.iTunes:MusicBrainz Track Id"], "3ccf19be-8a25-4127-8d57-e0e86b344dfb");
  assert.equal(output["----:com.apple.iTunes:MusicBrainz Artist Id"], "f59c5520-5f46-4d2c-b2c4-822eabf53419");
  assert.equal(output["----:com.apple.iTunes:PROVIDER_URL"], "https://listen.tidal.com/video/23282282");
  assert.equal(output["----:com.apple.iTunes:PROVIDER_ID"], "23282282");
});
