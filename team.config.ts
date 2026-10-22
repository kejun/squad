import type { TeamConfig } from './src/types.js';
export const config: TeamConfig = {
  version: 'team-v1', toolVersion: 'tools-v1', defaultBot: 'A',
  bots: [
    { id: 'A', name: '方案师', instructions: '负责交付，缺少依据时请求核查。', tools: ['read', 'writeArtifact'] },
    { id: 'B', name: '核查员', instructions: '核对具体问题，保留来源并说明不确定性。', tools: ['read'] },
  ],
  limits: { ordinary: 300, checks: 30, assists: 20, replans: 10, retries: 10, workTimeoutMs: 10_800_000, progressIntervalMs: 600_000, repeatThreshold: 20 },
};
