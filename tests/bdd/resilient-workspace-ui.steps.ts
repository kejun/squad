import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { After, Given, When, Then } from '@cucumber/cucumber';
import type { SpecWorld } from './steps.js';
import { ResilientWorkspaceUICase } from '../resilient-workspace-ui-case.mjs';

const fixtures = new WeakMap<SpecWorld, ResilientWorkspaceUICase>();
const timeout = { timeout: 45_000 };
After(timeout, async function (this: SpecWorld, { result }) {
  const fixture = fixtures.get(this);
  if (result?.status !== 'PASSED') fixture?.markFailed(result?.message);
  await fixture?.close();
});

// Bind every literal step in this feature; no scenario or failure is excluded.
// Repeated Then clauses re-read the full externally observable case contract.
const source = readFileSync(new URL('../../features/59_resilient_workspace_ui.feature', import.meta.url), 'utf8');
let scenario = '', kind: 'given' | 'when' | 'then' = 'given', firstGiven = false;
const definitions = new Set<string>();
for (const line of source.split('\n')) {
  const tag = /@BT_Y\d+/.exec(line)?.[0];
  if (tag) { scenario = tag.slice(1); firstGiven = true; }
  const step = /^\s+(假如|当|那么|而且) (.+)$/.exec(line);
  if (!step) continue;
  if (step[1] !== '而且') kind = step[1] === '假如' ? 'given' : step[1] === '当' ? 'when' : 'then';
  const text = step[2]!, id = scenario, starts = kind === 'given' && firstGiven;
  assert(!definitions.has(text), `UI feature step must remain unambiguous: ${text}`); definitions.add(text);
  if (kind === 'given') {
    Given(text, timeout, async function (this: SpecWorld) {
      if (starts) { const fixture = new ResilientWorkspaceUICase(id); fixtures.set(this, fixture); await fixture.open(); }
      else await fixtures.get(this)!.additional();
    });
    firstGiven = false;
  } else if (kind === 'when') When(text, timeout, async function (this: SpecWorld) { await fixtures.get(this)!.act(); });
  else Then(text, timeout, async function (this: SpecWorld) { await fixtures.get(this)!.verify(); });
}
