import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTeamConfig } from "../team.config.js";
import { WebService } from "../src/web/service.js";
import { createWebServer } from "../src/web/http.js";
import type { RoomSnapshot, WebRoom } from "../src/web/contracts.js";
import { WorkFailure, type WorkAdapter } from "../src/runner.js";
import { assistanceRetrySubmission } from "../web/src/AssistanceRetry.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const configuration = () => createTeamConfig({});
async function host(adapter: WorkAdapter, path?: string) {
  const directory = mkdtempSync(join(tmpdir(), "squad-web-"));
  const database = path ?? join(directory, "team.sqlite");
  const service = new WebService(configuration(), database, adapter);
  const server = createWebServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await service.close();
  };
  cleanup.push(async () => {
    await close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = async <T>(route: string, data?: unknown) => {
    const response = await fetch(
      url + route,
      data === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(data),
          },
    );
    return { status: response.status, data: (await response.json()) as T };
  };
  return { service, server, url, request, database, close };
}
async function until<T>(get: () => T, test: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 100; n++) {
    const value = get();
    if (test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Expected host state was not reached");
}
describe("Web host and HTTP boundary", () => {
  it.each(["button", "B 重试"])("[BT_H11] [BT_U16] resumes A after B retry through HTTP (%s)", async (entry) => {
    const calls: string[] = []; let ownerCalls = 0; let helperCalls = 0;
    const app = await host({ execute: async (work) => {
      calls.push(`${work.kind}:${work.target}`);
      if (work.kind === "assistance") {
        if (++helperCalls === 1) throw new WorkFailure("核查中断");
        return { type: "answer", text: "核查已恢复，结论有依据" };
      }
      if (work.kind === "check") return { type: "check", passed: true, gaps: [] };
      if (++ownerCalls === 1) return { type: "help", requestId: "H1", target: "B", question: "核查方案", expected: "依据" };
      if (ownerCalls === 2) return { type: "askUser", question: "核查中断，请重试 B" };
      expect(work.target).toBe("A"); expect(work.payload.answer).toBe("核查已恢复，结论有依据");
      expect(work.payload.requiresAssessment).toBe(true);
      return { type: "deliver", text: "A 根据 B 的核查完成方案", artifactIds: [] };
    } });
    const room = (await app.request<WebRoom>("/api/rooms", { title: "协助重试" })).data;
    const route = `/api/rooms/${room.id}`;
    const first = await app.request<{ taskId: string }>(`${route}/messages`, { id: "first", text: "请做方案" });
    expect(first.status).toBe(200);
    await until(() => app.service.snapshot(room.id), value => value.tasks[0]?.phase === "waitingHuman");
    const snapshot = (await app.request<RoomSnapshot>(route)).data;
    const help = snapshot.tasks[0]!.assists![0]!;
    expect(help.retryable).toBe(true); expect(help.taskId).toBe(first.data.taskId);
    const malformed = await app.request(`${route}/messages`, { id: "bad-retry", text: "重试", intent: "retry" });
    expect(malformed.status).toBe(409);
    const command = entry === "button" ? assistanceRetrySubmission(help, "retry")
      : { id: "retry", text: entry, intent: "decision", replyToTaskId: help.taskId };
    const retried = await app.request<{ taskId: string }>(`${route}/messages`, command);
    expect(retried.status).toBe(200); expect(retried.data.taskId).toBe(first.data.taskId);
    const done = await until(() => app.service.snapshot(room.id), value => value.tasks[0]?.outcome === "complete");
    expect(done.tasks).toHaveLength(1); expect(done.tasks[0]!.owner).toBe("A");
    expect(done.messages.at(-1)!.text).toBe("A 根据 B 的核查完成方案");
    expect(done.messages.filter(m => m.author === "facilitator" && m.text.includes("核查结果已交给 A"))).toHaveLength(1);
    expect(calls).toEqual(["owner:A", "assistance:B", "owner:A", "assistance:B", "owner:A", "check:facilitator"]);
    const duplicate = await app.request<{ duplicate: boolean }>(`${route}/messages`, command);
    expect(duplicate.status).toBe(200); expect(duplicate.data.duplicate).toBe(true); expect(helperCalls).toBe(2);
  });
  it("routes a selected member, returns actual execution records and preserves rooms/messages after reopening", async () => {
    const calls: string[] = [];
    const sessions: (string | undefined)[] = [];
    const adapter: WorkAdapter = {
      execute: async (work, _signal, scope) => {
        calls.push(work.target);
        sessions.push(scope.sessionId);
        if (work.kind === "check")
          return { type: "check", passed: true, gaps: [] };
        return {
          type: "deliver",
          text: "已完成可检查的方案。",
          artifactIds: [],
        };
      },
    };
    const h = await host(adapter);
    const room = (await h.request<WebRoom>("/api/rooms", {})).data;
    const input = {
      id: "user-1",
      text: "@builder-2 制定实施方案",
      mentions: ["builder-2"],
    };
    expect(
      (await h.request(`/api/rooms/${room.id}/messages`, input)).status,
    ).toBe(200);
    await until(
      () => h.service.snapshot(room.id),
      (s) => s.tasks[0]?.outcome === "complete",
    );
    expect(
      (
        await h.request<{ duplicate: boolean }>(
          `/api/rooms/${room.id}/messages`,
          input,
        )
      ).data.duplicate,
    ).toBe(true);
    const snapshot = (await h.request<RoomSnapshot>(`/api/rooms/${room.id}`))
      .data;
    expect(snapshot.tasks[0]?.owner).toBe("builder-2");
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      input.text,
      "已完成可检查的方案。",
    ]);
    expect(
      snapshot.events.some(
        (event) => event.agentId === "builder-2" && event.kind === "output",
      ),
    ).toBe(true);
    expect(
      snapshot.works.filter((work) => work.agentId === "builder-2"),
    ).toHaveLength(1);
    expect(calls).toEqual(["builder-2", "facilitator"]);
    expect(sessions).toEqual([room.id, room.id]);
    expect(JSON.stringify(snapshot)).not.toContain("apiKeyEnv");
    await h.close();
    const reopened = await host(adapter, h.database);
    expect(reopened.service.rooms()[0]?.title).toBe("制定实施方案");
    expect(reopened.service.snapshot(room.id).messages).toEqual(
      snapshot.messages,
    );
    expect(reopened.service.snapshot(room.id).events).toEqual(snapshot.events);
  });
  it("cancels an inflight request immediately and can explicitly continue its history", async () => {
    let aborted = false;
    let calls = 0;
    const adapter: WorkAdapter = {
      execute: async (work, signal) => {
        if (work.kind === "check")
          return { type: "check", passed: true, gaps: [] };
        if (++calls > 1) return { type: "answer", text: "继续后的结果" };
        return await new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    };
    const h = await host(adapter);
    const room = (await h.request<WebRoom>("/api/rooms", {})).data;
    await h.request(`/api/rooms/${room.id}/messages`, {
      id: "start",
      text: "执行任务",
    });
    const running = await until(
      () => h.service.snapshot(room.id),
      (s) => s.works.some((work) => work.status === "inflight"),
    );
    const taskId = running.activeTaskId!;
    expect(
      (await h.request(`/api/rooms/${room.id}/stop`, { id: "stop", taskId }))
        .status,
    ).toBe(200);
    const stopped = await until(
      () => h.service.snapshot(room.id),
      (s) => s.tasks[0]?.outcome === "stopped",
    );
    expect(aborted).toBe(true);
    expect(stopped.events.some((event) => event.kind === "cancelled")).toBe(
      true,
    );
    expect(stopped.messages).toHaveLength(1);
    await h.request(`/api/rooms/${room.id}/messages`, {
      id: "continue",
      text: "继续执行",
      intent: "continue",
      replyToTaskId: taskId,
    });
    await until(
      () => h.service.snapshot(room.id),
      (s) => s.tasks[0]?.outcome === "complete",
    );
    expect(h.service.snapshot(room.id).tasks).toHaveLength(1);
  });
  it("records help and failures under the correct agent, and accepts a human reply", async () => {
    let assistanceCalls = 0;
    const adapter: WorkAdapter = {
      execute: async (work) => {
        if (work.kind === "check")
          return { type: "check", passed: true, gaps: [] };
        if (work.kind === "assistance") {
          assistanceCalls++;
          return { type: "answer", text: "已核查来源。" };
        }
        if (!work.payload.answer && !work.payload.inputs?.length)
          return {
            type: "help",
            requestId: "help-1",
            target: "B",
            question: "请核查来源",
            expected: "有依据的结论",
          };
        if (work.payload.answer)
          return { type: "askUser", question: "希望采用哪种方案？" };
        return { type: "answer", text: "已按用户选择交付。" };
      },
    };
    const h = await host(adapter);
    const room = (await h.request<WebRoom>("/api/rooms", {})).data;
    await h.request(`/api/rooms/${room.id}/messages`, {
      id: "start",
      text: "形成方案",
    });
    const waiting = await until(
      () => h.service.snapshot(room.id),
      (s) => s.tasks[0]?.phase === "waitingHuman",
    );
    expect(assistanceCalls).toBe(1);
    expect(
      waiting.events
        .filter((event) => event.agentId === "B")
        .map((event) => event.kind),
    ).toEqual(["started", "output"]);
    expect(
      waiting.messages.some(
        (message) => message.kind === "help" && message.recipient === "B",
      ),
    ).toBe(true);
    await h.request(`/api/rooms/${room.id}/messages`, {
      id: "reply",
      text: "采用方案一",
      intent: "decision",
      replyToTaskId: waiting.activeTaskId,
    });
    await until(
      () => h.service.snapshot(room.id),
      (s) => s.tasks[0]?.outcome === "complete",
    );
    expect(h.service.snapshot(room.id).messages.at(-1)?.text).toBe(
      "已按用户选择交付。",
    );
    const broken = await host({
      execute: async () => {
        throw new Error("服务连接失败");
      },
    });
    const brokenRoom = broken.service.createRoom();
    broken.service.submit(brokenRoom.id, { id: "error", text: "test" });
    const failed = await until(
      () => broken.service.snapshot(brokenRoom.id),
      (s) => s.tasks[0]?.phase === "waitingHuman",
    );
    expect(failed.events.at(-1)?.detail).toContain("服务连接失败");
  });
  it("turns a follow-up chat message into a complete team review of the previous delivery", async () => {
    const proposal = "ESP32 方案：代理同步文档，墨水屏做局部刷新。";
    const reviewers: string[] = [];
    const h = await host({
      execute: async (work) => {
        if (work.kind === "facilitator")
          return {
            type: "decision",
            decision: {
              action: "review",
              question: "评审现有 ESP32 方案",
              expected: "意见和改进建议",
              reason: "大家提意见",
            },
          };
        if (work.kind === "assistance") {
          expect(JSON.stringify(work.payload.messages)).toContain(proposal);
          reviewers.push(work.target);
          return { type: "answer", text: `${work.target} 的评审意见` };
        }
        if (work.kind === "check")
          return { type: "check", passed: true, gaps: [] };
        return {
          type: "deliver",
          text: work.payload.review ? "团队评审汇总" : proposal,
          artifactIds: [],
        };
      },
    });
    const room = (await h.request<WebRoom>("/api/rooms", {})).data;
    await h.request(`/api/rooms/${room.id}/messages`, {
      id: "plan",
      text: "制定方案",
    });
    await until(
      () => h.service.snapshot(room.id),
      (snapshot) => snapshot.tasks[0]?.outcome === "complete",
    );
    const command = { id: "review", text: "大家都提提意见" };
    expect(
      (await h.request(`/api/rooms/${room.id}/messages`, command)).status,
    ).toBe(200);
    const completed = await until(
      () => h.service.snapshot(room.id),
      (snapshot) => snapshot.tasks[1]?.outcome === "complete",
    );
    expect(reviewers).toEqual(["B", "builder-1", "builder-2", "builder-3"]);
    expect(completed.tasks[1]?.review).toMatchObject({
      status: "complete",
      completed: reviewers,
      targets: reviewers,
    });
    expect(
      completed.messages.filter((message) => message.text === proposal),
    ).toHaveLength(1);
    expect(completed.messages.at(-1)?.text).toBe("团队评审汇总");
    expect(
      (
        await h.request<{ duplicate: boolean }>(
          `/api/rooms/${room.id}/messages`,
          command,
        )
      ).data.duplicate,
    ).toBe(true);
    expect(
      h.service
        .snapshot(room.id)
        .works.filter((work) => work.kind === "assistance"),
    ).toHaveLength(4);
  });
  it("rejects malformed commands, unknown rooms, forged raw events and cross-origin writes", async () => {
    let executions = 0;
    const h = await host({
      execute: async () => {
        executions++;
        return { type: "answer", text: "ok" };
      },
    });
    const room = (await h.request<WebRoom>("/api/rooms", {})).data;
    expect(
      (
        await h.request(`/api/rooms/${room.id}/messages`, {
          id: "empty",
          text: "",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(`/api/rooms/${room.id}/messages`, {
          id: "bot",
          text: "Hi",
          mentions: ["missing"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.request(`/api/rooms/${room.id}/messages`, {
          id: "event",
          type: "DELIVER",
        })
      ).status,
    ).toBe(400);
    expect((await h.request("/api/rooms/missing")).status).toBe(404);
    expect(
      (
        await fetch(`${h.url}/api/rooms`, {
          method: "POST",
          headers: {
            origin: "https://untrusted.example",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(executions).toBe(0);
  });
});
