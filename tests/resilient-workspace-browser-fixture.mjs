import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createTeamConfig } from '../team.config.ts';
import { WebService } from '../src/web/service.ts';
import { createWebServer } from '../src/web/http.ts';
import { fixtureCheck } from './delivery-protocol-fixture.ts';
import { captureSource, verifyBuild } from '../.agents/skills/verify-squad/scripts/build-proof.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');

function browserModule() {
  const candidates = [process.env.SQUAD_PLAYWRIGHT_MODULE,
    process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES && join(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES, 'playwright/index.mjs'),
    '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs'];
  const local = candidates.find(value => value && existsSync(value));
  if (local) return pathToFileURL(local).href;
  return pathToFileURL(createRequire(import.meta.url).resolve('playwright')).href;
}

export function barrier() {
  let release;
  const promise = new Promise(resolvePromise => { release = resolvePromise; });
  return { promise, release };
}

/** Actual Chromium -> HTTP -> WebService/Engine/SQLite. The supplied adapter is
 * the controlled external model boundary. No application API response is faked. */
export class ResilientWorkspaceBrowserFixture {
  constructor(scenario, options = {}) {
    this.scenario = scenario;
    this.options = options;
    this.posts = [];
    this.consoleErrors = [];
    this.pageErrors = [];
    this.completed = [];
    this.gates = [];
    this.closed = false;
    this.modelCalls = [];
    this.network = [];
    this.serviceRestarts = [];
  }

  async open() {
    this.build = verifyBuild(root);
    this.source = captureSource(root);
    this.evidence = resolve(this.options.evidence ?? join(root, 'reports/resilient-workspace-ui', `${Date.now()}-${process.pid}-${this.scenario}`));
    assert(!existsSync(this.evidence), 'Every browser run retains its own evidence');
    await mkdir(this.evidence, { recursive: true });
    this.directory = await mkdtemp(join(tmpdir(), 'squad-resilient-ui-'));
    this.database = join(this.directory, 'team.sqlite');
    const config = this.options.config ?? createTeamConfig({});
    config.inputAnalysis = { enabled: false };
    const implementation = this.options.adapter ?? { execute: async work => {
      return work.kind === 'check' ? fixtureCheck(work.payload.candidate)
        : { type: 'deliver', text: '浏览器夹具的可核对成果', artifactIds: [], artifacts: [{ name: 'source.md', content: '浏览器夹具的可核对成果' }] };
    } };
    const adapter = { ...implementation, execute: async (work, ...args) => {
      this.modelCalls.push({ kind: work.kind, id: work.id, attempt: work.attempt });
      return implementation.execute(work, ...args);
    } };
    this.config = config; this.adapter = adapter;
    this.service = new WebService(config, this.database, adapter, undefined, true, this.options.localRuntime);
    await this.service.ready();
    this.server = createWebServer(this.service, join(root, 'dist/web'));
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    const { chromium } = await import(browserModule());
    const executablePath = process.env.SQUAD_CHROMIUM ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    this.browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    this.context = await this.browser.newContext({ viewport: { width: 1440, height: 980 }, acceptDownloads: true });
    await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(8000);
    this.page.on('console', message => { if (message.type() === 'error') this.consoleErrors.push(message.text()); });
    this.page.on('pageerror', error => { this.pageErrors.push(String(error)); this.consoleErrors.push(String(error)); });
    this.page.on('request', request => {
      if (request.method() === 'POST' && request.url().startsWith(this.url + '/api/'))
        this.posts.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
    });
    this.page.on('response', response => {
      if (!response.url().startsWith(this.url + '/api/')) return;
      const capture = response.body().then(body => this.log('http-response', { path: new URL(response.url()).pathname,
        status: response.status(), sha256: sha(body), bytes: body.length })).catch(error =>
        this.log('http-response-unreadable', { path: new URL(response.url()).pathname, error: String(error) }));
      this.network.push(capture);
    });
    await this.page.route('https://fonts.googleapis.com/**', route => route.abort());
    await this.page.route('https://fonts.gstatic.com/**', route => route.abort());
    await this.page.goto(this.url);
    await this.page.getByRole('button', { name: '新建群聊', exact: false }).waitFor();
    await this.log('opened', { chromium: this.browser.version(), source: this.source.source, modelBoundary: 'controlled adapter' });
    return this;
  }

  async log(action, detail = {}) {
    await appendFile(join(this.evidence, 'actions.jsonl'), JSON.stringify({ at: Date.now(), action, ...detail }) + '\n');
  }

  async get(path) {
    const response = await fetch(this.url + '/api' + path, { signal: AbortSignal.timeout(8000) });
    return { status: response.status, data: await response.json() };
  }

  async until(read, accepts, label) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const value = await read();
      if (accepts(value)) return value;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    assert.fail(`Browser fixture did not reach ${label}`);
  }

  async createRoom() {
    const before = (await this.get('/rooms')).data.rooms;
    await this.page.getByRole('button', { name: '新建群聊', exact: false }).click();
    const result = await this.until(() => this.get('/rooms'), value => value.data.rooms.length === before.length + 1, 'new room persisted');
    const room = result.data.rooms.find(item => !before.some(previous => previous.id === item.id));
    await this.until(() => this.page.evaluate(() => localStorage.getItem('squad-room')), value => value === room.id, 'new room selected');
    return room;
  }

  async send(text) {
    const input = this.page.getByRole('textbox', { name: '群聊消息输入框' });
    await input.fill(text);
    await this.page.getByRole('button', { name: '发送消息', exact: true }).click();
  }

  async selectRoom(room, archived = false) {
    if (archived) await this.page.getByRole('button', { name: /^已归档/ }).click();
    const current = (await this.get('/rooms/' + encodeURIComponent(room.id))).data.room;
    await this.page.getByRole('navigation', { name: archived ? '归档群聊列表' : '群聊列表', exact: true })
      .getByRole('button', { name: current.title, exact: true }).click();
    await this.page.getByRole('heading', { name: current.title, exact: true, includeHidden: true }).waitFor();
  }

  async capture(name) {
    await this.page.evaluate(() => document.fonts.ready);
    await this.page.screenshot({ path: join(this.evidence, name + '.png'), fullPage: true });
    await writeFile(join(this.evidence, name + '.aria.txt'), await this.page.locator('body').ariaSnapshot());
    const cdp = await this.context.newCDPSession(this.page);
    try {
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const document = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '.message-text, .welcome h2, h1' });
      assert(nodeId, 'Capture must include a visible Chinese product label');
      const fonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      await writeFile(join(this.evidence, name + '.fonts.json'), JSON.stringify(fonts, null, 2));
      assert(fonts.fonts.some(font => font.glyphCount > 0 && /Noto Sans CJK|WenQuanYi|Microsoft YaHei|PingFang|Source Han|Droid Sans Fallback/i.test(font.familyName)), 'Capture must use actual Chinese font glyphs');
    } finally { await cdp.detach(); }
  }

  async download(button, name) {
    const pending = this.page.waitForEvent('download');
    await button.click();
    const download = await pending;
    const path = join(this.evidence, name);
    await download.saveAs(path);
    const content = await readFile(path, 'utf8');
    await this.log('download', { suggested: download.suggestedFilename(), file: name, sha256: sha(content) });
    return content;
  }

  /** Hold an actual response after the server has handled it. Releasing preserves
   * its exact status/body; this helper never creates a successful API response. */
  async holdResponse(pattern, accepts = () => true) {
    const entered = barrier(), release = barrier(), completed = barrier();
    let held = false;
    const handler = async route => {
      if (!accepts(route.request())) return route.continue();
      const response = await route.fetch();
      const body = await response.body();
      held = true;
      entered.release({ status: response.status(), body: body.toString('utf8') });
      await release.promise;
      try { await route.fulfill({ response, body }); } finally { completed.release(); }
    };
    await this.page.route(pattern, handler);
    const gate = { entered: entered.promise, release: async () => {
      release.release(); await this.page.unroute(pattern, handler); if (held) await completed.promise;
    } };
    this.gates.push(gate);
    return gate;
  }

  readDatabase() {
    const database = new DatabaseSync(this.database, { readOnly: true });
    try {
      return { rooms: database.prepare('SELECT id,data FROM rooms ORDER BY id').all(),
        webRooms: database.prepare('SELECT * FROM web_rooms ORDER BY id').all(),
        events: database.prepare('SELECT roomId,taskId,kind,title,detail FROM web_events ORDER BY id').all(),
        receipts: database.prepare('SELECT room_id,id FROM receipts ORDER BY room_id,id').all() };
    } finally { database.close(); }
  }

  async restartService() {
    assert.deepEqual(verifyBuild(root), this.build, 'Restart must serve the same verified production bundle');
    const port = this.server.address().port;
    this.server.close(); await once(this.server, 'close');
    await this.service.close();
    if (this.options.reopenLocalRuntime) {
      await this.options.localRuntime?.close();
      this.options.localRuntime = await this.options.reopenLocalRuntime();
    }
    this.service = new WebService(this.config, this.database, this.adapter, undefined, true, this.options.localRuntime);
    await this.service.ready();
    this.server = createWebServer(this.service, join(root, 'dist/web'));
    this.server.listen(port, '127.0.0.1'); await once(this.server, 'listening');
    const proof = { at: Date.now(), sameDatabase: this.database, samePort: port,
      oldServiceClosed: true, newServiceReady: true, runtimeReopened: !!this.options.reopenLocalRuntime };
    this.serviceRestarts.push(proof); await this.log('service-restarted', proof);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const cleanup = {};
    let verified = false;
    try {
      for (const gate of this.gates) await gate.release().catch(() => {});
      if (this.context) await this.context.tracing.stop({ path: join(this.evidence, 'trace.zip') });
      await this.browser?.close(); cleanup.browserClosed = true;
      await Promise.allSettled(this.network);
      if (this.server?.listening) { this.server.close(); await once(this.server, 'close'); }
      await this.service?.close(); cleanup.serviceClosed = true;
      await this.options.localRuntime?.close(); cleanup.runtimeClosed = true;
      if (this.directory) await rm(this.directory, { recursive: true, force: true }); cleanup.temporaryStateRemoved = true;
      if (this.source) assert.deepEqual(captureSource(root), this.source, 'Source changed during browser run; rebuild and repeat');
      assert.equal(this.pageErrors.length, 0, 'Browser must not report an unhandled application error');
      verified = true;
    } finally {
      if (this.evidence) await writeFile(join(this.evidence, 'run.json'), JSON.stringify({
        status: verified && !this.failed && this.completed.includes(this.scenario) && Object.values(cleanup).every(Boolean) ? 'verified' : 'incomplete',
        scenario: this.scenario, completed: this.completed, source: this.source, build: this.build,
        posts: this.posts, modelCalls: this.modelCalls, consoleErrors: this.consoleErrors, pageErrors: this.pageErrors, cleanup,
        serviceRestarts: this.serviceRestarts,
        ...(this.failureReason ? { failureReason: this.failureReason } : {}),
      }, null, 2) + '\n');
    }
  }
}
