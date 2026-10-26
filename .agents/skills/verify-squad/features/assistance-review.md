# 协助重试与成员评审

核查员中断后，用户重试该次协助，结果交回原负责人续办；也可请求其他成员评审已有方案。

## Sub-features

- `assistance-button` / `assistance-text`：按钮与直接输入「B 重试」。
- `assistance-return`：B 完成后一次交回 A。
- `assistance-review`：四成员评审并汇总。
- `assistance-edges`：歧义/版本/预算拒绝和队列恢复（扩展）。

## How to get to it (user POV)

求助/提示消息「重试 B 的这次协助」；输入「B 重试」「@B 重试」；已有方案后输入「大家都提提意见」「其他人评审一下方案」或定向评审。

## Driving it with verify-squad

Preconditions: 夹具让 A 求助 B，B 首次 HTTP 400 中断，A 随后 askUser；快照必须 waitingHuman 且原协助 retryable=true。

- **运行。** `node .agents/skills/verify-squad/scripts/verify.mjs --feature assistance`；动作位于 `assistance()`。
- **按钮。** 新群发送 `VERIFY_RETRY button 核查中断后交回负责人`；等前提成立后，在 log「群聊消息」点第一个「重试 B 的这次协助」，等完成。
- **文字。** 另建群，发送 `VERIFY_RETRY text 核查中断后交回负责人`，相同前提下输入 `B 重试` 并 Enter。
- **交回。** 两次均只有一个任务、原 taskId、owner=A、两次 B 协助尝试、促进者「核查结果已交给 A」只出现一次，A 最终交付报告。保存各路径 interrupted/returned 证据、快照和 HTTP 序列。
- **评审。** 第三群先发 `VERIFY_REVIEW 先生成报告` 并等完成，再发「大家都提提意见」。第二任务完成、review.status=complete、completed 严格为 B/builder-1/builder-2/builder-3；页面可见最后一位评审，保存 `assistance-review.snapshot.json` 和截图。
- **扩展。** @B 文字、其他评审说法、定向评审、多个匹配协助、历史版本、其他活动任务、预算不足及评审中途重启分别构造前提再验，不纳入当前自动覆盖。

## Gotchas

- 重试按钮可能出现在多条消息，限定时间线。A 在首次失败后还有一次 askUser，不能误算为 B 成功后的续办。
- 普通协助与评审是不同路径；夹具固定模型行为，真实宿主仍负责预算、队列与交回。
