const db = require('better-sqlite3')('config/discogenius.db');
const videos = db.prepare("SELECT id, title FROM ProviderMedia WHERE type = 'Music Video' OR type = 'video' LIMIT 5").all();
console.log(videos);
