import { fixtureCheck } from './delivery-protocol-fixture.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { WebService } from '../src/web/service.js';
import { createWebServer } from '../src/web/http.js';
import type { RoomSnapshot, WebRoom } from '../src/web/contracts.js';
import { createTeamConfig } from '../team.config.js';
import type { WorkAdapter } from '../src/runner.js';

export async function archiveUntil<T>(read: () => T | Promise<T>, accept: (value: T) => boolean) {
  const end = Date.now() + 4000;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Archive fixture did not reach expected state');
}
export class RoomArchiveFixture {
  readonly directory = mkdtempSync(join(tmpdir(), 'squad-archive-'));
  readonly database = join(this.directory, 'team.sqlite');
  service!: WebService;
  server!: Server;
  url = '';
  first!: WebRoom;
  second!: WebRoom;
  before!: RoomSnapshot;
  calls = 0;
  cancelled = 0;
  private closed = false;
  release: (() => void) | undefined;
  readonly adapter: WorkAdapter = { execute: async (work, signal) => {
    this.calls++;
    if (this.hold && work.kind === 'owner') {
      this.hold = false;
      await new Promise<void>((resolve, reject) => {
        this.release = resolve;
        signal.addEventListener('abort', () => { this.cancelled++; reject(new Error('cancelled')); }, { once: true });
      });
    }
    return work.kind === 'check' ? fixtureCheck(work.payload.candidate)
      : { type: 'deliver', text: '归档测试历史结果', artifactIds: [] };
  } };
  hold = false;
  async start(legacy = false) {
    if (legacy) {
      const db = new DatabaseSync(this.database);
      db.exec("CREATE TABLE web_rooms(id TEXT PRIMARY KEY,title TEXT NOT NULL,createdAt INTEGER NOT NULL); INSERT INTO web_rooms VALUES('legacy','旧群',0);");
      db.close();
    }
    this.service = new WebService(createTeamConfig({}), this.database, this.adapter);
    this.server = createWebServer(this.service);
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.url = 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
  }
  async request<T = unknown>(path: string, data?: unknown, method = data === undefined ? 'GET' : 'POST', origin?: string) {
    const response = await fetch(this.url + path, { method,
      headers: { ...(data !== undefined ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}) },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, data: await response.json() as T };
  }
  route(id = this.first.id) { return '/api/rooms/' + encodeURIComponent(id); }
  async seed() {
    this.first = (await this.request<WebRoom>('/api/rooms', { title: '群一' })).data;
    this.second = (await this.request<WebRoom>('/api/rooms', { title: '群二' })).data;
    for (const room of [this.first, this.second]) {
      assert.equal((await this.request(this.route(room.id) + '/messages', { id: 'history', text: room.title + '历史' })).status, 200);
      await archiveUntil(() => this.service.snapshot(room.id), value => value.tasks.at(-1)?.outcome === 'complete');
    }
    this.first = this.service.snapshot(this.first.id).room; this.second = this.service.snapshot(this.second.id).room;
    this.before = this.service.snapshot(this.first.id);
  }
  async change(archived: boolean, commandId: string, roomId = this.first.id) {
    return this.request<WebRoom>(this.route(roomId) + (archived ? '/archive' : '/restore'), { id: commandId });
  }
  assertHistory() {
    const after = this.service.snapshot(this.first.id);
    assert.deepEqual(after.messages, this.before.messages); assert.deepEqual(after.tasks, this.before.tasks);
    assert.equal(after.activeTaskId, this.before.activeTaskId);
  }
  readStored() {
    const db = new DatabaseSync(this.database, { readOnly: true });
    try {
      return { data: db.prepare('SELECT data FROM rooms WHERE id=?').get(this.first.id)?.data,
        receipts: db.prepare('SELECT id,fingerprint,result FROM receipts WHERE room_id=? ORDER BY id').all(this.first.id) };
    } finally { db.close(); }
  }
  async restart() {
    await new Promise<void>(resolve => this.server.close(() => resolve())); await this.service.close(); await this.start();
  }
  async close() {
    if (this.closed) return; this.closed = true;
    this.release?.();
    if (this.server) await new Promise<void>(resolve => this.server.close(() => resolve()));
    await this.service?.close(); rmSync(this.directory, { recursive: true, force: true });
  }
}
