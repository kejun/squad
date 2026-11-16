import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { OpenAICompatibleAdapter, WorkRunner } from '../src/index.js';
import { createTeamConfig } from '../team.config.js';
import { Harness } from './helpers.js';

const answer = '完整方案已给出';

export interface ModelTimeoutReport {
  requests: { model?: string; stream?: boolean; max_tokens?: number }[];
  phase: string;
  retries: number;
  candidate: string | null;
  reason: string;
  stopped: boolean;
  closedBeforeResponse: boolean;
  pendingOwner: boolean;
}

/** Real Node fetch against a local server that withholds headers or the body. */
export class ModelTimeoutFixture {
  readonly requests: ModelTimeoutReport['requests'] = [];
  closedBeforeResponse = false;
  h!: Harness;
  runner!: WorkRunner;
  private server!: Server;
  private responded = false;
  private timer?: ReturnType<typeof setTimeout>;
  private releaseReceived!: () => void;
  readonly received = new Promise<void>(resolve => { this.releaseReceived = resolve; });

  constructor(private readonly options: {
    headerDelayMs?: number; bodyDelayMs?: number; workTimeoutMs?: number;
    headersTimeout?: string; bodyTimeout?: string; invalid?: { key: string; value: string };
  }) {}

  async start(): Promise<this> {
    const payload = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ type: 'answer', text: answer }) } }] });
    this.server = createServer((request, response) => {
      let incoming = '';
      request.on('data', chunk => { incoming += String(chunk); });
      request.socket.on('close', () => {
        if (this.timer) clearTimeout(this.timer);
        if (!response.writableEnded) this.closedBeforeResponse = true;
      });
      request.on('end', () => {
        this.requests.push(JSON.parse(incoming));
        this.releaseReceived();
        const send = () => { this.responded = true; response.end(payload); };
        if ((this.options.headerDelayMs ?? 0) > 0) this.timer = setTimeout(send, this.options.headerDelayMs);
        else if ((this.options.bodyDelayMs ?? 0) > 0) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.flushHeaders();
          this.timer = setTimeout(send, this.options.bodyDelayMs);
        } else send();
      });
    });
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', () => resolve()));
    const address = this.server.address();
    assert(address && typeof address !== 'string');
    const env: Record<string, string> = {
      MODEL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, MODEL_NAME: 'qwen4-max-preview', MODEL_NO_AUTH: 'true',
      SQUAD_INTENT_ANALYSIS_ENABLED: 'false', SQUAD_LOCAL_TOOLS_ENABLED: 'false', SQUAD_WEB_TOOLS_ENABLED: 'false',
      ...(this.options.headersTimeout ? { MODEL_HEADERS_TIMEOUT_MS: this.options.headersTimeout } : {}),
      ...(this.options.bodyTimeout ? { MODEL_BODY_TIMEOUT_MS: this.options.bodyTimeout } : {}),
      ...(this.options.invalid ? { [this.options.invalid.key]: this.options.invalid.value } : {}),
    };
    const config = createTeamConfig(env);
    config.limits.workTimeoutMs = this.options.workTimeoutMs ?? 30_000;
    this.h = new Harness(config);
    this.runner = new WorkRunner(this.h.engine, new OpenAICompatibleAdapter(config, { env, clock: () => this.h.now }), () => this.h.now);
    return this;
  }

  run(): Promise<boolean> { return this.runner.runOne(this.h.room, this.h.task); }

  async stop(): Promise<void> {
    assert(this.h.event({ type: 'STOP' }).ok);
    await this.runner.runOne(this.h.room, this.h.task);
  }

  report(): ModelTimeoutReport {
    const context = this.h.context();
    return {
      requests: this.requests, phase: this.h.view().phase, retries: context.usage.retries,
      candidate: context.candidate?.text ?? null, reason: context.reason, stopped: context.stopped,
      closedBeforeResponse: this.closedBeforeResponse,
      pendingOwner: this.h.engine.pending(this.h.room, this.h.task).some(work => work.kind === 'owner'),
    };
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
