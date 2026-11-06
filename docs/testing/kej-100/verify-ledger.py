#!/usr/bin/env python3
"""Check the frozen inventory against this one-off cleanup record, not test quality."""
import collections
import json
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def read(name):
    return json.loads((HERE / name).read_text())


def entries(document):
    groups = document if isinstance(document, list) else document['groups']
    return [(group, (group['file'], case))
            for group in groups for case in group['cases']]


def tags(source):
    return [tag for line in source.splitlines() if line.lstrip().startswith('@')
            for tag in re.findall(r'@BT_[A-Z]\d+\b', line)]


baseline = read('baseline-vitest.json')
expected = {(file['file'], case['name']): file['unitEntry']
            for file in baseline for case in file['cases']}
assert len(expected) == 966, 'Frozen baseline must contain 966 distinct cases'
ledgers = {name: read(name + '.json')
           for name in ['ui', 'host', 'core', 'delivery', 'map', 'other']}
primary = []
for name, document in ledgers.items():
    for group, key in entries(document):
        assert key in expected, (name, 'Unknown original case', key)
        assert group.get('disposition') and group.get('reason'), (name, key)
        assert group.get('btIds') or group.get('command'), (name, key)
        assert group.get('evidence'), (name, 'Missing review evidence', key)
        if name == 'other' or expected[key]:
            primary.append(key)
        if group.get('delegateLedger'):
            target = pathlib.Path(group['delegateLedger']).stem
            assert target in ledgers, ('Unknown delegate ledger', target)
            assert any(key == item for _, item in entries(ledgers[target])), ('Missing delegated case', key)

counts = collections.Counter(primary)
assert set(counts) == set(expected), ('Unaccounted cases', set(expected) - set(counts))
assert all(value == 1 for value in counts.values()), ('Duplicate primary records', counts)
assert all(not expected[key] for _, key in entries(ledgers['other'])), 'Other ledger contains unit cases'
for name, document in ledgers.items():
    if name != 'other':
        assert all(expected[key] or any(key == other for _, other in entries(ledgers['other']))
                   for _, key in entries(document)), name

source_changes = subprocess.check_output(
    ['git', 'diff', read('baseline.json')['commit'], '--name-only', '--',
     'src', 'web', 'team.config.ts', 'package-lock.json', 'features/acceptance-gaps.json'],
    cwd=ROOT, text=True)
assert not source_changes, ('Product, dependency or acceptance-gap change', source_changes)
baseline_meta = read('baseline.json')
original_tags = set()
for file in baseline_meta['files']:
    if file.startswith('features/') and file.endswith('.feature'):
        source = subprocess.check_output(
            ['git', 'show', baseline_meta['commit'] + ':' + file], cwd=ROOT, text=True)
        original_tags.update(tags(source))
current_tags = [tag for file in (ROOT / 'features').glob('*.feature')
                for tag in tags(file.read_text())]
assert original_tags <= set(current_tags), ('Removed acceptance identities', original_tags - set(current_tags))
assert len(current_tags) == len(set(current_tags)), 'Duplicate acceptance identity'
if '--results' in sys.argv:
    report = json.loads((ROOT / 'test-results/vitest.json').read_text())
    actual = set()
    for file in report['testResults']:
        name = pathlib.Path(file['name']).relative_to(ROOT).as_posix()
        for case in file['assertionResults']:
            assert case['status'] == 'passed', (name, case['fullName'], case['status'])
            actual.add((name, case['fullName']))
    assert actual <= set(expected), ('Unexpected Vitest cases', actual - set(expected))
    for group, key in entries(ledgers['other']):
        migrated = group['disposition'].startswith('migrat')
        assert (key not in actual) if migrated else (key in actual), ('Disposition and execution differ', key)
    assert all(not expected[key] for key in actual), 'A baseline unit case remains in Vitest'
print(json.dumps({'baselineCases': len(expected), 'unitCasesAccounted': 406,
                  'otherCasesAccounted': 560, 'primaryRecords': len(primary),
                  'originalAcceptanceIdentitiesPreserved': len(original_tags),
                  'productAndAcceptanceGapsUnchanged': True}, indent=2))
