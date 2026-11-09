import { registerHooks } from 'node:module';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
let applied = false;
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!new URL(url).pathname.endsWith('/src/model-adapter.ts')) return result;
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
  const changed = source.replace(/readSuccessBody\(response,\s*service\.maxResponseBytes\s*\?\?\s*8\s*\*\s*1024\s*\*\s*1024,\s*requestSignal\)/,
    'readSuccessBody(response, Number.MAX_SAFE_INTEGER, requestSignal)');
  if (changed === source) throw new Error('response-byte-limit fault did not match');
  applied = true;
  appendFileSync(process.env.MODEL_RESPONSE_FAULT_PROOF, JSON.stringify({ fault: 'remove-response-byte-limit',
    originalHash: createHash('sha256').update(source).digest('hex'), mutatedHash: createHash('sha256').update(changed).digest('hex') }) + '\n');
  return { ...result, source: changed };
} });
process.on('exit', () => { if (!applied) process.stderr.write('RESPONSE_LIMIT_FAULT_NOT_APPLIED\n'); });
