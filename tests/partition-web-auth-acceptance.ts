import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { CloudflareWebTools } from '../src/web-tools.js';
import { WorkRunner } from '../src/runner.js';
import { savedAcquisitions } from '../src/resource-acquisition.js';
import { verifiedReadMethods } from '../src/task/map-scheduling.js';
import { InputIntentFixture, intentConfig } from './input-intent-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';

/** Actual HTTP200 login body through SDK/Runner/adapter/SQLite; no CLI or external service. */
export async function partitionWebAuthenticationAcceptance() {
  const config = intentConfig({ ordinary: 30 }); config.inputAnalysis = { enabled: false };
  config.localTools = { enabled: false }; config.webTools = { enabled: true }; config.skillSearch = { enabled: false };
  const fixture = new InputIntentFixture(config, true), url = 'https://auth.example.com/report';
  const contents = ['已取得的真实原文', '<title>Login</title><input type="password">', '故障之后重新取得的真实原文'];
  let reads = 0; const methodCounts: number[] = [], methodIds: string[] = [];
  const server = createServer((_request, response) => {
    assert(reads < 3); fixture.now += 10;
    response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' }); response.end(contents[reads++]);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address !== 'string');
  try {
    fixture.response = request => {
      assert.equal(request.kind, 'owner');
      const pages = request.messages.filter(message => message.role === 'user').map(message => JSON.parse(message.content) as {
        type?: string; hostEvidence?: { status: string };
      }).filter(message => message.type === 'web_fetch_result');
      if (pages.length) {
        const methods = verifiedReadMethods(fixture.context()); methodCounts.push(methods.length);
        assert.equal(methods.length, pages.length === 2 ? 0 : 1, 'A real newer HTTP200 login observation must invalidate the older method immediately');
        assert.equal(pages.at(-1)!.hostEvidence?.status, pages.length === 2 ? 'authentication_required' : 'acquired');
        if (methods.length) methodIds.push(methods[0]!.id);
      }
      return pages.length < 3 ? modelResponse({ type: 'web_fetch', url }) : modelResponse({ type: 'askUser', question: '已保存原文和重新验证结果，请确认下一步要求' });
    };
    const tools = new CloudflareWebTools({ env: {}, transport: (remote, init) => {
      assert.equal(String(remote), url); return globalThis.fetch(`http://127.0.0.1:${address.port}/report`, init);
    } });
    assert(fixture.submit(`读取${url}`, { goal: { text: `读取${url}`, constraints: [], criteria: ['保留正文来源'], requiredArtifacts: 0,
      resourceRequirements: [{ resource: { kind: 'url', url }, freshness: 'saved' }] } }).ok);
    const runner = new WorkRunner(fixture.engine, fixture.adapter, () => fixture.now, undefined, tools);
    assert(await runner.runOne(fixture.room, fixture.task));
    assert.deepEqual(methodCounts, [1, 0, 1]); assert.notEqual(methodIds[0], methodIds[1]);
    const observations = savedAcquisitions(fixture.context());
    assert.deepEqual(observations.map(receipt => receipt.status), ['acquired', 'authentication_required', 'acquired']);
    assert.deepEqual(observations.map(receipt => receipt.at), [110, 120, 130]);
    assert(observations.every(receipt => receipt.configuration?.version === observations[0]!.configuration?.version));
    fixture.reopen();
    assert.equal(verifiedReadMethods(fixture.context())[0]!.id, methodIds[1]); assert.equal(reads, 3);
    assert.equal(fixture.context().intents.flatMap(work => work.localOperations ?? []).length, 0);
    assert.deepEqual(savedAcquisitions(fixture.context()), observations);
    return { methodCounts, sourceStatuses: observations.map(receipt => receipt.status), generationChanged: true,
      httpRequests: reads, cliOperations: 0, originalObservationsRetained: true, sqliteRecovery: true,
      boundary: 'Real local HTTP/SDK/Runner/adapter/SQLite, controlled provider responses, no external account or OS sandbox claim' };
  } finally {
    fixture.close(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await partitionWebAuthenticationAcceptance()));
