import { describe, expect, it } from 'vitest';
import { persistTask, restoreTask, taskPhase } from '../src/task.machine.js';
import type { Phase, TaskContext } from '../src/types.js';
import { LocalModel } from './local-model-fixture.js';

function strandedIn(phase: Phase) {
  const model = new LocalModel();
  const saved = structuredClone(persistTask(model.snapshot)) as { value: Phase; context: TaskContext };
  saved.value = phase;
  saved.context.intents[0]!.status = 'done';
  saved.context.candidate = { text: '已保存的候选', artifactIds: [], goalVersion: saved.context.goalVersion };
  model.snapshot = restoreTask(saved);
  model.at = model.c.nextCheckAt;
  return model;
}

describe('任务推进监督', () => {
  it.each(['interpreting', 'waitingAssistance', 'coordinating', 'checking'] as const)(
    '[BT_X02] 在 %s 无后续工作时保留候选并明确结算', phase => {
      const model = strandedIn(phase);

      model.send({ type: 'TICK', id: 'supervision' });

      expect(taskPhase(model.snapshot)).toBe('ended');
      expect(model.c.outcome).toBe('partial');
      expect(model.c.reason).toContain('推进中断');
      expect(model.c.candidate?.text).toBe('已保存的候选');
      expect(model.c.publishedDelivery).toBeUndefined();
      expect(model.c.intents.filter(work => work.status === 'pending')).toEqual([]);
    });

  it('[BT_X01] 活跃工作结算后允许同一进展期限安排协调', () => {
    const model = new LocalModel();
    model.at = model.c.nextCheckAt;
    expect(model.send({ type: 'TICK', id: 'supervision' }).ok).toBe(false);
    expect(model.send({ type: 'SETTLE', intentId: model.work.id }).ok).toBe(true);

    model.send({ type: 'TICK', id: 'supervision' });

    expect(taskPhase(model.snapshot)).toBe('coordinating');
    expect(model.c.intents.filter(work => work.kind === 'facilitator' && work.status === 'pending')).toHaveLength(1);
  });

  it('[BT_X03] 真实的用户等待不被进展期限结算', () => {
    const model = new LocalModel();
    expect(model.send({ type: 'WAIT_USER', workId: model.work.id, fence: model.work, question: '选哪个工作区？' }).ok).toBe(true);
    model.at = model.c.nextCheckAt;

    model.send({ type: 'TICK', id: 'supervision' });

    expect(taskPhase(model.snapshot)).toBe('waitingHuman');
    expect(model.c.reason).toBe('选哪个工作区？');
    expect(model.c.outcome).toBeNull();
  });
});
