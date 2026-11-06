import assert from 'node:assert/strict';
import { deliveryEvidence } from '../src/task/evidence.js';
import { skillResourceModel } from './skill-resource-evidence-fixture.js';

export async function* givesTheCheckTheActualCompleteResourceAndItsProvenance() {
const { model, check } = skillResourceModel();
yield 'prepared';
const evidence = deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence)!;
yield 'observed';
assert.equal((evidence.sources).length, 1);
assert.partialDeepStrictEqual(evidence.sources[0], { stdout: '{"total":62500}', metadata: {
      status: 'succeeded', completeness: 'complete', sourceMember: 'A', resourceId: 'local:source:references/orders.json', resourceVersion: 'version1',
      capturedContentHash: 'a'.repeat(64), stdoutBytes: 15,
    } });
}

export async function* keepsPagedResourceIncomplete() {
const row = "paged";
const mode = row;
const { model, check } = skillResourceModel(mode);
yield 'prepared';
const evidence = deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence)!;
yield 'observed';
assert.equal((evidence.sources).length, 1);
assert.notEqual(evidence.sources[0]?.metadata.completeness, 'complete');
assert.equal(evidence.sources[0]?.stdout, undefined);
assert.equal(evidence.sources[0]?.metadata.capturedContentHash, null);
}

export async function* keepsFailedResourceIncomplete() {
const row = "failed";
const mode = row;
const { model, check } = skillResourceModel(mode);
yield 'prepared';
const evidence = deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence)!;
yield 'observed';
assert.equal((evidence.sources).length, 1);
assert.notEqual(evidence.sources[0]?.metadata.completeness, 'complete');
assert.equal(evidence.sources[0]?.stdout, undefined);
assert.equal(evidence.sources[0]?.metadata.capturedContentHash, null);
}

export async function* rejectsChangedContentAfterTheCandidateFixedItsEvidence() {
const { model, check } = skillResourceModel();
yield 'prepared';
model.c.intents[0]!.localOperations![0]!.result!.data.content = '{"total":62501}';
const observation0 = deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence);
yield 'observed';
assert.equal(observation0, undefined);
}

export async function* excludesReadingFromAnOlderGoal() {
const { model, check } = skillResourceModel();
yield 'prepared';
model.c.intents[0]!.goalVersion = 0;
const observation0 = deliveryEvidence(model.c, check);
yield 'observed';
assert.deepEqual(observation0?.sources, []);
}

export async function* rejectsALegacyResourceReferenceWithoutItsFrozenReceiptSnapshot() {
const { model, check } = skillResourceModel();
yield 'prepared';
const reference = model.c.deliveryCycle?.evidence?.[0];
assert(reference);
const legacy = { id: reference.id, stdoutHash: reference.stdoutHash, stderrHash: reference.stderrHash };
const observation0 = deliveryEvidence(model.c, check, [legacy]);
yield 'observed';
assert.equal(observation0, undefined);
}

export async function* rejectsChangedFrozenHash() {
const row = ["hash","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
const [field, value] = row;
const { model, check } = skillResourceModel();
yield 'prepared';
model.c.intents[0]!.localOperations![0]!.result!.data[field as string] = value;
const observation0 = deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence);
yield 'observed';
assert.equal(observation0, undefined);
}

export async function* rejectsChangedFrozenSkillVersion() {
const row = ["skillVersion","version2"];
const [field, value] = row;
const { model, check } = skillResourceModel();
yield 'prepared';
model.c.intents[0]!.localOperations![0]!.result!.data[field as string] = value;
const observation0 = deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence);
yield 'observed';
assert.equal(observation0, undefined);
}

export async function* rejectsChangedFrozenNextOffset() {
const row = ["nextOffset",15];
const [field, value] = row;
const { model, check } = skillResourceModel();
yield 'prepared';
model.c.intents[0]!.localOperations![0]!.result!.data[field as string] = value;
const observation0 = deliveryEvidence(model.c, check, model.c.deliveryCycle!.evidence);
yield 'observed';
assert.equal(observation0, undefined);
}
