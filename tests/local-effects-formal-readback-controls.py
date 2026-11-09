#!/usr/bin/env python3
"""Exercise an evidence reader against intact proof and internally consistent missing data."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def update_manifest(area, changed=None, omitted_prefix=None):
    manifest_path = area / 'artifacts.json'
    manifest = json.loads(manifest_path.read_text())
    if changed:
        name = str(changed.relative_to(area))
        old = manifest[name]
        manifest[name] = {'sha256': digest(changed), 'bytes': changed.stat().st_size} if isinstance(old, dict) else digest(changed)
    if omitted_prefix:
        manifest = {name: entry for name, entry in manifest.items() if not name.startswith(omitted_prefix)}
    save(manifest_path, manifest)
    report_path = area / 'run.json'
    report = json.loads(report_path.read_text())
    for key in ['manifestSha256', 'evidenceManifestSha256']:
        if key in report:
            report[key] = digest(manifest_path)
    # Local-effects includes run.json itself in its manifest. The other readers
    # keep the manifest digest in run.json, which is intentionally outside it.
    if 'run.json' not in manifest:
        save(report_path, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--checker', type=Path, required=True)
    parser.add_argument('--proof', type=Path, required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    checker, proof, out = args.checker.resolve(), args.proof.resolve(), args.evidence.resolve()
    assert proof.is_dir() and checker.is_file()
    assert out != proof and proof not in out.parents, 'Keep controls outside the source proof'
    out.mkdir(parents=True, exist_ok=False)
    shutil.copyfile(Path(__file__), out / 'readback-controls.py')
    reader_source = out / 'reader-source'
    reader_source.mkdir()
    for source in checker.parent.glob('*.py'):
        shutil.copyfile(source, reader_source / source.name)
    records = []
    source_identity = {name: digest(proof / name) for name in ['artifacts.json', 'run.json']}
    report = {'status': 'running', 'checker': str(checker), 'checkerSha256': digest(checker),
              'readerSources': {source.name: digest(source) for source in reader_source.iterdir()},
              'python': sys.version, 'sourceProof': str(proof), 'sourceIdentity': source_identity, 'cases': records}

    def verify(area, name):
        command = [sys.executable, str(checker), '--verify-evidence', str(area)]
        done = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=30)
        (out / f'{name}.stdout.log').write_text(done.stdout)
        (out / f'{name}.stderr.log').write_text(done.stderr)
        record = {'case': name, 'command': command, 'exitCode': done.returncode,
                  'reason': next((line for line in reversed(done.stderr.splitlines()) if line), None)}
        records.append(record)
        return done

    scratch = None
    try:
        assert verify(proof, 'intact-before').returncode == 0, 'Original proof must pass before fault injection'
        with tempfile.TemporaryDirectory(prefix='formal-readback-controls-') as temp:
            scratch = Path(temp)
            for name in ['raw-log-tamper', 'truncated-edges', 'missing-negative-controls', 'missing-code-control-details']:
                area = scratch / name
                shutil.copytree(proof, area)
                if name == 'raw-log-tamper':
                    path = next((area / 'baseline').rglob('tlc.log'))
                    path.write_text(path.read_text() + '\nchanged-after-run\n')
                elif name == 'truncated-edges':
                    path = next((area / 'baseline').rglob('*.jsonl'), None)
                    if path is None:
                        path = next(area.glob('baseline*.jsonl'))
                    rows = path.read_text().splitlines()
                    assert len(rows) > 1
                    path.write_text('\n'.join(rows[:-1]) + '\n')
                    update_manifest(area, changed=path)
                elif name == 'missing-negative-controls':
                    assert (area / 'negative-controls').is_dir()
                    shutil.rmtree(area / 'negative-controls')
                    update_manifest(area, omitted_prefix='negative-controls/')
                else:
                    removed = []
                    for directory in [area / 'negative-controls', area / 'composition/negative-controls']:
                        if not directory.exists():
                            continue
                        for control in directory.iterdir():
                            if not control.is_dir():
                                continue
                            for path in control.iterdir():
                                if path.is_file() and path.suffix in ['.json', '.diff']:
                                    removed.append(str(path.relative_to(area)))
                                    path.unlink()
                    assert removed, 'No raw negative-control details to remove'
                    manifest_path = area / 'artifacts.json'
                    manifest = json.loads(manifest_path.read_text())
                    save(manifest_path, {key: entry for key, entry in manifest.items() if key not in removed})
                    update_manifest(area)
                result = verify(area, name)
                assert result.returncode != 0, f'False green: {name}'
                text = result.stderr.lower()
                if name == 'raw-log-tamper':
                    assert 'tlc.log' in text and ('changed' in text or 'modified' in text), 'Wrong corruption failure'
                elif name == 'truncated-edges':
                    assert 'edge' in text and ('assertionerror' in text or 'error' in text), 'Wrong edge omission failure'
                else:
                    assert 'negative-controls' in text and ('missing' in text or 'no such file' in text), 'Wrong missing-control failure'
        assert verify(proof, 'intact-after').returncode == 0, 'Original proof must still pass after controls'
        assert source_identity == {name: digest(proof / name) for name in source_identity}, 'Source proof modified'
        report['status'] = 'verified'
    except Exception as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        report['cleanup'] = {'scratchRemoved': scratch is None or not scratch.exists(),
                             'sourceEvidenceUnchanged': source_identity == {name: digest(proof / name) for name in source_identity}}
        save(out / 'run.json', report)
        save(out / 'artifacts.json', {str(path.relative_to(out)): {'bytes': path.stat().st_size, 'sha256': digest(path)}
             for path in out.iterdir() if path.is_file() and path.name != 'artifacts.json'})
        print(json.dumps({'status': report['status'], 'evidence': str(out), 'cleanup': report['cleanup']}))


if __name__ == '__main__':
    main()
