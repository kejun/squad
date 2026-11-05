# 本地技能与 CLI 运行说明

所有 Bot 默认可用。服务先准备运行时、扫描技能并核对旧执行会话，再恢复和调度任务。技能目录不需要逐 Bot 配置，新增成员自动继承。`TeamConfig.localTools.enabled = false` 全部关闭，`Bot.localTools = false` 只关闭指定成员。

## 目录与配置

| 配置 | 默认/用途 |
| --- | --- |
| `SQUAD_LOCAL_SKILLS_ROOTS` | 默认运行账号 `~/.agents/skills/`；macOS/Linux 用 `:` 分隔额外的受信绝对路径，不自动扫描克隆项目 |
| `SQUAD_LOCAL_DATA_DIR` | 数据库旁的 `.squad-local/`；保存私有快照、命令日志、会话回执、默认任务目录和检查副本 |
| `SQUAD_WORKSPACE_ROOT` | 可选真实工程；不设置时每个群/任务使用独立空目录。必须与服务源码、数据库和运行时目录分开 |
| `SQUAD_LOCAL_TOOLS_ENABLED` | 默认开启；`false` 关闭启动扫描及 Bot 本地能力 |

`~` 属于服务器服务账号；容器需显式只读映射技能来源。顶层安装链接可用，同一真实来源去重；包内链接不得逃逸。单包默认最多1500个文件、32MiB，单文件2MiB；首轮最多检查200个入口，扫描达到边界明确报告不完整。目录缺失为空，单包损坏不阻止服务启动。目录元数据分页，每页20条；正文最多48000字符，资源每页24000字符。

启动目录已绑定全包 manifest。首次激活制作并复验只读快照，更新来源不会改变已激活内容；更新后重启加载新版本。任务级绑定会跨 Bot/续办继承，名称先解析来源 ID 再读取已固定版本；旧任务仍使用已保存的旧快照；版本缺失明确返回 `SKILL_VERSION_UNAVAILABLE`。技能资源过多时先给有界清单，按相对路径继续读取。没有热更新、自动下载、安装或执行 setup。

## Bot 的动作协议

```json
{"type":"listSkills","query":"验证"}
{"type":"loadSkill","skillId":"从目录复制的 local:..."}
{"type":"readSkillResource","skillId":"已激活ID","path":"references/guide.md","offset":0}
{"type":"runCli","executable":"node","args":["@skill/scripts/check.mjs"],"skillId":"已激活ID","cwd":".","timeoutMs":120000}
{"type":"runCli","executable":"gh","args":["pr","list"],"execution":"host","reason":"需要使用本机已登录的 GitHub 账号"}
```

每次只返回一个 JSON 动作，工具回执交给原 Bot 后继续模型循环。普通 CLI 可省略 skillId。`@skill/` 指选中技能的只读快照，`@workspace/` 指当前工作区；cwd 必须在工作区内。返回真实退出码、信号、受限 stdout/stderr、工程版本和变更文件清单。长输出及日志截断会明确标记。结果整体也有大小边界，不会因转义后的 JSON 过大留下无法结算的操作。

## 宿主命令授权

默认不需要新增配置。`execution` 省略或为 `sandbox` 时继续使用原沙箱。Bot 确认需要本机登录态、网络、本地服务或系统能力时，可以带 `execution: host` 和具体 `reason` 提出申请。网页自动显示完整参数、真实工作目录、服务机器与账号、原因及权限范围，并提供“允许本次”、“允许本次会话”和“拒绝”。关闭提示不作决定，待处理卡片仍可打开；刷新与重启后仍能看到请求。

“允许本次”只授权这一条不可替换的命令，不建立永久 CLI 白名单。预备与等待不启动进程、不扣 CLI 执行额度，且释放工程租约；批准后重新领取并扣一次 ordinary。等待不循环请求模型。默认申请10分钟内有效，且不超过父工作期限。批准标识、参数、真实目录、工程内容、可执行文件或环境指纹不匹配时拒绝执行。恢复使未消费批准重新等待；已领取操作先核对日志，即使确定尚未启动也重新批准。已经运行而效果不明的命令不重放。

“允许本次会话”覆盖当前任务内全部 Bot 的后续宿主命令；仅在相同任务轮次、目标版本、工作区、宿主账号和环境内复用。页面刷新保留，任务结束、停止、目标或轮次改变、服务重启后失效。授权期间显示状态，并可点击“撤销会话授权”恢复按次审批；撤销影响尚未启动的命令。每条命令仍准备独立计划并重新校验完整参数、工程内容、可执行文件、环境与租约；不把沙箱命令自动升级为宿主执行。

遇到 `PERM_DENIED`、`Operation not permitted`、`EPERM`、`EACCES`、网络策略拒绝或 `ENOTFOUND localhost` 等签名，且任务确需本机登录态、宿主网络、本地服务或系统权限时，提示词要求 Bot 先申请具体宿主命令，不能直接宣布无法完成或要求粘贴内容。申请不等于执行，仍须用户批准；普通业务失败、参数错误、缺失文件或任意 DNS 错误不适用这一要求。

失败记录会在输入区和对应工作详情中显示“请求在宿主执行”。用户可直接从原始记录提出申请，不依赖模型主动选择；服务固定原命令和参数，弹出按次审批。已结束的当前任务可以同一目标版本续办，批准后的真实回执交给任务负责人继续整理。重复点击只创建一条操作；停止、旧目标、另一任务已活动、撤权或效果不明等情况拒绝申请。原失败记录保留，已记录的文件变更在审批原因中提示。

普通失败不会自动在宿主重试。模型、技能、命令输出及聊天中的“同意”不能批准；只有用户在同源页面提交对应批准标识，经过 TeamEngine 事务和 XState 守卫后，运行器才执行。拒绝与过期作为明确回执交回原 Bot。

宿主使用服务运行账号的真实 HOME、PATH 和认证环境，过滤服务私有配置及已登记的模型密钥，不加载交互式 shell。它能访问该账号的工作区外文件及网络；原 check/讨论目录副本仍存在，但宿主模式没有原沙箱的读写或网络隔离保证。它不会继承另一台机器、另一账号的登录态，也不会自动授予 macOS 辅助功能、录屏权限或提供交互终端。已知环境凭据在命令回执和落盘输出中脱敏，包括跨管道数据块的输出；未知文件凭据或主动编码后的内容不在此脱敏保证内。

专用浏览器验收：先 `npm run build`，再 `node scripts/verify-host-approval.mjs`；浏览器模块和二进制沿用 `SQUAD_PLAYWRIGHT_MODULE` / `SQUAD_CHROMIUM`。增加 `SQUAD_VERIFY_HOST_RETRY=1` 可验证失败记录按钮路径；`SQUAD_VERIFY_HOST_SESSION=1` 验证会话授权、刷新、撤销和重启失效。该脚本使用独立生产服务、模型 HTTP 夹具、浏览器点击与真实宿主命令，证据保存到 `reports/host-approval/`。

元数据查询不扣额度；技能正文、资源读取及 CLI 每次领取扣一次 ordinary。继续模型按原工作 bucket 计费，check 仍扣 checks；子操作不重复走通用请求扣费。保留现有评审、讨论汇总和负责人续办额度。

owner、assistance、facilitator、check 均可使用；纯输入解析和讨论汇总不执行本地动作。check 和后台讨论使用绑定工程版本的副本；check 的源文件只读，仅 dist/test-results/reports/coverage 及任务临时目录可写，后台讨论可在副本试验，但不自动合回权威工程。正面检查提交前另领取一次 ordinary 的宿主版本复核，同时核对权威工程与副本输入；变化则检查不通过。`Bot.tools` 仍是业务权限，不能把 `writeArtifact` 当成 OS 写权限。

## 执行边界

生产后端固定 `@anthropic-ai/sandbox-runtime@0.0.81`，支持 macOS 与 Linux。macOS 需 `/usr/bin/sandbox-exec`、`/usr/bin/python3` 和 SRT 的依赖；系统 Python 以隔离模式调用 libproc，使用微秒启动时间和开机UUID核对服务/命令身份，不读取用户 Python 配置。Linux 需 bubblewrap、socat、ripgrep 和内核命名空间能力。`npm run verify:local-sandbox` 在真实后端验证边界，不可用退出78，不降级为宿主执行。Windows 后端尚未接入。

服务先探测自身身份再原子创建锁；活跃锁和未知平台/身份锁均不接管。Linux 旧版持久回执继续识别为 Linux 身份。macOS 的系统目录别名在技能边界与沙箱策略中先规范为真实路径；`@skill/` 和 `@workspace/` 展开为受检验的真实路径。沙箱使用系统 `/bin/bash` 包装结构化参数，macOS 的系统运行依赖包含 `/System/Library`、`/Library/Apple` 和 Homebrew 的 `/opt/homebrew`；子进程 PATH 可发现 `/opt/homebrew/bin`。

默认拒绝网络，文件读取从根目录拒绝后只开放系统运行依赖、任务目录和选中快照；服务目录、环境文件、数据库保持不可读，技能快照不可写。子进程只收到最小环境，不继承模型密钥、宿主代理或 `SRT_*` 私有环境；固定 SRT 的 Linux wrapper 已自行编码沙箱代理设置，不能把它返回的 `process.env` 合回子进程。需要凭据的 CLI 只能由可信宿主通过 `LocalRuntimeOptions.commandEnv` 明确配置，输出中的配置密钥会脱敏。

公共接口使用 executable + argv，outer spawn 为 shell:false；SRT 内部要求的命令文本逐参数做宿主转义，模型文本不能直接拼成 shell 程序。默认命令期限120秒，且不超过父工作剩余期限。单路模型输出16000字符、落盘日志128000字节，JSON 总回执也有上限。工程副本保留包内相对工具链接；逃逸或循环被拒绝。首次工程扫描最多50000个文件/链接、单文件64MiB、合计1GiB，每轮扫描10秒；达到边界明确失败，不制作部分工程的成功快照。此版本没有硬性 cgroup CPU/RAM/总磁盘配额，不应把文件/网络隔离当作完整资源配额或多租户隔离。

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
