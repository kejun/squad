import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { initialTransition, transition } from 'xstate';
import { MemoryStore, TeamEngine } from '../src/index.js';
import { inspectorMachine, inspectorOrigin, inspectorWindowMachine } from '../src/inspector.machine.js';
import { createTeamConfig } from '../team.config.js';

/** Reuse actual task transactions and observation models before touching browser wiring. */
export function verifyWebCompositionModels() {
  const engine = new TeamEngine(new MemoryStore(), createTeamConfig({}), () => 1);
  const first = { id: 'composition-message', text: '形成可检查方案' };
  const receipt = engine.submit('composition-A', first);
  assert(receipt.ok);
  const other = engine.submit('composition-B', { id: 'other-message', text: '另一群的独立方案' });
  assert(other.ok);
  assert.deepEqual(engine.submit('composition-A', first), { ...receipt, duplicate: true });
  assert(!engine.submit('composition-A', { ...first, text: '不同载荷' }).ok);
  assert.equal(engine.view('composition-A', receipt.taskId)?.context.messages.filter(message => message.kind === 'user').length, 1);
  assert.equal(engine.view('composition-B', other.taskId)?.context.messages.filter(message => message.kind === 'user').length, 1);

  let [window] = initialTransition(inspectorWindowMachine);
  const windowPath: string[] = [String(window.value)];
  for (const type of ['OPEN', 'OPENED', 'WINDOW_CLOSED', 'OPEN', 'OPENED', 'DISPOSE'] as const) {
    [window] = transition(inspectorWindowMachine, window, { type });
    windowPath.push(String(window.value));
  }
  assert.deepEqual(windowPath, ['closed', 'opening', 'open', 'closed', 'opening', 'open', 'disposed']);
  const frame = { snapshot: { marker: 'first' }, event: undefined };
  let [observer] = initialTransition(inspectorMachine, frame);
  [observer] = transition(inspectorMachine, observer, { type: 'CONNECT', origin: inspectorOrigin, fromTarget: false });
  assert.equal(observer.value, 'waiting');
  [observer] = transition(inspectorMachine, observer, { type: 'SELECT', frame: { ...frame, snapshot: { marker: 'latest' } } });
  [observer] = transition(inspectorMachine, observer, { type: 'CONNECT', origin: inspectorOrigin, fromTarget: true });
  assert.equal(observer.value, 'connected');
  assert.equal(observer.context.delivery?.kind, 'register');
  assert.deepEqual(observer.context.delivery?.frame.snapshot, { marker: 'latest' });
  [observer] = transition(inspectorMachine, observer, { type: 'CLOSE' });
  assert.equal(observer.status, 'done');
  assert.equal(observer.context.delivery?.kind, 'disconnect');
  return { task: 'two rooms; duplicate receipt; conflicting payload rejected', windowPath, observer: 'trusted register latest then disconnect' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verifyWebCompositionModels()));
