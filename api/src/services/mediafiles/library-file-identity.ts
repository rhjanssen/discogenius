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
type MbTrackRow = { mbid: string; release_mbid: string; recording_mbid: string };
type ProviderItemRow = {
  provider: string;
  entity_type: string;
  provider_id: string;
  artist_mbid: string | null;
  release_group_mbid: string | null;
  release_mbid: string | null;
  track_mbid: string | null;
  recording_mbid: string | null;
  library_slot: library_slot | string | null;
  updated_at: string | null;
};
type ReleaseGroupSlotRow = {
  id: number;
  artist_mbid: string;
  release_group_mbid: string;
  selected_provider_id: string | null;
  selected_release_mbid: string | null;
  selected_provider: string | null;
  slot: library_slot | string | null;
};

type PreparedIdentityInput = {
  input: LibraryFileIdentityInput;
  artistId: string | null;
  albumId: string | null;
  provider: string | null;
  providerEntityType: string | null;
  providerId: string | null;
};

type PreparedIdentityEvidence = {
  prepared: PreparedIdentityInput;
  artist: ArtistRow | null;
  providerAlbum: ProviderItemRow | null;
  providerMedia: ProviderItemRow | null;
  preferredSlot: library_slot;
  releaseGroupSlot: ReleaseGroupSlotRow | null;
  selectedTrack: MbTrackRow | null;
  inputTrack: MbTrackRow | null;
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

  if (fileType.includes("video") || root.includes("video")) {
    return "video";
  }

  if (isSpatialAudioQuality(quality) || root.includes("spatial") || root.includes("atmos")) {
    return "spatial";
  }

  if (["track", "cover", "nfo", "lyrics", "bio", "review"].includes(fileType)) {
    return "stereo";
  }

  return "stereo";
}

function inferProviderEntityType(input: LibraryFileIdentityInput): string | null {
  const explicit = nullableText(input.providerEntityType);
  if (explicit) {
    return explicit;
  }

  const fileType = nullableText(input.fileType)?.toLowerCase() ?? "";
  if (fileType.includes("video")) {
    return "video";
  }
  if (nullableText(input.mediaId)) {
    return "track";
  }
  if (nullableText(input.albumId)) {
    return "album";
  }
  if (nullableText(input.artistId)) {
    return "artist";
  }
  return null;
}

function inferProviderId(input: LibraryFileIdentityInput, providerEntityType: string | null): string | null {
  const explicit = nullableText(input.providerId);
  if (explicit) {
    return explicit;
  }

  if (providerEntityType === "track" || providerEntityType === "video") {
    return nullableText(input.mediaId);
  }
  if (providerEntityType === "album") {
    return nullableText(input.albumId);
  }
  if (providerEntityType === "artist") {
    return null;
  }
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
  };
}

function providerItemKey(entityType: string, providerId: string): string {
  return `${entityType}\u0000${providerId}`;
}

function trackPairKey(releaseMbid: string, recordingMbid: string): string {
  return `${releaseMbid}\u0000${recordingMbid}`;
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

function loadProviderItems(prepared: PreparedIdentityInput[]): Map<string, ProviderItemRow[]> {
  const idsByEntityType = new Map<string, Set<string>>();
  const addRequest = (entityType: string | null, providerId: string | null) => {
    if (!entityType || !providerId) return;
    const ids = idsByEntityType.get(entityType) ?? new Set<string>();
    ids.add(providerId);
    idsByEntityType.set(entityType, ids);
  };
  for (const entry of prepared) {
    addRequest("album", entry.albumId);
    addRequest(entry.providerEntityType, entry.providerId);
  }

  const byEntityAndId = new Map<string, ProviderItemRow[]>();
  for (const [entityType, requestedIds] of idsByEntityType) {
    for (const ids of chunks(Array.from(requestedIds))) {
      const marks = ids.map(() => "?").join(",");
      const rows = db.prepare(`
        SELECT
          provider_item.provider,
          provider_item.entity_type,
          provider_item.provider_id,
          COALESCE(provider_item.artist_mbid, recording.artist_mbid) AS artist_mbid,
          provider_item.release_group_mbid,
          provider_item.release_mbid,
          provider_item.track_mbid,
          COALESCE(provider_item.recording_mbid, recording.mbid) AS recording_mbid,
          provider_item.library_slot,
          provider_item.updated_at
        FROM ProviderItems provider_item
        LEFT JOIN Recordings recording ON recording.id = provider_item.recording_id
        WHERE provider_item.entity_type = ?
          AND provider_item.provider_id IN (${marks})
        ORDER BY provider_item.updated_at DESC, provider_item.provider ASC
      `).all(entityType, ...ids) as ProviderItemRow[];
      for (const row of rows) {
        const key = providerItemKey(String(row.entity_type), String(row.provider_id));
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
  entityType: string | null,
  providerId: string | null,
  provider: string | null,
): ProviderItemRow | null {
  if (!entityType || !providerId) return null;
  const candidates = providerItems.get(providerItemKey(entityType, providerId)) ?? [];
  if (!provider) return candidates[0] ?? null;
  return candidates.find((candidate) => candidate.provider === provider) ?? null;
}

function selectedProviderContainsId(selectedProviderId: string | null, providerId: string): boolean {
  return String(selectedProviderId || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(providerId);
}

function loadReleaseGroupSlots(evidence: PreparedIdentityEvidence[]): ReleaseGroupSlotRow[] {
  const rowsById = new Map<number, ReleaseGroupSlotRow>();
  const releaseGroupMbids = uniqueTexts(
    evidence.map((entry) => nullableText(entry.prepared.input.canonicalReleaseGroupMbid)),
  );
  for (const mbids of chunks(releaseGroupMbids)) {
    const marks = mbids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT id, artist_mbid, release_group_mbid, selected_provider_id,
             selected_release_mbid, selected_provider, slot
      FROM ReleaseGroupSlots
      WHERE release_group_mbid IN (${marks})
      ORDER BY id ASC
    `).all(...mbids) as ReleaseGroupSlotRow[];
    for (const row of rows) rowsById.set(Number(row.id), row);
  }

  // Rows without an RG hint can point at one native provider album inside a
  // semicolon-delimited hybrid. Keep the old exact/boundary semantics, but load
  // every requested album in bounded batches instead of probing once per file.
  const fallbackAlbumIds = uniqueTexts(
    evidence
      .filter((entry) => !nullableText(entry.prepared.input.canonicalReleaseGroupMbid))
      .map((entry) => entry.prepared.albumId),
  );
  for (const albumIds of chunks(fallbackAlbumIds, 80)) {
    const exactMarks = albumIds.map(() => "?").join(",");
    const likeClauses = albumIds
      .map(() => "(selected_provider_id LIKE ? OR selected_provider_id LIKE ? OR selected_provider_id LIKE ?)")
      .join(" OR ");
    const likeParams = albumIds.flatMap((albumId) => [
      `${albumId};%`,
      `%;${albumId};%`,
      `%;${albumId}`,
    ]);
    const rows = db.prepare(`
      SELECT id, artist_mbid, release_group_mbid, selected_provider_id,
             selected_release_mbid, selected_provider, slot
      FROM ReleaseGroupSlots
      WHERE selected_provider_id IN (${exactMarks})
         OR ${likeClauses}
      ORDER BY id ASC
    `).all(...albumIds, ...likeParams) as ReleaseGroupSlotRow[];
    for (const row of rows) rowsById.set(Number(row.id), row);
  }
  return Array.from(rowsById.values()).sort((left, right) => Number(left.id) - Number(right.id));
}

function pickReleaseGroupSlot(
  rows: ReleaseGroupSlotRow[],
  prepared: PreparedIdentityInput,
  preferredSlot: library_slot,
): ReleaseGroupSlotRow | null {
  const releaseGroupMbid = nullableText(prepared.input.canonicalReleaseGroupMbid);
  const candidates = releaseGroupMbid
    ? rows.filter((row) => row.release_group_mbid === releaseGroupMbid)
    : prepared.albumId
      ? rows.filter((row) => selectedProviderContainsId(row.selected_provider_id, prepared.albumId!))
      : [];
  return candidates.find((row) => nullableText(row.slot)?.toLowerCase() === preferredSlot)
    ?? candidates[0]
    ?? null;
}

function loadSelectedTracks(evidence: PreparedIdentityEvidence[]): Map<string, MbTrackRow> {
  const pairs = new Map<string, [string, string]>();
  for (const entry of evidence) {
    const releaseMbid = nullableText(entry.releaseGroupSlot?.selected_release_mbid);
    const recordingMbid = nullableText(entry.prepared.input.canonicalRecordingMbid)
      ?? nullableText(entry.providerMedia?.recording_mbid);
    if (releaseMbid && recordingMbid) {
      pairs.set(trackPairKey(releaseMbid, recordingMbid), [releaseMbid, recordingMbid]);
    }
  }

  const byPair = new Map<string, MbTrackRow>();
  for (const requestedPairs of chunks(Array.from(pairs.values()), 250)) {
    const valuesSql = requestedPairs.map(() => "(?, ?)").join(",");
    const params = requestedPairs.flatMap(([releaseMbid, recordingMbid]) => [releaseMbid, recordingMbid]);
    const rows = db.prepare(`
      WITH requested(release_mbid, recording_mbid) AS (
        VALUES ${valuesSql}
      )
      SELECT track.mbid, track.release_mbid, track.recording_mbid
      FROM Tracks track
      JOIN requested
        ON requested.release_mbid = track.release_mbid
       AND requested.recording_mbid = track.recording_mbid
      ORDER BY track.mbid ASC
    `).all(...params) as MbTrackRow[];
    for (const row of rows) {
      const key = trackPairKey(row.release_mbid, row.recording_mbid);
      if (!byPair.has(key)) byPair.set(key, row);
    }
  }
  return byPair;
}

function loadInputTracks(prepared: PreparedIdentityInput[]): Map<string, MbTrackRow> {
  const byMbid = new Map<string, MbTrackRow>();
  const trackMbids = uniqueTexts(prepared.map((entry) => nullableText(entry.input.canonicalTrackMbid)));
  for (const mbids of chunks(trackMbids)) {
    const marks = mbids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT mbid, release_mbid, recording_mbid
      FROM Tracks
      WHERE mbid IN (${marks})
    `).all(...mbids) as MbTrackRow[];
    for (const row of rows) byMbid.set(row.mbid, row);
  }
  return byMbid;
}

function resolveLibraryFileIdentityFromEvidence(evidence: PreparedIdentityEvidence): LibraryFileIdentity {
  const {
    prepared,
    artist,
    providerAlbum,
    providerMedia,
    preferredSlot,
    releaseGroupSlot,
    selectedTrack,
    inputTrack,
  } = evidence;
  const { input } = prepared;
  // When a ReleaseGroupSlot is bound (especially composite hybrids), slot /
  // remapped track identity outranks native ProviderItems RG/track MBIDs so
  // organize/naming/tags follow the monitored hybrid, not the source albums.
  const slotReleaseGroupMbid = nullableText(releaseGroupSlot?.release_group_mbid);
  const slotReleaseMbid = nullableText(releaseGroupSlot?.selected_release_mbid);
  const slotTrackMbid = nullableText(selectedTrack?.mbid);
  const inputTrackMbid = nullableText(input.canonicalTrackMbid);
  // Explicit job track MBIDs win only when they belong on the selected
  // release. Hybrid downloads often carry the *native* source-album track
  // MBID (Pompeii=1 on its single); keeping that here produced `01 - Pompeii`
  // on Killing Me Softly instead of hybrid track 2.
  const inputTrackOnSelectedRelease = Boolean(
    inputTrackMbid && slotReleaseMbid && inputTrack?.release_mbid === slotReleaseMbid,
  );
  const resolvedTrackMbid = inputTrackOnSelectedRelease
    ? inputTrackMbid
    : (slotTrackMbid
      ?? (slotReleaseMbid ? null : inputTrackMbid)
      ?? nullableText(providerMedia?.track_mbid)
      ?? null);

  return {
    canonicalArtistMbid:
      nullableText(input.canonicalArtistMbid)
      ?? nullableText(providerMedia?.artist_mbid)
      ?? nullableText(providerAlbum?.artist_mbid)
      ?? nullableText(artist?.mbid)
      ?? null,
    canonicalReleaseGroupMbid:
      nullableText(input.canonicalReleaseGroupMbid)
      ?? slotReleaseGroupMbid
      // Prefer the album offer's RG over the track row's. Hybrid source tracks
      // are often mis-matched onto unrelated singles (Rehab vs Back to Black).
      ?? nullableText(providerAlbum?.release_group_mbid)
      ?? nullableText(providerMedia?.release_group_mbid)
      ?? null,
    canonicalReleaseMbid:
      nullableText(input.canonicalReleaseMbid)
      ?? slotReleaseMbid
      ?? nullableText(providerMedia?.release_mbid)
      ?? nullableText(providerAlbum?.release_mbid)
      ?? null,
    canonicalTrackMbid: resolvedTrackMbid,
    canonicalRecordingMbid:
      nullableText(input.canonicalRecordingMbid)
      ?? nullableText(selectedTrack?.recording_mbid)
      ?? nullableText(providerMedia?.recording_mbid)
      ?? null,
    provider: providerMedia?.provider ?? providerAlbum?.provider ?? prepared.provider ?? null,
    providerEntityType: prepared.providerEntityType,
    providerId: prepared.providerId,
    librarySlot: preferredSlot,
  };
}

/**
 * Resolve a rename/import batch against one shared evidence snapshot. The
 * single-row API below is intentionally a wrapper over this path so hybrid-slot
 * precedence cannot drift between normal imports and Lidarr-style bulk renames.
 */
export function resolveLibraryFileIdentities(
  inputs: LibraryFileIdentityInput[],
): LibraryFileIdentity[] {
  if (inputs.length === 0) return [];

  const prepared = inputs.map(prepareIdentityInput);
  const artists = loadArtists(prepared);
  const providerItems = loadProviderItems(prepared);
  const evidence: PreparedIdentityEvidence[] = prepared.map((entry) => {
    const providerAlbum = pickProviderItem(providerItems, "album", entry.albumId, entry.provider);
    const providerMedia = pickProviderItem(
      providerItems,
      entry.providerEntityType,
      entry.providerId,
      entry.provider,
    );
    return {
      prepared: entry,
      artist: entry.artistId ? artists.get(entry.artistId) ?? null : null,
      providerAlbum,
      providerMedia,
      preferredSlot: inferLibrarySlot({
        ...entry.input,
        librarySlot:
          entry.input.librarySlot
          ?? providerMedia?.library_slot
          ?? providerAlbum?.library_slot,
        quality: entry.input.quality,
      }),
      releaseGroupSlot: null,
      selectedTrack: null,
      inputTrack: null,
    };
  });

  const slots = loadReleaseGroupSlots(evidence);
  for (const entry of evidence) {
    entry.releaseGroupSlot = pickReleaseGroupSlot(
      slots,
      entry.prepared,
      entry.preferredSlot,
    );
  }

  const selectedTracks = loadSelectedTracks(evidence);
  const inputTracks = loadInputTracks(prepared);
  for (const entry of evidence) {
    const releaseMbid = nullableText(entry.releaseGroupSlot?.selected_release_mbid);
    const recordingMbid = nullableText(entry.prepared.input.canonicalRecordingMbid)
      ?? nullableText(entry.providerMedia?.recording_mbid);
    entry.selectedTrack = releaseMbid && recordingMbid
      ? selectedTracks.get(trackPairKey(releaseMbid, recordingMbid)) ?? null
      : null;
    const inputTrackMbid = nullableText(entry.prepared.input.canonicalTrackMbid);
    entry.inputTrack = inputTrackMbid ? inputTracks.get(inputTrackMbid) ?? null : null;
  }

  return evidence.map(resolveLibraryFileIdentityFromEvidence);
}

export function resolveLibraryFileIdentity(input: LibraryFileIdentityInput): LibraryFileIdentity {
  return resolveLibraryFileIdentities([input])[0]!;
}
