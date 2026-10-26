import type { ArtifactDraft } from './types.js';

export function isLongResult(text: string): boolean {
  return text.length > 600 || text.split('\n').length >= 12;
}

/** Presentation fallback only. Callers retain the complete source separately. */
export function compactMessage(text: string, summary?: string): string {
  const value = (summary?.trim() || text.trim());
  if (value.length <= 300 && value.split('\n').length <= 5) return value;
  const paragraph = value.split(/\n\s*\n/).find(part => part.trim() && !/^\s*#{1,6}\s+[^\n]+$/.test(part)) ?? value;
  const flat = paragraph.replace(/\s+/g, ' ').trim();
  return flat.length > 280 ? `${flat.slice(0, 280)}…` : flat;
}

export function validArtifactDrafts(value: unknown): value is ArtifactDraft[] | undefined {
  return value === undefined || Array.isArray(value) && value.every(item => item && typeof item === 'object'
    && typeof item.name === 'string' && !!item.name.trim() && !/[\r\n\0]/.test(item.name)
    && typeof item.content === 'string' && !!item.content.trim());
}

export function validSummary(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string' && !!value.trim();
}
