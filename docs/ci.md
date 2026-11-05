# 持续集成

`CI` 工作流在 PR、main 推送和手动运行时执行。唯一必需 job 名为 `Complete verification`。

此 job 使用 Node 24.22.1、锁文件安装和 Ubuntu 22.04，依次执行：

1. 安装 Linux 沙箱的 bubblewrap、socat 和 ripgrep 依赖。
2. `npm run verify:local-sandbox`，用真实生产后端验证文件、技能快照、环境、网络和进程取消边界。不可用退出 78 仍失败，不改安全设置、不退回无沙箱执行。
3. `npm run check`，包含生产、网页、测试三份严格类型检查，全部 Vitest、全部已登记可自动验收的 Gherkin，以及规格覆盖报告。现有验收缺口仍由仓库登记，CI 不增加排除条件。
4. `npm run build`，验证后端编译和网页生产构建。

测试报告在成功或失败时保留 14 天；缺少报告不是通过证据。20 分钟 job 上限只负责终止失控 job，各测试仍保留断言、步骤时限和叶进程监督。

合并前应确认 PR 最终 head SHA 的本工作流最新运行及 `Complete verification` job 均为 success，并再次核对 head 未变化。空 checks、跳过、取消、超时、旧提交成功或仅本地成功均不满足这一条件。此文件不更改 GitHub 分支保护或授予写权限。

此门槛不声称验收真实模型供应商、用户账号或全部浏览器流程；界面变更仍须按 verify-squad 技能补充真实浏览器验收。工作流只使用合成测试输入，不配置模型服务密钥。
