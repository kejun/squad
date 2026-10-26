# 简短消息与完整交付

现有模型协议只接收正文和既有产物 ID，缺少提交报告正文的能力；负责人和协助结果被原样写入群消息。详情区已有执行记录，但产物只有下载入口，历史消息也不能定位自己的任务。单纯要求模型少写或折叠 CSS 无法保证报告真正保存、核查材料完整或历史入口准确。

Claude 的产物机制将独立、可复用的内容放在对话旁；渐进式披露让主视图聚焦重要信息，详细内容按需打开。同时，失败、等待和需要用户决定的状态仍应及时可见。本次采用以下范围：

| 内容 | 群消息 | 详情与产物 |
| --- | --- | --- |
| 简单问答 | 直接短答 | 不强制文档 |
| 方案、报告、长代码 | 结论及报告入口 | 完整产物、预览和下载 |
| 核查 | 核查结论 | 完整核查报告、来源；负责人获得全文 |
| 失败、等待用户 | 状态及待处理事项 | 具体原因、已记录的工具和调度轨迹 |

模型的 answer / deliver 增加可选 summary 和 artifacts 草稿；草稿仅含 name、content，真实 ID 由状态机生成。DELIVER / RECORD_RESULT 在一次事务中保存完整结果、产物和关联，HELP_RESULT 仍原子消费。消息保存简短正文及全文/产物引用，候选与核查结果保留完整文本。旧协议的长结果自动保存成 Markdown 报告；旧历史消息的完整正文可在详情查看。简单回答保持直接回复，不按关键词强制生成空报告。

沿用现有 XState 顶层状态和执行额度，不增加总结模型调用。所有结果先经工作身份、epoch、goalVersion、停止和去重守卫；事务失败、旧版本或停止后的结果均不能发布报告入口。报告正文不会通过 HTML 原样执行。界面入口带 taskId、messageId 和可选 artifactId，只显示实际存在的关联。过程仅展示已记录的任务、工具和核查记录。

明确交付标准为 BT_A01–BT_A11；交互和结果事务见 [细化状态图](state-diagrams.md#简短结果与产物发布)。模型风格本身仍需真实模型体验核验，受控传输测试验证协议和保存边界。

资料：
- https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
- https://www.nngroup.com/articles/progressive-disclosure/
- https://www.nngroup.com/articles/visibility-system-status/
