# KEJ-105：成功响应读取资源边界

问题是成功 HTTP 响应原先直接 `response.json()`，供应方正文在解析前没有宿主字节约束。请求 `max_tokens` 只表达期望，不能限制供应方的 envelope、转义膨胀或违规响应。复用现有适配器、请求信号和 Runner 的非瞬时失败路径即可解决，不需要新 SDK 或任务状态。

## 契约与实施顺序

先写 `features/32_model_response_limit.feature` 的 BT_M38–M41，再更新 README 状态模型入口和 `docs/state-diagrams.md` 的「模型成功响应资源边界」。以 main `8a2f82bf26d467e8974ecbf8cc4ac3861fcf96da` 为门槛基线，以下纯真实 XState 驱动先通过，随后才修改适配器：

```sh
node --import tsx tests/core-model-gate.ts
node --import tsx tests/compatibility-model-gate.ts
MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=controlled MODEL_NO_AUTH=true node --import tsx tests/model-response-model-gate.ts
```

前两项分别通过 80 项核心场景驱动、55 项 actor/冻结快照契约。专项门槛验证 owner 非瞬时失败进入 waitingHuman 且不重试；check 非瞬时失败 ended/partial，不发布且不重试；停止拒绝迟到交付。专项门槛是场景的纯模型前置验证，不增加平行单元测试；实际字节、HTTP 取消、UTF-8 和 SQLite 由同一场景的真实依赖接线验证。

## 配置与实现

每个 `ModelService.maxResponseBytes` 是正安全整数；缺省 **8 MiB（8388608 字节）**。`.env` 的 `MODEL_MAX_RESPONSE_BYTES` 为默认值，成员、协调员、检查和输入理解前缀支持独立覆盖。配置进入现有 model binding 签名，改变上限不静默绕过恢复兼容性检查。

8 MiB 是宿主响应预算，不是 token 换算公式：普通完整 JSON envelope 和多语言转义结果通常远小于该容量；有限且宽松的缺省值保留正常输出空间。合法大输出可由部署方显式配置。`maxTokens` 和上下文窗口预检仍保持原职责。实际 JSON 解析仍会产生解码字符串和对象开销，因此 8 MiB 不是整个进程 RSS 的精确上限；它是每个成功体保留输入的上限。

实现按 fetch 暴露的实际解压后字节计数。声明的 Content-Length 不参与授权，不实的较小压缩长度无法绕过计数，夸大长度也不会掩盖分块超限。使用最多增长到上限的单个 Buffer 聚合，避免为大量极小 chunk 保留一个数组元素/对象；仅在完整结束后解码 UTF-8、解析 JSON。中断会取消 reader 并释放锁；超限取消读取并报告固定前缀 `MODEL_RESPONSE_TOO_LARGE`、配置字节数和下一步，不含供应方正文。外部停止和 deadline 优先保留其原失败语义，不被误记为可重试的检查 JSON 错误。

读取模式依据 [Fetch 的完整消费规则](https://fetch.spec.whatwg.org/#concept-body-consume-body)、[Streams 的 reader 取消与锁生命周期](https://streams.spec.whatwg.org/#default-reader-class)、[Node Buffer 字节存储接口](https://nodejs.org/api/buffer.html)。实际 gzip 解压、网络取消和分块行为另由本项目真实 Node fetch 验收。

## 可复跑验收

```sh
MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=controlled MODEL_NO_AUTH=true \
TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json \
node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js \
features/32_model_response_limit.feature --import 'tests/bdd/*.ts' --format progress

node tests/model-response-limit-negative.mjs
```

9 个直接 Gherkin 场景全部通过，复用原配置/Harness 并使用真实 `SqliteStore → TeamEngine → WorkRunner → OpenAICompatibleAdapter → 回环 HTTP`。没有拦截适配器的成功响应：

| 场景 | 真实证据 |
| --- | --- |
| BT_M38 两例 | 正确 Content-Length 的精确上限成功体；逐字节分块拆开中文 UTF-8，仍完整接受原中文结果 |
| BT_M39 四例 | owner/check 的无长度分块、夸大长度、gzip 声明长度小于上限但解压后超限；全都明确失败、无重试、无部分产物，非压缩响应在全体发送前关闭 |
| BT_M40 两例 | 正文读取中经 STOP 和 Runner cancel 取消；真实 deadline 取消；均不产生部分候选、产物或响应重试 |
| BT_M41 | 默认上限继承、检查角色独立覆盖；0、负值、小数、NaN、Infinity 被公开配置校验拒绝 |

`reports/kej-105/` 保存每次真实 HTTP/SQLite 场景的源码 SHA、源码哈希、Node 版本、实际正文/配置字节数、发送量、关闭/清理结果、请求数、失败状态、重试数、产物与敏感合成正文是否落盘。临时库和 HTTP 连接在成功/失败钩子中均有界清理。超时和停止保存各自证据，互不覆盖。

负对照只在隔离子进程的加载 hook 中把成功体读取上限替换为 `Number.MAX_SAFE_INTEGER`，不改工作区文件。4 个 BT_M39 必须因缺失目标 `MODEL_RESPONSE_TOO_LARGE` 业务断言而失败；脚本校验 mutation 已应用、原文件 SHA 不变，并在原实现下重跑全部 9 场景通过。结果在 `reports/kej-105-negative/result.json`，并保留 mutation 哈希、Cucumber JSON、日志与 HTTP 证据。最初有界读取实现前也已观察到目标超限断言失败。

相关回归命令：

```sh
MODEL_BASE_URL=http://127.0.0.1:1/v1 MODEL_NAME=controlled MODEL_NO_AUTH=true \
node node_modules/vitest/vitest.mjs run tests/model-adapter.test.ts \
tests/model-regeneration.test.ts tests/model-env.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tests/tsconfig.json --noEmit
```

41 项现有适配器/重生成/环境配置回归通过；测试 TypeScript 检查通过。集成分支仍需统一 `npm run check`、生产构建与四套 formal drift 审查/门禁，不能把本票局部通过等同全部 CI。

## 形式化边界影响

生产改动只有 `src/model-adapter.ts`（传输消费和故障分类）、`src/model-env.ts`（环境映射）、`src/types.ts`（配置字段/校验）。不修改 XState 状态/事件、领取规则、操作身份、预算算法、交接、发布或租约语义。超限使用现有 `WORK_FAILED transient=false`；配置随既有 binding 序列化。formal source 指纹需逐文件审查并刷新，不能只跳过 drift。真实供应方语义质量不在本票范围。

## 操作日志

读取规则、调研适配器/配置/既有夹具 → 定义场景 → 更新图 → 模型门槛通过 → 编写真实 HTTP/SQLite 场景并观察超限红灯 → 实现有界消费 → 9 场景通过 → 交叉评审后将 chunk 数组收敛为单 Buffer → 移除上限的 4 个负对照被业务断言检出 → 原实现全部恢复通过 → 41 项相关回归及 TypeScript 检查通过。详细执行日志在本工作树 `work/` 和上述可上传 `reports/` 中。
