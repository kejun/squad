import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxCliBackend, minimalCliEnvironment } from '../src/local-cli.js';

/** Production SRT backend, never the injected process fixture. Exit 78 means host unavailable. */
const root = await mkdtemp(join(tmpdir(), 'squad-os-sandbox-'));
process.env.SRT_PRIVATE_SENTINEL = 'must-not-inherit';
const backend = await SandboxCliBackend.create();
try {
  if (!backend.available) {
    console.error(`CLI_SANDBOX_UNAVAILABLE: ${backend.unavailableReason}`); process.exitCode = 78;
  } else {
    const workspace = join(root, 'workspace'), snapshot = join(root, 'skill'); await mkdir(workspace); await mkdir(snapshot);
    await mkdir(join(workspace, '.home')); await mkdir(join(workspace, '.tmp'));
    const secret = join(root, 'private.txt'); await writeFile(secret, 'must-not-read'); await writeFile(join(snapshot, 'readonly.txt'), 'skill-body');
    const program = `const fs=require('fs'),net=require('net');
      fs.writeFileSync('output.txt','workspace-write-ok');
      for(const path of ${JSON.stringify([secret, join(workspace, '.env')])}) { try { fs.readFileSync(path); process.exit(11); } catch{} }
      try { fs.writeFileSync(${JSON.stringify(join(snapshot, 'readonly.txt'))},'overwritten'); process.exit(12); } catch{}
      if(fs.readFileSync(${JSON.stringify(join(snapshot, 'readonly.txt'))},'utf8')!=='skill-body')process.exit(13);
      if(process.env.SQUAD_SANDBOX_TEST_SECRET || process.env.SRT_PRIVATE_SENTINEL)process.exit(14);
      const s=net.connect({host:'1.1.1.1',port:80});s.on('connect',()=>process.exit(15));s.on('error',()=>{console.log('boundaries-ok');process.exit(0)});setTimeout(()=>{console.log('boundaries-ok');process.exit(0)},500);`;
    await writeFile(join(workspace, '.env'), 'secret');
    const completion = await backend.execute({ executable: process.execPath, args: ['-e', program], workspace, cwd: workspace, skillPath: snapshot,
      env: minimalCliEnvironment(workspace), timeoutMs: 5000, sessionId: 'verify-os-boundaries', logPath: join(root, 'output.log') }, new AbortController().signal, async () => {});
    assert(completion.settled); assert(completion.result.ok, JSON.stringify(completion.result)); assert(String(completion.result.data.stdout).includes('boundaries-ok'));
    assert.equal(await readFile(join(workspace, 'output.txt'), 'utf8'), 'workspace-write-ok'); console.log('OS sandbox file, snapshot-write, credential and network boundaries passed');
  }
} finally { await backend.close(); await rm(root, { recursive: true, force: true }); }
