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
    ["release", "album"],
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
    ORDER BY CASE entity_type WHEN 'release' THEN 0 WHEN 'album' THEN 1 ELSE 2 END, id
    LIMIT 1
  `).get(provider, ...entityTypes, providerId) as { id: number } | undefined;
  if (existing) return existing;

  return db.prepare(`
    INSERT INTO ProviderItems (provider, entity_type, provider_id, title)
    VALUES (?, ?, ?, ?)
    RETURNING id
  `).get(provider, entityTypes[0], providerId, title) as { id: number };
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
    ["release", "album"],
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
