import type { TeamConfig } from './src/types.js';
import { configureModelsFromEnv, loadModelEnvFile, type ModelEnvironment } from './src/model-env.js';

loadModelEnvFile();

export function createTeamConfig(env: ModelEnvironment = process.env): TeamConfig {
  const webEnabled = env.SQUAD_WEB_TOOLS_ENABLED?.trim().toLowerCase();
  if (webEnabled && !['true', 'false'].includes(webEnabled)) throw new Error('SQUAD_WEB_TOOLS_ENABLED must be true or false');
  const intentEnabled = env.SQUAD_INTENT_ANALYSIS_ENABLED?.trim().toLowerCase();
  if (intentEnabled && !['true', 'false'].includes(intentEnabled)) throw new Error('SQUAD_INTENT_ANALYSIS_ENABLED must be true or false');
  const localEnabled = env.SQUAD_LOCAL_TOOLS_ENABLED?.trim().toLowerCase();
  if (localEnabled && !['true', 'false'].includes(localEnabled)) throw new Error('SQUAD_LOCAL_TOOLS_ENABLED must be true or false');
  return configureModelsFromEnv({
  version: 'team-v1', toolVersion: 'tools-v1', defaultBot: 'A',
  skillSearch: { enabled: true },
  localTools: { enabled: env.SQUAD_LOCAL_TOOLS_ENABLED?.trim().toLowerCase() !== 'false' },
  webTools: { enabled: webEnabled !== 'false' },
  inputAnalysis: { enabled: intentEnabled !== 'false' },
  bots: [
    { id: 'A', name: '方案师', instructions: '负责交付，缺少依据时请求核查。', tools: ['read', 'writeArtifact'] },
    { id: 'B', name: '核查员', instructions: '核对具体问题，保留来源并说明不确定性。', tools: ['read'] },
    { id: 'builder-1', name: 'Builder 1', instructions: '负责具体实现、修改与验证，按任务目标交付可检查的结果；遇到阻塞及时说明原因。', tools: ['read', 'writeArtifact'] },
    { id: 'builder-2', name: 'Builder 2', instructions: '负责具体实现、修改与验证，按任务目标交付可检查的结果；遇到阻塞及时说明原因。', tools: ['read', 'writeArtifact'] },
    { id: 'builder-3', name: 'Builder 3', instructions: '负责具体实现、修改与验证，按任务目标交付可检查的结果；遇到阻塞及时说明原因。', tools: ['read', 'writeArtifact'] },
  ],
  limits: { ordinary: 300, checks: 30, assists: 20, replans: 10, retries: 10, workTimeoutMs: 10_800_000, progressIntervalMs: 600_000, repeatThreshold: 20 },
  }, env);
}

export const config = createTeamConfig();
