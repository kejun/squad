# 本地技能与 CLI 运行说明

所有 Bot 默认可用。服务先准备运行时、扫描技能并核对旧执行会话，再恢复和调度任务。技能目录不需要逐 Bot 配置，新增成员自动继承。`TeamConfig.localTools.enabled = false` 全部关闭，`Bot.localTools = false` 只关闭指定成员。

## 目录与配置

| 配置 | 默认/用途 |
| --- | --- |
| `SQUAD_LOCAL_SKILLS_ROOTS` | 默认运行账号 `~/.agents/skills/`；Linux 用 `:` 分隔额外的受信绝对路径，不自动扫描克隆项目 |
| `SQUAD_LOCAL_DATA_DIR` | 数据库旁的 `.squad-local/`；保存私有快照、命令日志、会话回执、默认任务目录和检查副本 |
| `SQUAD_WORKSPACE_ROOT` | 可选真实工程；不设置时每个群/任务使用独立空目录。必须与服务源码、数据库和运行时目录分开 |
| `SQUAD_LOCAL_TOOLS_ENABLED` | 默认开启；`false` 关闭启动扫描及 Bot 本地能力 |

`~` 属于服务器服务账号；容器需显式只读映射技能来源。顶层安装链接可用，同一真实来源去重；包内链接不得逃逸。单包默认最多1500个文件、32MiB，单文件2MiB；首轮最多检查200个入口，扫描达到边界明确报告不完整。目录缺失为空，单包损坏不阻止服务启动。目录元数据分页，每页20条；正文最多48000字符，资源每页24000字符。

启动目录已绑定全包 manifest。首次激活制作并复验只读快照，更新来源不会改变已激活内容；更新后重启加载新版本。旧任务仍使用已保存的旧快照；版本缺失明确返回 `SKILL_VERSION_UNAVAILABLE`。技能资源过多时先给有界清单，按相对路径继续读取。没有热更新、自动下载、安装或执行 setup。

## Bot 的动作协议

```json
{"type":"listSkills","query":"验证"}
{"type":"loadSkill","skillId":"从目录复制的 local:..."}
{"type":"readSkillResource","skillId":"已激活ID","path":"references/guide.md","offset":0}
{"type":"runCli","executable":"node","args":["@skill/scripts/check.mjs"],"skillId":"已激活ID","cwd":".","timeoutMs":120000}
```

每次只返回一个 JSON 动作，工具回执交给原 Bot 后继续模型循环。普通 CLI 可省略 skillId。`@skill/` 指选中技能的只读快照，`@workspace/` 指当前工作区；cwd 必须在工作区内。返回真实退出码、信号、受限 stdout/stderr、工程版本和变更文件清单。长输出及日志截断会明确标记。结果整体也有大小边界，不会因转义后的 JSON 过大留下无法结算的操作。

元数据查询不扣额度；技能正文、资源读取及 CLI 每次领取扣一次 ordinary。继续模型按原工作 bucket 计费，check 仍扣 checks；子操作不重复走通用请求扣费。保留现有评审、讨论汇总和负责人续办额度。

owner、assistance、facilitator、check 均可使用；纯输入解析和讨论汇总不执行本地动作。check 和后台讨论使用绑定工程版本的可写副本，允许 build 写 dist/test-results，但不自动合回权威工程。`Bot.tools` 仍是业务权限，不能把 `writeArtifact` 当成 OS 写权限。

## 执行边界

生产后端固定 `@anthropic-ai/sandbox-runtime@0.0.81`，首期支持 Linux。需已安装 bubblewrap、socat、ripgrep 和内核命名空间能力；`npm run verify:local-sandbox` 在真实后端验证边界，不可用退出78，不降级为宿主执行。跨平台后端是后续增量。

默认拒绝网络，文件读取从根目录拒绝后只开放系统运行依赖、任务目录和选中快照；服务目录、环境文件、数据库保持不可读，技能快照不可写。子进程只收到最小环境，不继承模型密钥、宿主代理或 `SRT_*` 私有环境；固定 SRT 的 Linux wrapper 已自行编码沙箱代理设置，不能把它返回的 `process.env` 合回子进程。需要凭据的 CLI 只能由可信宿主通过 `LocalRuntimeOptions.commandEnv` 明确配置，输出中的配置密钥会脱敏。

公共接口使用 executable + argv，outer spawn 为 shell:false；SRT 内部要求的命令文本逐参数做宿主转义，模型文本不能直接拼成 shell 程序。默认命令期限120秒，且不超过父工作剩余期限。单路模型输出16000字符、落盘日志128000字节，JSON 总回执也有上限。首次工程副本扫描有数量、大小和时间边界。此版本没有硬性 cgroup CPU/RAM/总磁盘配额，不应把文件/网络隔离当作完整资源配额或多租户隔离。

同一 canonical 工程在一个服务实例、同一数据库内串行领取，租约和领取在同一存储事务提交；排队不扣子操作预算。默认目录和副本按群/任务隔离。服务持有运行时锁；不能用不同数据库/运行时目录启动多个写同一工程的实例来获得跨实例互斥保证。

服务仍仅监听127.0.0.1。经隧道对外提供时，需要已具备身份校验的访问网关；Origin 检查不是账号认证。首期是一个受信服务账号的运行环境。

## 停止、重启与核对

停止先取消父会话，等待实际进程和后代结算；无法确认退出时保留 uncertain。取消/超时可能已写入，进程退出不等于效果已核对。租约不会因超时或重启自动释放。恢复先检查 fsync 的宿主日志：确认尚未启动可重新领取，已有确定回执可补交；启动和回执之间存在缺口时不重放写入。进程身份包含启动时间、boot ID、PID 命名空间及 /proc 映射，不能拿裸 PID 重启后直接发信号。

回执与模型检查点原子保存，格式修复及模型重试会继续读取已有证据。后台成员操作不确定时，方案师返回的草稿仍保存；等待讨论核对完成后再汇总，不会开始最终检查。

人工核对入口为宿主命令，先停止服务，使用同一 `.env`、数据库和运行时目录：

```sh
npm run local:operations -- --database /path/team.sqlite
```

输出未决操作的 room、task、operationId、真实回执、当前工作区文件摘要及 reviewDigest。检查命令实际影响，确认进程已退出后，使用刚读到的精确标识和摘要：

```sh
npm run local:operations -- --database /path/team.sqlite \
  --room ROOM --task TASK --operation OPERATION --confirm REVIEW_DIGEST
```

该命令不执行 CLI，只把操作者确认转成 `LOCAL_RECONCILE(receipt)`。文件或回执变化使摘要失效；进程未退出或身份不明时拒绝确认。停止任务完成结算；仍有效的活动任务下次启动从检查点续办。若进程已退出但退出码遗失，确认效果仍不会伪造命令成功。

## 验证命令

```sh
npm run simulate:local-tools
npm run check
npm run build
npm run verify:local-sandbox
```

前3项覆盖真实 XState、事务、技能目录、受控 HTTP 模型协议和真实子进程夹具；进程夹具明确不宣称 OS 隔离。最后一项必须在支持该后端的部署宿主另行通过。具体场景、模型摘要和执行结果见 [local-tools-verification.md](local-tools-verification.md)。
