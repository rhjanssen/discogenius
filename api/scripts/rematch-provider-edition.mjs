// Re-run track matching for provider releases already stored in the catalog,
// without contacting the provider.
//
// Matching is a decision over stored rows, not a consequence of new data, so a
// matcher fix has to be replayable against a catalog that was matched by an
// older version. Refresh does this automatically for releases it walks; this
// script targets specific ones (or a whole canonical edition) directly.
//
//   node api/scripts/rematch-provider-edition.mjs --edition <mbid> [db]
//   node api/scripts/rematch-provider-edition.mjs --provider tidal --release 243860257 [db]
//
// Item facts, credits and audio variants are left untouched — only the match
// decision is recomputed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const argv = process.argv.slice(2);
function flag(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : null;
}
const editionMbid = flag("edition");
const providerFilter = flag("provider");
const releaseFilter = flag("release");
const dbPath = argv.find((arg, index) =>
  !arg.startsWith("--") && argv[index - 1] !== "--edition"
  && argv[index - 1] !== "--provider" && argv[index - 1] !== "--release")
  || path.join(repoRoot, "config", "discogenius.db");

if (!editionMbid && !releaseFilter) {
  console.error("Usage: node api/scripts/rematch-provider-edition.mjs (--edition <mbid> | --provider <id> --release <id>) [db]");
  process.exit(1);
}

async function loadIngestion() {
  const candidates = [
    path.join(repoRoot, "api", "dist", "src", "services", "providers", "provider-release-ingestion-service.js"),
    path.join(here, "..", "dist", "src", "services", "providers", "provider-release-ingestion-service.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return import(`file://${candidate}`);
  }
  throw new Error(`Compiled ingestion service not found in:\n  ${candidates.join("\n  ")}`);
}

const text = (value) => {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
};
const positive = (value) => {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
};
const finite = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

async function main() {
  const { ProviderReleaseIngestionService } = await loadIngestion();
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");

  const targets = editionMbid
    ? db.prepare(`
        SELECT item.provider, item.provider_id, item.id AS item_id, edition.id AS edition_id, edition.title
        FROM AlbumEditions edition
        JOIN ProviderEditionMatches match ON match.edition_id = edition.id
        JOIN ProviderItems item ON item.id = match.provider_edition_item_id
        WHERE edition.mbid = ?
        ORDER BY item.provider, item.provider_id
      `).all(editionMbid)
    : db.prepare(`
        SELECT item.provider, item.provider_id, item.id AS item_id, edition.id AS edition_id, edition.title
        FROM ProviderItems item
        JOIN ProviderEditionMatches match
          ON match.provider_edition_item_id = item.id AND match.match_state = 'accepted'
        JOIN AlbumEditions edition ON edition.id = match.edition_id
        WHERE item.provider = ? AND item.entity_type = 'release' AND item.provider_id = ?
      `).all(providerFilter, releaseFilter);

  if (targets.length === 0) {
    console.error("No matched provider releases found for that selector.");
    process.exit(1);
  }

  const releaseStmt = db.prepare(`
    SELECT title, version, provider_type, upc, duration_ms, release_date, explicit,
           availability, checked_at, provider_url, cover_id, artwork_url,
           volume_count, copyright
    FROM ProviderItems WHERE id = ?
  `);
  const memberStmt = db.prepare(`
    SELECT member.medium_position, member.position, member.number,
           member.contextual_title, member.contextual_duration_ms,
           item.entity_type, item.provider_id, item.title, item.version, item.isrc,
           item.duration_ms, item.release_date, item.explicit, item.availability,
           item.provider_url, item.cover_id, item.artwork_url, item.replay_gain,
           item.peak, item.bpm, item.musical_key, item.copyright
    FROM ProviderEditionMembers member
    JOIN ProviderItems item ON item.id = member.member_item_id
    WHERE member.provider_edition_item_id = ?
    ORDER BY member.medium_position, member.position, member.id
  `);

  const service = new ProviderReleaseIngestionService(db);
  for (const target of targets) {
    const releaseRow = releaseStmt.get(target.item_id);
    const memberRows = memberStmt.all(target.item_id);
    if (!releaseRow || memberRows.length === 0) {
      console.log(`${target.provider}:${target.provider_id} — no stored members, skipped`);
      continue;
    }
    const result = service.ingest({
      canonicalReleaseId: target.edition_id,
      matcherVersion: 1,
      release: {
        provider: target.provider,
        entityType: "release",
        providerId: String(target.provider_id),
        title: text(releaseRow.title),
        version: text(releaseRow.version),
        providerType: text(releaseRow.provider_type),
        upc: text(releaseRow.upc),
        durationMs: positive(releaseRow.duration_ms),
        releaseDate: text(releaseRow.release_date),
        explicit: releaseRow.explicit == null ? null : Boolean(releaseRow.explicit),
        availability: text(releaseRow.availability) || "available",
        checkedAt: text(releaseRow.checked_at) || new Date().toISOString(),
        providerUrl: text(releaseRow.provider_url),
        coverId: text(releaseRow.cover_id),
        artworkUrl: text(releaseRow.artwork_url),
        volumeCount: positive(releaseRow.volume_count),
        copyright: text(releaseRow.copyright),
      },
      members: memberRows.map((row) => ({
        item: {
          provider: target.provider,
          entityType: row.entity_type === "video" ? "video" : "track",
          providerId: String(row.provider_id),
          title: text(row.title),
          version: text(row.version),
          isrc: text(row.isrc),
          durationMs: positive(row.duration_ms),
          releaseDate: text(row.release_date),
          explicit: row.explicit == null ? null : Boolean(row.explicit),
          availability: text(row.availability) || "available",
          providerUrl: text(row.provider_url),
          coverId: text(row.cover_id),
          artworkUrl: text(row.artwork_url),
          replayGain: finite(row.replay_gain),
          peak: finite(row.peak),
          bpm: finite(row.bpm),
          musicalKey: text(row.musical_key),
          copyright: text(row.copyright),
        },
        mediumPosition: Number(row.medium_position || 1),
        position: Number(row.position || 0),
        number: text(row.number),
        contextualTitle: text(row.contextual_title),
        contextualDurationMs: positive(row.contextual_duration_ms),
      })),
    });
    const relation = db.prepare(`
      SELECT relation, matched_track_count, target_track_count
      FROM ProviderEditionMatches
      WHERE provider_edition_item_id = ? AND edition_id = ?
    `).get(target.item_id, target.edition_id);
    console.log(
      `${target.provider}:${target.provider_id} → accepted=${result.acceptedTrackCount}`
      + ` ambiguous=${result.ambiguousTrackCount}`
      + ` relation=${relation?.relation ?? "-"}`
      + ` coverage=${relation?.matched_track_count ?? "?"}/${relation?.target_track_count ?? "?"}`,
    );
  }
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
