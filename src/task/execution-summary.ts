import type { TaskContext } from '../types.js';

const statusLabel = { queued: '待执行', running: '待结算', uncertain: '待核实', succeeded: '完成',
  partial: '部分完成', failed: '失败', timeout: '超时', cancelled: '已跳过' } as const;

function brief(text: string, max = 56): string {
  const characters = Array.from(text.replace(/\s+/g, ' ').trim());
  return characters.length > max ? characters.slice(0, max - 1).join('') + '…' : characters.join('');
}

function list(items: readonly string[], max = 2): string {
  const shown = items.slice(0, max).join('、');
  return items.length > max ? `${shown}等 ${items.length} 项` : shown;
}

export function executionSummary(c: TaskContext, submissionGaps: readonly string[]): string {
  const files = new Set(c.publishedDelivery?.goalVersion === c.goalVersion ? c.publishedDelivery.artifactIds : []);
  const names = c.artifacts.filter(artifact => files.has(artifact.id)).map(artifact => brief(artifact.name, 32));
  const report = [c.outcome === 'complete'
    ? `执行摘要。已交付正文${names.length ? `及 ${names.length} 个文件（${list(names)}）` : ''}。`
    : '执行摘要。已记录本轮执行结果。'];
  const discussion = c.discussion?.goalVersion === c.goalVersion ? c.discussion : undefined;
  const plan = discussion?.mapReduce;
  const originalIds = new Set(plan?.partitions.map(part => part.id));
  const partitions = plan?.queue?.filter(part => originalIds.has(part.partitionId)) ?? [];
  const gaps: string[] = [];
  if (partitions.length) {
    const succeeded = partitions.filter(part => part.status === 'succeeded').length;
    const reused = partitions.filter(part => part.reusedSource).length;
    report.push(`分片 ${succeeded}/${partitions.length} 完成${reused ? `，其中 ${reused} 个沿用已验证版本` : ''}。`);
    for (const part of partitions.filter(item => item.status !== 'succeeded')) {
      gaps.push(`${brief(part.partitionId, 28)} ${statusLabel[part.status]}${part.reason ? `（${brief(part.reason)}）` : ''}`);
    }
  } else if (discussion?.incomplete) gaps.push(brief(discussion.incomplete));
  const missedHelp = c.assists.filter(help => help.goalVersion === c.goalVersion && ['partial', 'failed', 'timeout'].includes(help.status));
  if (missedHelp.length) gaps.push(`${missedHelp.length} 项协助未完整完成`);
  if (c.candidate?.deliveryIssue?.code === 'RESOURCE_ACQUISITION_UNVERIFIED') gaps.push('缺少必需资源的获取凭证');
  else if (c.outcome !== 'complete' && c.reason) gaps.push(brief(c.reason));
  gaps.push(...submissionGaps);
  if (gaps.length) report.push(`待确认 ${list(gaps)}。`);
  return report.join('\n');
}
