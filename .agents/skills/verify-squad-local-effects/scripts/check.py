#!/usr/bin/env python3
"""Finite local-effects protocol + actual interfaces, fault controls and retained evidence."""
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
PROPERTIES = ['TypeOK', 'UnconfirmedKeepsLease', 'AtomicCheckpoint', 'CompetitorAfterSettlement', 'OneStart', 'NoUnsafeReplay', 'SessionBound', 'NoFalseNotStarted']
WITNESSES = ['NeverStarted', 'NeverUnknown', 'NeverCommitted', 'NeverStoppedReceipt', 'NeverRollback', 'NeverCompetitor']
CONTROLS = {
    'release-unknown': ('UnconfirmedKeepsLease', 'src/engine.ts',
        "['succeeded', 'failed', 'cancelled', 'queued', 'awaitingApproval'].includes(op.status)",
        "['succeeded', 'failed', 'cancelled', 'queued', 'awaitingApproval', 'uncertain'].includes(op.status)"),
    'drop-checkpoint': ('AtomicCheckpoint', 'src/local-operation.ts',
        'delete work.localCheckpoint.pendingOperationId;', '/* negative control: pending checkpoint incorrectly retained */'),
    'wrong-session': ('SessionBound', 'src/local-operation.ts',
        "if (!op || op.sessionId !== event.sessionId || !['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) return 'LOCAL_SESSION_MISMATCH';",
        "if (!op || !['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) return 'LOCAL_SESSION_MISMATCH';"),
    'replay-unknown': ('NoFalseNotStarted', 'src/local-cli.ts',
        "if (!record) return { resolution: 'notStarted', detail: 'Durable launch journal absent; spawn is strictly after journal fsync' };",
        "if (!record || record.phase === 'prepared') return { resolution: 'notStarted', detail: 'incorrectly inferred no effects' };"),
}

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    data = value.encode() if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2).encode()
    temporary = path.with_name(path.name + '.part')
    with temporary.open('wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)

def verify(evidence):
    manifest = json.loads((evidence / 'artifacts.json').read_text())
    required = ['run.json', 'baseline/tlc.log', 'baseline/graph.dot', 'baseline-code.json', 'restored/tlc.log', 'restored-code.json',
                'integration/bridges.json', 'checker-inputs/scripts/check.py', 'checker-inputs/scripts/LocalEffects.tla',
                'checker-inputs/scripts/LocalEffects.cfg', 'checker-inputs/scripts/replay.mjs', 'checker-inputs/references/coverage.json']
    for name in CONTROLS:
        required += [f'negative-controls/{name}/real-code.diff', f'negative-controls/{name}/model/tlc.log', f'negative-controls/{name}/model/result.json']
        for backend in ['memory', 'sqlite']:
            required += [f'negative-controls/{name}/{backend}.json', f'negative-controls/{name}/{backend}.log']
    missing = [name for name in required if name not in manifest]
    assert not missing, f'Missing required artifact: {missing[0]}'
    for name, expected in manifest.items():
        path = evidence / name
        assert path.is_file() and path.stat().st_size == expected['bytes'] and sha(path) == expected['sha256'], f'Evidence changed or missing: {name}'
    report = json.loads((evidence / 'run.json').read_text())
    assert report['status'] == 'verified' and all(report['cleanup'].values()), 'Incomplete verification or cleanup'
    assert report['tool']['sha256'] == JAR_SHA
    coverage = json.loads((evidence / 'checker-inputs/references/coverage.json').read_text())
    assert report['coveredFiles'] == coverage['files'] and report['bounds'] == coverage['bounds'], 'Captured source scope mismatch'
    assert report['syncCommit'] == coverage['syncCommit'], 'Captured synchronization identity mismatch'
    for name, expected in coverage['files'].items():
        relative = f'checker-inputs/implementation/{name}'
        assert relative in manifest, f'Missing captured implementation: {relative}'
        assert sha(evidence / relative) == expected, f'Captured implementation differs: {relative}'
    captured_cfg = (evidence / 'checker-inputs/scripts/LocalEffects.cfg').read_text()
    assert all(property_name in captured_cfg for property_name in PROPERTIES + ['PROPERTY SettledProgress']), 'Omitted declared model property'
    expected_kinds = {'model-gate': 1, 'model-baseline': 1, 'model-restored': 1, 'model-witness': 6, 'model-negative': 4,
                      'replay-baseline': 1, 'replay-restored': 1, 'code-negative': 8, 'integration': 1}
    assert {kind: sum(step['kind'] == kind for step in report['steps']) for kind in expected_kinds} == expected_kinds, 'Incomplete mandatory stages'
    assert len(report['steps']) == sum(expected_kinds.values())
    for step in report['steps']:
        log = (evidence / step['log']).read_text()
        assert log and not step.get('timeout'), 'Missing/truncated execution log'
        if step['kind'] in ['model-baseline', 'model-restored']:
            assert step['exitCode'] == 0 and 'Model checking completed. No error has been found.' in log
            assert '0 states left on queue' in log and 'Finished checking temporal properties' in log
        elif step['kind'] in ['model-witness', 'model-negative']:
            assert step['exitCode'] != 0 and f"Invariant {step['expected']} is violated" in log, 'Wrong counterexample reason'
        elif step['kind'] == 'code-negative':
            assert step['exitCode'] != 0 and 'AssertionError' in log and f"LocalEffects:{step['expected']}" in log, 'Mutation did not fail on target behavior'
            _, name, filename = Path(step['log']).parts
            backend = Path(filename).stem
            assert name in CONTROLS and step['expected'] == CONTROLS[name][0] and backend in ['memory', 'sqlite'], 'Misidentified source negative control'
            proof = json.loads((evidence / f'negative-controls/{name}/{backend}.json').read_text())
            assert proof['status'] == 'failed' and proof['counterexample']['backend'] == backend, 'Negative did not execute selected store'
            assert 'AssertionError' in proof['error'] and f"LocalEffects:{CONTROLS[name][0]}" in proof['error'], 'Wrong raw source failure'
        else:
            assert step['exitCode'] == 0, 'Baseline, gate, replay or integration failed'
    for name in ['baseline-code.json', 'restored-code.json']:
        replay = json.loads((evidence / name).read_text())
        assert replay['status'] == 'verified' and len(replay['backends']) == 2
        assert all(item['edges'] == replay['graphEdges'] for item in replay['backends'])
        assert {item['backend'] for item in replay['backends']} == {'memory', 'sqlite'}
        graph_name = 'baseline' if name.startswith('baseline') else 'restored'
        graph = (evidence / graph_name / 'graph.dot').read_text()
        nodes = {key: {field: value == 'TRUE' if value in ['TRUE', 'FALSE'] else int(value)
                       for field, value in re.findall(r'(\w+) = (TRUE|FALSE|\d+)', label)}
                 for key, label in re.findall(r'^(-?\d+) \[label="((?:\\.|[^"\\])*)"', graph, re.M)}
        graph_edges = re.findall(r'^(-?\d+) -> (-?\d+) \[label="(\w+)"', graph, re.M)
        records = [json.loads(line) for line in (evidence / (name + '.jsonl')).read_text().splitlines()]
        assert len(records) == len(graph_edges) * 2, 'Incomplete per-edge replay log'
        expected_edges = Counter((backend, source, target, action) for backend in ['memory', 'sqlite'] for source, target, action in graph_edges)
        actual_edges = Counter((record['backend'], record['from'], record['to'], record['action']) for record in records)
        assert actual_edges == expected_edges, 'Replay did not retain every labeled edge for both stores'
        assert len(nodes) == replay['graphStates'] and all(record['actual'] == nodes[record['to']] for record in records), 'Replay projection differs from model target'
        raw = (evidence / graph_name / 'tlc.log').read_text()
        counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', raw)[-1]
        assert replay['graphStates'] == int(counts[1].replace(',', ''))
        assert replay['graphEdges'] + 1 == int(counts[0].replace(',', ''))
    bridges = json.loads((evidence / 'integration/bridges.json').read_text())
    assert bridges['status'] == 'verified' and len(bridges['records']) == 7
    print(f'Evidence verified: {evidence} ({len(manifest)} retained artifacts)')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_jar = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'squad-formal/tla2tools-1.7.4.jar'
    parser.add_argument('--jar', type=Path, default=Path(os.environ.get('TLA2TOOLS_JAR', default_jar)))
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--verify-evidence', type=Path)
    args = parser.parse_args()
    if args.verify_evidence:
        verify(args.verify_evidence.resolve())
        return 0
    out = (args.evidence or ROOT / 'reports/verify-squad-local-effects' / f'{time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())}-{os.getpid()}').resolve()
    out.mkdir(parents=True, exist_ok=False)
    coverage = json.loads((SKILL / 'references/coverage.json').read_text())
    before = {name: sha(ROOT / name) for name in coverage['files']}
    report = {'status': 'running', 'sourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'workingTree': subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True),
              'syncCommit': coverage['syncCommit'], 'bounds': coverage['bounds'], 'coveredFiles': before, 'steps': []}
    scratch = Path(tempfile.mkdtemp(prefix='squad-local-effects-'))
    started = time.monotonic()
    try:
        assert before == coverage['files'], 'BLOCKED: source drift; review code correspondence before updating hashes'
        jar = args.jar.resolve()
        assert jar.is_file() and sha(jar) == JAR_SHA, 'BLOCKED: provide official pinned TLA+ Tools v1.7.4 JAR'
        report['tool'] = {'release': 'TLA+ Tools v1.7.4 / TLC 2.19', 'sha256': sha(jar)}
        shutil.copytree(SKILL / 'scripts', out / 'checker-inputs/scripts', ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copytree(SKILL / 'references', out / 'checker-inputs/references')
        shutil.copyfile(SKILL / 'SKILL.md', out / 'checker-inputs/SKILL.md')
        for name in coverage['files']:
            destination = out / 'checker-inputs/implementation' / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        for name in ['tests/local-effects-formal-fixture.ts', 'tests/local-effects-formal-bridges.mjs', 'tests/bdd/local-effects-formal.steps.ts', 'features/37_local_effects_composition.feature']:
            target = out / 'checker-inputs' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)

        def run(command, relative, kind, expected=None, cwd=ROOT, timeout=90):
            log = out / relative
            t0 = time.monotonic()
            try:
                process = subprocess.run([str(part) for part in command], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
            except subprocess.TimeoutExpired as error:
                save(log, (error.stdout or b'').decode(errors='replace'))
                report['steps'].append({'kind': kind, 'command': list(map(str, command)), 'log': relative, 'timeout': timeout})
                raise RuntimeError(f'BLOCKED: subprocess timed out: {relative}') from error
            save(log, process.stdout.decode(errors='replace'))
            step = {'kind': kind, 'command': list(map(str, command)), 'cwd': str(cwd), 'log': relative, 'exitCode': process.returncode,
                    'seconds': round(time.monotonic() - t0, 3)}
            if expected:
                step['expected'] = expected
            report['steps'].append(step)
            raw = process.stdout.decode(errors='replace')
            if kind == 'code-negative':
                assert process.returncode != 0 and 'AssertionError' in raw and f'LocalEffects:{expected}' in raw, f'Wrong mutation failure: {relative}'
            elif kind in ['model-witness', 'model-negative']:
                assert process.returncode != 0 and f'Invariant {expected} is violated' in raw, f'Wrong model counterexample: {relative}'
            else:
                assert process.returncode == 0, f'Check failed: {relative}'
            return raw

        def model(name, witness=None, mutation='none'):
            area = out / name
            area.mkdir(parents=True)
            shutil.copyfile(SKILL / 'scripts/LocalEffects.tla', area / 'LocalEffects.tla')
            cfg = (SKILL / 'scripts/LocalEffects.cfg').read_text()
            assert all(prop in cfg for prop in PROPERTIES + ['PROPERTY SettledProgress'])
            cfg = cfg.replace('Mutation = "none"', f'Mutation = "{mutation}"')
            if witness:
                cfg = re.sub(r'^INVARIANTS .*$', f'INVARIANT {witness}', cfg, flags=re.M)
                cfg = re.sub(r'^PROPERTY SettledProgress\n?', '', cfg, flags=re.M)
            save(area / 'check.cfg', cfg)
            expected = witness or {'release-unknown': 'UnconfirmedKeepsLease', 'drop-checkpoint': 'AtomicCheckpoint',
                                   'wrong-session': 'SessionBound', 'replay-unknown': 'NoFalseNotStarted'}.get(mutation)
            kind = 'model-witness' if witness else 'model-negative' if mutation != 'none' else 'model-restored' if name == 'restored' else 'model-baseline'
            java_tmp = area / 'java-tmp'
            java_tmp.mkdir()
            command = ['java', '-XX:+UseParallelGC', '-Xmx512m', f'-Djava.io.tmpdir={java_tmp}', '-cp', jar, 'tlc2.TLC', '-seed', '1', '-workers', '1',
                       '-config', 'check.cfg', '-metadir', area / 'states', '-dump', 'dot,actionlabels', 'graph.dot', 'LocalEffects.tla']
            raw = run(command, f'{name}/tlc.log', kind, expected, area)
            counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', raw)
            save(area / 'result.json', {'counts': [[int(value.replace(',', '')) for value in count] for count in counts], 'witness': witness, 'mutation': mutation})
            if not witness and mutation == 'none':
                assert 'Model checking completed. No error has been found.' in raw and '0 states left on queue' in raw
                assert 'Finished checking temporal properties' in raw
            return area / 'graph.dot'

        def replay(target, graph, relative, kind, backend='both', expected=None):
            return run(['node', '--import', ROOT / 'node_modules/tsx/dist/loader.mjs', SKILL / 'scripts/replay.mjs', target, graph, out / relative.replace('.log', '.json'), backend], relative, kind, expected)

        run(['node', '--import', 'tsx', '--input-type=module', '-e', 'const m=await import("./tests/local-effects-formal-fixture.ts");console.log(JSON.stringify(m.localEffectsModelGate()));'], 'model-gate.log', 'model-gate')
        graph = model('baseline')
        replay(ROOT, graph, 'baseline-code.log', 'replay-baseline')
        baseline = json.loads((out / 'baseline-code.json').read_text())
        counts = json.loads((out / 'baseline/result.json').read_text())['counts'][-1]
        assert baseline['graphStates'] == counts[1] and baseline['graphEdges'] + 1 == counts[0], 'Graph parsing omitted TLC states or labeled edges'
        for witness in WITNESSES:
            model(f'reachability/{witness}', witness=witness)
        for name, (prop, source, old, new) in CONTROLS.items():
            clone = scratch / name
            shutil.copytree(ROOT / 'src', clone / 'src')
            (clone / 'tests').mkdir()
            shutil.copyfile(ROOT / 'tests/local-effects-formal-fixture.ts', clone / 'tests/local-effects-formal-fixture.ts')
            shutil.copyfile(ROOT / 'package.json', clone / 'package.json')
            (clone / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            path = clone / source
            original = path.read_text()
            assert original.count(old) == 1, f'Negative-control anchor drift: {name}'
            modified = original.replace(old, new)
            path.write_text(modified)
            save(out / 'negative-controls' / name / 'real-code.diff', ''.join(difflib.unified_diff(original.splitlines(True), modified.splitlines(True), fromfile=source, tofile=source)))
            for backend in ['memory', 'sqlite']:
                replay(clone, graph, f'negative-controls/{name}/{backend}.log', 'code-negative', backend, prop)
            model(f'negative-controls/{name}/model', mutation=name)
            shutil.rmtree(clone)
        restored = model('restored')
        replay(ROOT, restored, 'restored-code.log', 'replay-restored')
        run(['node', '--import', 'tsx', ROOT / 'tests/local-effects-formal-bridges.mjs', out / 'integration'], 'integration.log', 'integration')
        report['status'] = 'verified'
    except Exception as error:
        report['status'] = 'blocked' if str(error).startswith('BLOCKED:') else 'failed'
        report['error'] = str(error)
    finally:
        shutil.rmtree(scratch)
        report['seconds'] = round(time.monotonic() - started, 3)
        report['cleanup'] = {'scratchRemoved': not scratch.exists(), 'coveredFilesUnchanged': before == {name: sha(ROOT / name) for name in before}}
        if not all(report['cleanup'].values()):
            report['status'] = 'failed'
        save(out / 'run.json', report)
        save(out / 'artifacts.json', {str(path.relative_to(out)): {'bytes': path.stat().st_size, 'sha256': sha(path)}
             for path in sorted(out.rglob('*')) if path.is_file() and path.name != 'artifacts.json' and 'states' not in path.relative_to(out).parts})
        print(json.dumps({'status': report['status'], 'evidence': str(out), 'seconds': report['seconds'], 'cleanup': report['cleanup'], 'error': report.get('error')}, ensure_ascii=False))
    if report['status'] == 'verified':
        verify(out)
        return 0
    return 1

if __name__ == '__main__':
    sys.exit(main())
