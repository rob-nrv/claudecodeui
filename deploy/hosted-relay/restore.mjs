#!/usr/bin/env node
// Restore the relay database from a backup made by backup.mjs.
// STOP THE SERVICE FIRST (systemctl stop cloudcli-relay). Run from the install directory:
//   DATABASE_PATH=/var/lib/cloudcli-relay/relay.db node deploy/hosted-relay/restore.mjs /var/backups/cloudcli-relay/relay-<stamp>.db
// The current database is kept next to it as relay.db.before-restore-<time>; nothing is deleted.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');

const backup = process.argv[2];
const destination = process.env.DATABASE_PATH;
if (!backup || !destination || !fs.existsSync(backup)) {
  console.error('usage: DATABASE_PATH=<relay.db> node restore.mjs <backup.db>');
  process.exit(2);
}
const check = new Database(backup, { readonly: true });
const integrity = check.pragma('integrity_check', { simple: true });
check.close();
if (integrity !== 'ok') {
  console.error(`refusing to restore: backup integrity_check = ${integrity}`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
for (const suffix of ['', '-wal', '-shm']) {
  const file = destination + suffix;
  if (fs.existsSync(file)) fs.renameSync(file, `${destination}.before-restore-${stamp}${suffix}`);
}
fs.copyFileSync(backup, destination);
fs.chmodSync(destination, 0o600);
console.log(`restored ${backup} -> ${destination} (previous database kept as .before-restore-${stamp}). Now make sure the service user owns the file, then start the service.`);
