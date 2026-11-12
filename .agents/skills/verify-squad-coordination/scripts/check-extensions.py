#!/usr/bin/env python3
"""Check KEJ-107/108 coordination compositions, conformance, reachability and real faults."""
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
sys.dont_write_bytecode = True
import extension_evidence as evidence

SKILL = Path(__file__).resolve().parents[1]
ROOT = SKILL.parents[2]
JAR_SHA = '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88'
SPECS = {
    'DiscussionBudget': ('DiscussionBudget', '', ['NeverFrontier', 'NeverPaidSuccessor', 'NeverConcurrentMembers']),
    'ReservedRequests-review': ('ReservedRequests', 'review', ['NeverAdditional', 'NeverReservedFrontier']),
    'ReservedRequests-retry': ('ReservedRequests', 'retry', ['NeverAdditional', 'NeverReservedFrontier']),
    'ReservedRequests-host': ('ReservedRequests', 'host', ['NeverAdditional', 'NeverReservedFrontier']),
    'InputBoundary-help': ('InputBoundary', 'help', ['NeverWaitingBoundary', 'NeverResolved', 'NeverClarified', 'NeverStoppedSaved', 'NeverRecoveredParsing']),
    'InputBoundary-check': ('InputBoundary', 'check', ['NeverResolved', 'NeverClarified', 'NeverStoppedSaved', 'NeverRecoveredParsing']),
    'ReviewQueue': ('ReviewQueue', '', ['NeverSynthesis', 'NeverRecoveredSaved', 'NeverRepairedReview', 'NeverNewRound']),
    'DeferredCoordination': ('DeferredCoordination', '', ['NeverDeferred', 'NeverCoordinated', 'NeverReset', 'NeverRecoveredDeferred']),
    'ToolRecovery': ('ToolRecovery', '', ['NeverFeedback', 'NeverSecondFeedback', 'NeverRecoveredFeedback', 'NeverBudgetFrontier', 'NeverExpiredFeedback']),
    'ForwardDelivery': ('ForwardDelivery', '', ['NeverGapDelivery', 'NeverDirectRepair', 'NeverPublication', 'NeverRollback', 'NeverReopened', 'NeverStoppedCheck', 'NeverStaleGoal']),
}
for origin in ['map', 'discussion']:
    for mode in ['goal', 'stop', 'end']:
        for effects in ['safe', 'physical']:
            key = f'CancelledDiscussion-{origin}-{mode}-{effects}'
            SPECS[key] = ('CancelledDiscussion', f'{origin}-{mode}-{effects}', ['NeverRetired', 'NeverReinvited'] + (['NeverRecoveredUnknown'] if effects == 'physical' else []) + (['NeverContentResumedWithCustody'] if effects == 'physical' and mode != 'goal' else []))

CONTROLS = {
    'tool-recovery-no-bound': ('ToolRecovery', 'BoundedToolRecovery', 'src/task/tool-recovery.ts', "  if (failures.length >= 2) return 'TOOL_RECOVERY_EXHAUSTED';", '  /* faulty missing feedback ceiling */'),
    'tool-recovery-no-duplicate': ('ToolRecovery', 'ToolFailureIdentity', 'src/task/tool-recovery.ts', "  if (failures.some(item => item.requestId === e.requestId)) return 'DUPLICATE_TOOL_FAILURE';", '  /* faulty missing duplicate guard */'),
    'tool-recovery-no-request': ('ToolRecovery', 'ToolFailureIdentity', 'src/task/tool-recovery.ts', "|| !c.trace.some(entry => entry.event === 'CONSUME' && entry.detail === e.requestId)", ''),
    'tool-recovery-no-budget': ('ToolRecovery', 'ToolRecoveryAccounting', 'src/task/tool-recovery.ts', '  return requestBudgetProblem(c, work);', '  return null; /* faulty missing follow-up reservation */'),
    'tool-recovery-feedback-fee': ('ToolRecovery', 'ToolRecoveryAccounting', 'src/task/tool-recovery.ts', '  (work.toolRecovery ??= { failures: [] }).failures.push({ requestId: e.requestId, tool: e.tool, code: e.code, attempt: work.attempt, at: e.at });', '  (work.toolRecovery ??= { failures: [] }).failures.push({ requestId: e.requestId, tool: e.tool, code: e.code, attempt: work.attempt, at: e.at });\n  c.usage.ordinary++; /* faulty double charge for feedback */'),
    'tool-recovery-no-deadline': ('ToolRecovery', 'StoppedToolRecovery', 'src/task/tool-recovery.ts', "  if (work.deadline !== null && e.at >= work.deadline) return 'WORK_EXPIRED';", '  /* faulty expired feedback accepted */'),
    'return-review-to-owner': ('ForwardDelivery', 'NoReviewBackflow', 'src/task/reducer.ts',
        "      if (outcome.kind === 'complete') {", "      if (outcome.kind === 'complete') { owner(c, e, { reason: 'faulty upstream review rejection' });"),
    'hide-content-gap': ('ForwardDelivery', 'DeclaredGaps', 'src/task/reducer.ts',
        'if (findings.length) c.candidate!.text +=', 'if (false && findings.length) c.candidate!.text +='),
    'keep-failed-child-output': ('ForwardDelivery', 'FailedOutputEmpty', 'src/task/discussion.ts',
        "const text = failed ? '' : e.text;", 'const text = e.text;'),
    'prefer-historical-verdict': ('ForwardDelivery', 'LatestVerdict', 'src/delivery-acceptance.ts',
        'return [...c.intents].reverse().find(work => work.kind', 'return c.intents.find(work => work.kind'),
    'prefer-historical-artifact-verdict': ('ForwardDelivery', 'LatestVerdict', 'src/resource-acquisition.ts',
        "const check = candidate?.revision ? [...c.intents].reverse().find(work => work.kind", "const check = candidate?.revision ? c.intents.find(work => work.kind"),
    'spend-discussion-reserve': ('DiscussionBudget', 'ProtectedDiscussionBudget', 'src/task/budget.ts',
        "if (c.usage.ordinary + 1 + reserve + hostReserve > c.config.limits.ordinary) return 'DISCUSSION_BUDGET_RESERVED';", '/* faulty loss of promised discussion capacity */'),
    'spend-review-synthesis': ('ReservedRequests-review', 'ProtectedContinuation', 'src/task/budget.ts',
        "if (work.bucket === 'ordinary' && c.review && ['pending', 'reviewing'].includes(c.review.status)", "if (false && work.bucket === 'ordinary' && c.review && ['pending', 'reviewing'].includes(c.review.status)"),
    'spend-retry-synthesis': ('ReservedRequests-retry', 'ProtectedContinuation', 'src/task/budget.ts',
        "if (work.kind === 'assistance' && c.assists.some(h => h.id === work.payload.requestId && h.retryOf)", "if (false && work.kind === 'assistance' && c.assists.some(h => h.id === work.payload.requestId && h.retryOf)"),
    'spend-host-obligation': ('ReservedRequests-host', 'ProtectedContinuation', 'src/task/budget.ts',
        "const hostReserve = work.id === c.hostRetryBatch?.workId ? 0 : hostRetryReservation(c);", 'const hostReserve = 0;'),
    'parse-before-help-consumption': ('InputBoundary-help', 'NoPrematureInterpretation', 'src/task/guards.ts',
        "analysisReady: ({ context }) => !taskHumanGate(context) && !context.stopped && context.outcome === null && !incompatibleExecution(context) && !!pendingInput(context)\n      && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) && !workInCleanup(context, work)) && !activeHelp(context),",
        "analysisReady: ({ context }) => !taskHumanGate(context) && !context.stopped && context.outcome === null && !incompatibleExecution(context) && !!pendingInput(context)\n      && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) && !workInCleanup(context, work)),"),
    'publish-over-pending-input': ('InputBoundary-check', 'NoUnresolvedPublication', 'src/task/delivery.ts',
        "if (deliveryInterruptionPending(c)) return { kind: 'handoff' };", "if (deliveryInterruptionPending(c)) return { kind: 'complete' };"),
    'retain-input-check-evidence': ('InputBoundary-check', 'AppliedInputBoundary', 'src/task/reducer.ts',
        "if (c.inputs.some(note => !note.applied)) resetDeliveryMaterials(c);", '/* faulty stale check-evidence snapshot after input boundary */'),
    'lose-review-membership': ('ReviewQueue', 'ReviewMembership', 'src/task/assistance.ts',
        "if (!review.completed.includes(completed.target)) review.completed.push(completed.target);", '/* faulty consumed reviewer never recorded in completed */'),
    'premature-review-synthesis': ('ReviewQueue', 'AllReviewersSettled', 'src/task/assistance.ts',
        "return c.review?.targets.find(target => target !== completing && !c.review!.completed.includes(target));", 'return undefined;'),
    'duplicate-review-synthesis': ('ReviewQueue', 'UniqueReviewSynthesis', 'src/task/assistance.ts',
        "owner(c, e, { reason: '汇总本轮所有成员意见，区分共识、分歧、风险、建议与未完成项；不得再次索要已在群聊中的方案。' });",
        "owner(c, e, { reason: '汇总本轮所有成员意见，区分共识、分歧、风险、建议与未完成项；不得再次索要已在群聊中的方案。' }); owner(c, e, { reason: 'faulty duplicate review synthesis' });"),
    'coordinate-before-primary-settlement': ('DeferredCoordination', 'SafeCoordinationBoundary', 'src/task/reducer.ts',
        "if (inflight(c).length || discussionActive(c)) { c.deferredCoordination = true; c.reason = e.reason; }",
        "if (discussionActive(c)) { c.deferredCoordination = true; c.reason = e.reason; }"),
    'erase-review-failure': ('ReviewQueue', 'PreserveReviewFailure', 'src/task/assistance.ts',
        '    refreshReviewFailures(c);\n  }\n  const target = nextReviewer(c);', '    /* faulty loss of failed reviewer status */\n  }\n  const target = nextReviewer(c);'),
    'lose-deferred-coordination': ('DeferredCoordination', 'DeferredProgress', 'src/task/guards.ts',
        "deferredReady: ({ context }) => context.deferredCoordination && !discussionActive(context) && !unresolvedInput(context) && inflight(context).length === 0 && !context.intents.some(work => localPhysicalPending(work) && !workInCleanup(context, work)),", 'deferredReady: () => false,'),
    'retire-obsolete-discussion-too-late': ('CancelledDiscussion-map-goal-safe', 'CancelledRetirement', 'src/task/reducer.ts',
        'for (const work of c.intents.filter(work => canRetireDiscussionWork(c, work))) release(c, work.id);', '/* faulty cancelled work continues occupying members after recovery */'),
    'skip-ended-obsolete-discussion': ('CancelledDiscussion-discussion-end-safe', 'CancelledRetirement', 'src/engine.ts',
        "if (taskPhase(snapshot) === 'ended' && !snapshot.context.resilience?.cleanup.some(item => item.state === 'pending')\n        && !snapshot.context.intents.some(work => canRetireDiscussionWork(snapshot.context, work) || localPhysicalPending(work)\n          || work.kind !== 'cancel' && work.replay !== 'unsafe' && ['pending', 'inflight'].includes(work.status))) continue;", "if (taskPhase(snapshot) === 'ended') continue;"),
    'release-unknown-resource': ('CancelledDiscussion-map-stop-physical', 'UnknownResourceCustody', 'src/engine.ts',
        '        let next = this.step(current, event);',
        "        let next = this.step(current, event);\n        if (event.type === 'RECOVER') for (const w of next.context.intents) for (const op of w.localOperations ?? []) if (localPhysicalPending(w) && op.workspaceId) tx.releaseWorkspace(op.workspaceId, fingerprint({ roomId, taskId, operationId: op.id })); /* faulty premature resource release */"),
    'lose-cleanup-owner': ('CancelledDiscussion-map-stop-physical', 'CleanupCustody', 'src/task/resilience.ts',
        "    r.cleanup.push({ kind: 'local', id:", "    if (false) r.cleanup.push({ kind: 'local', id:"),
    'forget-unknown-command-effects': ('CancelledDiscussion-map-stop-physical', 'UnknownMemberRetention', 'src/local-operation.ts',
        "for (const op of work.localOperations ?? []) if (['claimed', 'running', 'cancelling'].includes(op.status)) op.status = 'uncertain';",
        "for (const op of work.localOperations ?? []) if (['claimed', 'running', 'cancelling'].includes(op.status)) op.status = 'cancelled';"),
    'lose-known-discussion-retirement': ('CancelledDiscussion-map-end-physical', 'KnownReceiptRetirement', 'src/task/reducer.ts',
        "if ((e.type === 'LOCAL_RESULT' || e.type === 'LOCAL_RECONCILE') && work && canRetireDiscussionWork(c, work)) release(c, work.id);", "if ((e.type === 'LOCAL_RESULT' || e.type === 'LOCAL_RECONCILE') && work?.discussionId && c.discussion?.status === 'cancelled') work.status = 'uncertain'; /* faulty known work reoccupied after receipt */"),
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.part')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    temporary.replace(path)


def execute(command, cwd, log, timeout=180):
    log.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    try:
        value = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        log.write_bytes(error.stdout or b'')
        raise RuntimeError(f'BLOCKED: command exceeded {timeout}s: {log}') from error
    log.write_bytes(value.stdout)
    return {'command': command, 'exitCode': value.returncode, 'seconds': round(time.monotonic() - started, 3)}


def tlc(jar, key, area, witness=None):
    area.mkdir(parents=True)
    (area / 'java-tmp').mkdir()
    model, variant, _ = SPECS[key]
    shutil.copyfile(SKILL / f'scripts/{model}.tla', area / f'{model}.tla')
    cfg = (SKILL / f'scripts/{key}.cfg').read_text()
    evidence.verify_properties(cfg, model)
    if witness:
        cfg = re.sub(r'^INVARIANTS .*$', 'INVARIANT ' + witness, cfg, flags=re.M)
        cfg = re.sub(r'^PROPERTY .*\n?', '', cfg, flags=re.M)
    (area / f'{model}.cfg').write_text(cfg)
    result = execute(['java', '-XX:+UseParallelGC', '-Xmx512m', '-Djava.io.tmpdir=' + str(area / 'java-tmp'), '-jar', str(jar), '-workers', '1', '-seed', '1',
        '-metadir', str(area / 'states'), '-dump', 'dot,actionlabels', str(area / 'graph.dot'), '-config', f'{model}.cfg', f'{model}.tla'], area, area / 'tlc.log', 45)
    raw = (area / 'tlc.log').read_text()
    counts = re.findall(r'([\d,]+) states generated, ([\d,]+) distinct states found, ([\d,]+) states left on queue', raw)
    result.update(model=model, variant=variant, witness=witness, counts=[int(value.replace(',', '')) for value in counts[-1]] if counts else None)
    if witness:
        assert result['exitCode'] != 0 and f'Invariant {witness} is violated' in raw, f'Reachability witness failed for another reason: {key}/{witness}'
    else:
        assert result['exitCode'] == 0 and 'Model checking completed. No error has been found.' in raw, f'{key}: TLC incomplete/failed: {area}/tlc.log'
        assert counts and result['counts'][2] == 0, f'{key}: graph exploration incomplete'
        if re.search(r'^PROPERTY ', cfg, re.M): assert 'Finished checking temporal properties' in raw, f'{key}: temporal check incomplete'
    write(area / 'result.json', result)
    return result


def replay(target, key, graph, output, backend='both'):
    model, variant, _ = SPECS[key]
    result = execute(['node', '--import', str(ROOT / 'node_modules/tsx/dist/loader.mjs'),
        str(SKILL / 'scripts/replay-extensions.mjs'), str(target), model, variant, str(graph), str(output), backend], target, output.with_suffix('.log'))
    assert output.exists(), f'{key}: replay failed before behavior report'
    actual_exit = result['exitCode']
    result.update(json.loads(output.read_text()))
    result['processExitCode'] = actual_exit
    result['exitCode'] = actual_exit
    return result


def verify_evidence(area):
    return evidence.readback(area, SPECS, CONTROLS)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--jar', type=Path, default=Path(os.environ.get('TLA2TOOLS_JAR', Path.home() / '.cache/squad-formal/tla2tools-1.7.4.jar')))
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--verify-evidence', type=Path)
    args = parser.parse_args()
    if args.verify_evidence:
        print(f'Verified {verify_evidence(args.verify_evidence.resolve())} coordination extension evidence files')
        return 0
    area = (args.evidence or ROOT / 'reports/verify-squad-coordination' / ('extensions-' + time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + f'-{os.getpid()}')).resolve()
    assert not area.exists(), 'Refusing to overwrite evidence'
    area.mkdir(parents=True)
    coverage_path = SKILL / 'references/extensions-coverage.json'
    coverage = json.loads(coverage_path.read_text())
    before = {name: sha(ROOT / name) for name in coverage['files']}
    inputs = {str(path.relative_to(ROOT)): sha(path) for path in [*sorted((SKILL / 'scripts').glob('*')), ROOT / 'tests/coordination-composition-fixture.ts',
        SKILL / 'SKILL.md', SKILL / 'references/correspondence.md', SKILL / 'references/drift-review-kej-113-114.json', SKILL / 'references/drift-review-shared-agent-behavior.json'] if path.is_file()}
    report = {'status': 'running', 'source': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'syncCommit': coverage['syncCommit'], 'coveredFileHashes': before, 'checkerInputHashes': inputs,
        'baseline': {}, 'restored': {}, 'witnesses': {}, 'negativeControls': {}}
    scratch = Path(tempfile.mkdtemp(prefix='squad-composition-faults-'))
    started = time.monotonic()
    try:
        assert before == coverage['files'], 'BLOCKED: source drift requires correspondence review, never refresh pins blindly'
        jar = args.jar.resolve(); assert jar.is_file() and sha(jar) == JAR_SHA, 'BLOCKED: provide pinned TLA+ Tools 1.7.4 archive with --jar'
        report['tool'] = {'release': 'TLA+ Tools v1.7.4 / TLC 2.19', 'sha256': JAR_SHA}
        for name in inputs:
            destination = area / 'checker-inputs' / name; destination.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(ROOT / name, destination)
        shutil.copyfile(coverage_path, area / 'extensions-coverage.json')
        for name in before:
            path = area / 'implementation' / name; path.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(ROOT / name, path)
        for key in SPECS:
            print(f'Extension {key}: TLC, every edge on MemoryStore and SQLite', flush=True)
            checked = tlc(jar, key, area / 'baseline' / key)
            compared = replay(ROOT, key, area / 'baseline' / key / 'graph.dot', area / f'baseline-{key}.json')
            report['baseline'][key] = {'model': checked, 'replay': compared}
            assert compared['exitCode'] == 0 and compared['status'] == 'verified', f'{key}: concrete counterexample in {area}/baseline-{key}.json'
            assert compared['graphStates'] == checked['counts'][1] and compared['graphEdges'] + 1 == checked['counts'][0]
            report['witnesses'][key] = {name: tlc(jar, key, area / 'reachability' / key / name, name) for name in SPECS[key][2]}
        for name, (key, property_name, source, old, new) in CONTROLS.items():
            print(f'Real fault: {name}', flush=True)
            clone = scratch / name; clone.mkdir(); shutil.copytree(ROOT / 'src', clone / 'src')
            for path in ['package.json', 'team.config.ts']: shutil.copyfile(ROOT / path, clone / path)
            (clone / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            target = clone / source; original = target.read_text()
            assert original.count(old) == 1, f'Fault anchor drift: {name}'
            changed = original.replace(old, new); target.write_text(changed)
            destination = area / 'negative-controls' / name; destination.mkdir(parents=True)
            (destination / 'real-code.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True), fromfile=source, tofile=source)))
            values = {backend: replay(clone, key, area / 'baseline' / key / 'graph.dot', destination / f'{backend}.json', backend) for backend in ['memory', 'sqlite']}
            report['negativeControls'][name] = {'property': property_name, 'stores': values}
            assert all(value['exitCode'] == 1 and 'AssertionError' in value.get('error', '') and property_name in value.get('error', '') for value in values.values()), f'{name}: fault survived or failed for unrelated reason'
            shutil.rmtree(clone)
        for key in SPECS:
            print(f'Restored extension {key}', flush=True)
            checked = tlc(jar, key, area / 'restored' / key)
            compared = replay(ROOT, key, area / 'restored' / key / 'graph.dot', area / f'restored-{key}.json')
            report['restored'][key] = {'model': checked, 'replay': compared}
            assert compared['exitCode'] == 0 and compared['status'] == 'verified', f'{key}: restored original did not pass'
        report['status'] = 'verified'
    except Exception as error:
        report['status'] = 'blocked' if str(error).startswith('BLOCKED:') else 'failed'; report['error'] = str(error)
    finally:
        shutil.rmtree(scratch)
        report['cleanup'] = {'scratchRemoved': not scratch.exists(), 'coveredFilesUnchanged': before == {name: sha(ROOT / name) for name in before},
            'checkerInputsUnchanged': inputs == {name: sha(ROOT / name) for name in inputs}}
        if not all(report['cleanup'].values()): report['status'] = 'failed'
        report['seconds'] = round(time.monotonic() - started, 3)
        def retain_manifest():
            entries = {str(path.relative_to(area)): {'sha256': sha(path), 'bytes': path.stat().st_size}
                for path in sorted(area.rglob('*')) if path.is_file() and 'states' not in path.relative_to(area).parts and path.name not in ['run.json', 'artifacts.json']}
            write(area / 'artifacts.json', entries); report['manifestSha256'] = sha(area / 'artifacts.json'); write(area / 'run.json', report)
        retain_manifest()
        if report['status'] == 'verified':
            try:
                evidence.readback(area, SPECS, CONTROLS, check_reader_controls=False)
                report['readbackControls'] = evidence.reader_controls(area, SPECS, CONTROLS)
                write(area / 'readback-controls.json', report['readbackControls'])
                retain_manifest()
                verify_evidence(area)
            except Exception as error:
                report['status'] = 'failed'; report['error'] = str(error); retain_manifest()
        print(json.dumps({'status': report['status'], 'evidence': str(area), 'seconds': report['seconds'], 'error': report.get('error')}, ensure_ascii=False))
    return 0 if report['status'] == 'verified' else 1

if __name__ == '__main__':
    raise SystemExit(main())
