import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OpenAICompatibleAdapter } from '../src/model-adapter.js';
import { WorkRunner } from '../src/runner.js';
import type { WebTools } from '../src/web-tools.js';
import type { LocalAction } from '../src/local-operation.js';
import { LocalFixture } from './local-tools-fixture.js';
import { modelResponse } from './model-regeneration-fixture.js';

type Token = 'search' | 'fetch' | 'skills' | 'local' | 'invalid';
interface SessionEvidence { sequence: Token[]; modelRequests: number; repairs: number; acquired: string[]; calls: Record<string, number>; cleanOtherRoom: boolean }
const invalidMarker = 'INVALID_SESSION_BODY_MUST_NOT_BE_RETAINED';
function sequences(): Token[][] {
  const tools: Token[] = ['search', 'fetch', 'skills', 'local'];
  const generated: Token[][] = [];
  for (const first of tools) for (const second of tools) for (const index of [0,1,2]) {
    const tokens = [first,second]; tokens.splice(index,0,'invalid'); generated.push(tokens);
  }
  return generated;
}
async function runSequence(sequence: Token[], ordinal: number): Promise<SessionEvidence> {
  const f = await LocalFixture.create();
  const acquired: string[] = [], calls = { search: 0, fetch: 0, skills: 0 };
  const marker = `COMPOSED_SESSION_${ordinal}_`;
  const requests: { messages: {role: string; content: string}[] }[] = [];
  const expectedLocal = sequence.filter(item => item === 'local').length * 2;
  const actions: unknown[] = sequence.flatMap<unknown>(token => token === 'search' ? [{ type: 'web_search', query: marker+'SEARCH' }]
    : token === 'fetch' ? [{ type: 'web_fetch', url: 'https://example.com/'+marker+'FETCH' }]
    : token === 'skills' ? [{ type: 'findSkills', query: marker+'SKILLS' }]
    : token === 'local' ? [{ type: 'loadSkill', skillId: f.skillId }, { type: 'readSkillResource', skillId: f.skillId, path: 'references/guide.md' } satisfies LocalAction]
    : [{ type: 'deliver', text: invalidMarker }]);
  actions.push({ type: 'answer', text: marker+'FINAL' });
  let cursor = 0, observationFailure: string | undefined;
  const transport: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as typeof requests[number];
    const serialized = JSON.stringify(request.messages);
    try {
      for (const value of acquired) assert(serialized.includes(value), 'SessionEvidence: completed tool data disappeared');
      assert(!serialized.includes(invalidMarker), 'InvalidBodyIsolation: invalid provider body echoed');
      requests.push(request);
      assert(cursor < actions.length, 'Sequence model replies exhausted');
      return modelResponse(actions[cursor++]);
    } catch (error) { observationFailure = String(error); throw error; }
  };
  const web: WebTools = {
    search: async input => {
      calls.search++; const text = marker+'SEARCH_RESULT'; acquired.push(text);
      return { output: { items: [{ url: 'https://example.com/source', title: text }], metadata: { query: input.query, requestId: marker+'search', latencyMs: 0 } }, text };
    },
    fetch: async input => {
      calls.fetch++; const text = marker+'FETCH_RESULT'; acquired.push(text);
      return { output: { url: input.url, finalUrl: input.url, status: 200, contentType: 'text/plain', via: 'text', content: text,
        totalChars: text.length, headers: {}, bytes: Buffer.byteLength(text), redirects: [], offset: 0, nextOffset: null }, text };
    },
  };
  const skills: typeof fetch = async () => {
    calls.skills++; const name = marker+'SKILLS_RESULT'; acquired.push(name);
    return Response.json({ skills: [{ id: 'composed', name, source: 'example/repo', installs: 1 }] });
  };
  try {
    const adapter = new OpenAICompatibleAdapter(f.h.config, { clock: () => f.h.now, transport });
    const runner = new WorkRunner(f.h.engine, adapter, () => f.h.now, skills, web, f.runtime);
    assert(await runner.runOne(f.h.room,f.h.task));
    assert.equal(observationFailure, undefined, observationFailure);
    const context = f.h.context(), work = context.intents.find(item => item.kind === 'owner')!;
    assert.equal(context.candidate?.text,marker+'FINAL','FinalOutput: only valid final answer applied');
    assert.equal(context.trace.filter(event => event.event === 'MODEL_OUTPUT_REPAIR').length,sequence.filter(item => item === 'invalid').length);
    assert.equal(calls.search,sequence.filter(item => item === 'search').length,'NoImplicitReplay: search repeated by format repair');
    assert.equal(calls.fetch,sequence.filter(item => item === 'fetch').length,'NoImplicitReplay: fetch repeated by format repair');
    assert.equal(calls.skills,sequence.filter(item => item === 'skills').length,'NoImplicitReplay: skills repeated by format repair');
    assert.equal(work.localOperations?.length ?? 0,expectedLocal,'NoImplicitReplay: local reads repeated by format repair');
    assert.equal(f.backend.calls.length,0,'ReadOnlyComposition: no CLI process is needed');
    assert(!JSON.stringify(f.h.store.read(f.h.room)).includes(invalidMarker),'InvalidBodyIsolation: rejected original persisted');
    const localReceipts = work.localOperations?.filter(op => op.action.type === 'readSkillResource') ?? [];
    assert(localReceipts.every(op => op.result?.ok && String(op.result.data.content).includes('真实引用资料')));
    if (expectedLocal) assert(JSON.stringify(requests.at(-1)).includes('真实引用资料'),'SessionEvidence: local receipt missing from final request');
    // A new room/work shares the host runtime, never the first room's transcript.
    const otherRoom = 'other-session-room', submission = f.h.engine.submit(otherRoom,{ id:'other',text:'只回答这次新问题' }); assert(submission.ok);
    let cleanOtherRoom = false;
    const other = new OpenAICompatibleAdapter(f.h.config,{clock:()=>f.h.now,transport:async (_url,init)=>{
      const serialized = String(init?.body); assert(!serialized.includes(marker),'CrossWorkIsolation: another work inherited source results');
      assert(!serialized.includes(invalidMarker)); cleanOtherRoom = true; return modelResponse({type:'answer',text:'独立结果'});
    }});
    assert(await new WorkRunner(f.h.engine,other,()=>f.h.now,skills,web,f.runtime).runOne(otherRoom,submission.taskId!));
    return {sequence,modelRequests:requests.length,repairs:context.usage.retries,acquired,calls,cleanOtherRoom};
  } finally { await f.close(); }
}
export async function modelSessionComposition(generated = false) {
  const selected: Token[][] = generated ? sequences() : [['search','local','invalid','fetch','skills','invalid']];
  const results: SessionEvidence[] = [];
  for (const [index,sequence] of selected.entries()) results.push(await runSequence(sequence,index));
  const directory = process.env.MODEL_SESSION_COMPOSITION_EVIDENCE ?? 'reports/kej-108-model-session';
  await mkdir(directory,{recursive:true});
  const sourceHashes: Record<string,string> = {};
  for (const path of ['src/model-adapter.ts','src/runner.ts','tests/model-session-composition-fixture.ts']) sourceHashes[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  await writeFile(join(directory,generated?'generated.json':'representative.json'),JSON.stringify({sourceHashes,status:'verified',scope:'actual WorkRunner/adapter, scripted network tools, real immutable skill reads; no provider or CLI',sequences:results.length,results},null,2));
  return {sequences:results.length};
}
