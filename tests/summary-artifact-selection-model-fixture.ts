import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { LocalModel } from './local-model-fixture.js';
import type { ArtifactSource } from '../src/types.js';

const oldArtifact = { taskId: 'previous-month', id: 'previous-month:artifacts:report', name: '上月月报.md', content: '# 上月月报', goalVersion: 1 };
const fixedSource: ArtifactSource = { sourceTaskId: oldArtifact.taskId, artifactId: oldArtifact.id, documentId: 'monthly-document', revision: 1,
  name: oldArtifact.name, content: oldArtifact.content, owner: 'A', publishedAt: 0, contentHash: 'a'.repeat(64) };
const currentId = 'this-month:artifact:report';
const deliveredText = '当前任务的文字结果。';

export const referenceVariants = {
  '背景里的跨任务旧文件': { artifactIds: [currentId], backgroundArtifactIds: [oldArtifact.id] },
  '交付里的跨任务旧文件': { artifactIds: [currentId, oldArtifact.id] },
  '两处都列了固定来源': { artifactIds: [currentId, oldArtifact.id], backgroundArtifactIds: [oldArtifact.id] },
  '交付与背景重复列出本轮成果': { artifactIds: [currentId, currentId], backgroundArtifactIds: [currentId] },
  '不存在的文件': { artifactIds: [currentId, 'unknown-id'], backgroundArtifactIds: ['another-unknown-id'] },
};

export class SummaryArtifactSelectionCase {
  readonly model: LocalModel;
  previousId?: string;

  constructor(fixed = false) {
    this.model = new LocalModel(input => {
      input.config.deliveryReport = 'summary';
      input.goal.requiredArtifacts = 1;
      input.history = { messages: [], artifacts: [oldArtifact], board: [], truncated: false };
      if (fixed) input.sourceArtifact = fixedSource;
    });
  }

  prepareCurrentArtifact() {
    assert(this.model.send({ type: 'ARTIFACT', artifact: { id: currentId, name: '本月摘要.md', content: '# 本月摘要' } }).ok);
  }

  private deliver(fields: Record<string, unknown>) {
    const { model } = this;
    const reply = model.send({ type: 'DELIVER', workId: model.work.id, fence: model.work, attempt: model.work.attempt,
      text: deliveredText, artifactIds: [], ...fields });
    assert.equal(reply.code, 'OK');
  }

  submitReferences(variant: keyof typeof referenceVariants) {
    this.deliver(referenceVariants[variant]);
  }

  submitOldAttachmentOnly() {
    this.deliver({ artifactIds: [oldArtifact.id] });
  }

  assertCurrentOutput() {
    const { c } = this.model;
    assert.equal(c.outcome, 'complete');
    assert.deepEqual(c.candidate?.artifactIds, [currentId]);
    assert.deepEqual(c.candidate?.backgroundArtifactIds ?? [], []);
    assert.deepEqual(c.publishedDelivery?.artifactIds, [currentId]);
    const final = c.messages.filter(message => message.kind === 'final').at(-1);
    assert.equal(final?.detailText ?? final?.text, deliveredText);
    assert.deepEqual(final?.artifactIds, [currentId]);
    assert(!c.artifacts.some(artifact => artifact.id === oldArtifact.id));
    if (c.sourceArtifact) assert.deepEqual(c.sourceArtifact, fixedSource);
    else assert.deepEqual(c.history?.artifacts, [oldArtifact]);
  }

  assertMissingOutput() {
    const { c } = this.model;
    assert.equal(c.outcome, 'complete');
    assert.deepEqual(c.publishedDelivery?.artifactIds, []);
    const final = c.messages.filter(message => message.kind === 'final').at(-1);
    assert.deepEqual(final?.artifactIds, []);
    assert.equal(final?.detailText ?? final?.text, deliveredText);
    assert.equal(c.candidate?.text, deliveredText);
    assert(c.candidate?.deliveryFindings?.some(finding => finding.kind === 'missing_requirement' && finding.reason === '尚未提供要求的全部文件'));
    assert(c.messages.some(message => message.kind === 'notice' && (message.detailText ?? message.text).includes('尚未提供要求的全部文件')));
  }

  preparePublishedRevision() {
    const { model } = this;
    this.deliver({ artifacts: [{ name: '本月摘要.md', content: '# 本月摘要第一版' }] });
    const previousId = model.c.publishedDelivery?.artifactIds[0];
    assert(previousId);
    this.previousId = previousId;
    assert(model.send({ type: 'CONTINUE', text: '更新本月摘要' }).ok);
    const pending = model.c.intents.find(work => work.kind === 'owner' && work.status === 'pending')!;
    assert(model.send({ type: 'CLAIM', intentId: pending.id }).ok);
    model.work = model.c.intents.find(work => work.id === pending.id)!;
  }

  submitRevision(base: '本轮发布稿' | '跨任务旧报告') {
    this.deliver({ artifactIds: [base === '本轮发布稿' ? this.previousId : oldArtifact.id],
      artifacts: [{ name: '本月摘要.md', content: '# 本月摘要更新', replacesArtifactId: base === '本轮发布稿' ? this.previousId : oldArtifact.id }] });
  }

  assertRevision(relation: '原报告的下一修订' | '独立文档') {
    const { c } = this.model;
    assert.equal(c.outcome, 'complete');
    const saved = c.artifacts.find(artifact => artifact.content === '# 本月摘要更新');
    assert(saved);
    assert.deepEqual(c.publishedDelivery?.artifactIds, [saved.id]);
    assert.equal(c.artifacts.find(artifact => artifact.id === this.previousId)?.content, '# 本月摘要第一版');
    const expected = relation === '原报告的下一修订'
      ? { documentId: this.previousId, revision: 2, replacesArtifactId: this.previousId }
      : { documentId: saved.id, revision: 1, replacesArtifactId: undefined };
    assert.deepEqual({ documentId: saved.documentId, revision: saved.revision, replacesArtifactId: saved.replacesArtifactId }, expected);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const variant of Object.keys(referenceVariants) as (keyof typeof referenceVariants)[]) {
    const test = new SummaryArtifactSelectionCase(variant === '两处都列了固定来源');
    test.prepareCurrentArtifact(); test.submitReferences(variant); test.assertCurrentOutput();
  }
  const missing = new SummaryArtifactSelectionCase();
  missing.submitOldAttachmentOnly(); missing.assertMissingOutput();
  const chained = new SummaryArtifactSelectionCase();
  chained.preparePublishedRevision(); chained.submitRevision('本轮发布稿'); chained.assertRevision('原报告的下一修订');
  const independent = new SummaryArtifactSelectionCase();
  independent.preparePublishedRevision(); independent.submitRevision('跨任务旧报告'); independent.assertRevision('独立文档');
  console.log('BT_A72–BT_A74: verified summary delivery artifact selection through persisted taskMachine transitions');
}
