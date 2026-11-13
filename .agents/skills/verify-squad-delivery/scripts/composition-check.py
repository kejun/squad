#!/usr/bin/env python3
"""Independent finite delivery slices, complete edge replay and real-code controls."""
import argparse
from collections import Counter
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

SKILL = Path(__file__).resolve().parents[1]
ROOT = SKILL.parents[2]
helper_file = ROOT / '.agents/skills/verify-squad-handoff/scripts/check.py'
spec = importlib.util.spec_from_file_location('delivery_composition_helpers', helper_file)
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
MODELS = {
    'Verification': {
        'properties': ['TypeOK', 'HonestVerification', 'OrderedPublication'],
        'witnesses': ['NeverModelRequested', 'NeverEarlyCheck', 'NeverFailedValidationDelivery', 'NeverPublished', 'NeverChanged', 'NeverRolledBack'],
        'bounds': 'One task/candidate/check; one successful or failing isolated validation, up to two model requests including early remedy, two unequal workspace revisions, one final verification, one rollback/reopen. Missing or failed verification is declared in delivered content; no OS crash is modeled.'},
    'Cycles': {
        'properties': ['TypeOK', 'RetainedPublication', 'CurrentCandidate', 'OneFinalPerCycle', 'DirectRepairRevision'],
        'witnesses': ['NeverThirdPublication', 'NeverRevised', 'NeverRolledBack'],
        'bounds': 'One task, three explicitly requested publication cycles, one direct downstream repair across these cycles, four document revisions, one rollback/reopen; duplicate, prior-candidate and prior-work results. No automatic owner revision.'},
    'SourceLineage': {
        'properties': ['TypeOK', 'FrozenSource', 'DirectLineage'],
        'witnesses': ['NeverSourceReplaced', 'NeverDirectChild', 'NeverRejectedStale', 'NeverReopened'],
        'bounds': 'Three sequential tasks in one room, source A with two publications, frozen A1 in B, stop/resume B, B publication then direct B source in C; one reopen/recover excluding consumed check in flight; duplicate/conflicting source request.'},
}
# Every source edit is made only in a disposable production-code copy.
CONTROLS = [
    ('hide-validation-gap', 'Verification', 'HonestVerification', 'src/task/delivery.ts',
     "...(verification ? { detail: `实际验证未完成：${verification}` } : {})",
     '...{}', 'hide-validation-gap'),
    ('skip-version', 'Verification', 'HonestVerification', 'src/task/verification.ts',
     'return final ? versionReceiptProblem(work, receipt) : null;', 'return null;', 'skip-version'),
    ('accept-changed', 'Verification', 'HonestVerification', 'src/task/verification.ts',
     'if ([expectedRevision, currentRevision, copyRevision].every(value => value === receipt.revision)) return null;',
     'return null;', 'accept-changed'),
    ('ignore-verification-badge', 'Verification', 'HonestVerification', 'src/resource-acquisition.ts',
     '&& check && !deliveryVerificationProblem(check, true)', '&& check', 'ignore-verification-badge'),
    ('drop-publication', 'Cycles', 'RetainedPublication', 'src/task/reducer.ts',
     'if (e.extraOrdinary) c.config.limits.ordinary += e.extraOrdinary;\n      retainLegacyPublication(c, e.at);',
     'if (e.extraOrdinary) c.config.limits.ordinary += e.extraOrdinary;\n      c.publishedDelivery = { ...c.publishedDelivery!, artifactIds: [] };', 'drop-publication'),
    ('accept-old-cycle', 'Cycles', 'CurrentCandidate', 'src/task/delivery.ts',
     'e.candidateRevision !== candidate.revision || ', '', 'accept-stale'),
    ('drop-repair-version', 'Cycles', 'DirectRepairRevision', 'src/task/reducer.ts',
     'saveReports(c, delivery, c.sourceArtifact', 'saveReports(c, e, c.sourceArtifact', 'drop-repair-version'),
    ('corrupt-freeze', 'SourceLineage', 'FrozenSource', 'src/engine.ts',
     'sourceArtifact = resolution.sourceArtifact;',
     "sourceArtifact = { ...resolution.sourceArtifact, content: resolution.sourceArtifact.content + '\\ncorrupted' };", 'corrupt-freeze'),
    ('transitive-source', 'SourceLineage', 'DirectLineage', 'src/source-artifact.ts',
     'sourceTaskId: c.taskId, artifactId: artifact.id,',
     'sourceTaskId: c.sourceArtifact?.sourceTaskId ?? c.taskId, artifactId: artifact.id,', 'transitive-source'),
]


def validate_config(name, config):
    invariants = [token for line in re.findall(r'^INVARIANTS?\s+([^\n]+)$', config, re.M) for token in line.split()]
    properties = re.findall(r'^PROPERTY\s+(\w+)\s*$', config, re.M)
    assert set(invariants) == set(MODELS[name]['properties']) and len(invariants) == len(MODELS[name]['properties']), f'{name}: required safety checks changed or missing'
    assert properties == ['Progress'], f'{name}: required Progress temporal check changed or missing'
    assert re.findall(r'^SPECIFICATION\s+(\w+)\s*$', config, re.M) == ['Spec'], f'{name}: full temporal specification required'


def check_model(name, jar, area, witness=None, mutation='none', violation=None):
    area.mkdir(parents=True)
    shutil.copyfile(SKILL / f'scripts/{name}.tla', area / f'{name}.tla')
    config = (SKILL / f'scripts/{name}.cfg').read_text()
    validate_config(name, config)
    assert config.count('Mutation = "none"') == 1
    config = config.replace('Mutation = "none"', f'Mutation = "{mutation}"')
    if witness:
        config = re.sub(r'^INVARIANTS .*$', 'INVARIANT ' + witness, config, flags=re.M)
        config = config.replace('PROPERTY Progress\n', '')
    (area / f'{name}.cfg').write_text(config)
    java_tmp = area / 'java-tmp'
    java_tmp.mkdir()
    command = ['java', '-Djava.io.tmpdir=' + str(java_tmp), '-XX:+UseParallelGC', '-Xmx512m', '-jar', str(jar), '-workers', '1', '-seed', '1',
               '-metadir', str(area / 'states'), '-dump', 'dot,actionlabels', str(area / 'graph.dot'), '-config', f'{name}.cfg', f'{name}.tla']
    code, seconds = helpers.execute(command, area / 'tlc.log', area, timeout=45)
    raw = (area / 'tlc.log').read_text()
    counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', raw)
    result = {'model': name, 'command': command, 'exitCode': code, 'seconds': seconds, 'witness': witness, 'mutation': mutation,
              'properties': MODELS[name]['properties'], 'bounds': MODELS[name]['bounds'],
              'counts': [int(value.replace(',', '')) for value in counts[-1]] if counts else None,
              'logSha256': helpers.digest(area / 'tlc.log'), 'logBytes': (area / 'tlc.log').stat().st_size}
    expected = witness or violation
    if expected:
        assert code != 0 and f'Invariant {expected} is violated' in raw, f'{name}: required {expected} witness is not a tool failure'
        result['violatedProperty'] = expected
    else:
        assert code == 0 and 'Model checking completed. No error has been found.' in raw, f'{name}: model did not finish successfully'
        assert result['counts'] and result['counts'][2] == 0 and 'Finished checking temporal properties' in raw, f'{name}: incomplete state space or liveness check'
    (area / 'result.json').write_text(json.dumps(result, indent=2))
    return result


def replay(name, root, graph, output, scratch, backend='both'):
    command = ['node', '--import', str(ROOT / 'node_modules/tsx/dist/loader.mjs'), str(SKILL / 'scripts/composition-replay.mjs'),
               str(root), str(graph), str(output), backend, name]
    code, seconds = helpers.execute(command, output.with_suffix('.log'), scratch, timeout=90)
    assert output.exists(), f'{name}: code replay did not produce evidence'
    value = json.loads(output.read_text())
    value.update(command=command, exitCode=code, seconds=seconds)
    output.write_text(json.dumps(value, indent=2))
    return value


def assert_replay(value, model):
    assert value['exitCode'] == 0 and value['status'] == 'verified', f"{value['model']}: real code failed: {value.get('error')}"
    assert value['graphStates'] == model['counts'][1], 'Graph parser omitted TLC states'
    assert value['graphEdges'] + 1 == model['counts'][0], 'Graph parser omitted TLC labeled edges'
    assert {entry['backend'] for entry in value['backends']} == {'memory', 'sqlite'}
    assert all(entry['edgesReplayed'] == value['graphEdges'] for entry in value['backends'])


def run(jar, evidence, scratch):
    evidence.mkdir(parents=True)
    scratch.mkdir(parents=True)
    report = {'models': {}, 'negativeControls': {}}
    for name, definition in MODELS.items():
        area = evidence / name
        model = check_model(name, jar, area / 'baseline')
        code = replay(name, ROOT, area / 'baseline/graph.dot', area / 'baseline-code.json', scratch)
        assert_replay(code, model)
        report['models'][name] = {'baseline': model, 'implementation': code, 'witnesses': {}}
        for witness in definition['witnesses']:
            report['models'][name]['witnesses'][witness] = check_model(name, jar, area / 'reachability' / witness, witness=witness)
    for control, name, property_name, path, old, new, mutation in CONTROLS:
        clone = scratch / control
        clone.mkdir()
        shutil.copytree(ROOT / 'src', clone / 'src')
        for filename in ['team.config.ts', 'package.json']:
            shutil.copyfile(ROOT / filename, clone / filename)
        (clone / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        original = (clone / path).read_text()
        assert original.count(old) == 1, f'Mutation anchor drift: {control}'
        mutated = original.replace(old, new)
        (clone / path).write_text(mutated)
        area = evidence / 'negative-controls' / control
        area.mkdir(parents=True)
        (area / 'real-code.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), mutated.splitlines(True), fromfile=path, tofile=path)))
        stores = {}
        for backend in ['memory', 'sqlite']:
            value = replay(name, clone, evidence / name / 'baseline/graph.dot', area / f'{backend}-code.json', scratch, backend)
            assert value['exitCode'] == 1 and value['status'] == 'failed' and property_name in value.get('error', ''), f'{control}/{backend}: must fail its behavior assertion, not tooling/import/timeout'
            stores[backend] = value
        matching = check_model(name, jar, area / 'model', mutation=mutation, violation=property_name)
        report['negativeControls'][control] = {'property': property_name, 'stores': stores, 'model': matching}
        shutil.rmtree(clone)
    for name in MODELS:
        area = evidence / name
        model = check_model(name, jar, area / 'restored')
        code = replay(name, ROOT, area / 'restored/graph.dot', area / 'restored-code.json', scratch)
        assert_replay(code, model)
        report['models'][name].update(restored=model, restoredImplementation=code)
    return report


def required_artifact(evidence, manifest, relative):
    path = evidence / relative
    assert str(relative) in manifest and path.is_file() and path.stat().st_size > 0, f'Missing required raw artifact: {relative}'
    return path


def verify_legacy_delivery(evidence, manifest, report):
    expected_controls = {'drop-final': 'AtomicPublication', 'accept-stale': 'CurrentCandidate', 'skip-snapshot': 'SnapshotBinding'}
    assert set(report['negativeControls']) == set(expected_controls), 'Legacy Delivery control omitted'
    for phase, summary_key in [('baseline', 'implementation'), ('restored', 'restoredImplementation')]:
        prefix = Path(phase)
        for filename in ['Delivery.tla', 'Delivery.cfg', 'tlc.log', 'result.json', 'graph.dot']:
            required_artifact(evidence, manifest, prefix / filename)
        for suffix in ['.json', '.log', '.json.jsonl']:
            required_artifact(evidence, manifest, Path(phase + '-code' + suffix))
        model = json.loads((evidence / prefix / 'result.json').read_text())
        code = json.loads((evidence / (phase + '-code.json')).read_text())
        assert model == report['models'][phase] and code == report[summary_key], 'Legacy raw result differs from run summary'
        assert model['exitCode'] == 0 and model['counts'][2] == 0 and code['exitCode'] == 0 and code['status'] == 'verified' and code['scratchRemoved']
        assert code['graphStates'] == model['counts'][1] and code['graphEdges'] + 1 == model['counts'][0]
        assert {item['backend'] for item in code['backends']} == {'memory', 'sqlite'}
        assert all(item['edgesReplayed'] == code['graphEdges'] for item in code['backends'])
        graph = (evidence / prefix / 'graph.dot').read_text()
        nodes = {key: {name: True if value == 'TRUE' else False if value == 'FALSE' else int(value)
                       for name, value in re.findall(r'(\w+) = (TRUE|FALSE|\d+)', label)}
                 for key, label in re.findall(r'^(-?\d+) \[label="((?:\\.|[^"\\])*)"', graph, re.M)}
        edges = Counter(re.findall(r'^(-?\d+) -> (-?\d+) \[label="(\w+)"', graph, re.M))
        assert len(nodes) == code['graphStates'] and sum(edges.values()) == code['graphEdges'], 'Legacy graph/count mismatch'
        rows = [json.loads(line) for line in (evidence / (phase + '-code.json.jsonl')).read_text().splitlines() if line]
        for backend in ['memory', 'sqlite']:
            selected = [row for row in rows if row['backend'] == backend]
            actual_edges = Counter((row['from'], row['to'], row['path'][-1]) for row in selected)
            assert actual_edges == edges, f'Legacy missing or duplicate raw edge observations: {backend}'
            assert all(row['actual'] == nodes[row['to']] for row in selected), 'Legacy raw replay target differs from TLC graph'
        config = (evidence / prefix / 'Delivery.cfg').read_text()
        checks = [token for line in re.findall(r'^INVARIANTS?\s+([^\n]+)$', config, re.M) for token in line.split()]
        assert checks == ['TypeOK', 'AtomicPublication', 'CurrentCandidate', 'VersionIsolation'], 'Legacy Delivery safety checks omitted'
        assert re.findall(r'^PROPERTY\s+(\w+)\s*$', config, re.M) == ['Progress'], 'Legacy Delivery Progress omitted'
        raw = (evidence / prefix / 'tlc.log').read_text()
        assert 'Model checking completed. No error has been found.' in raw and 'Finished checking temporal properties' in raw and '0 states left on queue' in raw
    for control, property_name in expected_controls.items():
        summary = report['negativeControls'][control]
        assert summary['property'] == property_name and set(summary['stores']) == {'memory', 'sqlite'}
        prefix = Path('negative-controls') / control
        required_artifact(evidence, manifest, prefix / 'real-code.diff')
        for backend in ['memory', 'sqlite']:
            value = json.loads(required_artifact(evidence, manifest, prefix / f'{backend}-code.json').read_text())
            log = required_artifact(evidence, manifest, prefix / f'{backend}-code.log').read_text()
            assert value == summary['stores'][backend], 'Legacy negative raw result differs from summary'
            assert value['exitCode'] == 1 and value['status'] == 'failed' and value['scratchRemoved']
            assert value['command'][-1] == backend, 'Legacy negative did not execute the selected backend'
            assert 'AssertionError' in value.get('error', '') and property_name in value['error'], 'Legacy negative did not violate its behavior property'
            assert 'AssertionError' in log and property_name in log, 'Legacy negative raw log lacks behavior failure'
        if control != 'skip-snapshot':
            raw = required_artifact(evidence, manifest, prefix / 'model/tlc.log').read_text()
            required_artifact(evidence, manifest, prefix / 'model/result.json')
            assert f'Invariant {property_name} is violated' in raw
    for witness in ['NeverPublished', 'NeverStopped', 'NeverChangedGoal', 'NeverRolledBack', 'NeverCrashed']:
        prefix = Path('reachability') / witness
        raw = required_artifact(evidence, manifest, prefix / 'tlc.log').read_text()
        value = json.loads(required_artifact(evidence, manifest, prefix / 'result.json').read_text())
        assert value['exitCode'] != 0 and f'Invariant {witness} is violated' in raw


def verify_composition_evidence(evidence):
    count = helpers.verify_evidence(evidence)
    report = json.loads((evidence / 'run.json').read_text())
    composition = report.get('composition', report)
    manifest = json.loads((evidence / 'artifacts.json').read_text())
    if 'composition' in report:
        verify_legacy_delivery(evidence, manifest, report)
    # The exact implementation driver is reviewable even before its first Git commit.
    for filename in ['tests/delivery-composition-fixture.ts', 'tests/source-lineage-formal-fixture.ts', 'features/40_delivery_composition.feature', 'tests/bdd/delivery-composition.steps.ts']:
        relative = ('checker-inputs/composition/' if 'composition' in report else 'checker-inputs/') + filename
        required_artifact(evidence, manifest, Path(relative))
    for name, definition in MODELS.items():
        recorded = composition['models'][name]
        area = evidence / 'composition' / name
        for phase in ['baseline', 'restored']:
            raw = (area / phase / 'tlc.log').read_text()
            matches = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', raw)
            counts = [int(value.replace(',', '')) for value in matches[-1]]
            assert counts == recorded[phase]['counts'] and counts[2] == 0
            assert 'Model checking completed. No error has been found.' in raw and 'Finished checking temporal properties' in raw
            config = (area / phase / f'{name}.cfg').read_text()
            validate_config(name, config)
            nodes, edges = {}, set()
            for line in (area / phase / 'graph.dot').read_text().splitlines():
                node = re.match(r'^(-?\d+) \[label="((?:\\.|[^"\\])*)"', line)
                if node:
                    nodes[node[1]] = {key: True if value == 'TRUE' else False if value == 'FALSE' else int(value)
                                     for key, value in re.findall(r'(\w+) = (TRUE|FALSE|\d+)', node[2])}
                edge = re.match(r'^(-?\d+) -> (-?\d+) \[label="(\w+)"', line)
                if edge: edges.add(edge.groups())
            assert len(nodes) == counts[1] and len(edges) + 1 == counts[0], 'Independent graph/count readback mismatch'
            code = json.loads((area / f'{phase}-code.json').read_text())
            assert code['status'] == 'verified' and code['exitCode'] == 0 and code['scratchRemoved']
            rows = [json.loads(line) for line in (area / f'{phase}-code.json.jsonl').read_text().splitlines()]
            for backend in ['memory', 'sqlite']:
                selected = [row for row in rows if row['backend'] == backend]
                assert len(selected) == len(edges)
                actual_edges = {(row['from'], row['to'], row['path'][-1]) for row in selected}
                assert actual_edges == edges, 'Independent readback: missing or duplicate backend edges'
                assert all(row['actual'] == nodes[row['to']] for row in selected), 'Independent readback: replay projection differs from TLC target'
        for witness in definition['witnesses']:
            raw = (area / 'reachability' / witness / 'tlc.log').read_text()
            assert f'Invariant {witness} is violated' in raw
    assert set(composition['negativeControls']) == {row[0] for row in CONTROLS}
    for control, name, property_name, *_ in CONTROLS:
        value = composition['negativeControls'][control]
        assert value['property'] == property_name and set(value['stores']) == {'memory', 'sqlite'}, 'Missing or changed backend/property control summary'
        prefix = Path('composition/negative-controls') / control
        required_artifact(evidence, manifest, prefix / 'real-code.diff')
        for backend in ['memory', 'sqlite']:
            observed = json.loads(required_artifact(evidence, manifest, prefix / f'{backend}-code.json').read_text())
            raw_log = required_artifact(evidence, manifest, prefix / f'{backend}-code.log').read_text()
            assert observed == value['stores'][backend], 'Raw negative result differs from run summary'
            assert observed['status'] == 'failed' and observed['exitCode'] == 1 and observed['scratchRemoved'], 'Negative command must fail normally with exit 1'
            assert 'AssertionError' in observed.get('error', '') and property_name in observed['error'], 'Negative must violate its named behavior assertion'
            assert observed.get('counterexample', {}).get('backend') == backend, 'Negative did not reach the required backend'
            assert 'AssertionError' in raw_log and property_name in raw_log, 'Raw negative log does not contain the behavior failure'
        raw = required_artifact(evidence, manifest, prefix / 'model/tlc.log').read_text()
        required_artifact(evidence, manifest, prefix / 'model/result.json')
        assert f'Invariant {property_name} is violated' in raw
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, required=False)
    parser.add_argument('--verify-evidence', type=Path)
    parser.add_argument('--jar', type=Path, default=Path(os.environ.get('TLA2TOOLS_JAR', '/workspace/work/tla2tools-1.7.4.jar')))
    args = parser.parse_args()
    if args.verify_evidence:
        print(f'Evidence verified: {verify_composition_evidence(args.verify_evidence.resolve())} artifacts')
        return 0
    evidence = (args.evidence or ROOT / 'reports/verify-squad-delivery' / f'composition-{time.time_ns()}').resolve()
    assert not evidence.exists(), 'Use a fresh evidence directory'
    evidence.mkdir(parents=True)
    scratch = Path(tempfile.mkdtemp(prefix='squad-delivery-composition-'))
    covered = json.loads((SKILL / 'references/coverage.json').read_text())['files']
    before = {path: helpers.digest(ROOT / path) for path in covered}
    report = {'status': 'running', 'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(), 'coveredFileHashes': before}
    inputs = evidence / 'checker-inputs'
    inputs.mkdir()
    for path in [*SKILL.glob('scripts/*.py'), *SKILL.glob('scripts/*.mjs'), *SKILL.glob('scripts/*.tla'), *SKILL.glob('scripts/*.cfg'),
                 ROOT / 'tests/delivery-composition-fixture.ts', ROOT / 'tests/source-lineage-formal-fixture.ts', ROOT / 'features/40_delivery_composition.feature', ROOT / 'tests/bdd/delivery-composition.steps.ts',
                 SKILL / 'references/coverage.json', SKILL / 'references/correspondence.md', helper_file]:
        relative = path.relative_to(ROOT)
        destination = inputs / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
    try:
        drift = [path for path, value in before.items() if covered[path] != value]
        assert not drift, 'BLOCKED: covered-source correspondence drift: ' + ', '.join(drift)
        jar = helpers.jar_at(args.jar.resolve())
        report['tool'] = {'release': 'TLA+ Tools v1.7.4 / TLC 2.19', 'sha256': helpers.digest(jar)}
        report.update(run(jar, evidence / 'composition', scratch / 'slices'))
        report['status'] = 'verified'
    except Exception as error:
        report.update(status='blocked' if str(error).startswith('BLOCKED:') else 'failed', error=str(error))
    finally:
        shutil.rmtree(scratch)
        report['cleanup'] = {'scratchRemoved': not scratch.exists(), 'coveredFilesUnchanged': before == {path: helpers.digest(ROOT / path) for path in covered}, 'evidenceRetained': evidence.exists()}
        if not all(report['cleanup'].values()): report['status'] = 'failed'
        entries = {str(path.relative_to(evidence)): {'sha256': helpers.digest(path), 'bytes': path.stat().st_size} for path in sorted(evidence.rglob('*')) if path.is_file() and 'states' not in path.relative_to(evidence).parts}
        helpers.save_bytes(evidence / 'artifacts.json', json.dumps(entries, indent=2).encode())
        report['evidenceManifestSha256'] = helpers.digest(evidence / 'artifacts.json')
        helpers.save_bytes(evidence / 'run.json', json.dumps(report, indent=2).encode())
        if report['status'] == 'verified': verify_composition_evidence(evidence)
        print(json.dumps(report, indent=2))
    return 0 if report['status'] == 'verified' else 1

if __name__ == '__main__':
    raise SystemExit(main())
