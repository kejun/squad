#!/usr/bin/env python3
"""Bounded authority checking; never executes a command against a real host."""
import importlib.util, sys
sys.dont_write_bytecode = True
import re
import argparse, datetime, hashlib, json, os, pathlib, shutil, subprocess, tempfile, difflib
HERE=pathlib.Path(__file__).resolve().parent
ROOT=HERE.parents[3]
JAR_SHA='936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p,v): p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
def verify(path):
 manifest=json.loads((path/'artifacts.json').read_text())
 required=['run.json','checker-inputs/scripts/check.py','checker-inputs/scripts/replay.mjs','checker-inputs/scripts/scenarios.mjs','checker-inputs/scripts/runtime-binding.mjs','checker-inputs/references/coverage.json','runtime-binding.json','runtime-binding-restored.json']
 for name in ['one-use','approval-identity','lease-exclusion','approval-expiry','session-namespace']:
  for backend in ['memory','sqlite']:required += [f'negative-controls/{name}/{backend}.log']
 required += ['negative-controls/command-digest/runtime.log']
 for d in ['host','execution','session']: required += [f'{d}/tlc.log',f'{d}/graph.dot',f'{d}/replay.json',f'{d}/restored.json']
 assert all(p in manifest for p in required),'Incomplete evidence manifest'
 assert manifest and all((path/k).is_file() and sha(path/k)==v for k,v in manifest.items()), 'Evidence modified or missing'
 report=json.loads((path/'run.json').read_text())
 assert len(report['steps'])==34, 'Incomplete verification steps'
 for step in report['steps']:
  log=(path/step['log']).read_text();assert log and 'timeout' not in step
  if step['log'].startswith('negative-controls/'):
   assert step['exitCode']!=0 and 'Authority:' in log and 'AssertionError' in log, 'Negative control did not fail on behavior'
  elif step['log'].startswith('model-negative/'):
   assert step['exitCode']!=0 and 'Invariant NoUnauthorizedStart is violated' in log
  elif step['log'].startswith('reachability/'):
   assert step['exitCode']!=0 and 'Invariant ' in log and ' is violated' in log
  else:assert step['exitCode']==0, 'Baseline or restored run failed'
 assert report['status']=='verified' and report['cleanup'] and report['coveredFilesUnchanged']
 for domain in ['execution','host']:
  log=(path/domain/'tlc.log').read_text()
  assert 'Model checking completed. No error has been found.' in log and '0 states left on queue' in log
  replay=json.loads((path/domain/'replay.json').read_text())
  assert replay['edges']>0 and replay['states']>0 and {o['backend'] for o in replay['observations']}=={'memory','sqlite'}
 session_log=(path/'session/tlc.log').read_text();assert 'Model checking completed. No error has been found.' in session_log and '0 states left on queue' in session_log
 session=json.loads((path/'session/replay.json').read_text());assert session['scopeStates']==512 and len(session['records'])==1044
 runtime=json.loads((path/'runtime-binding.json').read_text());assert runtime['status']=='passed' and len(runtime['records'])==10
 print('Evidence verified:',path)
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--jar',default=os.environ.get('TLA2TOOLS_JAR',str(pathlib.Path(os.environ.get('XDG_CACHE_HOME',pathlib.Path.home()/'.cache'))/'squad-formal/tla2tools-1.7.4.jar')));ap.add_argument('--evidence');ap.add_argument('--verify-evidence');a=ap.parse_args()
 if a.verify_evidence: verify(pathlib.Path(a.verify_evidence).resolve());return
 out=pathlib.Path(a.evidence).resolve() if a.evidence else ROOT/'reports'/'verify-squad-authority'/datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
 out.mkdir(parents=True,exist_ok=False)
 report={'status':'running','cleanup':False,'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),'workingTree':subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True),'steps':[]}
 coverage=json.loads((HERE.parent/'references'/'coverage.json').read_text())
 before={p:sha(ROOT/p) for p in coverage['files']}
 try:
  assert before==coverage['files'],'Covered source drift: review correspondence before updating hashes'
  helper=HERE.parents[1]/'verify-squad-handoff/scripts/check.py'
  spec=importlib.util.spec_from_file_location('handoff_helper',helper);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  jar=module.jar_at(pathlib.Path(a.jar).resolve());assert sha(jar)==JAR_SHA,'Pinned TLC JAR SHA mismatch'
  inputs=out/'checker-inputs';shutil.copytree(HERE,inputs/'scripts',ignore=shutil.ignore_patterns('__pycache__'));shutil.copytree(HERE.parent/'references',inputs/'references');shutil.copy(HERE.parent/'SKILL.md',inputs/'SKILL.md')
  def run(cmd,log,cwd=ROOT,negative=None):
   log.parent.mkdir(parents=True,exist_ok=True)
   try: p=subprocess.run([str(x) for x in cmd],cwd=cwd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=90)
   except subprocess.TimeoutExpired as error:
    raw=error.stdout or b'';log.write_text(raw.decode(errors='replace') if isinstance(raw,bytes) else raw);report['steps'].append({'command':[str(x) for x in cmd],'timeout':90,'log':str(log.relative_to(out))});raise
   log.write_text(p.stdout);report['steps'].append({'command':[str(x) for x in cmd],'exitCode':p.returncode,'log':str(log.relative_to(out))})
   if negative: assert p.returncode!=0 and negative in p.stdout, f'Negative control missed or wrong failure: {log}'
   else: assert p.returncode==0,f'Failed: {log}'
   return p.stdout
  def tlc(domain,dest,reach=None,fault=None):
   dest.mkdir(parents=True,exist_ok=True);shutil.copy(HERE/'Authority.tla',dest/'Authority.tla')
   cfg=(HERE/f'{domain}.cfg').read_text()+(f'INVARIANT {reach}\n' if reach else '')
   assert 'INVARIANTS TypeOK OneStart NoUnauthorizedStart' in cfg, 'Missing required authority invariants'
   assert 'SPECIFICATION Spec' in cfg, 'Missing authority specification'
   if fault: cfg=cfg.replace('Fault = "none"',f'Fault = "{fault}"')
   (dest/'check.cfg').write_text(cfg)
   cmd=['java','-XX:+UseParallelGC','-Xmx512m','-cp',jar,'tlc2.TLC','-seed','1','-workers','1','-config','check.cfg','-dump','dot,actionlabels','graph.dot','Authority.tla']
   log=run(cmd,dest/'tlc.log',dest,f'Invariant {reach} is violated' if reach else ('Invariant NoUnauthorizedStart is violated' if fault else None))
   counts=re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue',log)
   write(dest/'result.json',{'domain':domain,'witness':reach,'fault':fault,'counts':[[int(v.replace(',','')) for v in c] for c in counts]})
   if not reach and not fault: assert 'Model checking completed. No error has been found.' in log and '0 states left on queue' in log
  for domain in ['execution','host']:
   dest=out/domain;tlc(domain,dest)
   tlc(domain,out/'model-negative'/domain,fault='revocation')
   run(['node','--import','tsx',HERE/'replay.mjs',ROOT,dest/'graph.dot',domain,dest/'replay.json'],dest/'replay.log')
   for witness in ['StartedReachable','RevokedReachable','RecoveredReachable']+(['ApprovedReachable','LeaseReachable'] if domain=='host' else []):tlc(domain,out/'reachability'/f'{domain}-{witness}',witness)
  session=out/'session';session.mkdir()
  shutil.copy(HERE/'SessionScope.tla',session/'SessionScope.tla')
  assert 'INVARIANT ScopeBound' in (HERE/'session.cfg').read_text() and 'SPECIFICATION Spec' in (HERE/'session.cfg').read_text(), 'Missing required scope property'
  shutil.copy(HERE/'session.cfg',session/'check.cfg')
  session_cmd=['java','-XX:+UseParallelGC','-Xmx512m','-cp',jar,'tlc2.TLC','-seed','1','-workers','1','-config','check.cfg','-dump','dot,actionlabels','graph.dot','SessionScope.tla']
  session_log=run(session_cmd,session/'tlc.log',session)
  assert 'Model checking completed. No error has been found.' in session_log and '0 states left on queue' in session_log
  run(['node','--import','tsx',HERE/'scenarios.mjs',ROOT,session/'graph.dot',session/'replay.json'],session/'replay.log')
  for witness in ['UsableReachable','RevokedReachable']:
   dest=out/'reachability'/f'session-{witness}';dest.mkdir()
   shutil.copy(HERE/'SessionScope.tla',dest/'SessionScope.tla')
   (dest/'check.cfg').write_text((HERE/'session.cfg').read_text()+f'INVARIANT {witness}\n')
   run(session_cmd,dest/'tlc.log',dest,f'Invariant {witness} is violated')
  run(['node','--import','tsx',HERE/'runtime-binding.mjs',ROOT,out/'runtime-binding.json'],out/'runtime-binding.log')
  mutations=[('command-digest','digest','src/local-runtime.ts',"if (op.approval.digest !== commandDigest) throw new LocalToolError('HOST_APPROVAL_STALE');",''),('session-namespace','session','src/host-session.ts','g.namespace === op.namespace && ',''),('one-use','execution','src/task.machine.ts',"if (executionState(snapshot, intentId, attempt) !== 'authorized') return { snapshot, allowed: false };",''),('approval-identity','host','src/local-operation.ts',"if (op.approval.id !== event.approvalId) return 'HOST_APPROVAL_MISMATCH';",''),('lease-exclusion','host','src/local-operation.ts',"if (['runCli', 'verifyWorkspace'].includes(op.action.type) && !event.leaseAvailable) return 'WORKSPACE_BUSY';",''),('approval-expiry','host','src/local-operation.ts',"if (op.approval && e.at >= op.approval.expiresAt) return 'HOST_APPROVAL_EXPIRED';",'')]
  for name,domain,file,old,new in mutations:
   with tempfile.TemporaryDirectory(prefix='squad-authority-') as tmp:
    target=pathlib.Path(tmp);shutil.copytree(ROOT/'src',target/'src');(target/'tests').mkdir();shutil.copy(ROOT/'tests/local-model-fixture.ts',target/'tests/local-model-fixture.ts');shutil.copy(ROOT/'package.json',target/'package.json');(target/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
    p=target/file;original=p.read_text();assert original.count(old)==1;modified=original.replace(old,new);p.write_text(modified)
    dest=out/'negative-controls'/name;dest.mkdir(parents=True)
    (dest/'mutation.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True),modified.splitlines(True),fromfile=file,tofile=file)))
    for backend in (['runtime'] if domain=='digest' else ['memory','sqlite']):
     command=['node','--import','tsx',HERE/'runtime-binding.mjs',target,dest/f'{backend}.json'] if domain=='digest' else ['node','--import','tsx',HERE/'scenarios.mjs',target,out/'session/graph.dot',dest/f'{backend}.json',backend] if domain=='session' else ['node','--import','tsx',HERE/'replay.mjs',target,out/domain/'graph.dot',domain,dest/f'{backend}.json',backend]
     run(command,dest/f'{backend}.log',negative=f'Authority:{domain}:')
  for domain in ['execution','host']:
   run(['node','--import','tsx',HERE/'replay.mjs',ROOT,out/domain/'graph.dot',domain,out/domain/'restored.json'],out/domain/'restored.log')
  run(['node','--import','tsx',HERE/'scenarios.mjs',ROOT,out/'session/graph.dot',out/'session/restored.json'],out/'session/restored.log')
  run(['node','--import','tsx',HERE/'runtime-binding.mjs',ROOT,out/'runtime-binding-restored.json'],out/'runtime-binding-restored.log')
  report['coveredFilesUnchanged']=before=={p:sha(ROOT/p) for p in before};assert report['coveredFilesUnchanged'];report['cleanup']=True;report['status']='verified'
 except Exception as e:
  report['status']='blocked';report['error']=str(e);raise
 finally:
  write(out/'run.json',report);write(out/'artifacts.json',{str(p.relative_to(out)):sha(p) for p in out.rglob('*') if p.is_file() and p.name!='artifacts.json' and 'states' not in p.relative_to(out).parts})
 verify(out)
if __name__=='__main__':main()
