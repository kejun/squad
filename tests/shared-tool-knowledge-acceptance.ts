import assert from 'node:assert/strict';
import { LocalFixture } from './local-tools-fixture.js';

export async function sharedToolKnowledgeAcceptance() {
  const readerScript = 'console.log("独立资料正文：" + process.argv[1])';
  const fixture = await LocalFixture.create('方案师', true, false, { runtimeOptions: {
    acquisitionReaders: [{ id: 'shared-reader', version: '1', command: 'node', argsPrefix: ['-e', readerScript],
      format: 'text', resource: { kind: 'url-argument', index: 2 } }],
    cliCatalog: [{ command: 'node', description: 'Configured document reader', domains: ['example.com'], execution: 'sandbox' }],
  } });
  try {
    fixture.runtime.options.redact = ['host-model-secret', 'private-source-key'];
    fixture.replies.push(
      { type: 'discoverHost', commands: ['node'] },
      { type: 'runCli', executable: 'node', args: ['-e', readerScript, 'https://example.com/first?key=private-source-key'] },
      { type: 'help', requestId: 'second-source', target: 'B', question: '读取https://example.com/second 的独立资料', expected: '独立读取结果' },
    );
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const owner = fixture.h.context().intents.find(work => work.kind === 'owner')!;
    const original = owner.localOperations!.find(operation => operation.action.type === 'runCli')!;
    assert.equal(original.status, 'succeeded');
    const member = fixture.h.engine.pending(fixture.h.room, fixture.h.task).find(work => work.kind === 'assistance')!;
    assert(member, 'Owner must hand off the independent second source');
    fixture.replies.push(
      { type: 'runCli', executable: 'node', args: ['-e', readerScript, 'https://example.com/second'] },
      { type: 'answer', text: '独立资料已读取', status: 'success' },
    );
    await fixture.runner().runOne(fixture.h.room, fixture.h.task, member.id);
    const memberRequest = fixture.requests.find(request => request.messages[0]!.content.includes('executing assistance work'))!;
    const knowledge = memberRequest.messages.find(message => message.content.includes('"type":"shared_tool_knowledge"'));
    assert(knowledge, 'Member must see the first member\'s successful method before its first request');
    const data = JSON.parse(knowledge.content) as { methods: { sourceOperationId: string; action: { args: string[] }; validation?: { status: string } }[] };
    data.methods = data.methods.filter(method => method.validation?.status === 'acquired');
    assert.equal(data.methods.length, 1);
    assert.equal(data.methods[0]!.sourceOperationId, original.id);
    assert.equal(data.methods[0]!.action.args.at(-1), 'https://example.com/first?key=[redacted]');
    assert(!knowledge.content.includes('private-source-key'));
    assert(!knowledge.content.includes('stdout'));
    assert.equal(fixture.backend.calls.length, 2);
    const completed = fixture.h.context().intents.find(work => work.id === member.id)!;
    assert.equal(completed.localOperations?.length, 1);
    assert.equal(completed.localOperations[0]!.result?.data.stdout, '独立资料正文：https://example.com/second\n');
    assert.notEqual(completed.localOperations[0]!.id, original.id);
    return { methods: data.methods, original, operation: completed.localOperations[0]!, knowledge: knowledge.content,
      executions: fixture.backend.calls.length };
  } finally { await fixture.close(); }
}
