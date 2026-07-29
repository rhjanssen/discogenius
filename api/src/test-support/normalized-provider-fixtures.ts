import type Database from "better-sqlite3";

export interface AcceptedProviderTrackFixture {
  provider: string;
  providerReleaseId: string;
  providerTrackId: string;
  releaseMbid: string;
  trackMbid: string;
  quality?: string;
}

export interface AcceptedProviderTrackFixtureIds {
  providerReleaseItemId: number;
  providerTrackItemId: number;
  providerReleaseMemberId: number;
  providerReleaseMatchId: number;
  providerTrackMatchId: number;
  releaseId: number;
  releaseGroupId: number;
  trackId: number;
  recordingId: number;
}

export function seedAcceptedProviderReleaseMatch(
  db: Database.Database,
  fixture: {
    provider: string;
    providerReleaseId: string;
    releaseMbid: string;
  },
): { providerReleaseItemId: number; providerReleaseMatchId: number; releaseId: number; releaseGroupId: number } {
  const release = db.prepare(`
    SELECT release.id, release.release_group_id, release.title
    FROM AlbumReleases release
    WHERE release.mbid = ?
  `).get(fixture.releaseMbid) as {
    id: number;
    release_group_id: number;
    title: string;
  };
  const providerRelease = providerItem(
    db,
    fixture.provider,
    ["release"],
    fixture.providerReleaseId,
    release.title,
  );
  db.prepare(`
    INSERT OR IGNORE INTO ProviderReleaseMatches (
      provider_release_item_id, release_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test_fixture', 1)
  `).run(providerRelease.id, release.id);
  const releaseMatch = db.prepare(`
    SELECT id
    FROM ProviderReleaseMatches
    WHERE provider_release_item_id = ? AND release_id = ?
  `).get(providerRelease.id, release.id) as { id: number };
  return {
    providerReleaseItemId: providerRelease.id,
    providerReleaseMatchId: releaseMatch.id,
    releaseId: release.id,
    releaseGroupId: release.release_group_id,
  };
}

function providerItem(
  db: Database.Database,
  provider: string,
  entityTypes: string[],
  providerId: string,
  title: string,
): { id: number } {
  const marks = entityTypes.map(() => "?").join(",");
  const existing = db.prepare(`
    SELECT id
    FROM ProviderItems
    WHERE provider = ?
      AND entity_type IN (${marks})
      AND provider_id = ?
    ORDER BY id
    LIMIT 1
  `).get(provider, ...entityTypes, providerId) as { id: number } | undefined;
  if (existing) return existing;

  return db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).get(provider, entityTypes[0], providerId, title) as { id: number };
}

/**
 * Seed a provider VIDEO offer accepted-matched to a canonical recording, and
 * optionally place it on a provider release. Mirrors what real video ingestion
 * writes: identity + typed match (+ membership), never a provider-shadow column.
 */
export function seedAcceptedProviderVideoMatch(
  db: Database.Database,
  fixture: {
    provider: string;
    providerVideoId: string;
    recordingId: number;
    title?: string;
    durationMs?: number | null;
    availability?: string;
    providerReleaseId?: string;
    position?: number;
  },
): { providerVideoItemId: number; providerVideoMatchId: number; providerReleaseItemId: number | null } {
  const title = fixture.title
    ?? String((db.prepare("SELECT title FROM Recordings WHERE id = ?").get(fixture.recordingId) as { title?: string } | undefined)?.title || "");
  const videoItem = providerItem(db, fixture.provider, ["video"], fixture.providerVideoId, title);
  db.prepare(`
    UPDATE ProviderItems
    SET title = COALESCE(?, title),
        duration_ms = COALESCE(?, duration_ms),
        availability = COALESCE(?, availability)
    WHERE id = ?
  `).run(title || null, fixture.durationMs ?? null, fixture.availability ?? null, videoItem.id);

  db.prepare(`
    INSERT OR IGNORE INTO ProviderVideoMatches (
      provider_video_item_id, recording_id, match_state, decision_source,
      confidence, method, matcher_version
    ) VALUES (?, ?, 'accepted', 'automatic', 1, 'test_fixture', 1)
  `).run(videoItem.id, fixture.recordingId);
  const videoMatch = db.prepare(`
    SELECT id FROM ProviderVideoMatches
    WHERE provider_video_item_id = ? AND recording_id = ?
  `).get(videoItem.id, fixture.recordingId) as { id: number };

  let providerReleaseItemId: number | null = null;
  if (fixture.providerReleaseId) {
    const releaseItem = providerItem(
      db,
      fixture.provider,
      ["release"],
      fixture.providerReleaseId,
      `Release ${fixture.providerReleaseId}`,
    );
    providerReleaseItemId = releaseItem.id;
    const position = fixture.position
      ?? (db.prepare(`
          SELECT COUNT(*) AS count FROM ProviderReleaseMembers WHERE provider_release_item_id = ?
        `).get(releaseItem.id) as { count: number }).count + 1;
    db.prepare(`
      INSERT OR IGNORE INTO ProviderReleaseMembers (
        provider_release_item_id, member_item_id, medium_position, position
      ) VALUES (?, ?, 1, ?)
    `).run(releaseItem.id, videoItem.id, position);
  }

  return {
    providerVideoItemId: videoItem.id,
    providerVideoMatchId: videoMatch.id,
    providerReleaseItemId,
  };
}

/**
 * Seed a provider TRACK offer accepted-matched to a canonical recording (no
 * canonical track_id), placed on a provider release. For fixtures that model a
 * provider track whose canonical anchor is the recording rather than a specific
 * release-track.
 */
export function seedAcceptedProviderRecordingTrack(
  db: Database.Database,
  fixture: {
    provider: string;
    providerReleaseId: string;
    providerTrackId: string;
    recordingId: number;
    title: string;
    durationMs?: number | null;
    position?: number;
  },
): { providerTrackItemId: number; providerReleaseItemId: number; providerReleaseMemberId: number } {
  const releaseItem = providerItem(
    db,
    fixture.provider,
    ["release"],
    fixture.providerReleaseId,
    `Release ${fixture.providerReleaseId}`,
  );
  const trackItem = providerItem(db, fixture.provider, ["track"], fixture.providerTrackId, fixture.title);
  db.prepare(`
    UPDATE ProviderItems SET title = ?, duration_ms = COALESCE(?, duration_ms) WHERE id = ?
  `).run(fixture.title, fixture.durationMs ?? null, trackItem.id);

  const position = fixture.position
    ?? (db.prepare(`
        SELECT COUNT(*) AS count FROM ProviderReleaseMembers WHERE provider_release_item_id = ?
      `).get(releaseItem.id) as { count: number }).count + 1;
  db.prepare(`
    INSERT OR IGNORE INTO ProviderReleaseMembers (
      provider_release_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, ?)
  `).run(releaseItem.id, trackItem.id, position);
  const member = db.prepare(`
    SELECT id FROM ProviderReleaseMembers
    WHERE provider_release_item_id = ? AND member_item_id = ?
    ORDER BY id LIMIT 1
  `).get(releaseItem.id, trackItem.id) as { id: number };

  // A release match is required for the typed track edge; it targets whichever
  // canonical release carries this recording, when one does.
  const canonicalRelease = db.prepare(`
    SELECT album_release_id FROM Tracks WHERE recording_id = ? ORDER BY id LIMIT 1
  `).get(fixture.recordingId) as { album_release_id: number } | undefined;
  if (canonicalRelease?.album_release_id) {
    db.prepare(`
      INSERT OR IGNORE INTO ProviderReleaseMatches (
        provider_release_item_id, release_id, relation, match_state,
        decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, 'overlap', 'accepted', 'automatic', 1, 'test_fixture', 1)
    `).run(releaseItem.id, canonicalRelease.album_release_id);
    const releaseMatch = db.prepare(`
      SELECT id FROM ProviderReleaseMatches
      WHERE provider_release_item_id = ? AND release_id = ?
    `).get(releaseItem.id, canonicalRelease.album_release_id) as { id: number };
    db.prepare(`
      INSERT OR IGNORE INTO ProviderTrackMatches (
        provider_release_member_id, provider_release_match_id, track_id, recording_id,
        match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, NULL, ?, 'accepted', 'automatic', 1, 'test_fixture', 1)
    `).run(member.id, releaseMatch.id, fixture.recordingId);
  }

  return {
    providerTrackItemId: trackItem.id,
    providerReleaseItemId: releaseItem.id,
    providerReleaseMemberId: member.id,
  };
}

export function seedAcceptedProviderTrackMatch(
  db: Database.Database,
  fixture: AcceptedProviderTrackFixture,
): AcceptedProviderTrackFixtureIds {
  const release = db.prepare(`
    SELECT release.id, release.release_group_id, release.title
    FROM AlbumReleases release
    WHERE release.mbid = ?
  `).get(fixture.releaseMbid) as {
    id: number;
    release_group_id: number;
    title: string;
  };
  const track = db.prepare(`
    SELECT track.id, track.recording_id, track.medium_position, track.position, track.number, track.title
    FROM Tracks track
    WHERE track.mbid = ?
  `).get(fixture.trackMbid) as {
    id: number;
    recording_id: number;
    medium_position: number;
    position: number;
    number: string | null;
    title: string;
  };

  const providerRelease = providerItem(
    db,
    fixture.provider,
    ["release"],
    fixture.providerReleaseId,
    release.title,
  );
  const providerTrack = providerItem(
    db,
    fixture.provider,
    ["track"],
    fixture.providerTrackId,
    track.title,
  );

  db.prepare(`
    INSERT OR IGNORE INTO ProviderReleaseMembers (
      provider_release_item_id, member_item_id, medium_position, position,
      number, contextual_title
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    providerRelease.id,
    providerTrack.id,
    track.medium_position || 1,
    track.position,
    track.number,
    track.title,
  );
  const member = db.prepare(`
    SELECT id
    FROM ProviderReleaseMembers
    WHERE provider_release_item_id = ?
      AND member_item_id = ?
    ORDER BY id
    LIMIT 1
  `).get(providerRelease.id, providerTrack.id) as { id: number };

  const releaseMatch = seedAcceptedProviderReleaseMatch(db, fixture);

  db.prepare(`
    INSERT OR IGNORE INTO ProviderTrackMatches (
      provider_release_member_id, provider_release_match_id, track_id, recording_id,
      match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, ?, 'accepted', 'automatic', 1, 'test_fixture', 1)
  `).run(member.id, releaseMatch.providerReleaseMatchId, track.id, track.recording_id);
  const trackMatch = db.prepare(`
    SELECT id
    FROM ProviderTrackMatches
    WHERE provider_release_member_id = ?
      AND provider_release_match_id = ?
      AND track_id = ?
      AND recording_id = ?
    ORDER BY id
    LIMIT 1
  `).get(member.id, releaseMatch.providerReleaseMatchId, track.id, track.recording_id) as { id: number };

  return {
    providerReleaseItemId: providerRelease.id,
    providerTrackItemId: providerTrack.id,
    providerReleaseMemberId: member.id,
    providerReleaseMatchId: releaseMatch.providerReleaseMatchId,
    providerTrackMatchId: trackMatch.id,
    releaseId: release.id,
    releaseGroupId: release.release_group_id,
    trackId: track.id,
    recordingId: track.recording_id,
  };
}
