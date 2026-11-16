import type { ArtifactDraft } from './types.js';
import { validSourceItems } from './source-items.js';

export function isLongResult(text: string): boolean {
  return text.length > 600 || text.split('\n').length >= 12;
}

const pureHeading = /^\s*#{1,6}\s+[^\n]+$/;

/** A saved coordinator summary can already be one line whose heading marker swallowed the body. */
function detachStoredReportHeading(value: string): string {
  return !value.includes('\n') && value.startsWith('# 任务处理报告 ') ? value.replace(/^# /, '') : value;
}

function detachOpeningHeading(block: string): string {
  const lines = block.split('\n');
  if (lines.length > 1 && /^\s*#{1,6}\s+/.test(lines[0] ?? '')) lines[0] = lines[0]!.replace(/^\s*#{1,6}\s+/, '');
  return lines.join('\n');
}

/** Presentation fallback only. Callers retain the complete source separately. */
export function compactMessage(text: string, summary?: string): string {
  const value = detachStoredReportHeading((summary?.trim() || text.trim()));
  if (value.length <= 300 && value.split('\n').length <= 5) return value;
  const paragraph = value.split(/\n\s*\n/).map(detachOpeningHeading).find(part => part.trim() && !pureHeading.test(part.trim())) ?? value;
  const flat = paragraph.replace(/\s+/g, ' ').trim();
  return flat.length > 280 ? `${flat.slice(0, 280)}…` : flat;
}

export function validArtifactDrafts(value: unknown): value is ArtifactDraft[] | undefined {
  return value === undefined || Array.isArray(value) && value.every(item => item && typeof item === 'object'
    && typeof item.name === 'string' && !!item.name.trim() && !/[\r\n\0]/.test(item.name)
    && typeof item.content === 'string' && !!item.content.trim() && validSourceItems(item.sourceItems)
    && (item.sourceItems === undefined || !/\bD\d+\b/i.test(item.content))
    && (item.replacesArtifactId === undefined || typeof item.replacesArtifactId === 'string' && !!item.replacesArtifactId.trim()));
}

export function validSummary(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string' && !!value.trim();
}
