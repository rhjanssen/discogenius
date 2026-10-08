import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { prepareActiveSchemaEnv, openActiveSchemaDb, closeActiveSchemaDb } from '../../test-support/active-schema-fixture.js';
import { LEGACY_FOLDER_SCAN_MEMBER_ARTIST_SCOPE_SQL as members, LEGACY_FOLDER_SCAN_RELEASE_ARTIST_SCOPE_SQL as releases } from './provider-item-artist-scope.js';

const { tempDir } = prepareActiveSchemaEnv('folder-provider-scope');
const { db, dbModule } = await openActiveSchemaDb();
after(() => closeActiveSchemaDb(dbModule, tempDir));

test('folder scope preserves direct credits, parent credits and canonical ownership without provider-ID collisions', () => {
  const artistId = Number(db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES ('scope-artist','Artist')").run().lastInsertRowid);
  const otherId = Number(db.prepare("INSERT INTO ArtistMetadata(mbid,name) VALUES ('scope-other','Other')").run().lastInsertRowid);
  db.prepare("INSERT INTO Albums(mbid,artist_mbid,title) VALUES ('scope-album','scope-artist','Album')").run();
  const editionId = Number(db.prepare("INSERT INTO AlbumEditions(mbid,release_group_mbid,artist_mbid,title) VALUES ('scope-edition','scope-album','scope-artist','Edition')").run().lastInsertRowid);
  const item = (provider: string, type: string, id: string) => Number(db.prepare('INSERT INTO ProviderItems(provider,entity_type,provider_id,title) VALUES (?,?,?,?)').run(provider,type,id,id).lastInsertRowid);
  const artist = item('tidal','artist','artist');
  const candidateArtist = item('tidal','artist','candidate');
  const wrongArtist = item('deezer','artist','artist');
  const matchArtist = db.prepare("INSERT INTO ProviderArtistMatches(provider_artist_item_id,artist_id,match_state,decision_source,confidence,method,matcher_version) VALUES (?, ?, ?, 'automatic',1,'fixture',1)");
  matchArtist.run(artist,artistId,'accepted');
  matchArtist.run(candidateArtist,artistId,'candidate');
  matchArtist.run(wrongArtist,otherId,'accepted');
  const direct = item('tidal','track','shared');
  const collision = item('deezer','track','shared');
  const parent = item('tidal','release','parent');
  const child = item('tidal','track','child');
  const canonicalParent = item('tidal','release','canonical');
  const canonicalChild = item('tidal','video','canonical-child');
  const rejectedParent = item('tidal','release','rejected');
  const rejectedChild = item('tidal','track','rejected-child');
  const candidate = item('tidal','track','candidate-track');
  const credit = db.prepare("INSERT INTO ProviderItemCredits(item_id,artist_item_id,ordinal,credited_name) VALUES (?,?,0,'Artist')");
  credit.run(direct,artist); credit.run(parent,artist); credit.run(collision,wrongArtist); credit.run(candidate,candidateArtist);
  const membership = db.prepare('INSERT INTO ProviderEditionMembers(provider_edition_item_id,member_item_id,position) VALUES (?,?,1)');
  membership.run(parent,child); membership.run(canonicalParent,canonicalChild); membership.run(rejectedParent,rejectedChild);
  const editionMatch = db.prepare("INSERT INTO ProviderEditionMatches(provider_edition_item_id,edition_id,relation,match_state,decision_source,confidence,method,matcher_version) VALUES (?, ?, 'exact', ?, 'automatic',1,'fixture',1)");
  editionMatch.run(canonicalParent,editionId,'accepted'); editionMatch.run(rejectedParent,editionId,'rejected');
  const ids = (scope: string, type: string) => (db.prepare(`SELECT pi.id FROM ProviderItems pi WHERE ${type} AND ${scope} ORDER BY pi.id`).all({artistId}) as {id:number}[]).map(row => row.id);
  assert.deepEqual(ids(members,"pi.entity_type IN ('track','video')"),[direct,child,canonicalChild]);
  assert.deepEqual(ids(releases,"pi.entity_type='release'"),[parent,canonicalParent]);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
});

test('folder scope builds artist-indexed sets instead of correlated work for every provider item', () => {
  for (const scope of [members,releases]) {
    const details = (db.prepare(`EXPLAIN QUERY PLAN SELECT pi.id FROM ProviderItems pi WHERE ${scope}`).all({artistId:1}) as {detail:string}[]).map(row => row.detail);
    assert.equal(details.some(detail => detail.includes('CORRELATED')),false);
    assert.equal(details.some(detail => detail.includes('idx_provider_artist_matches_artist')),true);
  }
});
