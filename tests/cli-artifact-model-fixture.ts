import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LocalModel } from './local-model-fixture.js';
import type { ArtifactDraft, TaskContext } from '../src/types.js';

export const pageName = '把 Agents 变成真团队.html';
export const page = '<!DOCTYPE html>\n<html lang="zh"><title>团队</title><h1 id="team">团队</h1></html>\n';
export const pageHash = createHash('sha256').update(page).digest('hex');
export const fileConclusion = '这是任务已有的结论。';
export const revisedPage = '发布版.html';

export function assertFileConclusion(context: TaskContext, files: readonly string[], missing?: string, text = fileConclusion) {
  assert.equal(context.outcome, missing ? 'partial' : 'complete');
  assert.equal(context.deliveryCycle?.stage.kind, 'published');
  const final = context.messages.filter(message => message.kind === 'final').at(-1);
  assert(final);
  assert.equal(final.detailText ?? final.text, text);
  const names = (final.artifactIds ?? []).map(id => context.artifacts.find(item => item.id === id)?.name);
  assert.deepEqual(names, files);
  const summary = [...context.messages].reverse().find(message => message.kind === 'notice' && message.text.startsWith('执行摘要'));
  assert(summary, 'the room must receive a delivery summary');
  if (missing) {
    assert(summary.text.includes('发现严重问题') && summary.text.includes(missing), summary.text);
    assert(context.candidate?.deliveryFindings?.some(finding => finding.kind === 'missing_requirement' && finding.reason.includes(missing)));
  } else assert(!summary.text.includes('发现严重问题'), summary.text);
}

export function submitFileConclusion(model: LocalModel, artifacts?: ArtifactDraft[], backgroundArtifactIds?: string[]) {
  assert(model.send({ type: 'DELIVER', text: fileConclusion, workId: model.work.id, fence: model.work,
    artifactIds: [], ...(artifacts ? { artifacts } : {}), ...(backgroundArtifactIds ? { backgroundArtifactIds } : {}) }).ok);
}

export function prepareFileRequirement(text: string) {
  return new LocalModel(input => {
    input.config.deliveryReport = 'summary';
    input.goal = { ...input.goal, text };
    input.message = { ...input.message, text };
  });
}

export class CliArtifactContinuation {
  readonly model = prepareFileRequirement('把分享稿转成 HTML，把生成的网页文件附在群消息里。');
  readonly first = this.model.work;
  readonly savedId: string;

  constructor() {
    const m = this.model;
    assert(m.request({ type: 'runCli', executable: 'pandoc', args: ['share.md', '-o', pageName], artifactPath: pageName }).ok);
    assert(m.claim().ok);
    assert(m.started().ok);
    assert(m.result({ artifact: { path: pageName, content: page, sha256: pageHash } }).ok);
    const saved = m.c.artifacts.find(item => item.name === pageName);
    assert(saved);
    this.savedId = saved.id;
  }

  submit(continuation: string) {
    const m = this.model;
    if (continuation === '明确续办同一目标的新轮次') {
      assert(m.send({ type: 'STOP' }).ok);
      assert(m.send({ type: 'SETTLE', intentId: this.first.id }).ok);
      assert(m.send({ type: 'CONTINUE', text: '继续原任务' }).ok);
    } else if (continuation === '将已保存网页替换为当前修订' || continuation === '明确作为背景后再次续办') {
      const background = continuation === '明确作为背景后再次续办' ? [this.savedId] : [];
      assert(m.send({ type: 'DELIVER', workId: this.first.id, fence: this.first, text: '原任务已有结果',
        artifactIds: [], backgroundArtifactIds: background }).ok);
      assert(m.send({ type: 'CONTINUE', text: '继续原任务' }).ok);
    } else {
      assert(m.send({ type: 'BLOCKED', workId: this.first.id, fence: this.first, reason: '需安排后续交付' }).ok);
      const coordinator = m.c.intents.find(work => work.kind === 'facilitator' && work.status === 'pending');
      assert(coordinator);
      assert(m.send({ type: 'CLAIM', intentId: coordinator.id }).ok);
      assert(m.send({ type: 'COORDINATE', workId: coordinator.id, fence: coordinator,
        decision: { action: 'continue', reason: '接续已保存成果' } }).ok);
    }
    if (continuation === '更新后的新目标') {
      const text = '改为只给出新的文字结论';
      assert(m.send({ type: 'USER_INPUT', text, goal: { text, constraints: [], criteria: [], requiredArtifacts: 0 } }).ok);
      assert.notEqual(m.c.goalVersion, this.first.goalVersion);
    }
    const next = m.c.intents.find(work => work.kind === 'owner' && work.status === 'pending');
    assert(next && next.id !== this.first.id);
    assert(m.send({ type: 'CLAIM', intentId: next.id }).ok);
    m.work = m.c.intents.find(work => work.id === next.id)!;
    submitFileConclusion(m, continuation === '将已保存网页替换为当前修订' ? [{ name: revisedPage, content: page, replacesArtifactId: this.savedId }] : undefined,
      continuation === '把网页明确列为背景' ? [this.savedId] : undefined);
  }

  verify(result: string) {
    const c = this.model.c;
    const final = c.messages.filter(message => message.kind === 'final').at(-1);
    assert(final);
    assert.equal(final.text, fileConclusion);
    assert.deepEqual(final.artifactIds ?? [], result === '复用已保存网页' ? [this.savedId]
      : result === '发布新稿并保留旧网页' ? [c.artifacts.find(artifact => artifact.name === revisedPage)?.id] : []);
    if (result === '发布新稿并保留旧网页') {
      assert.equal(c.artifacts.find(artifact => artifact.name === revisedPage)?.replacesArtifactId, this.savedId);
    }
    assert.equal(c.artifacts.find(item => item.id === this.savedId)?.content, page);
    assert.equal(c.intents.flatMap(work => work.localOperations ?? []).filter(operation => operation.action.type === 'runCli').length, 1);
  }
}

export function verifyCliArtifactModel(scenario: 'failed' | 'deliver' | 'stopped' | 'reconcile') {
  const model = new LocalModel();
  assert(model.request({ type: 'runCli', executable: 'pandoc', args: ['share.md', '-o', pageName], artifactPath: pageName }).ok,
    'The declared workspace output must be accepted by the real local request boundary');
  assert(model.claim().ok);
  assert(model.send({ type: 'LOCAL_STARTED', intentId: model.work.id, operationId: 'op1', sessionId: 'session1' }).ok);
  if (scenario === 'stopped') assert(model.send({ type: 'STOP' }).ok);
  if (scenario === 'reconcile') assert(model.send({ type: 'RECOVER', config: model.c.config }).ok);
  const artifact = { path: pageName, content: page, sha256: pageHash };
  const result = { ok: true, code: 'succeeded', data: {} };
  const response = scenario === 'reconcile' ? model.send({ type: 'LOCAL_RECONCILE', intentId: model.work.id,
    operationId: 'op1', sessionId: 'session1', resolution: 'receipt', detail: 'durable process receipt', result, artifact })
    : model.result({ result, artifact });
  assert(response.ok);
  if (scenario === 'stopped') {
    assert(!model.c.artifacts.some(file => file.name === pageName));
    return;
  }
  const saved = model.c.artifacts.find(file => file.name === pageName);
  assert(saved, 'CLI result must save the complete attachment before a model delivery');
  assert.equal(saved.content, page);
  assert.deepEqual(model.op?.result?.data.artifact, { id: saved.id, name: pageName, sha256: pageHash });
  assert(!JSON.stringify(model.op?.result).includes(page));
  if (scenario === 'failed') {
    assert(model.send({ type: 'WORK_FAILED', intentId: model.work.id, reason: 'INVALID_TOOL_REQUEST', transient: false }).ok);
    assert(model.c.messages.some(message => message.artifactIds?.includes(saved.id)));
    assert.notEqual(model.c.outcome, 'complete');
  } else if (scenario === 'deliver') {
    assert(model.send({ type: 'DELIVER', workId: model.work.id, fence: model.work, text: '生成网页', artifactIds: [] }).ok);
    assert.deepEqual(model.c.candidate?.artifactIds, [saved.id]);
    const check = model.c.intents.find(work => work.kind === 'check');
    assert.deepEqual(check?.payload.artifacts, [saved]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const scenario of ['failed', 'deliver', 'stopped', 'reconcile'] as const) verifyCliArtifactModel(scenario);
  const model = prepareFileRequirement('把本地 Markdown 分享稿转成 HTML，把生成的网页文件附在群消息里。');
  submitFileConclusion(model, [{ name: '分享稿.md', content: '# 另一份可用文件' }]);
  assertFileConclusion(model.c, ['分享稿.md'], 'HTML 文件');
  for (const [continuation, result] of [['同一目标的后继工作', '复用已保存网页'],
    ['明确续办同一目标的新轮次', '复用已保存网页'], ['把网页明确列为背景', '仅发布结论'],
    ['明确作为背景后再次续办', '仅发布结论'],
    ['将已保存网页替换为当前修订', '发布新稿并保留旧网页'], ['更新后的新目标', '仅发布结论']] as const) {
    const flow = new CliArtifactContinuation(); flow.submit(continuation); flow.verify(result);
  }
  console.log('BT_A67–BT_A69、BT_A75–BT_A76: verified persisted taskMachine attachment and result boundaries');
}
