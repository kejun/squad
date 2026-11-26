# CLI 进程与回执结算状态图

用项目所用的 XState 5.33.3 对 `runProcess` 建模。图按实际观察事件绘制，覆盖单次命令的进程结算和身份记录。可执行模型由调用方发送 I/O 观察事件。 [模型源码](cli-receipt.machine.ts)

```mermaid
stateDiagram-v2
    direction LR
    state "准备日志并启动" as preparing
    state "执行中" as active
    state "整理进程回执并清理日志" as finalizing
    state "返回进程回执" as returned
    state "I/O 失败并抛错" as ioFailed

    [*] --> preparing
    preparing --> active: 子进程句柄已创建
    preparing --> ioFailed: 准备或启动抛错
    state active {
        state "等待 close" as running
        state "取消中 · 清理进程组" as cancelling
        state "已确认关闭" as closed
        state "关闭未确认" as unconfirmed

        [*] --> running
        running --> closed: close / 清理进程组并记录退出
        running --> cancelling: 超时、中止或身份处理失败
        cancelling --> closed: close 先到 / 清理进程组并保留取消原因
        cancelling --> unconfirmed: 强制结算期限先到
        closed --> [*]
        unconfirmed --> [*]
        --
        state "读身份并等待日志写入" as identityPending
        state "身份处理结束" as identityFinished

        [*] --> identityPending
        identityPending --> identityFinished: 写入成功、无可用 PID 或 ENOENT
        identityPending --> identityFinished: 其他错误 / 标记失败并发起内部取消
        identityFinished --> [*]
    }
    active --> finalizing: 两个并行区域都结束
    finalizing --> returned: 日志同步并关闭
    finalizing --> ioFailed: 清理日志抛错
    returned --> [*]
    ioFailed --> [*]
```

## 先到的事件决定进程结算

| 事件顺序 | 进程回执 |
| --- | --- |
| `close(0)` → 普通超时或外部中止 → 身份写入结束 | `succeeded`，`settled: true`、`effectsKnown: true` |
| 外部中止 → `close` → 强制结算期限 → 身份写入结束 | `cancelled`，`settled: true`、`effectsKnown: false` |
| 外部中止 → 强制结算期限 → 迟到的 `close` | `CLI_SESSION_UNCERTAIN`，`settled: false`、`effectsKnown: false` |
| `close` → 身份处理遇到非 ENOENT 错误 | 内部取消，`CLI_NOT_FOUND`，`settled: true`、`effectsKnown: false` |

`close` 停止普通超时、外部中止监听和已预约的取消计时，并立即向同组剩余进程发送 KILL。身份日志独立完成。关闭前的取消先发 TERM，300 ms 后尝试 KILL，1800 ms 后在关闭仍未确认时执行强制结算。发送进程组信号失败时，除进程组已不存在以外，模型记录执行错误并沿用先到的结算结果。 [结算与取消源码](../../src/local-cli.ts#L211)

XState 模型将日志同步、关闭与执行异常汇总为 I/O 完成或失败事件，并保留退出码、信号和结果分类。后续交付物捕获及持久结算回执由 `LocalRuntime` 负责。 [退出分类](../../src/local-cli.ts#L258) · [外层回执保存](../../src/local-runtime.ts#L430) · [真实进程回归](../../tests/local-tools-durability.test.ts#L9)
