const Database = require('better-sqlite3');
const db = new Database('../config/discogenius.db');
console.log(db.prepare("PRAGMA table_info(ProviderItems)").all());
