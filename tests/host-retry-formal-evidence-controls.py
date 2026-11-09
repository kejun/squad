#!/usr/bin/env python3
"""Self-consistent missing/raw-trace evidence must still be rejected."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
root=Path(__file__).resolve().parents[1]
evidence=Path(sys.argv[1]).resolve()
output=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else root/'reports/verify-squad-host-retry/evidence-controls.json'
checker=root/'.agents/skills/verify-squad-host-retry/scripts/check.py'
records=[]
for name in ['missing-negative-controls','truncated-edge-records','missing-baseline-replay','tampered-edge-state','invalid-public-prefix','missing-implementation','missing-properties']:
    scratch=Path(tempfile.mkdtemp(prefix='host-retry-evidence-control-'))
    clone=scratch/'evidence'
    try:
        shutil.copytree(evidence,clone,ignore=shutil.ignore_patterns('states'))
        if name=='missing-negative-controls':
            shutil.rmtree(clone/'negative-controls')
            expected='Required raw evidence missing'
        elif name=='missing-implementation':
            shutil.rmtree(clone/'inputs/implementation');expected='Required raw evidence missing'
        elif name=='missing-properties':
            path=clone/'baseline/HostRetry.cfg';path.write_text(path.read_text().replace('NoUnknownAdvance ',''));expected='Configured proof properties missing'
        elif name=='truncated-edge-records':
            path=clone/'baseline/replay.json.jsonl'
            path.write_text('\n'.join(path.read_text().splitlines()[1:])+'\n')
            expected='Incomplete labeled-edge records'
        elif name in ['tampered-edge-state','invalid-public-prefix','missing-implementation','missing-properties']:
            path=clone/'baseline/replay.json.jsonl';rows=[json.loads(line) for line in path.read_text().splitlines()]
            if name=='tampered-edge-state':
                rows[0]['actual']['parent']=999;expected='Replay actual state disagrees'
            else:
                rows[0]['prefix']=['NotAPublicAction'];expected='Replay prefix is not a reachable'
            path.write_text(''.join(json.dumps(row)+'\n' for row in rows))
        else:
            (clone/'baseline/replay.json').unlink()
            expected='Required raw evidence missing'
        # This is deliberately stronger than a stale SHA failure: rebuild both
        # manifest and summary digest so internal completeness has to reject it.
        manifest={str(path.relative_to(clone)):{'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in sorted(clone.rglob('*')) if path.is_file() and path.name not in ['artifacts.json','run.json']}
        manifest_path=clone/'artifacts.json';manifest_path.write_text(json.dumps(manifest,indent=2))
        report=json.loads((clone/'run.json').read_text());report['manifestSha256']=hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        (clone/'run.json').write_text(json.dumps(report,indent=2))
        child=subprocess.run([sys.executable,str(checker),'--verify-evidence',str(clone)],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=20)
        assert child.returncode!=0 and expected in child.stdout,f'{name} was not rejected for completeness'
        records.append({'case':name,'exitCode':child.returncode,'expected':expected,'log':child.stdout})
    finally:
        shutil.rmtree(scratch)
output.parent.mkdir(parents=True,exist_ok=True)
output.write_text(json.dumps({'status':'verified','sourceEvidence':str(evidence),'records':records,'scratchRemoved':True},ensure_ascii=False,indent=2))
print(json.dumps({'status':'verified','rejections':len(records),'output':str(output)}))
