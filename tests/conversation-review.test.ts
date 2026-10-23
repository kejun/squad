import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryStore,
  SqliteStore,
  TeamEngine,
  WorkRunner,
  OpenAICompatibleAdapter,
  WorkFailure,
  type Intent,
  type Message,
  type Store,
  type TeamConfig,
  type WorkAdapter,
} from "../src/index.js";
import {
  conversationHistory,
  requestedReviewTargets,
} from "../src/conversation.js";
import { configuration } from "./helpers.js";

const plan =
  "ESP32 墨水屏同步方案：代理服务读取飞书文档，按块计算增量，设备局部刷新。";
const reviewers = ["B", "builder-1", "builder-2", "builder-3"];
let sequence = 0;
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
});
function seed(engine: TeamEngine, room = "r") {
  engine.submit(room, { id: "plan", text: "请制定 ESP32 同步方案" });
  engine.send(room, "task:plan", {
    id: "artifact",
    type: "ARTIFACT",
    at: 0,
    artifact: { id: "old-artifact", name: "原方案", content: plan },
  });
  engine.send(room, "task:plan", {
    id: "delivery",
    type: "DELIVER",
    at: 0,
    text: plan,
    artifactIds: ["old-artifact"],
  });
  engine.send(room, "task:plan", {
    id: "checked",
    type: "CHECK_RESULT",
    at: 0,
    passed: true,
    gaps: [],
    resultId: "check-plan",
  });
}
function setup(config = configuration(), store: Store = new MemoryStore()) {
  const engine = new TeamEngine(store, config, () => 0);
  seed(engine);
  return { engine, config, store };
}
function review(engine: TeamEngine, id = `review-${++sequence}`) {
  const result = engine.submit("r", { id, text: "大家都提提意见" });
  expect(result.ok).toBe(true);
  return result.taskId!;
}
function script(calls: Intent[], failure?: string): WorkAdapter {
  return {
    async execute(work) {
      calls.push(work);
      if (work.kind === "facilitator")
        return {
          type: "decision",
          decision: {
            action: "review",
            question:
              "评审群聊中的 ESP32 方案，给出你负责方向的风险和改进建议。",
            expected: "具体意见和来源依据",
            reason: "用户要求团队评审已有方案",
          },
        };
      if (work.kind === "assistance") {
        if (work.target === failure) throw new Error("验证服务不可用");
        return {
          type: "answer",
          text: `${work.target}：建议验证文档变化与局部刷新边界。`,
        };
      }
      if (work.kind === "check")
        return { type: "check", passed: true, gaps: [] };
      return {
        type: "deliver",
        text: "已汇总成员的共识、分歧与改进项。",
        artifactIds: [],
      };
    },
  };
}
async function drain(engine: TeamEngine, task: string, adapter: WorkAdapter) {
  const runner = new WorkRunner(engine, adapter, () => 0);
  for (let n = 0; n < 30; n++) if (!(await runner.runOne("r", task))) return;
  throw new Error("Review did not settle within its expected finite sequence");
}

describe("same-room conversational context", () => {
  it("[BT_G01] carries the previous delivery into a new task without reviving it or duplicating public messages", () => {
    const { engine } = setup();
    engine.submit("secret", { id: "private", text: "另一个群的私密资料" });
    const oldMessages = engine.timeline("r");
    const task = engine.submit("r", {
      id: "followup",
      text: "这个方案的成本如何？",
    }).taskId!;
    const input = engine.pending("r", task)[0]!.payload;
    expect(
      (input.messages as Message[]).some(
        (message) => message.taskId === "task:plan" && message.text === plan,
      ),
    ).toBe(true);
    expect(input.conversation).toMatchObject({
      artifacts: [{ id: "old-artifact", taskId: "task:plan", content: plan }],
    });
    expect(input.artifacts).toEqual([]);
    expect(input.conversation).toMatchObject({
      tasks: [
        {
          taskId: "task:plan",
          goal: { text: "请制定 ESP32 同步方案" },
          owner: "A",
          outcome: "complete",
        },
      ],
    });
    expect(JSON.stringify(input)).not.toContain("另一个群的私密资料");
    expect(engine.view("r", "task:plan")?.phase).toBe("ended");
    expect(
      engine
        .timeline("r")
        .filter((message) => oldMessages.some((old) => old.id === message.id)),
    ).toHaveLength(oldMessages.length);
  });

  it("[BT_G02] hydrates a legacy waiting task when the user asks the team to review the previous plan", () => {
    const { engine, store } = setup();
    engine.submit("r", { id: "legacy", text: "请看看这个问题" });
    engine.send("r", "task:legacy", {
      type: "WAIT_USER",
      id: "wait",
      at: 0,
      question: "缺少方案",
    });
    store.transact("r", (tx) => {
      const stored = tx.room.tasks["task:legacy"] as {
        snapshot: { context: { history?: unknown } };
      };
      delete stored.snapshot.context.history;
    });
    engine.submit("r", {
      id: "request",
      text: "其他人提提意见？",
      intent: "decision",
    });
    const pending = engine.pending("r", "task:legacy");
    expect(pending.map((work) => work.kind)).toEqual(["facilitator"]);
    expect(JSON.stringify(pending[0]!.payload.messages)).toContain(plan);
    expect(engine.view("r", "task:legacy")?.context.review?.targets).toEqual(
      reviewers,
    );
  });

  it("also gives ordinary helpers the proposal and source-task references", () => {
    const { engine } = setup();
    engine.submit("r", { id: "followup", text: "请核查上述方案" });
    engine.send("r", "task:followup", {
      type: "HELP",
      id: "help",
      at: 0,
      requestId: "H1",
      caller: "A",
      target: "B",
      question: "核查上面的方案",
      expected: "依据",
    });
    const helper = engine.pending("r", "task:followup")[0]!;
    expect(JSON.stringify(helper.payload.messages)).toContain(plan);
    expect(helper.payload.conversation).toMatchObject({
      artifacts: [{ taskId: "task:plan", id: "old-artifact" }],
    });
    expect(helper.payload.artifacts).toEqual([]);
  });

  it("[BT_G03] bounds historical input and labels omitted material", () => {
    const { engine } = setup();
    const context = engine.view("r", "task:plan")!.context;
    const history = conversationHistory([
      {
        ...context,
        messages: Array.from({ length: 150 }, (_, index) => ({
          ...context.messages[0]!,
          id: `m${index}`,
          at: index,
          text: "x".repeat(2000),
        })),
      },
    ]);
    expect(history.messages.length).toBeLessThanOrEqual(100);
    expect(history.messages.at(-1)?.id).toBe("m149");
    expect(
      history.messages.reduce((sum, message) => sum + message.text.length, 0),
    ).toBeLessThanOrEqual(96_000);
    expect(history.truncated).toBe(true);
  });

  it("[BT_G03] cannot count a historical artifact as a current-goal delivery", () => {
    const { engine } = setup();
    engine.submit("r", {
      id: "new-file",
      text: "交付新版方案",
      goal: {
        text: "交付新版方案",
        constraints: [],
        criteria: ["新版产物"],
        requiredArtifacts: 1,
      },
    });
    engine.send("r", "task:new-file", {
      type: "DELIVER",
      id: "bad",
      at: 0,
      text: "新版已完成",
      artifactIds: ["old-artifact"],
    });
    engine.send("r", "task:new-file", {
      type: "CHECK_RESULT",
      id: "bad-check",
      at: 0,
      passed: true,
      gaps: [],
      resultId: "bad-check-result",
    });
    expect(engine.view("r", "task:new-file")?.phase).toBe("coordinating");
    expect(engine.view("r", "task:new-file")?.context.outcome).toBeNull();
  });
});

describe("bounded group review", () => {
  it("[BT_G04] collects every other member sequentially, then runs one owner synthesis and one check", async () => {
    const { engine } = setup();
    const task = review(engine);
    const calls: Intent[] = [];
    expect(engine.view("r", task)?.phase).toBe("coordinating");
    expect(Number.isFinite(engine.pending("r", task)[0]?.deadline)).toBe(true);
    await drain(engine, task, script(calls));
    expect(calls.map((work) => `${work.kind}:${work.target}`)).toEqual([
      "facilitator:facilitator",
      ...reviewers.map((id) => `assistance:${id}`),
      "owner:A",
      "check:facilitator",
    ]);
    for (const work of calls)
      expect(JSON.stringify(work.payload.messages)).toContain(plan);
    expect(
      calls.find((work) => work.kind === "owner")?.payload.review,
    ).toMatchObject({
      status: "summarizing",
      completed: reviewers,
      results: reviewers.map((target) => ({ target, status: "success" })),
    });
    const view = engine.view("r", task)!;
    expect(view.context.outcome).toBe("complete");
    expect(view.context.review?.completed).toEqual(reviewers);
    expect(
      view.context.messages
        .filter((message) => message.kind === "answer")
        .map((message) => message.author),
    ).toEqual(reviewers);
    expect(
      view.context.messages.filter((message) => message.kind === "final"),
    ).toHaveLength(1);
    expect(view.context.usage).toMatchObject({
      ordinary: 6,
      checks: 1,
      assists: 4,
    });
  });

  it("[BT_G05] keeps an explicit single-member review bounded to that selected member", async () => {
    const { engine } = setup();
    engine.submit("r", { id: "active", text: "评估上面的方案" });
    engine.send("r", "task:active", {
      type: "WAIT_USER",
      id: "wait",
      at: 0,
      question: "希望谁评审？",
    });
    engine.submit("r", {
      id: "selected",
      text: "@builder-1 review 一下方案",
      mentions: ["builder-1"],
      intent: "decision",
    });
    const calls: Intent[] = [];
    await drain(engine, "task:active", script(calls));
    expect(
      calls
        .filter((work) => work.kind === "assistance")
        .map((work) => work.target),
    ).toEqual(["builder-1"]);
    expect(engine.view("r", "task:active")?.context.owner).toBe("A");
  });

  it("[BT_G06] does not infer authority from negation, quoted requests, code or Bot messages", () => {
    const { engine, config } = setup();
    for (const text of [
      "“大家提提意见”是什么意思？",
      "> 大家都提提意见",
      "```\n大家都提提意见\n```",
      "不要让大家提意见",
      "大家先不要提意见",
    ]) {
      expect(
        requestedReviewTargets(text, [], config.bots, "A"),
      ).toBeUndefined();
    }
    engine.submit("r", { id: "ordinary", text: "请解释一下实现" });
    engine.send("r", "task:ordinary", {
      type: "BOARD_WRITE",
      id: "quote",
      at: 0,
      author: "B",
      entryId: "quote",
      text: "大家都提提意见",
      kind: "opinion",
      sources: [],
    });
    expect(
      engine.pending("r", "task:ordinary").map((work) => work.kind),
    ).toEqual(["owner"]);
    expect(engine.view("r", "task:ordinary")?.context.review).toBeUndefined();
  });

  it.each(["ordinary", "assists"] as const)(
    "reserves synthesis capacity and reports partial completion at the %s limit",
    async (limit) => {
      const { engine } = setup(
        configuration(limit === "ordinary" ? { ordinary: 3 } : { assists: 1 }),
      );
      const task = review(engine);
      const calls: Intent[] = [];
      await drain(engine, task, script(calls));
      expect(
        calls
          .filter((work) => work.kind === "assistance")
          .map((work) => work.target),
      ).toEqual(["B"]);
      expect(calls.filter((work) => work.kind === "owner")).toHaveLength(1);
      expect(engine.view("r", task)?.context.outcome).toBe("partial");
      expect(engine.view("r", task)?.context.review?.incomplete).toContain(
        "builder-1",
      );
      expect(engine.view("r", task)!.context.usage[limit]).toBeLessThanOrEqual(
        engine.view("r", task)!.context.config.limits[limit],
      );
    },
  );

  it("[BT_G09] continues collecting opinions after a reviewer fails and labels the final result partial", async () => {
    const { engine } = setup();
    const task = review(engine);
    const calls: Intent[] = [];
    await drain(engine, task, script(calls, "B"));
    expect(
      calls
        .filter((work) => work.kind === "assistance")
        .map((work) => work.target),
    ).toEqual(reviewers);
    expect(engine.view("r", task)?.context.outcome).toBe("partial");
    expect(
      engine
        .view("r", task)
        ?.context.messages.some(
          (message) =>
            message.author === "B" && message.text.includes("验证服务不可用"),
        ),
    ).toBe(true);
  });

  it.each(["model", "skill"] as const)(
    "[BT_F12] protects synthesis capacity from a reviewer's additional %s request before external I/O",
    async (kind) => {
      const { engine } = setup(configuration({ ordinary: 3 }));
      const task = review(engine);
      const calls: Intent[] = [];
      const base = script(calls);
      let externalCalls = 0;
      const runner = new WorkRunner(engine, {
        async execute(work, signal, scope) {
          if (work.kind === "assistance") {
            if (kind === "skill") await scope.findSkills("review tools");
            else scope.authorizeAdditionalRequest("extra-model");
            externalCalls++;
          }
          return base.execute(work, signal, scope);
        },
      }, () => 0, async () => {
        externalCalls++;
        return new Response(JSON.stringify({ skills: [] }));
      });
      for (let n = 0; n < 20 && await runner.runOne("r", task); n++);
      expect(externalCalls).toBe(0);
      expect(calls.filter((work) => work.kind === "owner")).toHaveLength(1);
      expect(calls.filter((work) => work.kind === "check")).toHaveLength(1);
      expect(engine.view("r", task)?.context.usage.ordinary).toBe(3);
      expect(engine.view("r", task)?.context.outcome).toBe("partial");
      expect(engine.view("r", task)?.context.assists[0]?.answer).toContain(
        "REVIEW_SYNTHESIS_RESERVED",
      );
    },
  );

  it("[BT_F12] keeps the final ordinary request for synthesis instead of retrying a reviewer", async () => {
    const { engine } = setup(configuration({ ordinary: 3 }));
    const task = review(engine);
    const calls: Intent[] = [];
    const base = script(calls);
    let attempts = 0;
    await drain(engine, task, {
      async execute(work, signal, scope) {
        if (work.kind === "assistance" && ++attempts === 1)
          throw new WorkFailure("temporary review failure", true);
        return base.execute(work, signal, scope);
      },
    });
    expect(attempts).toBe(1);
    expect(calls.filter((work) => work.kind === "owner")).toHaveLength(1);
    expect(engine.view("r", task)?.context.outcome).toBe("partial");
    expect(engine.view("r", task)?.context.usage.retries).toBe(0);
  });

  it("[BT_F13] allows an extra reviewer request when synthesis still has its own unit", async () => {
    const { engine } = setup(configuration({ ordinary: 4 }));
    const task = review(engine);
    const calls: Intent[] = [];
    const base = script(calls);
    let extraRequests = 0;
    await drain(engine, task, {
      async execute(work, signal, scope) {
        if (work.kind === "assistance") {
          scope.authorizeAdditionalRequest("extra-model");
          extraRequests++;
        }
        return base.execute(work, signal, scope);
      },
    });
    expect(extraRequests).toBe(1);
    expect(calls.filter((work) => work.kind === "owner")).toHaveLength(1);
    expect(engine.view("r", task)?.context.assists[0]?.status).toBe("success");
    expect(engine.view("r", task)?.context.usage.ordinary).toBe(4);
    expect(engine.view("r", task)?.context.outcome).toBe("partial");
  });

  it("[BT_F12] settles a recovered reviewer that cannot be reclaimed without spending synthesis capacity", async () => {
    const { engine, config, store } = setup(configuration({ ordinary: 3 }));
    const task = review(engine);
    const calls: Intent[] = [];
    await new WorkRunner(engine, script(calls), () => 0).runOne("r", task);
    const helper = engine.pending("r", task)[0]!;
    expect(engine.claim("r", task, helper.id)?.kind).toBe("assistance");
    const restored = new TeamEngine(store, config, () => 0);
    restored.recover("r");
    await drain(restored, task, script(calls));
    expect(calls.filter((work) => work.kind === "assistance")).toHaveLength(0);
    expect(calls.filter((work) => work.kind === "owner")).toHaveLength(1);
    expect(restored.view("r", task)?.context.usage.ordinary).toBe(3);
    expect(restored.view("r", task)?.context.outcome).toBe("partial");
    expect(restored.view("r", task)?.context.assists[0]?.status).toBe("failed");
  });

  it("[BT_G07] waits for genuinely missing material without repeatedly calling the facilitator", async () => {
    const engine = new TeamEngine(new MemoryStore(), configuration(), () => 0);
    const task = review(engine);
    let calls = 0;
    await drain(engine, task, {
      execute: async () => {
        calls++;
        return {
          type: "decision",
          decision: {
            action: "askUser",
            question: "请提供待评审方案",
            reason: "群内没有方案",
          },
        };
      },
    });
    expect(calls).toBe(1);
    expect(engine.view("r", task)?.phase).toBe("waitingHuman");
    expect(engine.nextWake("r")).toBeNull();
    engine.submit("r", { id: "material", text: plan, intent: "decision" });
    expect(engine.pending("r", task)[0]?.kind).toBe("facilitator");
    expect(
      JSON.stringify(engine.pending("r", task)[0]?.payload.messages),
    ).toContain(plan);
  });

  it("[BT_G08] rejects a facilitator attempt to skip the required review", async () => {
    const { engine } = setup();
    const task = review(engine);
    await drain(engine, task, {
      execute: async () => ({
        type: "decision",
        decision: { action: "continue", reason: "skip" },
      }),
    });
    expect(engine.view("r", task)?.phase).toBe("waitingHuman");
    expect(engine.pending("r", task)).toEqual([]);
    expect(
      engine
        .view("r", task)
        ?.context.trace.some((event) =>
          event.detail.includes("REVIEW_PLAN_REQUIRED"),
        ),
    ).toBe(true);
  });

  it("[BT_G10] stops an inflight review and only restarts the queue on an explicit new epoch", async () => {
    const { engine } = setup();
    const task = review(engine);
    const calls: Intent[] = [];
    const runner = new WorkRunner(engine, script(calls), () => 0);
    await runner.runOne("r", task);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = new WorkRunner(
      engine,
      {
        execute: async (_work, signal) => {
          started();
          return await new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        },
      },
      () => 0,
    );
    const inflight = waiting.runOne("r", task);
    await ready;
    const oldRequest = engine.view("r", task)!.context.assists[0]!.id;
    engine.send("r", task, { type: "STOP", id: "stop", at: 0 });
    await waiting.runOne("r", task);
    await inflight;
    expect(engine.view("r", task)?.context.outcome).toBe("stopped");
    expect(engine.pending("r", task)).toEqual([]);
    engine.submit("r", {
      id: "resume",
      text: "继续",
      intent: "continue",
      replyToTaskId: task,
    });
    const late = engine.send("r", task, {
      type: "HELP_RESULT",
      id: "late",
      at: 0,
      requestId: oldRequest,
      resultId: "late-result",
      status: "success",
      answer: "旧轮次结果",
      fence: { epoch: 1, goalVersion: 1 },
    });
    expect(late.ok).toBe(false);
    await drain(engine, task, script(calls));
    expect(engine.view("r", task)?.context.outcome).toBe("complete");
    expect(engine.view("r", task)?.context.epoch).toBe(2);
    expect(engine.view("r", task)?.context.review?.completed).toEqual(
      reviewers,
    );
  });

  it("[BT_G11] applies new user input at the next safe boundary before dispatching further reviewers", async () => {
    const { engine } = setup();
    const task = review(engine);
    const calls: Intent[] = [];
    const runner = new WorkRunner(engine, script(calls), () => 0);
    await runner.runOne("r", task);
    const helper = engine.claim("r", task, engine.pending("r", task)[0]!.id)!;
    engine.submit("r", { id: "extra", text: "评审时重点考虑离线使用" });
    expect(engine.view("r", task)?.context.inputs.at(-1)?.applied).toBe(false);
    engine.send("r", task, {
      type: "HELP_RESULT",
      id: "old-answer",
      at: 0,
      workId: helper.id,
      fence: { epoch: 1, goalVersion: 1 },
      requestId: String(helper.payload.requestId),
      resultId: "R1",
      status: "success",
      answer: "旧输入下的意见",
    });
    expect(engine.view("r", task)?.phase).toBe("coordinating");
    expect(engine.view("r", task)?.context.inputs.at(-1)?.applied).toBe(true);
    expect(
      engine
        .pending("r", task)
        .filter((work) => work.kind !== "cancel")
        .map((work) => work.kind),
    ).toEqual(["facilitator"]);
    expect(
      JSON.stringify(engine.pending("r", task).at(-1)?.payload.messages),
    ).toContain("评审时重点考虑离线使用");
    await drain(engine, task, script(calls));
    expect(engine.view("r", task)?.context.outcome).toBe("complete");
  });

  it("[BT_G12] recovers a persisted helper result exactly once and resumes the remaining queue", async () => {
    const directory = mkdtempSync(join(tmpdir(), "squad-review-"));
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "review.sqlite");
    const first = new SqliteStore(file);
    const config = configuration();
    const { engine } = setup(config, first);
    const task = review(engine);
    const calls: Intent[] = [];
    await new WorkRunner(engine, script(calls), () => 0).runOne("r", task);
    const helper = engine.claim("r", task, engine.pending("r", task)[0]!.id)!;
    engine.send("r", task, {
      type: "RECORD_RESULT",
      id: "record",
      at: 0,
      workId: helper.id,
      fence: { epoch: 1, goalVersion: 1 },
      requestId: String(helper.payload.requestId),
      resultId: "saved-result",
      status: "success",
      answer: "B 的已保存意见",
    });
    first.close();
    const second = new SqliteStore(file);
    cleanup.push(() => second.close());
    const restored = new TeamEngine(second, config, () => 0);
    restored.recover("r");
    restored.recover("r");
    expect(restored.view("r", task)?.context.review?.completed).toEqual(["B"]);
    expect(restored.pending("r", task)[0]?.target).toBe("builder-1");
    await drain(restored, task, script(calls));
    expect(restored.view("r", task)?.context.outcome).toBe("complete");
    expect(
      restored
        .timeline("r")
        .filter((message) => message.text === "B 的已保存意见"),
    ).toHaveLength(1);
    expect(
      calls
        .filter((work) => work.kind === "assistance")
        .map((work) => work.target),
    ).toEqual(reviewers.slice(1));
  });

  it("[BT_G13] does not accept a review result prepared before a changed hard constraint", async () => {
    const { engine } = setup();
    const task = review(engine);
    const calls: Intent[] = [];
    await new WorkRunner(engine, script(calls), () => 0).runOne("r", task);
    const helper = engine.claim("r", task, engine.pending("r", task)[0]!.id)!;
    const oldGoal = engine.view("r", task)!.context.goal;
    engine.submit("r", {
      id: "changed",
      text: "不允许设备直接持有飞书密钥",
      goal: { ...oldGoal, constraints: ["密钥只能保存在代理服务"] },
    });
    const rejected = engine.send("r", task, {
      type: "HELP_RESULT",
      id: "stale-help",
      at: 0,
      workId: helper.id,
      fence: { epoch: 1, goalVersion: 1 },
      requestId: String(helper.payload.requestId),
      resultId: "stale-result",
      status: "success",
      answer: "旧约束下的意见",
    });
    expect(rejected.ok).toBe(false);
    expect(engine.view("r", task)?.context.review?.completed).toEqual([]);
    expect(engine.view("r", task)?.context.review?.goalVersion).toBe(2);
    const next = engine
      .pending("r", task)
      .find((work) => work.kind === "facilitator")!;
    expect(next.goalVersion).toBe(2);
    expect(JSON.stringify(next.payload)).toContain("密钥只能保存在代理服务");
  });

  it("[BT_G14] blocks recovery when a required but not-yet-dispatched reviewer was removed", async () => {
    const { engine, store, config } = setup();
    const task = review(engine);
    await new WorkRunner(engine, script([]), () => 0).runOne("r", task);
    const changed = structuredClone(config);
    changed.bots = changed.bots.filter((bot) => bot.id !== "builder-3");
    const restored = new TeamEngine(store, changed, () => 0);
    restored.recover("r");
    expect(restored.view("r", task)?.phase).toBe("waitingHuman");
    expect(restored.view("r", task)?.context.reason).toBe(
      "Execution member unavailable",
    );
    expect(
      restored.pending("r", task).filter((work) => work.kind !== "cancel"),
    ).toEqual([]);
  });

  it("uses the model protocol to plan the review and passes history through every HTTP request", async () => {
    const config = configuration();
    config.models = {
      default: "local",
      services: { local: { baseUrl: "http://127.0.0.1:9/v1", model: "test" } },
    };
    const { engine } = setup(config);
    const task = review(engine);
    const requests: { system: string; context: Record<string, unknown> }[] = [];
    const adapter = new OpenAICompatibleAdapter(config, {
      clock: () => 0,
      transport: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const system = body.messages[0].content as string;
        const context = JSON.parse(body.messages[1].content).context;
        requests.push({ system, context });
        const work = engine
          .view("r", task)!
          .context.intents.find((work) => work.status === "inflight")!;
        const output = await script([]).execute(
          work,
          new AbortController().signal,
          {
            authorizeAdditionalRequest() {},
            async findSkills() {
              return [];
            },
          },
        );
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify(output) },
            },
          ],
        });
      },
    });
    await drain(engine, task, adapter);
    expect(requests).toHaveLength(7);
    expect(requests[0]!.system).toContain('return action "review"');
    for (const request of requests)
      expect(JSON.stringify(request.context.messages)).toContain(plan);
    expect(requests.at(-2)!.system).toContain("Deliver one synthesis");
    expect(engine.view("r", task)?.context.outcome).toBe("complete");
  });
});
