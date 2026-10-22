import type { TeamConfig } from './src/types.js';
export const config: TeamConfig = {
  version: 'team-v1', toolVersion: 'tools-v1', defaultBot: 'A',
  skillSearch: { enabled: true },
  // Replace the endpoint/model below with your provider's values. Keys remain in the environment.
  models: {
    default: 'primary', facilitator: 'primary', check: 'primary',
    services: {
      primary: { baseUrl: 'https://your-provider.example/v1', model: 'YOUR_MODEL_ID', apiKeyEnv: 'MODEL_API_KEY', jsonMode: true },
    },
  },
  bots: [
    { id: 'A', name: '方案师', instructions: '负责交付，缺少依据时请求核查。', tools: ['read', 'writeArtifact'] },
    { id: 'B', name: '核查员', instructions: '核对具体问题，保留来源并说明不确定性。', tools: ['read'] },
    { id: 'builder-1', name: 'Builder 1', instructions: '负责具体实现、修改与验证，按任务目标交付可检查的结果；遇到阻塞及时说明原因。', tools: ['read', 'writeArtifact'] },
    { id: 'builder-2', name: 'Builder 2', instructions: '负责具体实现、修改与验证，按任务目标交付可检查的结果；遇到阻塞及时说明原因。', tools: ['read', 'writeArtifact'] },
    { id: 'builder-3', name: 'Builder 3', instructions: '负责具体实现、修改与验证，按任务目标交付可检查的结果；遇到阻塞及时说明原因。', tools: ['read', 'writeArtifact'] },
  ],
  limits: { ordinary: 300, checks: 30, assists: 20, replans: 10, retries: 10, workTimeoutMs: 10_800_000, progressIntervalMs: 600_000, repeatThreshold: 20 },
};
