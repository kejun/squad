import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const preparationCases = ['技能并发加载', '技能复制变化后重试', '技能发布前进程丢失', '技能发布后进程丢失',
  '副本复制变化后重试', '副本标记前进程丢失', '副本标记后进程丢失', '检查副本标记后进程丢失'] as const;
export type PreparationCase = typeof preparationCases[number];
interface ChildMessage { type: string; point?: string; result?: unknown; failure?: { message: string }; reason?: string }
interface ChildProof { mode: string; messages: ChildMessage[]; code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, '..');
const skillBody = '---\nname: preparation-check\ndescription: Preparation fixture\n---\nRead references/guide.md before scripts/run.mjs.\n';
async function createFixture(checking = false) {
  const root = await mkdtemp(join(tmpdir(), 'squad-preparation-'));
  await mkdir(join(root, 'skills/preparation-check/references'), { recursive: true });
  await mkdir(join(root, 'skills/preparation-check/scripts'), { recursive: true });
  await writeFile(join(root, 'skills/preparation-check/SKILL.md'), skillBody);
  await writeFile(join(root, 'skills/preparation-check/references/guide.md'), 'immutable preparation guide');
  await writeFile(join(root, 'skills/preparation-check/scripts/run.mjs'), 'throw new Error("preparation must never run this script");\n');
  await mkdir(join(root, 'source'));
  await writeFile(join(root, 'source/a.txt'), 'alpha'); await writeFile(join(root, 'source/z.txt'), 'omega');
  await writeFile(join(root, 'source/.env'), 'PREPARATION_PRIVATE_FILE=not-copyable');
  if (checking) {
    await writeFile(join(root, 'source/package.json'), JSON.stringify({ private: true, scripts: { build: 'node build.mjs' } }));
    await writeFile(join(root, 'source/build.mjs'), 'console.log("build-fixture");\n');
  }
  return root;
}
async function removeFixture(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await removeFixture(join(root, entry.name));
  await rm(root, { recursive: true, force: true });
}
function childRun(root: string, kind: string, mode: string, crash: boolean, changed: boolean): Promise<ChildProof> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', join(here, 'preparation-composition-loader.mjs'),
      join(here, 'preparation-composition-child.ts'), kind], { cwd: rootDir, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:MODEL_|A_MODEL_|B_MODEL_|BUILDER_[123]_MODEL_|FACILITATOR_MODEL_|CHECK_MODEL_|INTENT_MODEL_)/.test(key))), PREPARATION_ROOT: root,
        PREPARATION_BARRIER: mode, PREPARATION_EXPECT_CHANGE: changed ? 'yes' : 'no' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const proof: ChildProof = { mode, messages: [], code: null, signal: null, stdout: '', stderr: '' };
    let handlerError: Error | undefined;
    const stop = (error: unknown) => { handlerError = error instanceof Error ? error : new Error(String(error)); child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop(new Error(`Preparation child exceeded 20s: ${kind}/${mode}`)), 20_000);
    child.stdout!.on('data', chunk => { proof.stdout = (proof.stdout + String(chunk)).slice(-4000); });
    child.stderr!.on('data', chunk => { proof.stderr = (proof.stderr + String(chunk)).slice(-4000); });
    child.on('error', stop);
    child.on('message', message => {
      const event = message as ChildMessage; proof.messages.push(event);
      void (async () => {
        if (event.type === 'barrier') {
          if (crash) { assert(child.kill('SIGKILL')); return; }
          const source = kind === 'skill' ? 'skills/preparation-check/references/guide.md' : 'source/z.txt';
          await writeFile(join(root, source), 'changed while preparation was in progress'); child.send({ type: 'release' });
        }
        if (event.type === 'retry-ready') {
          const source = kind === 'skill' ? 'skills/preparation-check/references/guide.md' : 'source/z.txt';
          await writeFile(join(root, source), kind === 'skill' ? 'immutable preparation guide' : 'omega'); child.send({ type: 'retry' });
        }
      })().catch(stop);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer); proof.code = code; proof.signal = signal;
      if (handlerError) reject(Object.assign(handlerError, { childProof: proof })); else done(proof);
    });
  });
}
const scenarios: Record<PreparationCase, { kind: string; mode: string; crash?: boolean; changed?: boolean }> = {
  技能并发加载: { kind: 'skill', mode: '' },
  技能复制变化后重试: { kind: 'skill', mode: 'skill-copy', changed: true },
  技能发布前进程丢失: { kind: 'skill', mode: 'skill-before-publish', crash: true },
  技能发布后进程丢失: { kind: 'skill', mode: 'skill-after-publish', crash: true },
  副本复制变化后重试: { kind: 'workspace', mode: 'workspace-copy', changed: true },
  副本标记前进程丢失: { kind: 'workspace', mode: 'workspace-before-marker', crash: true },
  副本标记后进程丢失: { kind: 'workspace', mode: 'workspace-after-marker', crash: true },
  检查副本标记后进程丢失: { kind: 'check-workspace', mode: 'workspace-after-marker', crash: true },
};
export async function preparationComposition(scenario: PreparationCase) {
  assert(Object.hasOwn(scenarios, scenario), `Unknown preparation scenario: ${scenario}`);
  const specification = scenarios[scenario]; const root = await createFixture(specification.kind === 'check-workspace');
  const proof: { scenario: string; scope: string; status: string; runs: ChildProof[]; sourceHashes: Record<string, string>; cleanup: boolean; failure?: string } = {
    scenario, scope: 'Real temporary filesystem and real child process; controlled non-spawning CLI backend; no OS sandbox claim',
    status: 'running', runs: [], sourceHashes: {}, cleanup: false };
  for (const path of ['src/local-skills.ts', 'src/local-runtime.ts']) proof.sourceHashes[path] = createHash('sha256').update(await readFile(join(rootDir, path))).digest('hex');
  try {
    proof.runs.push(await childRun(root, specification.kind, specification.mode, !!specification.crash, !!specification.changed));
    const initial = proof.runs[0]!;
    if (specification.mode) assert(initial.messages.some(message => message.type === 'barrier' && message.point === specification.mode), 'The intended real filesystem barrier must be reached');
    if (specification.crash) {
      assert.equal(initial.signal, 'SIGKILL', 'The host must actually lose its child process');
      proof.runs.push(await childRun(root, specification.kind, '', false, false));
    }
    const completed = proof.runs.at(-1)!;
    assert.equal(completed.code, 0, `${scenario}: ${completed.messages.find(message => message.type === 'failure')?.failure?.message ?? completed.stderr}`);
    assert(completed.messages.some(message => message.type === 'complete'), 'A successful public-interface result is required');
    proof.status = 'passed';
    return proof;
  } catch (error) { proof.status = 'failed'; proof.failure = String(error); throw error; }
  finally {
    await removeFixture(root); proof.cleanup = true;
    const evidence = resolve(process.env.PREPARATION_EVIDENCE ?? join(rootDir, 'reports/kej-108-preparation'));
    await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, `${scenario}.json`), JSON.stringify(proof, null, 2));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = process.argv[2] === '--all' ? preparationCases : [process.argv[2] as PreparationCase];
  let failures = 0;
  for (const scenario of selected) {
    try { await preparationComposition(scenario); console.log(JSON.stringify({ scenario, status: 'passed' })); }
    catch (error) { failures++; console.error(JSON.stringify({ scenario, status: 'failed', failure: String(error) })); }
  }
  if (failures) process.exitCode = 1;
}
