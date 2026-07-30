import type Database from "better-sqlite3";

export interface AcceptedProviderTrackFixture {
  provider: string;
  providerEditionId: string;
  providerTrackId: string;
  releaseMbid: string;
  trackMbid: string;
  quality?: string;
}

export interface AcceptedProviderTrackFixtureIds {
  providerEditionItemId: number;
  providerTrackItemId: number;
  providerEditionMemberId: number;
  providerEditionMatchId: number;
  providerTrackMatchId: number;
  editionId: number;
  releaseGroupId: number;
  trackId: number;
  recordingId: number;
}

export function seedAcceptedProviderReleaseMatch(
  db: Database.Database,
  fixture: {
    provider: string;
    providerEditionId: string;
    releaseMbid: string;
  },
): { providerEditionItemId: number; providerEditionMatchId: number; editionId: number; releaseGroupId: number } {
  const release = db.prepare(`
    SELECT release.id, release.release_group_id, release.title
    FROM AlbumEditions release
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
    fixture.providerEditionId,
    release.title,
  );
  db.prepare(`
    INSERT OR IGNORE INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, 'exact', 'accepted', 'automatic', 1, 'test_fixture', 1)
  `).run(providerRelease.id, release.id);
  const releaseMatch = db.prepare(`
    SELECT id
    FROM ProviderEditionMatches
    WHERE provider_edition_item_id = ? AND edition_id = ?
  `).get(providerRelease.id, release.id) as { id: number };
  return {
    providerEditionItemId: providerRelease.id,
    providerEditionMatchId: releaseMatch.id,
    editionId: release.id,
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
    providerEditionId?: string;
    position?: number;
  },
): { providerVideoItemId: number; providerVideoMatchId: number; providerEditionItemId: number | null } {
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

  let providerEditionItemId: number | null = null;
  if (fixture.providerEditionId) {
    const releaseItem = providerItem(
      db,
      fixture.provider,
      ["release"],
      fixture.providerEditionId,
      `Release ${fixture.providerEditionId}`,
    );
    providerEditionItemId = releaseItem.id;
    const position = fixture.position
      ?? (db.prepare(`
          SELECT COUNT(*) AS count FROM ProviderEditionMembers WHERE provider_edition_item_id = ?
        `).get(releaseItem.id) as { count: number }).count + 1;
    db.prepare(`
      INSERT OR IGNORE INTO ProviderEditionMembers (
        provider_edition_item_id, member_item_id, medium_position, position
      ) VALUES (?, ?, 1, ?)
    `).run(releaseItem.id, videoItem.id, position);
  }

  return {
    providerVideoItemId: videoItem.id,
    providerVideoMatchId: videoMatch.id,
    providerEditionItemId,
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
    providerEditionId: string;
    providerTrackId: string;
    recordingId: number;
    title: string;
    durationMs?: number | null;
    position?: number;
  },
): { providerTrackItemId: number; providerEditionItemId: number; providerEditionMemberId: number } {
  const releaseItem = providerItem(
    db,
    fixture.provider,
    ["release"],
    fixture.providerEditionId,
    `Release ${fixture.providerEditionId}`,
  );
  const trackItem = providerItem(db, fixture.provider, ["track"], fixture.providerTrackId, fixture.title);
  db.prepare(`
    UPDATE ProviderItems SET title = ?, duration_ms = COALESCE(?, duration_ms) WHERE id = ?
  `).run(fixture.title, fixture.durationMs ?? null, trackItem.id);

  const position = fixture.position
    ?? (db.prepare(`
        SELECT COUNT(*) AS count FROM ProviderEditionMembers WHERE provider_edition_item_id = ?
      `).get(releaseItem.id) as { count: number }).count + 1;
  db.prepare(`
    INSERT OR IGNORE INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position
    ) VALUES (?, ?, 1, ?)
  `).run(releaseItem.id, trackItem.id, position);
  const member = db.prepare(`
    SELECT id FROM ProviderEditionMembers
    WHERE provider_edition_item_id = ? AND member_item_id = ?
    ORDER BY id LIMIT 1
  `).get(releaseItem.id, trackItem.id) as { id: number };

  // A typed track edge always hangs off a release match, which needs a canonical
  // release. Reuse the release that already carries this recording; when the
  // fixture only seeded a bare Recording, mint the minimal canonical
  // release-group/release/track it implies so the chain production walks
  // (member -> track match -> release match) actually exists.
  let canonicalRelease = db.prepare(`
    SELECT album_edition_id FROM Tracks WHERE recording_id = ? ORDER BY id LIMIT 1
  `).get(fixture.recordingId) as { album_edition_id: number } | undefined;
  if (!canonicalRelease?.album_edition_id) {
    const recording = db.prepare(
      "SELECT id, mbid, title, artist_mbid FROM Recordings WHERE id = ?",
    ).get(fixture.recordingId) as {
      id: number; mbid: string | null; title: string; artist_mbid: string | null;
    } | undefined;
    if (recording) {
      const key = `fixture-${recording.id}`;
      const artistMbid = recording.artist_mbid || "artist-mbid";
      db.prepare(`
        INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type)
        VALUES (?, ?, ?, 'Album')
      `).run(`rg-${key}`, artistMbid, recording.title);
      const group = db.prepare("SELECT id FROM Albums WHERE mbid = ?").get(`rg-${key}`) as { id: number };
      db.prepare(`
        INSERT OR IGNORE INTO AlbumEditions (
          mbid, release_group_mbid, release_group_id, artist_mbid, title, track_count
        ) VALUES (?, ?, ?, ?, ?, 1)
      `).run(`rel-${key}`, `rg-${key}`, group.id, artistMbid, recording.title);
      const release = db.prepare("SELECT id FROM AlbumEditions WHERE mbid = ?").get(`rel-${key}`) as { id: number };
      db.prepare(`
        INSERT OR IGNORE INTO Tracks (
          mbid, release_mbid, album_edition_id, recording_mbid, recording_id,
          medium_position, position, title
        ) VALUES (?, ?, ?, ?, ?, 1, 1, ?)
      `).run(`trk-${key}`, `rel-${key}`, release.id, recording.mbid, recording.id, recording.title);
      canonicalRelease = { album_edition_id: release.id };
    }
  }
  if (canonicalRelease?.album_edition_id) {
    db.prepare(`
      INSERT OR IGNORE INTO ProviderEditionMatches (
        provider_edition_item_id, edition_id, relation, match_state,
        decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, 'overlap', 'accepted', 'automatic', 1, 'test_fixture', 1)
    `).run(releaseItem.id, canonicalRelease.album_edition_id);
    const releaseMatch = db.prepare(`
      SELECT id FROM ProviderEditionMatches
      WHERE provider_edition_item_id = ? AND edition_id = ?
    `).get(releaseItem.id, canonicalRelease.album_edition_id) as { id: number };
    db.prepare(`
      INSERT OR IGNORE INTO ProviderTrackMatches (
        provider_edition_member_id, provider_edition_match_id, track_id, recording_id,
        match_state, decision_source, confidence, method, matcher_version
      ) VALUES (?, ?, NULL, ?, 'accepted', 'automatic', 1, 'test_fixture', 1)
    `).run(member.id, releaseMatch.id, fixture.recordingId);
  }

  return {
    providerTrackItemId: trackItem.id,
    providerEditionItemId: releaseItem.id,
    providerEditionMemberId: member.id,
  };
}

export function seedAcceptedProviderTrackMatch(
  db: Database.Database,
  fixture: AcceptedProviderTrackFixture,
): AcceptedProviderTrackFixtureIds {
  const release = db.prepare(`
    SELECT release.id, release.release_group_id, release.title
    FROM AlbumEditions release
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
    fixture.providerEditionId,
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
    INSERT OR IGNORE INTO ProviderEditionMembers (
      provider_edition_item_id, member_item_id, medium_position, position,
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
    FROM ProviderEditionMembers
    WHERE provider_edition_item_id = ?
      AND member_item_id = ?
    ORDER BY id
    LIMIT 1
  `).get(providerRelease.id, providerTrack.id) as { id: number };

  const releaseMatch = seedAcceptedProviderReleaseMatch(db, fixture);

  db.prepare(`
    INSERT OR IGNORE INTO ProviderTrackMatches (
      provider_edition_member_id, provider_edition_match_id, track_id, recording_id,
      match_state, decision_source, confidence, method, matcher_version
    ) VALUES (?, ?, ?, ?, 'accepted', 'automatic', 1, 'test_fixture', 1)
  `).run(member.id, releaseMatch.providerEditionMatchId, track.id, track.recording_id);
  const trackMatch = db.prepare(`
    SELECT id
    FROM ProviderTrackMatches
    WHERE provider_edition_member_id = ?
      AND provider_edition_match_id = ?
      AND track_id = ?
      AND recording_id = ?
    ORDER BY id
    LIMIT 1
  `).get(member.id, releaseMatch.providerEditionMatchId, track.id, track.recording_id) as { id: number };

  return {
    providerEditionItemId: providerRelease.id,
    providerTrackItemId: providerTrack.id,
    providerEditionMemberId: member.id,
    providerEditionMatchId: releaseMatch.providerEditionMatchId,
    providerTrackMatchId: trackMatch.id,
    editionId: release.id,
    releaseGroupId: release.release_group_id,
    trackId: track.id,
    recordingId: track.recording_id,
  };
}

/**
 * A minimal canonical release group + release + tracks, so a provider fixture has
 * something real to match against. Idempotent, so tests can call it per case.
 */
export function seedCanonicalAlbum(
  db: Database.Database,
  fixture: {
    releaseGroupMbid: string;
    releaseMbid: string;
    artistMbid?: string;
    artistName?: string;
    title?: string;
    tracks?: Array<{ trackMbid: string; recordingMbid: string; title?: string; position?: number }>;
  },
): { releaseGroupId: number; editionId: number } {
  const artistMbid = fixture.artistMbid ?? "fixture-artist";
  const title = fixture.title ?? fixture.releaseGroupMbid;
  db.prepare("INSERT OR IGNORE INTO ArtistMetadata (mbid, name) VALUES (?, ?)")
    .run(artistMbid, fixture.artistName ?? "Fixture Artist");
  db.prepare(`
    INSERT OR IGNORE INTO Albums (mbid, artist_mbid, title, primary_type)
    VALUES (?, ?, ?, 'album')
  `).run(fixture.releaseGroupMbid, artistMbid, title);
  db.prepare(`
    INSERT OR IGNORE INTO AlbumEditions (
      mbid, release_group_mbid, artist_mbid, title, track_count, media_count
    ) VALUES (?, ?, ?, ?, ?, 1)
  `).run(
    fixture.releaseMbid,
    fixture.releaseGroupMbid,
    artistMbid,
    title,
    fixture.tracks?.length ?? 1,
  );

  let position = 0;
  for (const track of fixture.tracks ?? []) {
    position += 1;
    db.prepare(`
      INSERT OR IGNORE INTO Recordings (mbid, artist_mbid, title, is_video, metadata_status)
      VALUES (?, ?, ?, 0, 'complete')
    `).run(track.recordingMbid, artistMbid, track.title ?? track.trackMbid);
    const recording = db.prepare("SELECT id FROM Recordings WHERE mbid = ?")
      .get(track.recordingMbid) as { id: number };
    db.prepare(`
      INSERT OR IGNORE INTO Tracks (
        mbid, release_mbid, recording_mbid, recording_id,
        medium_position, position, number, title
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      track.trackMbid,
      fixture.releaseMbid,
      track.recordingMbid,
      recording.id,
      track.position ?? position,
      String(track.position ?? position),
      track.title ?? track.trackMbid,
    );
  }

  const release = db.prepare("SELECT id, release_group_id FROM AlbumEditions WHERE mbid = ?")
    .get(fixture.releaseMbid) as { id: number; release_group_id: number };
  return { releaseGroupId: release.release_group_id, editionId: release.id };
}

/**
 * A provider item's SOURCE CAPABILITY. This is what the offer rankers read for
 * quality — never a local file's imported quality.
 */
export function seedProviderAudioVariant(
  db: Database.Database,
  fixture: {
    providerItemId: number;
    qualityClass: "lossy" | "lossless" | "hires-lossless" | "spatial";
    variantKey?: string;
    providerQualityLabel?: string | null;
    spatialFormat?: string | null;
    codec?: string | null;
    bitDepth?: number | null;
    sampleRate?: number | null;
    channelCount?: number | null;
    availability?: string;
  },
): number {
  return Number((db.prepare(`
    INSERT INTO ProviderItemAudioVariants (
      provider_item_id, variant_key, quality_class, provider_quality_label,
      spatial_format, codec, bit_depth, sample_rate, channel_count, availability
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get(
    fixture.providerItemId,
    fixture.variantKey ?? fixture.qualityClass,
    fixture.qualityClass,
    fixture.providerQualityLabel ?? null,
    fixture.spatialFormat ?? null,
    fixture.codec ?? null,
    fixture.bitDepth ?? null,
    fixture.sampleRate ?? null,
    fixture.channelCount ?? null,
    fixture.availability ?? "available",
  ) as { id: number }).id);
}
