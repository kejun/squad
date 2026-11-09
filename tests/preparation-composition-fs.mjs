import * as native from 'node:fs/promises';
import { resolve, sep } from 'node:path';
export * from 'node:fs/promises';
const root = resolve(process.env.PREPARATION_ROOT ?? '/unused');
const mode = process.env.PREPARATION_BARRIER ?? '';
let used = false;
async function barrier(point, metadata = {}) {
  if (used || mode !== point) return;
  used = true;
  if (!process.send) throw new Error('Preparation barrier requires an IPC parent');
  await new Promise((done, reject) => {
    const onMessage = message => {
      if (message?.type !== 'release') return;
      process.off('message', onMessage); done();
    };
    process.on('message', onMessage);
    process.send({ type: 'barrier', point, ...metadata }, error => { if (error) reject(error); });
  });
}
export async function copyFile(source, target, ...options) {
  const value = await native.copyFile(source, target, ...options);
  const name = String(target);
  if (name.startsWith(root + sep) && name.includes('.pending-')) await barrier('skill-copy', { source: String(source), target: name });
  if (name.startsWith(root + sep) && name.includes(`${sep}copies${sep}`)) await barrier('workspace-copy', { source: String(source), target: name });
  return value;
}
export async function rename(source, target) {
  const name = String(source);
  if (name.startsWith(root + sep) && name.includes('.pending-')) await barrier('skill-before-publish', { source: name, target: String(target) });
  const value = await native.rename(source, target);
  if (name.startsWith(root + sep) && name.includes('.pending-')) await barrier('skill-after-publish', { source: name, target: String(target) });
  return value;
}
export async function writeFile(path, ...options) {
  const name = String(path);
  const marker = name.startsWith(root + sep) && name.includes(`${sep}copies${sep}`) && name.endsWith('.json');
  if (marker) await barrier('workspace-before-marker', { target: name });
  const value = await native.writeFile(path, ...options);
  if (marker) await barrier('workspace-after-marker', { target: name });
  return value;
}
