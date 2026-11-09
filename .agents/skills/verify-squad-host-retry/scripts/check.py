#!/usr/bin/env python3
"""Host retry finite retirement model + all-action double-store correspondence."""
import argparse
from collections import Counter
import difflib
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

SKILL = Path(__file__).resolve().parents[1]
ROOT = SKILL.parents[2]
JAR_SHA = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
WITNESSES = ['NeverUnknown', 'NeverSuccessor', 'NeverRecovered', 'NeverLateReceipt']
CONTROLS = {
    'retire-unknown': ('NoUnknownAdvance', 'src/host-retry.ts',
        'export function hostRetryBatchRetirable(c: TaskContext): boolean {',
        "export function hostRetryBatchRetirable(c: TaskContext): boolean {\n  if (c.hostRetryBatch && c.intents.some(w => w.id === c.hostRetryBatch!.workId && w.status === 'uncertain')) return true;"),
    'erase-known-receipt': ('PreserveReceipt', 'src/host-retry.ts',
        '  if (work) cancelLocalOperations(work);',
        '  if (work) { cancelLocalOperations(work); for (const op of work.localOperations ?? []) delete op.result; }'),
    'omit-retirement': ('RetirementProjection', 'src/task/lifecycle.ts',
        "    { guard: 'hostRetryBatchRetirable', actions: 'retireHostRetry' },",
        '    /* faulty omission of the enabled retirement */'),
    'duplicate-source-request': ('UniqueSourceRequest', 'src/host-retry.ts',
        '  if (existing) { ok(c, existing.id); return; }',
        '  /* faulty source deduplication omission */'),
}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def write(path, value):
    pending = path.with_suffix(path.suffix + '.part')
    pending.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    pending.replace(path)

def execute(command, cwd, log, timeout=60):
    env = dict(os.environ)
    # Host-injected incomplete profiles are irrelevant to this provider-free slice.
    for key in list(env):
        if re.match(r'^(?:MODEL_|A_MODEL_|B_MODEL_|BUILDER_[123]_MODEL_|FACILITATOR_MODEL_|CHECK_MODEL_|INTENT_MODEL_)', key):
            del env[key]
    started = time.monotonic()
    try:
        done = subprocess.run(command, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        log.write_bytes(error.stdout or b'')
        raise RuntimeError(f'BLOCKED: command timeout ({timeout}s), see {log}') from error
    log.write_bytes(done.stdout)
    return {'command': command, 'exitCode': done.returncode, 'seconds': round(time.monotonic()-started,3)}

def model(jar, area, witness=None):
    area.mkdir(parents=True)
    shutil.copyfile(SKILL/'scripts/HostRetry.tla',area/'HostRetry.tla')
    cfg = (SKILL/'scripts/HostRetry.cfg').read_text()
    assert 'PROPERTY Progress' in cfg and 'NoUnknownAdvance PreserveReceipt UniqueSuccessor' in cfg
    if witness:
        cfg = re.sub(r'^INVARIANTS .*$', 'INVARIANT '+witness,cfg,flags=re.M)
        cfg = re.sub(r'^PROPERTY .*\n?', '',cfg,flags=re.M)
    (area/'HostRetry.cfg').write_text(cfg)
    temporary=area/'java-tmp';temporary.mkdir()
    command=['java',f'-Djava.io.tmpdir={temporary}','-XX:+UseParallelGC','-Xmx512m','-jar',str(jar),'-workers','1','-seed','1','-metadir',str(area/'states'),
        '-dump','dot,actionlabels',str(area/'graph.dot'),'-config','HostRetry.cfg','HostRetry.tla']
    result=execute(command,area,area/'tlc.log',45)
    raw=(area/'tlc.log').read_text()
    counts=re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue',raw)
    result.update(witness=witness, counts=[int(n.replace(',','')) for n in counts[-1]] if counts else None)
    if witness:
        assert result['exitCode'] != 0 and f'Invariant {witness} is violated' in raw, 'Witness must fail for the declared invariant'
    else:
        assert result['exitCode']==0 and 'Model checking completed. No error has been found.' in raw, 'Incomplete/failed TLC run'
        assert result['counts'] and result['counts'][2]==0 and 'Finished checking temporal properties' in raw, 'Missing complete exploration or liveness'
    write(area/'result.json',result)
    return result

def replay(target,graph,output,backend='both'):
    value=execute(['node','--import',str(ROOT/'node_modules/tsx/dist/loader.mjs'),str(SKILL/'scripts/replay.mjs'),str(target),str(graph),str(output),backend],target,output.with_suffix('.log'),60)
    assert output.exists(),'Replay did not reach behavioral report'
    value.update(json.loads(output.read_text()))
    return value

def verify_evidence(area):
    report=json.loads((area/'run.json').read_text())
    assert report['status']=='verified' and all(report['cleanup'].values()), 'Run incomplete or cleanup failed'
    assert sha(area/'artifacts.json')==report['manifestSha256'], 'Manifest changed'
    entries=json.loads((area/'artifacts.json').read_text()); assert entries
    required=set()
    for stage in ['baseline','restored']:
        required.update(f'{stage}/{name}' for name in ['tlc.log','result.json','graph.dot','HostRetry.tla','HostRetry.cfg','replay.json','replay.log','replay.json.jsonl'])
    required.update('inputs/'+name for name in ['scripts-check.py','scripts-replay.mjs','scripts-HostRetry.tla','scripts-HostRetry.cfg','references-coverage.json','references-correspondence.md'])
    for witness in WITNESSES:
        required.update(f'witnesses/{witness}/{name}' for name in ['tlc.log','result.json','graph.dot','HostRetry.tla','HostRetry.cfg'])
    for control in CONTROLS:
        required.add(f'negative-controls/{control}/real-code.diff')
        required.update(f'negative-controls/{control}/{backend}.{suffix}' for backend in ['memory','sqlite'] for suffix in ['json','log'])
    captured_coverage=json.loads((area/'inputs/references-coverage.json').read_text())
    assert captured_coverage['files']==report['coveredHashes'], 'Coverage input disagrees with tested source fingerprints'
    required.update('inputs/implementation/'+name for name in captured_coverage['files'])
    assert required <= set(entries), 'Required raw evidence missing: '+', '.join(sorted(required-set(entries)))
    for name,record in entries.items():
        path=area/name
        assert path.is_file() and path.stat().st_size==record['bytes'] and sha(path)==record['sha256'],f'Evidence changed/missing: {name}'
    for name,expected in captured_coverage['files'].items():
        assert sha(area/'inputs/implementation'/name)==expected, 'Captured implementation differs from tested fingerprint: '+name
    for stage in ['baseline','restored']:
        value=report[stage]
        actual_model=json.loads((area/stage/'result.json').read_text())
        assert actual_model==value['model'] and actual_model['exitCode']==0
        raw=(area/stage/'tlc.log').read_text()
        counts=re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue',raw)
        assert counts, 'Raw TLC counts missing'
        actual_counts=[int(n.replace(',','')) for n in counts[-1]]
        assert actual_counts==actual_model['counts'] and actual_counts[2]==0
        assert 'Finished checking temporal properties' in raw and 'Model checking completed. No error has been found.' in raw
        cfg=(area/stage/'HostRetry.cfg').read_text()
        assert re.search(r'^PROPERTY Progress$',cfg,re.M)
        invariant_line=re.search(r'^INVARIANTS (.*)$',cfg,re.M);assert invariant_line
        assert set(invariant_line[1].split())=={'TypeOK','NoUnknownAdvance','PreserveReceipt','UniqueSuccessor'}, 'Configured proof properties missing'
        replay=json.loads((area/stage/'replay.json').read_text())
        assert all(value['replay'].get(key)==item for key,item in replay.items())
        assert replay['status']=='verified' and value['replay']['exitCode']==0
        assert [item['name'] for item in replay['backends']]==['memory','sqlite']
        graph=(area/stage/'graph.dot').read_text()
        edges=re.findall(r'^(-?\d+) -> (-?\d+) \[label="(\w+)"',graph,re.M)
        nodes=re.findall(r'^(-?\d+) \[label=',graph,re.M)
        assert len(nodes)==replay['graphStates']==actual_counts[1]
        assert len(edges)==replay['graphEdges'] and len(edges)+replay['initialPrefixes']==actual_counts[0]
        assert all(item['edgesReplayed']==len(edges) for item in replay['backends'])
        records=[json.loads(line) for line in (area/stage/'replay.json.jsonl').read_text().splitlines()]
        expected_edges=Counter((backend,source,target,action) for backend in ['memory','sqlite'] for source,target,action in edges)
        actual_edges=Counter((record['backend'],record['from'],record['to'],record['action']) for record in records)
        assert actual_edges==expected_edges, 'Incomplete labeled-edge records for both stores'
        states={node: {key: True if value=='TRUE' else False if value=='FALSE' else int(value)
            for key,value in re.findall(r'(\w+) = (TRUE|FALSE|\d+)',label)}
            for node,label in re.findall(r'^(-?\d+) \[label="((?:\\.|[^"\\])*)"',graph,re.M)}
        initials=[node for node,_label,tail in re.findall(r'^(-?\d+) \[label="((?:\\.|[^"\\])*)"([^\n]*)',graph,re.M) if 'filled' in tail]
        for record in records:
            assert record['actual']==states[record['to']], 'Replay actual state disagrees with raw graph target'
            possible={node for node in initials if states[node]['mode']==record['mode']}
            for action in record['prefix']:
                possible={target for source,target,label in edges if source in possible and label==action}
            assert record['from'] in possible, 'Replay prefix is not a reachable labeled path'

        actual_log=(area/stage/'replay.log').read_text().strip()
        assert json.loads(actual_log)==replay, 'Replay raw log disagrees with JSON'
    assert set(report['witnesses'])==set(WITNESSES)
    for name in WITNESSES:
        actual=json.loads((area/'witnesses'/name/'result.json').read_text())
        assert actual==report['witnesses'][name] and actual['exitCode']!=0 and actual['witness']==name
        assert f'Invariant {name} is violated' in (area/'witnesses'/name/'tlc.log').read_text()
        assert 'INVARIANT '+name in (area/'witnesses'/name/'HostRetry.cfg').read_text()
    assert set(report['negativeControls'])==set(CONTROLS)
    for name,(prop,file,*_) in CONTROLS.items():
        control=report['negativeControls'][name]
        assert control['property']==prop and set(control['stores'])=={'memory','sqlite'}
        diff=(area/'negative-controls'/name/'real-code.diff').read_text()
        assert '--- '+file in diff and '+++ '+file in diff and '@@' in diff and '\n+' in diff, 'Code mutation diff missing'
        for backend in ['memory','sqlite']:
            summary=control['stores'][backend]
            actual=json.loads((area/'negative-controls'/name/(backend+'.json')).read_text())
            raw=(area/'negative-controls'/name/(backend+'.log')).read_text().strip()
            assert json.loads(raw)==actual, 'Raw negative log disagrees with actual JSON'
            assert summary['exitCode']!=0 and summary['command'][-1]==backend
            assert actual['status']=='failed' and 'AssertionError' in actual.get('error','') and prop in actual['error']
            assert all(summary.get(key)==item for key,item in actual.items()), 'Negative summary detached from raw evidence'
    return len(entries)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar',type=Path,default=Path(os.environ.get('TLA2TOOLS_JAR',str(Path.home()/'.cache/squad-formal/tla2tools-1.7.4.jar'))))
    parser.add_argument('--evidence',type=Path)
    parser.add_argument('--verify-evidence',type=Path)
    args=parser.parse_args()
    if args.verify_evidence:
        print(json.dumps({'status':'verified','artifacts':verify_evidence(args.verify_evidence.resolve())}));return 0
    area=(args.evidence or ROOT/'reports/verify-squad-host-retry'/(time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())+f'-{os.getpid()}')).resolve()
    assert not area.exists(),'Refuse to overwrite retained proof';area.mkdir(parents=True)
    inputs=area/'inputs';inputs.mkdir()
    for name in ['scripts/check.py','scripts/replay.mjs','scripts/HostRetry.tla','scripts/HostRetry.cfg','references/coverage.json','references/correspondence.md']:
        source_file=SKILL/name
        if source_file.exists():shutil.copyfile(source_file,inputs/name.replace('/','-'))
    coverage=json.loads((SKILL/'references/coverage.json').read_text())
    for name in coverage['files']:
        captured=inputs/'implementation'/name;captured.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(ROOT/name,captured)
    before={name:sha(ROOT/name) for name in coverage['files']}
    scratch=Path(tempfile.mkdtemp(prefix='squad-host-retry-controls-'))
    started=time.monotonic()
    report={'status':'running','source':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'worktree':subprocess.check_output(['git','status','--porcelain'],cwd=ROOT,text=True).strip(),
        'coveredHashes':before,'syncCommit':coverage['syncCommit'],'bounds':coverage['bounds'],
        'baseline':{},'restored':{},'witnesses':{},'negativeControls':{}}
    try:
        assert before==coverage['files'],'BLOCKED: covered code drift requires correspondence review, never just refresh hashes'
        jar=args.jar.resolve();assert jar.is_file() and sha(jar)==JAR_SHA,'BLOCKED: fixed TLA tools v1.7.4 JAR required'
        report['jar']={'path':str(jar),'sha256':sha(jar)}
        baseline=model(jar,area/'baseline');original=replay(ROOT,area/'baseline/graph.dot',area/'baseline/replay.json')
        assert original['exitCode']==0 and original['status']=='verified','Baseline correspondence failed'
        report['baseline']={'model':baseline,'replay':original}
        for name in WITNESSES: report['witnesses'][name]=model(jar,area/'witnesses'/name,name)
        for name,(prop,file,old,new) in CONTROLS.items():
            clone=scratch/name;clone.mkdir()
            shutil.copytree(ROOT/'src',clone/'src');shutil.copytree(ROOT/'tests',clone/'tests')
            for file_name in ['package.json','tsconfig.json','team.config.ts']:shutil.copyfile(ROOT/file_name,clone/file_name)
            (clone/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
            path=clone/file;source=path.read_text();assert source.count(old)==1,f'Negative anchor drift: {name}'
            changed=source.replace(old,new);path.write_text(changed)
            destination=area/'negative-controls'/name;destination.mkdir(parents=True)
            (destination/'real-code.diff').write_text(''.join(difflib.unified_diff(source.splitlines(True),changed.splitlines(True),fromfile=file,tofile=file)))
            stores={}
            for backend in ['memory','sqlite']:
                result=replay(clone,area/'baseline/graph.dot',destination/f'{backend}.json',backend)
                assert result['exitCode']!=0 and result['status']=='failed' and prop in result.get('error',''),f'Code fault did not fail for {prop}: {name}/{backend}'
                stores[backend]=result
            report['negativeControls'][name]={'property':prop,'stores':stores}
            shutil.rmtree(clone)
        restored=model(jar,area/'restored');code=replay(ROOT,area/'restored/graph.dot',area/'restored/replay.json')
        assert code['exitCode']==0 and code['status']=='verified','Original implementation failed restoration run'
        report['restored']={'model':restored,'replay':code};report['status']='verified'
    except Exception as error:
        report['status']='blocked' if str(error).startswith('BLOCKED:') else 'failed';report['error']=str(error)
    finally:
        shutil.rmtree(scratch)
        report['cleanup']={'scratchRemoved':not scratch.exists(),'coveredFilesUnchanged':before=={name:sha(ROOT/name) for name in before},'evidenceRetained':area.exists()}
        if not all(report['cleanup'].values()):report['status']='failed'
        report['seconds']=round(time.monotonic()-started,3)
        entries={str(path.relative_to(area)):{'bytes':path.stat().st_size,'sha256':sha(path)} for path in sorted(area.rglob('*')) if path.is_file() and 'states' not in path.relative_to(area).parts}
        write(area/'artifacts.json',entries);report['manifestSha256']=sha(area/'artifacts.json');write(area/'run.json',report)
    if report['status']=='verified':
        try:verify_evidence(area)
        except Exception as error:
            report['status']='failed';report['error']='Evidence integrity: '+str(error);write(area/'run.json',report)
    print(json.dumps({'status':report['status'],'evidence':str(area),'seconds':report['seconds'],'error':report.get('error')},ensure_ascii=False))
    return 0 if report['status']=='verified' else 1

if __name__=='__main__':raise SystemExit(main())
