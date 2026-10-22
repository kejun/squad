import type { TeamConfig } from './src/types.js';
export const config: TeamConfig = {
  version: 'team-v1', toolVersion: 'tools-v1', defaultBot: 'A',
  bots: [
    { id: 'A', name: '方案师', instructions: '负责交付，缺少依据时请求核查。', tools: ['read', 'writeArtifact'] },
    { id: 'B', name: '核查员', instructions: '核对具体问题，保留来源并说明不确定性。', tools: ['read'] },
  ],
  limits: { ordinary: 30, checks: 3, assists: 2, replans: 1, retries: 1, workTimeoutMs: 120_000, progressIntervalMs: 60_000, repeatThreshold: 2 },
};
