The live behavior evaluator compares the actual adapter at `1893d0be` with the current adapter. It loads the baseline in an isolated worktree and reuses frozen work, capabilities, service parameters and tool stimuli. The intended system prompt is the only request difference. The default ten cases run twice in AB/BA order.

Run the evaluator's deterministic positive/negative controls without network access:

```sh
node --import tsx tests/shared-agent-behavior-live.ts --self-check
```

Exercise capture, pairing, tool follow-ups, credential redaction, authentication failure and cleanup with a local scripted provider:

```sh
node --import tsx tests/shared-agent-behavior-live-controls.ts work/new-control-evidence
```

These commands test the evaluator. Scripted provider replies do not measure prompt behavior. The control command uses loopback networking and no real provider credentials.

Without `--run`, the live command only checks configuration and sends no request. Missing `MODEL_BASE_URL` or `MODEL_NAME` records `blocked` and exits 78. Select the provider and model explicitly and supply its existing credential through the environment; never write it into an evidence argument or command:

```sh
node --import tsx tests/shared-agent-behavior-live.ts --run --repeats 2 --evidence reports/shared-agent-behavior-live/new-study
```

The first scheduled trial also serves as preflight. Provider failures and an invalid first protocol output stop the study. There is no automatic provider retry or model substitution. Normal subsequent protocol-invalid samples remain in the original denominator. The controlled scope permits tool follow-ups but grants no format-repair regeneration, so host repair cannot hide an invalid initial model action. This layer measures model choices; it does not execute business CLIs or replace Engine/OS integration verification.

The hard request limit is 64, including tool follow-ups. When a prior batch already used requests, preserve that evidence and constrain the next batch:

```sh
node --import tsx tests/shared-agent-behavior-live.ts --run --max-requests 63 --prior-batch reports/shared-agent-behavior-live/previous-batch --evidence reports/shared-agent-behavior-live/next-batch
```

The run and manifest record prior, current and cumulative requests. `NODE_USE_ENV_PROXY=1` and `NODE_USE_SYSTEM_CA=1` can select the existing environment proxy and normal system trust store when required by the execution environment. Never disable TLS verification.

A separately preregistered check-only follow-up can supply `--cases LB07 --repeats 4 --expected-system-addition-file work/exact-new-check-directive.txt`. The file must contain the exact additional system directive. Comparison requires it once in the candidate and absent from the baseline, while every other system remainder and all non-system inputs remain equal. This follow-up retains even its first check protocol failure as an observed result; provider failures still stop the study. It never modifies or merges the original study's verdicts.

Read back the persisted artifact hashes and deterministic verdicts independently:

```sh
node --import tsx tests/shared-agent-behavior-live.ts --verify-evidence reports/shared-agent-behavior-live/new-study
```

`status:completed` and exit 0 mean the scheduled study executed. Inspect `automaticContractsStatus`, `behaviorConclusion`, invalid samples and the separate review pack before drawing a behavior conclusion. Hard checks cover specified actions and fields, not arbitrary prose. In particular, LB04 checks for the marker `741`; exact code interpretation still needs review. Neither two repetitions nor another Agent's qualitative review establishes a calibrated correctness rate, general improvement or a human verdict. All `humanVerdict` fields remain null until a human supplies them.

The recorded real-provider studies used `deepseek-v4.1-flash`. The original comparison used candidate `4032d883` and baseline `1893d0be`; the separate check-only follow-up used candidate `e1c29edb` and the same baseline. The frozen fixture SHA256 remained `8120ec4a9739e70934ac9faa7dd079cdba622de25a9d2c2d90ae10f883b54b71`.

| Batch | Trials | Requests | Observations |
| --- | ---: | ---: | --- |
| Initial preflight without environment proxy | 1 incomplete | 1 | Transport failed before an HTTP response; retained in the budget |
| Original ten-case study | 40 | 46 | Baseline 15/20 hard passes, 1 hard failure, 4 protocol-invalid; candidate 18/20 hard passes, 2 protocol-invalid |
| Independent LB07 follow-up | 8 | 8 | Both variants 4/4 hard passes; no provider or protocol-invalid samples |
| Cumulative budget | | 55/64 | 9 unused; no further requests issued |

The original candidate's protocol failures were LB07 source-catalog citation and LB01 an extra status field in deliver. The follow-up only addresses citation guidance. Both variants passing the new fixed check does not establish a causal improvement or clear the original study's failures. The original automatic contract conclusion remains failed; open prose semantics retain their separate review boundary.

Original evidence directory: `reports/shared-agent-behavior-live/source4032-real-proxy-20261111`. Its manifest SHA256 is `ff92dc49950c3341d7e1b7c7115a3a3b7c17e6c95cd1f18cfc8eb7b217800e83`; actual evaluator SHA256 is `d01d27d14eb53dec7c07da76ebced0c00fab97bf2dddd5cd35198fe0b9c07ec4`. The complete evaluator/fixture snapshot is archived separately under `reports/shared-agent-behavior-live-sources/source4032-40trials`.

Follow-up evidence directory: `reports/shared-agent-behavior-live/sourcee1c29ed-LB07-targeted-20261111`. Its manifest SHA256 is `13041ad09da5920b16696ac2ebb407ce6e3448db2e9cccb2a1e2f149be47a5d2`; evaluator SHA256 is `6de6fd4636fac41a52ee1e46af978267b82c1dafbed4fa6b82da681e07d02083`. The registration is `reports/shared-agent-behavior-live-registrations/LB07-e1c29ed-20261111.json`.

Independent readback verified 262 original artifacts and 53 follow-up artifacts. Separate audits confirmed all 20 original pairs and 4 follow-up pairs had the declared system differences and identical non-system inputs within each pair; the follow-up non-system input also matched original LB07. Actual Adapter OpenCode headers were checked for all 46 and 8 response-bearing requests. Source fingerprints, cumulative budget, credential absence and owned temporary worktree cleanup were checked separately. These checks establish evidence integrity and experiment boundaries, not general semantic correctness.

The separate anonymous review bundle initially labelled LB03's inherited checkpoint messages as observed interactions without identifying them as history. A read-only supplement at `reports/shared-agent-behavior-blind-supplement/20261111` preserves the original messages and artifact hashes and corrects this attribution: all four LB03 samples had no current model-requested or host-invoked tool actions and one model response each. The original bundle and research artifacts remain unchanged. The hard oracle used current response/action capture throughout, so its verdicts did not change. The supplement manifest SHA256 is `d7073a886d5538e3bdb8ebc00951e102473726eaf3c0ef76885c5bbba250a470`.
