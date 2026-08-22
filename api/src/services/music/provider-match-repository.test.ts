import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { createCurrentDomainSchema } from "../../database/schema/domain-baseline.js";
import { ProviderCatalogRepository } from "../providers/provider-catalog-repository.js";
import { ProviderMatchRepository } from "./provider-match-repository.js";

test("Laura Palmer provider release persists one safe assignment and no positional substitutions", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-provider-match-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    db.prepare("INSERT INTO ArtistMetadata (id, mbid, name) VALUES (1, 'artist', 'Bastille')").run();
    db.prepare("INSERT INTO Albums (id, mbid, artist_metadata_id, title) VALUES (1, 'group', 1, 'Laura Palmer EP')").run();
    db.prepare("INSERT INTO AlbumEditions (id, mbid, release_group_id, title) VALUES (1, 'release', 1, 'Laura Palmer EP')").run();
    const canonicalTitles = [
      "Laura Palmer",
      "Overjoyed",
      "Things We Lost in the Fire",
      "Get Home",
      "Laura Palmer (acoustic version)",
    ];
    canonicalTitles.forEach((title, index) => {
      const id = index + 1;
      db.prepare("INSERT INTO Recordings (id, mbid, title) VALUES (?, ?, ?)").run(id, `recording-${id}`, title);
      db.prepare(`
        INSERT INTO Tracks (id, mbid, album_edition_id, recording_id, medium_position, position, title)
        VALUES (?, ?, 1, ?, 1, ?, ?)
      `).run(id, `track-${id}`, id, id, title);
    });

    const catalog = new ProviderCatalogRepository(db);
    const providerRelease = catalog.upsertItem({
      provider: "apple-music",
      entityType: "release",
      providerId: "laura-palmer",
    });
    const providerTitles = [
      "Laura Palmer",
      "Thinkin' 'Bout You (feat. O.N.E.)",
      "Laura Palmer (RAC Mix)",
      "Laura Palmer (Imagine Dragons Remix)",
      "Laura Palmer (Kat Krazy Remix)",
    ];
    const providerTracks = providerTitles.map((title, index) => catalog.upsertItem({
      provider: "apple-music",
      entityType: "track",
      providerId: `provider-track-${index + 1}`,
      title,
    }));
    const memberIds = catalog.replaceReleaseMembers(
      providerRelease,
      providerTracks.map((memberItemId, index) => ({
        memberItemId,
        mediumPosition: 1,
        position: index + 1,
      })),
    );

    const repository = new ProviderMatchRepository(db);
    const result = repository.replaceReleaseMatch({
      providerEditionItemId: providerRelease,
      editionId: 1,
      decision: {
        matchState: "accepted",
        decisionSource: "automatic",
        confidence: 0.8,
        method: "title_artist_duration",
        matcherVersion: 1,
      },
      targetTrackIds: new Set([1, 2, 3, 4, 5]),
      sourceMemberIds: new Set(memberIds),
      trackMatches: [{
        providerEditionMemberId: memberIds[0],
        trackId: 1,
        recordingId: 1,
        matchState: "accepted",
        decisionSource: "automatic",
        confidence: 1,
        method: "title_artist_duration",
        matcherVersion: 1,
      }],
    });

    assert.equal(result.relation.relation, "overlap");
    assert.equal(result.relation.matchedTrackCount, 1);
    assert.deepEqual(db.prepare(`
      SELECT provider_edition_member_id, track_id, recording_id, match_state
      FROM ProviderTrackMatches
    `).all(), [{
      provider_edition_member_id: memberIds[0],
      track_id: 1,
      recording_id: 1,
      match_state: "accepted",
    }]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("an accepted video match supersedes the provider video's previous accepted identity", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-provider-video-match-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    db.prepare("INSERT INTO Recordings (id, mbid, title, is_video) VALUES (1, 'video-1', 'Pompeii', 1)").run();
    db.prepare("INSERT INTO Recordings (id, mbid, title, is_video) VALUES (2, 'video-2', 'Pompeii', 1)").run();
    const itemId = new ProviderCatalogRepository(db).upsertItem({
      provider: "tidal",
      entityType: "video",
      providerId: "provider-video",
      title: "Pompeii",
    });
    const repository = new ProviderMatchRepository(db);
    const decision = {
      matchState: "accepted" as const,
      decisionSource: "automatic" as const,
      confidence: 0.92,
      method: "title_artist_duration",
      matcherVersion: 1,
    };
    repository.upsertVideoMatch({ providerVideoItemId: itemId, recordingId: 1, decision });
    repository.upsertVideoMatch({ providerVideoItemId: itemId, recordingId: 2, decision });

    assert.deepEqual(db.prepare(`
      SELECT recording_id, match_state, method
      FROM ProviderVideoMatches
      ORDER BY recording_id
    `).all(), [
      { recording_id: 1, match_state: "rejected", method: "superseded" },
      { recording_id: 2, match_state: "accepted", method: "title_artist_duration" },
    ]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("automatic video matching cannot supersede a manual accepted identity", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-provider-video-manual-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    db.prepare(`
      INSERT INTO Recordings (id, mbid, title, is_video)
      VALUES (1, 'video-1', 'Pompeii', 1), (2, 'video-2', 'Pompeii', 1)
    `).run();
    const itemId = new ProviderCatalogRepository(db).upsertItem({
      provider: "tidal",
      entityType: "video",
      providerId: "provider-video",
      title: "Pompeii",
    });
    const repository = new ProviderMatchRepository(db);
    repository.upsertVideoMatch({
      providerVideoItemId: itemId,
      recordingId: 1,
      decision: {
        matchState: "accepted",
        decisionSource: "manual",
        confidence: 1,
        method: "manual",
        matcherVersion: 1,
      },
    });
    repository.upsertVideoMatch({
      providerVideoItemId: itemId,
      recordingId: 2,
      decision: {
        matchState: "accepted",
        decisionSource: "automatic",
        confidence: 0.99,
        method: "title_artist_duration",
        matcherVersion: 2,
      },
    });

    assert.deepEqual(db.prepare(`
      SELECT recording_id, match_state, decision_source, method
      FROM ProviderVideoMatches
      ORDER BY recording_id
    `).all(), [
      {
        recording_id: 1,
        match_state: "accepted",
        decision_source: "manual",
        method: "manual",
      },
      {
        recording_id: 2,
        match_state: "candidate",
        decision_source: "automatic",
        method: "title_artist_duration:blocked_by_manual",
      },
    ]);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("video matches reject missing or non-video canonical targets", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-provider-video-target-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    db.prepare(`
      INSERT INTO Recordings (id, mbid, title, is_video, metadata_status)
      VALUES (2, 'audio-recording', 'Audio recording', 0, 'musicbrainz')
    `).run();
    const itemId = new ProviderCatalogRepository(db).upsertItem({
      provider: "tidal",
      entityType: "video",
      providerId: "provider-video",
      title: "Provider video",
    });
    const repository = new ProviderMatchRepository(db);
    const decision = {
      matchState: "accepted" as const,
      decisionSource: "automatic" as const,
      confidence: 0.95,
      method: "title_artist_duration",
      matcherVersion: 1,
    };

    assert.throws(
      () => repository.upsertVideoMatch({
        providerVideoItemId: itemId,
        recordingId: 999,
        decision,
      }),
      /canonical video recording/,
    );
    assert.throws(
      () => repository.upsertVideoMatch({
        providerVideoItemId: itemId,
        recordingId: 2,
        decision,
      }),
      /canonical video recording/,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM ProviderVideoMatches").get() as { count: number }).count,
      0,
    );
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("video matches accept a YouTube-only catalog recording", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "discogenius-provider-video-yt-"));
  const db = new Database(path.join(folder, "test.db"));
  try {
    db.pragma("foreign_keys = ON");
    createCurrentDomainSchema(db);
    db.prepare(`
      INSERT INTO Recordings (id, title, is_video, youtube_video_id, metadata_status)
      VALUES (3, 'YouTube-only video', 1, 'a1xFsoRYrds', 'youtube')
    `).run();
    const itemId = new ProviderCatalogRepository(db).upsertItem({
      provider: "youtube-music",
      entityType: "video",
      providerId: "a1xFsoRYrds",
      title: "YouTube-only video",
    });
    const repository = new ProviderMatchRepository(db);
    const matchId = repository.upsertVideoMatch({
      providerVideoItemId: itemId,
      recordingId: 3,
      decision: {
        matchState: "accepted",
        decisionSource: "automatic",
        confidence: 0.99,
        method: "youtube_video_id",
        matcherVersion: 1,
      },
    });
    assert.ok(matchId > 0);
    const row = db.prepare(`
      SELECT recording_id AS recordingId, match_state AS matchState, method
      FROM ProviderVideoMatches WHERE id = ?
    `).get(matchId) as { recordingId: number; matchState: string; method: string };
    assert.deepEqual(row, {
      recordingId: 3,
      matchState: "accepted",
      method: "youtube_video_id",
    });
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
