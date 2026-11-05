import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const git = (args: string[]) => spawnSync("git", ["--no-optional-locks", ...args],
  { cwd: sourceRoot, encoding: "utf8", timeout: 2000, maxBuffer: 1_000_000 });
const revision = git(["rev-parse", "HEAD"]);
const status = revision.status === 0 ? git(["status", "--porcelain", "--untracked-files=normal"]) : undefined;
const service = new WebService(
  config,
  process.env.WEB_DATABASE ?? "team.sqlite",
  undefined,
  undefined,
  process.env.SQUAD_DEBUG === "1" || process.env.SQUAD_DEBUG === "true",
  runtime,
  {
    ...(revision.status === 0 ? { commit: revision.stdout.trim() } : {}),
    ...(status?.status === 0 ? { dirty: status.stdout.length > 0 } : {}),
    ...(process.env.SQUAD_MEASUREMENT_DATASET ? { dataset: process.env.SQUAD_MEASUREMENT_DATASET } : {}),
  },
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
