import { TeamEngine, MemoryStore, WorkRunner } from '../src/index.js';
import { config } from '../team.config.js';

const engine = new TeamEngine(new MemoryStore(), config, () => 0);
const started = engine.submit('demo', { id: 'M1', text: '@A 给出 MVP 方案并核实恢复边界', mentions: ['A'],
  goal: { text: 'MVP 方案', constraints: ['引用依据并说明恢复边界'], criteria: ['可读的 Markdown 方案'], requiredArtifacts: 1 } });
const taskId = started.taskId!;
let ownerCalls = 0;
const runner = new WorkRunner(engine, {
  async execute(work) {
    if (work.kind === 'owner' && ++ownerCalls === 1) return { type: 'help', requestId: 'H1', target: 'B', question: '核对恢复边界', expected: '依据与限制' };
    if (work.kind === 'assistance') return { type: 'answer', text: '示例核查结果：会话恢复与外部动作去重需要分别验证。' };
    if (work.kind === 'owner') {
      engine.send('demo', taskId, { type: 'ARTIFACT', id: 'artifact:A1', at: 0, workId: work.id, fence: { epoch: work.epoch, goalVersion: work.goalVersion },
        artifact: { id: 'A1', name: 'plan.md', content: '# MVP\n群聊、求助、监督与恢复。\n此文件为受控示例产物。' } });
      return { type: 'deliver', text: '方案已结合核查结果完成。', artifactIds: ['A1'] };
    }
    if (work.kind === 'check') return { type: 'check', passed: true, gaps: [] };
    throw new Error(`Unexpected demonstration operation: ${work.kind}`);
  },
}, () => 0);

for (let n = 0; n < 10 && await runner.runOne('demo', taskId); n++) { /* bounded demonstration */ }
const view = engine.view('demo', taskId)!;
for (const m of view.context.messages) console.log(`[${m.author}] ${m.text}`);
console.log(JSON.stringify({ state: view.phase, outcome: view.context.outcome, usage: view.context.usage }, null, 2));
if (view.context.outcome !== 'complete') throw new Error('Demonstration did not complete');
