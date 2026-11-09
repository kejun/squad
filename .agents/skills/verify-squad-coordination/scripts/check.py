#!/usr/bin/env python3
"""Bounded coordination models, all-edge implementation replays and real faults."""
import argparse
import difflib
import hashlib
import importlib.util
import sys
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
JAR_SHA = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
WITNESSES = {
    'Budget': ['NeverRetry', 'NeverRecoveryCharge', 'NeverContinuation', 'NeverBudgetExhausted', 'NeverUncertain'],
    'Shards': ['NeverSecondFirst', 'NeverPartial', 'NeverFailure', 'NeverHandoff', 'NeverStoppedInflight', 'NeverStaleInflight', 'NeverReopenedSaved', 'NeverInterruptedRecovery'],
    'CheckBudget': ['NeverThreeRequests', 'NeverTechnicalRetry', 'NeverRevised', 'NeverRepeatedRecovery', 'NeverBeforeRequestFailure', 'NeverUncertain'],
}
CONTROLS = {
    'skip-ended-discussion-recovery': ('Shards', 'EndedDiscussionRecovery', 'src/engine.ts',
        "if (taskPhase(snapshot) === 'ended' && !snapshot.context.intents.some(work => canRetireDiscussionWork(snapshot.context, work))) continue;",
        "if (taskPhase(snapshot) === 'ended') continue;"),
    'omit-discussion-recovery-retirement': ('Shards', 'CancelledRecovery', 'src/task/reducer.ts',
        'for (const work of c.intents.filter(work => canRetireDiscussionWork(c, work))) release(c, work.id);',
        '/* faulty omission of obsolete discussion retirement at recovery */'),
    'omit-obsolete-member-exclusion': ('Shards', 'ObsoleteMemberRecovery', 'src/task/facts.ts',
        "['pending', 'inflight'].includes(i.status) && !canRetireDiscussionWork(c, i)",
        "['pending', 'inflight'].includes(i.status)"),
    'omit-known-local-retirement': ('Shards', 'SettledDiscussionRecovery', 'src/task/reducer.ts',
        "if ((e.type === 'LOCAL_RESULT' || e.type === 'LOCAL_RECONCILE') && work && canRetireDiscussionWork(c, work)) release(c, work.id);",
        '/* faulty omission of obsolete discussion retirement after known local effects */'),
    'retire-unsafe-discussion': ('Shards', 'UnsafeRetention', 'src/task/facts.ts',
        "&& work.replay === 'safe' && !localPhysicalPending(work)",
        '&& !localPhysicalPending(work)'),
    'retire-current-discussion': ('Shards', 'ActiveDiscussionRecovery', 'src/task/facts.ts',
        '&& (!discussionActive(c) || work.discussionId !== c.discussion!.id || work.epoch !== c.epoch || work.goalVersion !== c.goalVersion);',
        '&& true;'),
    'omit-interpretation-reservation': ('Shards', 'CapacitySnapshot', 'src/task/input.ts',
        'maxPartitions: mapReduceCapacity(c, 1),', 'maxPartitions: mapReduceCapacity(c),'),
    'omit-capacity-refresh': ('Shards', 'CapacityRefresh', 'src/task/reducer.ts',
        "if (typeof work.payload.maxPartitions === 'number') work.payload.maxPartitions = mapReduceCapacity(c);",
        '/* faulty reuse of stale capacity */'),
    'backfill-legacy-capacity': ('Shards', 'LegacyCapacity', 'src/task/reducer.ts',
        "if (typeof work.payload.maxPartitions === 'number') work.payload.maxPartitions = mapReduceCapacity(c);",
        'work.payload.maxPartitions = mapReduceCapacity(c);'),
    'skip-capacity-dispatch-guard': ('Shards', 'CapacityDispatch', 'src/task/map-reduce.ts',
        'if (plan.partitions.length > mapReduceCapacity(c)) {', 'if (false) {'),
    'ignore-adapter-capacity': ('Shards', 'CapacityValidation', 'src/input-intent.ts',
        '&& (maxPartitions === undefined || !parsed.data.decomposition || parsed.data.decomposition.partitions.length <= maxPartitions)',
        '&& true /* faulty acceptance above the host ceiling */'),
    'omit-claim-charge': ('Budget', 'PaidBudget', 'src/task/reducer.ts',
        "else if (work.bucket !== 'none' && !isBoundedCheck(work)) c.usage[work.bucket]++;",
        "else if (work.bucket !== 'none' && !isBoundedCheck(work)) { /* faulty free claim */ }"),
    'ignore-retry-limit': ('Budget', 'RetryBound', 'src/task/budget.ts',
        '&& c.usage.retries < c.config.limits.retries && hasOrdinary(c) && !requestBudgetProblem(c, work);',
        '&& hasOrdinary(c) && !requestBudgetProblem(c, work);'),
    'premature-reduce': ('Shards', 'AllSettledBeforeReduce', 'src/task/discussion.ts',
        "if (!c.intents.some(item => item.discussionId === c.discussion!.id && item.kind === 'assistance' && ['pending', 'inflight'].includes(item.status))) summarizeDiscussion(c, e);",
        'summarizeDiscussion(c, e);'),
    'erase-partial-evidence': ('Shards', 'PreserveIncomplete', 'src/task/discussion.ts',
        "if (e.status !== 'success') c.discussion!.incomplete = '部分讨论工作未完整完成，详见原始意见。';",
        '/* faulty omission of incomplete marker */'),
    'duplicate-owner-handoff': ('Shards', 'UniqueHandoff', 'src/task/reducer.ts',
        "owner(c, e, { reason: '吸收协调员汇总和全部成员原始意见，在已有草稿上继续完善；区分共识、分歧、依据和未完成项。', previousBlocker: c.reason });",
        "owner(c, e, { reason: '吸收协调员汇总和全部成员原始意见，在已有草稿上继续完善；区分共识、分歧、依据和未完成项。', previousBlocker: c.reason });\n      owner(c, e, { reason: 'faulty duplicate handoff' });"),
    'accept-old-shard-attempt': ('Shards', 'NoStaleAttempt', 'src/task/policy.ts',
        "if (e.attempt !== undefined && c.intents.find(work => work.id === attemptWorkId)?.attempt !== e.attempt) return 'STALE_ATTEMPT';",
        '/* faulty acceptance of a previous physical attempt */'),
    'omit-summary-progress': ('Shards', 'ProgressHandoff', 'src/task/discussion.ts',
        "if (!c.intents.some(item => item.discussionId === c.discussion!.id && item.kind === 'assistance' && ['pending', 'inflight'].includes(item.status))) summarizeDiscussion(c, e);",
        '/* faulty omission of the enabled reducer */'),
    'omit-check-charge': ('CheckBudget', 'CheckAccounting', 'src/task/reducer.ts',
        'c.usage.checks++;', '/* faulty uncharged check request */'),
    'reuse-check-request-permit': ('CheckBudget', 'BoundedChecks', 'src/task/policy.ts',
        "if (i.requestCount > 0 && !hasDeliveryRetryPermit(c, i)) return 'CHECK_REQUEST_NOT_AUTHORIZED';",
        '/* faulty reuse of one request permit */'),
    'omit-technical-retry-charge': ('CheckBudget', 'OneTechnicalRetry', 'src/task/budget.ts',
        'c.usage.retries++;', '/* faulty uncharged retry reservation */'),
    'omit-revision-marker': ('CheckBudget', 'OneRevision', 'src/task/reducer.ts',
        'c.deliveryCycle!.revisionUsed = true;', '/* faulty revision marker omission */'),
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    part = path.with_name(path.name + '.part')
    part.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    part.replace(path)


def execute(command, cwd, log, timeout=180):
    started = time.monotonic()
    try:
        result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        log.write_bytes(error.stdout or b'')
        raise RuntimeError(f'BLOCKED: command exceeded {timeout}s; see {log}') from error
    log.write_bytes(result.stdout)
    return {'command': command, 'exitCode': result.returncode, 'seconds': round(time.monotonic() - started, 3)}


def tlc(jar, model, area, witness=None):
    area.mkdir(parents=True)
    (area / 'java-tmp').mkdir()
    shutil.copyfile(SKILL / f'scripts/{model}.tla', area / f'{model}.tla')
    cfg = (SKILL / f'scripts/{model}.cfg').read_text()
    if witness:
        cfg = re.sub(r'^INVARIANTS .*$', 'INVARIANT ' + witness, cfg, flags=re.M)
        cfg = re.sub(r'^PROPERTY .*\n?', '', cfg, flags=re.M)
    (area / f'{model}.cfg').write_text(cfg)
    result = execute(['java', '-XX:+UseParallelGC', '-Xmx512m', '-Djava.io.tmpdir=' + str(area / 'java-tmp'), '-jar', str(jar), '-workers', '1', '-seed', '1',
        '-metadir', str(area / 'states'), '-dump', 'dot,actionlabels', str(area / 'graph.dot'),
        '-config', f'{model}.cfg', f'{model}.tla'], area, area / 'tlc.log', timeout=45)
    raw = (area / 'tlc.log').read_text()
    counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', raw)
    result.update(model=model, witness=witness, counts=[int(n.replace(',', '')) for n in counts[-1]] if counts else None)
    if witness:
        assert result['exitCode'] != 0 and f'Invariant {witness} is violated' in raw, 'Witness did not fail for the stated reachable condition'
    else:
        assert result['exitCode'] == 0 and 'Model checking completed. No error has been found.' in raw, 'TLC did not fully pass'
        assert counts and result['counts'][2] == 0, 'Model exploration incomplete'
        if model == 'Shards':
            assert 'Finished checking temporal properties' in raw, 'Progress not checked'
    write(area / 'result.json', result)
    return result


def replay(target, model, graph, output, backend='both'):
    run = execute(['node', '--import', str(ROOT / 'node_modules/tsx/dist/loader.mjs'),
        str(SKILL / 'scripts/replay.mjs'), str(target), model, str(graph), str(output), backend], target, output.with_suffix('.log'))
    assert output.exists(), 'Replay failed before writing report (not a behavioral negative control)'
    run.update(json.loads(output.read_text()))
    return run


def verify_evidence(area):
    report = json.loads((area / 'run.json').read_text())
    assert report['status'] == 'verified' and all(report['cleanup'].values()), 'Incomplete run'
    assert sha(area / 'artifacts.json') == report['manifestSha256'], 'Manifest changed'
    entries = json.loads((area / 'artifacts.json').read_text())
    assert entries, 'Empty manifest'
    for name, record in entries.items():
        path = area / name
        assert path.is_file() and sha(path) == record['sha256'] and path.stat().st_size == record['bytes'], f'Tampered/missing evidence: {name}'
    for stage in ['baseline', 'restored']:
        for model in WITNESSES:
            value = report[stage][model]
            assert value['model']['exitCode'] == 0 and value['replay']['exitCode'] == 0
            assert value['replay']['status'] == 'verified'
            assert value['replay']['graphStates'] == value['model']['counts'][1]
            assert value['replay']['graphEdges'] + 1 == value['model']['counts'][0]
            assert [b['name'] for b in value['replay']['backends']] == ['memory', 'sqlite']
            assert all(b['edgesReplayed'] == value['replay']['graphEdges'] for b in value['replay']['backends'])
            if model == 'Shards':
                probes = value['replay']['probes']
                for backend in ['memory', 'sqlite']:
                    capacity = [probe for probe in probes if probe['backend'] == backend and probe.get('verified') and probe.get('family') != 'discussion-recovery']
                    assert {probe['name'] for probe in capacity} == {'zero', 'one', 'two', 'four', 'refreshed-recovery', 'legacy-recovery'}, 'Missing finite capacity examples'
                    assert len(capacity) == 6, 'Duplicate finite capacity example'
                    recovery = [probe for probe in probes if probe['backend'] == backend and probe.get('family') == 'discussion-recovery' and probe.get('verified')]
                    expected = {'map-goal', 'map-stop', 'discussion-goal', 'discussion-stop', 'map-ended', 'discussion-ended', 'active-safe', 'historical-pending', 'removed-member',
                                'physical-claimed', 'physical-started', 'physical-unknown', 'known-LOCAL_RESULT', 'known-LOCAL_RECONCILE', 'unsafe-compatibility'}
                    assert len(recovery) == len(expected) and {probe['name'] for probe in recovery} == expected, 'Missing or duplicate finite discussion recovery examples'
    assert set(report['negativeControls']) == set(CONTROLS), 'Missing real-code controls'
    for name, (_, expected, _, _, _) in CONTROLS.items():
        value = report['negativeControls'][name]
        assert value['property'] == expected and set(value['stores']) == {'memory', 'sqlite'}
        assert all(item['exitCode'] != 0 and expected in item.get('error', '') for item in value['stores'].values()), 'Invalid real-code control'
    assert set(report['witnesses']) == set(WITNESSES)
    assert all(set(report['witnesses'][model]) == set(names) for model, names in WITNESSES.items()), 'Missing reachability runs'
    return len(entries)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', type=Path, default=Path(os.environ.get('TLA2TOOLS_JAR', Path.home() / '.cache/squad-formal/tla2tools-1.7.4.jar')))
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--verify-evidence', type=Path)
    args = parser.parse_args()
    if args.verify_evidence:
        print(f'Verified {verify_evidence(args.verify_evidence.resolve())} retained artifacts')
        return 0
    area = (args.evidence or ROOT / 'reports/verify-squad-coordination' / (time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + f'-{os.getpid()}')).resolve()
    assert not area.exists(), 'Refusing to overwrite evidence'
    area.mkdir(parents=True)
    coverage = json.loads((SKILL / 'references/coverage.json').read_text())
    before = {name: sha(ROOT / name) for name in coverage['files']}
    checker_before = {str(path): sha(path) for path in (SKILL / 'scripts').iterdir() if path.is_file()}
    report = {'status': 'running', 'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'worktree': subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip(),
        'syncCommit': coverage['syncCommit'], 'bounds': coverage['bounds'], 'coveredFileHashes': before,
        'baseline': {}, 'restored': {}, 'witnesses': {}, 'negativeControls': {}}
    scratch = Path(tempfile.mkdtemp(prefix='squad-coordination-controls-'))
    started = time.monotonic()
    try:
        changed = [name for name, value in before.items() if coverage['files'][name] != value]
        assert not changed, 'BLOCKED: code-to-model review required; do not refresh hashes blindly: ' + ', '.join(changed)
        jar = args.jar.resolve()
        sys.dont_write_bytecode = True
        helper_path = ROOT / '.agents/skills/verify-squad-handoff/scripts/check.py'
        spec = importlib.util.spec_from_file_location('squad_handoff_helpers', helper_path)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        jar = helper.jar_at(jar)
        assert sha(jar) == JAR_SHA, 'Wrong pinned TLC archive'
        report['tool'] = {'release': 'TLA+ Tools v1.7.4 / TLC 2.19', 'jarSha256': JAR_SHA}
        shutil.copytree(SKILL / 'scripts', area / 'checker-inputs', ignore=shutil.ignore_patterns('__pycache__'))
        for name in ['SKILL.md', 'references/correspondence.md', 'references/drift-review-pr40.json', 'references/drift-review-kej-106.json', 'references/drift-review-kej-102-105.json']:
            retained = area / 'checker-inputs' / name
            retained.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SKILL / name, retained)
        shutil.copyfile(SKILL / 'references/coverage.json', area / 'coverage.json')
        for model, witnesses in WITNESSES.items():
            print(f'{model}: checking finite state graph and replaying every edge on both stores', flush=True)
            checked = tlc(jar, model, area / 'baseline' / model)
            value = replay(ROOT, model, area / 'baseline' / model / 'graph.dot', area / f'baseline-{model}.json')
            report['baseline'][model] = {'model': checked, 'replay': value}
            assert value['status'] == 'verified' and value['exitCode'] == 0, f'{model}: concrete replay failed'
            assert value['graphStates'] == checked['counts'][1] and value['graphEdges'] + 1 == checked['counts'][0], 'Graph parser omitted states/transitions'
            report['witnesses'][model] = {name: tlc(jar, model, area / 'reachability' / model / name, name) for name in witnesses}
        for name, (model, property_name, source, old, new) in CONTROLS.items():
            print(f'Negative control: {name}', flush=True)
            clone = scratch / name; clone.mkdir()
            shutil.copytree(ROOT / 'src', clone / 'src')
            for file in ['package.json', 'team.config.ts']:
                shutil.copyfile(ROOT / file, clone / file)
            (clone / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            path = clone / source; original = path.read_text()
            assert original.count(old) == 1, f'Control anchor drift: {name}'
            mutated = original.replace(old, new); path.write_text(mutated)
            control = area / 'negative-controls' / name; control.mkdir(parents=True)
            (control / 'real-code.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), mutated.splitlines(True), fromfile=source, tofile=source)))
            values = {}
            for backend in ['memory', 'sqlite']:
                value = replay(clone, model, area / 'baseline' / model / 'graph.dot', control / f'{backend}.json', backend)
                assert value['exitCode'] != 0 and property_name in value.get('error', ''), f'Control must fail {property_name}, not dependency/build: {name}/{backend}'
                values[backend] = value
            report['negativeControls'][name] = {'property': property_name, 'stores': values}
            shutil.rmtree(clone)
        for model in WITNESSES:
            checked = tlc(jar, model, area / 'restored' / model)
            value = replay(ROOT, model, area / 'restored' / model / 'graph.dot', area / f'restored-{model}.json')
            report['restored'][model] = {'model': checked, 'replay': value}
            assert value['exitCode'] == 0 and value['status'] == 'verified', 'Restored original did not pass'
        report['status'] = 'verified'
    except Exception as error:
        report['status'] = 'blocked' if str(error).startswith('BLOCKED:') else 'failed'
        report['error'] = str(error)
    finally:
        shutil.rmtree(scratch)
        report['cleanup'] = {'scratchRemoved': not scratch.exists(), 'coveredFilesUnchanged': before == {name: sha(ROOT / name) for name in before},
            'checkerInputsUnchanged': checker_before == {str(path): sha(path) for path in (SKILL / 'scripts').iterdir() if path.is_file()}}
        if not all(report['cleanup'].values()): report['status'] = 'failed'
        report['seconds'] = round(time.monotonic() - started, 3)
        entries = {str(path.relative_to(area)): {'sha256': sha(path), 'bytes': path.stat().st_size}
            for path in sorted(area.rglob('*')) if path.is_file() and 'states' not in path.relative_to(area).parts}
        write(area / 'artifacts.json', entries)
        report['manifestSha256'] = sha(area / 'artifacts.json')
        write(area / 'run.json', report)
        if report['status'] == 'verified': verify_evidence(area)
        print(json.dumps({'status': report['status'], 'evidence': str(area), 'seconds': report['seconds'], 'error': report.get('error')}, ensure_ascii=False))
    return 0 if report['status'] == 'verified' else 1


if __name__ == '__main__':
    raise SystemExit(main())
