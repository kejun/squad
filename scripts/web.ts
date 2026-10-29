import { LocalRuntime } from "../src/local-runtime.js";
import { delimiter, dirname, join, resolve } from "node:path";
import { config } from "../team.config.js";
import { createWebServer } from "../src/web/http.js";
import { WebService } from "../src/web/service.js";

const port = Number(process.env.WEB_PORT ?? 4318);
const runtime = config.localTools?.enabled === false ? undefined : await LocalRuntime.create({
  dataRoot: process.env.SQUAD_LOCAL_DATA_DIR ?? join(dirname(resolve(process.env.WEB_DATABASE ?? "team.sqlite")), ".squad-local"),
  ...(process.env.SQUAD_LOCAL_SKILLS_ROOTS ? { skillRoots: process.env.SQUAD_LOCAL_SKILLS_ROOTS.split(delimiter).filter(Boolean) } : {}),
  ...(process.env.SQUAD_WORKSPACE_ROOT ? { workspaceRoot: process.env.SQUAD_WORKSPACE_ROOT } : {}),
  redact: Object.values(config.models?.services ?? {}).flatMap(model => model.apiKeyEnv && process.env[model.apiKeyEnv] ? [process.env[model.apiKeyEnv]!] : []),
});
if (runtime) console.log(`Local skills: ${runtime.catalog().skills.length} on first page; CLI sandbox: ${runtime.backend.available ? "ready" : "unavailable"}`);
const service = new WebService(
  config,
  process.env.WEB_DATABASE ?? "team.sqlite",
  undefined,
  undefined,
  process.env.SQUAD_DEBUG === "1" || process.env.SQUAD_DEBUG === "true",
  runtime,
);
await service.ready();
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
  await runtime?.close();
}
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
