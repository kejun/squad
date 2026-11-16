import assert from 'node:assert/strict';
import { LocalModel } from './local-model-fixture.js';
import { reclaimsARecoveredInProgressReadUnderTheSameIdentityWithoutChargingAgain } from './task-evidence-model-contract-fixture.js';

const catalog = 'CATALOG-BODY-MARKER';

/** Directory receipts are stored as operation ids. Command receipts stay on the operation and in the checkpoint. */
export function directoryCheckpointOmitsCatalogBody() {
  const m = new LocalModel();
  const before = m.c.usage.ordinary;
  assert(m.request({ type: 'discoverHost', query: 'ocr' }).ok);
  assert(m.claim().ok);
  assert.equal(m.c.usage.ordinary, before, 'Directory discovery remains free');
  assert(m.result({ result: { ok: true, code: 'discoverHost', data: { catalog } } }).ok);
  const settled = JSON.stringify(m.c.intents[0]!.localCheckpoint?.messages);
  assert(!settled.includes(catalog), 'Settled directory checkpoint must not keep the catalog body');
  assert(settled.includes('persistedMetadataOperationId'));
  assert.equal(m.c.intents[0]!.localOperations?.[0]?.result?.data.catalog, catalog, 'The operation receipt keeps the catalog');
  const work = m.c.intents[0]!;
  const full = { type: 'local_tool_result', operationId: 'op1', untrusted: true, ok: true, code: 'discoverHost', data: { catalog } };
  assert(m.send({ type: 'LOCAL_REQUEST', intentId: work.id, operationId: 'op2', namespace: 'c'.repeat(64), requestHash: 'b'.repeat(64),
    action: { type: 'runCli', executable: 'node', args: ['next.js'] }, parentAttempt: work.attempt,
    messages: [{ role: 'user', content: JSON.stringify(full) }, { role: 'assistant', content: '{"type":"runCli","executable":"node"}' }],
    workspaceId: 'project', fence: work }).ok);
  const stored = JSON.stringify(m.c.intents[0]!.localCheckpoint?.messages);
  assert(!stored.includes(catalog), 'A later checkpoint save must replace a full directory message with the operation id');
  assert(stored.includes('persistedMetadataOperationId'));
  assert(stored.includes('runCli'));
  return { catalogInCheckpoint: false, receiptKept: true };
}

export function commandCheckpointKeepsBoundedBody() {
  const m = new LocalModel();
  assert(m.request().ok);
  assert(m.claim().ok);
  assert(m.started().ok);
  assert(m.result({ result: { ok: true, code: 'succeeded', data: { stdout: 'KEEP-STDOUT-BODY', truncated: false } } }).ok);
  const stored = JSON.stringify(m.c.intents[0]!.localCheckpoint?.messages);
  assert(stored.includes('KEEP-STDOUT-BODY'));
  assert.equal(m.c.intents[0]!.localOperations?.[0]?.result?.data.stdout, 'KEEP-STDOUT-BODY');
  return { checkpointBody: true };
}

export async function receiptProjectionModelGate() {
  const directory = directoryCheckpointOmitsCatalogBody();
  const command = commandCheckpointKeepsBoundedBody();
  for await (const step of reclaimsARecoveredInProgressReadUnderTheSameIdentityWithoutChargingAgain()) {
    assert(step === 'prepared' || step === 'observed');
  }
  return { directory, command, readReclaim: 'uncharged' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await receiptProjectionModelGate();
  console.log(JSON.stringify(result));
}
