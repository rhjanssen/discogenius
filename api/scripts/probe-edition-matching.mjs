// Probe the canonical <-> provider matching, edition relation and acquisition
// plans for one canonical edition, against a real Discogenius database.
//
// This exists because matching failures are only legible with the *whole*
// picture: the canonical tracks, the provider edition members with their
// structural context (medium/position/contextual title/duration), every
// candidate score, the ambiguity margins that filtered edges out, and the final
// one-to-one assignment. Reading any one of those alone hides the cause.
//
//   node api/scripts/probe-edition-matching.mjs <edition-mbid> [path/to/discogenius.db]
//
// Scores are recomputed with the compiled matcher so the probe reflects the
// code under test, not a paraphrase of it. Pass --json for machine output.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const args = process.argv.slice(2).filter((a) => a !== "--json");
const asJson = process.argv.includes("--json");
const editionMbid = args[0];
const dbPath = args[1] || path.join(repoRoot, "config", "discogenius.db");

if (!editionMbid) {
  console.error("Usage: node api/scripts/probe-edition-matching.mjs <edition-mbid> [db]");
  process.exit(1);
}

// Prefer the compiled matcher next to this script (container: /app/api/dist),
// fall back to a source-tree build.
async function loadMatcher() {
  const candidates = [
    path.join(repoRoot, "api", "dist", "src", "services", "music", "provider-track-matcher.js"),
    path.join(here, "..", "dist", "src", "services", "music", "provider-track-matcher.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return import(`file://${candidate}`);
    }
  }
  throw new Error(`Compiled matcher not found. Looked in:\n  ${candidates.join("\n  ")}\nRun \`yarn --cwd api build\` first.`);
}

function normalizeIsrcs(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return (Array.isArray(parsed) ? parsed : [])
      .map((isrc) => String(isrc || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const secs = (ms) => (ms == null ? null : Math.round(ms / 1000));
const explicitLabel = (value) => (value == null ? "null" : value ? "true" : "false");

async function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }
  const { scoreTrackMatch, TRACK_MATCH_THRESHOLD } = await loadMatcher();
  const db = new Database(dbPath, { readonly: true });

  const edition = db.prepare(`
    SELECT e.id, e.mbid, e.title, e.release_group_id, a.title AS album_title
    FROM AlbumEditions e
    LEFT JOIN Albums a ON a.id = e.release_group_id
    WHERE e.mbid = ?
  `).get(editionMbid);
  if (!edition) {
    console.error(`No canonical edition with mbid ${editionMbid}`);
    process.exit(1);
  }

  const canonicalRows = db.prepare(`
    SELECT t.id, t.recording_id, r.mbid AS recording_mbid, r.isrcs,
           t.title, t.length_ms, t.position, t.medium_position
    FROM Tracks t
    JOIN Recordings r ON r.id = t.recording_id
    WHERE t.album_edition_id = ? AND r.is_video = 0
    ORDER BY t.medium_position, t.position, t.id
  `).all(edition.id);

  const targets = canonicalRows.map((row) => ({
    trackId: row.id,
    recordingId: row.recording_id,
    recordingMbid: row.recording_mbid,
    isrcs: normalizeIsrcs(row.isrcs),
    title: row.title,
    medium: row.medium_position,
    position: row.position,
    durationSec: secs(row.length_ms),
    matchTarget: {
      recordingMbid: row.recording_mbid,
      isrcs: new Set(normalizeIsrcs(row.isrcs)),
      title: row.title,
      trackNumber: row.position,
      volumeNumber: row.medium_position,
      durationSec: row.length_ms == null ? null : row.length_ms / 1000,
    },
  }));

  // Every provider edition that either already relates to this canonical
  // edition, or shares its release group through an accepted match.
  const providerEditions = db.prepare(`
    SELECT pi.id, pi.provider, pi.provider_id, pi.title, pi.version, pi.upc,
           pi.explicit, pi.availability, pi.release_date, pi.volume_count,
           m.id AS match_id, m.relation, m.match_state, m.confidence, m.method,
           m.matched_track_count, m.source_track_count, m.target_track_count,
           m.source_coverage, m.target_coverage, m.matcher_version
    FROM ProviderEditionMatches m
    JOIN ProviderItems pi ON pi.id = m.provider_edition_item_id
    WHERE m.edition_id = ?
    ORDER BY pi.provider, pi.provider_id
  `).all(edition.id);

  const memberStmt = db.prepare(`
    SELECT mem.id AS member_id, mem.medium_position, mem.position, mem.number,
           mem.contextual_title, mem.contextual_duration_ms,
           it.id AS item_id, it.entity_type, it.provider_id, it.title, it.version,
           it.isrc, it.duration_ms, it.explicit, it.availability
    FROM ProviderEditionMembers mem
    JOIN ProviderItems it ON it.id = mem.member_item_id
    WHERE mem.provider_edition_item_id = ?
    ORDER BY mem.medium_position, mem.position, mem.id
  `);

  const trackMatchStmt = db.prepare(`
    SELECT ptm.provider_edition_member_id, ptm.track_id, ptm.recording_id,
           ptm.match_state, ptm.confidence, ptm.method, ptm.ambiguity_margin,
           ptm.duration_delta_ms, ptm.evidence
    FROM ProviderTrackMatches ptm
    JOIN ProviderEditionMembers mem ON mem.id = ptm.provider_edition_member_id
    WHERE mem.provider_edition_item_id = ?
  `);

  const variantStmt = db.prepare(`
    SELECT variant_key, quality_class, codec, container, lossless, bit_depth,
           sample_rate, bitrate, channel_count, spatial_format,
           provider_quality_label, availability
    FROM ProviderItemAudioVariants
    WHERE provider_item_id = ?
    ORDER BY variant_key
  `);

  const report = {
    database: path.relative(repoRoot, dbPath),
    canonicalEdition: {
      id: edition.id,
      mbid: edition.mbid,
      title: edition.title,
      album: edition.album_title,
      trackCount: targets.length,
      isrcCoverage: `${targets.filter((t) => t.isrcs.length > 0).length}/${targets.length}`,
    },
    canonicalTracks: targets.map((t) => ({
      trackId: t.trackId,
      medium: t.medium,
      position: t.position,
      title: t.title,
      durationSec: t.durationSec,
      recordingMbid: t.recordingMbid,
      isrcs: t.isrcs,
    })),
    providerEditions: [],
    plans: [],
  };

  for (const pe of providerEditions) {
    const members = memberStmt.all(pe.id);
    const persisted = trackMatchStmt.all(pe.id);
    const persistedByMember = new Map(persisted.map((row) => [row.provider_edition_member_id, row]));
    const audioMembers = members.filter((m) => m.entity_type === "track");

    // Recompute candidate scores exactly as ingestion does today (item-only,
    // no member structure) *and* as it would with member structure restored,
    // so the probe shows what the structural context is worth.
    const asItemOnly = (m) => ({
      mbid: null,
      isrc: m.isrc || null,
      title: m.title || "",
      version: m.version || null,
      trackNumber: null,
      volumeNumber: null,
      durationSec: m.duration_ms == null ? null : m.duration_ms / 1000,
    });
    const asStructural = (m) => ({
      mbid: null,
      isrc: m.isrc || null,
      title: m.contextual_title || m.title || "",
      version: m.version || null,
      trackNumber: m.position,
      volumeNumber: m.medium_position,
      durationSec: (m.contextual_duration_ms ?? m.duration_ms) == null
        ? null
        : (m.contextual_duration_ms ?? m.duration_ms) / 1000,
    });

    const scoreGrid = (shape) => audioMembers.map((m) =>
      targets.map((t) => scoreTrackMatch(t.matchTarget, shape(m))));
    const itemScores = scoreGrid(asItemOnly);
    const structuralScores = scoreGrid(asStructural);

    const marginsFor = (scores) => {
      const sourceMargins = scores.map((row) => {
        const ranked = [...row].sort((a, b) => b - a);
        return (ranked[0] ?? 0) - (ranked[1] ?? 0);
      });
      const targetMargins = targets.map((_, ti) => {
        const ranked = scores.map((row) => row[ti] || 0).sort((a, b) => b - a);
        return (ranked[0] ?? 0) - (ranked[1] ?? 0);
      });
      return { sourceMargins, targetMargins };
    };
    const itemMargins = marginsFor(itemScores);
    const structuralMargins = marginsFor(structuralScores);

    const memberReport = audioMembers.map((m, si) => {
      const best = (scores) => {
        const ranked = targets
          .map((t, ti) => ({ ti, trackId: t.trackId, title: t.title, score: scores[si][ti] || 0 }))
          .sort((a, b) => b.score - a.score);
        return ranked.slice(0, 3);
      };
      const persistedRow = persistedByMember.get(m.member_id);
      return {
        memberId: m.member_id,
        medium: m.medium_position,
        position: m.position,
        number: m.number,
        itemTitle: m.title,
        contextualTitle: m.contextual_title,
        version: m.version,
        itemDurationSec: secs(m.duration_ms),
        contextualDurationSec: secs(m.contextual_duration_ms),
        isrc: m.isrc,
        explicit: explicitLabel(m.explicit == null ? null : Boolean(m.explicit)),
        availability: m.availability,
        variants: variantStmt.all(m.item_id),
        candidatesItemOnly: best(itemScores),
        candidatesWithStructure: best(structuralScores),
        sourceMarginItemOnly: Number(itemMargins.sourceMargins[si].toFixed(3)),
        sourceMarginWithStructure: Number(structuralMargins.sourceMargins[si].toFixed(3)),
        persisted: persistedRow
          ? {
            matchState: persistedRow.match_state,
            trackId: persistedRow.track_id,
            recordingId: persistedRow.recording_id,
            confidence: persistedRow.confidence,
            method: persistedRow.method,
            ambiguityMargin: persistedRow.ambiguity_margin,
            durationDeltaMs: persistedRow.duration_delta_ms,
          }
          : null,
      };
    });

    const assignedTrackIds = new Set(
      persisted.filter((r) => r.match_state === "accepted" && r.track_id != null).map((r) => r.track_id),
    );

    report.providerEditions.push({
      providerItemId: pe.id,
      provider: pe.provider,
      providerId: pe.provider_id,
      title: pe.title,
      version: pe.version,
      upc: pe.upc,
      explicit: explicitLabel(pe.explicit == null ? null : Boolean(pe.explicit)),
      availability: pe.availability,
      releaseDate: pe.release_date,
      volumeCount: pe.volume_count,
      releaseVariants: variantStmt.all(pe.id),
      relation: {
        relation: pe.relation,
        matchState: pe.match_state,
        confidence: pe.confidence,
        method: pe.method,
        matchedTrackCount: pe.matched_track_count,
        sourceTrackCount: pe.source_track_count,
        targetTrackCount: pe.target_track_count,
        sourceCoverage: pe.source_coverage,
        targetCoverage: pe.target_coverage,
        matcherVersion: pe.matcher_version,
      },
      memberCounts: {
        total: members.length,
        audio: audioMembers.length,
        video: members.length - audioMembers.length,
      },
      canonicalCoverage: `${assignedTrackIds.size}/${targets.length}`,
      unassignedCanonicalTracks: targets
        .filter((t) => !assignedTrackIds.has(t.trackId))
        .map((t) => ({ trackId: t.trackId, medium: t.medium, position: t.position, title: t.title, durationSec: t.durationSec })),
      members: memberReport,
    });
  }

  const planRows = db.prepare(`
    SELECT p.id, p.library_id, l.name AS library_name, p.provider, p.composition,
           p.download_mode, p.state, p.plan_key, p.rank, p.coverage,
           p.target_track_count, p.quality_tier, p.explicit_content,
           p.explicit_track_count, p.clean_track_count, p.unknown_explicitness_count,
           p.planner_version
    FROM AcquisitionPlans p
    LEFT JOIN Libraries l ON l.id = p.library_id
    WHERE p.edition_id = ?
    ORDER BY p.library_id, p.rank, p.id
  `).all(edition.id);

  const planSourceStmt = db.prepare(`
    SELECT s.role, s.sort_order, pi.provider, pi.provider_id, pi.title, m.relation
    FROM AcquisitionPlanSources s
    JOIN ProviderEditionMatches m ON m.id = s.provider_edition_match_id
    JOIN ProviderItems pi ON pi.id = m.provider_edition_item_id
    WHERE s.plan_id = ?
    ORDER BY s.sort_order
  `);
  const planQualityStmt = db.prepare(`
    SELECT v.quality_class, COUNT(*) AS count
    FROM AcquisitionPlanTracks t
    LEFT JOIN ProviderItemAudioVariants v ON v.id = t.provider_audio_variant_id
    WHERE t.plan_id = ?
    GROUP BY v.quality_class
    ORDER BY count DESC
  `);

  for (const plan of planRows) {
    report.plans.push({
      id: plan.id,
      library: { id: plan.library_id, name: plan.library_name },
      provider: plan.provider,
      composition: plan.composition,
      downloadMode: plan.download_mode,
      state: plan.state,
      planKey: plan.plan_key,
      rank: plan.rank,
      coverage: `${plan.coverage}/${plan.target_track_count}`,
      qualityTier: plan.quality_tier,
      deliveredQuality: planQualityStmt.all(plan.id),
      explicitContent: plan.explicit_content,
      explicitTrackCount: plan.explicit_track_count,
      cleanTrackCount: plan.clean_track_count,
      unknownExplicitnessCount: plan.unknown_explicitness_count,
      plannerVersion: plan.planner_version,
      sources: planSourceStmt.all(plan.id),
    });
  }

  db.close();

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const ed = report.canonicalEdition;
  console.log(`CANONICAL EDITION  ${ed.title}`);
  console.log(`  id=${ed.id} mbid=${ed.mbid} tracks=${ed.trackCount} isrcCoverage=${ed.isrcCoverage}`);
  console.log(`  match threshold=${TRACK_MATCH_THRESHOLD}`);
  for (const pe of report.providerEditions) {
    console.log("");
    console.log(`PROVIDER EDITION   ${pe.provider}:${pe.providerId}  "${pe.title}"${pe.version ? ` [${pe.version}]` : ""}`);
    console.log(`  explicit=${pe.explicit} upc=${pe.upc || "-"} members=${pe.memberCounts.audio} audio / ${pe.memberCounts.video} video`);
    console.log(`  relation=${pe.relation.relation} state=${pe.relation.matchState} method=${pe.relation.method} coverage=${pe.canonicalCoverage}`);
    if (pe.unassignedCanonicalTracks.length) {
      console.log(`  UNASSIGNED canonical tracks (${pe.unassignedCanonicalTracks.length}):`);
      for (const t of pe.unassignedCanonicalTracks) {
        console.log(`    - d${t.medium}t${t.position} "${t.title}" ${t.durationSec}s (trackId=${t.trackId})`);
      }
    }
    for (const m of pe.members) {
      const p = m.persisted;
      const state = p ? `${p.match_state || p.matchState}->track ${p.trackId} (${p.method} conf=${p.confidence})` : "NO PERSISTED MATCH";
      console.log(`    d${m.medium}t${m.position} "${m.contextualTitle || m.itemTitle}" ${m.contextualDurationSec ?? m.itemDurationSec}s isrc=${m.isrc || "-"} explicit=${m.explicit}`);
      console.log(`        persisted: ${state}`);
      console.log(`        item-only  top: ${m.candidatesItemOnly.map((c) => `${c.score.toFixed(3)}@${c.trackId}`).join(" ")} (margin ${m.sourceMarginItemOnly})`);
      console.log(`        structural top: ${m.candidatesWithStructure.map((c) => `${c.score.toFixed(3)}@${c.trackId}`).join(" ")} (margin ${m.sourceMarginWithStructure})`);
    }
  }
  console.log("");
  console.log(`ACQUISITION PLANS (${report.plans.length})`);
  for (const plan of report.plans) {
    console.log(`  [${plan.library.name}] ${plan.provider} ${plan.composition}/${plan.downloadMode} state=${plan.state} rank=${plan.rank}`);
    console.log(`      coverage=${plan.coverage} tier=${plan.qualityTier} delivered=${plan.deliveredQuality.map((q) => `${q.quality_class || "?"}x${q.count}`).join(" ")}`);
    console.log(`      explicitContent=${plan.explicitContent} explicit=${plan.explicitTrackCount} clean=${plan.cleanTrackCount} unknown=${plan.unknownExplicitnessCount}`);
    console.log(`      key=${plan.planKey}`);
    console.log(`      sources=${plan.sources.map((s) => `${s.provider}:${s.provider_id}(${s.relation})`).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
