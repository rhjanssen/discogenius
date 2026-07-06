const Database = require('better-sqlite3');
const db = new Database('../test-server-data/discogenius.db');
console.log(db.prepare("SELECT title, provider_id, version, match_status, match_method, library_slot, release_group_mbid FROM ProviderItems WHERE entity_type='album' AND artist_mbid='df60a241-e8df-4917-82db-1f1a8ecd7cc3'").all());
