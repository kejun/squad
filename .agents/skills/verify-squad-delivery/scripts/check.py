#!/usr/bin/env python3
"""TLC finite publication protocol, real transaction replays, receipt binding controls."""
import argparse
import difflib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

sys.dont_write_bytecode = True
SKILL = Path(__file__).resolve().parents[1]
ROOT = SKILL.parents[2]
# Reuse evidence integrity, fixed verified TLC download, and bounded subprocess I/O.
HELPER = ROOT / '.agents/skills/verify-squad-handoff/scripts/check.py'
spec = importlib.util.spec_from_file_location('handoff_helpers', HELPER)
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
digest, execute, jar_at = helpers.digest, helpers.execute, helpers.jar_at
composition_spec = importlib.util.spec_from_file_location('delivery_composition', SKILL / 'scripts/composition-check.py')
composition = importlib.util.module_from_spec(composition_spec)
composition_spec.loader.exec_module(composition)

CONTROLS = {
    'drop-final': ('AtomicPublication', 'src/task/operations.ts',
                   "if (outcome !== 'stopped') {", "if (outcome !== 'stopped' && outcome !== 'complete') {"),
    'accept-stale': ('CurrentCandidate', 'src/task/delivery.ts',
                     'e.candidateRevision !== candidate.revision || ', ''),
    'skip-snapshot': ('SnapshotBinding', 'src/task/evidence.ts',
                      'if (expected && snapshot !== undefined && expected.resourceSnapshot !== snapshot) return undefined;',
                      '// Negative control: omit immutable resource receipt binding.'),
}
WITNESSES = ['NeverPublished', 'NeverStopped', 'NeverChangedGoal', 'NeverRolledBack', 'NeverCrashed']


def model(jar, area, mutation='none', witness=None):
    area.mkdir(parents=True)
    shutil.copyfile(SKILL / 'scripts/Delivery.tla', area / 'Delivery.tla')
    cfg = (SKILL / 'scripts/Delivery.cfg').read_text()
    assert cfg.count('Mutation = "none"') == 1, 'Model configuration mutation anchor drift'
    assert 'INVARIANTS TypeOK AtomicPublication CurrentCandidate VersionIsolation' in cfg and 'PROPERTY Progress' in cfg, 'Required model checks missing'
    cfg = cfg.replace('Mutation = "none"', f'Mutation = "{mutation}"')
    if witness:
        cfg = re.sub(r'^INVARIANTS .*$', 'INVARIANT ' + witness, cfg, flags=re.M)
        cfg = cfg.replace('PROPERTY Progress\n', '')
    (area / 'Delivery.cfg').write_text(cfg)
    java_tmp = area / 'java-tmp'
    java_tmp.mkdir()
    command = ['java', '-Djava.io.tmpdir=' + str(java_tmp), '-XX:+UseParallelGC', '-Xmx512m', '-jar', str(jar), '-workers', '1', '-seed', '1',
               '-metadir', str(area / 'states'), '-dump', 'dot,actionlabels', str(area / 'graph.dot'), '-config', 'Delivery.cfg', 'Delivery.tla']
    code, seconds = execute(command, area / 'tlc.log', area)
    log = (area / 'tlc.log').read_text()
    counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', log)
    result = {'command': command, 'exitCode': code, 'seconds': seconds, 'mutation': mutation, 'witness': witness,
              'logSha256': digest(area / 'tlc.log'), 'logBytes': (area / 'tlc.log').stat().st_size,
              'counts': [int(v.replace(',', '')) for v in counts[-1]] if counts else None}
    if witness or mutation != 'none':
        expected = witness or CONTROLS[mutation][0]
        assert code != 0 and f'Invariant {expected} is violated' in log, f'Expected property violation, not tooling failure: {area}'
    else:
        assert code == 0 and 'Model checking completed. No error has been found.' in log, f'Model incomplete: {area}'
        assert counts and result['counts'][2] == 0 and 'Finished checking temporal properties' in log, 'Incomplete exhaustive/liveness check'
    (area / 'result.json').write_text(json.dumps(result, indent=2))
    return result


def replay(root, graph, output, cwd, backend='both'):
    command = ['node', '--import', str(ROOT / 'node_modules/tsx/dist/loader.mjs'), str(SKILL / 'scripts/compare.mjs'),
               str(root), str(graph), str(output), backend]
    code, seconds = execute(command, output.with_suffix('.log'), cwd, timeout=90)
    assert output.exists(), f'Replay did not execute: {output}'
    value = json.loads(output.read_text())
    value.update(exitCode=code, seconds=seconds, command=command)
    output.write_text(json.dumps(value, indent=2))
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--verify-evidence', type=Path)
    parser.add_argument('--jar', type=Path, default=Path(os.environ.get('TLA2TOOLS_JAR', str(Path.home() / '.cache/squad-formal/tla2tools-1.7.4.jar'))))
    args = parser.parse_args()
    if args.verify_evidence:
        print(f'Evidence verified: {composition.verify_composition_evidence(args.verify_evidence.resolve())} artifacts')
        return 0
    evidence = (args.evidence or ROOT / 'reports/verify-squad-delivery' / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + f'-{os.getpid()}')).resolve()
    assert not evidence.exists(), 'Evidence directory must be new'
    evidence.mkdir(parents=True)
    inputs = evidence / 'checker-inputs'
    inputs.mkdir()
    for relative in ['scripts/check.py', 'scripts/compare.mjs', 'scripts/Delivery.tla', 'scripts/Delivery.cfg', 'references/coverage.json', 'references/correspondence.md', 'references/drift-review-pr40.json', 'references/drift-review-kej-102-105.json', 'SKILL.md']:
        destination = inputs / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(SKILL / relative, destination)
    shutil.copyfile(HELPER, inputs / 'handoff-check-helper.py')
    composition_inputs = [*SKILL.glob('scripts/composition-*'), *SKILL.glob('scripts/Verification.*'), *SKILL.glob('scripts/Cycles.*'), *SKILL.glob('scripts/SourceLineage.*'),
                          ROOT / 'tests/delivery-composition-fixture.ts', ROOT / 'tests/source-lineage-formal-fixture.ts',
                          ROOT / 'features/40_delivery_composition.feature', ROOT / 'tests/bdd/delivery-composition.steps.ts',
                          SKILL / 'references/drift-review-kej-107-108.json']
    for source in composition_inputs:
        destination = inputs / 'composition' / source.relative_to(ROOT)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)

    coverage = json.loads((SKILL / 'references/coverage.json').read_text())
    before = {p: digest(ROOT / p) for p in coverage['files']}
    checker_paths = set(composition_inputs + [HELPER, SKILL / 'scripts/check.py', SKILL / 'scripts/compare.mjs', SKILL / 'scripts/Delivery.tla', SKILL / 'scripts/Delivery.cfg', SKILL / 'references/coverage.json', SKILL / 'references/correspondence.md', SKILL / 'SKILL.md'])
    checker_before = {str(path.relative_to(ROOT)): digest(path) for path in checker_paths}
    report = {'status': 'running', 'evidence': str(evidence), 'syncCommit': coverage['syncCommit'], 'bounds': coverage['bounds'],
              'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'workingTree': subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip(),
              'coveredFileHashes': before, 'checkerFileHashes': checker_before, 'models': {}, 'negativeControls': {}}
    scratch = Path(tempfile.mkdtemp(prefix='squad-delivery-check-'))
    started = time.monotonic()
    try:
        drift = [p for p, value in before.items() if value != coverage['files'][p]]
        assert not drift, 'BLOCKED: code correspondence review required: ' + ', '.join(drift)
        jar = jar_at(args.jar.resolve())
        report['tool'] = {'release': 'TLA+ Tools v1.7.4 / TLC 2.19', 'sha256': digest(jar)}
        report['models']['baseline'] = model(jar, evidence / 'baseline')
        graph = evidence / 'baseline/graph.dot'
        baseline = replay(ROOT, graph, evidence / 'baseline-code.json', scratch)
        report['implementation'] = baseline
        assert baseline['exitCode'] == 0 and baseline['status'] == 'verified', 'Real implementation failed; inspect baseline-code.json'
        assert baseline['graphStates'] == report['models']['baseline']['counts'][1]
        assert baseline['graphEdges'] + 1 == report['models']['baseline']['counts'][0]
        for witness in WITNESSES:
            report['models'][witness] = model(jar, evidence / 'reachability' / witness, witness=witness)
        for name, (expected, path, old, new) in CONTROLS.items():
            clone = scratch / name
            clone.mkdir()
            shutil.copytree(ROOT / 'src', clone / 'src')
            for filename in ['team.config.ts', 'package.json']:
                shutil.copyfile(ROOT / filename, clone / filename)
            (clone / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            source = clone / path
            original = source.read_text()
            assert original.count(old) == 1, f'Mutation anchor drift: {name}'
            mutated = original.replace(old, new)
            source.write_text(mutated)
            area = evidence / 'negative-controls' / name
            area.mkdir(parents=True)
            (area / 'real-code.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), mutated.splitlines(True), fromfile=path, tofile=path)))
            stores = {}
            for backend in ['memory', 'sqlite']:
                value = replay(clone, graph, area / f'{backend}-code.json', scratch, backend)
                assert value['exitCode'] != 0 and expected in value.get('error', ''), f'Control must violate {expected}, not fail to import/build: {name}/{backend}'
                stores[backend] = value
            result = {'property': expected, 'stores': stores}
            # Receipt corruption is an input-level check, outside the event model.
            if name != 'skip-snapshot': result['model'] = model(jar, area / 'model', mutation=name)
            report['negativeControls'][name] = result
            shutil.rmtree(clone)
        report['models']['restored'] = model(jar, evidence / 'restored')
        restored = replay(ROOT, evidence / 'restored/graph.dot', evidence / 'restored-code.json', scratch)
        report['restoredImplementation'] = restored
        assert restored['exitCode'] == 0 and restored['status'] == 'verified', 'Restored implementation did not pass'
        report['composition'] = composition.run(jar, evidence / 'composition', scratch / 'composition')
        report['status'] = 'verified'
    except Exception as error:
        report['status'] = 'blocked' if str(error).startswith('BLOCKED:') else 'failed'
        report['error'] = str(error)
    finally:
        shutil.rmtree(scratch)
        report['cleanup'] = {'scratchRemoved': not scratch.exists(), 'coveredFilesUnchanged': before == {p: digest(ROOT / p) for p in before}, 'evidenceRetained': evidence.exists(), 'checkerInputsUnchanged': checker_before == {path: digest(ROOT / path) for path in checker_before}}
        if not all(report['cleanup'].values()): report['status'] = 'failed'
        report['seconds'] = time.monotonic() - started
        artifacts = {str(p.relative_to(evidence)): {'sha256': digest(p), 'bytes': p.stat().st_size}
                     for p in sorted(evidence.rglob('*')) if p.is_file() and 'states' not in p.relative_to(evidence).parts}
        helpers.save_bytes(evidence / 'artifacts.json', json.dumps(artifacts, indent=2).encode())
        report['evidenceManifestSha256'] = digest(evidence / 'artifacts.json')
        helpers.save_bytes(evidence / 'run.json', json.dumps(report, ensure_ascii=False, indent=2).encode())
        if report['status'] == 'verified': composition.verify_composition_evidence(evidence)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report['status'] == 'verified' else 1

if __name__ == '__main__':
    raise SystemExit(main())
