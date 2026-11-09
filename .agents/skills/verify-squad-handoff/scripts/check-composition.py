#!/usr/bin/env python3
from pathlib import Path
from composition_support import run_suite
skill = Path(__file__).resolve().parents[1]
run_suite(skill, skill / 'references/composition-suite.json')
