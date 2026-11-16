import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { CliCatalogEntry } from '../src/cli-catalog.js';
import { recallCatalogEntries } from '../src/catalog-bm25.js';

const ocrEntries: CliCatalogEntry[] = [
  { command: 'tesseract', description: '识别图片中的文字并输出文本', scenarios: ['扫描件 OCR', '图片文字识别'] },
  { command: 'ocrmypdf', description: '为扫描 PDF 增加可搜索文字层', scenarios: ['扫描 PDF OCR'] },
  { command: 'pdftotext', description: '提取 PDF 已有文字层', scenarios: ['读取电子版 PDF 文本'] },
  { command: 'git', description: '已在有效 PATH 发现可执行命令；用途资料未知。',
    documentation: { state: 'unknown', source: 'path', reference: 'git' } },
];

describe('catalog bm25 recall', () => {
  it('merges bm25 and name channels for ocr discovery', () => {
    const result = recallCatalogEntries(ocrEntries, {
      query: '识别图片文字',
      terms: ['ocr', '光学识别'],
      commands: ['tesseract', 'paddleocr', 'git'],
    });
    const commands = result.matches.map(match => match.entry.command);
    assert(commands.includes('git'));
    assert(commands.includes('tesseract'));
    assert.deepEqual(result.unregisteredNames, ['paddleocr']);
    const tesseract = result.matches.find(match => match.entry.command === 'tesseract');
    assert(tesseract?.channels.includes('bm25'));
    const git = result.matches.find(match => match.entry.command === 'git');
    assert(git?.channels.includes('name'));
  });

  it('recalls scan pdf workflow commands', () => {
    const result = recallCatalogEntries(ocrEntries, { query: '给扫描PDF添加可搜索文字层', commands: ['ocrmypdf'] });
    const commands = result.matches.map(match => match.entry.command);
    assert(commands.includes('ocrmypdf'));
  });

  it('restores pdftotext through the name channel', () => {
    const result = recallCatalogEntries(ocrEntries, { query: '提取PDF已有文字层', commands: ['pdftotext'] });
    assert(result.matches.some(match => match.entry.command === 'pdftotext'));
  });

  it('indexes real descriptions when every scenario is the generic template', () => {
    const boilerplate = '当任务的输入和目标符合用途说明时，选择本命令；按所引资料核对参数和前提，以取得说明中的结果。';
    const unknown = '已在有效 PATH 发现可执行命令；用途资料未知。';
    const entries: CliCatalogEntry[] = [
      { command: 'named-ocr', description: 'Named optical character recognition utility', scenarios: [boilerplate] },
      ...Array.from({ length: 2475 }, (_, index) => ({
        command: `path-command-${index}`,
        description: index < 1806 ? unknown : `Read archive records for workflow ${index}`,
        scenarios: [boilerplate],
      })),
    ];
    const recalled = recallCatalogEntries(entries, { query: 'optical character recognition' });
    assert.deepEqual(recalled.matches.map(match => match.entry.command), ['named-ocr']);
    assert.deepEqual(recalled.matches[0]?.channels, ['bm25']);
    const documented = recallCatalogEntries(entries, { query: 'workflow' });
    assert.equal(documented.matches.length, 669);
    assert(documented.matches.every(match => match.channels.includes('bm25') && !match.entry.description.includes('用途资料未知')));
    assert.equal(recallCatalogEntries(entries, { query: '按所引资料核对参数' }).matches.length, 0);
    assert.equal(recallCatalogEntries(entries, { query: '用途资料未知' }).matches.length, 0);
  });
});
