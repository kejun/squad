# 报告与详情

用户从简短结论进入完整报告，查看成员记录，复制或导出当前详情。

## Sub-features

- `reports-open`：报告链接、返回详情、成员产物页。
- `reports-transfer`：真实剪贴板与下载文件读回。
- `reports-repair`：检查输出错误后重新生成并计费。
- `reports-other`：消息/任务入口、其他详情与错误分支（扩展）。

## How to get to it (user POV)

消息「查看 verification-report.md」「查看消息详情」；底部任务状态；侧栏、头像或作者的成员过程入口；成员「产物」tab；详情「复制详情」「导出详情」「返回详情」「关闭详情」，产物列表还有单独下载。

## Driving it with verify-squad

Preconditions: 空群、本地夹具、可授予 clipboard-read/write 权限的 Chromium。报告经真实模型 HTTP 输出生成。

- **运行。** `node .agents/skills/verify-squad/scripts/verify.mjs --feature reports`，动作位于 `reports()`。
- **生成。** 发送 `VERIFY_REPAIR 生成可导出的报告`，夹具第一次返回无效 check；宿主重新生成后完成。请求日志必须有 check 修复记录、检查额度=2，产物作者=A，内容等于完整报告。
- **预览。** 在 log「群聊消息」点「查看 verification-report.md」；complementary「报告预览」内 heading「验证报告」可见，保存 `reports-preview`。
- **复制。** 点「复制详情」，等 status「已复制」，只读 `navigator.clipboard.readText()`，逐字等于持久化报告并保存 `clipboard.txt`。
- **下载。** 先 `page.waitForEvent('download')` 再点「导出详情」，文件名必须是 `verification-report.md`，实际保存并逐字读回。
- **其他已驱动入口。** 点「返回详情」，关闭后在侧栏点「查看方案师的执行过程」，切「产物」tab，必须有同一报告。
- **扩展。** 消息详情、任务状态、作者/头像、成员执行过程及列表下载入口分别驱动并导出读回；当前助手仅覆盖报告预览的复制/导出，不推及其他类型。

## Gotchas

- summary 不等于完整产物；「已开始导出」不等于文件正确。复制使用真实浏览器权限，不能用模拟 clipboard API 冒充。
- check 修复消耗检查额度；模型判断来自夹具。HTML/代码下载、安全文件名、失败提示和复制中切页需另验。
