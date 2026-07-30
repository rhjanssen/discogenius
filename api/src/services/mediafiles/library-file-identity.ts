import { db } from "../../database.js";
import { isSpatialAudioQuality } from "../../utils/spatial-audio.js";

export type library_slot = "stereo" | "spatial" | "video";

export type LibraryFileIdentityInput = {
  artistId?: string | number | null;
  albumId?: string | number | null;
  mediaId?: string | number | null;
  fileType?: string | null;
  quality?: string | null;
  libraryRoot?: string | null;
  provider?: string | null;
  providerEntityType?: string | null;
  providerId?: string | number | null;
  librarySlot?: library_slot | string | null;
  canonicalArtistMbid?: string | null;
  canonicalReleaseGroupMbid?: string | null;
  canonicalReleaseMbid?: string | null;
  canonicalTrackMbid?: string | null;
  canonicalRecordingMbid?: string | null;
};

export type LibraryFileIdentity = {
  canonicalArtistMbid: string | null;
  canonicalReleaseGroupMbid: string | null;
  canonicalReleaseMbid: string | null;
  canonicalTrackMbid: string | null;
  canonicalRecordingMbid: string | null;
  provider: string | null;
  providerEntityType: string | null;
  providerId: string | null;
  librarySlot: library_slot;
};

type ArtistRow = { id: string; mbid: string | null };
type ProviderItemRow = {
  id: number;
  provider: string;
  entity_type: string;
  provider_id: string;
};
type CanonicalMatch = {
  providerItemId: number;
  providerReleaseItemId: number | null;
  artistMbid: string | null;
  releaseGroupMbid: string | null;
  releaseMbid: string | null;
  trackMbid: string | null;
  recordingMbid: string | null;
  confidence: number;
};
type CanonicalReleaseRow = {
  mbid: string;
  releaseGroupMbid: string;
  artistMbid: string;
};
type CanonicalTrackRow = {
  mbid: string;
  releaseMbid: string;
  releaseGroupMbid: string;
  recordingMbid: string;
  artistMbid: string | null;
};
type LibrarySelection = {
  releaseGroupMbid: string;
  releaseMbid: string;
  libraryClass: "stereo" | "spatial";
  providerReleaseItemId: number | null;
};

type PreparedIdentityInput = {
  input: LibraryFileIdentityInput;
  artistId: string | null;
  albumId: string | null;
  provider: string | null;
  providerEntityType: string | null;
  providerId: string | null;
  preferredSlot: library_slot;
};

type IdentityEvidence = {
  prepared: PreparedIdentityInput;
  artist: ArtistRow | null;
  providerAlbum: ProviderItemRow | null;
  providerMedia: ProviderItemRow | null;
  inputRelease: CanonicalReleaseRow | null;
  inputTrack: CanonicalTrackRow | null;
  albumMatches: CanonicalMatch[];
  mediaMatches: CanonicalMatch[];
  releaseGroupMbid: string | null;
  releaseMbid: string | null;
  recordingMbid: string | null;
  selectedTrack: CanonicalTrackRow | null;
};

const BULK_QUERY_CHUNK_SIZE = 350;

function nullableText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

function uniqueTexts(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map(nullableText).filter((value): value is string => Boolean(value))));
}

function chunks<T>(values: T[], size = BULK_QUERY_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function inferLibrarySlot(input: LibraryFileIdentityInput): library_slot {
  const explicit = nullableText(input.librarySlot)?.toLowerCase();
  if (explicit === "stereo" || explicit === "spatial" || explicit === "video") {
    return explicit;
  }

  const fileType = nullableText(input.fileType)?.toLowerCase() ?? "";
  const root = nullableText(input.libraryRoot)?.toLowerCase() ?? "";
  const quality = nullableText(input.quality);

  if (fileType.includes("video") || root.includes("video")) return "video";
  if (isSpatialAudioQuality(quality) || root.includes("spatial") || root.includes("atmos")) {
    return "spatial";
  }
  return "stereo";
}

function inferProviderEntityType(input: LibraryFileIdentityInput): string | null {
  const explicit = nullableText(input.providerEntityType);
  if (explicit) return explicit;

  const fileType = nullableText(input.fileType)?.toLowerCase() ?? "";
  if (fileType.includes("video")) return "video";
  if (nullableText(input.mediaId)) return "track";
  if (nullableText(input.albumId)) return "album";
  if (nullableText(input.artistId)) return "artist";
  return null;
}

function inferProviderId(input: LibraryFileIdentityInput, providerEntityType: string | null): string | null {
  const explicit = nullableText(input.providerId);
  if (explicit) return explicit;
  if (providerEntityType === "track" || providerEntityType === "video") {
    return nullableText(input.mediaId);
  }
  if (providerEntityType === "album" || providerEntityType === "release") {
    return nullableText(input.albumId);
  }
  if (providerEntityType === "artist") return null;
  return nullableText(input.mediaId) ?? nullableText(input.albumId) ?? nullableText(input.artistId);
}

function prepareIdentityInput(input: LibraryFileIdentityInput): PreparedIdentityInput {
  const providerEntityType = inferProviderEntityType(input);
  return {
    input,
    artistId: nullableText(input.artistId),
    albumId: nullableText(input.albumId),
    provider: nullableText(input.provider),
    providerEntityType,
    providerId: inferProviderId(input, providerEntityType),
    preferredSlot: inferLibrarySlot(input),
  };
}

function providerItemKey(entityType: string, providerId: string): string {
  return `${entityType}\u0000${providerId}`;
}

function trackPairKey(releaseMbid: string, recordingMbid: string): string {
  return `${releaseMbid}\u0000${recordingMbid}`;
}

function selectionKey(releaseGroupMbid: string, libraryClass: "stereo" | "spatial"): string {
  return `${releaseGroupMbid}\u0000${libraryClass}`;
}

function loadArtists(prepared: PreparedIdentityInput[]): Map<string, ArtistRow> {
  const byId = new Map<string, ArtistRow>();
  for (const ids of chunks(uniqueTexts(prepared.map((entry) => entry.artistId)))) {
    const marks = ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT CAST(id AS TEXT) AS id, mbid
      FROM Artists
      WHERE id IN (${marks})
    `).all(...ids) as ArtistRow[];
    for (const row of rows) byId.set(String(row.id), row);
  }
  return byId;
}

function requestedProviderItemIds(prepared: PreparedIdentityInput[]): Map<string, Set<string>> {
  const requested = new Map<string, Set<string>>();
  const add = (entityType: string, providerId: string | null) => {
    if (!providerId) return;
    const ids = requested.get(entityType) ?? new Set<string>();
    ids.add(providerId);
    requested.set(entityType, ids);
  };
  for (const entry of prepared) {
    add("release", entry.albumId);
    add("album", entry.albumId);
    const mediaType = entry.providerEntityType === "album"
      ? "release"
      : entry.providerEntityType;
    if (mediaType) add(mediaType, entry.providerId);
    if (entry.providerEntityType === "album") add("album", entry.providerId);
  }
  return requested;
}

function loadProviderItems(prepared: PreparedIdentityInput[]): Map<string, ProviderItemRow[]> {
  const byEntityAndId = new Map<string, ProviderItemRow[]>();
  for (const [entityType, requestedIds] of requestedProviderItemIds(prepared)) {
    for (const ids of chunks(Array.from(requestedIds))) {
      const marks = ids.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT id, provider, entity_type, provider_id
        FROM ProviderItems
        WHERE entity_type = ?
          AND provider_id IN (${marks})
        ORDER BY updated_at DESC, provider ASC, id DESC
      `).all(entityType, ...ids) as ProviderItemRow[];
      for (const row of rows) {
        const key = providerItemKey(row.entity_type, row.provider_id);
        const candidates = byEntityAndId.get(key) ?? [];
        candidates.push(row);
        byEntityAndId.set(key, candidates);
      }
    }
  }
  return byEntityAndId;
}

function pickProviderItem(
  providerItems: Map<string, ProviderItemRow[]>,
  entityTypes: string[],
  providerId: string | null,
  provider: string | null,
): ProviderItemRow | null {
  if (!providerId) return null;
  const candidates = entityTypes.flatMap(
    (entityType) => providerItems.get(providerItemKey(entityType, providerId)) ?? [],
  );
  if (provider) {
    return candidates.find((candidate) => candidate.provider === provider) ?? null;
  }
  const providers = new Set(candidates.map((candidate) => candidate.provider));
  return providers.size <= 1 ? candidates[0] ?? null : null;
}

function addCanonicalMatch(
  byProviderItem: Map<number, CanonicalMatch[]>,
  match: CanonicalMatch,
): void {
  const matches = byProviderItem.get(match.providerItemId) ?? [];
  matches.push(match);
  matches.sort((left, right) => right.confidence - left.confidence);
  byProviderItem.set(match.providerItemId, matches);
}

function loadCanonicalMatches(providerItems: ProviderItemRow[]): Map<number, CanonicalMatch[]> {
  const byProviderItem = new Map<number, CanonicalMatch[]>();
  const ids = Array.from(new Set(providerItems.map((item) => item.id)));
  for (const itemIds of chunks(ids)) {
    const marks = itemIds.map(() => "?").join(",");

    const releases = db.prepare(`
      SELECT
        release_match.provider_edition_item_id AS provider_item_id,
        release_match.provider_edition_item_id AS provider_edition_item_id,
        release_group.artist_mbid,
        release_group.mbid AS release_group_mbid,
        release.mbid AS release_mbid,
        NULL AS track_mbid,
        NULL AS recording_mbid,
        release_match.confidence
      FROM ProviderEditionMatches release_match
      JOIN AlbumEditions release ON release.id = release_match.edition_id
      JOIN Albums release_group ON release_group.id = release.release_group_id
      WHERE release_match.provider_edition_item_id IN (${marks})
        AND release_match.match_state = 'accepted'
      ORDER BY release_match.confidence DESC, release_match.id
    `).all(...itemIds) as Array<Record<string, unknown>>;
    for (const row of releases) {
      addCanonicalMatch(byProviderItem, {
        providerItemId: Number(row.provider_item_id),
        providerReleaseItemId: Number(row.provider_edition_item_id),
        artistMbid: nullableText(row.artist_mbid),
        releaseGroupMbid: nullableText(row.release_group_mbid),
        releaseMbid: nullableText(row.release_mbid),
        trackMbid: null,
        recordingMbid: null,
        confidence: Number(row.confidence || 0),
      });
    }

    const tracks = db.prepare(`
      SELECT
        member.member_item_id AS provider_item_id,
        release_match.provider_edition_item_id AS provider_edition_item_id,
        release_group.artist_mbid,
        release_group.mbid AS release_group_mbid,
        release.mbid AS release_mbid,
        track.mbid AS track_mbid,
        recording.mbid AS recording_mbid,
        track_match.confidence
      FROM ProviderTrackMatches track_match
      JOIN ProviderEditionMembers member
        ON member.id = track_match.provider_edition_member_id
      JOIN ProviderEditionMatches release_match
        ON release_match.id = track_match.provider_edition_match_id
       AND release_match.match_state = 'accepted'
      JOIN AlbumEditions release ON release.id = release_match.edition_id
      JOIN Albums release_group ON release_group.id = release.release_group_id
      JOIN Tracks track ON track.id = track_match.track_id
      JOIN Recordings recording ON recording.id = track_match.recording_id
      WHERE member.member_item_id IN (${marks})
        AND track_match.match_state = 'accepted'
      ORDER BY track_match.confidence DESC, track_match.id
    `).all(...itemIds) as Array<Record<string, unknown>>;
    for (const row of tracks) {
      addCanonicalMatch(byProviderItem, {
        providerItemId: Number(row.provider_item_id),
        providerReleaseItemId: Number(row.provider_edition_item_id),
        artistMbid: nullableText(row.artist_mbid),
        releaseGroupMbid: nullableText(row.release_group_mbid),
        releaseMbid: nullableText(row.release_mbid),
        trackMbid: nullableText(row.track_mbid),
        recordingMbid: nullableText(row.recording_mbid),
        confidence: Number(row.confidence || 0),
      });
    }

    const videos = db.prepare(`
      SELECT
        video_match.provider_video_item_id AS provider_item_id,
        NULL AS provider_edition_item_id,
        recording.artist_mbid,
        NULL AS release_group_mbid,
        NULL AS release_mbid,
        NULL AS track_mbid,
        recording.mbid AS recording_mbid,
        video_match.confidence
      FROM ProviderVideoMatches video_match
      JOIN Recordings recording ON recording.id = video_match.recording_id
      WHERE video_match.provider_video_item_id IN (${marks})
        AND video_match.match_state = 'accepted'
      ORDER BY video_match.confidence DESC, video_match.id
    `).all(...itemIds) as Array<Record<string, unknown>>;
    for (const row of videos) {
      addCanonicalMatch(byProviderItem, {
        providerItemId: Number(row.provider_item_id),
        providerReleaseItemId: null,
        artistMbid: nullableText(row.artist_mbid),
        releaseGroupMbid: null,
        releaseMbid: null,
        trackMbid: null,
        recordingMbid: nullableText(row.recording_mbid),
        confidence: Number(row.confidence || 0),
      });
    }

    const artists = db.prepare(`
      SELECT
        artist_match.provider_artist_item_id AS provider_item_id,
        artist.mbid AS artist_mbid,
        artist_match.confidence
      FROM ProviderArtistMatches artist_match
      JOIN ArtistMetadata artist ON artist.id = artist_match.artist_id
      WHERE artist_match.provider_artist_item_id IN (${marks})
        AND artist_match.match_state = 'accepted'
      ORDER BY artist_match.confidence DESC, artist_match.id
    `).all(...itemIds) as Array<Record<string, unknown>>;
    for (const row of artists) {
      addCanonicalMatch(byProviderItem, {
        providerItemId: Number(row.provider_item_id),
        providerReleaseItemId: null,
        artistMbid: nullableText(row.artist_mbid),
        releaseGroupMbid: null,
        releaseMbid: null,
        trackMbid: null,
        recordingMbid: null,
        confidence: Number(row.confidence || 0),
      });
    }
  }
  return byProviderItem;
}

function loadCanonicalReleases(mbids: string[]): Map<string, CanonicalReleaseRow> {
  const byMbid = new Map<string, CanonicalReleaseRow>();
  for (const releaseMbids of chunks(uniqueTexts(mbids))) {
    const marks = releaseMbids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT
        release.mbid,
        release_group.mbid AS release_group_mbid,
        release_group.artist_mbid
      FROM AlbumEditions release
      JOIN Albums release_group ON release_group.id = release.release_group_id
      WHERE release.mbid IN (${marks})
    `).all(...releaseMbids) as Array<{
      mbid: string;
      release_group_mbid: string;
      artist_mbid: string;
    }>;
    for (const row of rows) {
      byMbid.set(row.mbid, {
        mbid: row.mbid,
        releaseGroupMbid: row.release_group_mbid,
        artistMbid: row.artist_mbid,
      });
    }
  }
  return byMbid;
}

function loadCanonicalTracks(mbids: string[]): Map<string, CanonicalTrackRow> {
  const byMbid = new Map<string, CanonicalTrackRow>();
  for (const trackMbids of chunks(uniqueTexts(mbids))) {
    const marks = trackMbids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT
        track.mbid,
        release.mbid AS release_mbid,
        release_group.mbid AS release_group_mbid,
        recording.mbid AS recording_mbid,
        release_group.artist_mbid
      FROM Tracks track
      JOIN AlbumEditions release ON release.id = track.album_edition_id
      JOIN Albums release_group ON release_group.id = release.release_group_id
      JOIN Recordings recording ON recording.id = track.recording_id
      WHERE track.mbid IN (${marks})
    `).all(...trackMbids) as Array<{
      mbid: string;
      release_mbid: string;
      release_group_mbid: string;
      recording_mbid: string;
      artist_mbid: string | null;
    }>;
    for (const row of rows) {
      byMbid.set(row.mbid, {
        mbid: row.mbid,
        releaseMbid: row.release_mbid,
        releaseGroupMbid: row.release_group_mbid,
        recordingMbid: row.recording_mbid,
        artistMbid: row.artist_mbid,
      });
    }
  }
  return byMbid;
}

function loadLibrarySelections(releaseGroupMbids: string[]): Map<string, LibrarySelection> {
  const byGroupAndClass = new Map<string, LibrarySelection>();
  for (const groupMbids of chunks(uniqueTexts(releaseGroupMbids))) {
    const marks = groupMbids.map(() => "?").join(",");
    const rows = db.prepare(`
      WITH ranked AS (
        SELECT
          release_group.mbid AS release_group_mbid,
          release.mbid AS release_mbid,
          CASE WHEN EXISTS (
            SELECT 1
            FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
            WHERE allowed.value = 'spatial'
          ) THEN 'spatial' ELSE 'stereo' END AS library_class,
          provider_match.provider_edition_item_id,
          ROW_NUMBER() OVER (
            PARTITION BY
              release_group.id,
              CASE WHEN EXISTS (
                SELECT 1
                FROM json_each(COALESCE(quality_profile.allowed_source_formats, '[]')) allowed
                WHERE allowed.value = 'spatial'
              ) THEN 'spatial' ELSE 'stereo' END
            ORDER BY library_release.updated_at DESC, library_release.id DESC
          ) AS selection_rank
        FROM LibraryEditions library_release
        JOIN AlbumEditions release ON release.id = library_release.edition_id
        JOIN Albums release_group ON release_group.id = release.release_group_id
        JOIN Libraries library
          ON library.id = library_release.library_id
         AND library.enabled = 1
        JOIN quality_profiles quality_profile
          ON quality_profile.id = library.quality_profile_id
        LEFT JOIN AcquisitionPlans plan
          ON plan.library_edition_id = library_release.id
         AND plan.state = 'current'
        LEFT JOIN AcquisitionPlanSources source
          ON source.plan_id = plan.id
         AND source.role = 'primary'
        LEFT JOIN ProviderEditionMatches provider_match
          ON provider_match.id = source.provider_edition_match_id
         AND provider_match.match_state = 'accepted'
        WHERE release_group.mbid IN (${marks})
      )
      SELECT
        release_group_mbid,
        release_mbid,
        library_class,
        provider_edition_item_id
      FROM ranked
      WHERE selection_rank = 1
    `).all(...groupMbids) as Array<{
      release_group_mbid: string;
      release_mbid: string;
      library_class: "stereo" | "spatial";
      provider_edition_item_id: number | null;
    }>;
    for (const row of rows) {
      byGroupAndClass.set(selectionKey(row.release_group_mbid, row.library_class), {
        releaseGroupMbid: row.release_group_mbid,
        releaseMbid: row.release_mbid,
        libraryClass: row.library_class,
        providerReleaseItemId: row.provider_edition_item_id,
      });
    }
  }
  return byGroupAndClass;
}

function chooseMatch(
  matches: CanonicalMatch[],
  releaseGroupHint: string | null,
  selection: LibrarySelection | null,
): CanonicalMatch | null {
  const candidates = releaseGroupHint
    ? matches.filter((match) => match.releaseGroupMbid === releaseGroupHint)
    : matches;
  return candidates.find((match) =>
    Boolean(
      selection
      && match.releaseMbid === selection.releaseMbid
      && (
        !selection.providerReleaseItemId
        || match.providerReleaseItemId === selection.providerReleaseItemId
      )
    ),
  ) ?? candidates[0] ?? null;
}

function loadTracksForReleaseRecording(
  pairs: Array<[string, string]>,
): Map<string, CanonicalTrackRow> {
  const byPair = new Map<string, CanonicalTrackRow>();
  const uniquePairs = Array.from(new Map(
    pairs.map((pair) => [trackPairKey(pair[0], pair[1]), pair]),
  ).values());
  for (const requestedPairs of chunks(uniquePairs, 250)) {
    const valuesSql = requestedPairs.map(() => "(?, ?)").join(",");
    const params = requestedPairs.flatMap((pair) => pair);
    const rows = db.prepare(`
      WITH requested(release_mbid, recording_mbid) AS (
        VALUES ${valuesSql}
      )
      SELECT
        track.mbid,
        release.mbid AS release_mbid,
        release_group.mbid AS release_group_mbid,
        recording.mbid AS recording_mbid,
        release_group.artist_mbid
      FROM requested
      JOIN AlbumEditions release ON release.mbid = requested.release_mbid
      JOIN Albums release_group ON release_group.id = release.release_group_id
      JOIN Tracks track ON track.album_edition_id = release.id
      JOIN Recordings recording
        ON recording.id = track.recording_id
       AND recording.mbid = requested.recording_mbid
      ORDER BY track.medium_position, track.position, track.id
    `).all(...params) as Array<{
      mbid: string;
      release_mbid: string;
      release_group_mbid: string;
      recording_mbid: string;
      artist_mbid: string | null;
    }>;
    for (const row of rows) {
      const key = trackPairKey(row.release_mbid, row.recording_mbid);
      if (!byPair.has(key)) {
        byPair.set(key, {
          mbid: row.mbid,
          releaseMbid: row.release_mbid,
          releaseGroupMbid: row.release_group_mbid,
          recordingMbid: row.recording_mbid,
          artistMbid: row.artist_mbid,
        });
      }
    }
  }
  return byPair;
}

function resolveEvidence(
  evidence: IdentityEvidence,
  selectedTracks: Map<string, CanonicalTrackRow>,
  selections: Map<string, LibrarySelection>,
): LibraryFileIdentity {
  const {
    prepared,
    artist,
    providerAlbum,
    providerMedia,
    inputRelease,
    inputTrack,
    albumMatches,
    mediaMatches,
  } = evidence;
  const { input } = prepared;
  const libraryClass = prepared.preferredSlot === "spatial" ? "spatial" : "stereo";
  const selection = evidence.releaseGroupMbid
    ? selections.get(selectionKey(evidence.releaseGroupMbid, libraryClass)) ?? null
    : null;
  const albumMatch = chooseMatch(albumMatches, evidence.releaseGroupMbid, selection);
  const mediaMatch = chooseMatch(mediaMatches, evidence.releaseGroupMbid, selection);
  const selectedTrack = evidence.releaseMbid && evidence.recordingMbid
    ? selectedTracks.get(trackPairKey(evidence.releaseMbid, evidence.recordingMbid)) ?? null
    : null;
  const inputTrackOnRelease = Boolean(
    inputTrack
    && evidence.releaseMbid
    && inputTrack.releaseMbid === evidence.releaseMbid,
  );
  const mediaTrackOnRelease = Boolean(
    mediaMatch?.trackMbid
    && evidence.releaseMbid
    && mediaMatch.releaseMbid === evidence.releaseMbid,
  );
  const resolvedTrack = inputTrackOnRelease
    ? inputTrack
    : selectedTrack
      ?? (mediaTrackOnRelease ? {
        mbid: mediaMatch!.trackMbid!,
        releaseMbid: mediaMatch!.releaseMbid!,
        releaseGroupMbid: mediaMatch!.releaseGroupMbid!,
        recordingMbid: mediaMatch!.recordingMbid!,
        artistMbid: mediaMatch!.artistMbid,
      } : null)
      ?? (!evidence.releaseMbid ? inputTrack : null);

  return {
    canonicalArtistMbid:
      nullableText(input.canonicalArtistMbid)
      ?? resolvedTrack?.artistMbid
      ?? mediaMatch?.artistMbid
      ?? albumMatch?.artistMbid
      ?? inputRelease?.artistMbid
      ?? artist?.mbid
      ?? null,
    canonicalReleaseGroupMbid:
      evidence.releaseGroupMbid,
    canonicalReleaseMbid:
      evidence.releaseMbid,
    canonicalTrackMbid:
      resolvedTrack?.mbid ?? null,
    canonicalRecordingMbid:
      nullableText(input.canonicalRecordingMbid)
      ?? resolvedTrack?.recordingMbid
      ?? mediaMatch?.recordingMbid
      ?? inputTrack?.recordingMbid
      ?? null,
    provider: providerMedia?.provider ?? providerAlbum?.provider ?? prepared.provider ?? null,
    providerEntityType: prepared.providerEntityType,
    providerId: prepared.providerId,
    librarySlot: prepared.preferredSlot,
  };
}

/**
 * Resolve a rename/import batch from explicit canonical choices, typed provider
 * matches, and selected LibraryEditions. Provider shadow MBIDs and positional
 * reconstruction are intentionally excluded.
 */
export function resolveLibraryFileIdentities(
  inputs: LibraryFileIdentityInput[],
): LibraryFileIdentity[] {
  if (inputs.length === 0) return [];

  const prepared = inputs.map(prepareIdentityInput);
  const artists = loadArtists(prepared);
  const providerItems = loadProviderItems(prepared);
  const allProviderItems = Array.from(providerItems.values()).flat();
  const canonicalMatches = loadCanonicalMatches(allProviderItems);
  const releases = loadCanonicalReleases(
    prepared.map((entry) => nullableText(entry.input.canonicalReleaseMbid)).filter(
      (value): value is string => Boolean(value),
    ),
  );
  const inputTracks = loadCanonicalTracks(
    prepared.map((entry) => nullableText(entry.input.canonicalTrackMbid)).filter(
      (value): value is string => Boolean(value),
    ),
  );

  const evidence = prepared.map((entry): IdentityEvidence => {
    const providerAlbum = pickProviderItem(
      providerItems,
      ["release", "album"],
      entry.albumId,
      entry.provider,
    );
    const mediaEntityTypes = entry.providerEntityType === "album"
      ? ["release", "album"]
      : entry.providerEntityType ? [entry.providerEntityType] : [];
    const providerMedia = pickProviderItem(
      providerItems,
      mediaEntityTypes,
      entry.providerId,
      entry.provider,
    );
    const inputReleaseMbid = nullableText(entry.input.canonicalReleaseMbid);
    const inputRelease = inputReleaseMbid ? releases.get(inputReleaseMbid) ?? null : null;
    const inputTrackMbid = nullableText(entry.input.canonicalTrackMbid);
    const inputTrack = inputTrackMbid ? inputTracks.get(inputTrackMbid) ?? null : null;
    const albumMatches = providerAlbum ? canonicalMatches.get(providerAlbum.id) ?? [] : [];
    const mediaMatches = providerMedia ? canonicalMatches.get(providerMedia.id) ?? [] : [];
    const explicitGroup = nullableText(entry.input.canonicalReleaseGroupMbid);
    const provisionalGroup = explicitGroup
      ?? inputRelease?.releaseGroupMbid
      ?? inputTrack?.releaseGroupMbid
      ?? albumMatches[0]?.releaseGroupMbid
      ?? mediaMatches[0]?.releaseGroupMbid
      ?? null;

    return {
      prepared: entry,
      artist: entry.artistId ? artists.get(entry.artistId) ?? null : null,
      providerAlbum,
      providerMedia,
      inputRelease,
      inputTrack,
      albumMatches,
      mediaMatches,
      releaseGroupMbid: provisionalGroup,
      releaseMbid: null,
      recordingMbid:
        nullableText(entry.input.canonicalRecordingMbid)
        ?? inputTrack?.recordingMbid
        ?? mediaMatches[0]?.recordingMbid
        ?? null,
      selectedTrack: null,
    };
  });

  const releaseGroupMbids = uniqueTexts(
    evidence.flatMap((entry) => [
      entry.releaseGroupMbid,
      ...entry.albumMatches.map((match) => match.releaseGroupMbid),
      ...entry.mediaMatches.map((match) => match.releaseGroupMbid),
    ]),
  );
  const selections = loadLibrarySelections(releaseGroupMbids);
  for (const entry of evidence) {
      const libraryClass = entry.prepared.preferredSlot === "spatial" ? "spatial" : "stereo";
      const selection = entry.releaseGroupMbid
        ? selections.get(selectionKey(entry.releaseGroupMbid, libraryClass)) ?? null
        : null;
      const albumMatch = chooseMatch(entry.albumMatches, entry.releaseGroupMbid, selection);
      const mediaMatch = chooseMatch(entry.mediaMatches, entry.releaseGroupMbid, selection);
      const explicitRelease = entry.inputRelease
        && (
          !entry.releaseGroupMbid
          || entry.inputRelease.releaseGroupMbid === entry.releaseGroupMbid
        )
        ? entry.inputRelease
        : null;
      entry.releaseGroupMbid = entry.releaseGroupMbid
        ?? albumMatch?.releaseGroupMbid
        ?? mediaMatch?.releaseGroupMbid
        ?? null;
      const selectedForResolvedGroup = entry.releaseGroupMbid
        ? selections.get(selectionKey(entry.releaseGroupMbid, libraryClass)) ?? null
        : null;
      entry.releaseMbid =
        explicitRelease?.mbid
        ?? selectedForResolvedGroup?.releaseMbid
        ?? albumMatch?.releaseMbid
        ?? mediaMatch?.releaseMbid
        ?? entry.inputTrack?.releaseMbid
        ?? null;
      entry.recordingMbid =
        nullableText(entry.prepared.input.canonicalRecordingMbid)
        ?? entry.inputTrack?.recordingMbid
        ?? mediaMatch?.recordingMbid
        ?? null;
  }

  const selectedTracks = loadTracksForReleaseRecording(
    evidence
      .filter((entry) => entry.releaseMbid && entry.recordingMbid)
      .map((entry) => [entry.releaseMbid!, entry.recordingMbid!]),
  );
  return evidence.map((entry) => resolveEvidence(entry, selectedTracks, selections));
}

export function resolveLibraryFileIdentity(input: LibraryFileIdentityInput): LibraryFileIdentity {
  return resolveLibraryFileIdentities([input])[0]!;
}
