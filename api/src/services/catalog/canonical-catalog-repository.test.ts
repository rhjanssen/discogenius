import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCurrentDomainSchema } from "../../database/schema/domain-baseline.js";
import { CanonicalCatalogRepository } from "./canonical-catalog-repository.js";

test("canonical catalogue writes resolve boundaries once and persist integer relations", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-canonical-catalog-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    const repository = new CanonicalCatalogRepository(db);
    const bastilleId = repository.upsertArtist({ mbid: "artist-bastille", name: "Bastille" });
    const collaboratorId = repository.upsertArtist({ mbid: "artist-collab", name: "Collaborator" });
    const groupId = repository.upsertReleaseGroup({
      mbid: "group",
      title: "Release Group",
      primaryArtistId: bastilleId,
      primaryType: "Album",
    });
    const editionId = repository.upsertRelease({
      mbid: "release",
      releaseGroupId: groupId,
      title: "Release",
      mediaCount: 1,
      trackCount: 1,
    });
    const recordingId = repository.upsertRecording({
      mbid: "recording",
      title: "Track",
      isrcs: ["GB-AAA-26-00001"],
    });
    const trackId = repository.upsertTrack({
      mbid: "track",
      editionId,
      recordingId,
      mediumPosition: 1,
      position: 1,
      title: "Track",
    });
    repository.replaceReleaseGroupCredits(groupId, [
      { artistId: bastilleId, ordinal: 0, creditedName: "Bastille", joinPhrase: " feat. " },
      { artistId: collaboratorId, ordinal: 1, creditedName: "Collaborator" },
    ]);
    repository.replaceTrackCredits(trackId, [
      { artistId: collaboratorId, ordinal: 0, creditedName: "Collaborator" },
    ]);

    assert.deepEqual(db.prepare(`
      SELECT release_group_id FROM AlbumEditions WHERE id = ?
    `).get(editionId), { release_group_id: groupId });
    assert.deepEqual(db.prepare(`
      SELECT album_edition_id, recording_id FROM Tracks WHERE id = ?
    `).get(trackId), { album_edition_id: editionId, recording_id: recordingId });
    assert.deepEqual(db.prepare(`
      SELECT artist_id, ordinal, credited_name, join_phrase
      FROM ReleaseGroupArtistCredits
      WHERE release_group_id = ?
      ORDER BY ordinal
    `).all(groupId), [
      { artist_id: bastilleId, ordinal: 0, credited_name: "Bastille", join_phrase: " feat. " },
      { artist_id: collaboratorId, ordinal: 1, credited_name: "Collaborator", join_phrase: "" },
    ]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
