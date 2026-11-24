import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { After, Given, Then, When } from '@cucumber/cucumber';
import { artifactDocument } from '../../web/src/detail-document.js';
import { page, pageHash, pageName } from '../cli-artifact-model-fixture.js';
import { LocalFixture } from '../local-tools-fixture.js';
import type { SpecWorld } from './steps.js';

const fixtures = new WeakMap<SpecWorld, LocalFixture>();
const script = `const fs = require('node:fs');
const heading = fs.readFileSync('share.md', 'utf8').trim().slice(2);
fs.writeFileSync(process.argv[1], '<!DOCTYPE html>\\n<html lang="zh"><title>' + heading + '</title><h1 id="team">' + heading + '</h1></html>\\n');`;
const convert = (body = script) => ({ type: 'runCli', executable: 'node', args: ['-e', body, pageName], artifactPath: pageName });

After(async function (this: SpecWorld) {
  await fixtures.get(this)?.close();
  fixtures.delete(this);
});

Given('负责人请求将本地 Markdown 转为一个声明的网页交付文件', async function (this: SpecWorld) {
  const fixture = await LocalFixture.create('方案师', true);
  fixtures.set(this, fixture);
  await writeFile(join(fixture.source, 'share.md'), '# 团队\n');
  assert(fixture.h.event({ type: 'USER_INPUT', text: `将 share.md 转为 ${pageName}` }).ok);
});

When('转换命令生成网页而后续模型工具请求修正仍失败', async function (this: SpecWorld) {
  const fixture = fixtures.get(this)!;
  const malformed = { type: 'runCli', executable: 'node', args: 'bad arguments' };
  fixture.replies.push(convert(), { type: 'discoverHost', commands: ['node'] }, malformed, malformed);
  assert(await fixture.runner().runOne(fixture.h.room, fixture.h.task));
});

Then('群消息应引用一个可按原文件名下载的完整网页', async function (this: SpecWorld) {
  const fixture = fixtures.get(this)!;
  const context = fixture.h.context();
  const stored = context.artifacts.find(item => item.name === pageName);
  assert(stored, 'the generated workspace file must survive the failed model request');
  const failure = context.messages.find(message => message.artifactIds?.includes(stored.id));
  assert.match(failure?.detailText ?? failure?.text ?? '', /INVALID_TOOL_REQUEST/);
  const document = artifactDocument(stored, failure!.taskId);
  assert.equal(document.name, pageName);
  assert.equal(document.content, page);
  const generated = await readFile(join(fixture.source, pageName));
  assert.equal(createHash('sha256').update(generated).digest('hex'), pageHash);
  const receipt = context.intents.flatMap(work => work.localOperations ?? []).find(op => op.action.type === 'runCli');
  assert.deepEqual(receipt?.result?.data.artifact, { id: stored.id, name: pageName, sha256: pageHash });
  const resultMessage = fixture.requests[1]?.messages.find(message => message.content.includes('local_tool_result'));
  assert.deepEqual(JSON.parse(resultMessage!.content).data.artifact, receipt?.result?.data.artifact);
  const compactReceipt = fixture.requests[2]?.messages.find(message => message.content.includes(receipt!.id));
  assert.deepEqual(JSON.parse(compactReceipt!.content).artifact, receipt?.result?.data.artifact);
});

Then('任务不应标为验收通过且转换只运行一次', function (this: SpecWorld) {
  const fixture = fixtures.get(this)!;
  assert.notEqual(fixture.h.context().outcome, 'complete');
  assert.equal(fixture.backend.calls.length, 1);
});

When('转换命令生成网页且负责人用简短结论提交交付', async function (this: SpecWorld) {
  const fixture = fixtures.get(this)!;
  fixture.replies.push(convert(), { type: 'answer', text: '网页已生成' });
  assert(await fixture.runner().runOne(fixture.h.room, fixture.h.task));
});

Then('独立检查应收到命令结算时保存的同一网页', function (this: SpecWorld) {
  const fixture = fixtures.get(this)!;
  const context = fixture.h.context();
  const stored = context.artifacts.find(item => item.name === pageName);
  assert(stored);
  assert.equal(stored.content, page);
  assert.deepEqual(context.candidate?.artifactIds, [stored.id]);
  const check = context.intents.find(work => work.kind === 'check');
  assert.deepEqual(check?.payload.artifacts, [stored]);
  assert.equal(fixture.backend.calls.length, 1);
});

const invalidEffects = {
  文件未写入: '',
  路径为链接: `require('node:fs').symlinkSync('share.md', process.argv[1]);`,
  '内容不是有效 UTF-8': `require('node:fs').writeFileSync(process.argv[1], Buffer.from([0xff]));`,
};

When('该命令遇到{string}', async function (this: SpecWorld, cause: string) {
  const fixture = fixtures.get(this)!;
  if (cause === '任务停止后收到结果') {
    const execute = fixture.backend.execute.bind(fixture.backend);
    fixture.backend.execute = async (...args) => {
      const result = await execute(...args);
      assert(fixture.h.event({ type: 'STOP' }).ok);
      return result;
    };
    fixture.replies.push(convert());
    assert(await fixture.runner().runOne(fixture.h.room, fixture.h.task));
    assert.equal(await readFile(join(fixture.source, pageName), 'utf8'), page);
    assert.equal(fixture.h.context().outcome, 'stopped');
    return;
  }
  assert(Object.hasOwn(invalidEffects, cause));
  if (cause === '文件未写入') await writeFile(join(fixture.source, pageName), '上一次的旧文件');
  fixture.replies.push(convert(invalidEffects[cause as keyof typeof invalidEffects]), { type: 'blocked', reason: '未生成可用网页' });
  assert(await fixture.runner().runOne(fixture.h.room, fixture.h.task));
  const operations = fixture.h.context().intents.flatMap(work => work.localOperations ?? []);
  assert.equal(operations[0]?.result?.code, 'CLI_ARTIFACT_UNAVAILABLE');
});

Then('群内不应出现该网页的产物入口', function (this: SpecWorld) {
  const context = fixtures.get(this)!.h.context();
  assert(!context.artifacts.some(item => item.name === pageName));
});
