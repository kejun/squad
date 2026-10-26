# 停止与继续

用户停止在途工作，再明确继续同一任务；界面和执行记录反映真实取消与恢复。

## Sub-features

- `control-stop`：停止在途请求，观察 stopped 和 HTTP 取消。
- `control-continue`：继续同一任务，保留身份。
- `control-input`：执行中补充、等待用户决定（扩展）。
- `control-recovery`：迟到结果与在途崩溃恢复（扩展）。

## How to get to it (user POV)

输入任务并发送，底部点「停止」，停止后点「继续执行」。执行中输入框接受补充，等待回复时输入决定，这些是其他入口。

## Driving it with verify-squad

Preconditions: `VERIFY_STOP` 夹具保留第一次 owner HTTP 请求直到用户取消，后续正常交付。普通瞬时返回不能代替此在途前提。

- **运行。** `node .agents/skills/verify-squad/scripts/verify.mjs --feature control`；动作位于 `control()`。
- **在途。** 发送 `VERIFY_STOP 停止后继续原任务`，快照应有 inflight，保存 `control-inflight`。
- **停止。** 点 button「停止」，等 outcome=stopped 且模型 HTTP 连接真实关闭，保存 `control-stopped`。
- **继续。** 点「继续执行」，等完成；任务总数=1、taskId 不变、至少有一个 cancelled 执行记录，保存 `control-continued` 与快照。
- **扩展。** 补充输入需可释放的延迟 HTTP 前提；等待决定需模型先返回 askUser。分别发送用户输入并核对安全边界后应用。在途崩溃恢复另设独立实例与持久化前提，记录各自证据。

## Gotchas

- 缺少 inflight 前提时报告失败，不能跳过停止断言。
- stopped/partial/failed/complete 不可混淆。本组证明本地 HTTP 取消，不证明供应商停止计算或停止收费。
- 关闭宿主导致的离线与停止任务不同；离线路径在 rooms 组。
