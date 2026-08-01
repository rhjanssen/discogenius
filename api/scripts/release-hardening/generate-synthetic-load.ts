#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import {
  SYNTHETIC_RUN_FORMAT,
  appendNdjson,
  assertPathWithinRoot,
  assertSafeOutputRoot,
  classifyBehavior,
  createRunPaths,
  defaultRunId,
  ensureFreshRunDirectory,
  getDockerImageId,
  getGitSha,
  parseCli,
  readIntegerOption,
  readStringOption,
  repoRootFrom,
  seededNumber,
  seededUuid,
  validateRunId,
  writeJson,
  type SyntheticExpectedState,
  type SyntheticGenerationOptions,
  type SyntheticRunManifest,
} from "./synthetic-load-common.js";

type SqliteDb = Database.Database;

interface CanonicalArtistFixture {
  index: number;
  mbid: string;
  metadataId: number;
  name: string;
}

interface CanonicalTrackFixture {
  id: number;
  mbid: string;
  recordingId: number;
  recordingMbid: string;
  title: string;
  position: number;
}

interface ProviderTrackAssignment {
  track: CanonicalTrackFixture;
  providerItemId: number;
  providerId: string;
  providerTrackMatchId: number;
  losslessVariantId: number;
  spatialVariantId: number | null;
}

interface ProviderSourceFixture {
  provider: string;
  providerEditionItemId: number;
  editionMatchId: number;
  relation: "exact" | "source_subset" | "source_superset" | "overlap";
  assignments: ProviderTrackAssignment[];
}

interface DeferredFileFixture {
  filePath: string;
  bytes: Buffer;
}

interface CreditedEdge {
  index: number;
  parentIndex: number;
  artistId: string;
  artistName: string;
}

const HELP = `
Generate a deterministic, disposable schema-42 release-hardening fixture.

Usage:
  yarn --cwd api tsx scripts/release-hardening/generate-synthetic-load.ts [options]

Options:
  --seed N                Deterministic seed (default: 2800)
  --primary-artists N     Monitored primary Artists (default: 500)
  --credited-artists N    First-degree credited Artists (default: 2000)
  --history-rows N        Historical command rows (default: 100000)
  --concurrency N         Requested runner concurrency recorded in manifest (default: 4)
  --output-root PATH      Parent for a new disposable run directory
  --run-id ID             Unique run directory name
  --help                  Show this text
`.trim();

function parseOptions(argv: readonly string[], repoRoot: string): SyntheticGenerationOptions {
  const cli = parseCli(argv);
  if (cli.help === true) {
    console.log(HELP);
    process.exit(0);
  }
  const seed = readIntegerOption(cli, "seed", 2800, { min: 0, max: 0x7fffffff });
  const outputRoot = assertSafeOutputRoot(
    readStringOption(cli, "output-root", path.join(repoRoot, "test-results", "release-hardening")),
    repoRoot,
  );
  return {
    seed,
    primaryArtists: readIntegerOption(cli, "primary-artists", 500, { min: 1, max: 100_000 }),
    creditedArtists: readIntegerOption(cli, "credited-artists", 2_000, { min: 0, max: 100_000 }),
    historyRows: readIntegerOption(cli, "history-rows", 100_000, { min: 0, max: 2_000_000 }),
    concurrency: readIntegerOption(cli, "concurrency", 4, { min: 1, max: 64 }),
    outputRoot,
    runId: validateRunId(readStringOption(cli, "run-id", defaultRunId(seed))),
  };
}

function emptyExpected(options: SyntheticGenerationOptions): SyntheticExpectedState {
  return {
    artists: {
      primary: options.primaryArtists,
      credited: options.creditedArtists,
      canonical: 0,
      legacy: 0,
      managed: 0,
    },
    catalogue: {
      albums: 0,
      editions: 0,
      recordings: 0,
      audioRecordings: 0,
      videoRecordings: 0,
      tracks: 0,
      directVideoTracks: 0,
    },
    provider: {
      items: 0,
      artistMatches: 0,
      editionMatches: 0,
      trackMatches: 0,
      videoMatches: 0,
      audioVariants: 0,
    },
    curation: {
      libraryArtists: 0,
      libraryAlbums: 0,
      libraryEditions: 0,
      libraryVideos: 0,
      inlineVideos: 0,
      plans: 0,
      planSources: 0,
      planTracks: 0,
    },
    files: {
      trackFiles: 0,
      unmappedFiles: 0,
      totalBytes: 0,
    },
    commands: {
      history: options.historyRows,
      initialPrimary: options.primaryArtists,
      initialDownloads: Math.max(1, Math.floor(options.primaryArtists / 25)),
    },
    behavior: {
      normal: 0,
      slow: 0,
      transient_failure: 0,
      poison: 0,
      worker_crash: 0,
      worker_hang: 0,
    },
  };
}

function insertArtistMetadata(
  db: SqliteDb,
  seed: number,
  namespace: "primary" | "credited",
  index: number,
): CanonicalArtistFixture {
  const mbid = seededUuid(seed, `${namespace}-artist`, index);
  const name = `${namespace === "primary" ? "Primary" : "Credited"} Artist ${String(index + 1).padStart(5, "0")}`;
  const result = db.prepare(`
    INSERT INTO ArtistMetadata (
      foreign_artist_id, mbid, name, sort_name, disambiguation, type,
      country, aliases, content_hash, status
    ) VALUES (?, ?, ?, ?, ?, 'Person', ?, ?, ?, 'active')
  `).run(
    mbid,
    mbid,
    name,
    `${String(index + 1).padStart(5, "0")}, ${namespace}`,
    namespace === "credited" ? "synthetic first-degree credit" : "synthetic monitored fixture",
    ["US", "GB", "NL", "DE"][seededNumber(seed, `${namespace}-country`, index, 4)],
    JSON.stringify([{ name: `${name} Alias`, locale: null, primary: false }]),
    `synthetic:${seed}:${namespace}:${index}`,
  );
  return { index, mbid, metadataId: Number(result.lastInsertRowid), name };
}

function setFixtureEnvironment(paths: ReturnType<typeof createRunPaths>): void {
  process.env.DB_PATH = paths.databasePath;
  process.env.DISCOGENIUS_CONFIG_DIR = paths.configRoot;
  process.env.DISCOGENIUS_APP_DATA = paths.configRoot;
  process.env.MUSIC_PATH = paths.stereoRoot;
  process.env.SPATIAL_PATH = paths.spatialRoot;
  process.env.VIDEO_PATH = paths.videoRoot;
  process.env.DOWNLOAD_PATH = paths.downloadRoot;
  process.env.DISCOGENIUS_STARTUP_INTEGRITY_CHECK = "quick";
}

function createSyntheticBytes(seed: number, namespace: string, index: number, size: number): Buffer {
  const digest = Buffer.from(seededUuid(seed, namespace, index).replaceAll("-", ""), "hex");
  const output = Buffer.alloc(size);
  for (let offset = 0; offset < output.length; offset += 1) {
    output[offset] = digest[offset % digest.length] ^ (offset & 0xff);
  }
  return output;
}

function insertProviderItem(
  db: SqliteDb,
  expected: SyntheticExpectedState,
  input: {
    provider: string;
    entityType: "artist" | "release" | "track" | "video";
    providerId: string;
    title: string;
    availability?: string;
    explicit?: number | null;
    durationMs?: number | null;
    videoQuality?: string | null;
  },
): number {
  const result = db.prepare(`
    INSERT INTO ProviderItems (
      provider, entity_type, provider_id, title, availability, checked_at,
      explicit, duration_ms, video_quality, provider_url
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)
  `).run(
    input.provider,
    input.entityType,
    input.providerId,
    input.title,
    input.availability ?? "available",
    input.explicit ?? null,
    input.durationMs ?? null,
    input.videoQuality ?? null,
    `https://synthetic.invalid/${input.provider}/${input.entityType}/${input.providerId}`,
  );
  expected.provider.items += 1;
  return Number(result.lastInsertRowid);
}

function seedProviderSource(
  db: SqliteDb,
  expected: SyntheticExpectedState,
  input: {
    seed: number;
    albumOrdinal: number;
    sourceOrdinal: number;
    provider: string;
    editionId: number;
    editionTitle: string;
    relation: ProviderSourceFixture["relation"];
    tracks: CanonicalTrackFixture[];
    targetTrackCount: number;
    addProviderOnlyTrack: boolean;
    unavailable: boolean;
    spatialCapable: boolean;
    explicitMode: "explicit" | "clean" | "unknown";
  },
): ProviderSourceFixture {
  const providerEditionId = `synthetic-release-${input.albumOrdinal}-${input.sourceOrdinal}`;
  const providerEditionItemId = insertProviderItem(db, expected, {
    provider: input.provider,
    entityType: "release",
    providerId: providerEditionId,
    title: `${input.editionTitle} [${input.provider} source ${input.sourceOrdinal + 1}]`,
    availability: input.unavailable ? "unavailable" : "available",
  });
  const sourceTrackCount = input.tracks.length + (input.addProviderOnlyTrack ? 1 : 0);
  const targetTrackCount = input.targetTrackCount;
  const editionMatch = db.prepare(`
    INSERT INTO ProviderEditionMatches (
      provider_edition_item_id, edition_id, relation, match_state,
      decision_source, confidence, method, evidence, matcher_version,
      matched_track_count, source_track_count, target_track_count,
      source_coverage, target_coverage
    ) VALUES (?, ?, ?, 'accepted', 'automatic', ?, 'synthetic_exact_identity', ?, 1, ?, ?, ?, ?, ?)
  `).run(
    providerEditionItemId,
    input.editionId,
    input.relation,
    input.relation === "exact" ? 0.99 : 0.82,
    JSON.stringify({ seed: input.seed, albumOrdinal: input.albumOrdinal, sourceOrdinal: input.sourceOrdinal }),
    input.tracks.length,
    sourceTrackCount,
    targetTrackCount,
    sourceTrackCount > 0 ? input.tracks.length / sourceTrackCount : 0,
    targetTrackCount > 0 ? input.tracks.length / targetTrackCount : 0,
  );
  expected.provider.editionMatches += 1;
  const editionMatchId = Number(editionMatch.lastInsertRowid);
  const assignments: ProviderTrackAssignment[] = [];

  for (let index = 0; index < input.tracks.length; index += 1) {
    const track = input.tracks[index];
    const providerTrackId = `${input.albumOrdinal}-${input.sourceOrdinal}-${index + 1}`;
    const explicit = input.explicitMode === "unknown" ? null : input.explicitMode === "explicit" ? 1 : 0;
    const providerItemId = insertProviderItem(db, expected, {
      provider: input.provider,
      entityType: "track",
      providerId: providerTrackId,
      title: track.title,
      availability: input.unavailable ? "unavailable" : "available",
      explicit,
      durationMs: 180_000 + ((index * 1_337) % 90_000),
    });
    const member = db.prepare(`
      INSERT INTO ProviderEditionMembers (
        provider_edition_item_id, member_item_id, medium_position, position,
        number, contextual_title, contextual_duration_ms
      ) VALUES (?, ?, 1, ?, ?, ?, ?)
    `).run(
      providerEditionItemId,
      providerItemId,
      index + 1,
      String(index + 1),
      track.title,
      180_000 + ((index * 1_337) % 90_000),
    );
    const memberId = Number(member.lastInsertRowid);
    const losslessVariant = db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, codec, container,
        lossless, bit_depth, sample_rate, bitrate, channel_count,
        channel_layout, provider_quality_label, availability
      ) VALUES (?, 'lossless-44k', 'lossless', 'flac', 'flac', 1, 16, 44100, 900000, 2, 'stereo', 'LOSSLESS', ?)
    `).run(providerItemId, input.unavailable ? "unavailable" : "available");
    expected.provider.audioVariants += 1;
    let spatialVariantId: number | null = null;
    if (input.spatialCapable) {
      const spatialVariant = db.prepare(`
        INSERT INTO ProviderItemAudioVariants (
          provider_item_id, variant_key, quality_class, codec, container,
          lossless, bit_depth, sample_rate, bitrate, channel_count,
          channel_layout, spatial_format, provider_quality_label, availability
        ) VALUES (?, 'atmos-joc', 'spatial', 'eac3', 'mp4', 0, 24, 48000, 768000, 8, '7.1', 'atmos', 'DOLBY_ATMOS', ?)
      `).run(providerItemId, input.unavailable ? "unavailable" : "available");
      spatialVariantId = Number(spatialVariant.lastInsertRowid);
      expected.provider.audioVariants += 1;
    }
    const trackMatch = db.prepare(`
      INSERT INTO ProviderTrackMatches (
        provider_track_item_id, provider_edition_member_id,
        provider_edition_match_id, track_id, recording_id,
        match_state, decision_source, confidence, method, evidence,
        matcher_version, duration_delta_ms, ambiguity_margin
      ) VALUES (?, ?, ?, ?, ?, 'accepted', 'automatic', 0.99,
                'synthetic_track_identity', ?, 1, 0, 0.5)
    `).run(
      providerItemId,
      memberId,
      editionMatchId,
      track.id,
      track.recordingId,
      JSON.stringify({ trackMbid: track.mbid, recordingMbid: track.recordingMbid }),
    );
    expected.provider.trackMatches += 1;
    assignments.push({
      track,
      providerItemId,
      providerId: providerTrackId,
      providerTrackMatchId: Number(trackMatch.lastInsertRowid),
      losslessVariantId: Number(losslessVariant.lastInsertRowid),
      spatialVariantId,
    });
  }

  if (input.addProviderOnlyTrack) {
    const position = input.tracks.length + 1;
    const providerOnlyItemId = insertProviderItem(db, expected, {
      provider: input.provider,
      entityType: "track",
      providerId: `${input.albumOrdinal}-${input.sourceOrdinal}-provider-only`,
      title: "Provider-only bonus",
      availability: input.unavailable ? "unavailable" : "available",
      explicit: null,
      durationMs: 123_000,
    });
    db.prepare(`
      INSERT INTO ProviderEditionMembers (
        provider_edition_item_id, member_item_id, medium_position, position,
        number, contextual_title, contextual_duration_ms
      ) VALUES (?, ?, 1, ?, ?, 'Provider-only bonus', 123000)
    `).run(providerEditionItemId, providerOnlyItemId, position, String(position));
    const variant = db.prepare(`
      INSERT INTO ProviderItemAudioVariants (
        provider_item_id, variant_key, quality_class, codec, container,
        lossless, bit_depth, sample_rate, bitrate, channel_count,
        channel_layout, provider_quality_label, availability
      ) VALUES (?, 'lossless-44k', 'lossless', 'flac', 'flac', 1, 16, 44100, 900000, 2, 'stereo', 'LOSSLESS', ?)
    `).run(providerOnlyItemId, input.unavailable ? "unavailable" : "available");
    void variant;
    expected.provider.audioVariants += 1;
  }

  return {
    provider: input.provider,
    providerEditionItemId,
    editionMatchId,
    relation: input.relation,
    assignments,
  };
}

function seedPlan(
  db: SqliteDb,
  expected: SyntheticExpectedState,
  input: {
    libraryId: number;
    editionId: number;
    editionMbid: string;
    sources: ProviderSourceFixture[];
    targetTrackCount: number;
    state: "current" | "stale" | "unavailable" | "failed";
    explicitMode: "explicit" | "clean" | "unknown";
    spatial: boolean;
  },
): string | null {
  if (input.sources.length === 0) return null;
  const provider = input.sources[0].provider;
  const composition = input.sources.length > 1 ? "composite" : "single_source";
  const assignmentByTrack = new Map<number, { sourceIndex: number; assignment: ProviderTrackAssignment }>();
  input.sources.forEach((source, sourceIndex) => {
    for (const assignment of source.assignments) {
      if (!assignmentByTrack.has(assignment.track.id)) {
        assignmentByTrack.set(assignment.track.id, { sourceIndex, assignment });
      }
    }
  });
  const usableAssignments = [...assignmentByTrack.values()].filter(({ assignment }) => (
    input.spatial ? assignment.spatialVariantId != null : true
  ));
  if (input.spatial && usableAssignments.length === 0) return null;
  const planKey = [
    "synthetic",
    provider,
    composition,
    input.spatial ? "spatial" : "stereo",
    input.editionMbid,
    ...input.sources.map((source) => source.providerEditionItemId),
  ].join(":");
  const explicitCount = input.explicitMode === "explicit" ? usableAssignments.length : 0;
  const cleanCount = input.explicitMode === "clean" ? usableAssignments.length : 0;
  const unknownCount = input.explicitMode === "unknown" ? usableAssignments.length : 0;
  const plan = db.prepare(`
    INSERT INTO AcquisitionPlans (
      library_id, edition_id, provider, composition, download_mode, state,
      plan_key, rank, coverage, target_track_count, quality_tier,
      explicit_content, explicit_track_count, clean_track_count,
      unknown_explicitness_count, planner_version, policy_hash, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
  `).run(
    input.libraryId,
    input.editionId,
    provider,
    composition,
    composition === "single_source" && usableAssignments.length === input.targetTrackCount ? "album" : "tracks",
    input.state,
    planKey,
    usableAssignments.length,
    input.targetTrackCount,
    input.spatial ? "spatial" : "lossless",
    input.explicitMode,
    explicitCount,
    cleanCount,
    unknownCount,
    `synthetic-policy:${input.spatial ? "spatial" : "stereo"}`,
  );
  expected.curation.plans += 1;
  const planId = Number(plan.lastInsertRowid);
  const planSourceIds: number[] = [];
  input.sources.forEach((source, sourceIndex) => {
    const planSource = db.prepare(`
      INSERT INTO AcquisitionPlanSources (
        plan_id, provider_edition_match_id, role, sort_order
      ) VALUES (?, ?, ?, ?)
    `).run(planId, source.editionMatchId, sourceIndex === 0 ? "primary" : "supplement", sourceIndex);
    planSourceIds[sourceIndex] = Number(planSource.lastInsertRowid);
    expected.curation.planSources += 1;
  });
  for (const { sourceIndex, assignment } of usableAssignments) {
    db.prepare(`
      INSERT INTO AcquisitionPlanTracks (
        plan_id, track_id, source_id, provider_track_match_id,
        provider_audio_variant_id, source_quality_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      planId,
      assignment.track.id,
      planSourceIds[sourceIndex],
      assignment.providerTrackMatchId,
      input.spatial ? assignment.spatialVariantId : assignment.losslessVariantId,
      input.spatial ? "DOLBY_ATMOS" : "LOSSLESS",
    );
    expected.curation.planTracks += 1;
  }
  return planKey;
}

function queueSyntheticCommand(
  db: SqliteDb,
  input: {
    name: string;
    refId: string;
    payload: unknown;
    priority: number;
    trigger?: number;
    status?: "queued" | "completed" | "failed" | "cancelled";
    createdAt?: string;
    completedAt?: string | null;
    error?: string | null;
  },
): number {
  const result = db.prepare(`
    INSERT INTO commands (
      name, ref_id, payload, status, progress, priority, trigger,
      queue_order, attempts, error, created_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?)
  `).run(
    input.name,
    input.refId,
    JSON.stringify(input.payload),
    input.status ?? "queued",
    input.status === "completed" ? 100 : 0,
    input.priority,
    input.trigger ?? 0,
    input.error ?? null,
    input.createdAt ?? new Date().toISOString(),
    input.completedAt ?? null,
    input.completedAt ?? input.createdAt ?? new Date().toISOString(),
  );
  const id = Number(result.lastInsertRowid);
  db.prepare("UPDATE commands SET queue_order = ? WHERE id = ?").run(id, id);
  return id;
}

function seedHistoricalCommands(
  db: SqliteDb,
  options: SyntheticGenerationOptions,
): void {
  const names = [
    "RefreshArtist",
    "MatchArtistProviders",
    "RescanFolders",
    "CurateArtist",
    "DownloadMissing",
    "DownloadTrack",
    "ImportDownload",
    "Housekeeping",
  ];
  const statuses = ["completed", "completed", "completed", "failed", "cancelled"] as const;
  const baseTime = Date.UTC(2026, 0, 1, 0, 0, 0);
  const statement = db.prepare(`
    INSERT INTO commands (
      name, ref_id, payload, status, progress, priority, trigger,
      queue_order, attempts, error, created_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `);
  const chunkSize = 1_000;
  for (let start = 0; start < options.historyRows; start += chunkSize) {
    const end = Math.min(options.historyRows, start + chunkSize);
    db.transaction(() => {
      for (let index = start; index < end; index += 1) {
        const status = statuses[index % statuses.length];
        const createdAt = new Date(baseTime + index * 1_000).toISOString();
        const completedAt = new Date(baseTime + index * 1_000 + 800).toISOString();
        statement.run(
          names[index % names.length],
          `synthetic-history-${options.seed}-${index}`,
          JSON.stringify({
            description: `Synthetic history row ${index + 1}`,
            syntheticHistory: { seed: options.seed, index },
          }),
          status,
          status === "completed" ? 100 : (index * 17) % 100,
          (index % 7) - 3,
          index % 3,
          status === "failed" ? 1 : 0,
          status === "failed" ? "deterministic synthetic historical failure" : null,
          createdAt,
          createdAt,
          completedAt,
          completedAt,
        );
      }
    })();
  }
}

async function generate(): Promise<void> {
  const startedAtMs = Date.now();
  const repoRoot = repoRootFrom(import.meta.url);
  const options = parseOptions(process.argv.slice(2), repoRoot);
  const paths = createRunPaths(options.outputRoot, options.runId);
  ensureFreshRunDirectory(paths);
  setFixtureEnvironment(paths);

  appendNdjson(paths.eventsPath, {
    at: new Date().toISOString(),
    type: "generation_started",
    runId: options.runId,
    options,
  });

  const databaseModule = await import("../../src/database.js");
  databaseModule.initDatabase();
  const db = databaseModule.db;
  const expected = emptyExpected(options);
  const deferredFiles: DeferredFileFixture[] = [];

  const libraries = db.prepare(`
    SELECT library.id, library.name, library.root_path
    FROM Libraries library
    ORDER BY library.id
  `).all() as Array<{ id: number; name: string; root_path: string }>;
  const libraryByName = new Map(libraries.map((library) => [library.name, library]));
  const stereoLibrary = libraryByName.get("Stereo");
  const spatialLibrary = libraryByName.get("Spatial");
  const videoLibrary = libraryByName.get("Video");
  if (!stereoLibrary || !spatialLibrary || !videoLibrary) {
    throw new Error("Active schema did not bootstrap Stereo, Spatial, and Video Libraries");
  }
  for (const [name, expectedPath] of [
    ["Stereo", paths.stereoRoot],
    ["Spatial", paths.spatialRoot],
    ["Video", paths.videoRoot],
  ] as const) {
    const actual = libraryByName.get(name)?.root_path;
    if (!actual || path.resolve(actual) !== path.resolve(expectedPath)) {
      throw new Error(`${name} Library escaped the synthetic root: ${actual ?? "missing"}`);
    }
  }

  const creditedArtists: CanonicalArtistFixture[] = [];
  const creditedEdges: CreditedEdge[] = [];
  const insertLegacyCredited = db.prepare(`
    INSERT INTO Artists (
      id, name, mbid, monitored, library_origin, musicbrainz_status,
      musicbrainz_match_method
    ) VALUES (?, ?, ?, 0, 'musicbrainz-credit', 'verified', 'synthetic')
  `);
  for (let start = 0; start < options.creditedArtists; start += 250) {
    const end = Math.min(options.creditedArtists, start + 250);
    db.transaction(() => {
      for (let index = start; index < end; index += 1) {
        const artist = insertArtistMetadata(db, options.seed, "credited", index);
        insertLegacyCredited.run(artist.mbid, artist.name, artist.mbid);
        creditedArtists.push(artist);
        creditedEdges.push({
          index,
          parentIndex: index % options.primaryArtists,
          artistId: artist.mbid,
          artistName: artist.name,
        });
      }
    })();
  }
  expected.artists.canonical += creditedArtists.length;
  expected.artists.legacy += creditedArtists.length;
  fs.writeFileSync(
    paths.creditedEdgesPath,
    creditedEdges.map((edge) => JSON.stringify(edge)).join("\n") + (creditedEdges.length ? "\n" : ""),
    "utf8",
  );

  const creditedByParent = new Map<number, CanonicalArtistFixture[]>();
  for (const edge of creditedEdges) {
    const bucket = creditedByParent.get(edge.parentIndex) ?? [];
    bucket.push(creditedArtists[edge.index]);
    creditedByParent.set(edge.parentIndex, bucket);
  }

  const primaryArtists: CanonicalArtistFixture[] = [];
  const pendingDownloadFixtures: Array<{
    provider: string;
    providerId: string;
    providerItemId: number;
    track: CanonicalTrackFixture;
    artist: CanonicalArtistFixture;
  }> = [];
  let albumOrdinal = 0;

  for (let artistIndex = 0; artistIndex < options.primaryArtists; artistIndex += 1) {
    const artistFiles: DeferredFileFixture[] = [];
    const behavior = classifyBehavior(artistIndex);
    expected.behavior[behavior.kind] += 1;

    db.transaction(() => {
      const artist = insertArtistMetadata(db, options.seed, "primary", artistIndex);
      primaryArtists.push(artist);
      expected.artists.canonical += 1;
      const artistPath = path.join(paths.stereoRoot, artist.name);
      assertPathWithinRoot(artistPath, paths.stereoRoot);
      db.prepare(`
        INSERT INTO Artists (
          id, name, mbid, path, monitored, monitored_at, library_origin,
          musicbrainz_status, musicbrainz_match_method
        ) VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP, 'synthetic-load', 'verified', 'synthetic')
      `).run(artist.mbid, artist.name, artist.mbid, artistPath);
      expected.artists.legacy += 1;
      const managed = db.prepare(`
        INSERT INTO ManagedArtists (
          artist_id, path, library_origin, metadata_status,
          metadata_last_checked_at, metadata_match_method
        ) VALUES (?, ?, 'synthetic-load', 'verified', CURRENT_TIMESTAMP, 'synthetic')
      `).run(artist.metadataId, artistPath);
      const managedArtistId = Number(managed.lastInsertRowid);
      expected.artists.managed += 1;
      for (const library of [stereoLibrary, spatialLibrary]) {
        db.prepare(`
          INSERT INTO LibraryArtists (
            library_id, managed_artist_id, monitored, credited_scope
          ) VALUES (?, ?, 1, 'release_and_track_credit')
        `).run(library.id, managedArtistId);
        expected.curation.libraryArtists += 1;
      }

      const providerArtistItemId = insertProviderItem(db, expected, {
        provider: artistIndex % 3 === 0 ? "apple-music" : "tidal",
        entityType: "artist",
        providerId: `synthetic-artist-${artistIndex}`,
        title: artist.name,
      });
      db.prepare(`
        INSERT INTO ProviderArtistMatches (
          provider_artist_item_id, artist_id, match_state, decision_source,
          confidence, method, evidence, matcher_version
        ) VALUES (?, ?, 'accepted', 'automatic', 0.99, 'synthetic_mbid', ?, 1)
      `).run(providerArtistItemId, artist.metadataId, JSON.stringify({ artistMbid: artist.mbid }));
      expected.provider.artistMatches += 1;

      const largeDiscography = artistIndex % 50 === 0;
      const albumCount = largeDiscography ? 12 : artistIndex % 7 === 0 ? 4 : 2;
      let artistAlbumCount = 0;
      let artistTrackCount = 0;
      let artistVideoCount = 0;

      for (let localAlbumIndex = 0; localAlbumIndex < albumCount; localAlbumIndex += 1) {
        const currentAlbumOrdinal = albumOrdinal;
        albumOrdinal += 1;
        artistAlbumCount += 1;
        const albumMbid = seededUuid(options.seed, "album", currentAlbumOrdinal);
        const albumTitle = `Synthetic Album ${String(currentAlbumOrdinal + 1).padStart(6, "0")}`;
        const album = db.prepare(`
          INSERT INTO Albums (
            foreign_album_id, mbid, artist_metadata_id, artist_mbid, title,
            primary_type, secondary_types, first_release_date, disambiguation,
            content_hash, monitored
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          albumMbid,
          albumMbid,
          artist.metadataId,
          artist.mbid,
          albumTitle,
          localAlbumIndex % 5 === 4 ? "EP" : "Album",
          JSON.stringify(localAlbumIndex % 9 === 8 ? ["Live"] : []),
          `20${String((artistIndex + localAlbumIndex) % 26).padStart(2, "0")}-01-01`,
          localAlbumIndex % 9 === 8 ? "Live synthetic edition family" : "",
          `synthetic-album:${options.seed}:${currentAlbumOrdinal}`,
        );
        const albumId = Number(album.lastInsertRowid);
        expected.catalogue.albums += 1;
        db.prepare(`
          INSERT INTO ArtistReleaseGroups (
            artist_metadata_id, artist_mbid, release_group_id,
            release_group_mbid, relationship
          ) VALUES (?, ?, ?, ?, 'primary')
        `).run(artist.metadataId, artist.mbid, albumId, albumMbid);
        db.prepare(`
          INSERT INTO AlbumArtists (
            release_group_id, release_group_mbid, artist_metadata_id,
            artist_mbid, ord, credited_name, join_phrase, is_primary
          ) VALUES (?, ?, ?, ?, 0, ?, '', 1)
        `).run(albumId, albumMbid, artist.metadataId, artist.mbid, artist.name);
        db.prepare(`
          INSERT INTO ReleaseGroupArtistCredits (
            release_group_id, artist_id, ordinal, credited_name, join_phrase, role
          ) VALUES (?, ?, 0, ?, '', 'primary')
        `).run(albumId, artist.metadataId, artist.name);
        const creditedBucket = creditedByParent.get(artistIndex) ?? [];
        const creditedArtist = creditedBucket.length > 0
          ? creditedBucket[localAlbumIndex % creditedBucket.length]
          : null;
        if (creditedArtist) {
          db.prepare(`
            INSERT INTO AlbumArtists (
              release_group_id, release_group_mbid, artist_metadata_id,
              artist_mbid, ord, credited_name, join_phrase, is_primary
            ) VALUES (?, ?, ?, ?, 1, ?, '', 0)
          `).run(
            albumId,
            albumMbid,
            creditedArtist.metadataId,
            creditedArtist.mbid,
            creditedArtist.name,
          );
          db.prepare(`
            INSERT INTO ReleaseGroupArtistCredits (
              release_group_id, artist_id, ordinal, credited_name, join_phrase, role
            ) VALUES (?, ?, 1, ?, '', 'featured')
          `).run(albumId, creditedArtist.metadataId, creditedArtist.name);
          db.prepare(`
            INSERT OR IGNORE INTO ArtistReleaseGroups (
              artist_metadata_id, artist_mbid, release_group_id,
              release_group_mbid, relationship
            ) VALUES (?, ?, ?, ?, 'credited')
          `).run(creditedArtist.metadataId, creditedArtist.mbid, albumId, albumMbid);
        }

        for (const library of [stereoLibrary, ...(currentAlbumOrdinal % 4 === 0 ? [spatialLibrary] : [])]) {
          db.prepare(`
            INSERT INTO LibraryAlbums (
              library_id, release_group_id, selection_mode, locked,
              reason, curation_version
            ) VALUES (?, ?, ?, ?, ?, 1)
          `).run(
            library.id,
            albumId,
            currentAlbumOrdinal % 17 === 0 ? "manual" : "auto",
            currentAlbumOrdinal % 19 === 0 ? 1 : 0,
            "deterministic synthetic curation",
          );
          expected.curation.libraryAlbums += 1;
        }

        const editionCount = currentAlbumOrdinal % 9 === 0 ? 3 : currentAlbumOrdinal % 3 === 0 ? 2 : 1;
        const baseTrackCount = currentAlbumOrdinal % 50 === 0 ? 18 : 6 + (currentAlbumOrdinal % 5);
        const audioRecordings: Array<{
          id: number;
          mbid: string;
          title: string;
        }> = [];
        for (let position = 0; position < baseTrackCount + 3; position += 1) {
          const recordingMbid = seededUuid(options.seed, `recording-${currentAlbumOrdinal}`, position);
          const title = `Track ${position + 1} of ${albumTitle}`;
          const recording = db.prepare(`
            INSERT INTO Recordings (
              foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
              title, artist_credit, length_ms, is_video, metadata_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'musicbrainz')
          `).run(
            recordingMbid,
            recordingMbid,
            artist.metadataId,
            artist.mbid,
            title,
            creditedArtist && position === 1
              ? `${artist.name} feat. ${creditedArtist.name}`
              : artist.name,
            180_000 + ((position * 1_337) % 90_000),
          );
          const recordingId = Number(recording.lastInsertRowid);
          audioRecordings.push({ id: recordingId, mbid: recordingMbid, title });
          expected.catalogue.recordings += 1;
          expected.catalogue.audioRecordings += 1;
          db.prepare(`
            INSERT INTO RecordingArtistCredits (
              recording_id, artist_id, ordinal, credited_name, join_phrase, role
            ) VALUES (?, ?, 0, ?, '', 'primary')
          `).run(recordingId, artist.metadataId, artist.name);
          if (creditedArtist && position === 1) {
            db.prepare(`
              INSERT INTO RecordingArtistCredits (
                recording_id, artist_id, ordinal, credited_name, join_phrase, role
              ) VALUES (?, ?, 1, ?, '', 'featured')
            `).run(recordingId, creditedArtist.metadataId, creditedArtist.name);
          }
        }

        let representativeEditionId = 0;
        let representativeEditionMbid = "";
        let representativeTracks: CanonicalTrackFixture[] = [];
        let directVideoTrack: CanonicalTrackFixture | null = null;
        for (let editionIndex = 0; editionIndex < editionCount; editionIndex += 1) {
          const editionMbid = seededUuid(options.seed, `edition-${currentAlbumOrdinal}`, editionIndex);
          const editionTitle = editionIndex === 0
            ? albumTitle
            : editionIndex === 1 ? `${albumTitle} (Deluxe Edition)` : `${albumTitle} (Anniversary Edition)`;
          const editionAudioCount = baseTrackCount + (editionIndex === 0 ? 0 : editionIndex + 1);
          const includesDirectVideoTrack = editionIndex === 0 && currentAlbumOrdinal % 101 === 0;
          const edition = db.prepare(`
            INSERT INTO AlbumEditions (
              foreign_release_id, mbid, release_group_id, release_group_mbid,
              artist_metadata_id, artist_mbid, title, status, country, date,
              barcode, disambiguation, media_count, track_count, monitored
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Official', ?, ?, ?, ?, 1, ?, 1)
          `).run(
            editionMbid,
            editionMbid,
            albumId,
            albumMbid,
            artist.metadataId,
            artist.mbid,
            editionTitle,
            JSON.stringify(["US", "GB"].slice(0, 1 + (editionIndex % 2))),
            `20${String((artistIndex + editionIndex) % 26).padStart(2, "0")}-0${editionIndex + 1}-01`,
            String(1_000_000_000_000 + currentAlbumOrdinal * 10 + editionIndex),
            editionIndex === 0 ? "" : "Expanded synthetic track list",
            editionAudioCount + (includesDirectVideoTrack ? 1 : 0),
          );
          const editionId = Number(edition.lastInsertRowid);
          expected.catalogue.editions += 1;
          db.prepare(`
            INSERT INTO ReleaseArtistCredits (
              edition_id, artist_id, ordinal, credited_name, join_phrase, role
            ) VALUES (?, ?, 0, ?, '', 'primary')
          `).run(editionId, artist.metadataId, artist.name);
          const editionTracks: CanonicalTrackFixture[] = [];
          for (let position = 0; position < editionAudioCount; position += 1) {
            const recording = audioRecordings[position];
            const trackMbid = seededUuid(
              options.seed,
              `track-${currentAlbumOrdinal}-${editionIndex}`,
              position,
            );
            const track = db.prepare(`
              INSERT INTO Tracks (
                foreign_track_id, mbid, album_edition_id, release_mbid,
                recording_id, recording_mbid, medium_position, position,
                number, title, length_ms, monitored
              ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1)
            `).run(
              trackMbid,
              trackMbid,
              editionId,
              editionMbid,
              recording.id,
              recording.mbid,
              position + 1,
              String(position + 1),
              recording.title,
              180_000 + ((position * 1_337) % 90_000),
            );
            const trackFixture = {
              id: Number(track.lastInsertRowid),
              mbid: trackMbid,
              recordingId: recording.id,
              recordingMbid: recording.mbid,
              title: recording.title,
              position: position + 1,
            };
            editionTracks.push(trackFixture);
            expected.catalogue.tracks += 1;
            artistTrackCount += 1;
            db.prepare(`
              INSERT INTO TrackArtistCredits (
                track_id, artist_id, ordinal, credited_name, join_phrase, role
              ) VALUES (?, ?, 0, ?, '', 'primary')
            `).run(trackFixture.id, artist.metadataId, artist.name);
            if (creditedArtist && position === 1) {
              db.prepare(`
                INSERT INTO TrackArtistCredits (
                  track_id, artist_id, ordinal, credited_name, join_phrase, role
                ) VALUES (?, ?, 1, ?, '', 'featured')
              `).run(trackFixture.id, creditedArtist.metadataId, creditedArtist.name);
            }
          }

          if (includesDirectVideoTrack) {
            const videoRecordingMbid = seededUuid(options.seed, "direct-video-recording", currentAlbumOrdinal);
            const videoRecording = db.prepare(`
              INSERT INTO Recordings (
                foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
                title, artist_credit, length_ms, is_video, video_variant,
                metadata_status, release_date
              ) VALUES (?, ?, ?, ?, ?, ?, 210000, 1, 'video', 'musicbrainz', CURRENT_TIMESTAMP)
            `).run(
              videoRecordingMbid,
              videoRecordingMbid,
              artist.metadataId,
              artist.mbid,
              `${albumTitle} Direct Video`,
              artist.name,
            );
            const videoRecordingId = Number(videoRecording.lastInsertRowid);
            expected.catalogue.recordings += 1;
            expected.catalogue.videoRecordings += 1;
            artistVideoCount += 1;
            const trackMbid = seededUuid(options.seed, "direct-video-track", currentAlbumOrdinal);
            const videoTrack = db.prepare(`
              INSERT INTO Tracks (
                foreign_track_id, mbid, album_edition_id, release_mbid,
                recording_id, recording_mbid, medium_position, position,
                number, title, length_ms, monitored
              ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 210000, 0)
            `).run(
              trackMbid,
              trackMbid,
              editionId,
              editionMbid,
              videoRecordingId,
              videoRecordingMbid,
              editionAudioCount + 1,
              String(editionAudioCount + 1),
              `${albumTitle} Direct Video`,
            );
            directVideoTrack = {
              id: Number(videoTrack.lastInsertRowid),
              mbid: trackMbid,
              recordingId: videoRecordingId,
              recordingMbid: videoRecordingMbid,
              title: `${albumTitle} Direct Video`,
              position: editionAudioCount + 1,
            };
            expected.catalogue.tracks += 1;
            expected.catalogue.directVideoTracks += 1;
          }

          if (editionIndex === 0) {
            representativeEditionId = editionId;
            representativeEditionMbid = editionMbid;
            representativeTracks = editionTracks;
          }
          const selectStereo = editionIndex === 0 || (editionIndex === 1 && currentAlbumOrdinal % 11 === 0);
          if (selectStereo) {
            db.prepare(`
              INSERT INTO LibraryEditions (
                library_id, edition_id, selection_mode, representative,
                reason, curation_version, preferred_plan_key,
                plan_selection_mode
              ) VALUES (?, ?, ?, ?, ?, 1, NULL, ?)
            `).run(
              stereoLibrary.id,
              editionId,
              editionIndex === 0 ? "auto" : "manual",
              editionIndex === 0 ? 1 : 0,
              editionIndex === 0 ? "representative synthetic edition" : "additive deluxe coverage",
              editionIndex === 0 ? "auto" : "manual",
            );
            expected.curation.libraryEditions += 1;
          }
          if (editionIndex === 0 && currentAlbumOrdinal % 4 === 0) {
            db.prepare(`
              INSERT INTO LibraryEditions (
                library_id, edition_id, selection_mode, representative,
                reason, curation_version, preferred_plan_key,
                plan_selection_mode
              ) VALUES (?, ?, 'auto', 1, 'spatial capability fixture', 1, NULL, 'auto')
            `).run(spatialLibrary.id, editionId);
            expected.curation.libraryEditions += 1;
          }
        }

        const shape = currentAlbumOrdinal % 7;
        const explicitMode = (["explicit", "clean", "unknown"] as const)[currentAlbumOrdinal % 3];
        let sources: ProviderSourceFixture[] = [];
        if (shape !== 5) {
          if (shape === 2) {
            const midpoint = Math.ceil(representativeTracks.length / 2);
            sources = [
              seedProviderSource(db, expected, {
                seed: options.seed,
                albumOrdinal: currentAlbumOrdinal,
                sourceOrdinal: 0,
                provider: "tidal",
                editionId: representativeEditionId,
                editionTitle: albumTitle,
                relation: "source_subset",
                tracks: representativeTracks.slice(0, midpoint),
                targetTrackCount: representativeTracks.length,
                addProviderOnlyTrack: false,
                unavailable: false,
                spatialCapable: true,
                explicitMode,
              }),
              seedProviderSource(db, expected, {
                seed: options.seed,
                albumOrdinal: currentAlbumOrdinal,
                sourceOrdinal: 1,
                provider: "tidal",
                editionId: representativeEditionId,
                editionTitle: albumTitle,
                relation: "source_subset",
                tracks: representativeTracks.slice(midpoint),
                targetTrackCount: representativeTracks.length,
                addProviderOnlyTrack: false,
                unavailable: false,
                spatialCapable: true,
                explicitMode,
              }),
            ];
          } else {
            const provider = shape === 1 || shape === 4 ? "apple-music" : "tidal";
            const selectedTracks = shape === 1
              ? representativeTracks.slice(0, Math.max(1, representativeTracks.length - 2))
              : shape === 4
                ? representativeTracks.filter((_, index) => index % 2 === 0)
                : representativeTracks;
            sources = [seedProviderSource(db, expected, {
              seed: options.seed,
              albumOrdinal: currentAlbumOrdinal,
              sourceOrdinal: 0,
              provider,
              editionId: representativeEditionId,
              editionTitle: albumTitle,
              relation: shape === 0 || shape === 6
                ? "exact"
                : shape === 1 ? "source_subset" : shape === 3 ? "source_superset" : "overlap",
              tracks: selectedTracks,
              targetTrackCount: representativeTracks.length,
              addProviderOnlyTrack: shape === 3,
              unavailable: shape === 6,
              spatialCapable: provider === "tidal",
              explicitMode,
            })];
          }
        }

        const planState = shape === 4 ? "stale" : shape === 6 ? "unavailable" : "current";
        const stereoPlanKey = seedPlan(db, expected, {
          libraryId: stereoLibrary.id,
          editionId: representativeEditionId,
          editionMbid: representativeEditionMbid,
          sources,
          targetTrackCount: representativeTracks.length,
          state: planState,
          explicitMode,
          spatial: false,
        });
        if (stereoPlanKey) {
          db.prepare(`
            UPDATE LibraryEditions
            SET preferred_plan_key = ?, plan_selection_mode = ?, updated_at = CURRENT_TIMESTAMP
            WHERE library_id = ? AND edition_id = ?
          `).run(
            stereoPlanKey,
            shape === 4 ? "manual" : "auto",
            stereoLibrary.id,
            representativeEditionId,
          );
        }
        if (currentAlbumOrdinal % 4 === 0) {
          const spatialPlanKey = seedPlan(db, expected, {
            libraryId: spatialLibrary.id,
            editionId: representativeEditionId,
            editionMbid: representativeEditionMbid,
            sources,
            targetTrackCount: representativeTracks.length,
            state: planState,
            explicitMode,
            spatial: true,
          });
          if (spatialPlanKey) {
            db.prepare(`
              UPDATE LibraryEditions
              SET preferred_plan_key = ?, updated_at = CURRENT_TIMESTAMP
              WHERE library_id = ? AND edition_id = ?
            `).run(spatialPlanKey, spatialLibrary.id, representativeEditionId);
          }
        }

        const firstAssignment = sources.flatMap((source) => source.assignments)[0];
        if (firstAssignment && pendingDownloadFixtures.length < expected.commands.initialDownloads) {
          pendingDownloadFixtures.push({
            provider: sources[0].provider,
            providerId: firstAssignment.providerId,
            providerItemId: firstAssignment.providerItemId,
            track: firstAssignment.track,
            artist,
          });
        }

        if (artistIndex % 3 === 0 && localAlbumIndex === 0 && representativeTracks[0]) {
          const relativePath = path.join(artist.name, albumTitle, `01 - ${representativeTracks[0].title}.flac`);
          const filePath = path.join(paths.stereoRoot, relativePath);
          assertPathWithinRoot(filePath, paths.stereoRoot);
          const bytes = createSyntheticBytes(options.seed, "existing-track", artistIndex, 2_048);
          artistFiles.push({ filePath, bytes });
          db.prepare(`
            INSERT INTO TrackFiles (
              artist_id, canonical_artist_mbid, canonical_release_group_mbid,
              canonical_release_mbid, canonical_track_mbid,
              canonical_recording_mbid, release_group_id, album_edition_id,
              track_id, recording_id, provider, provider_entity_type,
              provider_id, provider_item_id, library_slot, library_id,
              source_audio_variant_id, file_path, relative_path, library_root,
              filename, extension, file_size, duration, bitrate, sample_rate,
              bit_depth, channels, codec, file_type, quality, file_class,
              source_quality, imported_quality, original_filename, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stereo', ?, ?, ?, ?, ?, ?, 'flac',
                      ?, 180, 900, 44100, 16, 2, 'FLAC', 'track', 'LOSSLESS',
                      'audio', 'LOSSLESS', 'LOSSLESS', ?, CURRENT_TIMESTAMP)
          `).run(
            artist.mbid,
            artist.mbid,
            albumMbid,
            representativeEditionMbid,
            representativeTracks[0].mbid,
            representativeTracks[0].recordingMbid,
            albumId,
            representativeEditionId,
            representativeTracks[0].id,
            representativeTracks[0].recordingId,
            firstAssignment ? sources[0].provider : null,
            firstAssignment ? "track" : null,
            firstAssignment?.providerId ?? null,
            firstAssignment?.providerItemId ?? null,
            stereoLibrary.id,
            firstAssignment?.losslessVariantId ?? null,
            filePath,
            relativePath,
            paths.stereoRoot,
            path.basename(filePath),
            bytes.length,
            path.basename(filePath),
          );
          expected.files.trackFiles += 1;
          expected.files.totalBytes += bytes.length;
        }

        if (artistIndex % 11 === 0 && localAlbumIndex === 0 && representativeTracks[1]) {
          const relativePath = path.join(artist.name, albumTitle, `02 - ${representativeTracks[1].title}.m4a`);
          const filePath = path.join(paths.spatialRoot, relativePath);
          assertPathWithinRoot(filePath, paths.spatialRoot);
          const bytes = createSyntheticBytes(options.seed, "existing-spatial", artistIndex, 1_536);
          artistFiles.push({ filePath, bytes });
          db.prepare(`
            INSERT INTO TrackFiles (
              artist_id, canonical_artist_mbid, canonical_release_group_mbid,
              canonical_release_mbid, canonical_track_mbid,
              canonical_recording_mbid, release_group_id, album_edition_id,
              track_id, recording_id, library_slot, library_id,
              file_path, relative_path, library_root, filename, extension,
              file_size, duration, bitrate, sample_rate, bit_depth, channels,
              codec, file_type, quality, file_class, source_quality,
              imported_quality, original_filename, verified_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'spatial', ?, ?, ?, ?, ?, 'm4a',
                      ?, 180, 768, 48000, 24, 8, 'E-AC-3 JOC', 'track',
                      'DOLBY_ATMOS', 'audio', 'DOLBY_ATMOS', 'DOLBY_ATMOS', ?,
                      CURRENT_TIMESTAMP)
          `).run(
            artist.mbid,
            artist.mbid,
            albumMbid,
            representativeEditionMbid,
            representativeTracks[1].mbid,
            representativeTracks[1].recordingMbid,
            albumId,
            representativeEditionId,
            representativeTracks[1].id,
            representativeTracks[1].recordingId,
            spatialLibrary.id,
            filePath,
            relativePath,
            paths.spatialRoot,
            path.basename(filePath),
            bytes.length,
            path.basename(filePath),
          );
          expected.files.trackFiles += 1;
          expected.files.totalBytes += bytes.length;
        }

        if (artistIndex % 8 === 0 && localAlbumIndex === 0 && representativeTracks[0]) {
          const variants = [
            { variant: "video", slot: "video" as const, selected: true, quality: "1080P" },
            { variant: "lyrics", slot: "lyrics" as const, selected: true, quality: "720P" },
            { variant: "live", slot: "video" as const, selected: false, quality: "4K" },
          ];
          for (let videoIndex = 0; videoIndex < variants.length; videoIndex += 1) {
            const variant = variants[videoIndex];
            const videoMbid = directVideoTrack && videoIndex === 0
              ? directVideoTrack.recordingMbid
              : seededUuid(options.seed, `related-video-${artistIndex}`, videoIndex);
            let videoRecordingId = directVideoTrack && videoIndex === 0
              ? directVideoTrack.recordingId
              : 0;
            if (!videoRecordingId) {
              const recording = db.prepare(`
                INSERT INTO Recordings (
                  foreign_recording_id, mbid, artist_metadata_id, artist_mbid,
                  title, artist_credit, length_ms, is_video, video_variant,
                  metadata_status, release_date
                ) VALUES (?, ?, ?, ?, ?, ?, 210000, 1, ?, 'musicbrainz', CURRENT_TIMESTAMP)
              `).run(
                videoMbid,
                videoMbid,
                artist.metadataId,
                artist.mbid,
                `${representativeTracks[0].title} (${variant.variant})`,
                artist.name,
                variant.variant,
              );
              videoRecordingId = Number(recording.lastInsertRowid);
              expected.catalogue.recordings += 1;
              expected.catalogue.videoRecordings += 1;
              artistVideoCount += 1;
            }
            db.prepare(`
              INSERT OR IGNORE INTO RecordingRelations (
                source_recording_id, target_recording_id,
                source_foreign_recording_id, target_foreign_recording_id,
                relation_type, source, confidence, data
              ) VALUES (?, ?, ?, ?, 'music_video_for', 'synthetic', 0.99, ?)
            `).run(
              videoRecordingId,
              representativeTracks[0].recordingId,
              videoMbid,
              representativeTracks[0].recordingMbid,
              JSON.stringify({ exactRecordingRelation: true }),
            );
            const provider = videoIndex === 2 ? "youtube" : videoIndex === 1 ? "apple-music" : "tidal";
            const providerId = `synthetic-video-${artistIndex}-${videoIndex}`;
            const providerVideoItemId = insertProviderItem(db, expected, {
              provider,
              entityType: "video",
              providerId,
              title: `${representativeTracks[0].title} (${variant.variant})`,
              availability: "available",
              explicit: null,
              durationMs: 210_000,
              videoQuality: variant.quality,
            });
            db.prepare(`
              INSERT INTO ProviderVideoMatches (
                provider_video_item_id, recording_id, match_state,
                decision_source, confidence, method, evidence, matcher_version
              ) VALUES (?, ?, 'accepted', 'automatic', 0.99,
                        'synthetic_exact_recording_relation', ?, 1)
            `).run(
              providerVideoItemId,
              videoRecordingId,
              JSON.stringify({ audioRecordingMbid: representativeTracks[0].recordingMbid }),
            );
            expected.provider.videoMatches += 1;
            if (variant.selected) {
              db.prepare(`
                INSERT INTO LibraryVideos (
                  library_id, video_recording_id, preferred_offer_key,
                  selection_mode, placement_mode, placement_library_id,
                  inline_track_id, inline_slot, placement_selection_mode, reason
                ) VALUES (?, ?, ?, 'auto', 'inline', ?, ?, ?, 'auto', ?)
              `).run(
                videoLibrary.id,
                videoRecordingId,
                `${provider}:${providerId}`,
                stereoLibrary.id,
                representativeTracks[0].id,
                variant.slot,
                "deterministic inline winner",
              );
              expected.curation.libraryVideos += 1;
              expected.curation.inlineVideos += 1;
              if (artistIndex % 16 === 0 && videoIndex === 0) {
                const relativePath = path.join(
                  artist.name,
                  albumTitle,
                  `${representativeTracks[0].position.toString().padStart(2, "0")} - ${representativeTracks[0].title}-video.mp4`,
                );
                const filePath = path.join(paths.stereoRoot, relativePath);
                assertPathWithinRoot(filePath, paths.stereoRoot);
                const bytes = createSyntheticBytes(options.seed, "existing-video", artistIndex, 4_096);
                artistFiles.push({ filePath, bytes });
                db.prepare(`
                  INSERT INTO TrackFiles (
                    artist_id, canonical_artist_mbid, canonical_release_group_mbid,
                    canonical_release_mbid, canonical_recording_mbid,
                    release_group_id, album_edition_id, recording_id,
                    provider, provider_entity_type, provider_id, provider_item_id,
                    library_slot, library_id, file_path, relative_path,
                    library_root, filename, extension, file_size, duration,
                    bitrate, channels, codec, video_codec, width, height,
                    file_type, quality, file_class, source_quality,
                    imported_quality, original_filename, verified_at
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'video', ?, ?, 'video', ?, ?, ?, ?, ?, 'mp4',
                            ?, 210, 4000, 2, 'AAC', 'h264', 1920, 1080, 'video',
                            '1080P', 'video', '1080P', '1080P', ?, CURRENT_TIMESTAMP)
                `).run(
                  artist.mbid,
                  artist.mbid,
                  albumMbid,
                  representativeEditionMbid,
                  videoMbid,
                  albumId,
                  representativeEditionId,
                  videoRecordingId,
                  provider,
                  providerId,
                  providerVideoItemId,
                  videoLibrary.id,
                  filePath,
                  relativePath,
                  paths.stereoRoot,
                  path.basename(filePath),
                  bytes.length,
                  path.basename(filePath),
                );
                expected.files.trackFiles += 1;
                expected.files.totalBytes += bytes.length;
              }
            }
          }
        }
      }

      db.prepare(`
        INSERT INTO ArtistStatistics (
          artist_id, artist_mbid, album_count, monitored_album_count,
          downloaded_album_count, track_count, monitored_track_count,
          track_file_count, video_count, size_on_disk
        ) VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?, 0)
      `).run(
        artist.mbid,
        artist.mbid,
        artistAlbumCount,
        artistAlbumCount,
        artistTrackCount,
        artistTrackCount,
        artistVideoCount,
      );
    })();

    for (const file of artistFiles) {
      assertPathWithinRoot(file.filePath, paths.mediaRoot);
      fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
      fs.writeFileSync(file.filePath, file.bytes);
      deferredFiles.push(file);
    }
    if ((artistIndex + 1) % 50 === 0 || artistIndex + 1 === options.primaryArtists) {
      appendNdjson(paths.eventsPath, {
        at: new Date().toISOString(),
        type: "generation_progress",
        completedArtists: artistIndex + 1,
        totalArtists: options.primaryArtists,
        albums: expected.catalogue.albums,
        tracks: expected.catalogue.tracks,
      });
    }
  }

  const unmappedCount = Math.max(5, Math.floor(options.primaryArtists / 10));
  const insertUnmapped = db.prepare(`
    INSERT INTO UnmappedFiles (
      file_path, relative_path, library_root, filename, extension,
      file_size, duration, bitrate, sample_rate, bit_depth, channels,
      codec, detected_artist, detected_album, detected_track,
      audio_quality, reason, ignored
    ) VALUES (?, ?, ?, ?, 'flac', ?, 180, 900, 44100, 16, 2, 'FLAC',
              ?, ?, ?, '16-BIT 44.1KHZ FLAC', ?, ?)
  `);
  db.transaction(() => {
    for (let index = 0; index < unmappedCount; index += 1) {
      const relativePath = path.join(`Unknown Artist ${index % 17}`, `Unmapped ${index + 1}.flac`);
      const filePath = path.join(paths.unmappedRoot, relativePath);
      assertPathWithinRoot(filePath, paths.unmappedRoot);
      const bytes = createSyntheticBytes(options.seed, "unmapped", index, 1_024);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, bytes);
      insertUnmapped.run(
        filePath,
        relativePath,
        paths.unmappedRoot,
        path.basename(filePath),
        bytes.length,
        `Unknown Artist ${index % 17}`,
        `Unknown Album ${index % 9}`,
        `Unmapped ${index + 1}`,
        index % 4 === 0 ? "no canonical match" : "ambiguous duplicate title",
        index % 23 === 0 ? 1 : 0,
      );
      expected.files.unmappedFiles += 1;
      expected.files.totalBytes += bytes.length;
    }
  })();

  seedHistoricalCommands(db, options);
  db.transaction(() => {
    for (const artist of primaryArtists) {
      const behavior = classifyBehavior(artist.index);
      queueSyntheticCommand(db, {
        name: "RefreshArtist",
        refId: `rh:${options.runId}:p:${artist.index}:c:1:s:RefreshArtist`,
        priority: 1,
        payload: {
          artistId: artist.mbid,
          artistName: artist.name,
          workflow: "metadata-refresh",
          monitorArtist: true,
          hydrateCatalog: true,
          hydrateAlbumTracks: true,
          scanLibrary: true,
          forceDownloadQueue: true,
          forceUpdate: false,
          syntheticLoad: {
            runId: options.runId,
            role: "primary",
            artistIndex: artist.index,
            cycle: 1,
            stage: "RefreshArtist",
            behavior,
          },
        },
      });
    }
    for (let index = 0; index < expected.commands.initialDownloads; index += 1) {
      const fixture = pendingDownloadFixtures[index % Math.max(1, pendingDownloadFixtures.length)];
      queueSyntheticCommand(db, {
        name: "DownloadTrack",
        refId: `rh:${options.runId}:d:${index}`,
        priority: 20,
        trigger: 1,
        payload: {
          type: "track",
          provider: fixture?.provider ?? "tidal",
          providerId: fixture?.providerId ?? `synthetic-pending-${index}`,
          canonicalTrackId: fixture ? String(fixture.track.id) : null,
          canonicalTrackMbid: fixture?.track.mbid ?? null,
          canonicalRecordingMbid: fixture?.track.recordingMbid ?? null,
          artistId: fixture?.artist.mbid ?? primaryArtists[index % primaryArtists.length].mbid,
          artistName: fixture?.artist.name ?? primaryArtists[index % primaryArtists.length].name,
          syntheticLoad: {
            runId: options.runId,
            role: "preexisting_download",
            index,
            stage: "DownloadTrack",
            behavior: { kind: "normal" },
          },
        },
      });
    }
  })();

  expected.artists.canonical = options.primaryArtists + options.creditedArtists;
  const schemaVersion = Number(db.pragma("user_version", { simple: true }));
  const quickCheck = String(db.pragma("quick_check", { simple: true }));
  const foreignKeyErrors = db.pragma("foreign_key_check") as unknown[];
  if (schemaVersion !== 42 || quickCheck !== "ok" || foreignKeyErrors.length > 0) {
    throw new Error(
      `Generated database integrity failed: schema=${schemaVersion}, quick_check=${quickCheck}, `
      + `foreign_key_errors=${foreignKeyErrors.length}`,
    );
  }

  writeJson(paths.expectedPath, expected);
  const manifest: SyntheticRunManifest = {
    format: SYNTHETIC_RUN_FORMAT,
    runId: options.runId,
    gitSha: getGitSha(repoRoot),
    dockerImageId: getDockerImageId(),
    schemaVersion,
    seed: options.seed,
    generatedAt: new Date().toISOString(),
    generatorDurationMs: Date.now() - startedAtMs,
    configuration: {
      primaryArtists: options.primaryArtists,
      creditedArtists: options.creditedArtists,
      historyRows: options.historyRows,
      requestedConcurrency: options.concurrency,
    },
    paths: {
      runRoot: paths.runRoot,
      databasePath: paths.databasePath,
      stereoRoot: paths.stereoRoot,
      spatialRoot: paths.spatialRoot,
      videoRoot: paths.videoRoot,
      downloadRoot: paths.downloadRoot,
      unmappedRoot: paths.unmappedRoot,
    },
    warnings: [
      "Media payloads are deterministic placeholder bytes, not decodable audio/video.",
      "Synthetic workers exercise the real SQLite command table and WAL, but do not invoke production metadata/provider/download handlers.",
      "API and SSE latency require the separate Docker/API layer and are not inferred by this generator.",
    ],
  };
  writeJson(paths.manifestPath, manifest);
  appendNdjson(paths.eventsPath, {
    at: new Date().toISOString(),
    type: "generation_completed",
    durationMs: manifest.generatorDurationMs,
    expected,
    integrity: { schemaVersion, quickCheck, foreignKeyErrors: foreignKeyErrors.length },
  });
  databaseModule.closeDatabase();

  console.log(JSON.stringify({
    status: "generated",
    runId: options.runId,
    runRoot: paths.runRoot,
    databasePath: paths.databasePath,
    manifest: paths.manifestPath,
    expected: paths.expectedPath,
    durationMs: manifest.generatorDurationMs,
  }, null, 2));
}

function isMainModule(): boolean {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return invoked === path.resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  generate().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}

export { generate, parseOptions };
