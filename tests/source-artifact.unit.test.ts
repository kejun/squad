import { describe, expect, it } from 'vitest';
import { parseArtifactRequest } from '../src/source-artifact.js';

describe('direct artifact revision target', () => {
  it.each([
    ['修改 a.md，补充部署说明，输出为 b.md', 'a.md', false],
    ['请修改产物 `a.md`，补充说明', 'a.md', true],
    ['@B 修订 "部署 方案.markdown"，保留原文', '部署 方案.markdown', false],
    ['麻烦更新“部署 方案.md”，补充部署说明', '部署 方案.md', false],
    ['改写产物 a.MD，输出新版', 'a.MD', true],
    ['修改产物 项目计划.md，补充说明', '项目计划.md', true],
    ['修改文件.md，补充说明', '文件.md', false],
    ['> 修改 secret.md\n修改 a.md，补充说明', 'a.md', false],
    ['```md\n修改 secret.md\n```\n修改 a.md，补充说明', 'a.md', false],
  ])('recognizes the target of %s', (text, name, explicit) => {
    expect(parseArtifactRequest(text)).toEqual({ name, explicit });
  });

  it.each([
    '我们刚才提到了 a.md，稍后再讨论',
    '请解释如何修改 a.md',
    '不要修改 a.md',
    '> 修改 a.md，补充说明',
    '```\n修改 a.md\n```',
    '~~~md\n修改 a.md\n~~~',
    '~~~md\n修改 a.md\n~~~\n随口提及',
    '    修改 a.md，补充说明',
    '\t修改 a.md，补充说明',
    '这里有个示例：\n修改 a.md',
    '修改 ./a.md，补充说明',
    '修改 docs/a.md，补充说明',
    '修改 C:\\docs\\a.md，补充说明',
    '修改仓库中的 a.md，补充说明',
    '修改工作区 a.md，补充说明',
    '继续',
    '停止',
    '重试 @B',
    '同意修改 a.md',
    '修改 a.txt',
  ])('does not promote incidental, quoted, path or control text: %s', text => {
    expect(parseArtifactRequest(text)).toBeUndefined();
  });
});
