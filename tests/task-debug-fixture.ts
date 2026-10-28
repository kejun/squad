import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebService } from '../src/web/service.js';
import { createWebServer } from '../src/web/http.js';
import { debugEventTemplate, debugInput, TaskSandbox } from '../src/task-debug.js';

export async function debugHost(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'squad-debug-'));
  let externalCalls = 0;
  const service = new WebService(debugInput().config, join(directory, 'team.sqlite'), {
    execute: async () => { externalCalls++; return { type: 'askUser', question: '受控调试夹具' }; },
  }, undefined, enabled);
  const server = createWebServer(service);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const room = service.createRoom('调试验收');
  const started = service.engine.submit(room.id, { id: 'debug-real', text: '形成可检查的方案' });
  const taskId = started.taskId!;
  const route = '/api/debug/rooms/' + encodeURIComponent(room.id);
  let closed = false;
  return {
    service, server, url, room, taskId, route,
    get externalCalls() { return externalCalls; },
    async close() {
      if (closed) return; closed = true;
      await new Promise<void>(resolve => server.close(() => resolve()));
      await service.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export function sandboxBoundary(sandbox: TaskSandbox, scenario: string): string {
  let event = debugEventTemplate(sandbox.snapshot, 'HELP');
  if (scenario === '向自己求助') event.target = sandbox.snapshot.context.owner;
  else if (scenario === '旧轮次结果') event = { type: 'HELP_RESULT', requestId: 'old-help', resultId: 'old-result', status: 'success', answer: '旧结论', fence: { epoch: 99, goalVersion: 99 } };
  else if (scenario === '额度耗尽') {
    const input = debugInput(); input.config.limits.ordinary = 0;
    const limited = TaskSandbox.fromInput(JSON.stringify(input));
    limited.send(JSON.stringify(debugEventTemplate(limited.snapshot, 'CLAIM')));
    return limited.snapshot.context.reply.code;
  } else if (scenario === '停止后继续') {
    sandbox.send('{"type":"STOP"}');
    return String(sandbox.send('{"type":"CONTINUE"}').value);
  } else throw new Error('Unknown boundary: ' + scenario);
  return sandbox.send(JSON.stringify(event)).context.reply.code;
}

