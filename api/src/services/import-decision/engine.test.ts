import assert from "node:assert/strict";
import { test } from "node:test";
import { ImportDecisionEngine } from "./engine.js";
import type { LocalGroup, ProviderMatch } from "../mediafiles/import-types.js";

function makeGroup(fileCount: number): LocalGroup {
  return {
    id: "group-1",
    path: "/tmp/downloads/album-1",
    rootPath: "/tmp/downloads",
    libraryRoot: "music" as any,
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `/tmp/downloads/album-1/${String(index + 1).padStart(2, "0")} - Track ${index + 1}.flac`,
      name: `${String(index + 1).padStart(2, "0")} - Track ${index + 1}.flac`,
      size: 1024,
      extension: ".flac",
      metadata: {
        common: {
          artist: "Keane",
          album: "Hopes and Fears",
          title: `Track ${index + 1}`,
        },
      } as any,
    })),
    sidecars: [],
    commonTags: {
      artist: "Keane",
      album: "Hopes and Fears",
    },
    status: "queued",
  };
}

test("ImportDecisionEngine allows partial album imports when remote album has missing tracks (#76)", () => {
  const group = makeGroup(16);
  const match: ProviderMatch = {
    item: {
      id: "album-17",
      title: "Hopes and Fears",
      numberOfTracks: 17,
    },
    itemType: "album",
    score: 0.95,
    confidence: 0.92,
    matchType: "exact",
    directCandidateCount: 1,
    matchedCount: 16,
    totalFiles: 16,
  } as ProviderMatch;

  const result = ImportDecisionEngine.evaluateSingleMatch({
    group,
    match,
    mode: "NewDownload",
    directCandidateCount: 1,
  });

  assert.equal(result.autoImportReady, true);
  assert.deepEqual(result.rejections, []);
});

test("ImportDecisionEngine still rejects when local files on disk are unmatched", () => {
  const group = makeGroup(16);
  const match: ProviderMatch = {
    item: {
      id: "album-17",
      title: "Hopes and Fears",
      numberOfTracks: 17,
    },
    itemType: "album",
    score: 0.95,
    confidence: 0.92,
    matchType: "exact",
    matchedCount: 15,
    totalFiles: 16,
  };

  const result = ImportDecisionEngine.evaluateSingleMatch({
    group,
    match,
    mode: "NewDownload",
    directCandidateCount: 1,
  });

  assert.equal(result.autoImportReady, false);
  assert.ok(result.rejections?.includes("Has unmatched tracks"));
});
