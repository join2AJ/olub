'use strict';
// Consistent online backup of the Olub database (business continuity, ISO 22301).
// Usage: npm run backup   → writes backups/olub-<timestamp>.db
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const src = process.env.OLUB_DB || path.join(__dirname, '..', 'data', 'olub-v2.db');
const dir = process.env.OLUB_BACKUP_DIR || path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `olub-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(src);
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log(`Backup written: ${out}`);
