#!/usr/bin/env python3
"""Finite extension checks: TLC, all-edge real-code replay, mutants and evidence."""
import argparse
import difflib
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from collections import Counter


def required(area, manifest, relative, nonempty=True):
    path = area / relative
    assert str(relative) in manifest and path.is_file(), f'Missing required artifact: {relative}'
    assert not nonempty or path.stat().st_size > 0, f'Empty required artifact: {relative}'
    return path


def verify_replay_rows(area, manifest, prefix, expected):
    graph = required(area, manifest, prefix / 'graph.dot').read_text()
    nodes = {}
    for key, label in re.findall(r'^(-?\d+) \[label="((?:\\.|[^"\\])*)"', graph, re.M):
        nodes[key] = {name: True if value == 'TRUE' else False if value == 'FALSE' else int(value)
                      for name, value in re.findall(r'(\w+) = (TRUE|FALSE|\d+)', label)}
    edges = Counter(re.findall(r'^(-?\d+) -> (-?\d+) \[label="(\w+)"', graph, re.M))
    assert len(nodes) == expected['graphStates'] and sum(edges.values()) == expected['graphEdges'], 'Incomplete captured graph'
    rows = []
    logs = list((area / prefix).glob('code*.jsonl'))
    assert logs, 'Missing raw per-edge implementation observations'
    for log in logs:
        required(area, manifest, log.relative_to(area))
        rows.extend(json.loads(line) for line in log.read_text().splitlines() if line)
    for backend in ['memory', 'sqlite']:
        actual = [row for row in rows if row['backend'] == backend]
        assert Counter((row['from'], row['to'], row['action']) for row in actual) == edges, f'Omitted/duplicated edge observations: {backend}'
        assert all(row['actual'] == nodes[row['to']] for row in actual), 'Stored code projection differs from model state'


def verify_properties(cfg, definition):
    invariants = [name for line in re.findall(r'^INVARIANTS? (.*)$', cfg, re.M) for name in line.split()]
    properties = [name for line in re.findall(r'^PROPERT(?:Y|IES) (.*)$', cfg, re.M) for name in line.split()]
    assert invariants and set(invariants) == set(definition['invariants']), 'Required safety properties differ'
    assert set(properties) == set(definition['properties']), 'Required liveness properties differ'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2))


def command(args, cwd, log, timeout=120):
    with log.open('wb') as stream:
        run = subprocess.run(args, cwd=cwd, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout)
    return run.returncode


def readback(area):
    report = json.loads((area / 'run.json').read_text())
    assert report['status'] == 'verified' and all(report['cleanup'].values()), 'Incomplete extension check'
    manifest = json.loads((area / 'artifacts.json').read_text())
    assert sha(area / 'artifacts.json') == report['manifestSha256'], 'Changed manifest'
    assert manifest, 'Empty evidence'
    for name, item in manifest.items():
        path = area / name
        assert path.is_file() and sha(path) == item['sha256'] and path.stat().st_size == item['bytes'], f'Changed evidence: {name}'
    specs = list((area / 'checker-inputs').glob('*/references/composition-suite.json')) + list((area / 'checker-inputs').glob('*/references/composition-spec.json'))
    assert len(specs) == 1, 'Missing or ambiguous captured suite'
    required(area, manifest, specs[0].relative_to(area))
    suite = json.loads(specs[0].read_text())
    captured_coverage = json.loads(required(area, manifest, specs[0].relative_to(area).with_name('composition-coverage.json')).read_text())
    for name, expected in captured_coverage['files'].items():
        assert sha(required(area, manifest, Path('checker-inputs/implementation') / name)) == expected, 'Captured implementation differs from coverage'
    domains = [item['domain'] for item in suite['models']]
    assert set(report['negativeControls']) == {item['name'] for item in suite['controls']}, 'Omitted negative control'
    for stage in ['baseline', 'restored']:
        assert [item['domain'] for item in report[stage]] == domains, 'Omitted model domain'
        for item in report[stage]:
            assert item['model']['exitCode'] == 0 and item['model']['counts'][2] == 0
            assert item['replay']['status'] == 'verified'
            assert item['replay']['graphStates'] == item['model']['counts'][1]
            assert item['replay']['graphEdges'] + 1 == item['model']['counts'][0]
            assert all(store['replayedEdges'] == item['replay']['graphEdges'] for store in item['replay']['backends'])
            assert [store['name'] for store in item['replay']['backends']] == ['memory', 'sqlite']
            assert item['replay']['exitCode'] == 0, 'Implementation command failed'
            prefix = Path(stage) / item['domain']
            definition = next(model for model in suite['models'] if model['domain'] == item['domain'])
            for name in [definition['module'] + '.tla', definition['module'] + '.cfg', 'result.json', 'code.json']:
                required(area, manifest, prefix / name)
            raw = required(area, manifest, prefix / 'tlc.log').read_text()
            assert 'Model checking completed. No error has been found.' in raw and '0 states left on queue' in raw
            cfg = (area / prefix / (definition['module'] + '.cfg')).read_text()
            verify_properties(cfg, definition)
            if definition['properties']:
                assert 'Finished checking temporal properties' in raw, 'Unchecked liveness'
            counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', raw)
            assert counts and [int(value.replace(',', '')) for value in counts[-1]] == item['model']['counts'], 'Raw TLC counts differ'
            verify_replay_rows(area, manifest, prefix, item['replay'])
    assert report['negativeControls'] and report['witnesses'], 'Missing fault detection or reachability evidence'
    for name, control in report['negativeControls'].items():
        definition = next(item for item in suite['controls'] if item['name'] == name)
        assert control['property'] == definition['property'], 'Negative property differs from captured suite'
        assert set(control['stores']) == {'memory', 'sqlite'} and all(control['stores'].values()), 'A backend did not detect the real-code fault'
        required(area, manifest, Path('negative-controls') / name / 'real-code.diff')
        for backend, domains_detected in control['stores'].items():
            for domain in domains_detected:
                prefix = Path('negative-controls') / name
                proof = json.loads(required(area, manifest, prefix / (domain + '-' + backend + '.json')).read_text())
                assert proof.get('exitCode') == 1, 'Negative did not exit normally with behavioral failure'
                assert proof['status'] == 'failed' and 'AssertionError' in proof.get('error', '') and control['property'] in proof.get('error', ''), 'Negative did not violate its property'
                witnessed = proof.get('failedBackend') == backend or any(store.get('name') == backend and store.get('status') == 'failed' for store in proof.get('backends', []))
                assert witnessed, 'Negative did not execute the selected backend'
                required(area, manifest, prefix / (domain + '-' + backend + '.log'), nonempty=False)
    for witness in report['witnesses']:
        assert witness['exitCode'] != 0, 'Reachability check did not fail its named invariant'
        raw = required(area, manifest, Path('reachability') / witness['domain'] / witness['witness'] / 'tlc.log').read_text()
        assert f'Invariant {witness["witness"]} is violated' in raw, 'Invalid reachability failure'
    assert {(item['domain'], item['witness']) for item in report['witnesses']} == {(item['domain'], name) for item in suite['models'] for name in item.get('witnesses', [])}, 'Omitted witness'
    return len(manifest)


def run_suite(skill, spec_file):
    root = skill.parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--verify-evidence', type=Path)
    parser.add_argument('--jar', type=Path, default=Path(os.environ.get('TLA2TOOLS_JAR', str(root / 'work/tla2tools-1.7.4.jar'))))
    args = parser.parse_args()
    if args.verify_evidence:
        print(f'Evidence verified: {readback(args.verify_evidence.resolve())} artifacts')
        return
    spec = json.loads(spec_file.read_text())
    coverage_file = skill / 'references/composition-coverage.json'
    coverage = json.loads(coverage_file.read_text())
    area = (args.evidence or root / 'reports' / spec['report'] / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + f'-{os.getpid()}')).resolve()
    area.mkdir(parents=True, exist_ok=False)
    helper_path = root / '.agents/skills/verify-squad-handoff/scripts/check.py'
    module_spec = importlib.util.spec_from_file_location('squad_formal_existing', helper_path)
    helper = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(helper)
    jar = helper.jar_at(args.jar.resolve())
    before = {name: sha(root / name) for name in coverage['files']}
    report = {'status': 'running', 'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
              'syncCommit': coverage['syncCommit'], 'coveredFileHashes': before, 'bounds': spec['bounds'],
              'tool': {'release': 'TLA+ Tools v1.7.4 / TLC 2.19', 'sha256': sha(jar)},
              'baseline': [], 'restored': [], 'witnesses': [], 'negativeControls': {}, 'cleanup': {}}
    scratch = Path(tempfile.mkdtemp(prefix='squad-composition-'))
    try:
        assert before == coverage['files'], 'BLOCKED: review implementation drift before advancing coverage'
        inputs = area / 'checker-inputs'
        shutil.copytree(skill, inputs / skill.name, ignore=shutil.ignore_patterns('__pycache__'))
        shutil.copyfile(Path(__file__), inputs / 'composition-support.py')
        shutil.copyfile(Path(__file__).with_name('composition-graph.mjs'), inputs / 'composition-graph.mjs')
        for name in before:
            captured = inputs / 'implementation' / name
            captured.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, captured)

        def model(item, destination, witness=None):
            destination.mkdir(parents=True)
            name = item['module']
            shutil.copyfile(skill / 'scripts' / (name + '.tla'), destination / (name + '.tla'))
            cfg = (skill / 'scripts' / item['config']).read_text()
            verify_properties(cfg, item)
            temporal = bool(item['properties'])
            if witness:
                cfg = re.sub(r'^INVARIANTS? .*$', 'INVARIANT ' + witness, cfg, flags=re.M)
                cfg = re.sub(r'^PROPERTY .*\n?', '', cfg, flags=re.M)
            (destination / (name + '.cfg')).write_text(cfg)
            java_tmp = destination / 'java-tmp'
            java_tmp.mkdir()
            args_model = ['java', f'-Djava.io.tmpdir={java_tmp}', '-XX:+UseParallelGC', '-Xmx512m', '-jar', str(jar), '-workers', '1', '-seed', '1',
                          '-metadir', str(destination / 'states'), '-dump', 'dot,actionlabels', str(destination / 'graph.dot'),
                          '-config', name + '.cfg', name + '.tla']
            code = command(args_model, destination, destination / 'tlc.log')
            raw = (destination / 'tlc.log').read_text()
            counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', raw)
            result = {'exitCode': code, 'command': args_model, 'witness': witness,
                      'counts': [int(v.replace(',', '')) for v in counts[-1]] if counts else None}
            if witness:
                assert code != 0 and f'Invariant {witness} is violated' in raw, f'Unreachable required precondition: {witness}'
            else:
                assert code == 0 and 'Model checking completed. No error has been found.' in raw, f'TLC failed: {destination}'
                assert result['counts'] and result['counts'][2] == 0, 'Partial graph exploration'
                if temporal:
                    assert 'Finished checking temporal properties' in raw, 'Unchecked liveness'
            save(destination / 'result.json', result)
            return result

        def replay(item, target, destination, graph, backend='both'):
            args_replay = ['node', '--import', str(root / 'node_modules/tsx/dist/loader.mjs'), str(skill / 'scripts' / spec['replay']),
                           str(target), str(graph), str(destination), item['domain'], backend]
            code = command(args_replay, root, destination.with_suffix('.log'))
            assert destination.exists(), 'Replay failed to load; not a behavioral finding'
            value = json.loads(destination.read_text())
            value['exitCode'] = code
            save(destination, value)
            return value

        for stage in ['baseline', 'restored']:
            if stage == 'restored':
                for control in spec['controls']:
                    clone = scratch / control['name']
                    clone.mkdir()
                    for directory in ['src', 'tests']:
                        shutil.copytree(root / directory, clone / directory)
                    for file in ['team.config.ts', 'package.json']:
                        shutil.copyfile(root / file, clone / file)
                    (clone / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
                    path = clone / control['file']
                    original = path.read_text()
                    assert original.count(control['old']) == 1, f'Negative anchor drift: {control["name"]}'
                    mutated = original.replace(control['old'], control['new'])
                    path.write_text(mutated)
                    destination = area / 'negative-controls' / control['name']
                    destination.mkdir(parents=True)
                    (destination / 'real-code.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), mutated.splitlines(True), fromfile=control['file'], tofile=control['file'])))
                    candidates = [item for item in spec['models'] if not control.get('domain') or item['domain'] == control['domain']]
                    stores = {}
                    for backend in ['memory', 'sqlite']:
                        detected = []
                        for item in candidates:
                            value = replay(item, clone, destination / (item['domain'] + '-' + backend + '.json'), area / 'baseline' / item['domain'] / 'graph.dot', backend)
                            if value['exitCode'] == 1 and 'AssertionError' in value.get('error', '') and control['property'] in value.get('error', ''):
                                detected.append(item['domain'])
                        assert detected, f'Negative control escaped its behavioral property: {control["name"]}/{backend}'
                        stores[backend] = detected
                    report['negativeControls'][control['name']] = {'property': control['property'], 'stores': stores}
                    shutil.rmtree(clone)
            for item in spec['models']:
                destination = area / stage / item['domain']
                result_model = model(item, destination)
                result_replay = replay(item, root, destination / 'code.json', destination / 'graph.dot')
                assert result_replay['exitCode'] == 0 and result_replay['status'] == 'verified', f'Code correspondence failed: {destination}'
                assert result_replay['graphStates'] == result_model['counts'][1], 'TLC node omission'
                assert result_replay['graphEdges'] + 1 == result_model['counts'][0], 'TLC edge omission'
                report[stage].append({'domain': item['domain'], 'model': result_model, 'replay': result_replay})
                if stage == 'baseline':
                    for witness in item.get('witnesses', []):
                        result_witness = model(item, area / 'reachability' / item['domain'] / witness, witness)
                        report['witnesses'].append({'domain': item['domain'], **result_witness})
        report['status'] = 'verified'
    except Exception as error:
        report['status'] = 'blocked' if str(error).startswith('BLOCKED:') else 'failed'
        report['error'] = str(error)
        raise
    finally:
        shutil.rmtree(scratch)
        report['cleanup'] = {'scratchRemoved': not scratch.exists(), 'coveredFilesUnchanged': before == {name: sha(root / name) for name in before}}
        assert all(report['cleanup'].values()), 'Source changed during verification'
        artifacts = {str(path.relative_to(area)): {'sha256': sha(path), 'bytes': path.stat().st_size}
                     for path in area.rglob('*') if path.is_file() and 'states' not in path.relative_to(area).parts and path.name not in ['run.json', 'artifacts.json']}
        save(area / 'artifacts.json', artifacts)
        report['manifestSha256'] = sha(area / 'artifacts.json')
        save(area / 'run.json', report)
        print(json.dumps({'status': report['status'], 'evidence': str(area), 'cleanup': report['cleanup']}), flush=True)
