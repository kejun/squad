#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export async function inspectInstance(instance) {
  const { pid, url, database, root } = instance;
  assert(Number.isInteger(pid) && pid > 0, 'Expected owned application PID');
  assert.equal(new URL(url).hostname, '127.0.0.1');
  process.kill(pid, 0);
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), readFileSync(join(root, 'dist/web/index.html'), 'utf8'), 'Wrong web build');
  const listing = await fetch(url + '/api/rooms', { signal: AbortSignal.timeout(2000) });
  assert.equal(listing.status, 200);
  const { rooms } = await listing.json();
  assert(Array.isArray(rooms));
  const db = new DatabaseSync(database, { readOnly: true });
  try { assert.equal(Number(db.prepare('SELECT count(*) AS n FROM web_rooms').get().n), rooms.length); }
  finally { db.close(); }
  return { pid, url, database, roomCount: rooms.length, htmlMatchesBuild: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, 'Usage: doctor.mjs /absolute/evidence/instance.json (while that run is active)');
  console.log(JSON.stringify(await inspectInstance(JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
}
