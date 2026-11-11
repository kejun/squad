import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebError, type WebService } from "./service.js";
import type { Submission } from "../engine.js";
import { RoomDeletionError } from '../store.js';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 100_000)
      throw new WebError(413, "消息过长。");
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new WebError(400, "请求格式不正确。");
  }
}
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function createWebServer(
  service: WebService,
  publicDir = resolve("dist/web"),
) {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      if (url.pathname.startsWith("/api/")) {
        if (req.method === 'GET' && url.pathname === '/api/health') {
          const health = service.health(); return json(res, health, health.healthy ? 200 : 503);
        }
        // Local application: mutations must originate from this host, including through Vite's proxy.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host)
          throw new WebError(403, "请求来源不受支持。");
        if (req.method === "GET" && url.pathname === "/api/debug")
          return json(res, { enabled: service.debugEnabled });
        const debug = /^\/api\/debug\/rooms\/([^/]+)$/.exec(url.pathname);
        if (debug) {
          if (!service.debugEnabled) throw new WebError(404, "调试未开启。");
          if (req.method !== "GET") throw new WebError(405, "调试接口只允许读取。");
          const after = Number(url.searchParams.get("after") ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new WebError(400, "调试游标无效。");
          return json(res, service.debugSnapshot(decodeURIComponent(debug[1]!), after,
            url.searchParams.get("session") ?? undefined, url.searchParams.get("task") ?? undefined));
        }
        if (req.method === "GET" && url.pathname === "/api/rooms")
          return json(res, { rooms: service.rooms(), deletedRooms: service.deletedRooms() });
        if (req.method === "POST" && url.pathname === "/api/rooms") {
          const data = await body(req);
          return json(
            res,
            service.createRoom(
              typeof data.title === "string" ? data.title : undefined,
            ),
            201,
          );
        }
        const match = /^\/api\/rooms\/([^/]+)(?:\/(messages|stop|archive|restore|host-approval|host-retry|host-session-revoke|blocker-decision|operation-review|operation-reconcile|delete|delete-retry))?$/.exec(
          url.pathname,
        );
        if (!match?.[1]) throw new WebError(404, "接口不存在。");
        const roomId = decodeURIComponent(match[1]);
        if (req.method === "GET" && !match[2])
          return json(res, service.snapshot(roomId));
        if (req.method === 'GET' && match[2] === 'operation-review') {
          const data = { taskId: url.searchParams.get('taskId'), workId: url.searchParams.get('workId'), operationId: url.searchParams.get('operationId') };
          if (Object.values(data).some(value => !value || value.length > 1024)) throw new WebError(400, '核对身份不完整。');
          return json(res, await service.operationReview(roomId, data as { taskId: string; workId: string; operationId: string }));
        }
        if (req.method === "POST" && match[2]) {
          const data = await body(req);
          if (typeof data.id !== "string" || !data.id || data.id.length > 120)
            throw new WebError(400, "缺少请求标识。");
          if (['blocker-decision', 'operation-reconcile', 'delete', 'delete-retry'].includes(match[2])) {
            if (!origin || !req.headers['content-type']?.startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site') throw new WebError(403, '此操作必须由同源页面明确提交。');
          }
          if (match[2] === 'blocker-decision') {
            const keys = ['id', 'taskId', 'blockerId', 'blockerVersion', 'actionId', 'text', 'newWindowMs'];
            if (Object.keys(data).some(k => !keys.includes(k)) || !['taskId', 'blockerId'].every(k => typeof data[k] === 'string' && !!data[k] && String(data[k]).length <= 1024)
              || !Number.isSafeInteger(data.blockerVersion) || !['reply', 'skip', 'stop', 'newWindow'].includes(String(data.actionId))
              || data.text !== undefined && (typeof data.text !== 'string' || data.text.length > 32000)
              || ['reply', 'newWindow'].includes(String(data.actionId)) && (typeof data.text !== 'string' || !data.text.trim())
              || data.actionId === 'newWindow' && (!Number.isSafeInteger(data.newWindowMs) || Number(data.newWindowMs) <= 0)) throw new WebError(400, '回复格式不正确。');
            return json(res, service.decideBlocker(roomId, data as unknown as Parameters<WebService['decideBlocker']>[1]));
          }
          if (match[2] === 'operation-reconcile') {
            const keys = ['id', 'taskId', 'workId', 'operationId', 'reviewDigest'];
            if (Object.keys(data).some(k => !keys.includes(k)) || keys.some(k => typeof data[k] !== 'string' || !data[k] || String(data[k]).length > 1024)
              || !/^[a-f0-9]{64}$/.test(String(data.reviewDigest))) throw new WebError(400, '核对确认身份不正确。');
            return json(res, await service.reconcileOperation(roomId, data as unknown as Parameters<WebService['reconcileOperation']>[1]));
          }
          if (match[2] === 'delete') {
            if (Object.keys(data).some(k => !['id', 'expectedArchiveVersion', 'expectedDeletionVersion'].includes(k))
              || !Number.isSafeInteger(data.expectedArchiveVersion) || Number(data.expectedArchiveVersion) < 0
              || data.expectedDeletionVersion !== undefined && (!Number.isSafeInteger(data.expectedDeletionVersion) || Number(data.expectedDeletionVersion) < 0)) throw new WebError(400, '删除确认版本不正确。');
            return json(res, await service.deleteRoom(roomId, data as unknown as Parameters<WebService['deleteRoom']>[1]), 202);
          }
          if (match[2] === 'delete-retry') {
            if (Object.keys(data).some(k => !['id', 'deletionId', 'expectedDeletionVersion'].includes(k))
              || typeof data.deletionId !== 'string' || !data.deletionId || data.deletionId.length > 1024
              || !Number.isSafeInteger(data.expectedDeletionVersion) || Number(data.expectedDeletionVersion) < 0) throw new WebError(400, '删除重试版本不正确。');
            return json(res, await service.retryRoomDeletion(roomId, data as unknown as Parameters<WebService['retryRoomDeletion']>[1]), 202);
          }
          if (match[2] === 'host-retry') {
            if (!origin || !req.headers['content-type']?.startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site') throw new WebError(403, '宿主申请必须由同源页面提交。');
            const keys = ['id', 'taskId', 'workId', 'operationId', 'sourceRequestHash'];
            if (Object.keys(data).some(key => !keys.includes(key)) || keys.some(key => typeof data[key] !== 'string' || !data[key] || String(data[key]).length > 1024)) throw new WebError(400, '宿主申请格式不正确。');
            return json(res, service.requestHostRetry(roomId, data as unknown as Parameters<WebService['requestHostRetry']>[1]));
          }
          if (match[2] === 'host-session-revoke') {
            if (!origin || !req.headers['content-type']?.startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site') throw new WebError(403, '撤销宿主授权必须由同源页面提交。');
            const keys = ['id', 'taskId', 'grantId'];
            if (Object.keys(data).some(key => !keys.includes(key)) || keys.some(key => typeof data[key] !== 'string' || !data[key] || String(data[key]).length > 1024)) throw new WebError(400, '撤销请求格式不正确。');
            return json(res, service.revokeHostSession(roomId, data as unknown as Parameters<WebService['revokeHostSession']>[1]));
          }
          if (match[2] === 'host-approval') {
            if (!origin || !req.headers['content-type']?.startsWith('application/json') || req.headers['sec-fetch-site'] === 'cross-site')
              throw new WebError(403, '宿主授权必须由同源页面提交。');
            const keys = ['id', 'taskId', 'workId', 'operationId', 'approvalId', 'decision'];
            if (Object.keys(data).some(key => !keys.includes(key)) || keys.some(key => typeof data[key] !== 'string' || !data[key] || String(data[key]).length > 1024)
              || !['approve', 'approveSession', 'deny'].includes(String(data.decision))) throw new WebError(400, '授权请求格式不正确。');
            return json(res, service.decideHostApproval(roomId, data as unknown as Parameters<WebService['decideHostApproval']>[1]));
          }
          if (match[2] === "archive" || match[2] === "restore")
            return json(res, service.setRoomArchived(roomId, data.id, match[2] === "archive"));
          if (match[2] === "stop") {
            if (typeof data.taskId !== "string")
              throw new WebError(400, "缺少任务标识。");
            return json(res, service.stop(roomId, data.taskId, data.id));
          }
          if (typeof data.text !== "string")
            throw new WebError(400, "请输入消息。");
          if (
            data.mentions !== undefined &&
            (!Array.isArray(data.mentions) ||
              !data.mentions.every((id) => typeof id === "string"))
          )
            throw new WebError(400, "成员格式不正确。");
          if (
            data.intent !== undefined &&
            !["new", "supplement", "decision", "continue", "retry"].includes(
              String(data.intent),
            )
          )
            throw new WebError(400, "消息类型不正确。");
          if (
            data.replyToTaskId !== undefined &&
            typeof data.replyToTaskId !== "string"
          )
            throw new WebError(400, "任务标识不正确。");
          if (data.retryAssistanceId !== undefined && (typeof data.retryAssistanceId !== "string" || !data.retryAssistanceId || data.retryAssistanceId.length > 512))
            throw new WebError(400, "协助标识不正确。");
          if (data.extraOrdinary !== undefined && (!Number.isSafeInteger(data.extraOrdinary) || Number(data.extraOrdinary) <= 0))
            throw new WebError(400, '额外额度必须为正整数。');
          if (data.newWindowMs !== undefined && (!Number.isSafeInteger(data.newWindowMs) || Number(data.newWindowMs) <= 0))
            throw new WebError(400, '新处理窗口必须为正整数毫秒。');
          if ((data.extraOrdinary !== undefined || data.newWindowMs !== undefined) && data.intent !== 'continue')
            throw new WebError(400, '只有明确继续任务才能授权新额度或新处理窗口。');
          if (data.sourceArtifact !== undefined) {
            const source = data.sourceArtifact;
            if (!source || typeof source !== 'object' || Array.isArray(source)
              || Object.keys(source).some(key => !['sourceTaskId', 'artifactId'].includes(key))
              || !['sourceTaskId', 'artifactId'].every(key => {
                const value = (source as Record<string, unknown>)[key];
                return typeof value === 'string' && value.length > 0 && value.length <= 512;
              })) throw new WebError(400, '产物引用格式不正确，请重新选择来源。');
            if (data.extraOrdinary !== undefined) throw new WebError(400, '产物引用不能与任务额度控制同时提交。');
          }
          const input: Submission = {
            id: data.id,
            text: data.text,
            ...(data.mentions ? { mentions: data.mentions as string[] } : {}),
            ...(data.intent
              ? { intent: data.intent as Submission["intent"] & string }
              : {}),
            ...(typeof data.replyToTaskId === "string"
              ? { replyToTaskId: data.replyToTaskId }
              : {}),
            ...(typeof data.retryAssistanceId === "string" ? { retryAssistanceId: data.retryAssistanceId } : {}),
            ...(typeof data.extraOrdinary === 'number' ? { extraOrdinary: data.extraOrdinary } : {}),
            ...(typeof data.newWindowMs === 'number' ? { newWindowMs: data.newWindowMs } : {}),
            ...(data.sourceArtifact ? { sourceArtifact: data.sourceArtifact as Submission['sourceArtifact'] & object } : {}),
          };
          return json(res, service.submit(roomId, input));
        }
        throw new WebError(405, "请求方法不受支持。");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new WebError(405, "请求方法不受支持。");
      const path = resolve(publicDir, `.${decodeURIComponent(url.pathname)}`);
      if (path !== publicDir && !path.startsWith(publicDir + sep))
        throw new WebError(403, "无权访问。");
      try {
        const file = extname(path) ? path : resolve(publicDir, "index.html");
        const content = await readFile(file);
        res.writeHead(200, {
          "content-type": mime[extname(file)] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : content);
      } catch {
        throw new WebError(
          404,
          "请先运行 npm run build:web，或使用 npm run dev。",
        );
      }
    })().catch((error) => {
      if (error instanceof RoomDeletionError) error = new WebError(error.code === 'ROOM_DELETED' ? 410 : 409,
        error.code === 'ROOM_DELETED' ? '这个群聊已删除。' : '会话删除状态已更新，不能再执行此操作。',
        { ok: false, code: error.code, detail: error.message, roomId: error.roomId });
      if (!res.headersSent)
        json(
          res,
          {
            ...(error instanceof WebError && error.commandResult ? {
              code: error.commandResult.code,
              ...(error.commandResult.roomId ? { roomId: error.commandResult.roomId } : {}),
              ...(error.commandResult.deletionVersion !== undefined ? { deletionVersion: error.commandResult.deletionVersion } : {}),
              ...(error.commandResult.sourceCandidates ? { sourceCandidates: error.commandResult.sourceCandidates } : {}),
            } : {}),
            error:
              error instanceof WebError
                ? error.message
                : "服务暂时不可用，请稍后重试。",
          },
          error instanceof WebError ? error.status : 500,
        );
      else res.end();
    });
  });
}
