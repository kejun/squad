import assert from 'node:assert/strict';
import { parseArtifactRequest } from '../src/source-artifact.js';
export const sourceRequestExamples = [
  {
    "text": "修改 a.md，补充部署说明，输出为 b.md",
    "name": "a.md",
    "explicit": false
  },
  {
    "text": "请修改产物 `a.md`，补充说明",
    "name": "a.md",
    "explicit": true
  },
  {
    "text": "@B 修订 \"部署 方案.markdown\"，保留原文",
    "name": "部署 方案.markdown",
    "explicit": false
  },
  {
    "text": "麻烦更新“部署 方案.md”，补充部署说明",
    "name": "部署 方案.md",
    "explicit": false
  },
  {
    "text": "改写产物 a.MD，输出新版",
    "name": "a.MD",
    "explicit": true
  },
  {
    "text": "修改产物 项目计划.md，补充说明",
    "name": "项目计划.md",
    "explicit": true
  },
  {
    "text": "修改文件.md，补充说明",
    "name": "文件.md",
    "explicit": false
  },
  {
    "text": "> 修改 secret.md\n修改 a.md，补充说明",
    "name": "a.md",
    "explicit": false
  },
  {
    "text": "```md\n修改 secret.md\n```\n修改 a.md，补充说明",
    "name": "a.md",
    "explicit": false
  },
  {
    "text": "我们刚才提到了 a.md，稍后再讨论",
    "name": "无",
    "explicit": false
  },
  {
    "text": "请解释如何修改 a.md",
    "name": "无",
    "explicit": false
  },
  {
    "text": "不要修改 a.md",
    "name": "无",
    "explicit": false
  },
  {
    "text": "> 修改 a.md，补充说明",
    "name": "无",
    "explicit": false
  },
  {
    "text": "```\n修改 a.md\n```",
    "name": "无",
    "explicit": false
  },
  {
    "text": "~~~md\n修改 a.md\n~~~",
    "name": "无",
    "explicit": false
  },
  {
    "text": "~~~md\n修改 a.md\n~~~\n随口提及",
    "name": "无",
    "explicit": false
  },
  {
    "text": "    修改 a.md，补充说明",
    "name": "无",
    "explicit": false
  },
  {
    "text": "\t修改 a.md，补充说明",
    "name": "无",
    "explicit": false
  },
  {
    "text": "这里有个示例：\n修改 a.md",
    "name": "无",
    "explicit": false
  },
  {
    "text": "修改 ./a.md，补充说明",
    "name": "无",
    "explicit": false
  },
  {
    "text": "修改 docs/a.md，补充说明",
    "name": "无",
    "explicit": false
  },
  {
    "text": "修改 C:\\docs\\a.md，补充说明",
    "name": "无",
    "explicit": false
  },
  {
    "text": "修改仓库中的 a.md，补充说明",
    "name": "无",
    "explicit": false
  },
  {
    "text": "修改工作区 a.md，补充说明",
    "name": "无",
    "explicit": false
  },
  {
    "text": "继续",
    "name": "无",
    "explicit": false
  },
  {
    "text": "停止",
    "name": "无",
    "explicit": false
  },
  {
    "text": "重试 @B",
    "name": "无",
    "explicit": false
  },
  {
    "text": "同意修改 a.md",
    "name": "无",
    "explicit": false
  },
  {
    "text": "修改 a.txt",
    "name": "无",
    "explicit": false
  }
] as const;
export function readRevisionDirective(text: string) { return parseArtifactRequest(text); }
export function verifyRevisionDirective(actual: ReturnType<typeof parseArtifactRequest>, name: string, explicit: boolean) {
  if (name === '无') assert.equal(actual, undefined);
  else assert.deepEqual(actual, { name, explicit });
}
export function runSourceRequestGate() { for (const row of sourceRequestExamples) verifyRevisionDirective(readRevisionDirective(row.text), row.name, row.explicit); return sourceRequestExamples.length; }
