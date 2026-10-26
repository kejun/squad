#!/usr/bin/env python3
"""Finite TLC checking + real-code edge replays + real-code negative controls."""
import argparse
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
JAR_SHA256 = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
JAR_URL = 'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar'
PROPERTIES = ['TypeOK', 'AtomicHandoff', 'AtMostOnce', 'StopCancelsResume']
CONTROLS = {
    'drop-marker': ('AtomicHandoff', 'src/task.machine.ts',
                    'if (recorded) recorded.consumed = true;',
                    'if (recorded) recorded.consumed = false;'),
    'double-resume': ('AtMostOnce', 'src/task.machine.ts',
                     '    owner(c, e, { requestId: h.id, resultId: e.resultId, status: e.status, answer: e.answer, artifactIds, requiresAssessment: true });',
                     '    owner(c, e, { requestId: h.id, resultId: e.resultId, status: e.status, answer: e.answer, artifactIds, requiresAssessment: true });\n'
                     '    owner(c, e, { requestId: h.id, resultId: e.resultId, status: e.status, answer: e.answer, artifactIds, requiresAssessment: true });'),
    'skip-cancel': ('StopCancelsResume', 'src/task.machine.ts',
                   "if (item.status === 'pending') item.status = 'cancelled';",
                   "if (item.status === 'pending' && item.kind !== 'owner') item.status = 'cancelled';"),
    'starve-flush': ('RunnerProgress', 'src/runner.ts',
                     'if (this.engine.flushResults(roomId, taskId)) return true;',
                     'if (false && this.engine.flushResults(roomId, taskId)) return true;'),
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save_bytes(path, value):
    part = path.with_name(path.name + f'.{os.getpid()}.part')
    with part.open('wb') as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    part.replace(path)


def execute(command, log, cwd, timeout=45):
    started = time.monotonic()
    try:
        result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        save_bytes(log, error.stdout or b'')
        raise RuntimeError(f'BLOCKED: timeout after {timeout}s: {log}') from error
    # Capture through PIPE and write after exit: no child retains our log handle.
    save_bytes(log, result.stdout)
    return result.returncode, time.monotonic() - started


def jar_at(path):
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_name(path.name + f'.{os.getpid()}.part')
        try:
            subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--max-time', '45',
                            JAR_URL, '--output', str(part)], check=True, timeout=50)
            assert digest(part) == JAR_SHA256, 'TLA+ archive checksum mismatch'
            part.replace(path)
        finally:
            part.unlink(missing_ok=True)
    assert digest(path) == JAR_SHA256, f'Wrong tla2tools.jar: {path}'
    return path


def check_model(jar, area, mutation='none', witness=None):
    area.mkdir(parents=True)
    shutil.copyfile(SKILL / 'scripts/Handoff.tla', area / 'Handoff.tla')
    cfg = (SKILL / 'scripts/Handoff.cfg').read_text()
    assert cfg.count('CONSTANT Mutation = "none"') == 1, 'Configuration mutation anchor drift'
    assert all(p in cfg for p in PROPERTIES + ['PROPERTY Progress']), 'Required model properties missing'
    cfg = cfg.replace('CONSTANT Mutation = "none"', f'CONSTANT Mutation = "{mutation}"')
    if witness:
        cfg = re.sub(r'^INVARIANTS .*$', 'INVARIANT ' + witness, cfg, flags=re.M)
        cfg = re.sub(r'^PROPERTY Progress\n?', '', cfg, flags=re.M)
    (area / 'Handoff.cfg').write_text(cfg)
    command = ['java', '-XX:+UseParallelGC', '-Xmx512m', '-jar', str(jar), '-workers', '1', '-seed', '1',
               '-metadir', str(area / 'states'), '-dump', 'dot,actionlabels', str(area / 'graph.dot'),
               '-config', 'Handoff.cfg', 'Handoff.tla']
    code, duration = execute(command, area / 'tlc.log', area)
    raw = (area / 'tlc.log').read_text()
    counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', raw)
    summary = {'command': command, 'exitCode': code, 'seconds': round(duration, 3), 'mutation': mutation, 'witness': witness,
               'logSha256': digest(area / 'tlc.log'), 'logBytes': (area / 'tlc.log').stat().st_size,
               'counts': list(map(lambda x: int(x.replace(',', '')), counts[-1])) if counts else None}
    if witness:
        assert code != 0 and f'Invariant {witness} is violated' in raw, f'Reachability witness not established: {area}'
    elif mutation != 'none':
        property_name = 'Progress' if mutation == 'starve-flush' else CONTROLS[mutation][0]
        expected = 'Temporal properties were violated' if property_name == 'Progress' else f'Invariant {property_name} is violated'
        assert code != 0 and expected in raw, f'Negative model must violate {property_name}, not fail to build: {area}'
        summary['violatedProperty'] = property_name
    else:
        assert code == 0 and 'Model checking completed. No error has been found.' in raw, f'Model did not complete: {area}'
        assert counts and summary['counts'][2] == 0, 'Incomplete model state exploration'
        assert 'Finished checking temporal properties' in raw, 'Liveness was not checked'
    (area / 'result.json').write_text(json.dumps(summary, indent=2))
    return summary


def compare(target, graph, output, scratch, backend='both'):
    command = ['node', '--import', str(ROOT / 'node_modules/tsx/dist/loader.mjs'),
               str(SKILL / 'scripts/compare.mjs'), str(target), str(graph), str(output), backend]
    code, duration = execute(command, output.with_suffix('.log'), scratch)
    assert output.exists(), f'Code replay did not execute: {output}'
    value = json.loads(output.read_text())
    value['exitCode'], value['seconds'] = code, round(duration, 3)
    return value


def verify_evidence(evidence):
    report = json.loads((evidence / 'run.json').read_text())
    manifest = evidence / 'artifacts.json'
    assert digest(manifest) == report['evidenceManifestSha256'], 'Evidence manifest changed'
    entries = json.loads(manifest.read_text())
    assert entries, 'Empty evidence manifest'
    for relative, expected in entries.items():
        path = evidence / relative
        assert path.is_file() and path.stat().st_size == expected['bytes'] and digest(path) == expected['sha256'], f'Evidence missing or changed: {relative}'
    for result in evidence.rglob('result.json'):
        if 'states' in result.parts:
            continue
        value = json.loads(result.read_text())
        log = result.with_name('tlc.log')
        assert digest(log) == value['logSha256'] and log.stat().st_size == value['logBytes'], f'Incomplete raw TLC log: {log}'
    assert report['status'] == 'verified' and all(report['cleanup'].values()), 'Run itself is not verified'
    return len(entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--verify-evidence', type=Path, help='Read-only verification of an existing completed evidence directory')
    parser.add_argument('--jar', type=Path, default=Path(os.environ.get('TLA2TOOLS_JAR',
        str(Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache')) / 'squad-formal/tla2tools-1.7.4.jar'))))
    args = parser.parse_args()
    if args.verify_evidence:
        count = verify_evidence(args.verify_evidence.resolve())
        print(f'Evidence verified: {count} retained artifacts')
        return 0
    evidence = (args.evidence or ROOT / 'reports/verify-squad-handoff' / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + f'-{os.getpid()}')).resolve()
    assert not evidence.exists(), 'Use a new evidence directory; never overwrite a proof'
    evidence.mkdir(parents=True)
    audit = json.loads((SKILL / 'references/coverage.json').read_text())
    before = {p: digest(ROOT / p) for p in audit['files']}
    report = {'status': 'running', 'evidence': str(evidence), 'syncCommit': audit['syncCommit'],
              'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'workingTree': subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip(),
              'coveredFileHashes': before, 'bounds': audit['bounds'], 'models': {}, 'negativeControls': {}}
    started = time.monotonic()
    scratch = Path(tempfile.mkdtemp(prefix='squad-formal-check-'))
    try:
        drift = [p for p, sha in before.items() if sha != audit['files'][p]]
        assert not drift, 'BLOCKED: covered code changed; perform the documented code-to-model audit before updating coverage.json: ' + ', '.join(drift)
        jar = jar_at(args.jar.resolve())
        report['tool'] = {'release': 'TLA+ Tools v1.7.4 / TLC 2.19', 'sha256': digest(jar)}
        print('Checking complete finite model, then replaying every labeled graph edge on real code...', flush=True)
        report['models']['baseline'] = check_model(jar, evidence / 'baseline')
        graph = evidence / 'baseline/graph.dot'
        baseline = compare(ROOT, graph, evidence / 'baseline-code.json', scratch)
        report['implementation'] = baseline
        assert baseline['exitCode'] == 0 and baseline['status'] == 'verified', 'Real-code conformance or property violation; inspect baseline-code.json'
        assert baseline['graphStates'] == report['models']['baseline']['counts'][1], 'Graph parser omitted TLC states'
        assert baseline['graphEdges'] + 1 == report['models']['baseline']['counts'][0], 'Graph parser omitted labeled successor transitions'
        for witness in ['NeverEligible', 'NeverHandedOff', 'NeverStoppedSaved', 'NeverStaleSaved', 'NeverRolledBack', 'NeverNewEpochSaved']:
            report['models'][witness] = check_model(jar, evidence / 'reachability' / witness, witness=witness)
        print('Exercising four real-code mutations and matching model counterexamples...', flush=True)
        for name, (expected, source, old, new) in CONTROLS.items():
            clone = scratch / name
            clone.mkdir()
            shutil.copytree(ROOT / 'src', clone / 'src')
            for file in ['team.config.ts', 'package.json']:
                shutil.copyfile(ROOT / file, clone / file)
            (clone / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            path = clone / source
            original = path.read_text()
            assert original.count(old) == 1, f'Negative-control anchor drift: {name}'
            mutated = original.replace(old, new)
            path.write_text(mutated)
            area = evidence / 'negative-controls' / name
            area.mkdir(parents=True)
            (area / 'real-code.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), mutated.splitlines(True), fromfile=source, tofile=source)))
            # Checker input graph/model is unchanged here: this exercises the
            # implementation correspondence rather than a model-only mutation.
            proofs = {}
            for backend in ['memory', 'sqlite']:
                value = compare(clone, graph, area / f'{backend}-code.json', scratch, backend)
                assert value['exitCode'] != 0 and expected in value.get('error', ''), f'Negative code must violate {expected}, not fail to import/build: {area}/{backend}'
                proofs[backend] = value
            model = check_model(jar, area / 'model', mutation=name)
            report['negativeControls'][name] = {'codeProperty': expected, 'stores': proofs, 'model': model}
            shutil.rmtree(clone)
        print('Rerunning unmodified model and implementation after removing scratch mutations...', flush=True)
        report['models']['restored'] = check_model(jar, evidence / 'restored')
        restored = compare(ROOT, evidence / 'restored/graph.dot', evidence / 'restored-code.json', scratch)
        assert restored['exitCode'] == 0 and restored['status'] == 'verified', 'Baseline did not return to passing'
        report['restoredImplementation'] = restored
        report['status'] = 'verified'
    except Exception as error:
        report['status'] = 'blocked' if str(error).startswith('BLOCKED:') else 'failed'
        report['error'] = str(error)
    finally:
        shutil.rmtree(scratch)
        unchanged = before == {p: digest(ROOT / p) for p in audit['files']}
        report['cleanup'] = {'scratchRemoved': not scratch.exists(), 'coveredFilesUnchanged': unchanged,
                             'evidenceRetained': evidence.exists()}
        if not unchanged:
            report['status'] = 'failed'
        report['seconds'] = round(time.monotonic() - started, 3)
        artifacts = {str(p.relative_to(evidence)): {'sha256': digest(p), 'bytes': p.stat().st_size}
                     for p in sorted(evidence.rglob('*')) if p.is_file() and 'states' not in p.relative_to(evidence).parts}
        save_bytes(evidence / 'artifacts.json', json.dumps(artifacts, indent=2).encode())
        report['evidenceManifestSha256'] = digest(evidence / 'artifacts.json')
        save_bytes(evidence / 'run.json', json.dumps(report, ensure_ascii=False, indent=2).encode())
        if report['status'] == 'verified':
            try:
                verify_evidence(evidence)
            except Exception as error:
                report['status'] = 'failed'
                report['error'] = f'Evidence integrity: {error}'
                save_bytes(evidence / 'run.json', json.dumps(report, ensure_ascii=False, indent=2).encode())
        print(json.dumps({k: report[k] for k in ['status', 'source', 'evidence', 'seconds', 'cleanup']}, ensure_ascii=False, indent=2))
        if report.get('error'):
            print(report['error'], file=sys.stderr)
    return 0 if report['status'] == 'verified' else 1


if __name__ == '__main__':
    raise SystemExit(main())
