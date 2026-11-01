#!/usr/bin/env node
// Turns a decrypted backup (see the private bello-ai-backups repo) into SQL for D1:
//   node scripts/restore-backup.mjs backup.json > restore.sql
//   npx wrangler d1 execute bello-ai --remote --file restore.sql
// Rows are INSERT OR REPLACE, so it is safe to run over a database that already has the tables.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/restore-backup.mjs backup.json > restore.sql');
  process.exit(1);
}
const backup = JSON.parse(readFileSync(file, 'utf8'));

const literal = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};

const out = ['PRAGMA defer_foreign_keys = true;'];
for (const sql of backup.schema) {
  out.push(`${sql.replace(/^CREATE (TABLE|INDEX|UNIQUE INDEX) /, 'CREATE $1 IF NOT EXISTS ')};`);
}
for (const [table, rows] of Object.entries(backup.tables)) {
  for (const row of rows) {
    const cols = Object.keys(row);
    out.push(`INSERT OR REPLACE INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => literal(row[c])).join(', ')});`);
  }
  console.error(`${table}: ${rows.length}`);
}
process.stdout.write(`${out.join('\n')}\n`);
