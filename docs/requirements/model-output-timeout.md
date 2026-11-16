# 模型默认输出额度与非流式传输时限

原始要求：默认 `maxTokens` 从既有环境变量读取，缺省 384000；不要另开一条配置路径。生产现象是方案师（qwen4-max-preview）没有报错退出，而是被 300 秒固定上限连续卡住后人工停止。300000 毫秒是 Node fetch（undici）默认 `headersTimeout`。当前请求 `stream: false`，提供方要等整段生成结束才发送响应头，所以等响应头等于等整段生成。默认输出额度提到 384000 后，单轮生成更容易超过 300 秒。

| 编号 | EARS 要求 | 验收 |
| --- | --- | --- |
| OUT-01 | 当从环境生成模型配置且该模型未指定 `MAX_TOKENS` 时，系统应把 `maxTokens` 设为 384000。 | Y176 |
| OUT-02 | 如果显式设置了 `MAX_TOKENS`，或 `EXTRA_BODY` 含有 `max_tokens` / `max_completion_tokens`，则系统应沿用既有优先级，不用默认额度覆盖显式额度。 | Y176 |
| OUT-03 | 当适配器发出非流式 Chat Completions 请求时，系统应从 `MODEL_HEADERS_TIMEOUT_MS` 与 `MODEL_BODY_TIMEOUT_MS` 读取响应头和响应体时限；未设置时两者均为 2147483647 毫秒。 | Y176 |
| OUT-04 | 当非流式响应在已配置时限和工作期限之内完整返回时，系统应读完正文并执行既有协议校验，通过后才接受结果。 | Y177 |
| OUT-05 | 如果响应头或响应体超过已配置的客户端时限，且用户未停止、工作期限未到，则系统应中止该请求，记为可重试的网络失败，且不发布部分正文。 | Y177 |
| OUT-06 | 如果等待响应头期间工作期限到达或用户停止，则系统应中止请求，分别沿用工作超时和停止结算，且不把该中断记成可重试的网络失败，也不发布部分正文。 | Y178 |
| OUT-07 | 如果 `MODEL_HEADERS_TIMEOUT_MS` 或 `MODEL_BODY_TIMEOUT_MS` 不是 1 到 2147483647 的整数，则系统应拒绝该配置且不向提供方发出请求。 | Y179 |

核查：OUT-01 复用 `MODEL_MAX_TOKENS` 及各角色同名后缀，缺省从 仅 DeepSeek V4.1 Flash 改为所有未指定模型。这替换了“其他模型保持未设置”的旧约束；显式额度和附加完成额度的优先级保留，非法 `MAX_TOKENS` 仍由既有配置场景拒绝。OUT-03 的两个变量只约束客户端传输，不进入模型签名，避免改时限被当成模型配置变更。2147483647 毫秒是 Node 可计时上限，大于 undici 默认的 300000 毫秒；按 1 token/秒计算，384000 token 需要 384000000 毫秒，该默认值仍覆盖这次生成。请求保持 `stream: false`，因为适配器只校验完整 JSON，提供方协议没有在这里改成 SSE。工作期限和用户停止仍通过原有中止信号生效。协议校验、停止、失败和恢复要求没有放宽。

状态范围：不新增 XState 转移。输出额度仍是环境配置投影；传输时限在适配器领取已持久化意图之后生效。成功、网络失败、工作超时和停止分别进入既有结果、`WORK_FAILED` 与停止结算。

实现前门槛（源码 `a95355a78dbbc97b753bc6fbabaf8aeeb7bdfce7`，Node v22.23.4，真实 taskMachine）：

```
MODEL_BASE_URL=http://127.0.0.1:9/v1 MODEL_NAME=fixture MODEL_NO_AUTH=true node --import tsx tests/maximum-budget-model-gate.ts
```

结果：领取、消费、宿主授权拒绝启动、停止通过；下游直接补救完成，三次网络重试后停止。

```
MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=controlled MODEL_NO_AUTH=true node --import tsx tests/model-response-model-gate.ts
```

结果：负责人非瞬时失败进入 waitingHuman 且不重试；检查失败为 ended/partial 且不发布；停止后的迟到结果被拒绝。

接线后用同一 Node 复跑上述两条命令，结果不变。BT_Y176–Y179 共 9 个场景、649 步通过；BT_Y155 3 个场景通过；BT_M46–M49 共 9 个场景通过。`tests/model-env.test.ts` 与 `tests/model-adapter.test.ts` 共 30 项通过。`tsc -p tsconfig.json` 与 `tsc -p tests/tsconfig.json` 通过。

