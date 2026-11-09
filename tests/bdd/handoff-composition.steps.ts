import assert from 'node:assert/strict';
import { Given, When, Then } from '@cucumber/cucumber';
import { verifyRetryAuthorityCase, verifyRetryComposition, type RetryDomain } from '../handoff-composition-fixture.js';
import type { SpecWorld } from './steps.js';

type Observation = ReturnType<typeof verifyRetryComposition>[number];
const states = new WeakMap<SpecWorld, { domain?: RetryDomain; restriction?: string; observations?: Observation[] }>();
function state(world: SpecWorld) { const value = states.get(world); assert(value); return value; }
Given('原协助的结果为「{word}」', function(this: SpecWorld, result: string) {
  assert(['失败待重试', '已保存待交接'].includes(result));
  states.set(this, { domain: result === '失败待重试' ? 'failed' : 'saved' });
});
When('用户用不同请求身份重复重试并收到旧结果', function(this: SpecWorld) {
  const item = state(this); assert(item.domain); item.observations = verifyRetryComposition(item.domain);
});
Then('原负责人只收到一次合法结果且至多创建一次新核查', function(this: SpecWorld) {
  const item = state(this); assert(item.observations);
  const result = item.observations.map(value => ({ backend: value.backend, successors: value.successors, resumes: value.resumes }));
  assert.deepEqual(result, item.domain === 'saved'
    ? [{ backend: 'memory', successors: 0, resumes: 1 }, { backend: 'memory', successors: 0, resumes: 1 },
       { backend: 'sqlite', successors: 0, resumes: 1 }, { backend: 'sqlite', successors: 0, resumes: 1 }]
    : [{ backend: 'memory', successors: 1, resumes: 1 }, { backend: 'memory', successors: 0, resumes: 0 }, { backend: 'memory', successors: 0, resumes: 0 },
       { backend: 'sqlite', successors: 1, resumes: 1 }, { backend: 'sqlite', successors: 0, resumes: 0 }, { backend: 'sqlite', successors: 0, resumes: 0 }]);
});
Given('原协助重试前发生「{word}」', function(this: SpecWorld, change: string) {
  assert(['核查工具权限撤销', '原负责人已变化'].includes(change));
  states.set(this, { restriction: change === '核查工具权限撤销' ? 'RevokePermission' : 'ChangeOwner' });
});
When('用户先后两次重试并恢复服务', function(this: SpecWorld) {
  const item = state(this); assert(item.restriction); item.observations = verifyRetryAuthorityCase(item.restriction);
});
Then('不应创建该旧协助的新尝试或负责人结果续办', function(this: SpecWorld) {
  const values = state(this).observations; assert(values);
  assert.deepEqual(values.map(value => ({ backend: value.backend, successors: value.successors, resumes: value.resumes })),
    [{ backend: 'memory', successors: 0, resumes: 0 }, { backend: 'sqlite', successors: 0, resumes: 0 }]);
});
