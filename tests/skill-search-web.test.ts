import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createTeamConfig } from '../team.config.js';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WebService } from '../src/web/service.js';
import { createWebServer } from '../src/web/http.js';
import type { RoomSnapshot, WebRoom } from '../src/web/contracts.js';
import { mixedSourceSkills } from './skill-search-fixture.js';

describe('skill search execution logs through HTTP and SQLite', () => {
  it('[BT_M21] records mixed-source results and completes the task without search errors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'squad-skill-search-'));
    const config = createTeamConfig({});
    config.inputAnalysis = { enabled: false };
    config.models = { default: 'test', services: { test: { baseUrl: 'https://model.invalid/v1', model: 'test' } } };
    const outputs = [
      { type: 'findSkills', query: 'general purpose assistant skills' },
      { type: 'deliver', text: '已根据技能资料形成建议', artifactIds: [] },
      { type: 'check', passed: true, gaps: [] },
    ];
    let requests = 0; let searches = 0;
    const adapter = new OpenAICompatibleAdapter(config, { env: {}, transport: async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(outputs[requests++]) }, finish_reason: 'stop' }] }) });
    const service = new WebService(config, join(directory, 'team.sqlite'), adapter);
    const server = createWebServer(service);
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (async (input, init) => {
      if (String(input).startsWith('https://skills.sh/api/search?')) {
        searches++;
        return Response.json({ skills: mixedSourceSkills });
      }
      return realFetch(input, init);
    }) satisfies typeof fetch);
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = (path: string, body: unknown) => fetch(base + path,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const roomResponse = await post('/api/rooms', { title: '技能搜索验收' });
      expect(roomResponse.status).toBe(201);
      const room = await roomResponse.json() as WebRoom;
      const submitted = await post(`/api/rooms/${room.id}/messages`, { id: 'search', text: '搜索通用助手技能并给出建议' });
      expect(submitted.status).toBe(200);
      let snapshot: RoomSnapshot | undefined;
      for (let n = 0; n < 100; n++) {
        snapshot = await (await fetch(`${base}/api/rooms/${room.id}`)).json() as RoomSnapshot;
        if (snapshot.tasks[0]?.outcome === 'complete') break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(snapshot?.tasks[0]?.outcome).toBe('complete');
      expect(snapshot?.events.filter(event => event.kind === 'error')).toEqual([]);
      const result = snapshot?.events.find(event => event.title === '技能搜索完成');
      expect(result?.kind).toBe('tool-result');
      expect(JSON.parse(result!.detail).map((skill: { source: string }) => skill.source))
        .toEqual(['aliyun/alibabacloud-aiops-skills', 'skills.volces.com']);
      expect(snapshot?.tasks[0]?.usage).toEqual({ ordinary: 3, checks: 1 });
      expect(searches).toBe(1); expect(requests).toBe(3);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await service.close();
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
