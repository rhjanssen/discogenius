const Database = require('better-sqlite3');
const db = new Database('../config/discogenius.db');
console.log(db.prepare("SELECT entity_type, title, match_status, artist_mbid, provider_artist_name FROM ProviderItems WHERE entity_type='album' AND provider_artist_name LIKE '%Bakermat%'").all().slice(0, 5));
