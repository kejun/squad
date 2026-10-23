import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { WebError, type WebService } from "./service.js";
import type { Submission } from "../engine.js";

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
        // Local application: mutations must originate from this host, including through Vite's proxy.
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host)
          throw new WebError(403, "请求来源不受支持。");
        if (req.method === "GET" && url.pathname === "/api/rooms")
          return json(res, { rooms: service.rooms() });
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
        const match = /^\/api\/rooms\/([^/]+)(?:\/(messages|stop))?$/.exec(
          url.pathname,
        );
        if (!match?.[1]) throw new WebError(404, "接口不存在。");
        const roomId = decodeURIComponent(match[1]);
        if (req.method === "GET" && !match[2])
          return json(res, service.snapshot(roomId));
        if (req.method === "POST" && match[2]) {
          const data = await body(req);
          if (typeof data.id !== "string" || !data.id || data.id.length > 120)
            throw new WebError(400, "缺少请求标识。");
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
      if (!res.headersSent)
        json(
          res,
          {
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
