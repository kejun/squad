# XState 后台讨论仿真结果

执行 `npm run simulate:discussion`，直接调用当前任务机器的 `stepTask`，并用真实 `TaskSandbox` 另外验证事件模板与参数错误。批量测试共 195 个场景、3548 个事件步，全部符合预期；访问 8/8 个顶层状态。每个事件步可能包含内部 always 转移，不将事件步数当作完整边覆盖率。

## 检查范围

| 场景组 | 场景数 | 符合预期 |
| --- | --- | --- |
| 全部合法返回顺序 | 144 | 144 |
| 停止与迟到结果 | 6 | 6 |
| 目标版本隔离 | 5 | 5 |
| 恢复与结果去重 | 6 | 6 |
| 无效结果身份 | 4 | 4 |
| 部分失败 | 4 | 4 |
| 预算边界 | 17 | 17 |
| 格式修正 | 1 | 1 |
| 去重与成员互斥 | 1 | 1 |
| 超时与监督 | 2 | 2 |
| 负责人接续 | 2 | 2 |
| 成员占用与交接 | 1 | 1 |
| 主流程兼容 | 2 | 2 |

144种顺序穷举六个结果事件的排列：主草稿、四位成员结果、协调员汇总；汇总须在四位成员结算后返回。主请求和成员已领取，分别检查两种结果到达顺序中的全部相对位置。额外场景覆盖规划、收集、部分结果、汇总和待交接阶段的停止、版本改变及恢复，以及额度预留、格式修正、成员占用和原主流程。通过包括正确停在 waitingHuman、以 partial 交付和以 stopped 结束，并非所有场景都应完成任务。

八个状态均实际访问：`checking`, `coordinating`, `ended`, `interpreting`, `running`, `stopping`, `waitingAssistance`, `waitingHuman`。

## 方案师先返回的实际轨迹

下表列出状态变化与关键领取、交付事件，完整事件序列由 JSON 轨迹保存。

| 事件 | 主状态 | 讨论状态 | 已收意见 | 在途工作 |
| --- | --- | --- | --- | --- |
| CLAIM | running | — | 0 | owner:A |
| USER_INPUT | running | planning | 0 | owner:A |
| DISCUSSION_PLAN | running | collecting | 0 | owner:A |
| CLAIM | running | collecting | 0 | owner:A、assistance:B、assistance:builder-1、assistance:builder-2、assistance:builder-3 |
| DELIVER | running | collecting | 0 | assistance:B、assistance:builder-1、assistance:builder-2、assistance:builder-3 |
| DISCUSSION_RESULT | running | summarizing | 4 | 无 |
| DISCUSSION_RESULT | running | delivered | 4 | 无 |
| DELIVER | checking | delivered | 4 | 无 |
| CHECK_RESULT | ended | delivered | 4 | 无 |

## 讨论先返回的实际轨迹

| 事件 | 主状态 | 讨论状态 | 已收意见 | 在途工作 |
| --- | --- | --- | --- | --- |
| CLAIM | running | — | 0 | owner:A |
| USER_INPUT | running | planning | 0 | owner:A |
| DISCUSSION_PLAN | running | collecting | 0 | owner:A |
| CLAIM | running | collecting | 0 | owner:A、assistance:B、assistance:builder-1、assistance:builder-2、assistance:builder-3 |
| DISCUSSION_RESULT | running | summarizing | 4 | owner:A |
| DISCUSSION_RESULT | running | ready | 4 | owner:A |
| DELIVER | running | delivered | 4 | 无 |
| DELIVER | checking | delivered | 4 | 无 |
| CHECK_RESULT | ended | delivered | 4 | 无 |

`ready` 后若主请求已结算，同一个 XState 事件步会完成交接，快照直接显示 `delivered`；若主请求仍在途，则保留 `ready` 等待。两条轨迹都只创建一次负责人续办和一次完成检查，期间不检查或发布旧草稿。

## 发现并修正的问题

| 问题 | 修正前 | 修正后 |
| --- | --- | --- |
| 讨论事件模板漏字段 | DISCUSSION_PLAN 缺少工作身份，返回 DISCUSSION_WORK_REQUIRED | 绑定已领取的协调员或成员，填入 workId、discussionId、工作版本及角色协议 |
| 并发模板串错角色 | DELIVER 选中了较新的讨论成员，返回 DISCUSSION_EVENT_REQUIRED | 主工作事件选取主工作，不取并行成员的身份 |
| 图中遗漏全局守卫回退 | running 的 CLAIM 仅显示 claimOwner，隐藏可实际执行的 claimDiscussion 和 claimCancel | 有条件的局部分支保留父级回退，无条件局部事件仍遮蔽父级 |
| 拒绝结果误结算当前工作 | 缺少版本边界或关联主工作的讨论结果被拒绝，却把有效在途工作标为 done | 拒绝保留当前工作；只有完整匹配自己的工作身份才可结算，合法迟到结果只结算旧工作 |

新增的7项模板与身份回归初次执行有5项失败，修正后全部通过；图中守卫回退的新增回归也先复现失败再修正。BT_V10–BT_V15 同时直接绑定 Gherkin。原有合法结果、失败降级、停止与旧版本隔离路径继续回归。

## 复现与保证边界

运行 `npm run simulate:discussion` 后，`reports/discussion-simulation.json` 保存每个场景的完整事件、阶段、工作状态、预算、结果和源代码提交身份；Markdown 汇总位于同目录。任何断言不符都会令命令退出失败，报告不会把拒绝或等待伪装成完成。

本次穷举限定四位成员和上述因果关系，其他生命周期场景按明确有限事件序列验证。使用合成模型结果和受控时钟，不调用模型或工具，也不启动正式执行器。这不是任意事件序列的形式证明；SQLite、真实 HTTP 宿主与受控模型传输由完整回归套件另行验证，真实供应商的回答质量不在仿真保证范围内。
