const Database = require('better-sqlite3');
const db = new Database('../config/discogenius.db');
console.log(db.prepare("SELECT entity_type, title, match_status, release_group_mbid FROM ProviderItems WHERE artist_mbid='df60a241-e8df-4917-82db-1f1a8ecd7cc3'").all());
