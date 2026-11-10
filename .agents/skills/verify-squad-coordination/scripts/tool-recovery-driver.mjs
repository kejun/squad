import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { session } = await import(pathToFileURL(join(sourceRoot, 'tests/coordination-composition-fixture.ts')).href);
const identity = work => ({ intentId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion }, attempt: work.attempt });

/** Public Engine transactions only. No model HTTP or Web/CLI I/O is executed. */
export async function createToolRecoveryDriver(root, variant, backend, directory) {
  assert.equal(variant, '', 'ToolRecovery has one fixed finite domain');
  const s = await session(root, backend, directory, config => { config.limits.ordinary = 5; });
  s.submit();
  const initial = s.claim(s.find('owner'));
  const id = initial.id;
  assert(s.send({ type: 'CONSUME', id: `initial:${id}:${initial.attempt}`, ...identity(initial) }).ok);
  let charges = 1, recordings = 0, reopened = false, expired = false, blocked = 0, modelSequence = 0;
  const work = () => s.current(id);
  const webTraces = () => s.context().trace.filter(entry => entry.event === 'CONSUME'
    && entry.detail.startsWith(`request:${id}:`) && entry.detail.includes(':web_fetch:'));
  const failures = () => work().toolRecovery?.failures ?? [];
  const latestWeb = () => webTraces().at(-1)?.detail;
  const phase = () => {
    if (work().status === 'pending') return 3;
    if (work().requestCount === 0) return 4;
    const latest = s.context().trace.filter(entry => entry.event === 'CONSUME').at(-1)?.detail;
    if (latest === latestWeb() && latest !== undefined) return failures().some(item => item.requestId === latest) ? 2 : 1;
    return 0;
  };
  const observe = () => {
    const c = s.context(), records = failures();
    const identitiesValid = new Set(records.map(item => item.requestId)).size === records.length
      && records.every(item => item.tool === 'web_fetch' && item.code === 'WEB_TOOL_UNSUPPORTED_RESOURCE'
        && item.requestId.startsWith(`request:${id}:${item.attempt}:web_fetch:`)
        && c.trace.some(entry => entry.event === 'CONSUME' && entry.detail === item.requestId));
    return { phase: phase(), used: c.usage.ordinary, charges, requests: work().requestCount,
      webCalls: webTraces().length, feedbacks: records.length, recordings, attempt: work().attempt,
      reopened, stopped: c.stopped, expired, blocked, identitiesValid };
  };
  const properties = () => {
    const state = observe();
    assert(state.feedbacks <= 2 && state.feedbacks === state.recordings,
      'BoundedToolRecovery: feedback count exceeded the fixed bound or differed from accepted recording transactions');
    assert(state.used === state.charges && state.used <= 5,
      'ToolRecoveryAccounting: feedback refunded/charged a request or a follow-up escaped the paid limit');
    assert(state.identitiesValid && state.feedbacks <= state.webCalls,
      'ToolFailureIdentity: failure did not bind one unique consumed request and attempt');
    assert(!(state.stopped || state.expired) || state.feedbacks === state.blocked,
      'StoppedToolRecovery: stopped or expired work accepted new feedback');
    assert.equal(s.context().usage.retries, 0, 'ToolRecoveryAccounting: alternative feedback must not reset/spend technical retries');
  };
  const failure = (changes = {}) => ({ type: 'RECORD_TOOL_FAILURE', ...identity(work()),
    requestId: latestWeb(), tool: 'web_fetch', code: 'WEB_TOOL_UNSUPPORTED_RESOURCE', ...changes });
  const deny = (body, property) => {
    const before = observe();
    const response = s.send(body);
    assert.equal(response.ok, false, `${property}: invalid feedback/request must be rejected`);
    assert.deepEqual(observe(), before, `${property}: a rejected event changed the paid or recovery state`);
  };
  const apply = action => {
    switch (action) {
      case 'WebCall': {
        const current = work(), requestId = `request:${id}:${current.attempt}:web_fetch:${webTraces().length + 1}`;
        assert(s.send({ type: 'CONSUME', id: requestId, capability: 'web_fetch', ...identity(current) }).ok);
        charges++; break;
      }
      case 'RecordFailure': assert(s.send(failure()).ok); recordings++; break;
      case 'ModelRequest':
        assert(s.send({ type: 'CONSUME', id: `model:${id}:${++modelSequence}`, ...identity(work()) }).ok);
        charges++; break;
      case 'Recover': s.recover(); reopened = true; break;
      case 'Reclaim': s.claim(work()); charges++; break;
      case 'ResumeInitial':
        assert(s.send({ type: 'CONSUME', id: `initial:${id}:${work().attempt}`, ...identity(work()) }).ok); break;
      case 'Stop': assert(s.send({ type: 'STOP' }).ok); blocked = failures().length; break;
      case 'Expire': s.setNow(work().deadline); expired = true; blocked = failures().length; break;
      case 'DeniedFailure': deny(failure(), failures().length >= 2 ? 'BoundedToolRecovery' : 'ToolRecoveryAccounting'); break;
      case 'DeniedWeb':
        deny({ type: 'CONSUME', id: `request:${id}:${work().attempt}:web_fetch:${webTraces().length + 1}`,
          capability: 'web_fetch', ...identity(work()) }, 'ToolRecoveryAccounting'); break;
      case 'DuplicateFailure': {
        const original = failures()[0];
        deny(failure({ requestId: original.requestId, attempt: original.attempt }), 'ToolFailureIdentity'); break;
      }
      case 'StaleAttempt': deny(failure({ attempt: work().attempt + 1 }), 'ToolFailureIdentity'); break;
      case 'StaleFence': deny(failure({ fence: { epoch: work().epoch + 1, goalVersion: work().goalVersion } }), 'ToolFailureIdentity'); break;
      case 'UnknownRequest': deny(failure({ requestId: `request:${id}:${work().attempt}:web_fetch:999` }), 'ToolFailureIdentity'); break;
      case 'MismatchedTool': deny(failure({ tool: 'web_search' }), 'ToolFailureIdentity'); break;
      case 'LateFailure': deny(failure(), 'StoppedToolRecovery'); break;
      default: throw new Error(`Unknown ToolRecovery action ${action}`);
    }
    properties();
    return observe();
  };
  return { observe, apply, properties, close: s.close };
}
