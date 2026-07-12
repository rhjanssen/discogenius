// Capture real matching fixtures from a scanned Discogenius database.
//
// The matcher's inputs are two arrays — the artist's MusicBrainz release groups
// (with releases/tracks/ISRCs/barcodes) and the provider's albums (with track
// ISRCs). Both are produced by real scans against real sources (MusicBrainz
// Postgres, the Servarr metadata server, and the streaming provider). This
// script snapshots them into JSON so the golden-master test can exercise the
// matcher on actual data offline, deterministically.
//
// Regenerate after a scan:
//   node api/scripts/capture-match-fixtures.mjs [path/to/discogenius.db]
// The DB already reflects whichever catalog mode (musicbrainz | servarr) and
// whichever provider(s) were active during the scan, so switching mode/provider
// and re-scanning, then re-running this, captures that combination.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const dbPath = process.argv[2] || path.join(repoRoot, "config", "discogenius.db");
const outDir = path.join(repoRoot, "api", "test-fixtures", "matching");

// The artists to capture. Robert's canonical test cases: Bakermat exercises the
// remix-vs-radio-edit selection; Bastille exercises the multi-album composite.
const ARTISTS = [
  { slug: "bakermat", name: "Bakermat", mbid: "df60a241-e8df-4917-82db-1f1a8ecd7cc3" },
  { slug: "bastille", name: "Bastille", mbid: "7808accb-6395-4b25-858c-678bbb73896b" },
  { slug: "imagine-dragons", name: "Imagine Dragons", mbid: "012151a8-0f9a-44c9-997f-ebd68b5389f9" },
  { slug: "coldplay", name: "Coldplay", mbid: "cc197bad-dc9c-440d-a5b5-d52ba2e14234" },
  // Amy Winehouse exercises the quality-aware hybrid planner: Back to Black's
  // hi-res 11-track album + lossless deluxe must combine per volume, and the
  // "(live at Kalkscheune, Berlin)" disc of the 3-media German edition must
  // stay uncovered (TIDAL carries no Kalkscheune session).
  { slug: "amy-winehouse", name: "Amy Winehouse", mbid: "dfe9a7c4-8cf2-47f4-9dcb-d233c2b86ec3" },
];

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function captureReleaseGroups(db, artistMbid) {
  const rgs = db.prepare(`
    SELECT DISTINCT rg.mbid, rg.title, rg.primary_type, rg.secondary_types, rg.first_release_date, rg.disambiguation
    FROM Albums rg
    LEFT JOIN ArtistReleaseGroups scope ON scope.release_group_mbid = rg.mbid
    WHERE rg.artist_mbid = ? OR scope.artist_mbid = ?
    ORDER BY rg.mbid
  `).all(artistMbid, artistMbid);

  const releaseRows = rgs.length === 0 ? [] : db.prepare(`
    SELECT r.mbid, r.release_group_mbid, r.title, r.disambiguation, r.barcode, r.date,
           r.track_count, r.media_count, rec.isrcs AS recording_isrcs
    FROM AlbumReleases r
    LEFT JOIN Tracks t ON t.release_mbid = r.mbid
    LEFT JOIN Recordings rec ON rec.mbid = t.recording_mbid
    WHERE r.release_group_mbid IN (${rgs.map(() => "?").join(",")})
  `).all(...rgs.map((rg) => rg.mbid));

  const releasesByGroup = new Map();
  for (const row of releaseRows) {
    let entry = releasesByGroup.get(row.mbid);
    if (!entry) {
      entry = {
        releaseGroupMbid: row.release_group_mbid,
        mbid: row.mbid,
        title: row.title,
        disambiguation: row.disambiguation,
        barcode: row.barcode,
        date: row.date,
        trackCount: row.track_count,
        mediaCount: row.media_count,
        isrcs: new Set(),
      };
      releasesByGroup.set(row.mbid, entry);
    }
    for (const isrc of parseJsonArray(row.recording_isrcs)) {
      const normalized = String(isrc || "").trim();
      if (normalized) entry.isrcs.add(normalized);
    }
  }

  const byGroup = new Map();
  for (const release of releasesByGroup.values()) {
    const list = byGroup.get(release.releaseGroupMbid) || [];
    list.push({
      mbid: release.mbid,
      title: release.title,
      disambiguation: release.disambiguation,
      barcode: release.barcode,
      date: release.date,
      trackCount: release.trackCount,
      mediaCount: release.mediaCount,
      isrcs: Array.from(release.isrcs),
    });
    byGroup.set(release.releaseGroupMbid, list);
  }

  return rgs.map((rg) => ({
    mbid: rg.mbid,
    title: rg.title,
    primaryType: rg.primary_type,
    secondaryTypes: parseJsonArray(rg.secondary_types),
    firstReleaseDate: rg.first_release_date,
    disambiguation: rg.disambiguation,
    releases: byGroup.get(rg.mbid) || [],
  }));
}

function captureProviderAlbums(db, artistMbid) {
  const albums = db.prepare(`
    SELECT provider, provider_id, title, version, explicit, quality, type, upc,
           volume_count, release_date, provider_url
    FROM ProviderItems
    WHERE entity_type = 'album' AND artist_mbid = ?
    ORDER BY provider_id
  `).all(artistMbid);

  if (albums.length === 0) return [];

  const trackRows = db.prepare(`
    SELECT provider_album_id, isrc, title, version, duration
    FROM ProviderItems
    WHERE entity_type = 'track' AND provider_album_id IN (${albums.map(() => "?").join(",")})
  `).all(...albums.map((a) => String(a.provider_id)));

  const isrcsByAlbum = new Map();
  const trackCountByAlbum = new Map();
  for (const track of trackRows) {
    const key = String(track.provider_album_id || "");
    if (!key) continue;
    trackCountByAlbum.set(key, (trackCountByAlbum.get(key) || 0) + 1);
    if (track.isrc) {
      const set = isrcsByAlbum.get(key) || new Set();
      set.add(String(track.isrc).trim());
      isrcsByAlbum.set(key, set);
    }
  }

  return albums.map((album) => {
    const id = String(album.provider_id);
    return {
      provider: album.provider || "tidal",
      providerId: id,
      title: album.title || "",
      version: album.version || null,
      providerUrl: album.provider_url || null,
      releaseDate: album.release_date || null,
      type: album.type || null,
      quality: album.quality || null,
      explicit: album.explicit,
      upc: album.upc || null,
      isrcs: Array.from(isrcsByAlbum.get(id) || []),
      trackCount: trackCountByAlbum.get(id) || null,
      volumeCount: album.volume_count ?? null,
    };
  });
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });
  const mode = (() => {
    try {
      return String(db.prepare("SELECT value FROM config WHERE key = 'catalog.source'").get()?.value || "unknown");
    } catch {
      return "unknown";
    }
  })();
  fs.mkdirSync(outDir, { recursive: true });

  for (const artist of ARTISTS) {
    const releaseGroups = captureReleaseGroups(db, artist.mbid);
    const providerAlbums = captureProviderAlbums(db, artist.mbid);
    if (releaseGroups.length === 0 && providerAlbums.length === 0) {
      console.warn(`No data for ${artist.name} (${artist.mbid}) — scan it first; skipping.`);
      continue;
    }
    const fixture = {
      artist: { name: artist.name, mbid: artist.mbid },
      capturedFrom: { catalogSource: mode, dbPath: path.relative(repoRoot, dbPath) },
      releaseGroups,
      providerAlbums,
    };
    const outPath = path.join(outDir, `${artist.slug}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repoRoot, outPath)} — ${releaseGroups.length} release groups, ${providerAlbums.length} provider albums.`);
  }
  db.close();
}

main();
