import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Given, When, Then, After } from '@cucumber/cucumber';
import { SqliteStore, TeamEngine } from '../../src/index.js';
import { Harness, configuration } from '../helpers.js';
import type { SpecWorld } from './steps.js';
const stores = new WeakMap<SpecWorld, { directory: string; store: SqliteStore }>();
Given('{string}连续尝试同一方法失败且未主动求助', function (this: SpecWorld, _owner: string) {
  const directory = mkdtempSync(join(tmpdir(), 'gherkin-recovery-'));
  const store = new SqliteStore(join(directory, 'team.sqlite')); stores.set(this, { directory, store }); this.h = new Harness(configuration(), store);
  for (let n = 1; n < this.h.config.limits.repeatThreshold; n++) this.h.event({ type: 'FAILURE_SIGNAL', operation: '读取', parameters: '相同参数', resource: '资料', error: '反复无法访问', result: '无结果' });
});
Given('可控时钟已到达进展检查期限', function (this: SpecWorld) { this.h.now = this.h.context().nextCheckAt; });
Given('促进者将返回带具体问题的{string}', function (this: SpecWorld, action: string) { assert.equal(action, '安排 B 协助'); });
When('系统处理检查并保存协助意图后在派发前重启', function (this: SpecWorld) {
  this.h.engine.tick(this.h.room); assert.equal(this.h.view().phase, 'coordinating');
  this.h.event({ type: 'COORDINATE', decision: { action: 'assist', target: 'B', question: '寻找可访问的官方资料', expected: '来源与限制', reason: '原方法反复失败' } });
  const state = stores.get(this)!; state.store.close(); state.store = new SqliteStore(join(state.directory, 'team.sqlite'));
  this.h.engine = new TeamEngine(state.store, this.h.config, () => this.h.now); this.h.engine.recover(this.h.room);
});
When('恢复后{string}返回结果，该结果随后重复送达一次', function (this: SpecWorld, _bot: string) { this.received = this.h.claim('assistance'); this.h.event({ type: 'RECORD_RESULT', requestId: this.h.context().assists[0]!.id, resultId: 'R1', status: 'success', answer: '找到可访问的官方资料', workId: this.received.id }); this.h.engine.flushResults(this.h.room, this.h.task); this.result = this.h.event({ type: 'HELP_RESULT', requestId: this.h.context().assists[0]!.id, resultId: 'R1', status: 'success', answer: '找到可访问的官方资料' }); });
Then('应只存在一项逻辑协助并只推进原任务一次', function (this: SpecWorld) { assert.equal(this.h.context().assists.length, 1); assert.deepEqual(this.h.context().consumedResults, ['R1']); assert.equal(this.h.context().messages.filter(message => message.author === 'B').length, 1); });
Then('{string}应带着保留的失败经验与{string}的结果继续', function (this: SpecWorld, owner: string, _helper: string) { const work = this.h.engine.pending(this.h.room, this.h.task)[0]!; assert.equal(work.target, owner); assert(JSON.stringify(work.payload).includes('反复无法访问')); assert(JSON.stringify(work.payload).includes('找到可访问的官方资料')); });
Then('群中应如实显示系统安排的协作提示', function (this: SpecWorld) { const notices = this.h.context().messages.filter(message => message.kind === 'notice' && message.author === 'facilitator'); assert.equal(notices.length, 1); assert(notices[0]!.text.includes('安排 B 协助')); });
After(function (this: SpecWorld) { const state = stores.get(this); if (state) { state.store.close(); rmSync(state.directory, { recursive: true, force: true }); } });
