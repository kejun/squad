import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseCliCatalog } from "../src/cli-catalog.js";
import { parseCliAcquisitionReaders } from '../src/acquisition-readers.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from "node:url";
import { LocalRuntime } from "../src/local-runtime.js";
import { delimiter, dirname, join, resolve } from "node:path";
import { config as baseConfig } from "../team.config.js";
import { createWebServer } from "../src/web/http.js";
import { WebService } from "../src/web/service.js";

const port = Number(process.env.WEB_PORT ?? 4318);
const cliCatalog = process.env.SQUAD_CLI_CATALOG_FILE ? parseCliCatalog(JSON.parse(await readFile(process.env.SQUAD_CLI_CATALOG_FILE, 'utf8'))) : undefined;
async function acquisitionReadersFromFile() {
  if (!process.env.SQUAD_ACQUISITION_READERS_FILE) return undefined;
  try {
    const text = await readFile(process.env.SQUAD_ACQUISITION_READERS_FILE, 'utf8');
    if (Buffer.byteLength(text) > 1_000_000) throw new Error('CONFIGURATION_TOO_LARGE');
    return parseCliAcquisitionReaders(JSON.parse(text));
  } catch { throw new Error('正文校验器配置无效，请检查 SQUAD_ACQUISITION_READERS_FILE；未读取或执行任何正文。'); }
}
const acquisitionReaders = await acquisitionReadersFromFile();
const canonicalConfiguration = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonicalConfiguration).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalConfiguration((value as Record<string, unknown>)[key])}`).join(',')}}`;
const config = cliCatalog !== undefined || acquisitionReaders !== undefined ? { ...baseConfig,
  toolVersion: `${baseConfig.toolVersion}:${createHash('sha256').update(canonicalConfiguration({ cliCatalogConfigured: cliCatalog !== undefined,
    acquisitionReadersConfigured: acquisitionReaders !== undefined, cliCatalog: cliCatalog ?? [], acquisitionReaders: acquisitionReaders ?? [] })).digest('hex')}` } : baseConfig;
const runtime = await LocalRuntime.create({
  dataRoot: process.env.SQUAD_LOCAL_DATA_DIR ?? join(dirname(resolve(process.env.WEB_DATABASE ?? "team.sqlite")), ".squad-local"),
  ...(config.localTools?.enabled === false ? { skillRoots: [], backend: { available: false, execute: async () => { throw new Error('LOCAL_TOOLS_DISABLED'); } } }
    : process.env.SQUAD_LOCAL_SKILLS_ROOTS ? { skillRoots: process.env.SQUAD_LOCAL_SKILLS_ROOTS.split(delimiter).filter(Boolean) } : {}),
  ...(process.env.SQUAD_WORKSPACE_ROOT ? { workspaceRoot: process.env.SQUAD_WORKSPACE_ROOT } : {}),
  ...(cliCatalog !== undefined ? { cliCatalog } : {}),
  ...(acquisitionReaders !== undefined ? { acquisitionReaders } : {}),
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
