#!/usr/bin/env python3
import importlib.util
from pathlib import Path
here = Path(__file__).resolve().parent
path = here.parents[1] / 'verify-squad-handoff/scripts/composition_support.py'
spec = importlib.util.spec_from_file_location('squad_composition', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.run_suite(here.parent, here.parent / 'references/composition-spec.json')

# Independently reject omitted negative backends, witnesses or temporal checks.
import json
import sys
if '--verify-evidence' in sys.argv:
    area = Path(sys.argv[sys.argv.index('--verify-evidence') + 1]).resolve()
    report = json.loads((area / 'run.json').read_text())
    original = area / 'checker-inputs' / here.parent.name / 'references/composition-spec.json'
    suite = json.loads(original.read_text())
    assert set(report['negativeControls']) == {item['name'] for item in suite['controls']}, 'Omitted authority control'
    for control in suite['controls']:
        assert set(report['negativeControls'][control['name']]['stores']) == {'memory', 'sqlite'}, 'Omitted negative store'
        for backend in ['memory', 'sqlite']:
            result = json.loads((area / 'negative-controls' / control['name'] / ('approval-' + backend + '.json')).read_text())
            assert {store['name'] for store in result['backends']} == {backend}, 'Omitted negative backend'
            assert all(store['status'] == 'failed' and control['property'] in store.get('error', '') for store in result['backends']), 'Control did not violate its property on both stores'
    expected = {name for item in suite['models'] for name in item['witnesses']}
    assert {item['witness'] for item in report['witnesses']} == expected, 'Omitted authority reachability'
    for item in report['witnesses']:
        raw = (area / 'reachability' / item['domain'] / item['witness'] / 'tlc.log').read_text()
        assert f'Invariant {item["witness"]} is violated' in raw, 'Witness did not establish reachability'
    for stage in ['baseline', 'restored']:
        raw = (area / stage / 'approval/tlc.log').read_text()
        assert 'Finished checking temporal properties' in raw and '0 states left on queue' in raw
    print('Authority composition: both negative backends, all witnesses and liveness independently verified')
