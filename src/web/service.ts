import type { LocalRuntime } from "../local-runtime.js";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { TeamEngine, type Submission } from "../engine.js";
import { assistanceRetryProblem } from "../task.machine.js";
import { retryableAssistance, retryProblemText } from "../assistance-retry.js";
import { OpenAICompatibleAdapter } from "../model-adapter.js";
import { resolveModel } from "../model-config.js";
import {
  WorkFailure,
  WorkRunner,
  type WorkAdapter,
  type WorkScope,
} from "../runner.js";
import { SqliteStore } from "../store.js";
import { DebugJournal } from "./debug-journal.js";
import type { DebugFeed } from "../task-debug.js";
import type { Intent, TeamConfig } from "../types.js";
import type { WebTools } from "../web-tools.js";
import type {
  ExecutionEvent,
  RoomSnapshot,
  WebAgent,
  WebRoom,
  WebTask,
  WebWork,
} from "./contracts.js";

export class WebError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A local host for the existing execution engine. No client-supplied machine events are accepted. */
export class WebService {
  readonly engine: TeamEngine;
  private readonly db: DatabaseSync;
  private readonly store: SqliteStore;
  private readonly adapter: WorkAdapter;
  private readonly runners = new Map<string, WorkRunner>();
  private readonly running = new Map<string, { roomId: string; job: Promise<void> }>();
  private readonly failedRooms = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  private startup: Promise<void> = Promise.resolve();
  private initialized = true;
  private readonly debugJournal: DebugJournal | null;

  constructor(
    readonly config: TeamConfig,
    path: string,
    adapter?: WorkAdapter,
    private readonly webTools?: WebTools,
    readonly debugEnabled = false,
    private readonly localRuntime?: LocalRuntime,
  ) {
    this.store = new SqliteStore(path);
    this.debugJournal = debugEnabled ? new DebugJournal() : null;
    this.engine = new TeamEngine(this.store, config, Date.now,
      this.debugJournal ? (roomId, frame) => this.debugJournal!.append(roomId, frame) : undefined);
    // A second connection keeps Web metadata out of the engine's snapshot/receipt contract.
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_rooms(id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS web_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, roomId TEXT NOT NULL, taskId TEXT NOT NULL,
        workId TEXT NOT NULL, agentId TEXT NOT NULL, at INTEGER NOT NULL,
        kind TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_events_room ON web_events(roomId, id);
    `);
    this.adapter =
      adapter ??
      (config.models
        ? new OpenAICompatibleAdapter(config)
        : {
            execute: async () => {
              throw new WorkFailure("请先在 .env 配置模型服务，然后重启应用。");
            },
          });
    if (localRuntime) {
      this.initialized = false;
      this.startup = this.recoverLocal().then(() => {
        this.initialized = true;
        for (const room of this.rooms()) this.kick(room.id);
      });
    } else for (const room of this.rooms()) { this.engine.recover(room.id); this.kick(room.id); }
    this.timer = setInterval(() => {
      if (this.closing || !this.initialized) return;
      for (const room of this.rooms()) {
        const wake = this.engine.nextWake(room.id);
        if (wake !== null && wake <= Date.now()) this.engine.tick(room.id);
        this.kick(room.id);
      }
    }, 1000);
    this.timer.unref();
  }

  async ready(): Promise<void> { await this.startup; }
  private async recoverLocal(): Promise<void> {
    const rooms = this.rooms();
    for (const room of rooms) this.engine.recover(room.id);
    for (const room of rooms) {
      for (const taskId of Object.keys(this.store.read(room.id).tasks)) {
        const context = this.engine.view(room.id, taskId)!.context;
        for (const work of context.intents) for (const op of work.localOperations ?? []) {
          if (op.status !== 'uncertain' || !op.sessionId) continue;
          const reconciliation = await this.localRuntime!.reconcile(op);
          if (reconciliation) {
            const reply = this.engine.send(room.id, taskId, { type: 'LOCAL_RECONCILE', id: `startup-local:${randomUUID()}`, at: Date.now(),
              intentId: work.id, operationId: op.id, sessionId: op.sessionId, ...reconciliation });
            if (reply.ok) this.append(room.id, work, 'tool-result', '已核对本地操作回执', JSON.stringify({ operationId: op.id, ...reconciliation }));
          } else this.append(room.id, work, 'error', '本地操作等待核对', JSON.stringify({ operationId: op.id, sessionId: op.sessionId, status: 'uncertain' }));
        }
        // Projection from committed child receipts also fills a crash between DB commit and UI append.
        const latest = this.engine.view(room.id, taskId)!.context;
        for (const work of latest.intents) for (const op of work.localOperations ?? []) {
          if (!op.result || !['succeeded', 'failed', 'cancelled'].includes(op.status)) continue;
          const shown = this.db.prepare("SELECT 1 FROM web_events WHERE roomId=? AND workId=? AND kind='tool-result' AND instr(detail,?)>0 LIMIT 1").get(room.id, work.id, op.id);
          if (!shown) this.append(room.id, work, 'tool-result', '本地操作持久回执', JSON.stringify({ operationId: op.id, ...op.result }));
        }
      }
    }
  }
  rooms(): WebRoom[] {
    return this.db
      .prepare(
        "SELECT id, title, createdAt FROM web_rooms ORDER BY createdAt, rowid",
      )
      .all() as unknown as WebRoom[];
  }
  createRoom(title = "新的群聊"): WebRoom {
    const room = {
      id: randomUUID(),
      title: title.trim().slice(0, 80) || "新的群聊",
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO web_rooms(id, title, createdAt) VALUES(?, ?, ?)")
      .run(room.id, room.title, room.createdAt);
    return room;
  }
  private room(id: string): WebRoom {
    const room = this.rooms().find((room) => room.id === id);
    if (!room) throw new WebError(404, "找不到这个群聊。");
    return room;
  }
  snapshot(roomId: string): RoomSnapshot {
    const room = this.room(roomId);
    const stored = this.store.read(roomId);
    const tasks: WebTask[] = [];
    const works: WebWork[] = [];
    const agents: WebAgent[] = this.config.bots.map((bot) => ({
      id: bot.id,
      name: bot.name,
      instructions: bot.instructions,
      tools: bot.tools,
      model: resolveModel(this.config, "owner", bot.id)?.service.model ?? null,
    }));
    for (const taskId of Object.keys(stored.tasks)) {
      const { phase, context: c } = this.engine.view(roomId, taskId)!;
      tasks.push({
        id: taskId,
        goal: c.goal.text,
        owner: c.owner,
        phase,
        outcome: c.outcome,
        reason: c.reason,
        usage: { ordinary: c.usage.ordinary, checks: c.usage.checks },
        limits: {
          ordinary: c.config.limits.ordinary,
          checks: c.config.limits.checks,
        },
        artifacts: c.artifacts,
        board: c.board,
        trace: c.trace,
        ...(c.inputAnalyses ? { inputAnalyses: c.inputAnalyses } : {}),
        assists: c.assists.filter(retryableAssistance).map((help) => {
          const problem = stored.activeTaskId && stored.activeTaskId !== taskId
            ? "ROOM_BUSY" : assistanceRetryProblem(c, help.id, this.config);
          return { id: help.id, taskId, target: help.target, retryable: problem === null,
            reason: problem ? retryProblemText(problem) : "" };
        }),
        ...(c.review
          ? {
              review: {
                targets: c.review.targets,
                completed: c.review.completed,
                status: c.review.status,
              },
            }
          : {}),
      });
      for (const bot of c.config.bots) {
        if (!agents.some((agent) => agent.id === bot.id))
          agents.push({ ...bot, model: null, retired: true });
      }
      for (const i of c.intents) {
        works.push({
          id: i.id,
          agentId: i.target,
          taskId,
          kind: i.kind,
          status: i.status,
          attempt: i.attempt,
          requestCount: i.requestCount,
          model: i.model?.service.model ?? null,
          reason:
            i.kind === "assistance"
              ? String(i.payload.question ?? "")
              : i.kind === "check"
                ? "核对交付是否符合任务要求"
                : String(i.payload.reason ?? i.payload.plan ?? c.goal.text),
          epoch: i.epoch,
        });
      }
      for (const work of c.intents) for (const op of work.localOperations ?? []) {
        if (op.action.type !== 'verifyWorkspace' || !op.result) continue;
        const shown = this.db.prepare("SELECT 1 FROM web_events WHERE roomId=? AND workId=? AND kind='tool-result' AND instr(detail,?)>0 LIMIT 1").get(roomId, work.id, op.id);
        if (!shown) this.append(roomId, work, 'tool-result', '工程版本复核', JSON.stringify({ operationId: op.id, ...op.result }));
      }
    }
    const events = this.db
      .prepare(
        "SELECT id, taskId, workId, agentId, at, kind, title, detail FROM web_events WHERE roomId = ? ORDER BY id",
      )
      .all(roomId) as unknown as ExecutionEvent[];
    return {
      room,
      agents,
      tasks,
      works,
      events,
      messages: this.engine.timeline(roomId),
      activeTaskId: stored.activeTaskId,
      modelConfigured: !!this.config.models,
      serverTime: Date.now(),
    };
  }
  debugSnapshot(roomId: string, after = 0, sessionId?: string, taskId?: string): DebugFeed {
    if (!this.debugJournal) throw new WebError(404, "调试未开启。");
    this.room(roomId);
    const room = this.store.read(roomId);
    const tasks = Object.keys(room.tasks).map(id => ({ id, phase: this.engine.view(roomId, id)!.phase }));
    const id = taskId ?? room.activeTaskId ?? tasks.at(-1)?.id;
    if (taskId && !room.tasks[taskId]) throw new WebError(404, "找不到这个任务。");
    const stored = id ? room.tasks[id] as { snapshot: unknown } : undefined;
    return { ...this.debugJournal.read(roomId, after, sessionId), tasks,
      current: id && stored ? { taskId: id, snapshot: structuredClone(stored.snapshot) } : null };
  }
  submit(roomId: string, input: Submission) {
    this.room(roomId);
    if (!this.initialized) throw new WebError(503, "本地执行会话正在恢复，请稍后重试。");
    if (
      !input.id ||
      input.id.length > 120 ||
      !input.text.trim() ||
      input.text.length > 32_000
    )
      throw new WebError(400, "请输入 1–32000 字的消息。");
    if (
      input.mentions?.some(
        (id) => !this.config.bots.some((bot) => bot.id === id),
      )
    )
      throw new WebError(400, "点名的成员不存在。");
    const first = this.engine.timeline(roomId).length === 0;
    const result = this.engine.submit(roomId, input);
    if (!result.ok) throw new WebError(409, result.detail);
    if (result.taskId && this.engine.view(roomId, result.taskId)?.context.stopped) {
      void this.drainCancellation(roomId, result.taskId).catch(error => this.hostError(roomId, error));
    }
    if (first) {
      const title =
        input.text
          .replace(/@[\w-]+\s*/g, "")
          .trim()
          .slice(0, 24) || "新的群聊";
      this.db
        .prepare("UPDATE web_rooms SET title = ? WHERE id = ?")
        .run(title, roomId);
    }
    this.kick(roomId);
    return result;
  }
  stop(roomId: string, taskId: string, commandId: string) {
    this.room(roomId);
    const result = this.engine.send(roomId, taskId, {
      type: "STOP",
      id: commandId,
      at: Date.now(),
    });
    if (!result.ok) throw new WebError(409, result.detail);
    // Cancellation must be dispatched while execute() is still awaiting the model.
    void this.drainCancellation(roomId, taskId).catch((error) =>
      this.hostError(roomId, error),
    );
    return result;
  }
  private async drainCancellation(roomId: string, taskId: string) {
    const runner = this.runner(roomId);
    while (this.engine.pending(roomId, taskId).some((i) => i.kind === "cancel"))
      await runner.runOne(roomId, taskId);
  }
  private append(
    roomId: string,
    work: Intent,
    kind: ExecutionEvent["kind"],
    title: string,
    detail: string,
  ) {
    // Never serialize service bindings, headers, environment variables or provider secrets.
    for (const service of Object.values(this.config.models?.services ?? {})) {
      const key = service.apiKeyEnv
        ? process.env[service.apiKeyEnv]
        : undefined;
      if (key) detail = detail.replaceAll(key, "[redacted]");
    }
    const taskId = work.id.slice(0, work.id.lastIndexOf(":E"));
    this.db
      .prepare(
        "INSERT INTO web_events(roomId, taskId, workId, agentId, at, kind, title, detail) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        roomId,
        taskId,
        work.id,
        work.target,
        Date.now(),
        kind,
        title,
        detail.slice(0, 64_000),
      );
  }
  private runner(roomId: string): WorkRunner {
    let runner = this.runners.get(roomId);
    if (runner) return runner;
    const observed: WorkAdapter = {
      execute: async (work, signal, scope) => {
        this.append(
          roomId,
          work,
          "started",
          work.kind === "interpretation" ? "开始理解输入" : work.kind === "check" ? "开始检查交付" : "开始执行",
          String(
            work.payload.question ??
              work.payload.reason ??
              (work.payload.goal as { text?: string } | undefined)?.text ??
              "",
          ),
        );
        const tracedScope: WorkScope = {
          sessionId: roomId,
          ...(scope.localTools ? { localTools: {
            catalog: scope.localTools.catalog, checkpoint: scope.localTools.checkpoint,
            invoke: async (action, messages, toolSignal) => {
              const labels = { listSkills: "查看本地技能", loadSkill: "激活本地技能", readSkillResource: "读取技能资源", runCli: "执行本地命令", verifyWorkspace: "核对工程版本" };
              this.append(roomId, work, "tool-start", labels[action.type], JSON.stringify(this.localRuntime!.clean(action)));
              const result = await scope.localTools!.invoke(action, messages, toolSignal);
              this.append(roomId, work, "tool-result", action.type === "runCli" ? "本地命令结束" : "本地技能操作完成", JSON.stringify({ operationId: this.engine.view(roomId)!.context.intents.find(w => w.id === work.id)?.localOperations?.at(-1)?.id, ...result }));
              return result;
            },
            resume: async (operationId, toolSignal) => {
              this.append(roomId, work, "tool-start", "续办本地操作", operationId);
              const result = await scope.localTools!.resume(operationId, toolSignal);
              this.append(roomId, work, "tool-result", "已读取本地操作回执", JSON.stringify({ operationId: this.engine.view(roomId)!.context.intents.find(w => w.id === work.id)?.localOperations?.at(-1)?.id, ...result }));
              return result;
            },
          } satisfies NonNullable<WorkScope["localTools"]> } : {}),
          regenerateModelOutput: (issue) => {
            if (!scope.regenerateModelOutput) throw new Error('Model output repair authorization unavailable');
            scope.regenerateModelOutput(issue);
            this.append(roomId, work, "error", "模型输出格式不合规，重新生成", issue);
          },
          authorizeAdditionalRequest: (id) => {
            scope.authorizeAdditionalRequest(id);
            this.append(roomId, work, "request", "发起后续请求", id);
          },
          findSkills: async (query, toolSignal) => {
            this.append(roomId, work, "tool-start", "搜索技能", query);
            try {
              const skills = await scope.findSkills(query, toolSignal);
              this.append(
                roomId,
                work,
                "tool-result",
                "技能搜索完成",
                JSON.stringify(skills, null, 2),
              );
              return skills;
            } catch (error) {
              this.append(roomId, work, "error", "技能搜索失败", String(error));
              throw error;
            }
          },
          webSearch: async (input, toolSignal) => {
            this.append(roomId, work, "tool-start", "搜索网页", input.query);
            try {
              const result = await scope.webSearch(input, toolSignal);
              this.append(roomId, work, "tool-result", "网页搜索完成", result.text);
              return result;
            } catch (error) {
              this.append(roomId, work, "error", "网页搜索失败", String(error));
              throw error;
            }
          },
          webFetch: async (input, toolSignal) => {
            this.append(roomId, work, "tool-start", "读取网页", input.url);
            try {
              const result = await scope.webFetch(input, toolSignal);
              this.append(roomId, work, "tool-result", "网页读取完成", result.text);
              return result;
            } catch (error) {
              this.append(roomId, work, "error", "网页读取失败", String(error));
              throw error;
            }
          },
        };
        try {
          const output = await this.adapter.execute(work, signal, tracedScope);
          this.append(
            roomId,
            work,
            signal.aborted ? "cancelled" : "output",
            signal.aborted ? "执行已取消" : work.kind === "interpretation" ? "输入理解完成" : "返回执行结果",
            JSON.stringify(output, null, 2),
          );
          return output;
        } catch (error) {
          this.append(
            roomId,
            work,
            signal.aborted ? "cancelled" : "error",
            signal.aborted ? "执行已取消" : "执行失败",
            String(error),
          );
          throw error;
        }
      },
      cancel: async (work) => {
        await this.adapter.cancel?.(work);
      },
    };
    runner = new WorkRunner(this.engine, observed, Date.now, globalThis.fetch, this.webTools, this.localRuntime);
    this.runners.set(roomId, runner);
    return runner;
  }
  private hostError(roomId: string, error: unknown) {
    this.failedRooms.add(roomId);
    console.error(
      `Web host failure in room ${roomId}:`,
      error instanceof Error ? error.name : "Unknown error",
    );
    // Surface unexpected host failures instead of leaving a task looking healthy.
    const view = this.engine.view(roomId);
    if (view) {
      try {
        this.engine.send(roomId, view.context.taskId, {
          type: "WAIT_USER",
          id: randomUUID(),
          at: Date.now(),
          question: "执行服务发生错误，请重启服务后查看任务状态。",
        });
      } catch {
        /* A storage fault must not trigger another external request. */
      }
    }
  }
  private kick(roomId: string) {
    if (this.closing || !this.initialized || this.failedRooms.has(roomId)) return;
    const taskId = this.store.read(roomId).activeTaskId;
    if (!taskId) return;
    while (this.engine.flushResults(roomId, taskId)) { /* Consume durable handoffs before projecting successors. */ }
    for (const work of this.engine.pending(roomId, taskId)) {
      const key = `${roomId}:${work.id}`;
      if (this.running.has(key)) continue;
      let progressed = false;
      // The machine supplies eligibility; the transactional claim still checks every lock and budget.
      const job = Promise.resolve()
        .then(() => this.closing ? false : this.runner(roomId).runOne(roomId, taskId, work.id))
        .then(value => { progressed = value; })
        .catch((error) => this.hostError(roomId, error))
        .finally(() => {
          this.running.delete(key);
          if (progressed) this.kick(roomId);
        });
      this.running.set(key, { roomId, job });
    }
  }
  async close() {
    this.closing = true;
    await this.startup;
    clearInterval(this.timer);
    for (const roomId of new Set([...this.running.values()].map(work => work.roomId))) {
      const taskId = this.store.read(roomId).activeTaskId;
      if (taskId) {
        this.engine.send(roomId, taskId, {
          type: "STOP",
          id: randomUUID(),
          at: Date.now(),
        });
        await this.drainCancellation(roomId, taskId);
      }
    }
    await Promise.all([...this.running.values()].map(work => work.job));
    this.db.close();
    this.store.close();
  }
}
