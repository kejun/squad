import { withFixtureAcceptance } from './delivery-protocol-fixture.js';
import { OpenAICompatibleAdapter, WorkRunner } from '../src/index.js';
import { configuration, Harness } from './helpers.js';

// Fields captured from the public API's repository and domain result shapes.
export const mixedSourceSkills = [
  { id: 'skills.volces.com/gemini-assistant', source: 'skills.volces.com', skillId: 'gemini-assistant', name: 'gemini-assistant', installs: 14 },
  { id: 'aliyun/alibabacloud-aiops-skills/alibabacloud-nas-mount-diagnosis', source: 'aliyun/alibabacloud-aiops-skills', skillId: 'alibabacloud-nas-mount-diagnosis', name: 'alibabacloud-nas-mount-diagnosis', installs: 71 },
];
export const malformedSkillResults: Record<string, unknown> = {
  缺少名称: { ...mixedSourceSkills[0], name: undefined },
  非法来源: { ...mixedSourceSkills[0], source: 'https://skills.volces.com' },
  非法安装量: { ...mixedSourceSkills[0], installs: -1 },
};

export function skillSearchCase(problem?: string) {
  const config = configuration();
  config.models = { default: 'test', services: { test: { baseUrl: 'https://model.invalid/v1', model: 'test' } } };
  const h = new Harness(config);
  const requests: { messages: { role: string; content: string }[] }[] = [];
  let searches = 0;
  const adapter = new OpenAICompatibleAdapter(config, { clock: () => 0, env: {}, transport: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const output = requests.length === 1 ? { type: 'findSkills', query: 'general purpose assistant skills' }
      : { type: 'answer', text: '已根据两类技能资料形成建议' };
    return Response.json({ choices: [{ message: { content: JSON.stringify(withFixtureAcceptance(output, requests.at(-1))) }, finish_reason: 'stop' }] });
  } });
  const runner = new WorkRunner(h.engine, adapter, () => 0, async () => {
    searches++;
    return Response.json({ skills: problem ? [mixedSourceSkills[1], malformedSkillResults[problem]] : mixedSourceSkills });
  });
  return { h, requests, get searches() { return searches; }, run: () => runner.runOne(h.room, h.task) };
}
