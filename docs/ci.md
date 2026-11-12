# 持续集成

`CI` 工作流在 PR、main 推送和手动运行时执行。工作流定义8个实际作业：完整产品验收、独立浏览器与集成故障对照、原形式化集合，以及5个并行组合切片。GitHub分支保护的required状态以仓库设置为准；增加workflow job不会自动修改保护规则。

## 完整产品验收

`Complete verification`使用Node24.22.1、锁文件和Ubuntu22.04，20分钟上限：

1. 安装bubblewrap、socat、ripgrep、中文字体及固定Playwright1.62.1/Chromium。
2. `npm run verify:local-sandbox`运行真实生产后端，验证文件、技能快照、环境、网络及进程取消边界。不可用退出78仍失败，不退回无沙箱执行。
3. `npm run check`执行生产、网页、测试三份严格类型检查，全部Vitest、所有已登记可自动验收Gherkin及规格覆盖。既有延期需求保留原规格和记录，不新增排除条件。
4. 运行准备与模型会话控制/独立读回；这两个reader依赖本job的完整BDD报告，不能只搬控制脚本。
5. `npm run build`生成当前提交的生产构建与输入指纹。

## 独立浏览器与集成故障对照

`Browser fault detection`在同一Ubuntu22.04、Node24.22.1、锁定依赖、原生沙盒和Playwright环境中独立运行，15分钟上限。原8项源码故障控制、4项原浏览器契约的恢复复验均保留；检查器在自有worktree中构建每个变体与恢复源码，共9次构建，不下载或复用其他job的dist。还运行独立的提示隔离、CLI/SQLite崩溃、响应限制、窗口、工具目录、输入证据、网页/服务组合故障对照。原浏览器报告保留单独上传，其他报告另上传；均保留14天。

首次拆分依据是完整本地链实测1269.633秒，浏览器故障对照占341.651秒。C5远程结果随后量得check为921.97秒、此前步骤72.62秒、Browser job为376秒；其余独立故障命令再串行运行会挤压20分钟上限。因此再把14条互不依赖完整BDD的命令移入Browser job，本地合计222.323秒；Complete保留的4条组合命令与构建合计36.18秒。按该远程测量，Complete约17.2分钟；Browser即使迁移部分为本地2倍，合计约13.7分钟。这是预算估计，实际以最新head为准。正常浏览器BDD仍属于Complete；全部命令、原断言、清理及20/15分钟上限均保留。

## 定向复验

手动`workflow_dispatch`可提供空格分隔的`vitest_files`，只执行所列测试文件，其他完整作业不运行；输入为空时仍执行原完整流程。路径经校验后作为独立参数传给Vitest，不改变默认5秒用例限制。此入口用于已定位的夹具修订，不能表述为完整CI全部通过。普通PR/push的默认完整行为保持。

本轮C7只调整HostApprovalFixture的非目录前提，按用户要求复用未改部分已有结果。提交使用`[skip ci]`防止自动重跑全套，再手动定向运行宿主批准、会话、重试及UI四个文件；不借skip为未运行检查背书，PR保持草稿、未合并。

## 形式化集合

`Formal verification`安装Node24.22.1和Java21，15分钟内顺序运行handoff、delivery、authority、coordination原入口，再独立读回实际证据。delivery主入口包含原Delivery及Verification、Cycles、SourceLineage三个新域。

`Formal composition (...)`为handoff、authority、coordination、local-effects、host-retry五个独立matrix作业，各25分钟。每个干净runner独立下载官方TLA+ Tools v1.7.4并校验固定SHA-256，导出`TLA2TOOLS_JAR`，不假设另一作业已准备缓存。各切片完整探索后，用同一checker另行`--verify-evidence`读回；handoff/local-effects/host-retry还运行证据损坏与删件控制。具体九入口和有限保证见[形式化验证](formal-verification.md)。

## 结果与证据

所有作业在成功或失败时上传reports原始证据并保留14天；完整验收另上传test-results。缺报告、空checks、skip、cancel、timeout或旧提交成功都不能当作当前head完成。job上限只用于终止失控执行，叶进程保留自己的时限、断言与清理。

合并前核对PR最终head的本工作流全部8个作业成功，并确认head未变化。仅本地成功不能替代CI；本文不修改分支保护或授予写权限。独立读回检查声明协议下的证据完整性，不重新运行模型，不是防恶意作者伪造的数字签名。

工作流使用合成输入和受控模型HTTP，不配置真实供应商密钥。真实浏览器覆盖限定的原始契约及组合场景；不声称验收真实供应商质量、用户账号、任意浏览器流程或无限故障。
