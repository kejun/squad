# KEJ-103 action log

- Read AGENTS.md and Uncle Bob Mode before changes; inspected original CLI crash acceptance, journal, runner, WebService startup, and existing pure model contracts.
- Rebased onto origin/main 8a2f82b before editing; use current real model as baseline.
- Scope is dependency validation: preserve existing XState decisions and replace the simulated execution-after-crash window with an actual killed host. Add a durable-journal-before-DB counterpart. No new business state or production fault hook is needed.
- Pure model gate passed at baseline: BT_L73/L74, 14 scenarios/574 steps. Existing task.machine.ts blob c6a79625d5e5bc527fbcca414400af3e8d4a682f.
- Added the journal-before-DB example to BT_L06 and documented the exact existing state/recovery flow before writing the dependency fixture.
- Added a separately spawned WebService host using the real Store/Runner/LocalRuntime and actual CLI; two fsync receipt barriers precede parent SIGKILL. Unknown recovery, trusted acknowledgement, stopped late receipt, settled duplicate recovery and lease cleanup are asserted through public interfaces.
- First direct target run passed 7 scenarios/294 steps; tests TypeScript passed. Then related BT_L05/L06/L11/L14/L73/L74 passed 25 scenarios/1033 steps, and existing WebService durability integration passed 2 tests.
- Added isolated source-copy negative controls for blind replay and invented settlement. Both fail the concrete unknown-effects assertion; source and temporary copies restored/removed.
- Read-only cross-review prompted an additional settled-recovery restart asserting unchanged model calls, owner identity, checkpoint/receipt, candidate/artifacts/publication, and operation count. Three standalone positive modes pass after the addition.
- Cross-review tightened known receipt continuation to exactly one owner request and one check request; stopped continuation has neither.
- Reused KEJ-104 native TypeScript .js-resolution loader for the killed host so SIGKILL cannot orphan tsx's external compiler; asserted complete host process-group disappearance. Three actual fault/stop modes passed using the native host.
- Set per-step 30-second bounds for the real process recovery/acknowledgement BDD drivers; inner barriers and process exit retain shorter independent bounds.
- Final clean code SHA 57d9286: root and tests TypeScript passed; BT_L05/L06/L11/L14/L73/L74 passed 25 scenarios/1033 steps using native killed hosts. Both isolation mutations again failed the target unknown-effect assertion. All three host process groups disappeared; temporary state removed.
- Captured a reviewable docs/testing/kej-103/evidence.json with exact source SHA, model blob, host/CLI PIDs, SIGKILL exits, journal/SQLite boundary states, model continuation counts, evidence hashes and cleanup results. Original full run.json and host logs remain under reports/kej-103/.
