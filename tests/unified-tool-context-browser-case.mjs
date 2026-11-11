import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRuntime } from '../src/local-runtime.ts';
import { OpenAICompatibleAdapter } from '../src/model-adapter.ts';
import { localConfig } from './local-tools-fixture.ts';
import { fixtureCheck, withFixtureAcceptance } from './delivery-protocol-fixture.ts';
import { modelResponse } from './model-regeneration-fixture.ts';
import { ResilientWorkspaceBrowserFixture } from './resilient-workspace-browser-fixture.mjs';

/** A controlled model selects from the actual merged inventory. Every UI action,
 * HTTP request, SQLite commit, approval and host process uses production wiring. */
export async function directHostInventoryBrowserAcceptance() {
  const directory = await mkdtemp(join(tmpdir(), 'squad-unified-host-ui-'));
  const source = join(directory, 'source'), bin = join(directory, 'bin');
  await mkdir(source); await mkdir(bin);
  const executable = join(bin, 'squad-private-reader'), marker = join(source, 'host-started.txt');
  await writeFile(executable, '#!/usr/bin/env node\nconst fs=require("node:fs");fs.appendFileSync("host-started.txt","once\\n");console.log("真实宿主读取工具回执");\n', { mode: 0o755 });
  let sandboxCalls = 0;
  const runtime = await LocalRuntime.create({ dataRoot: join(directory, 'runtime'), workspaceRoot: source, skillRoots: [],
    catalogRefreshIntervalMs: 0, commandEnv: { 'squad-private-reader': { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` } },
    cliCatalog: [{ command: 'squad-private-reader', description: '读取需要服务账号现有登录态的私有资料', execution: 'host',
      requirements: ['Only the host service account can supply the configured login'], examples: [{ description: '返回读取工具实际运行结果', args: ['get', 'fixture-resource'] }] }],
    backend: { available: true, async execute() { sandboxCalls++; throw new Error('A direct host choice must not create a sandbox attempt'); } } });
  const config = localConfig(); config.limits.workTimeoutMs = 60_000; config.limits.progressIntervalMs = 60_000;
  const requests = [];
  const adapter = new OpenAICompatibleAdapter(config, { transport: async (_url, init) => {
    const request = JSON.parse(String(init?.body)); requests.push(request);
    const inventoryMessage = request.messages.find(message => message.content.startsWith('{"type":"tool_inventory",'));
    assert(inventoryMessage, 'The initial real model request must contain the unified inventory');
    const inventory = JSON.parse(inventoryMessage.content);
    const reader = inventory.cli.entries.find(entry => entry.command === 'squad-private-reader');
    assert(reader); assert.equal(reader.execution, 'host');
    assert(reader.variants.some(variant => variant.execution === 'host' && variant.approvalRequired));
    const receipt = request.messages.find(message => message.content.startsWith('{"type":"local_tool_result",'));
    if (!receipt) return modelResponse({ type: 'runCli', executable: reader.command, args: ['get', 'fixture-resource'],
      execution: 'host', reason: '目录明确此工具需要宿主服务账号；申请本次具体读取调用' });
    assert.equal(JSON.parse(receipt.content).ok, true);
    return modelResponse(withFixtureAcceptance({ type: 'answer', text: '读取工具已执行，真实回执：真实宿主读取工具回执。' }, request));
  } });
  const browser = new ResilientWorkspaceBrowserFixture('BT_Y122', { config, localRuntime: runtime,
    adapter: { execute: (work, signal, scope) => work.kind === 'check' ? Promise.resolve(fixtureCheck(work.payload.candidate))
      : adapter.execute(work, signal, scope) } });
  try {
    await browser.open(); const room = await browser.createRoom();
    await browser.send('请使用已接入的私有资料读取工具，返回其真实运行回执。');
    const approval = await browser.until(() => browser.service.snapshot(room.id).hostApprovals, list => list?.length === 1, 'direct host approval');
    const pending = approval[0];
    assert.equal(requests.length, 1); assert.equal(sandboxCalls, 0); assert(!existsSync(marker));
    const context = () => browser.service.engine.view(room.id, pending.taskId).context;
    const operations = () => context().intents.flatMap(work => work.localOperations ?? []);
    assert.equal(operations().length, 1); assert.equal(operations()[0].status, 'awaitingApproval');
    const dialog = browser.page.getByRole('dialog', { name: '请求在宿主执行命令', exact: true });
    await dialog.waitFor();
    assert((await dialog.getByLabel('请求执行的完整命令').textContent()).includes('squad-private-reader'));
    await browser.capture('direct-host-before-approval');
    await dialog.getByRole('button', { name: '允许本次', exact: true }).click();
    await browser.until(() => operations()[0], operation => operation.status === 'succeeded', 'one approved host process');
    await browser.page.getByText('读取工具已执行，真实回执：真实宿主读取工具回执。', { exact: false }).first().waitFor();
    assert.equal(await readFile(marker, 'utf8'), 'once\n'); assert.equal(sandboxCalls, 0);
    assert.equal(operations().length, 1); assert.equal(operations()[0].result.data.execution, 'host');
    const approvals = browser.posts.filter(post => post.path.endsWith('/host-approval'));
    assert.equal(approvals.length, 1); assert.equal(approvals[0].body.operationId, pending.operationId);
    assert.equal(approvals[0].body.decision, 'approve');
    assert.equal(requests.length, 2);
    await browser.capture('direct-host-approved-result');
    browser.completed.push('BT_Y122');
    return { evidence: browser.evidence, sandboxCalls, executions: 1, modelRequests: requests.length, approvalPosts: approvals.length };
  } catch (error) { browser.failed = true; browser.failureReason = String(error); throw error; }
  finally { await browser.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
}
