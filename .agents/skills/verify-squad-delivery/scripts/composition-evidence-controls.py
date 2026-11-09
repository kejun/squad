#!/usr/bin/env python3
"""Self-consistent evidence tampering must fail the independent delivery reader."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve()
spec = importlib.util.spec_from_file_location('delivery_evidence_reader', SCRIPT.with_name('composition-check.py'))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resign(area, manifest, report):
    path = area / 'artifacts.json'
    path.write_text(json.dumps(manifest, indent=2))
    report['evidenceManifestSha256'] = digest(path)
    (area / 'run.json').write_text(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('evidence', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    original = args.evidence.resolve()
    baseline_count = reader.verify_composition_evidence(original)
    original_manifest = digest(original / 'artifacts.json')
    original_report = json.loads((original / 'run.json').read_text())
    prefix = 'composition/negative-controls/skip-validation/'
    cases = [
        ('missing-json', prefix + 'memory-code.json', 'Missing required raw artifact'),
        ('missing-log', prefix + 'memory-code.log', 'Missing required raw artifact'),
        ('missing-diff', prefix + 'real-code.diff', 'Missing required raw artifact'),
        ('missing-fixture', 'checker-inputs/composition/tests/source-lineage-formal-fixture.ts', 'Missing required raw artifact'),
        ('missing-progress', 'composition/Verification/baseline/Verification.cfg', 'required Progress temporal check'),
        ('missing-invariant', 'composition/Verification/baseline/Verification.cfg', 'required safety checks'),
        ('summary-differs', None, 'Raw negative result differs from run summary'),
    ]
    if 'composition' in original_report:
        cases.extend([
            ('missing-legacy-json', 'negative-controls/drop-final/memory-code.json', 'Missing required raw artifact'),
            ('missing-legacy-log', 'negative-controls/drop-final/memory-code.log', 'Missing required raw artifact'),
            ('missing-legacy-diff', 'negative-controls/drop-final/real-code.diff', 'Missing required raw artifact'),
            ('missing-legacy-controls', 'negative-controls', 'Missing required raw artifact'),
        ])
    results = []
    with tempfile.TemporaryDirectory(prefix='squad-delivery-readback-') as scratch:
        for name, relative, expected in cases:
            area = Path(scratch) / name
            shutil.copytree(original, area, ignore=shutil.ignore_patterns('states'))
            manifest = json.loads((area / 'artifacts.json').read_text())
            report = json.loads((area / 'run.json').read_text())
            if name == 'missing-legacy-controls':
                shutil.rmtree(area / relative)
                manifest = {key: value for key, value in manifest.items() if not key.startswith(relative + '/')}
            elif name.startswith('missing-') and name not in ['missing-progress', 'missing-invariant']:
                (area / relative).unlink()
                del manifest[relative]
            elif name in ['missing-progress', 'missing-invariant']:
                path = area / relative
                text = path.read_text()
                text = text.replace('PROPERTY Progress\n', '') if name == 'missing-progress' else text.replace(' OrderedPublication', '')
                path.write_text(text)
                manifest[relative] = {'sha256': digest(path), 'bytes': path.stat().st_size}
            else:
                report['composition']['negativeControls']['skip-validation']['stores']['memory']['error'] += '\nchanged summary'
            resign(area, manifest, report)
            # The generic integrity layer accepts this new self-consistent manifest.
            reader.helpers.verify_evidence(area)
            try:
                reader.verify_composition_evidence(area)
            except AssertionError as error:
                assert expected in str(error), f'{name}: failed at an unrelated check: {error}'
                results.append({'case': name, 'detected': True, 'guard': str(error), 'selfConsistentManifest': True})
            else:
                raise AssertionError(f'{name}: incomplete proof was accepted')
    assert digest(original / 'artifacts.json') == original_manifest
    assert reader.verify_composition_evidence(original) == baseline_count
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'status': 'verified', 'sourceEvidence': str(original), 'artifacts': baseline_count,
                                     'controls': results, 'originalEvidenceUnchanged': True, 'scratchRemoved': not Path(scratch).exists()}, indent=2))
    print(f'{len(results)} self-consistent evidence controls detected; original {baseline_count} artifacts still verify')


if __name__ == '__main__':
    main()
