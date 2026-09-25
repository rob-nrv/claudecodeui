#!/usr/bin/env node
// Consistent online backup of the relay SQLite database (WAL-safe, uses SQLite's
// own backup API through the relay's better-sqlite3, so no sqlite3 CLI is needed).
// Run from the install directory:  node deploy/hosted-relay/backup.mjs
// Env: DATABASE_PATH (required), BACKUP_DIR (default /var/backups/cloudcli-relay), BACKUP_KEEP_DAYS (default 14).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const Database = require('better-sqlite3');

const source = process.env.DATABASE_PATH;
if (!source || !fs.existsSync(source)) {
  console.error('DATABASE_PATH must point to the relay database.');
  process.exit(1);
}
const dir = process.env.BACKUP_DIR || '/var/backups/cloudcli-relay';
const keepMs = Number(process.env.BACKUP_KEEP_DAYS || 14) * 86_400_000;
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const target = path.join(dir, `relay-${stamp}.db`);

const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  await db.backup(target);
} finally {
  db.close();
}
fs.chmodSync(target, 0o600);

const copy = new Database(target, { readonly: true });
const integrity = copy.pragma('integrity_check', { simple: true });
const users = copy.prepare('SELECT COUNT(*) AS n FROM users').get().n;
copy.close();
if (integrity !== 'ok') {
  fs.rmSync(target, { force: true });
  console.error(`backup failed integrity_check: ${integrity}`);
  process.exit(1);
}

for (const name of fs.readdirSync(dir)) {
  const file = path.join(dir, name);
  if (/^relay-.*\.db$/.test(name) && Date.now() - fs.statSync(file).mtimeMs > keepMs) fs.rmSync(file);
}
console.log(`backup ok: ${target} (integrity ok, ${users} user(s))`);
