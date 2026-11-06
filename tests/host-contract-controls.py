#!/usr/bin/env python3
"""Show that direct host Gherkin rejects representative real guard regressions."""
import argparse
import difflib
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CONTROLS = [
    ('approval-identity', 'BT_L26', 'src/local-operation.ts', "if (op.approval.id !== event.approvalId) return 'HOST_APPROVAL_MISMATCH';", '', 1),
    ('single-receipt', 'BT_L24', 'src/local-operation.ts', "if (!op || op.sessionId !== event.sessionId || !['claimed', 'running', 'cancelling', 'uncertain'].includes(op.status)) return 'LOCAL_SESSION_MISMATCH';", "if (!op || op.sessionId !== event.sessionId) return 'LOCAL_SESSION_MISMATCH';", 1),
    ('session-host-scope', 'BT_L36', 'src/host-session.ts', ' && g.host === p.host', '', 1),
    ('session-revocation', 'BT_L37', 'src/host-session.ts', '  c.hostSession = undefined;', '', 1),
    ('discovery-cancellation', 'BT_L57', 'src/host-capabilities.ts', 'signal.throwIfAborted();', '', 4),
    ('discovery-deduplication', 'BT_L56', 'src/host-capabilities.ts', '[...new Set(commands)]', 'commands', 1),
    ('discovery-authority-metadata', 'BT_L56', 'src/host-capabilities.ts', 'hostApprovalRequired: true', 'hostApprovalRequired: false', 1),
    ('retry-source-hash', 'BT_L34', 'src/host-retry.ts', "if (op.requestHash !== sourceRequestHash) return 'SOURCE_COMMAND_CHANGED';", '', 1),
    ('retry-isolated-source', 'BT_L34', 'src/host-retry.ts', "if (work.kind === 'check' || work.discussionId || op.isolated) return 'HOST_RETRY_ISOLATED_SOURCE';", '', 1),
    ('retry-unconfirmed-effects', 'BT_L55', 'src/host-retry.ts', 'return !batchRequests(c, batch.id).some(request => retryEffectUnconfirmed(request, operations));', 'return true;', 1),
    ('retry-preserved-receipt', 'BT_L54', 'src/host-retry.ts', 'if (op?.finishedAt !== undefined) {', 'if (false) {', 1),
    ('retry-source-warning', 'BT_L32', 'src/host-retry.ts', 'changed ?', 'false ?', 1),
    ('retry-request-idempotency', 'BT_L33', 'src/host-retry.ts', 'if (existing) { ok(c, existing.id); return; }', '', 1),
    ('retry-next-request', 'BT_L47', 'src/host-retry.ts', 'if (!c.stopped && !localRecoveryBlocked(c) && request.goalVersion === c.goalVersion) queueNext(c, work, at);', '', 1),
    ('retry-model-charge', 'BT_L49', 'src/task/reducer.ts', 'if (!c.hostRetryBatch.ownerClaimed || previousRequests > 0) c.usage.ordinary++;', 'if (!c.hostRetryBatch.ownerClaimed) c.usage.ordinary++;', 1),
]


def source_hashes():
    return {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (ROOT / 'src').rglob('*.ts')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', required=True)
    parser.add_argument('--only', action='append', choices=[item[0] for item in CONTROLS])
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    before = source_hashes()
    records = []
    selected = [item for item in CONTROLS if not args.only or item[0] in args.only]
    for name, tag, file, old, new, count in selected:
        evidence = output / name
        evidence.mkdir()
        with tempfile.TemporaryDirectory(prefix='host-bdd-control-', dir=output) as tmp:
            scratch = Path(tmp)
            for folder in ['src', 'tests', 'features', 'web', 'scripts', 'examples']:
                shutil.copytree(ROOT / folder, scratch / folder, ignore=shutil.ignore_patterns('node_modules', 'dist', '__pycache__'))
            for name_in_root in ['package.json', 'team.config.ts', 'tsconfig.json']:
                shutil.copy(ROOT / name_in_root, scratch / name_in_root)
            (scratch / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            target = scratch / file
            original = target.read_text()
            assert original.count(old) == count, f'Expected exact mutation site count: {file}'
            modified = original.replace(old, new)
            target.write_text(modified)
            (evidence / 'mutation.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), modified.splitlines(True), fromfile=file, tofile=file)))
            command = ['node', '--import', 'tsx', 'node_modules/@cucumber/cucumber/bin/cucumber.js', 'features/27_host_cli_approval.feature', 'features/30_host_capabilities.feature', '--import', 'tests/bdd/*.ts', '--tags', '@' + tag, '--format', 'summary', '--format', 'json:' + str(evidence / 'cucumber.json')]
            env = {**os.environ, 'MODEL_BASE_URL': 'https://example.test/v1', 'MODEL_NAME': 'fixture', 'TSX_TSCONFIG_PATH': 'tests/bdd/tsconfig.json'}
            result = subprocess.run(command, cwd=scratch, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=60)
            (evidence / 'run.log').write_text(result.stdout)
            assert result.returncode != 0 and 'AssertionError' in result.stdout, f'{name}: must fail on behavior, not setup'
            data = json.loads((evidence / 'cucumber.json').read_text())
            failures = [{'scenario': case['name'], 'step': step['name'], 'error': step['result'].get('error_message', '')} for feature in data for case in feature.get('elements', []) for step in case.get('steps', []) if step.get('result', {}).get('status') == 'failed']
            assert failures and any('AssertionError' in failure['error'] for failure in failures)
            records.append({'name': name, 'btId': tag, 'source': file, 'old': old, 'new': new, 'mutationSites': count, 'exitCode': result.returncode, 'failedAssertions': failures, 'command': command, 'scratchRemoved': False})
        records[-1]['scratchRemoved'] = not scratch.exists()
        assert records[-1]['scratchRemoved']
        print(json.dumps({'control': name, 'exitCode': result.returncode, 'failures': len(failures)}), flush=True)
    assert before == source_hashes(), 'Product sources changed during controls'
    report = {'status': 'passed', 'sourceFilesUnchanged': True, 'sourceHashes': before, 'controls': records}
    (output / 'controls.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
