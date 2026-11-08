import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Run from the checkout under test. Only the BDD fixture drives production APIs.
const mode = process.env.CONTROL_MODE ?? 'fixed-source';
assert(['old-source', 'fixed-source'].includes(mode));
const { DiscussionRecoveryFixture } = await import(pathToFileURL(`${process.cwd()}/tests/discussion-recovery-fixture.ts`).href);
const fixture = new DiscussionRecoveryFixture();
let caught;
try {
  await fixture.prepare(); fixture.cancel(); await fixture.recoverAndInvite();
  fixture.assertMembersReturned(); fixture.assertLateResultsRejected();
} catch (error) { caught = error; }
const context = fixture.context();
const result = {
  mode,
  failure: caught ? { code: caught.code, message: caught.message, actual: caught.actual, expected: caught.expected } : null,
  round: { id: context.discussion?.id, status: context.discussion?.status, targets: context.discussion?.targets, skipped: context.discussion?.skipped },
  obsolete: fixture.works.map(old => {
    const work = context.intents.find(item => item.id === old.id);
    return { target: work.target, status: work.status, attempt: work.attempt };
  }),
};
fixture.close();
console.log(JSON.stringify(result, null, 2));
if (mode === 'old-source') {
  assert.equal(caught?.code, 'ERR_ASSERTION');
  assert.deepEqual(result.round.targets, []);
  assert.equal(result.round.skipped.length, 2);
  assert(result.round.skipped.every(member => member.reason === '正在工作'));
  assert(result.obsolete.every(work => work.status === 'pending'));
} else assert.ifError(caught);
