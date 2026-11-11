"""Strict raw-evidence validation for the coordination extension protocol."""
from collections import Counter
import hashlib
import difflib
import json
from pathlib import Path
import re
import shutil
import tempfile

REQUIRED = {
    'ToolRecovery': (['TypeOK', 'BoundedToolRecovery', 'ToolRecoveryAccounting', 'ToolFailureIdentity', 'StoppedToolRecovery'], []),
    'MapRecovery': (['TypeOK', 'NoUnresolvedPublication', 'NoUnverifiedRecovery', 'RecoveryHistoryImmutable', 'VerifiedRecoveryEvidence', 'RecoveryIsolation', 'OutstandingRecoveryDebt'], ['RecoveryProgress']),
    'DiscussionBudget': (['TypeOK', 'ProtectedDiscussionBudget', 'AllSettledBudget', 'OwnerBudgetHandoff'], ['Progress']),
    'ReservedRequests': (['TypeOK', 'ProtectedContinuation', 'SharedRequestAccounting'], []),
    'InputBoundary': (['TypeOK', 'NoPrematureInterpretation', 'AppliedInputBoundary', 'NoUnresolvedPublication', 'NoUnresolvedOwner', 'StopCancelsInputSuccessor'], ['Progress']),
    'ReviewQueue': (['TypeOK', 'AllReviewersSettled', 'UniqueReviewSynthesis', 'PreserveReviewFailure', 'StoppedReview'], ['Progress']),
    'DeferredCoordination': (['TypeOK', 'UniqueCoordination', 'DeferredProgress', 'SafeCoordinationBoundary', 'StoppedCoordination'], ['Progress']),
    'CancelledDiscussion': (['TypeOK', 'CancelledRetirement', 'UnknownMemberRetention', 'KnownReceiptRetirement', 'RoundIsolation', 'UnknownResourceCustody', 'CleanupCustody'], ['RetirementProgress']),
}
READER_REASONS = {
    'remove-negative-json': 'memory.json', 'remove-negative-log': 'memory.log',
    'remove-negative-diff': 'real-code.diff', 'remove-required-property': 'required liveness properties differ',
    'remove-fixture-body': 'coordination-composition-fixture.ts',
    'remove-recovery-driver': 'map-recovery-driver.mjs',
    'remove-custody-probes': 'Missing cleanup resource-conflict probes',
}
COUNTS = r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def required(area, manifest, relative):
    relative = Path(relative)
    path = area / relative
    assert str(relative) in manifest and path.is_file() and path.stat().st_size > 0, f'Missing/empty required raw artifact: {relative}'
    return path


def verify_properties(cfg, model):
    invariants = [name for line in re.findall(r'^INVARIANTS? (.*)$', cfg, re.M) for name in line.split()]
    temporal = [name for line in re.findall(r'^PROPERT(?:Y|IES) (.*)$', cfg, re.M) for name in line.split()]
    expected_invariants, expected_temporal = REQUIRED[model]
    assert set(invariants) == set(expected_invariants) and len(invariants) == len(expected_invariants), f'{model}: required safety properties differ'
    assert set(temporal) == set(expected_temporal) and len(temporal) == len(expected_temporal), f'{model}: required liveness properties differ'
    assert re.search(r'^SPECIFICATION Spec$', cfg, re.M), 'Unexpected specification entry point'


def graph_data(path):
    text = path.read_text()
    nodes, initial = {}, None
    for key, label, tail in re.findall(r'^(-?\d+) \[label="((?:\\.|[^"\\])*)"(.*)$', text, re.M):
        nodes[key] = {name: True if value == 'TRUE' else False if value == 'FALSE' else int(value)
                      for name, value in re.findall(r'(\w+) = (TRUE|FALSE|\d+)', label)}
        if 'filled' in tail:
            assert initial is None, 'Multiple initial states'
            initial = key
    edges = Counter(re.findall(r'^(-?\d+) -> (-?\d+) \[label="(\w+)"', text, re.M))
    assert initial and nodes and edges, 'Empty captured graph'
    return nodes, edges, initial


def raw_replay(area, manifest, relative, summary, *, negative=None, backend=None):
    path = required(area, manifest, relative)
    raw = json.loads(path.read_text())
    log = required(area, manifest, path.relative_to(area).with_suffix('.log')).read_text()
    code = 1 if negative else 0
    assert summary['exitCode'] == code and raw.get('exitCode') == code, 'Unexpected process exit code; negative must fail normally with code 1'
    assert summary.get('processExitCode') == code, 'Actual child exit code not retained independently'
    assert all(summary.get(key) == value for key, value in raw.items()), 'Replay summary differs from raw code JSON'
    logged = [json.loads(line) for line in log.splitlines() if line.startswith('{') and line.endswith('}')]
    assert logged and logged[-1] == raw, 'Raw code log differs from its saved JSON'
    assert raw.get('scratchRemoved') is True, 'Replay cleanup did not finish'
    if negative:
        assert raw['status'] == 'failed' and 'AssertionError' in raw.get('error', '') and negative in raw.get('error', ''), 'Negative did not violate its named behavior'
        assert raw.get('failedBackend') == backend and raw.get('counterexample', {}).get('backend') == backend, 'Negative did not execute the selected backend'
    else:
        assert raw['status'] == 'verified', 'Positive code replay failed'
        required(area, manifest, str(relative) + '.jsonl')
    return raw


def replay_rows(area, manifest, relative, raw, graph):
    nodes, edges, initial = graph_data(graph)
    assert len(nodes) == raw['graphStates'] and sum(edges.values()) == raw['graphEdges'], 'Captured graph and replay sizes differ'
    rows = [json.loads(line) for line in required(area, manifest, str(relative) + '.jsonl').read_text().splitlines() if line]
    assert {row['backend'] for row in rows} == {'memory', 'sqlite'}, 'Missing backend observations'
    assert [item['name'] for item in raw['backends']] == ['memory', 'sqlite'], 'Missing backend results'
    for backend in ['memory', 'sqlite']:
        observed = [row for row in rows if row['backend'] == backend]
        assert Counter((row['from'], row['to'], row['actions'][-1]) for row in observed) == edges, f'Omitted/duplicated graph edge observations: {backend}'
        assert all(row['actual'] == nodes[row['to']] for row in observed), 'Saved implementation projection differs from TLC node'
        assert next(item['edgesReplayed'] for item in raw['backends'] if item['name'] == backend) == sum(edges.values())
        for row in observed:
            current, previous = initial, None
            for action in row['actions']:
                destinations = {target for source, target, label in edges if source == current and label == action}
                assert len(destinations) == 1, 'Saved representative prefix does not follow the captured graph'
                previous, current = current, next(iter(destinations))
            assert (previous, current) == (row['from'], row['to']), 'Saved prefix ends at another edge'


def readback(area, specs, controls, check_reader_controls=True):
    report = json.loads((area / 'run.json').read_text())
    assert report['status'] == 'verified' and set(report['cleanup']) == {'scratchRemoved', 'coveredFilesUnchanged', 'checkerInputsUnchanged'} and all(value is True for value in report['cleanup'].values()), 'Incomplete coordination extension run'
    manifest = json.loads((area / 'artifacts.json').read_text())
    assert manifest and sha(area / 'artifacts.json') == report['manifestSha256'], 'Changed manifest'
    for name, record in manifest.items():
        path = area / name
        assert path.is_file() and sha(path) == record['sha256'] and path.stat().st_size == record['bytes'], f'Changed raw evidence: {name}'
    assert report['tool']['sha256'] == '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88', 'Unpinned checker archive'
    for name, expected in report['checkerInputHashes'].items():
        assert sha(required(area, manifest, Path('checker-inputs') / name)) == expected, f'Captured checker input differs: {name}'
    fixture = Path('checker-inputs/tests/coordination-composition-fixture.ts')
    assert sha(required(area, manifest, fixture)) == report['checkerInputHashes']['tests/coordination-composition-fixture.ts'], 'Missing or changed uncommitted fixture body'
    coverage = json.loads(required(area, manifest, 'extensions-coverage.json').read_text())
    assert coverage['files'] == report['coveredFileHashes'], 'Captured source fingerprint map differs'
    for name, expected in coverage['files'].items():
        assert sha(required(area, manifest, Path('implementation') / name)) == expected, f'Captured implementation differs: {name}'
    for name in ['map-recovery-driver.mjs', 'tool-recovery-driver.mjs']:
        key = '.agents/skills/verify-squad-coordination/scripts/' + name
        assert key in report['checkerInputHashes'], 'Missing required recovery driver fingerprint: ' + name
        assert sha(required(area, manifest, Path('checker-inputs') / key)) == report['checkerInputHashes'][key], 'Missing or changed recovery driver: ' + name
    assert set(report['baseline']) == set(specs) == set(report['restored']) == set(report['witnesses']), 'Omitted model domain'
    for stage in ['baseline', 'restored']:
        for key, (model, variant, witnesses) in specs.items():
            value = report[stage][key]
            prefix = Path(stage) / key
            cfg = required(area, manifest, prefix / f'{model}.cfg').read_text()
            verify_properties(cfg, model)
            captured_model = required(area, manifest, prefix / f'{model}.tla')
            archived = Path('checker-inputs/.agents/skills/verify-squad-coordination/scripts')
            assert captured_model.read_bytes() == required(area, manifest, archived / f'{model}.tla').read_bytes(), 'Checked model differs from captured checker input'
            assert cfg == required(area, manifest, archived / f'{key}.cfg').read_text(), 'Checked constants differ from captured domain'
            result = json.loads(required(area, manifest, prefix / 'result.json').read_text())
            assert result == value['model'] and result['exitCode'] == 0 and result['model'] == model and result['variant'] == variant, 'Model result differs from saved command result'
            log = required(area, manifest, prefix / 'tlc.log').read_text()
            counts = re.findall(COUNTS, log)
            assert counts and [int(number.replace(',', '')) for number in counts[-1]] == result['counts'], 'Raw TLC statistics differ'
            assert result['counts'][2] == 0 and 'Model checking completed. No error has been found.' in log, 'Incomplete TLC check'
            if REQUIRED[model][1]: assert 'Finished checking temporal properties' in log, 'Unchecked liveness'
            replay_path = Path(f'{stage}-{key}.json')
            raw = raw_replay(area, manifest, replay_path, value['replay'])
            assert raw['model'] == model and raw['variant'] == variant, 'Replay belongs to another model domain'
            graph = required(area, manifest, prefix / 'graph.dot')
            assert raw['graphStates'] == result['counts'][1] and raw['graphEdges'] + 1 == result['counts'][0], 'Omitted graph structure'
            replay_rows(area, manifest, replay_path, raw, graph)
            if model == 'CancelledDiscussion' and variant.endswith('-physical') and '-goal-' not in variant:
                probes = raw.get('probes', [])
                assert len(probes) == 2 and {probe.get('backend') for probe in probes} == {'memory', 'sqlite'}, 'Missing cleanup resource-conflict probes'
                assert all(probe.get('name') == 'cleanup-content-resource-conflict' and probe.get('variant') == variant
                           and probe.get('verified') is True and probe.get('contentClaimedBeforeReceipt') is True
                           and probe.get('conflictingClaimBeforeReceipt') == 'WORKSPACE_BUSY'
                           and probe.get('claimAfterTrustedReceipt') is True and probe.get('physicalCommandsSpawned') == 0
                           for probe in probes), 'Incomplete cleanup resource-conflict observation'
            if model == 'MapRecovery':
                probes = raw.get('probes', [])
                for backend in ['memory', 'sqlite']:
                    selected = [probe for probe in probes if probe.get('backend') == backend and probe.get('verified') is True]
                    assert {probe.get('name') for probe in selected} == {'failed', 'truncated', 'unknown', 'duplicate', 'wrong-round', 'stale-epoch', 'independent-review'}, 'Missing MapRecovery evidence eligibility probes'
                    assert len(selected) == 7 and all(probe.get('family') == 'map-recovery-evidence' for probe in selected), 'Duplicated or unrelated recovery evidence probe'
                    assert all(probe.get('origin') == ('bounded-snapshot-input' if probe['name'] == 'independent-review' else 'public-prefix') for probe in selected), 'Unstated recovery probe input origin'
                    assert next(probe for probe in selected if probe['name'] == 'independent-review').get('input', {}).get('incomplete') == '原独立审查仍有缺口', 'Missing independent-review bounded input'

    for key, (model, variant, names) in specs.items():
        assert set(report['witnesses'][key]) == set(names), 'Omitted required reachability witness'
        for name in names:
            prefix = Path('reachability') / key / name
            result = json.loads(required(area, manifest, prefix / 'result.json').read_text())
            assert result == report['witnesses'][key][name] and result['exitCode'] != 0 and result['model'] == model and result['variant'] == variant and result['witness'] == name
            log = required(area, manifest, prefix / 'tlc.log').read_text()
            assert f'Invariant {name} is violated' in log, 'Reachability did not fail its named invariant'
            cfg = required(area, manifest, prefix / f'{model}.cfg').read_text()
            assert re.findall(r'^INVARIANTS? (.*)$', cfg, re.M) == [name] and not re.search(r'^PROPERTY ', cfg, re.M), 'Reachability configuration differs'
            archived = Path('checker-inputs/.agents/skills/verify-squad-coordination/scripts')
            assert required(area, manifest, prefix / f'{model}.tla').read_bytes() == required(area, manifest, archived / f'{model}.tla').read_bytes(), 'Reachability model differs from captured model'
            original_cfg = required(area, manifest, archived / f'{key}.cfg').read_text()
            expected_cfg = re.sub(r'^INVARIANTS .*$', 'INVARIANT ' + name, original_cfg, flags=re.M)
            expected_cfg = re.sub(r'^PROPERTY .*\n?', '', expected_cfg, flags=re.M)
            assert cfg == expected_cfg, 'Reachability constants/properties differ from declared domain'
    assert set(report['negativeControls']) == set(controls), 'Omitted real-code control'
    for name, (key, expected, source, old, new) in controls.items():
        control = report['negativeControls'][name]
        assert control['property'] == expected and set(control['stores']) == {'memory', 'sqlite'}, 'Wrong fault property/backends'
        prefix = Path('negative-controls') / name
        diff = required(area, manifest, prefix / 'real-code.diff').read_text()
        original = required(area, manifest, Path('implementation') / source).read_text()
        assert original.count(old) == 1, 'Captured fault anchor differs'
        changed = original.replace(old, new)
        expected_diff = ''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True), fromfile=source, tofile=source))
        assert diff == expected_diff and diff, 'Captured diff is not the specified real-code fault'
        for backend in ['memory', 'sqlite']:
            raw = raw_replay(area, manifest, prefix / f'{backend}.json', control['stores'][backend], negative=expected, backend=backend)
            model, variant, _ = specs[key]
            assert raw['model'] == model and raw['variant'] == variant, 'Real fault replay belongs to another domain'
            baseline = report['baseline'][key]['replay']
            assert (raw['graphStates'], raw['graphEdges']) == (baseline['graphStates'], baseline['graphEdges']), 'Real fault uses another model graph'
    if check_reader_controls:
        values = json.loads(required(area, manifest, 'readback-controls.json').read_text())
        assert values == report['readbackControls'] and set(values) == set(READER_REASONS)
        assert all(value['rejected'] is True and READER_REASONS[name] in value['reason'] for name, value in values.items()), 'Reader controls did not reject the intended deletion'
    return len(manifest)


def reader_controls(area, specs, controls):
    first = next(iter(controls)); key = next(iter(specs)); model = specs[key][0]
    cases = {
        'remove-negative-json': Path('negative-controls') / first / 'memory.json',
        'remove-negative-log': Path('negative-controls') / first / 'memory.log',
        'remove-negative-diff': Path('negative-controls') / first / 'real-code.diff',
        'remove-required-property': Path('baseline') / key / f'{model}.cfg',
        'remove-fixture-body': Path('checker-inputs/tests/coordination-composition-fixture.ts'),
        'remove-recovery-driver': Path('checker-inputs/.agents/skills/verify-squad-coordination/scripts/map-recovery-driver.mjs'),
        'remove-custody-probes': Path('baseline-CancelledDiscussion-map-stop-physical.json'),
    }
    scratch = Path(tempfile.mkdtemp(prefix='squad-coordination-reader-'))
    results = {}
    try:
        for name, relative in cases.items():
            copy = scratch / name
            shutil.copytree(area, copy, ignore=shutil.ignore_patterns('states', 'java-tmp'))
            # The copied manifest is made self-consistent, so rejection cannot
            # be attributed merely to a stale outer SHA or missing optional log.
            manifest = json.loads((copy / 'artifacts.json').read_text())
            for entry in list(manifest):
                if not (copy / entry).is_file(): manifest.pop(entry)
            report = json.loads((copy / 'run.json').read_text())
            if name == 'remove-custody-probes':
                path = copy / relative
                raw = json.loads(path.read_text()); raw['probes'] = []
                path.write_text(json.dumps(raw))
                log = path.with_suffix('.log')
                lines = log.read_text().splitlines()
                lines = [json.dumps(raw) if line.startswith('{') and line.endswith('}') else line for line in lines]
                log.write_text('\n'.join(lines) + '\n')
                report['baseline']['CancelledDiscussion-map-stop-physical']['replay']['probes'] = []
                for changed in [path, log]:
                    manifest[str(changed.relative_to(copy))] = {'sha256': sha(changed), 'bytes': changed.stat().st_size}
            elif name == 'remove-required-property':
                path = copy / relative
                path.write_text(re.sub(r'^PROPERTY .*\n?', '', path.read_text(), flags=re.M))
                manifest[str(relative)] = {'sha256': sha(path), 'bytes': path.stat().st_size}
            else:
                (copy / relative).unlink(); manifest.pop(str(relative))
            (copy / 'artifacts.json').write_text(json.dumps(manifest))
            report['manifestSha256'] = sha(copy / 'artifacts.json')
            (copy / 'run.json').write_text(json.dumps(report))
            try:
                readback(copy, specs, controls, check_reader_controls=False)
            except (AssertionError, FileNotFoundError) as error:
                assert READER_REASONS[name] in str(error), f'Reader rejected deletion for unrelated reason: {name}: {error}'
                results[name] = {'rejected': True, 'reason': str(error)}
            else:
                raise AssertionError(f'Reader accepted self-consistent deletion: {name}')
            shutil.rmtree(copy)
    finally:
        shutil.rmtree(scratch)
    return results
