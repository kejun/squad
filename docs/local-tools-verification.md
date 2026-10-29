# 本地技能与 CLI 验证记录

实现从 `d526aac` 开始，遵循 Gherkin → 状态图 → 真实 XState → 模型仿真 → I/O 接入顺序。BT_L01–BT_L13 在 `features/24_local_skills_cli.feature`；细化图在 `docs/state-diagrams.md` 的「本地技能与 CLI 子操作」。

## 接入前模型门槛

`node node_modules/vitest/vitest.mjs run tests/local-operation-model.test.ts --maxWorkers=1`：9/9 通过。模型使用真实 `taskMachine`，每个事件后序列化再恢复，所有时钟及回执受控，无文件、模型或进程 I/O。

受测模型 blob：`task.machine.ts=473c37e48c7cd6509863ea827dbb82c0495fbc82`；`local-operation.ts=dc16b0876770d6202aedeaa71766d7c282ff33fb`；`types.ts=076af7a7e51830052651ebd4bf60af54e3ee312b`。后续模型变化必须先复验再继续接线。

关键轨迹：父工作 inflight → LOCAL_REQUEST queued → LOCAL_CLAIM claimed（ordinary +1）→ LOCAL_STARTED running → LOCAL_RESULT succeeded（回执与模型检查点一同保存），父工作仍 inflight。STOP 将 claimed/running 置 cancelling，SETTLE 被拒，直到会话确实退出。RECOVER 将已领取且无回执的写入置 uncertain，并保留锁；仅可信的 LOCAL_RECONCILE 能解除。已保存成功回执恢复后可直接交给原 Bot，不重跑 CLI。

覆盖普通预算、评审/讨论汇总保留、check 子操作普通预算、元数据免费、权限撤销、旧 payload 无授权、版本失效、身份冲突、迟到回执、未结算交付与四类崩溃边界。

## 执行边界

固定 Anthropic Sandbox Runtime `0.0.81`（已核对其 allowRead、PID namespace、die-with-parent 和依赖探测实现）。当前验证宿主的 bubblewrap 返回 `Creating new namespace failed: Operation not permitted`；生产后端必须如实返回不可用，不能把受控进程夹具当作 OS 隔离验证。后续集成记录须区分真实子进程测试、策略测试和实际 OS 沙箱验收。
