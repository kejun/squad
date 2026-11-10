import { z } from 'zod';

const field = z.string().min(1).max(400).refine(value => value === value.trim() && !/[\r\n\0]/.test(value));
const sourceItemSchema = z.strictObject({
  text: z.string().min(1).max(4000).refine(value => !!value.trim() && !/\bD\d+\b/i.test(value)),
  status: field.refine(value => !/\bD\d+\b/i.test(value)),
  sourceDocId: field,
  sourceEvidenceId: field,
});
const sourceItemsSchema = z.array(sourceItemSchema).min(1).max(200);
export type SourceItem = z.infer<typeof sourceItemSchema>;
export function validSourceItems(value: unknown): value is SourceItem[] | undefined {
  return value === undefined || sourceItemsSchema.safeParse(value).success;
}


const tableCell = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
/** Only this renderer assigns display labels; stored items always retain source identities. */
export function renderSourceItems(content: string, items: readonly SourceItem[] | undefined): string {
  if (!items?.length) return content;
  const documents = new Map<string, number>();
  const rows = items.map(item => {
    const key = JSON.stringify([item.sourceEvidenceId, item.sourceDocId]);
    if (!documents.has(key)) documents.set(key, documents.size + 1);
    return `| D${documents.get(key)} | ${tableCell(item.sourceDocId)} | ${tableCell(item.text)} | ${tableCell(item.status)} |`;
  });
  return [content, '', '| 文档 | 原始文档标识 | 工作项 | 原文状态 |', '| --- | --- | --- | --- |', ...rows].join('\n');
}
