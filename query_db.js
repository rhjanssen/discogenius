const db = require('better-sqlite3')('data/discogenius.sqlite');
console.log(db.prepare("SELECT mbid, title, release_date FROM Albums WHERE mbid = '6bb5b3df-c963-49ef-b1e1-2c8ad370eb98'").get());
