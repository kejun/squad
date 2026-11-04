# 群聊归档验收

> 本页保留当时实跑的命令和数量。2026-10-30 测试治理后的文件对照、当前入口与数量见[测试治理记录](test-governance.md)；历史结果不代表当前用例数量。

2026-10-30，基于 main `b3502f19f8f6136cb8b818a526bab8885cb9f82e` 及当前工作区。

## 范围与取舍

用户已确认：归档只整理群聊列表，正在执行的任务继续运行。群聊从普通列表移入「已归档」，可以查看历史、继续发送消息并恢复；新消息不自动取消归档。保留原群ID、消息、任务、产物和当前浏览器会话的分群草稿；刷新或服务重启保留归档状态，未承诺草稿跨浏览器刷新保存。

复用原群数据和事务，没有搬迁、复制、删除历史或停止工作。群归档是可逆列表整理；[Slack官方归档说明](https://slack.com/help/articles/213185307-Archive-or-delete-a-channel)提供了保留历史及恢复入口的常见做法，本产品的执行策略以用户确认的继续工作为准。

旧RoomData没有归档字段时默认为普通群；新增的可选归档字段继续使用原SQLite事务保存。房间元数据与任务状态分开，避免把列表分类混入任务阶段。服务的调度和恢复仍枚举全部群，不能复用网页筛选后的列表。

## 场景和模型门槛

先写 `features/25_room_archive.feature`，再更新README「状态模型」入口和 `docs/state-diagrams.md`「群聊归档」，再实现 `src/room.machine.ts` 与纯列表投影。业务 `src/task.machine.ts` 无需修改。

| 编号 | 验收内容 |
| --- | --- |
| BT_G15 | 归档列表、恢复、相同身份与历史 |
| BT_G16 | 在途工作继续、原预算、新消息保持归档 |
| BT_G17 | 旧数据缺省、空群与重启持久化 |
| BT_G18 | 请求重试、指纹冲突、旧回执不覆盖恢复 |
| BT_G19 | 缺少/空标识、未知群、错误方法、跨来源拒绝 |
| BT_G20 | 提交失败回滚状态及回执、重新打开后重试 |
| BT_G21 | 网页失败提示、列表选择、草稿与恢复入口 |
| BT_G22 | 迟到列表/快照不能覆盖更高归档版本 |

接入存储、HTTP及网页之前执行：

```sh
node node_modules/vitest/vitest.mjs run tests/room-archive-model.test.ts --maxWorkers=1
```

6/6通过、退出0。模型SHA256：

- `src/room.machine.ts`：`1f2acd3d217731acd39b4258e0148b65b600f2b8cd7ae8cdcee8f047d8b696ab`。
- `web/src/room-list.ts`：`c1a6822d3bb21846f261f90923426b8c83854912407a043959917c07f59a907b`。
- 沿用任务模型：`dd5ec71b41a82a13c831938e5401783214db76aa07d9e0ab80487b03b7dd42f9`。

关键轨迹active→archived→active；同目标重复事件不增加版本，旧数据恢复为active，序列化归档后可恢复。拒绝旧列表覆盖及保持列表互斥。真实任务CLAIM→DELIVER→检查→complete，普通/检查额度各1；STOP→stopped，归档不改变任务快照、意图或预算。

## 接入与完整检查

`TeamEngine.setRoomArchived`通过原事务和命令回执提交真实房间模型结果；`POST /api/rooms/:id/archive`、`/restore`接受请求标识。相同请求重放读取当前元数据，不重演旧目标；失败时归档状态和回执一起回滚。`GET /api/rooms`保持返回完整目录，携带archived/archiveVersion，网页按分类展示。

网页仅在成功响应后移动群；失败保留列表、选择及草稿。更高归档版本不会被旧列表或快照覆盖，切群时拒绝旧群轮询返回。分类初始选择只在目录首次就绪时恢复，避免迟到快照覆盖用户刚刚执行的恢复操作。按钮具有归档/恢复的可访问名称，手机直接显示操作图标，桌面悬停或键盘聚焦显示。

`npm run build`、最终 `npm run build:web`、`npm run check`均通过。全量488项回归、536个Gherkin场景、10425步骤直接执行通过；归档8个定义展开为12场景，全部默认执行，没有新增延期或排除。仓库原有18项定义/26个实例仍按原登记延期。最终覆盖报告为 `reports/spec-coverage.json`，全仓302个场景身份唯一。

Gherkin重现命令：

```sh
TSX_TSCONFIG_PATH=tests/bdd/tsconfig.json node --import tsx node_modules/@cucumber/cucumber/bin/cucumber.js features/25_room_archive.feature --import 'tests/bdd/*.ts' --format progress
```

纯状态测试、真实SQLite/HTTP/WorkRunner测试，以及React连接真实API的交互测试分别执行。失败界面测试只注入一次网络失败，后续归档和恢复由真实API完成；不是伪造成功结果。

## 浏览器与持久化证据

使用仓库 `verify-squad`，实际运行生产入口、HTTP、SQLite和React；仅模型供应商HTTP边界使用合成夹具，用户会话、任务和密钥未参与。

```sh
SQUAD_PLAYWRIGHT_MODULE=/Users/haoyu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs node .agents/skills/verify-squad/scripts/verify.mjs --feature rooms
```

证据：`reports/verify-squad/2026-10-30T01-00-43.876Z-28236/`；退出0，run.json.status=verified，rooms进入completed，四项清理均true。桌面1440×1000和手机390×844。

- 在真实群聊行归档，普通列表移出；已归档列表打开原群，消息、任务、非空产物逐项保持，未发送草稿保留。
- 停止并重启隔离宿主，再刷新网页，归档仍保留；手机导航中点击恢复，回到普通列表。
- 保留负责人真实模型HTTP请求，待其在途时经网页归档；任务快照不变。夹具随后返回，原任务完成，ordinary=1/checks=1。
- 在归档群通过网页再发送请求，完成第二个任务且仍归档；只读SQLite的archive.value=archived、任务数2。
- `rooms-archived.png`、`rooms-archived-mobile.png`、`rooms-restored.png`、`rooms-archive-inflight.png`、`rooms-archive-complete.png`保留截图；`rooms-archive.sqlite-proof.json`、actions.jsonl、模型HTTP日志和trace保留接线证据。已查看桌面及手机归档截图。

## 本地服务更新

确认原服务无活动/在途任务后，保留数据库并重启4318端口服务，PID由19529更新为29011。3个现有群的消息、任务及activeTaskId更新前后哈希一致；没有归档或修改用户的现有群。旧群均正确返回archived=false/archiveVersion=0。调试仍开启、本地技能3个、CLI sandbox ready。

只读连续性证据为 `reports/room-archive-service-20261030.json`，status=verified、historyUnchanged=true。当前服务已提供归档接口与新构建，刷新本地页面即可使用。
