import { describe, expect, it } from 'vitest';
import { stateTransitions, taskGraph } from '../src/task-debug.js';
import { completeWithTemplates, malformedDiscussion, plannedSandbox, primaryDeliveryTemplate, rejectedDiscussionIdentity } from './discussion-debug-fixture.js';
describe('real XState discussion sandbox', () => {
  it('[BT_V10] completes background discussion using the generated event templates', () => completeWithTemplates(plannedSandbox()));
  it('[BT_V11] binds the primary delivery template to the owner during parallel work', () => primaryDeliveryTemplate(plannedSandbox(true)));
  it('[BT_V12] preserves sandbox state and history on malformed discussion events', () => malformedDiscussion(plannedSandbox()));
  it.each(['缺少版本边界', '错误讨论轮次', '过期版本边界', '关联主工作'])('[BT_V14] rejects %s without retiring the current worker', error => { rejectedDiscussionIdentity(plannedSandbox(true), error); });
  it('[BT_V15] retains guarded global fallbacks while preserving unconditional local overrides', () => {
    const graph = taskGraph();
    const guards = stateTransitions(graph, 'running').filter(item => item.event === 'CLAIM').flatMap(item => item.guards);
    expect(guards).toEqual(expect.arrayContaining(['claimOwner', 'claimDiscussion', 'claimCancel']));
    expect(stateTransitions(graph, 'stopping').filter(item => item.event === 'STOP')).toHaveLength(1);
  });
});
