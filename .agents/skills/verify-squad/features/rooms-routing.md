# 群聊与点名

用户创建或切换群聊，选择负责人发送消息，刷新和服务重启后仍可查看结果。

## Sub-features

- `rooms-create`：按钮和快捷键建群。
- `rooms-route`：默认 A、菜单/键盘点名 Builder 2。
- `rooms-persist`：切群、离线反馈、真实服务重启后保存。
- `rooms-compose-extra`：草稿、Shift+Enter、引用不调度（扩展）。

## How to get to it (user POV)

侧栏「新建群聊」或编辑区外 Ctrl+N / macOS ⌘N；输入框发送按钮或 Enter；「点名成员」菜单或输入 @ 补全；「群聊列表」中的群名称。

## Driving it with verify-squad

Preconditions: 按 SKILL.md 构建，空数据库、可显示中文的浏览器和正常本地模型夹具。

- **运行。** `node .agents/skills/verify-squad/scripts/verify.mjs --feature rooms`；动作位于助手的 `rooms()`。
- **默认负责人。** 点击 button「新建群聊」，在 textbox「群聊消息输入框」输入 `VERIFY_ROOMS 默认负责人验证`，点击「发送消息」；快照 owner=A、outcome=complete。
- **两种补全。** Ctrl+N 创建第二群，点「点名成员」再选 option「Builder 2 @builder-2」；输入 `@builder-2` 后 Enter 应补全而非发送。输入 `@builder-2 VERIFY_ROOMS 点名负责人验证` 后 Enter，第二群只有一个任务、owner=builder-2。
- **切群与重启。** 点击 navigation「群聊列表」内第一群标题，显示第一群消息。关闭本轮宿主后应显示「连接中断」并禁用发送；同库重启、刷新后消息和任务与原快照逐项相等。只读 SQLite 中也有用户输入。
- **证据。** 查看 `rooms-before`、`rooms-switched`、`rooms-offline`、`rooms-after-restart` 的 PNG/ARIA，`rooms.sqlite-proof.json`、房间快照和 trace。
- **扩展。** 输入文本后 `textbox.press('Shift+Enter')`，发送前任务数不得增加；切群再回原群检查草稿。引用/代码中的 @B 不调度需按 BT_R 规格另验；不计入本组自动覆盖。

## Gotchas

- 点名候选是 option，button「查看Builder 2的执行过程」是另一入口。
- 群标题会随首条目标更新；快捷键当前在 Linux 验证 Ctrl+N，macOS ⌘N 另验。
- 完成任务重启不代表在途恢复、Pi Durable 或去重验收。BT_U01/BT_U09 原 Cucumber 待验收范围仍保留。
