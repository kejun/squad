import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["--import", "tsx", "scripts/web.ts"], {
    stdio: "inherit",
    env: { ...process.env, SQUAD_DEBUG: process.env.SQUAD_DEBUG ?? "1" },
  }),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "web/vite.config.ts"],
    { stdio: "inherit" },
  ),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
for (const child of children)
  child.once("exit", (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
