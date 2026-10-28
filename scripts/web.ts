import { resolve } from "node:path";
import { config } from "../team.config.js";
import { createWebServer } from "../src/web/http.js";
import { WebService } from "../src/web/service.js";

const port = Number(process.env.WEB_PORT ?? 4318);
const service = new WebService(
  config,
  process.env.WEB_DATABASE ?? "team.sqlite",
  undefined,
  undefined,
  process.env.SQUAD_DEBUG === "1" || process.env.SQUAD_DEBUG === "true",
);
const server = createWebServer(service, resolve("dist/web"));
server.listen(port, "127.0.0.1", () =>
  console.log(`Squad API: http://127.0.0.1:${port}`),
);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await service.close();
}
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
