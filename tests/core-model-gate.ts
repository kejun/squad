import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { coreBoundaryCases } from './core-boundary-cases.js';
import { ArtifactReadContract } from './core-artifact-read-fixture.js';

/** Execute the same pure scenario drivers before implementation or wiring external I/O. */
export function verifyCoreModelGate() {
  for (const row of coreBoundaryCases) {
    const driver = row.prepare(); driver.act(); driver.verify();
  }
  for (const [subject, report, code, cost] of [
    ['负责人', '同任务报告', 'ARTIFACT_PAGE', 1],
    ['负责人', '其他任务报告', 'ARTIFACT_UNAVAILABLE', 0],
    ['独立检查', '同任务报告', 'CHECK_LOCAL_TOOLS_NOT_ALLOWED', 0],
  ] as const) {
    const driver = new ArtifactReadContract(subject); driver.read(report); driver.verify(code, cost); driver.verifyUnchanged();
  }
  assert.equal(coreBoundaryCases.length, 77);
  return { verified: 80, scope: 'pure real-XState scenario drivers; no model, network, file or process I/O' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(verifyCoreModelGate()));
