import assert from 'node:assert/strict';
import type { CliCatalogEntry } from '../src/cli-catalog.js';
import { LocalRuntime } from '../src/local-runtime.js';
import { LocalFixture } from './local-tools-fixture.js';
import { inventoryObservation } from './tool-inventory-observation.js';

const ocrCatalog: CliCatalogEntry[] = [
  { command: 'tesseract', description: '识别图片中的文字并输出文本', scenarios: ['扫描件 OCR', '图片文字识别'] },
  { command: 'ocrmypdf', description: '为扫描 PDF 增加可搜索文字层', scenarios: ['扫描 PDF OCR'] },
  { command: 'pdftotext', description: '提取 PDF 已有文字层', scenarios: ['读取电子版 PDF 文本'] },
  { command: 'git', description: '已在有效 PATH 发现可执行命令；用途资料未知。',
    documentation: { state: 'unknown', source: 'path', reference: 'git' } },
];
const largeCatalog: CliCatalogEntry[] = [
  ...ocrCatalog,
  ...Array.from({ length: 70 }, (_, index) => ({ command: `filler-${index}`, description: `Unrelated utility ${index}` })),
];

function submit(fixture: LocalFixture, text: string) {
  fixture.h.room = 'tool-discovery-planning';
  const reply = fixture.h.engine.submit(fixture.h.room, { id: 'tool-discovery-input', text,
    goal: { text, constraints: [], criteria: ['召回适用命令'], requiredArtifacts: 0 } });
  assert(reply.ok && reply.taskId); fixture.h.task = reply.taskId;
}

export async function progressiveInventoryAcceptance() {
  const fixture = await LocalFixture.create('方案师', true);
  try {
    await fixture.runtime.close();
    fixture.runtime = await createRuntime(fixture, largeCatalog);
    submit(fixture, '识别图片文字并准备 OCR 方案');
    fixture.replies.push({ type: 'answer', text: '先查看渐进式工具上下文。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const inventory = inventoryObservation(fixture.requests[0]!);
    assert.equal(inventory.catalogProjection, 'progressive');
    assert.equal(inventory.cli.entryCount, largeCatalog.length);
    assert.equal(inventory.cli.entries.length, 0);
    return { inventory, requests: fixture.requests.length };
  } finally { await fixture.close(); }
}

export async function mergedRecallAcceptance() {
  const fixture = await LocalFixture.create('方案师', true);
  try {
    await fixture.runtime.close();
    fixture.runtime = await createRuntime(fixture, largeCatalog);
    submit(fixture, '识别图片文字并为后续执行选择命令');
    fixture.replies.push({ type: 'discoverHost', query: '识别图片文字', terms: ['ocr', '光学识别'],
      commands: ['tesseract', 'paddleocr', 'git'] },
      { type: 'answer', text: '已合并用途 BM25 与名称假设。' });
    await fixture.runner().runOne(fixture.h.room, fixture.h.task);
    const result = fixture.h.context().intents[0]!.localOperations![0]!.result!;
    const recalled = (result.data.cli as { catalog?: { entries: CliCatalogEntry[]; recall?: { unregisteredNames: string[] } } }).catalog!;
    const commands = recalled.entries.map(entry => entry.command);
    assert(commands.includes('tesseract'));
    assert(commands.includes('git'));
    assert.deepEqual(recalled.recall?.unregisteredNames, ['paddleocr']);
    assert.equal(fixture.backend.calls.length, 0);
    const followUp = inventoryObservation(fixture.requests[1]!);
    assert(followUp.cli.entries.some(entry => entry.command === 'tesseract'));
    return { recalled, followUp };
  } finally { await fixture.close(); }
}

function createRuntime(fixture: LocalFixture, cliCatalog: CliCatalogEntry[]) {
  return LocalRuntime.create({ ...fixture.runtime.options, cliCatalog, catalogRefreshIntervalMs: 0 });
}
